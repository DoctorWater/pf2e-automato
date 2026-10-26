async () => {
  // Живые сценарии repeat-save (шаг apply.repeat): повторный спасбросок цели на конце её хода, снятие носителя, автор удалён. plan-triggered-save.md, T1.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в strike-gate.js. Правило — флаг rule на временном предмете-действии (validateRule), не каталог.
  // Параметры (перед запуском): window.__afRepeatSave = { only: ["apply", ...], skip: [...], cleanOnly: true }
  // «Повтор запустился» = новое сообщение с flags.pf2e-automato.use.state.event (карточка hostChallenge). Нужны mode.challenge и mode.apply = auto.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afRepeatSaveResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afRepeatSave ?? {}) };
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

  // ---------- уборка (аварийная: window.__afRepeatSave = {cleanOnly: true}) ----------
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name) || test(game.scenes.get(x.sceneId)?.name)))) await c.delete().catch(() => {});
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
          e.dialogs.push(el.querySelector(".window-title")?.textContent?.trim() ?? el.id);
          foundry.applications.instances.get(el.id)?.close();
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


  // ---------- сценарии repeat-save ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const OK_DEG = ["success", "criticalSuccess"];
  // Правило-образец (Undermine Reality в упрощении): Воля СЛ 20; провал и крит. провал -> замедлен 1 (не проходит сам, в отличие от испуга), в конце хода цели повторный спасбросок, успех и крит. успех снимают.
  const REPEAT = { on: "turn-end", end: OK_DEG };
  const step = { to: "target", condition: { slug: "slowed", value: 1 }, repeat: REPEAT };
  // Испуг убывает сам в конце хода цели: обёртка не должна остаться пустой (cascade) и слать карточки
  const FEAR = (r) => ({ ...r, onUse: { ...r.onUse, challenge: { ...r.onUse.challenge, byDegree: Object.fromEntries(Object.entries(r.onUse.challenge.byDegree).map(([k, v]) => [k, v.map((x) => ({ ...x, condition: { slug: "frightened", value: 1 } }))])) } } });
  const RULE = { v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: [step], criticalFailure: [step] } } } };

  /** Карточки испытаний модуля (host-сообщения: flags.<MOD>.use.state.event) после t0. */
  const hosts = (e, t0) => e.msgs(t0).filter((m) => m.flags?.[MOD]?.use?.state?.event);
  const carrier = (a) => a.items.find((i) => i.flags?.[MOD]?.meta?.repeat) ?? null;
  const nextTurn = async (c) => { await bound("nextTurn", c.nextTurn()); await wait(2500); };

  /** PC-автор и NPC-цель в бою (автор ходит первым); правило-действие брошено в цель при d20=1 -> цель провалила и замедлена с носителем. */
  const cast = async (e, rule = RULE) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("автор"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const item = await e.ruleItem(pc, rule);
    const c = await e.combat([tP, tV], [20, 10]);
    await c.startCombat(); await wait(1200);
    await e.fix(1);
    const m = await e.fire(item, tP, tV);
    const hit = await waitFor(() => carrier(e.A(tV)), 8000);
    return { pc, vic, tP, tV, c, m, hit };
  };

  sc("apply", "Провал спасброска: замедление висит в своей обёртке с meta.repeat (СЛ 20, Воля, конец хода)", async (e, t) => {
    const { tV, m, hit } = await cast(e);
    t.ok(!OK_DEG.includes(e.results(m)[tV.id]), `цель провалила (${e.results(m)[tV.id]})`);
    t.ok(!!hit, "носитель создан");
    const r = hit?.flags?.[MOD]?.meta?.repeat;
    t.ok(r?.on === "turn-end" && r?.statistic === "will" && r?.dc === 20, `meta.repeat: ${JSON.stringify(r)}`);
    t.ok(hit?.type === "effect" && !!e.cond(e.A(tV), "slowed"), "обёртка-эффект и выданное ею замедление");
  });

  sc("save-success", "Конец хода цели: NPC бросает сам, успех (d20=20) снимает носитель и замедление; карточка одна", async (e, t) => {
    const { tV, c } = await cast(e);
    const t0 = e.since();
    await nextTurn(c);   // ход цели
    t.ok(c.combatant?.actor?.id === e.A(tV).id || c.combatant?.tokenId === tV.id, "ход цели");
    t.ok(hosts(e, t0).length === 0, `в начале хода карточки нет (${hosts(e, t0).length})`);
    await e.fix(20);
    await nextTurn(c);
    const h = hosts(e, t0);
    t.ok(h.length === 1, `в конце хода одна карточка повтора (${h.length})`);
    const res = e.results(h[0])?.[tV.id];
    t.ok(OK_DEG.includes(res), `NPC бросил автоматически: ${res}`);
    t.ok(await waitFor(() => !carrier(e.A(tV)), 6000), "носитель снят");
    t.ok(!e.cond(e.A(tV), "slowed"), "замедление снято вместе с обёрткой");
  });

  sc("save-fail", "Провал повтора (d20=1): носитель остаётся, в следующем раунде — новая карточка", async (e, t) => {
    const { tV, c } = await cast(e);
    const t0 = e.since();
    await nextTurn(c);
    await nextTurn(c);   // конец хода цели при d20=1
    t.ok(hosts(e, t0).length === 1, `одна карточка (${hosts(e, t0).length})`);
    t.ok(!OK_DEG.includes(e.results(hosts(e, t0)[0])?.[tV.id]), `повтор провален (${e.results(hosts(e, t0)[0])?.[tV.id]})`);
    t.ok(!!carrier(e.A(tV)) && !!e.cond(e.A(tV), "slowed"), "носитель и замедление на месте");
    await nextTurn(c);   // ход автора, раунд 2
    await nextTurn(c);   // ход цели
    await nextTurn(c);   // конец хода цели раунда 2
    t.ok(hosts(e, t0).length === 2, `в раунде 2 вторая карточка (${hosts(e, t0).length})`);
  });

  sc("author-gone", "Автор удалён: повтор всё равно идёт по снимку (СЛ 20), успех снимает носитель", async (e, t) => {
    const { pc, tP, tV, c } = await cast(e);
    await nextTurn(c);   // ход цели
    await e.scene.deleteEmbeddedDocuments("Token", [tP.id]); await pc.delete(); await wait(800);
    t.ok(!game.actors.get(pc.id), "автор удалён");
    t.ok(!!carrier(e.A(tV)), "носитель пережил автора");
    const t0 = e.since();
    await e.fix(20);
    await nextTurn(c);
    const h = hosts(e, t0);
    t.ok(h.length === 1, `карточка повтора есть (${h.length})`);
    t.ok(h[0]?.flags?.[MOD]?.use?.dc === 20, `СЛ из снимка (${h[0]?.flags?.[MOD]?.use?.dc})`);
    t.ok(OK_DEG.includes(e.results(h[0])?.[tV.id]), `бросок цели: ${e.results(h[0])?.[tV.id]}`);
    t.ok(await waitFor(() => !carrier(e.A(tV)), 6000), "носитель снят");
  });

  sc("fear-drops", "Испуг 1 падает сам в конце хода цели: обёртки нет, в следующем раунде карточек повтора нет", async (e, t) => {
    const { tV, c } = await cast(e, FEAR(RULE));
    t.ok(!!e.cond(e.A(tV), "frightened"), "испуг наложен");
    const t0 = e.since();
    await nextTurn(c); await nextTurn(c);   // ход цели и его конец
    t.ok(await waitFor(() => !e.cond(e.A(tV), "frightened"), 6000), "испуг упал сам");
    t.ok(await waitFor(() => !carrier(e.A(tV)), 6000), "обёртки-носителя нет");
    const n = hosts(e, t0).length;
    await nextTurn(c); await nextTurn(c); await nextTurn(c);   // раунд 2: ход автора, цели, конец хода цели
    t.ok(hosts(e, t0).length === n, `в раунде 2 карточек повтора нет (${n} -> ${hosts(e, t0).length})`);
  });

  sc("undo", "Успех повтора -> откат (undoOps карточки): носитель и выданное состояние вернулись", async (e, t) => {
    const { tV, c } = await cast(e);
    const t0 = e.since();
    await nextTurn(c);
    await e.fix(20);
    await nextTurn(c);
    const h = hosts(e, t0)[0];
    t.ok(!!h && OK_DEG.includes(e.results(h)?.[tV.id]), `успех повтора (${e.results(h)?.[tV.id]})`);
    t.ok(await waitFor(() => !carrier(e.A(tV)), 6000), "носитель снят");
    await bound("undoOps", (await imp("apply.mjs")).undoOps(game.messages.get(h.id), tV.id));
    t.ok(await waitFor(() => carrier(e.A(tV)), 6000), "носитель вернулся");
    t.ok(await waitFor(() => e.cond(e.A(tV), "slowed"), 6000), "выданное состояние вернулось");
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами
    for (const s of pick) {
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0;
      try {
        e = await newEnv(s.id); cur = e;
        const run = s.run(e, t); run.catch(() => {});
        let timer;
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут 150 с; ${hangInfo(e)}`)), 150000); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} repeat-save | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 3).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  const table = rows.map((r) => `${r.id.padEnd(18)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afRepeatSaveResult = result;
  return result;
}
