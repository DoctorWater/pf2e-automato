async () => {
  // Живые сценарии противников мира RustySpirit (папка «Противники»): копии «AF тест: …», тестовая сцена создаётся и удаляется сценарием.
  // Окна выбора модуля отвечаются очередью e.answers (подпись или значение варианта; null — закрыть).
  // Параметры: window.__afEN = { only, skip, cleanOnly }. Результат — window.__afRSResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afEN ?? {}) };
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

  // ---------- уборка (аварийная: window.__afEN = {cleanOnly: true}) ----------
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

  // ---------- сценарии: противники RustySpirit (папка «Противники») ----------
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

  sc("strikes", "Удары всех противников: атака и урон кнопкой по формуле статблока; Ветвь бьёт на 10 фт, на 15 фт блок досягаемости", async (e, t) => {
    openChat();
    const cases = [["spirit", /1d6\s*\+\s*2/, "Когти"], ["fox", /1d4\s*\+\s*1/, "Укус"], ["sprout", /1d4\s*\+\s*2/, "Хлёсткая лоза"], ["guard", /1d8\s*\+\s*4/, "Удар ветвью"]];
    let x = 400;
    for (const [key, re, name] of cases) {
      const A0 = await copyFoe(e, EN[key]), V0 = await victim(e, `цель ${key}`);
      const dist = key === "guard" ? 200 : 100;
      const tA = await e.tok(A0, x, 500, -1), tV = await e.tok(V0, x + dist, 500, 1);
      await wait(600);
      t.ok(e.strike(e.A(tA))?.label === name, `${key}: Удар «${name}» (${e.strike(e.A(tA))?.label})`);
      const att = await e.hit(tA, tV);
      t.ok(!!att, `${key}: атака на ${dist / 20} фт состоялась`);
      const dm = await dmgOf(e, tA);
      t.ok(re.test(dm?.rolls?.[0]?.formula ?? ""), `${key}: урон ${dm?.rolls?.[0]?.formula}`);
      x += 500;
    }
    // досягаемость Ветви: 15 фт — блок модуля (melee-reach), атаки нет
    const G0 = await copyFoe(e, EN.guard, "страж дальний"), V1 = await victim(e, "цель 15 фт");
    const tG = await e.tok(G0, 400, 1200, -1), tV = await e.tok(V1, 700, 1200, 1);
    await wait(600);
    const n0 = notes.length;
    await e.aim(tG, tV);
    const t0 = e.since();
    await bound("Удар на 15 фт", e.strike(e.A(tG)).variants[0].roll({ event: SHIFT() }));
    await wait(1500);
    t.ok(!e.msgs(t0).some((m) => m.flags?.pf2e?.context?.type === "attack-roll"), "на 15 фт атаки нет");
    t.ok(notes.slice(n0).some((n) => /досягаем|reach/i.test(n)), `предупреждение о досягаемости (${notes.slice(n0).join(" / ")})`);
  });

  sc("pack-attack", "Стайный без переключателя: опция считается в момент урона — один союзник у цели без 1d4, два +1d4; цель урона (карточка и targets) решает; Phantom Wolf — порог 1", async (e, t) => {
    openChat();
    const F1 = await copyFoe(e, EN.fox, "лиса 1"), F2 = await copyFoe(e, EN.fox, "лиса 2"), S0 = await copyFoe(e, EN.spirit), V0 = await victim(e, "жертва"), V2 = await victim(e, "одинокая жертва");
    const tF1 = await e.tok(F1, 1000, 1000, -1), tV = await e.tok(V0, 1100, 1000, 1), tF2 = await e.tok(F2, 1200, 1000, -1), tV2 = await e.tok(V2, 1100, 1800, 1);
    await wait(700);
    const toggles = (a) => Object.values(a.synthetics.toggles ?? {}).flatMap((d) => Object.keys(d)).filter((o) => o === "pack-attack");
    t.ok(toggles(e.A(tF1)).length === 0, `переключателя нет в synthetics.toggles (${toggles(e.A(tF1))})`);
    const d4 = (dm) => [...(dm?.rolls?.[0]?.formula ?? "").matchAll(/(\d+)d4/g)].reduce((n, x) => n + Number(x[1]), 0);   // pf2e складывает кубы: Укус 1d4 + Стайный 1d4 = 2d4
    const round = async (tAtt, tDef, want, label) => {
      t.ok(!!(await e.hit(tAtt, tDef)), `${label}: атака`);
      const dm = await dmgOf(e, tAtt);   // сразу после попадания, без ожидания переключателя
      t.ok(d4(dm) === want, `${label}: урон ${dm?.rolls?.[0]?.formula}`);
    };
    await round(tF1, tV, 1, "один союзник");
    const tS = await e.tok(S0, 1100, 900, -1);
    await wait(700);
    await round(tF1, tV, 2, "два союзника");
    // цель урона: targets.first() переключена на одинокую жертву между атакой и уроном
    await e.hit(tF1, tV);
    await e.aim(tF1, tV2);
    t.ok(d4(await dmgOf(e, tF1)) === 1, "targets: цель урона — одинокая жертва, без Стайного");
    // путь кнопки карточки pf2e: цель карточки (c.target) приоритетнее targets
    const t0 = e.since();
    await bound("урон по цели карточки", e.strike(e.A(tF1)).damage({ event: SHIFT(), target: e.T(tV).object }));
    const cm = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "damage-roll"), 8000);
    t.ok(d4(cm) === 2, `карточка: цель карточки — жертва с двумя союзниками (${cm?.rolls?.[0]?.formula})`);
    await e.T(tS).update({ x: 1600, y: 300 }, { animate: false }); await wait(1200);
    await round(tF1, tV, 1, "союзник ушёл");
    // Phantom Wolf: тот же slug pack-attack, порог 1 по источнику актёра
    const PW = "Compendium.pf2e.season-of-ghosts-bestiary.Actor.R805QpID53EycZ5E";
    const W = await copyFoe(e, EN.fox, "призрачный волк"); await W.update({ "_stats.compendiumSource": PW });
    const V3 = await victim(e, "жертва волка"), F3 = await copyFoe(e, EN.fox, "союзник волка");
    const tW = await e.tok(W, 400, 400, -1), tV3 = await e.tok(V3, 500, 400, 1);
    await wait(700);
    await round(tW, tV3, 1, "волк без союзников");
    await e.tok(F3, 500, 300, -1); await wait(700);
    await round(tW, tV3, 2, "волк: один союзник — порог 1");
  });

  sc("voices", "Лесные голоса: эманация 15 фт, Воля СЛ 17 — провал испуг 1, крит. провал испуг 2 (и у союзной лисы); нежить и сам дух не участвуют; второе использование — блок, Alt — карточка", async (e, t) => {
    openChat();
    const S0 = await copyFoe(e, EN.spirit), F0 = await copyFoe(e, EN.fox);
    const V1 = await victim(e, "жертва"), U = await victim(e, "нежить", ["undead"]), far = await victim(e, "далёкий");
    const tS = await e.tok(S0, 1000, 1000, -1), tV = await e.tok(V1, 1100, 1000, 1), tF = await e.tok(F0, 1000, 1100, -1), tU = await e.tok(U, 900, 1000, 1), tFar = await e.tok(far, 1400, 1000, 1);
    await wait(800);
    const SA = e.A(tS), item = bySlug(SA, "forest-voices");
    t.ok(item?.system.frequency?.value === 1, `частота 1 (${JSON.stringify(item?.system.frequency)})`);
    await rigSave(e, e.A(tV), "will", 17, "failure");
    await rigSave(e, e.A(tF), "will", 17, "criticalFailure");
    await e.fix(10);
    await e.aim(tS);
    const m = await useAction(e, item);
    t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
    t.ok(bySlug(e.A(tS), "forest-voices").system.frequency.value === 0, "частота списана");
    const region = await area(e, m, 1050, 1050, 350, "emanation");
    t.ok(!!region, "область создана");
    await waitFor(() => cnd(e.A(tV), "frightened") && cnd(e.A(tF), "frightened"), 12000);
    t.ok(cnd(e.A(tV), "frightened") === 1, `жертва: испуг 1 (${cnd(e.A(tV), "frightened")})`);
    t.ok(cnd(e.A(tF), "frightened") === 2, `лиса: испуг 2 (${cnd(e.A(tF), "frightened")})`);
    t.ok(!cnd(e.A(tU), "frightened"), "нежить без испуга");
    t.ok(!cnd(e.A(tS), "frightened"), "дух без испуга");
    t.ok(!cnd(e.A(tFar), "frightened"), "далёкий без испуга");
    const keys = Object.keys(e.use(m)?.state?.challenge?.results ?? {});
    t.ok(!keys.some((k) => k.includes(tU.id)) && !keys.some((k) => k.includes(tS.id)), `в бросках нет нежити и духа (${keys.length})`);
    // второе использование
    const n0 = notes.length;
    const m2 = await useAction(e, bySlug(e.A(tS), "forest-voices"), 3000);
    t.ok(!m2, "второе использование: карточки нет");
    t.ok(notes.slice(n0).some((n) => /частота|использований не осталось/i.test(n)), `предупреждение (${notes.slice(n0).join(" / ")})`);
    const m3 = await withAlt(() => useAction(e, bySlug(e.A(tS), "forest-voices"), 4000));
    t.ok(!!m3, "Alt: карточка есть");
  });

  sc("roots", "Ржавые корни: область дальше 30 фт не ставится; Рефлекс СЛ 17 — провал: неподвижность + шёпот Освобождения СЛ 15, успех — ничего; Освобождение снимает; второе использование — блок", async (e, t) => {
    openChat();
    const G0 = await copyFoe(e, EN.guard), V1 = await victim(e, "провал"), V2 = await victim(e, "успех");
    const tG = await e.tok(G0, 1000, 1000, -1), t1 = await e.tok(V1, 1500, 1000, 1), t2 = await e.tok(V2, 1600, 1000, 1);
    await wait(800);
    await rigSave(e, e.A(t1), "reflex", 17, "failure");
    await rigSave(e, e.A(t2), "reflex", 17, "success");
    await e.fix(10);
    await e.aim(tG);
    const m = await useAction(e, bySlug(e.A(tG), "rusted-roots"));
    t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
    const tooFar = await area(e, m, 1900, 1050, 200, "burst");
    t.ok(!tooFar, "область в 42 фт не создана");
    const region = await area(e, m, 1600, 1050, 200, "burst");
    t.ok(!!region, "область в 27 фт создана");
    await waitFor(() => cnd(e.A(t1), "immobilized"), 12000);
    t.ok(!!cnd(e.A(t1), "immobilized"), "провал: неподвижность");
    t.ok(!cnd(e.A(t2), "immobilized"), "успех: без неподвижности");
    t.ok(!cnd(e.A(tG), "immobilized"), "хранитель не задет");
    const w = await waitFor(() => game.messages.contents.findLast((x) => x.flags?.[MOD]?.escape?.actor === e.A(t1).uuid), 6000);
    t.ok(w?.flags?.[MOD]?.escape?.dc === 15, `шёпот Освобождения СЛ 15 (${w?.flags?.[MOD]?.escape?.dc})`);
    await e.rig(e.A(t1), "skill-check", 30);
    const btn = await waitFor(() => e.dom(w)?.querySelector("[data-af-escape]"), 6000);
    btn?.click();
    t.ok(await waitFor(() => !cnd(e.A(t1), "immobilized"), 12000), "Освобождение сняло неподвижность");
    const n0 = notes.length;
    t.ok(!(await useAction(e, bySlug(e.A(tG), "rusted-roots"), 3000)), "второе использование: карточки нет");
    t.ok(notes.slice(n0).some((n) => /частота|использований не осталось/i.test(n)), "предупреждение о частоте");
  });

  sc("passive", "В лесу как дома, Осквернить ритуал, Опутать камень: карточка без кнопок модуля (сюжетное не автоматизируем)", async (e, t) => {
    openChat();
    for (const [key, slug] of [["spirit", "woodland-stride"], ["guard", "defile-ritual"], ["sprout", "entangle-stone"]]) {
      const a = await copyFoe(e, EN[key]);
      const tk = await e.tok(a, 600, 600, -1); await wait(500);
      const it = bySlug(e.A(tk), slug);
      t.ok(!!it, `${key}: есть ${slug}`);
      const t0 = e.since();
      await bound("toMessage", it.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === it.uuid), 6000);
      await wait(1200);
      const u = e.use(m);
      t.ok(!!m && !(u?.rule?.onUse?.challenge || u?.rule?.onUse?.apply?.length), `${key}: карточка без шагов модуля`);
      t.ok(!e.dom(m)?.querySelector(".pf2e-automato button"), `${key}: нет кнопок модуля`);
      await e.T(tk).delete();
    }
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} enemies | ${s.id}`, err); }
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
  window.__afENResult = out;
  return out;
}
