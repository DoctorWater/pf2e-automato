async () => {
  // Живые сценарии области (area-cleanup.mjs): мгновенная область модуля исчезает, когда всё разрешено; зона и чужой регион остаются; у областей модуля — skip Toolbelt.
  // Копии «AF тест: …» и сцена создаются и удаляются сценарием. Параметры: window.__afAT = { only, skip, cleanOnly }. Результат — window.__afATResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afAT ?? {}) };
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

  // ---------- уборка (аварийная: window.__afAT = {cleanOnly: true}) ----------
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
    for (const s of scenes) if (s.regions.size) await s.deleteEmbeddedDocuments("Region", s.regions.map((r) => r.id)).catch(() => {});   // до карточек: иначе deleteChatMessage модуля удаляет регион уже удаляемой сцены
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

  // ---------- сценарии: области карточек модуля ----------
  const TB = (r) => r?.flags?.["pf2e-toolbelt"]?.targetHelper?.skip;
  const here = (e, r) => !!r && e.scene.regions.has(r.id);
  /** Регионы-«чужие»: без карточки модуля и с обычным сообщением чата. Остаются при любом исходе сценария. */
  const foreign = async (e) => {
    const plain = await ChatMessage.create({ content: "AF тест: обычное сообщение" });
    const mk = (name, flags) => e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}${name}`, color: "#aa5500", shapes: [{ type: "circle", hole: false, x: 200, y: 200, radius: 100 }], behaviors: [], flags }]).then((r) => r[0]);
    return { none: await mk("чужой без карточки", {}), plain: await mk("чужой с обычным сообщением", { pf2e: { messageId: plain.id } }) };
  };
  const FRIGHT = [{ condition: { slug: "frightened", value: 1 } }];

  sc("no-damage", "Мгновенная область без урона (испытание с состоянием): есть до результатов, исчезает после применения; чужие регионы остаются; skip Toolbelt", async (e, t) => {
    openChat();
    const A0 = await e.foe("автор"), V1 = await victim(e, "провал"), V2 = await victim(e, "успех");
    const tA = await e.tok(A0, 1000, 1000, -1), t1 = await e.tok(V1, 1100, 1000, 1), t2 = await e.tok(V2, 1000, 1200, 1);
    await wait(800);
    const f = await foreign(e);
    const rule = { v: 1, onUse: { targets: "area", challenge: { statistic: "will", dc: { value: 17 }, basic: false, byDegree: { failure: FRIGHT, criticalFailure: FRIGHT } } } };
    const it = await e.ruleItem(e.A(tA), rule);
    await rigSave(e, e.A(t1), "will", 17, "failure");
    await rigSave(e, e.A(t2), "will", 17, "success");
    await e.fix(10);
    await e.aim(tA);
    const m = await useAction(e, it);
    t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
    const region = await area(e, m, 1050, 1050, 400, "burst");
    t.ok(!!region, "область создана");
    t.ok(TB(region) === true, `у области модуля стоит skip Toolbelt (${TB(region)})`);
    t.ok(await waitFor(() => cnd(e.A(t1), "frightened") === 1, 12000), `провал: испуг 1 (${cnd(e.A(t1), "frightened")})`);
    t.ok(await waitFor(() => !here(e, region), 8000), "область исчезла после применения");
    t.ok(here(e, f.none) && here(e, f.plain), "чужие регионы (без карточки / с обычным сообщением) на месте");
    t.ok(TB(f.none) == null && TB(f.plain) == null, "у чужих регионов skip не ставится");
  });

  sc("zone", "Зона с длительностью (onUse.zone): область остаётся, skip Toolbelt стоит", async (e, t) => {
    openChat();
    const A0 = await e.foe("автор");
    const tA = await e.tok(A0, 1000, 1000, -1);
    await wait(700);
    const it = await e.ruleItem(e.A(tA), { v: 1, onUse: { targets: "area", zone: { duration: { seconds: 600 }, condition: { slug: "concealed" } } } });
    await e.aim(tA);
    const m = await useAction(e, it);
    t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
    const region = await area(e, m, 1050, 1050, 300, "burst");
    t.ok(!!region, "область создана");
    t.ok(await waitFor(() => region.behaviors.some((b) => b.type === `${MOD}.zone`), 8000), "поведение зоны навешено");
    t.ok(TB(region) === true, `skip Toolbelt (${TB(region)})`);
    await wait(5000);
    t.ok(here(e, region), "зона осталась");
  });

  sc("damage", "Мгновенная область с уроном (Огненный шар): шаблон есть до урона, исчезает после нанесения", async (e, t) => {
    openChat();
    const A0 = await e.foe("заклинатель"), V1 = await victim(e, "жертва 1"), V2 = await victim(e, "жертва 2");
    const [entry] = await e.give(A0, { type: "spellcastingEntry", name: "AF", system: { ability: { value: "cha" }, spelldc: { value: 0, dc: 20 }, tradition: { value: "arcane" }, prepared: { value: "innate" } } });
    const fb = await find("pf2e.spells-srd", "fireball"); fb.system.location = { value: entry.id };
    const [sp0] = await e.give(A0, fb);
    const tA = await e.tok(A0, 1000, 1000, -1), t1 = await e.tok(V1, 1300, 1000, 1), t2 = await e.tok(V2, 1300, 1200, 1);
    await wait(900);
    const sp = e.A(tA).items.get(sp0.id), ent = e.A(tA).items.get(entry.id);
    await rigSave(e, e.A(t1), "reflex", 20, "failure");
    await rigSave(e, e.A(t2), "reflex", 20, "success");
    await e.fix(10);
    await e.aim(tA);
    const t0 = e.since();
    await bound("cast", ent.cast(sp, { rank: 3, message: true }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === sp.uuid), 8000);
    t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
    const region = await area(e, m, 1300, 1100, 400, "burst");
    t.ok(!!region, "область создана");
    t.ok(TB(region) === true, `skip Toolbelt (${TB(region)})`);
    const done = () => Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length >= 2;
    t.ok(await waitFor(done, 14000), `результаты спасбросков обеих целей (${JSON.stringify(e.results(m))})`);
    await wait(3000);
    t.ok(here(e, region), "после спасбросков, до урона, шаблон на месте");
    const btn = await waitFor(() => e.dom(m)?.querySelector("[data-action=spell-damage]"), 8000);
    t.ok(!!btn, "кнопка урона на карточке");
    const hp0 = e.A(t1).hitPoints.value;
    btn?.click();
    t.ok(await waitFor(() => e.A(t1).hitPoints.value < hp0, 15000), "урон нанесён провалившему");
    t.ok(await waitFor(() => !here(e, region), 10000), "шаблон исчез после нанесения урона");
    // п.2 критика: карточка закрыта, «Разместить» не возвращается, повторный регион целей не берёт
    t.ok(await waitFor(() => e.use(m)?.state?.area?.closed === true, 5000), "карточка помечена state.area.closed");
    await wait(800);
    const showing = [...(e.dom(m)?.querySelectorAll("[data-action=spell-template], .paf-area-box") ?? [])].filter((b) => !b.hidden && b.offsetParent);
    t.ok(showing.length === 0, `кнопка «Разместить» скрыта (${showing.length})`);
    const before = JSON.stringify(e.results(m)), hp2 = e.A(t2).hitPoints.value, uuid0 = e.use(m).state.area.regionUuid;
    const again = await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}повторная область`, color: "#00aa55", shapes: [{ type: "circle", hole: false, x: 1300, y: 1100, radius: 400 }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: "burst", origin: { uuid: m.item?.uuid, type: m.item?.type, actor: m.actor?.uuid, token: m.token?.uuid } } } }]);
    await wait(4000);
    t.ok(!!again[0] && e.use(m).state.area.regionUuid === uuid0 && JSON.stringify(e.results(m)) === before, "повторный шаблон не меняет цели и результаты карточки");
    t.ok(e.A(t2).hitPoints.value === hp2, "новые спасброски/урон по повторной области не запущены");
  });

  sc("toolbelt-targets", "Target Helper Toolbelt включён: цели области модуль пишет в флаг Toolbelt (skip на регионе), спасброски — кнопками Toolbelt, до них область на месте", async (e, t) => {
    openChat();
    await game.settings.set(MOD, "useToolbeltTargetHelper", true);
    try {
      const A0 = await e.foe("автор"), V1 = await victim(e, "провал");
      const tA = await e.tok(A0, 1000, 1000, -1), t1 = await e.tok(V1, 1100, 1000, 1);
      await wait(800);
      const it = await e.ruleItem(e.A(tA), { v: 1, onUse: { targets: "area", challenge: { statistic: "will", dc: { value: 17 }, basic: false, byDegree: { failure: FRIGHT, criticalFailure: FRIGHT } } } });
      await rigSave(e, e.A(t1), "will", 17, "failure");
      await e.fix(10);
      await e.aim(tA);
      const m = await useAction(e, it);
      t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
      const region = await area(e, m, 1050, 1050, 400, "burst");
      t.ok(!!region && TB(region) === true, "область создана, skip стоит");
      const tb = () => game.messages.get(m.id)?.flags?.["pf2e-toolbelt"]?.targetHelper?.targets ?? [];
      t.ok(await waitFor(() => tb().includes(e.T(t1).uuid), 8000), `цель области в флаге Toolbelt (${JSON.stringify(tb())})`);
      await wait(5000);
      t.ok(here(e, region) && !Object.keys(e.results(m)).length, `спасброски не брошены — область на месте (${JSON.stringify(e.results(m))})`);
    } finally { await game.settings.set(MOD, "useToolbeltTargetHelper", false); }
  });

  sc("target-steps-button-apply", "Шаги на цель без испытания при apply=button, effect=auto: область исчезает (ждёт effect, не apply)", async (e, t) => {
    openChat();
    const prev = setting("mode.apply");
    await game.settings.set(MOD, "mode.apply", "button");
    try {
      const A0 = await e.foe("автор"), V1 = await victim(e, "цель");
      const tA = await e.tok(A0, 1000, 1000, -1), t1 = await e.tok(V1, 1100, 1000, 1);
      await wait(800);
      const it = await e.ruleItem(e.A(tA), { v: 1, onUse: { targets: "area", apply: [{ to: "target", condition: { slug: "frightened", value: 1 } }] } });
      await e.aim(tA);
      const m = await useAction(e, it);
      t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
      const region = await area(e, m, 1050, 1050, 400, "burst");
      t.ok(!!region, "область создана");
      t.ok(await waitFor(() => cnd(e.A(t1), "frightened") === 1, 12000), "шаг на цель применён");
      t.ok(await waitFor(() => !here(e, region), 8000), "область исчезла");
    } finally { await game.settings.set(MOD, "mode.apply", prev); }
  });

  sc("check-area", "Область с проверкой автора (onUse.check): до броска проверки не удаляется", async (e, t) => {
    openChat();
    const player = game.users.find((u) => !u.isGM);
    if (!player) throw new Skip("нет пользователя-игрока: проверку автора без владельца-игрока бросает ГМ");
    const A0 = await e.pc("автор"), V1 = await e.foe("цель");   // автор с владельцем-игроком: его проверку модуль сам не бросает
    await A0.update({ [`ownership.${player.id}`]: 3 });
    const tA = await e.tok(A0, 1000, 1000, 1), t1 = await e.tok(V1, 1100, 1000, -1);
    await wait(800);
    const it = await e.ruleItem(e.A(tA), { v: 1, onUse: { targets: "area", apply: [], check: { statistic: "athletics", vs: { defense: "fortitude" }, byDegree: { success: [{ to: "target", condition: { slug: "frightened", value: 1 } }] } } } });
    await e.aim(tA);
    const m = await useAction(e, it);
    t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
    const region = await area(e, m, 1050, 1050, 400, "burst");
    t.ok(!!region, "область создана");
    await wait(6000);
    t.ok(here(e, region), "проверку автора не бросали — область на месте");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} area-templates | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      // шум ядра/pf2e при уборке: всплывающий текст токена дорисовывается после удаления сцены (не модуль)
      const errs = notes.filter((n) => /^(console\.error|uncaught)/.test(n) && !/createScrollingText|showFloatyText|reading 'position'\) at set y|dice-calculator/.test(n));
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
  window.__afATResult = out;
  return out;
}
