async () => {
  // Живые сценарии двух починок шага 1 plan-activate.md (§5.4): (а) шаг `choose` и его выбор для шагов цели / степеней / кнопки «Применить»;
  // (б) заклинания с переменным числом действий («1 to 3»): исполнение ждёт ответа (state.awaitingActions) и продолжается после ответа или закрытия окна.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в weapon-poison.js / strike-gate.js. Правила — флаг rule на временном предмете (validateRule), не каталог.
  // Окна `.paf-dialog` отвечает харнесс: e.pick = подстрока подписи варианта (select) или data-action кнопки («2»); null — закрыть окно (отмена).
  // Параметры (перед запуском): window.__afChooseActions = { only: ["choose-x", ...], skip: [...], cleanOnly: true }
  // Настройки мира mode.effect / mode.challenge / mode.apply на время прогона = auto и возвращаются в конце. Нужен mode.macro не off (иначе заклинания не ждут числа действий) — иначе SKIP.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afChooseActionsResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afChooseActions ?? {}) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000, step = 150) => {
    const end = Date.now() + ms, env = cur;
    if (env) env.step = `ждём: ${String(fn).replace(/\s+/g, " ").slice(0, 100)}`;
    while (Date.now() < end) { if (!env || env.dead) return null; try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(step); }
    return null;
  };
  class Skip extends Error {}
  const bound = (label, p, ms = 30000) => {
    const env = cur; if (env) env.step = label;
    let tm;
    return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`завис шаг «${label}» (>${ms / 1000} с)`)), ms); })]).finally(() => clearTimeout(tm));
  };
  const hangInfo = (e) => `последний шаг: ${e.step}; закрыто окон бросков: [${e.windows}]; окна модуля: [${e.dialogs}]; открыто: [${[...foundry.applications.instances.values(), ...Object.values(ui.windows ?? {})].map((a) => a.constructor.name).join(", ")}]`;
  let cur = null;
  const api = () => game.modules.get(MOD).api;
  const imp = (f) => import(`/modules/${MOD}/scripts/${f}`);
  const setting = (k) => game.settings.get(MOD, k);
  const short = (v, n = 300) => String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, n);

  // ---------- уборка (аварийная: window.__afChooseActions = {cleanOnly: true}) ----------
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name))) await c.delete().catch(() => {});
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const sceneIds = new Set(scenes.map((s) => s.id));
    const msgIds = new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene) || test(m.speaker?.alias)).map((m) => m.id)]);
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
  const MODES = ["mode.effect", "mode.challenge", "mode.apply"], modePrev = Object.fromEntries(MODES.map((k) => [k, setting(k)]));
  const setMode = (k, v) => game.settings.set(MOD, k, v);
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (er) { console.warn("viewCombat", er); } };

  const idx = {};
  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    idx[pack] ??= await p.getIndex({ fields: ["system.slug"] });
    const i = idx[pack].find((x) => x.system?.slug === slug);
    if (!i) throw new Error(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(i._id)).toObject();
  };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null, pick: null, n: 0, awaited: [] };
    // в момент создания карточки: ждёт ли исполнение число действий (ответ харнесса приходит позже)
    const hook = Hooks.on("createChatMessage", (m) => {
      if (m.author?.id !== game.user.id) return;
      e.tracked.add(m.id);
      const u = m.flags?.[MOD]?.use; if (u) e.awaited.push({ id: m.id, awaiting: u.state?.awaitingActions === true });
    });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {   // окна модуля: select[name=choice] + ok (choose) либо кнопки действий (data-action="1".."3")
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          const sel = el.querySelector("select[name=choice]"), labels = sel ? [...sel.options].map((o) => o.textContent.trim()) : [...el.querySelectorAll("button[data-action]")].map((b) => b.dataset.action);
          e.dialogs.push(`${el.querySelector(".window-title")?.textContent?.trim() ?? el.id}: ${labels.join(" / ")}`);
          const p = e.pick;
          let done = false;
          if (p != null && sel) {
            const o = [...sel.options].find((x) => x.textContent.trim() === p) ?? [...sel.options].find((x) => x.textContent.includes(p));
            if (o) { sel.value = o.value; el.querySelector("button[data-action=ok]")?.click(); done = true; }
          } else if (p != null) { const b = el.querySelector(`button[data-action="${p}"]`); if (b) { b.click(); done = true; } }
          if (!done) foundry.applications.instances.get(el.id)?.close();
        }
        for (const app of [...Object.values(globalThis.ui?.windows ?? {}), ...foundry.applications.instances.values()]) {   // окна бросков pf2e: жмём «Бросок»
          const aid = app.appId ?? app.id;
          if (seen.has(aid) || !/damage|modifiers|урон|check/i.test(`${app.constructor.name} ${app.title}`)) continue;
          seen.add(aid);
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
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: все проверки — на этом актёре
    e.aim = async (ctrl, ...targets) => {
      e.T(ctrl).object.control({ releaseOthers: true });
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      for (const t of targets) e.T(t).object.setTarget(true, { releaseOthers: false });
      await wait(300);
    };
    e.fix = async (n) => {
      if (n != null) live();
      if (e.d20 === null) e.d20 = CONFIG.Dice.randomUniform;
      CONFIG.Dice.randomUniform = n == null ? e.d20 : () => 1 - (n - 0.5) / 20;
      if (n != null && (await new Roll("1d20").evaluate()).total !== n) throw new Skip("не удалось зафиксировать d20 (CONFIG.Dice.randomUniform)");
    };
    e.since = () => Date.now();
    e.msgs = (t0) => game.messages.contents.filter((m) => m._stats.createdTime >= t0);
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug) ?? null;
    e.ruleItem = async (actor, rule) => {
      const v = api().validateRule(rule);
      if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
      const [it] = await e.give(actor, { type: "action", name: "AF правило", system: { slug: `af-test-${id}`, actionType: { value: "action" }, actions: { value: 1 }, description: { value: "<p>тест</p>" } }, flags: { [MOD]: { rule } } });
      return it;
    };
    /** Карточка предмета-действия с целями; -> сообщение со снимком use (после done). */
    e.fire = async (item, att, ...targets) => {
      await e.aim(att, ...targets);
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
      if (!m) throw new Error(`у карточки «${item.name}» нет снимка use (правило не найдено или модуль не слушает)`);
      if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
      await waitFor(() => e.use(m)?.state?.done, 12000);
      await wait(500);
      return game.messages.get(m.id);
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

  // ---------- общие приёмы ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const LX = "AF вариант X", LY = "AF вариант Y";
  const CHOOSE = { to: "self", choose: { from: "options", options: [{ value: "x", label: LX }, { value: "y", label: LY }], prompt: "AF выбор" } };
  const ON_X = { to: "target", condition: { slug: "frightened", value: 1 }, when: ["choice:x"] };
  const ON_Y = { to: "target", condition: { slug: "sickened", value: 1 }, when: ["choice:y"] };
  /** Правило 1-2: choose + шаги цели по выбору, без испытания. */
  const R_ONUSE = { v: 1, label: "AF choose", onUse: { targets: "selected", apply: [CHOOSE, ON_X, ON_Y] } };
  /** Правило 3: choose и шаги по выбору — внутри одной степени (провал и крит. провал), СЛ 20 против Стойкости цели. */
  const DEGREE = [CHOOSE, ON_X, ON_Y];
  const R_DEGREE = { v: 1, label: "AF choose degree", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: DEGREE, criticalFailure: DEGREE } } } };
  /** Правило 4-6: по числу действий — действия 2: испуг; не 2: тошнота. Испытание как у R_DEGREE. */
  const ACT = "origin:item:cast:actions:2";
  const BY_ACT = [{ to: "target", condition: { slug: "frightened", value: 1 }, when: [ACT] }, { to: "target", condition: { slug: "sickened", value: 1 }, when: [{ not: ACT }] }];
  const R_CAST = { v: 1, label: "AF cast actions", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: BY_ACT, criticalFailure: BY_ACT } } } };

  /** PC с временным предметом-действием с правилом и цель-гоблин рядом (5 фт). */
  const duel = async (e, rule) => {
    openChat();
    const pc = await e.pc("автор"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    return { pc, tP, tV, vic: e.A(tV), item: await e.ruleItem(pc, rule) };
  };
  const chosen = (m, which = "apply") => {
    const u = game.messages.get(m.id)?.flags?.[MOD]?.use?.state;
    const ops = which === "apply" ? u?.apply?.self?.ops : u?.challenge?.applied?.self?.ops;
    return (ops ?? []).filter((o) => o.op === "chose").map((o) => o.value);
  };
  const states = (a) => a.itemTypes.condition.map((c) => c.slug).join(",") || "—";

  // ---------- 1. choose -> шаг цели ----------
  const chooseCase = (id, pick, wantOn, wantOff, wantValue) => sc(id, `choose (from: options) -> шаг цели с when: choice:${wantValue}: выбор «${pick}» — ${wantOn} есть, ${wantOff} нет`, async (e, t) => {
    needMode("mode.effect", "off");
    const x = await duel(e, R_ONUSE);
    e.pick = pick;
    const m = await e.fire(x.item, x.tP, x.tV);
    t.ok(e.dialogs.length === 1, `окно выбора одно (${e.dialogs.length})`);
    t.ok(e.dialogs[0]?.includes(LX) && e.dialogs[0]?.includes(LY), `в окне оба варианта (${e.dialogs[0]})`);
    t.ok(e.use(m)?.state?.done === true, "исполнение завершено (done)");
    t.ok(JSON.stringify(chosen(m)) === JSON.stringify([wantValue]), `выбор записан в state.apply.self.ops (${short(chosen(m))})`);
    t.ok(!!(await waitFor(() => e.cond(x.vic, wantOn), 6000)), `шаг цели сработал: ${wantOn} у цели (состояния: ${states(x.vic)})`);
    await wait(500);
    t.ok(!e.cond(x.vic, wantOff), `шаг другого варианта не сработал: ${wantOff} нет`);
  });
  chooseCase("choose-x", LX, "frightened", "sickened", "x");
  chooseCase("choose-y", LY, "sickened", "frightened", "y");

  // ---------- 2. choose + «Применить» ----------
  sc("choose-button", "effect = button: карточка без применения; «Применить» (applyUse) -> окно один раз, шаг цели по выбору; applyUse(only) по цели и повтор — выбор не теряется, окна нет", async (e, t) => {
    const x = await duel(e, R_ONUSE);
    const { applyUse } = await imp("use.mjs");
    e.pick = LX;
    try {
      await setMode("mode.effect", "button");
      const m = await e.fire(x.item, x.tP, x.tV);
      t.ok(e.dialogs.length === 0, `при отправке карточки окна нет (${e.dialogs.length})`);
      t.ok(!e.cond(x.vic, "frightened") && !e.cond(x.vic, "sickened"), "до «Применить» состояний нет");
      await bound("applyUse", applyUse(m.id)); await wait(1200);
      t.ok(e.dialogs.length === 1, `«Применить»: окно выбора появилось один раз (${e.dialogs.length})`);
      t.ok(!!(await waitFor(() => e.cond(x.vic, "frightened"), 6000)), `после «Применить» у цели frightened (${states(x.vic)})`);
      t.ok(JSON.stringify(chosen(m)) === JSON.stringify(["x"]), `выбор записан (${short(chosen(m))})`);
      // только цель (self-шаги пропущены): choose не запускается, выбор берётся из сохранённого chose
      await e.cond(x.vic, "frightened")?.delete(); await wait(500);
      await bound("applyUse(only)", applyUse(m.id, e.T(x.tV).id)); await wait(1200);
      t.ok(e.dialogs.length === 1, `applyUse(only): нового окна нет (${e.dialogs.length})`);
      t.ok(!!(await waitFor(() => e.cond(x.vic, "frightened"), 6000)), `applyUse(only): выбор сохранён — frightened снова у цели (${states(x.vic)})`);
      t.ok(!e.cond(x.vic, "sickened"), "и вариант Y не сработал");
      // полный повтор: choose уже исполнен (prev) — без окна
      await e.cond(x.vic, "frightened")?.delete(); await wait(500);
      await bound("applyUse (повтор)", applyUse(m.id)); await wait(1200);
      t.ok(e.dialogs.length === 1 && chosen(m).length === 1, `повтор «Применить»: окна нет (${e.dialogs.length}), chose один (${chosen(m).length})`);
      t.ok(!!(await waitFor(() => e.cond(x.vic, "frightened"), 6000)), "повтор: frightened по сохранённому выбору");
    } finally { await setMode("mode.effect", "auto"); }
  });

  // ---------- 3. choose внутри byDegree ----------
  sc("choose-degree", "choose внутри шагов степени: окно один раз, шаг цели той же степени видит выбор (провал по d20=8)", async (e, t) => {
    needMode("mode.challenge", "off"); needMode("mode.effect", "off");
    const x = await duel(e, R_DEGREE);
    e.pick = LX;
    await e.fix(8);
    const m = await e.fire(x.item, x.tP, x.tV);
    const res = Object.values(e.use(m)?.state?.challenge?.results ?? {}).map((v) => v.degree);
    t.info(`степень цели: ${short(res)}; chose в challenge.applied.self: ${short(chosen(m, "challenge"))}; apply.self: ${short(chosen(m))}`);
    t.ok(e.dialogs.length === 1, `окно выбора одно (${e.dialogs.length})`);
    t.ok(!!(await waitFor(() => e.cond(x.vic, "frightened"), 8000)), `шаг цели в той же степени сработал: frightened (${states(x.vic)}; степень ${short(res)})`);
    t.ok(!e.cond(x.vic, "sickened"), "вариант Y не сработал");
  });

  // ---------- 4-6. переменное число действий ----------
  /** PC-заклинатель с временным заклинанием 1 круга (время `time`, правило R_CAST), цель рядом. Ячейки 1 круга есть. */
  const caster = async (e, time) => {
    openChat(); needMode("mode.macro", "off"); needMode("mode.challenge", "off"); needMode("mode.effect", "off");
    const pc = await e.pc("заклинатель"), vic = await e.foe("цель");
    const [entry] = await e.give(pc, { type: "spellcastingEntry", name: "AF спонтанные", system: { tradition: { value: "occult" }, prepared: { value: "spontaneous" }, ability: { value: "cha" }, slots: { slot1: { max: 5, value: 5 } } } });
    const spell = { type: "spell", name: "AF переменное", system: { slug: `af-var-${e.id}`, level: { value: 1 }, time: { value: time }, traits: { value: [], rarity: "common", traditions: ["occult"] }, range: { value: "30 feet" }, target: { value: "1 creature" }, location: { value: entry.id }, description: { value: "<p>тест</p>" } }, flags: { [MOD]: { rule: R_CAST } } };
    const v = api().validateRule(R_CAST);
    if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
    const [sp] = await e.give(pc, spell);
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    return { pc, sp, tP, tV, vic: e.A(tV) };
  };
  /** Сотворить: окно действий отвечает харнесс по e.pick. -> сообщение с use после done (или null done: сообщение вернётся всё равно). */
  const cast = async (e, x, pick) => {
    e.pick = pick;
    await e.fix(8); await e.aim(x.tP, x.tV);
    const t0 = e.since();
    await bound("cast", x.sp.spellcasting.cast(x.sp, { rank: 1 }));
    const m = await waitFor(() => e.msgs(t0).find((y) => y.flags?.pf2e?.origin?.uuid === x.sp.uuid && y.flags?.[MOD]?.use), 10000);
    if (!m) throw new Error("у сообщения сотворения нет снимка use (правило не найдено или модуль не слушает)");
    if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
    await waitFor(() => e.use(m)?.state?.done, 12000);
    await wait(1200);
    return game.messages.get(m.id);
  };
  const awaitedOf = (e, m) => e.awaited.find((a) => a.id === m.id)?.awaiting;
  const actsOf = (m) => (m.flags?.pf2e?.origin?.rollOptions ?? []).filter((o) => o.startsWith("origin:item:cast:actions:"));

  const castCase = (id, title, pick) => sc(id, title, async (e, t) => {
    const x = await caster(e, "1 to 3");
    const m = await cast(e, x, String(pick));
    const u = e.use(m)?.state;
    t.ok(awaitedOf(e, m) === true, `карточка создана с awaitingActions=true (${awaitedOf(e, m)})`);
    t.ok(e.dialogs.length === 1 && ["1", "2", "3"].every((n) => e.dialogs[0].includes(n)), `окно действий одно, кнопки 1/2/3 (${e.dialogs.join(" | ")})`);
    t.ok(u?.awaitingActions === false, `awaitingActions снят (${u?.awaitingActions})`);
    t.ok(u?.done === true, `done (${u?.done})`);
    t.ok(m.flags?.[MOD]?.cast?.actions === pick, `cast.actions = ${pick} (${m.flags?.[MOD]?.cast?.actions})`);
    t.ok(actsOf(m).join() === `origin:item:cast:actions:${pick}`, `rollOptions: ${actsOf(m).join() || "нет"}`);
    if (pick === 2) {
      t.ok(!!(await waitFor(() => e.cond(x.vic, "frightened"), 8000)), `шаги actions:2 отработали: frightened (${states(x.vic)}; результат ${short(Object.values(u?.challenge?.results ?? {}).map((v) => v.degree))})`);
      t.ok(!e.cond(x.vic, "sickened"), "ветка «не 2 действия» не сработала");
    } else {
      t.ok(!!(await waitFor(() => e.cond(x.vic, "sickened"), 8000)), `выбрано ${pick}: сработала ветка «не 2» — sickened (${states(x.vic)})`);
      t.ok(!e.cond(x.vic, "frightened"), "шаги actions:2 не сработали");
    }
    t.ok(x.sp.spellcasting.system.slots.slot1.value === 4, `ячейка потрачена один раз (${x.sp.spellcasting.system.slots.slot1.value}/5)`);
  });
  castCase("cast-2", "Переменное заклинание «1 to 3»: выбрано 2 действия — шаги actions:2 отработали, awaitingActions снят, done, ячейка один раз", 2);
  castCase("cast-1", "То же, выбрано 1 действие — шаги actions:2 не сработали, ветка «не 2» сработала", 1);

  sc("cast-cancel", "Окно действий закрыто крестиком: флаг снят, исполнение прошло, шаги actions:N не сработали (ветка «не 2» — да), числа действий в сообщении нет", async (e, t) => {
    const x = await caster(e, "1 to 3");
    const m = await cast(e, x, null);
    const u = e.use(m)?.state;
    t.ok(awaitedOf(e, m) === true, `карточка создана с awaitingActions=true (${awaitedOf(e, m)})`);
    t.ok(e.dialogs.length === 1, `окно было (${e.dialogs.length})`);
    t.ok(u?.awaitingActions === false, `awaitingActions снят при отмене (${u?.awaitingActions})`);
    t.ok(u?.done === true, `исполнение прошло: done (${u?.done})`);
    t.ok(!m.flags?.[MOD]?.cast?.actions && actsOf(m).length === 0, `числа действий нет (${short(m.flags?.[MOD]?.cast)}, ${actsOf(m).join() || "—"})`);
    t.ok(!!(await waitFor(() => e.cond(x.vic, "sickened"), 8000)), `шаги выполнены без числа действий: sickened (${states(x.vic)})`);
    t.ok(!e.cond(x.vic, "frightened"), "шаги actions:2 не сработали");
  });

  sc("cast-fixed", "Обычное заклинание (время «2» действия): окна нет, awaitingActions не ставится, исполнение сразу", async (e, t) => {
    const x = await caster(e, "2");
    const m = await cast(e, x, null);
    const u = e.use(m)?.state;
    t.ok(awaitedOf(e, m) !== true, `awaitingActions не ставился (${awaitedOf(e, m)})`);
    t.ok(e.dialogs.length === 0, `окна действий нет (${e.dialogs.join(" | ")})`);
    t.ok(!u?.awaitingActions, `флага нет (${u?.awaitingActions})`);
    t.ok(u?.done === true, `done (${u?.done})`);
    t.ok(!m.flags?.[MOD]?.cast?.actions, "variable-cast число не писал");
    t.info(`rollOptions действий: ${actsOf(m).join() || "нет"}; состояния цели: ${states(x.vic)} (при нативном actions:2 от pf2e ожидался бы frightened, иначе sickened)`);
    t.ok(!!(await waitFor(() => e.cond(x.vic, "frightened") || e.cond(x.vic, "sickened"), 8000)), `шаги отработали без ожидания (${states(x.vic)})`);
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);
    for (const k of MODES) await setMode(k, "auto");
    for (const s of pick) {
      const infos = [];
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); }, info(m) { infos.push(m); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0;
      try {
        e = await newEnv(s.id); cur = e;
        const run = s.run(e, t); run.catch(() => {});
        let timer;
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут 120 с; ${hangInfo(e)}`)), 120000); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} choose-actions | ${s.id}`, err); }
      } finally {
        for (const k of MODES) { try { await setMode(k, "auto"); } catch { /* ok */ } }
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      if (infos.length) detail += ` | инфо: ${infos.join(" ; ")}`;
      if (status === "fail" && e?.dialogs?.length) detail += ` | окна: ${e.dialogs.join(" || ")}`;
      if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 3).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    for (const k of MODES) { try { await setMode(k, modePrev[k]); } catch { /* ok */ } }
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  const table = rows.map((r) => `${r.id.padEnd(15)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afChooseActionsResult = result;
  return result;
}
