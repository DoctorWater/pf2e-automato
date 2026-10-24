async () => {
  // Живые сценарии affliction (шаг `affliction`, стадии недугов): наложение, конец хода цели, повтор, onset, чужое состояние, клик по бейджу, откат. plan-affliction.md.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в repeat-save.js. Правило — флаг rule на временном предмете-действии (validateRule), не каталог.
  // Параметры (перед запуском): window.__afAffliction = { only: ["start", ...], skip: [...], cleanOnly: true }
  // Нужны mode.challenge и mode.apply = auto (иначе SKIP). Сначала яды, затем болезнь и virulent.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afAfflictionResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afAffliction ?? {}) };
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
  const hangInfo = (e) => `последний шаг: ${e.step}; закрыто окон бросков: [${e.windows}]; окна модуля: [${e.dialogs}]`;
  let cur = null;
  const DEG = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const deg = (v) => (typeof v === "number" ? DEG[v] : v);
  const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });
  const api = () => game.modules.get(MOD).api;
  const imp = (f) => import(`/modules/${MOD}/scripts/${f}`);
  const setting = (k) => game.settings.get(MOD, k);

  // ---------- уборка (аварийная: window.__afAffliction = {cleanOnly: true}) ----------
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name)))) await c.delete().catch(() => {});
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
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };

  const idx = {};
  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    idx[pack] ??= await p.getIndex({ fields: ["system.slug"] });
    const e = idx[pack].find((i) => i.system?.slug === slug);
    if (!e) throw new Error(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(e._id)).toObject();
  };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
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
        for (const app of [...Object.values(globalThis.ui?.windows ?? {}), ...foundry.applications.instances.values()]) {
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
    e.pc = async (name) => {
      const a = await e.add({ name, type: "character", system: { details: { alliance: "party", languages: { value: ["common"] } } } });
      await a.createEmbeddedDocuments("Item", [await find("pf2e.ancestries", "human")]);
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
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: проверки — на этом актёре
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
    e.cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug) ?? null;
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.results = (m) => Object.fromEntries(Object.entries(e.use(m)?.state?.challenge?.results ?? {}).map(([k, v]) => [k, deg(v.degree)]));
    e.ruleItem = async (actor, rule) => {
      const v = api().validateRule(rule);
      if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
      const [it] = await e.give(actor, { type: "action", name: "AF недуг", system: { slug: `af-test-${id}`, actionType: { value: "action" }, actions: { value: 1 }, description: { value: "<p>тест</p>" } }, flags: { [MOD]: { rule } } });
      return it;
    };
    e.fire = async (item, att, ...targets) => {
      await e.aim(att, ...targets);
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
      if (!m) throw new Error(`у карточки «${item.name}» нет снимка use`);
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

  // ---------- сценарии ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  // Яд: Стойкость СЛ 20 (гоблин-воин при d20=1 — крит. провал, при d20=8 — провал; detail называет фактическую степень), 3 стадии по раунду
  const st = (o = {}) => ({ duration: { value: 1, unit: "rounds" }, damage: [{ formula: "1d6", damageType: "poison" }], conditions: [{ slug: "sickened", value: 1 }], ...o });
  const DEF = (o = {}) => ({ name: "AF яд", kind: "poison", save: { statistic: "fortitude", dc: 20 }, maxDuration: { value: 20, unit: "rounds" },
    stages: [st(), st({ conditions: [{ slug: "clumsy", value: 1 }, { slug: "sickened", value: 2 }] }), st({ conditions: [{ slug: "sickened", value: 3 }] })], ...o });
  const RULE = (def, failStage = 1, critStage = 2) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target",
    byDegree: { failure: [{ to: "target", affliction: { stage: failStage, def } }], criticalFailure: [{ to: "target", affliction: { stage: critStage, def } }] } } } });
  const carrier = (a) => a.items.find((i) => i.flags?.[MOD]?.meta?.affliction) ?? null;
  const aff = (a) => carrier(a)?.flags?.[MOD]?.meta?.affliction;
  const badge = (a) => carrier(a)?.system?.badge?.value ?? null;
  const cards = (e, t0) => e.msgs(t0).filter((m) => String(m.flags?.[MOD]?.use?.state?.event ?? "").endsWith(":affliction"));
  const hp = (a) => a.hitPoints.value;
  const nextTurn = async (c) => { await bound("nextTurn", c.nextTurn()); await wait(2500); };
  /** Конец хода цели в раунде 2: время в бою идёт на roundTime за раунд, поэтому первая карточка — только на втором ходу цели. */
  const targetTurnEnd = async (c) => { for (let i = 0; i < 4; i++) await nextTurn(c); };

  /** PC-автор и NPC-цель (в бою по желанию); d20 = fix -> недуг по правилу. */
  const cast = async (e, { rule = RULE(DEF()), fix = 8, combat = true } = {}) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("автор"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const item = await e.ruleItem(pc, rule);
    let c = null;
    if (combat) { c = await e.combat([tP, tV], [20, 10]); await c.startCombat(); await wait(1200); }
    await e.fix(fix);
    const m = await e.fire(item, tP, tV);
    await waitFor(() => carrier(e.A(tV)), 8000);
    return { pc, vic, tP, tV, c, m, item };
  };
  const again = async (e, x, fix) => { await e.fix(fix); const m = await e.fire(x.item, x.tP, x.tV); await wait(1500); return m; };

  sc("start", "Провал: носитель со стадией 1, тошнота 1, урон нанесён; повтор того же шага не удваивает", async (e, t) => {
    const x = await cast(e, { combat: false });
    const a = e.A(x.tV);
    t.ok(e.results(x.m)[x.tV.id] === "failure", `степень цели: ${e.results(x.m)[x.tV.id]} (нужен failure; иначе подправить d20)`);
    t.ok(badge(a) === 1, `бейдж = ${badge(a)}`);
    t.ok(carrier(a)?.type === "effect" && carrier(a).system.duration.unit === "unlimited", "носитель — effect без срока");
    t.ok(!!e.cond(a, "sickened"), "тошнота наложена");
    t.ok(hp(a) < a.hitPoints.max, `урон стадии нанесён (${hp(a)}/${a.hitPoints.max})`);
    t.ok(aff(a)?.nextAt > game.time.worldTime, "nextAt в будущем (в ход наложения броска нет)");
  });

  sc("start-crit", "Крит. провал: стадия 2 сразу — неловкость и тошнота 2", async (e, t) => {
    const x = await cast(e, { fix: 1, combat: false });
    const a = e.A(x.tV);
    t.ok(e.results(x.m)[x.tV.id] === "criticalFailure", `степень: ${e.results(x.m)[x.tV.id]}`);
    t.ok(badge(a) === 2, `бейдж = ${badge(a)}`);
    t.ok(!!e.cond(a, "clumsy") || a.items.some((i) => i.flags?.[MOD]?.meta?.key?.includes(":2:L:clumsy")), "неловкость стадии 2");
    t.ok(e.cond(a, "sickened")?.value === 2, `тошнота ${e.cond(a, "sickened")?.value}`);
  });

  sc("round-time", "Раунд в бою = 6 с мирового времени (иначе nextAt в бою не наступит)", async (e, t) => {
    const x = await cast(e);
    const w0 = game.time.worldTime, r0 = x.c.round;
    await nextTurn(x.c); await nextTurn(x.c);   // ход цели -> раунд 2
    t.ok(x.c.round === r0 + 1, `раунд ${r0} -> ${x.c.round}`);
    t.ok(game.time.worldTime - w0 === CONFIG.time.roundTime, `время за раунд: ${game.time.worldTime - w0} с (нужно ${CONFIG.time.roundTime})`);
  });

  sc("tick", "Конец хода цели: одна карточка, NPC бросает сам, успех (d20=20) снимает носитель и все состояния; в начале хода карточки нет", async (e, t) => {
    const x = await cast(e);
    const a = e.A(x.tV), t0 = e.since();
    await nextTurn(x.c);
    t.ok(cards(e, t0).length === 0, `в ход наложения и до интервала карточки нет (${cards(e, t0).length})`);
    await e.fix(20);
    await nextTurn(x.c); await nextTurn(x.c); await nextTurn(x.c);
    t.ok(cards(e, t0).length === 1, `одна карточка на конце хода цели (${cards(e, t0).length})`);
    t.ok(await waitFor(() => !carrier(a), 8000), "носитель снят (успех: стадия 1 -> 0)");
    t.ok(await waitFor(() => !e.cond(a, "sickened"), 6000), "тошнота снята вместе с носителем");
  });

  sc("fail-up", "Провал на конце хода (d20=1): стадия растёт, у высшей стадии урон повторяется (max-repeat)", async (e, t) => {
    const x = await cast(e, { rule: RULE(DEF(), 3, 3), fix: 1 });
    const a = e.A(x.tV);
    t.ok(badge(a) === 3, `старт на высшей стадии: ${badge(a)}`);
    const h0 = hp(a);
    await e.fix(1);
    await targetTurnEnd(x.c);
    t.ok(await waitFor(() => hp(a) < h0, 8000), `урон высшей стадии повторён (${h0} -> ${hp(a)})`);
    t.ok(badge(a) === 3, `стадия осталась высшей: ${badge(a)}`);
  });

  sc("again-poison", "Повторный яд: стадия +1, срок (endsAt) тот же", async (e, t) => {
    const x = await cast(e, { combat: false });
    const a = e.A(x.tV), ends = aff(a)?.endsAt;
    await again(e, x, 8);
    t.ok(badge(a) === 2, `бейдж = ${badge(a)}`);
    t.ok(aff(a)?.endsAt === ends, `endsAt прежний (${ends} -> ${aff(a)?.endsAt})`);
    t.ok(a.items.filter((i) => i.flags?.[MOD]?.meta?.affliction).length === 1, "носитель один");
  });

  sc("again-disease", "Болезнь повторно не действует: стадия прежняя, предупреждение ГМу", async (e, t) => {
    const x = await cast(e, { rule: RULE(DEF({ name: "AF болезнь", kind: "disease" })), combat: false });
    const a = e.A(x.tV);
    notes.length = 0;
    await again(e, x, 1);
    t.ok(badge(a) === 1, `бейдж = ${badge(a)}`);
    t.ok(notes.some((n) => /afflictionTaken|уже действует|already active/i.test(n)), `предупреждение: ${notes.join(" / ")}`);
  });

  sc("onset", "Onset: эффектов нет, пока не прошёл срок; после game.time.advance — стадия применена", async (e, t) => {
    const x = await cast(e, { rule: RULE(DEF({ onset: { value: 1, unit: "hours" } })), combat: false });
    const a = e.A(x.tV);
    t.ok(badge(a) === 1 && !e.cond(a, "sickened") && hp(a) === a.hitPoints.max, `в onset: бейдж ${badge(a)}, тошноты нет, урона нет`);
    await game.time.advance(3601); await wait(2500);
    t.ok(await waitFor(() => e.cond(a, "sickened"), 6000), "после onset тошнота наложена");
    t.ok(hp(a) < a.hitPoints.max, "после onset нанесён урон");
  });

  sc("foreign-sickened", "Чужая тошнота 2 не поднята и не снята стадией 1 и лечением", async (e, t) => {
    const x = await cast(e, { combat: false });
    const target = e.A(x.tV);
    await api().applyCondition(target, { slug: "sickened", value: 2, policy: "max" }, { key: "foreign" });
    await wait(500);
    t.ok(e.cond(target, "sickened")?.value >= 2, "чужая тошнота висит");
    await carrier(target)?.delete(); await wait(1500);
    t.ok(e.cond(target, "sickened")?.value === 2, `после снятия недуга чужая тошнота цела (${e.cond(target, "sickened")?.value})`);
  });

  sc("badge-click", "ГМ опускает бейдж (лечение): связанные эффекты прежней стадии уходят, урона нет", async (e, t) => {
    const x = await cast(e, { fix: 1, combat: false });
    const a = e.A(x.tV);
    t.ok(badge(a) === 2, `старт со стадии 2 (${badge(a)})`);
    const h0 = hp(a);
    await carrier(a).update({ "system.badge.value": 1 }); await wait(2000);
    t.ok(a.items.every((i) => !i.flags?.[MOD]?.meta?.key?.includes(":2:L:")), "связанные состояния стадии 2 сняты");
    t.ok(hp(a) === h0, `урона при снижении нет (${h0} -> ${hp(a)})`);
  });

  sc("undo", "Откат (undoOps): наложение снимает носитель и состояния; повторное воздействие возвращает стадию", async (e, t) => {
    const x = await cast(e, { combat: false });
    const a = e.A(x.tV), { undoOps } = await imp("apply.mjs");
    const m2 = await again(e, x, 8);
    t.ok(badge(a) === 2, `после второго яда ${badge(a)}`);
    await bound("undoOps повтора", undoOps(game.messages.get(m2.id), x.tV.id));
    t.ok(await waitFor(() => badge(a) === 1, 6000), `стадия вернулась (${badge(a)})`);
    await bound("undoOps", undoOps(game.messages.get(x.m.id), x.tV.id));
    t.ok(await waitFor(() => !carrier(a), 6000), "носитель снят откатом");
    t.ok(await waitFor(() => !e.cond(a, "sickened"), 6000), "состояние снято вместе с ним");
  });

  sc("reload-pending", "Карточка без результата: повторный тик (как после перезагрузки, память пуста) второй бросок не создаёт", async (e, t) => {
    const x = await cast(e, { combat: false });
    const a = e.A(x.tV), t0 = e.since();
    await e.fix(null);
    await game.time.advance(7); await wait(2500);
    const n = cards(e, t0).length;
    t.ok(n === 1, `карточка одна (${n})`);
    t.ok(!!aff(a)?.pending, "pending записан в носитель");
    await game.time.advance(7); await wait(2000);
    await api().afflictionTick(a, "reload-sim");
    t.ok(cards(e, t0).length === n || !aff(a)?.pending, `новых карточек при живом pending нет (${cards(e, t0).length})`);
  });

  sc("unlinked", "Несвязанный токен: носитель на синтетическом актёре, вне боя тикает по updateWorldTime", async (e, t) => {
    const x = await cast(e, { combat: false });
    const a = e.A(x.tV), t0 = e.since();
    t.ok(!e.T(x.tV).actorLink && !!carrier(a), "токен несвязан, носитель на нём");
    await e.fix(20);
    await game.time.advance(7); await wait(3000);
    t.ok(cards(e, t0).length === 1, `карточка выложена вне боя (${cards(e, t0).length})`);
    t.ok(await waitFor(() => !carrier(a), 8000), "успех снял носитель");
  });

  sc("author-gone", "Автор удалён: карточка идёт по снимку (СЛ 20), успех снимает носитель", async (e, t) => {
    const x = await cast(e, { combat: false });
    const a = e.A(x.tV);
    await e.scene.deleteEmbeddedDocuments("Token", [x.tP.id]); await x.pc.delete(); await wait(800);
    const t0 = e.since();
    await e.fix(20);
    await game.time.advance(7); await wait(3000);
    const h = cards(e, t0);
    t.ok(h.length === 1, `карточка есть (${h.length})`);
    t.ok(h[0]?.flags?.[MOD]?.use?.dc === 20, `СЛ из снимка (${h[0]?.flags?.[MOD]?.use?.dc})`);
    t.ok(await waitFor(() => !carrier(a), 8000), "носитель снят");
  });

  sc("virulent", "Virulent: первый успех подряд стадию не снижает (streak 1), второй — снижает на 1", async (e, t) => {
    const x = await cast(e, { rule: RULE(DEF({ name: "AF чума", kind: "disease", virulent: true }), 2, 2), fix: 8, combat: false });
    const a = e.A(x.tV);
    t.ok(badge(a) === 2, `старт со стадии 2 (${badge(a)})`);
    await e.fix(20);
    await game.time.advance(7); await wait(3000);
    t.ok(badge(a) === 2 && aff(a)?.streak === 1, `первый успех: стадия ${badge(a)}, streak ${aff(a)?.streak}`);
    await game.time.advance(7); await wait(3000);
    t.ok(await waitFor(() => badge(a) === 1, 6000), `второй успех подряд: стадия ${badge(a)}`);
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} affliction | ${s.id}`, err); }
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
  window.__afAfflictionResult = result;
  return result;
}
