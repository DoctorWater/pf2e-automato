async () => {
  // Живые сценарии strike-gate (onEvent.afterUse): испытание по исходу Удара, сразу следующего за карточкой предмета. plan-strike-gate.md §6.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в pa05.js. Правила — флаг rule на временном предмете-действии (validateRule), не каталог.
  // Параметры (перед запуском): window.__afStrikeGate = { only: ["hit", ...], skip: [...], cleanOnly: true }
  // «Испытание запустилось» = новое сообщение с flags.pf2e-automato.use.state.event (карточка испытания runEntry). Нужен mode.challenge не off.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afStrikeGateResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afStrikeGate ?? {}) };
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

  // ---------- уборка (аварийная: window.__afStrikeGate = {cleanOnly: true}) ----------
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name)))) await c.delete().catch(() => {});
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

  // ---------- сценарии strike-gate ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const OK_DEG = ["success", "criticalSuccess"];
  // Правило-образец: Dazing Blow (попадание) и Headshot (крит). Испытание — Стойкость СЛ 20, провал -> оглушён 1.
  const gate = (outcomes) => ({ v: 1, onEvent: [{ on: "attack-roll", side: "self", afterUse: true, when: ["self:action:slug:strike", outcomes.length > 1 ? { or: outcomes.map((o) => `outcome:${o}`) } : `outcome:${outcomes[0]}`],
    challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: [{ to: "target", condition: { slug: "stunned", value: 1 } }] } } }] });
  const HIT = gate(OK_DEG), CRIT = gate(["criticalSuccess"]);

  /** Карточки испытаний модуля (host-сообщения runEntry: flags.<MOD>.use.state.event) после t0. */
  const hosts = (e, t0) => e.msgs(t0).filter((m) => m.flags?.[MOD]?.use?.state?.event);
  /** Нажать карточку предмета (toMessage); -> сообщение pf2e с origin.uuid предмета. Снимок use модуля не нужен: afterUse смотрит только pf2e-origin. */
  const cardOf = async (e, item, att, ...targets) => {
    await e.aim(att, ...targets);
    const t0 = e.since();
    await bound("item.toMessage", item.toMessage(undefined, { create: true }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid), 8000);
    if (!m) throw new Error(`карточка «${item.name}» не появилась в чате`);
    await wait(700);   // timestamp карточки строго раньше броска
    return m;
  };
  /** Подкрутка бонуса атаки: при d20=10 итог = КЗ+2 (попал, не крит), при d20=19 — КЗ+11 (крит), при d20=1 — КЗ-7 (промах). */
  const rigTo = async (e, att, def) => {
    const s = e.strike(e.A(att)), ac = e.A(def).attributes.ac.value;
    if (!s || !Number.isFinite(s.totalModifier)) throw new Skip("у Удара нет totalModifier (pf2e изменил API)");
    await e.rig(e.A(att), "attack-roll", ac + 2 - 10 - s.totalModifier);
  };
  /** Удар с фиксированным d20 и ожиданием реакции модуля. -> сообщение атаки. */
  const swing = async (e, att, def, d20) => {
    await e.fix(d20);
    const m = await e.hit(att, def);
    if (!m) throw new Error("сообщение атаки не появилось");
    await wait(2500);
    return m;
  };
  const outcome = (m) => m?.flags?.pf2e?.context?.outcome;
  const duel = async (e, rule) => {
    openChat(); needMode("mode.challenge", "off");
    const pc = await e.pc("атакующий"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const item = await e.ruleItem(pc, rule);
    await rigTo(e, tP, tV);
    return { pc, tP, tV, item };
  };

  sc("hit", "Карточка -> Удар попал: одна карточка испытания; второй Удар — новой нет", async (e, t) => {
    const { tP, tV, item } = await duel(e, HIT);
    const t0 = e.since();
    await cardOf(e, item, tP, tV);
    const m1 = await swing(e, tP, tV, 10);
    t.ok(OK_DEG.includes(outcome(m1)), `Удар попал (${outcome(m1)})`);
    t.ok(hosts(e, t0).length === 1, `одна карточка испытания (${hosts(e, t0).length})`);
    const m2 = await swing(e, tP, tV, 10);
    t.ok(OK_DEG.includes(outcome(m2)), `второй Удар попал (${outcome(m2)})`);
    t.ok(hosts(e, t0).length === 1, `после второго Удара карточек по-прежнему одна (${hosts(e, t0).length})`);
  });

  sc("miss", "Карточка -> промах: испытания нет; следующий Удар (попал) карточку не наследует", async (e, t) => {
    const { tP, tV, item } = await duel(e, HIT);
    const t0 = e.since();
    await cardOf(e, item, tP, tV);
    const m1 = await swing(e, tP, tV, 1);
    t.ok(!OK_DEG.includes(outcome(m1)), `Удар промахнулся (${outcome(m1)})`);
    t.ok(hosts(e, t0).length === 0, `после промаха карточек нет (${hosts(e, t0).length})`);
    const m2 = await swing(e, tP, tV, 10);
    t.ok(OK_DEG.includes(outcome(m2)), `следующий Удар попал (${outcome(m2)})`);
    t.ok(hosts(e, t0).length === 0, `попадание без новой карточки ничего не запускает (${hosts(e, t0).length})`);
  });

  sc("stale", "Бой: карточка прошлого хода — Удар в новом ходу ничего не запускает (контроль: в свой ход запускает)", async (e, t) => {
    const { pc, tP, tV, item } = await duel(e, HIT);
    const c = await e.combat([tP, tV], [20, 10]);
    await c.startCombat(); await wait(1200);
    t.ok(c.combatant?.actor?.id === pc.id, "первый ход — у атакующего");
    const t0 = e.since();
    await cardOf(e, item, tP, tV);   // контроль: тот же ход -> испытание
    const m1 = await swing(e, tP, tV, 10);
    t.ok(OK_DEG.includes(outcome(m1)) && hosts(e, t0).length === 1, `контроль: карточка в свой ход -> испытание (${outcome(m1)}, ${hosts(e, t0).length})`);
    const t1 = e.since();
    await cardOf(e, item, tP, tV);
    await bound("nextTurn x2", (async () => { await c.nextTurn(); await wait(1200); await c.nextTurn(); })());
    await wait(1200);
    t.ok(c.combatant?.actor?.id === pc.id, `ход вернулся к атакующему (раунд ${c.round})`);
    const m2 = await swing(e, tP, tV, 10);
    t.ok(OK_DEG.includes(outcome(m2)), `Удар попал (${outcome(m2)})`);
    t.ok(hosts(e, t1).length === 0, `карточка прошлого хода устарела (${hosts(e, t1).length})`);
  });

  sc("npc-copies", "Два несвязанных токена одного NPC: карточка у A, Удар у B — ничего; Удар у A — испытание", async (e, t) => {
    openChat(); needMode("mode.challenge", "off");
    const base = await e.foe("гоблин"), vic = await e.pc("жертва");
    const tA = await e.tok(base, 500, 500, -1), tB = await e.tok(base, 500, 700, -1), tV = await e.tok(vic, 600, 600, 1);
    await wait(700);
    const aA = e.A(tA), aB = e.A(tB);
    t.ok(aA && aB && aA !== aB && aA.uuid !== aB.uuid, `токены развязаны (${aA?.uuid} / ${aB?.uuid})`);
    const itA = await e.ruleItem(aA, HIT);
    await e.ruleItem(aB, HIT);   // правило и у B: иначе «ничего» было бы тривиальным
    await rigTo(e, tA, tV); await rigTo(e, tB, tV);
    const t0 = e.since();
    await cardOf(e, itA, tA, tV);
    const mB = await swing(e, tB, tV, 10);
    t.ok(OK_DEG.includes(outcome(mB)), `Удар копии B попал (${outcome(mB)})`);
    t.ok(hosts(e, t0).length === 0, `Удар B после карточки A — испытания нет (${hosts(e, t0).length})`);
    const mA = await swing(e, tA, tV, 10);
    t.ok(OK_DEG.includes(outcome(mA)), `Удар копии A попал (${outcome(mA)})`);
    t.ok(hosts(e, t0).length === 1, `Удар A — одна карточка испытания (${hosts(e, t0).length})`);
  });

  sc("crit-only", "outcome:criticalSuccess (Headshot): обычное попадание — ничего; крит — испытание", async (e, t) => {
    const { tP, tV, item } = await duel(e, CRIT);
    const t0 = e.since();
    await cardOf(e, item, tP, tV);
    const m1 = await swing(e, tP, tV, 10);
    t.ok(outcome(m1) === "success", `обычное попадание (${outcome(m1)})`);
    t.ok(hosts(e, t0).length === 0, `попадание без крита — испытания нет (${hosts(e, t0).length})`);
    await cardOf(e, item, tP, tV);
    const m2 = await swing(e, tP, tV, 19);
    t.ok(outcome(m2) === "criticalSuccess", `критическое попадание (${outcome(m2)})`);
    t.ok(hosts(e, t0).length === 1, `крит — одна карточка испытания (${hosts(e, t0).length})`);
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} strike-gate | ${s.id}`, err); }
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
  window.__afStrikeGateResult = result;
  return result;
}
