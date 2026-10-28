async () => {
  // Живой сценарий l3-chunk2: «Не надо пугаться» (No Cause for Alarm, кусок 2) — один бросок Дипломатии против Воли нескольких испуганных существ (check.oneRoll + check.when).
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в l3-chunk1: временные «AF тест: …» актёры/сцена, уборка в finally. Правило — rules/catalog.json (мировое действие с флагом правила). mode.apply сценарии переключают сами (auto / button) и возвращают в конце.
  // Автор — PC, бросает кнопкой (runCheck only) либо кликом по Дипломатии (сценарий click). СЛ Воли целей и d20 подгоняются: A — успех, B — крит. успех, C не испуган.
  // Параметры (перед запуском): window.__afL3b = { only: ["repeat", ...], skip: [...], cleanOnly: true }. Нужен mode.challenge не off. Ожидание: PASS у one-roll-auto, repeat, button-expired, click; SKIP — только если СЛ Воли не выставилась или правило уступает pf2e-automations.
  // Результат: массив строк «PASS|FAIL|SKIP id: подробности» (то же в window.__afL3bResult и console.table).
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL3b ?? {}) };
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



  // ---------- сценарии l3-chunk2: «Не надо пугаться» (oneRoll + check.when) ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const FEAT = "Compendium.pf2e.feats-srd.Item.6ON8DjFXSMITZleX", SLUG = "no-cause-for-alarm";
  const catRule = async () => {
    const r = structuredClone((await (await fetch(`/modules/${MOD}/rules/catalog.json`)).json()).bySource[FEAT]);
    if (!r) throw new Error("нет правила No Cause for Alarm в catalog.json");
    return r;
  };
  const fval = (c) => (c ? (c.system?.value?.value ?? c.value ?? 1) : 0);
  const imm = (a) => a.items.find((i) => i.type === "effect" && i.flags?.[MOD]?.immunity?.slug === SLUG);
  // режим применения на время сценария (исходный возвращается в конце прогона)
  let origApply;
  const modeApply = async (v) => { if (origApply === undefined) origApply = setting("mode.apply"); if (setting("mode.apply") !== v) await game.settings.set(MOD, "mode.apply", v); };
  const prep = (c, m) => { if (!c) throw new Error(`подготовка: ${m}`); };

  /** Автор-PC (Дипломатия), три существа в области: A (испуг 2, СЛ Воли = итог−4 → успех), B (испуг 1, СЛ = итог−12 → крит. успех), C (не испуган, СЛ как у B). d20 автора = 10. */
  const setup = async (e) => {
    openChat(); needMode("mode.challenge", "off");
    const pc = await e.pc("жрец"), tP = await e.tok(pc, 100, 1000, 1);
    const toks = [];
    for (let i = 0; i < 3; i++) toks.push(await e.tok(await e.foe(`цель ${"ABC"[i]}`), 500 + i * 100, 500, 1));
    await wait(700);
    const [A, B, C] = toks.map((t) => e.A(t));
    await A.increaseCondition("frightened", { value: 2 }); await B.increaseCondition("frightened", { value: 1 });
    await wait(500);
    prep(fval(e.cond(A, "frightened")) === 2 && fval(e.cond(B, "frightened")) === 1, "испуг не выдан");
    await e.fix(10);
    const total = 10 + pc.getStatistic("diplomacy").check.mod;
    for (const [a, dc] of [[A, total - 4], [B, total - 12], [C, total - 12]]) {
      const d = dc - a.saves.will.dc.value;
      if (d) { await e.rig(a, "will", d); await wait(300); }
      if (a.saves.will.dc.value !== dc) throw new Skip(`не удалось выставить СЛ Воли ${dc} (есть ${a.saves.will.dc.value})`);
    }
    return { pc, tP, toks, A, B, C, total };
  };
  /** Карточка предмета-правила + регион на три токена. */
  const card = async (e, pc, tP, rule) => {
    const item = e.feat ?? (e.feat = await e.ruleItem(pc, rule));
    const t0 = e.since();
    await e.aim(tP);
    await bound("item.toMessage", item.toMessage(undefined, { create: true }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
    if (!m) throw new Error("у карточки нет снимка use");
    if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
    await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#00aa00", shapes: [{ type: "circle", hole: false, x: 600, y: 550, radius: 300 }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: "emanation" } } }]);
    await waitFor(() => (e.use(m)?.state?.area?.keys?.length ?? 0) >= 3, 10000);
    await wait(1500);
    return { m, item };
  };
  // броски проверок с момента t0: любое сообщение pf2e с контекстом-проверкой (тип у броска с целью/СЛ может быть не skill-check); types — для диагностики
  const rollMsgs = (e, t0) => e.msgs(t0).filter((x) => x.rolls?.length && /check/.test(x.flags?.pf2e?.context?.type ?? ""));
  const types = (e, t0) => e.msgs(t0).map((x) => x.flags?.pf2e?.context?.type ?? (x.flags?.[MOD] ? "module" : "chat")).join(",");
  const nres = (e, m) => Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length;

  sc("one-roll-auto", "Один бросок: A (успех) и B (крит. успех) — разные степени, испуг снижен, иммунитет 1 ч у обоих; C не испуган — вне карточки (apply=auto)", async (e, t) => {
    await modeApply("auto");
    const { pc, tP, toks: [a, b, c], A, B, C } = await setup(e);
    const { m } = await card(e, pc, tP, await catRule());
    const { runCheck } = await imp("checks.mjs");
    const t0 = e.since();
    await bound("runCheck(only)", runCheck(game.messages.get(m.id), { only: a.id }));   // автор-PC бросает кнопкой: один бросок на всех
    await waitFor(() => nres(e, m) >= 2, 8000);
    const r = e.results(m);
    t.ok(r[a.id] === "success" && r[b.id] === "criticalSuccess" && Object.keys(r).length === 2, `степени: ${JSON.stringify(r)}`);
    t.ok(!(c.id in r), "C (не испуган) не бросал");
    const res = e.use(m).state.challenge.results;
    // бросок один: у обеих целей один и тот же rollMessageId/итог, а сообщение броска существует (счёт по времени createdTime ненадёжен)
    const ids = [...new Set([a.id, b.id].map((k) => res[k]?.rollMessageId))], tots = [...new Set([a.id, b.id].map((k) => res[k]?.total))];
    t.ok(ids.length === 1 && tots.length === 1 && (!ids[0] || !!game.messages.get(ids[0])) && rollMsgs(e, t0).length <= 1,
      `бросок один: rollMessageId=${JSON.stringify(ids)}, итоги=${JSON.stringify(tots)}, по времени=${rollMsgs(e, t0).length}; сообщения с t0: [${types(e, t0)}]; результаты: ${JSON.stringify(res)}`);
    t.ok(res[a.id]?.dc !== res[b.id]?.dc, `СЛ у целей разные: ${res[a.id]?.dc}/${res[b.id]?.dc}`);
    t.ok(await waitFor(() => fval(e.cond(A, "frightened")) === 1, 8000), `у A испуг 2→1: ${fval(e.cond(A, "frightened"))}`);
    t.ok(await waitFor(() => !e.cond(B, "frightened"), 8000), "у B испуг 1→0 (крит. успех, −2)");
    for (const [n, x] of [["A", A], ["B", B]]) {
      const i = await waitFor(() => imm(x), 8000);
      t.ok(!!i && i.system.duration.unit === "hours" && i.system.duration.value === 1, `${n}: иммунитет 1 час: ${JSON.stringify(i?.system?.duration)}`);
    }
    t.ok(!imm(C), "у C иммунитета нет");
    // испуг у B снят применением, но цель осталась в списке карточки (when запомнен)
    const { challengeTargets } = await imp("saves.mjs");
    const keys = (await challengeTargets(game.messages.get(m.id))).map((x) => x.key);
    t.ok(keys.includes(a.id) && keys.includes(b.id) && !keys.includes(c.id), `цели карточки после применения: B на месте=${keys.includes(b.id)}, C вне=${!keys.includes(c.id)}`);
  });

  sc("repeat", "Повтор: цели с иммунитетом — карточка видит иммунитет (общий, без «your»), бросок их не затрагивает", async (e, t) => {
    await modeApply("auto");
    const { pc, tP, toks: [a], A, B } = await setup(e);
    const rule = await catRule();
    const first = await card(e, pc, tP, rule);
    const { runCheck, isImmune } = await imp("checks.mjs");
    await bound("runCheck#1", runCheck(game.messages.get(first.m.id), { only: a.id }));
    await waitFor(() => imm(A) && imm(B), 10000);
    t.ok(!!imm(A) && !!imm(B), "иммунитет после первого раза");
    await waitFor(() => fval(e.cond(A, "frightened")) === 1 && !e.cond(B, "frightened"), 8000);   // снижение испуга первым применением должно закончиться до новой выдачи
    await wait(500);
    await A.increaseCondition("frightened", { value: 2 });   // A снова испуган — но иммунен
    await e.fix(10); await wait(500);
    const before = fval(e.cond(A, "frightened"));
    t.ok(before >= 1, `A испуган перед повтором: ${before}`);
    const t0 = e.since();
    const second = await card(e, pc, tP, rule);
    const use2 = e.use(second.m);
    t.ok(await isImmune(use2, e.T(a), use2.rule.onUse.check), "isImmune(A): карточка видит иммунитет");
    const done = await bound("runCheck#2", runCheck(game.messages.get(second.m.id), { only: a.id }));
    t.ok(done.length === 0 && rollMsgs(e, t0).length === 0, `броска нет: done=${done.length}, бросков=${rollMsgs(e, t0).length} [${types(e, t0)}]`);
    t.ok(nres(e, second.m) === 0, "результатов нет");
    t.ok(fval(e.cond(A, "frightened")) === before, `испуг A не тронут: ${before} -> ${fval(e.cond(A, "frightened"))}`);
  });

  sc("button-expired", "apply=button: бросок записан, испуг кончился сам — кнопка ГМа всё равно ставит иммунитет обеим целям", async (e, t) => {
    await modeApply("button");
    const { pc, tP, toks: [a, b], A, B } = await setup(e);
    const { m } = await card(e, pc, tP, await catRule());
    const { runCheck } = await imp("checks.mjs"), { applyByDegree, challengeTargets } = await imp("saves.mjs");
    await bound("runCheck(only)", runCheck(game.messages.get(m.id), { only: a.id }));
    await waitFor(() => nres(e, m) >= 2, 8000);
    t.ok(nres(e, m) === 2, `результаты записаны: ${JSON.stringify(e.results(m))}`);
    t.ok(!imm(A) && !imm(B), "до кнопки иммунитета нет (button)");
    for (const x of [A, B]) if (e.cond(x, "frightened")) await x.decreaseCondition("frightened", { forceRemove: true });   // испуг кончился сам
    await wait(800);
    t.ok(!e.cond(A, "frightened") && !e.cond(B, "frightened"), "испуг снят");
    const keys = (await challengeTargets(game.messages.get(m.id))).map((x) => x.key);
    t.ok(keys.includes(a.id) && keys.includes(b.id), `обе цели остались в карточке: ${keys.length}`);
    await bound("applyByDegree(all)", applyByDegree(m.id, "all"));
    t.ok(!!(await waitFor(() => imm(A), 8000)) && !!(await waitFor(() => imm(B), 8000)), `иммунитет поставлен: A=${!!imm(A)} B=${!!imm(B)}`);
  });

  sc("click", "Игрок кликнул бросок Дипломатии с карточки (без маркера, без цели): результат распределился по целям от одного итога", async (e, t) => {
    await modeApply("auto");
    const { pc, tP, toks: [a, b, c], A, B } = await setup(e);
    const { m, item } = await card(e, pc, tP, await catRule());
    const t0 = e.since();
    game.user.targets.forEach((x) => x.setTarget(false, { releaseOthers: false }));
    await bound("check.roll", e.A(tP).getStatistic("diplomacy").check.roll({ item, skipDialog: true }));
    await waitFor(() => nres(e, m) >= 2, 8000);
    const r = e.results(m);
    t.ok(r[a.id] === "success" && r[b.id] === "criticalSuccess", `степени: ${JSON.stringify(r)}`);
    t.ok(!(c.id in r) && rollMsgs(e, t0).length === 1, "C не участвует, бросок один");
    t.ok(!!(await waitFor(() => imm(A) && imm(B), 8000)), "иммунитет у обоих");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} l3-chunk2 | ${s.id}`, err); }
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
    try { if (origApply !== undefined) await game.settings.set(MOD, "mode.apply", origApply); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afL3bResult = out;
  return out;
}
