async () => {
  // Живые сценарии M3 (Удар запускает способность из attackEffects), M6 (постоянное состояние NPC), M8 (Reach Spell у NPC) в мире RustySpirit: копии «AF тест: …», тестовая сцена создаётся и удаляется сценарием.
  // Окна выбора модуля отвечаются очередью e.answers (подпись или значение варианта; null — закрыть).
  // Параметры: window.__afSA = { only, skip, cleanOnly }. Результат — window.__afSAResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afSA ?? {}) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000, step = 150) => {
    const end = Date.now() + ms, env = cur;   // своё окружение: после таймаута на cur уже следующий сценарий
    if (env) env.step = `ждём: ${String(fn).replace(/\s+/g, " ").slice(0, 100)}`;
    while (Date.now() < end) { if (!env || env.dead) return null; try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(step); }
    return null;
  };
  class Skip extends Error {}
  /** await без таймаута может висеть вечно (бросок pf2e с окном): ограничиваем и называем шаг. */
  const bound = (label, p, ms = 30000) => {
    const env = cur; if (env) env.step = label;
    let tm;
    return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`завис шаг «${label}» (>${ms / 1000} с)`)), ms); })]).finally(() => clearTimeout(tm));
  };
  /** Что видно при зависании: последний шаг, окна, которые закрывал харнесс, и открытые сейчас. */
  const hangInfo = (e) => `последний шаг: ${e.step}; закрыто окон бросков: [${e.windows}]; окна модуля: [${e.dialogs}]; открыто: [${[...foundry.applications.instances.values(), ...Object.values(ui.windows ?? {})].map((a) => a.constructor.name).join(", ")}]`;
  let cur = null;
  const DEG = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const deg = (v) => (typeof v === "number" ? DEG[v] : v);
  // pf2e: shift ИНВЕРТИРУЕТ настройку show*Dialogs (eventToRollParams). Прогон ставит их в false (окон нет), поэтому shift окно как раз ПОКАЗЫВАЕТ и бросок
  // ждёт его вечно. Shift — только если окна включены; на всякий случай окна модификаторов ниже закрываются кнопкой броска.
  const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });
  const api = () => game.modules.get(MOD).api;
  const imp = (f) => import(`/modules/${MOD}/scripts/${f}`);
  const setting = (k) => game.settings.get(MOD, k);

  // ---------- уборка (аварийная: window.__afSA = {cleanOnly: true}) ----------
  // Бой удаляем с проверкой: молчаливый catch оставлял бой без сцены (сцену удаляли следом). Не удалился — повтор, потом предупреждение в консоль.
  const killCombat = async (c) => {
    for (let i = 0; i < 3 && game.combats.has(c.id); i++) { await game.combats.get(c.id).delete().catch((err) => console.warn("combat delete", c.id, err)); if (game.combats.has(c.id)) await wait(800); }
    if (game.combats.has(c.id)) console.warn("rustyspirit: бой не удалился", c.id);
  };
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    const mine = (n) => test(n) || (typeof n === "string" && n.startsWith("Тест: "));   // копии героев: «AF тест: » и «Тест: »
    // бои сцены (до её удаления), а также бои без сцены, чьи участники — наши копии
    for (const c of game.combats.filter((c) => test(c.scene?.name) || (!c.scene && c.combatants.some((x) => mine(x.actor?.name) || mine(x.name))) || c.combatants.some((x) => test(x.actor?.name) || test(x.name) || test(game.scenes.get(x.sceneId)?.name)))) await killCombat(c);
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const sceneIds = new Set(scenes.map((s) => s.id));
    const msgIds = new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene)).map((m) => m.id)]);
    const ids = [...msgIds].filter((id) => game.messages.has(id));
    if (ids.length) await ChatMessage.deleteDocuments(ids).catch(() => {});
    for (const s of scenes) await s.delete().catch(() => {});
    for (const a of game.actors.filter((a) => test(a.name))) await a.delete().catch(() => {});
    return game.actors.filter((a) => test(a.name)).length + game.scenes.filter((s) => test(s.name)).length;
  };
  if (opts.cleanOnly) return { left: await sweep() };

  // ---------- общее окружение прогона ----------
  const prevScene = game.scenes.viewed, prevCombat = game.combats.viewed;
  const pfSet = game.user.flags.pf2e?.settings ?? {};
  const origFlags = { showCheckDialogs: pfSet.showCheckDialogs, showDamageDialogs: pfSet.showDamageDialogs };
  const tbPrev = game.settings.get(MOD, "useToolbeltTargetHelper");
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  const ceOrig = console.error;   // стек ошибок модуля (в уведомление попадает только сообщение)
  console.error = function (...a) { const er = a.find((x) => x instanceof Error); if (er) notes.push(`console.error: ${String(a[0]).slice(0, 80)} ${String(er.stack ?? er.message).replace(/\s+/g, " ").slice(0, 700)}`); return ceOrig.apply(this, a); };
  const onErr = (ev) => { const er = ev.error ?? ev.reason; notes.push(`uncaught: ${String(er?.stack ?? er?.message ?? ev.message).replace(/\s+/g, " ").slice(0, 700)}`); };
  window.addEventListener("error", onErr); window.addEventListener("unhandledrejection", onErr);
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };

  // ---------- компендиумы (slug — по 8.6.1, tools/out/items.json) ----------
  const idx = {};
  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    idx[pack] ??= await p.getIndex({ fields: ["system.slug"] });
    const e = idx[pack].find((i) => i.system?.slug === slug);
    if (!e) throw new Error(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(e._id)).toObject();
  };
  const equip = (s) => find("pf2e.equipment-srd", s);
  const held = (d, hands = 1) => { d.system.equipped = { carryType: "held", handsHeld: hands }; return d; };
  /** Источник предмета по uuid (в т.ч. вложенного в актёра компендиума); нет — skip. */
  const src = async (uuid) => {
    const d = await fromUuid(uuid).catch(() => null);
    if (!d) throw new Skip(`нет в паках: ${uuid}`);
    const o = d.toObject(); delete o._id;
    return o;
  };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна: наши .paf-dialog закрываются (отмена); ChoiceSet pf2e — первый вариант. Список e.dialogs — «окно появилось».
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          const sel = el.querySelector("select[name=choice]"), opts = sel ? [...sel.options].map((o) => `${o.value}=${o.textContent.trim()}`) : [];
          e.dialogs.push(`${el.querySelector(".window-title")?.textContent?.trim() ?? el.id}: ${opts.join(" / ")}`);
          const want = e.answers?.length ? e.answers.shift() : null, o = sel && want != null ? [...sel.options].find((x) => x.value === want || x.textContent.toLowerCase().includes(String(want).toLowerCase())) : null;
          if (o) { sel.value = o.value; el.querySelector("button[data-action=ok]")?.click(); } else foundry.applications.instances.get(el.id)?.close();
        }
        for (const app of foundry.applications.instances.values()) {
          if (seen.has(app.id) || !app.element || !/Prompt|Picker/i.test(app.constructor.name)) continue;
          seen.add(app.id);
          if (Array.isArray(app.choices) && app.choices.length) { app.selection = app.choices[0]; app.close(); }
        }
        for (const app of [...Object.values(globalThis.ui?.windows ?? {}), ...foundry.applications.instances.values()]) {   // окна бросков pf2e (проверка / урон): жмём «Бросок»
          const id = app.appId ?? app.id;
          if (seen.has(id) || !/damage|modifiers|урон|check/i.test(`${app.constructor.name} ${app.title}`)) continue;
          seen.add(id);
          e.windows.push(`${app.constructor.name} «${app.title}»`);
          const root = app.element?.[0] ?? app.element, bs = root?.querySelectorAll?.("button");
          (root?.querySelector?.("button.roll") ?? bs?.[bs.length - 1])?.click();
        }
        await wait(150);
      }
    })();

    const live = () => { if (e.dead) throw new Error("сценарий остановлен"); };
    e.add = (data) => live() ?? Actor.create({ folder: null, ownership: { default: 0 }, ...data, name: PFX + data.name });
    e.foe = async (name) => {
      const a = await e.add({ ...(await fromUuid(GOBLIN)).toObject(), name });
      await a.update({ "system.attributes.hp.value": a.hitPoints.max });
      return a;
    };
    e.pc = async (name, items = []) => {
      const a = await e.add({ name, type: "character", system: { details: { alliance: "party", languages: { value: ["common"] } } } });
      await a.createEmbeddedDocuments("Item", [await find("pf2e.ancestries", "human"), ...items]);
      await a.update({ "system.attributes.hp.value": a.hitPoints.max });
      return a;
    };
    e.give = (a, ...docs) => live() ?? a.createEmbeddedDocuments("Item", docs);
    e.tok = async (a, x, y, disposition) => {
      live();
      const [t] = await e.scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition }]);
      return t;
    };
    e.T = (t) => e.scene.tokens.get(t.id);
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: все проверки и выдача предметов — на этом актёре, не на исходном
    e.aim = async (ctrl, ...targets) => {
      e.T(ctrl).object.control({ releaseOthers: true });
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      for (const t of targets) e.T(t).object.setTarget(true, { releaseOthers: false });
      await wait(300);
    };
    e.rig = (actor, selector, value) => live() ?? actor.createEmbeddedDocuments("Item", [{ type: "effect", name: "AF rig", system: { slug: "af-rig", rules: [{ key: "FlatModifier", selector, value }] } }]);
    e.fix = async (n) => {
      if (n != null) live();
      if (e.d20 === null) e.d20 = CONFIG.Dice.randomUniform;
      CONFIG.Dice.randomUniform = n == null ? e.d20 : () => 1 - (n - 0.5) / 20;
      if (n != null && (await new Roll("1d20").evaluate()).total !== n) throw new Skip("не удалось зафиксировать d20 (CONFIG.Dice.randomUniform)");
    };
    e.since = () => Date.now();
    e.msgs = (t0) => game.messages.contents.filter((m) => m._stats.createdTime >= t0);
    e.dom = (m) => document.querySelector(`#chat [data-message-id="${m?.id}"]`);
    e.applyAll = async (m) => { for (const b of [...(e.dom(m)?.querySelector(".pf2e-automato")?.querySelectorAll("button[data-action^=apply]:not([disabled])") ?? [])]) { live(); b.click(); await wait(1200); } };
    e.cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug) ?? null;
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.results = (m) => Object.fromEntries(Object.entries(e.use(m)?.state?.challenge?.results ?? {}).map(([k, v]) => [k, deg(v.degree)]));
    e.strike = (a) => a.system.actions.find((s) => s.item?.isMelee);
    e.hit = async (att, def) => {   // первый ближний Удар att по токену def (shift-клик без окна); сообщение атаки
      await e.aim(att, def);
      const t0 = e.since(), s = e.strike(e.A(att));
      if (!s) throw new Error("у атакующего нет ближнего Удара");
      await bound("бросок Удара (variants[0].roll)", s.variants[0].roll({ event: SHIFT() }));
      return waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "attack-roll"), 8000);
    };
    /** Мировой предмет-действие с правилом в флаге: rule валидируется заранее (ошибка — в detail). */
    e.ruleItem = async (actor, rule) => {
      const v = api().validateRule(rule);
      if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
      const [it] = await e.give(actor, { type: "action", name: "AF правило", system: { slug: `af-test-${id}`, actionType: { value: "action" }, actions: { value: 1 }, description: { value: "<p>тест</p>" } }, flags: { [MOD]: { rule } } });
      return it;
    };
    /** Использовать предмет «в чат» с целями; -> сообщение со снимком use (после done). Уступка pf2e-automations — skip. */
    e.fire = async (item, att, ...targets) => {
      await e.aim(att, ...targets);
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
      if (!m) throw new Error(`у карточки «${item.name}» нет снимка use (правило не найдено или модуль не слушает)`);
      if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
      await waitFor(() => e.use(m)?.state?.done, 10000);
      return game.messages.get(m.id);
    };
    e.combat = async (toks, inits) => {
      live();
      const c = await Combat.create({ scene: e.scene.id, active: true });
      await c.createEmbeddedDocuments("Combatant", toks.map((t, i) => ({ tokenId: t.id, sceneId: e.scene.id, actorId: t.actor.id, initiative: inits[i] })));
      await viewCombat(c);
      return c;
    };
    e.dispose = async () => {
      e.dead = true; e.stop = true;
      await wait(2500);   // модуль ещё дописывает флаги/эффекты карточек: сцену удаляем после, иначе «Scene … does not exist»
      for (const c of game.combats.filter((c) => c.scene?.id === e.scene.id || c.combatants.some((x) => x.sceneId === e.scene.id))) await killCombat(c);   // бой — до ухода со сцены и до её удаления
      if (prevScene && prevScene.id !== e.scene.id && game.scenes.has(prevScene.id)) { await prevScene.view().catch(() => {}); await wait(1000); }   // холст не должен рисовать удаляемую сцену
      Hooks.off("createChatMessage", hook);
      try { await e.fix(null); } catch { /* ok */ }
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      document.querySelectorAll(".paf-dialog").forEach((el) => foundry.applications.instances.get(el.id)?.close());
      const left = await sweep([...e.tracked]);
      await viewCombat(prevCombat);
      return left;
    };
    return e;
  };

  // Копии противников «AF тест: …» с их способностями; жертвы — гоблины на стороне партии (NPC бросают сами). Сетка 100 px / 5 фт.
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const EN = { spirit: "kLU5GWkHlFZhChxY", fox: "1E85fDMsHCCrOw0m", guard: "k4YZBN0sa876sJQk", sprout: "qbaMCMwu7xwk1Gi8" };
  const DEGREE_MOD = { criticalSuccess: 0, success: -10, failure: -11, criticalFailure: -20 };
  const copyFoe = async (e, id, name) => {
    const h = game.actors.get(id);
    if (!h) throw new Skip(`нет противника ${id}`);
    const d = h.toObject(); delete d._id; delete d.folder;
    return e.add({ ...d, name: name ?? h.name });
  };
  const victim = async (e, name, traits) => {
    const a = await e.foe(name);
    await a.update({ "system.details.alliance": "party", ...(traits && { "system.traits.value": [...a.system.traits.value, ...traits] }) });
    return a;
  };
  const rigSave = async (e, G, stat, dc, deg) => {
    for (const i of G.itemTypes.effect.filter((i) => i.slug === "af-rig")) await i.delete();
    await e.rig(G, stat, dc + DEGREE_MOD[deg] - G.saves[stat].mod);
  };
  const bySlug = (a, slug) => a.items.find((i) => i.system.slug === slug) ?? null;
  const cnd = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug)?.value ?? (a.itemTypes.condition.some((c) => c.slug === slug) ? true : 0);
  const openChat = () => { try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  /** Использование действия путём pf2e (createUseActionMessage: списание частоты) -> карточка или null. */
  const useAction = async (e, item, ms = 8000) => {
    const t0 = e.since();
    await bound("rollItemMacro", game.pf2e.rollItemMacro(item.uuid));
    return waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.origin?.uuid === item.uuid), ms);
  };
  const area = async (e, m, x, y, r, shape) => {
    await waitFor(() => e.use(m)?.state?.awaitingRegion || e.use(m)?.state?.done, 8000);
    const made = await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#00aa55", shapes: [{ type: "circle", hole: false, x, y, radius: r }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: shape, origin: { uuid: m.item?.uuid, type: m.item?.type, actor: m.actor?.uuid, token: m.token?.uuid } } } }]);   // origin — как у шаблона pf2e: по нему проверка дальности области
    if (made.length) await waitFor(() => (e.use(m)?.state?.area?.keys?.length ?? 0) >= 1, 10000);
    return made[0] ?? null;
  };
  const dmgOf = async (e, tAtt) => {
    const t0 = e.since(), s = e.strike(e.A(tAtt));
    await bound("урон Удара", s.damage({ event: SHIFT() }));
    return waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "damage-roll"), 8000);
  };
  const withAlt = async (f) => { const k = game.keyboard.downKeys; k.add("AltLeft"); try { return await f(); } finally { k.delete("AltLeft"); } };


  // ---------- сценарии: M3 (Удар запускает способность), M6 (постоянное состояние), M8 (следующее сотворение NPC) ----------
  const CENTIPEDE = "ShWcSAzHjKnQ8MJX";   // копия из мира: Giant Centipede, яд — каталог catalog.model по выведенному ключу
  const ZOMBIE = "Compendium.pf2e.book-of-the-dead-bestiary.Actor.nbVljZhCnWgGxA18";   // Zombie Owlbear: Slow без правил
  const ZOMBIE_RE = "Compendium.pf2e.pathfinder-monster-core.Actor.EDYKUdYmilw3rgJg";   // Zombie Hulk: Slow с готовым GrantItem inMemoryOnly
  const MAGE = "Compendium.pf2e.lost-omens-bestiary.Actor.M2Vi2mkwMZv1ZRka";            // Tempest-Sun Mage: Reach Spell без переключателя
  const carrier = (a) => a.items.find((i) => i.flags?.[MOD]?.meta?.affliction) ?? null;
  const strikeWith = (a, effect) => a.system.actions.find((s) => s.item?.system.attackEffects?.value?.includes(effect));
  const slowed = (a) => a.getCondition?.("slowed")?.value ?? (a.hasCondition?.("slowed") ? 1 : 0);
  const noReact = async (a) => (await imp("inline-effect.mjs")).noReactions(a);
  const shapeFx = (a) => a.itemTypes.effect.find((x) => x.flags?.[MOD]?.meta?.key === "spellshape") ?? null;
  const castMsg = (a, spell) => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: a }), content: "cast", flags: { pf2e: { origin: { type: "spell", actor: a.uuid, uuid: spell.uuid, rollOptions: ["origin:action:slug:cast-a-spell"] } } } });

  sc("strike-venom", "M3: урон Удара запускает яд из catalog.model; два клика «Урон» — одна карточка; у карточки способности нет кнопок, Alt даёт карточку", async (e, t) => {
    openChat();
    const A0 = await copyFoe(e, CENTIPEDE), V0 = await victim(e, "жертва многоножки");
    const tA = await e.tok(A0, 1000, 1000, -1), tV = await e.tok(V0, 1100, 1000, 1);
    await wait(700);
    const ab = e.A(tA).items.find((i) => i.type === "action" && api().resolveRule(i)?.lookupKey && strikeWith(e.A(tA), i.slug));
    t.ok(!!ab, "у копии пассивный яд, связанный с Ударом");
    const res = api().resolveRule(ab);
    t.ok(res?.source === "catalog", `правило каталога (${res?.source})`);
    const sl = await imp("strike-link.mjs");
    t.ok(!!sl.strikeLinked(ab), "способность выведена на Удар (strikeLinked)");
    const s = strikeWith(e.A(tA), ab.slug);
    await rigSave(e, e.A(tV), "fortitude", res.rule.onUse.challenge.dc.value, "failure");
    await e.fix(10);
    await e.aim(tA, tV);
    const t0 = e.since();
    await bound("Удар", s.variants[0].roll({ event: SHIFT() }));
    const am = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "attack-roll"), 8000);
    t.ok(["success", "criticalSuccess"].includes(am?.flags?.pf2e?.context?.outcome), `попадание (${am?.flags?.pf2e?.context?.outcome})`);
    await bound("урон 1", s.damage({ event: SHIFT() }));
    await waitFor(() => carrier(e.A(tV)), 15000);
    t.ok(!!carrier(e.A(tV)), "яд сработал при уроне Удара: носитель недуга на жертве");
    await wait(1500);
    await bound("урон 2 (второй клик)", s.damage({ event: SHIFT() }));
    await wait(4000);
    const hosts = e.msgs(t0).filter((m) => m.flags?.[MOD]?.use?.state?.event);
    const af = e.A(tV).items.filter((i) => i.flags?.[MOD]?.meta?.affliction);
    t.ok(hosts.length === 1, `карточка испытания одна (${hosts.length})`);
    t.ok(af.length === 1 && af[0].system.badge?.value === 1, `недуг один, стадия 1 (${af.length}; ${af[0]?.system?.badge?.value})`);
    // ручная карточка способности: без Alt — без кнопок модуля, с Alt — со снимком
    const t1 = e.since();
    await bound("карточка без Alt", ab.toMessage(undefined, { create: true }));
    const plain = await waitFor(() => e.msgs(t1).find((m) => m.flags?.pf2e?.origin?.uuid === ab.uuid), 8000);
    await wait(2000);
    t.ok(!!plain && !plain.flags?.[MOD]?.use && !e.dom(plain)?.querySelector(".pf2e-automato button"), "без Alt: у карточки способности нет снимка и кнопок");
    const t2 = e.since();
    await withAlt(() => bound("карточка с Alt", ab.toMessage(undefined, { create: true })));
    const alt = await waitFor(() => e.msgs(t2).find((m) => m.flags?.pf2e?.origin?.uuid === ab.uuid && m.flags?.[MOD]?.use), 8000);
    t.ok(!!alt, "с Alt: карточка со снимком use");
  });

  // недуг инъекционного яда NPC (affliction-batch: способность injury — обычное правило каталога): Удар Ледяного линнорма запускает стадию 1
  const LINNORM = "Compendium.pf2e.pathfinder-monster-core.Actor.Np5Z7RMQzvSNnH0h";
  sc("strike-linnorm-venom", "M3: Удар Ice Linnorm с недугом (injury-способность NPC, правило каталога) запускает стадию 1", async (e, t) => {
    openChat();
    const d = (await fromUuid(LINNORM))?.toObject(); if (!d) throw new Skip(`нет в паках: ${LINNORM}`);
    delete d._id;
    const A0 = await e.add({ ...d, name: "линнорм" }), V0 = await victim(e, "жертва линнорма");
    const tA = await e.tok(A0, 1000, 1000, -1), tV = await e.tok(V0, 1100, 1000, 1);
    await wait(700);
    const ab = bySlug(e.A(tA), "ice-linnorm-venom");
    t.ok(!!ab, "у копии есть Ice Linnorm Venom");
    const res = api().resolveRule(ab);
    t.ok(res?.source === "catalog", `правило каталога (${res?.source})`);
    t.ok(!!(await imp("strike-link.mjs")).strikeLinked(ab), "способность выведена на Удар (strikeLinked)");
    const s = strikeWith(e.A(tA), ab.slug);
    t.ok(!!s, "есть Удар с attackEffects этой способности");
    await rigSave(e, e.A(tV), "fortitude", res.rule.onUse.challenge.dc.value, "failure");
    await e.fix(10);
    await e.aim(tA, tV);
    const t0 = e.since();
    await bound("Удар", s.variants[0].roll({ event: SHIFT() }));
    const am = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "attack-roll"), 8000);
    t.ok(["success", "criticalSuccess"].includes(am?.flags?.pf2e?.context?.outcome), `попадание (${am?.flags?.pf2e?.context?.outcome})`);
    await bound("урон", s.damage({ event: SHIFT() }));
    await waitFor(() => carrier(e.A(tV)), 15000);
    const af = e.A(tV).items.filter((i) => i.flags?.[MOD]?.meta?.affliction);
    t.ok(af.length === 1 && af[0].system.badge?.value === 1, `недуг один, стадия 1 (${af.length}; ${af[0]?.system?.badge?.value})`);
  });

  sc("permanent-slow", "M6: зомби с Slow без правил — Slowed 1 и нет реакций; с готовым GrantItem — Slowed один, реакций нет; mode.effect off снимает", async (e, t) => {
    openChat();
    const prev = setting("mode.effect");
    try {
      const mk = async (uuid, name, x) => { const d = (await fromUuid(uuid))?.toObject(); if (!d) throw new Skip(`нет в паках: ${uuid}`); delete d._id; return e.tok(await e.add({ ...d, name }), x, 1000, -1); };
      const tN = await mk(ZOMBIE, "зомби без правил", 1000), tG = await mk(ZOMBIE_RE, "зомби с GrantItem", 1200);
      await wait(1000);
      // у части копий pf2e уже держит Slowed документом состояния; группа M6 — Slow без правил и без документа: убираем его у копии
      const docs = e.A(tN).itemTypes.condition.filter((c) => c.slug === "slowed" && e.A(tN)._source.items.some((x) => x._id === c.id));
      if (docs.length) await e.A(tN).deleteEmbeddedDocuments("Item", docs.map((c) => c.id));
      await wait(800);
      const n = e.A(tN), g = e.A(tG);
      t.ok(!!bySlug(n, "slow") && !bySlug(n, "slow").system.rules.length, "у Slow копии нет собственных правил");
      t.ok(slowed(n) === 1, `без правил: Slowed 1 (${slowed(n)})`);
      t.ok(await noReact(n), "без правил: реакции запрещены");
      t.ok(slowed(g) === 1, `с GrantItem: Slowed один, не два (${slowed(g)})`);
      t.ok(await noReact(g), "с GrantItem: реакции запрещены");
      t.ok(!n._source.items.some((i) => i.type === "condition"), "состояние только в памяти: в документах актёра условий нет");
      await game.settings.set(MOD, "mode.effect", "off");
      await wait(1500);
      t.ok(slowed(e.A(tN)) === 0 && !(await noReact(e.A(tN))), `mode.effect off: Slowed снят (${slowed(e.A(tN))}), реакции вернулись`);
      t.ok(slowed(e.A(tG)) === 1 && !(await noReact(e.A(tG))), "off: готовый GrantItem pf2e остался (это его механика), запрет реакций снят");
      await game.settings.set(MOD, "mode.effect", prev);
      await wait(1500);
      t.ok(slowed(e.A(tN)) === 1 && (await noReact(e.A(tN))), "режим вернули: снова Slowed 1 и без реакций");
    } finally { await game.settings.set(MOD, "mode.effect", prev).catch(() => {}); }
  });

  sc("reach-npc", "M8: Reach Spell у NPC без переключателя — эффект и +30 фт до сотворения; Reach Spell → Удар → сотворение — без +30", async (e, t) => {
    openChat();
    const d = (await fromUuid(MAGE))?.toObject(); if (!d) throw new Skip(`нет в паках: ${MAGE}`);
    delete d._id;
    const M0 = await e.add({ ...d, name: "маг" }), V0 = await victim(e, "цель");
    const tM = await e.tok(M0, 1000, 1000, -1), tV = await e.tok(V0, 1100, 1000, 1);
    await wait(900);
    const a = () => e.A(tM), reach = a().items.find((i) => i.system.slug === "reach-spell"), spell = a().itemTypes.spell[0];
    t.ok(!!reach && !!spell, "у копии есть Reach Spell и заклинание");
    t.ok(!reach.system.rules.some((r) => r.key === "RollOption"), "переключателя pf2e у Reach Spell нет");
    const ss = await imp("builtin/spellshape.mjs"), rg = await imp("range.mjs");
    t.ok(ss.optionOf(reach) === "reach-spell", `опция выведена по slug (${ss.optionOf(reach)})`);
    const base = rg.itemRange(spell, []), plus = rg.itemRange(spell, ["spellshape:reach-spell"]);
    t.ok(!base || JSON.stringify(base) !== JSON.stringify(plus), `itemRange с Reach Spell больше (${JSON.stringify(base)} → ${JSON.stringify(plus)})`);
    await e.aim(tM, tV);
    const used = await useAction(e, reach);
    t.ok(!!used, "карточка Reach Spell");
    t.ok(await waitFor(() => shapeFx(a()), 8000), "эффект метамагии на токене NPC");
    t.ok(a().rollOptions.all["spellshape:reach-spell"] === true, "опция spellshape:reach-spell у актёра");
    const c1 = await castMsg(a(), spell);
    t.ok(await waitFor(() => shapeFx(a())?.flags?.[MOD]?.spentBy === c1.id, 8000), "сотворение: эффект помечен потраченным (+30 действует на это сотворение)");
    const c2 = await castMsg(a(), spell);
    t.ok(await waitFor(() => !shapeFx(a()), 8000), "следующее сотворение снимает эффект");
    // Reach Spell -> Удар -> сотворение
    await useAction(e, reach);
    t.ok(await waitFor(() => shapeFx(a()), 8000), "Reach Spell снова: эффект есть");
    const s = a().system.actions.find((x) => x.item?.isMelee) ?? a().system.actions[0];
    t.ok(!!s, "у мага есть Удар");
    await e.fix(10);
    const t0 = e.since();
    await bound("Удар", s.variants[0].roll({ event: SHIFT() }));
    t.ok(!!(await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "attack-roll"), 8000)), "бросок Удара");
    t.ok(await waitFor(() => !shapeFx(a()), 8000), "Удар — другое действие: эффект Reach Spell снят");
    await castMsg(a(), spell);
    await wait(1500);
    t.ok(!shapeFx(a()) && !a().rollOptions.all["spellshape:reach-spell"], "сотворение после Удара — без +30");
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  const applyPrev = setting("mode.apply");
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами
    if (applyPrev !== "auto") await game.settings.set(MOD, "mode.apply", "auto");   // по умолчанию button: результаты не выдаются сами
    for (const s of pick) {
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0;
      try {
        e = await newEnv(s.id); cur = e;
        const run = s.run(e, t); run.catch(() => {});
        let timer;
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут 170 с; ${hangInfo(e)}`)), 170000); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} strike-ability | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      // шум ядра/pf2e при уборке: всплывающий текст токена дорисовывается после удаления сцены (не модуль)
      const errs = notes.filter((n) => /^(console\.error|uncaught)/.test(n) && !/createScrollingText|showFloatyText|reading 'position'\) at set y/.test(n));
      if (errs.length) { status = "fail"; detail += ` | ошибки: ${errs.slice(0, 3).join(" / ")}`; }
      else if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 4).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    console.error = ceOrig;
    window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr);
    try { await game.settings.set(MOD, "mode.apply", applyPrev); } catch { /* ok */ }
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afSAResult = out;
  return out;
}

