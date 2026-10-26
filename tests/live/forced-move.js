async () => {
  // Живые сценарии forced-move (шаг apply.move): толчок/притяжение цели испытания, стена, откат, нет подсказки реакции.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в repeat-save.js. Правило — флаг rule на временном предмете-действии.
  // Параметры (перед запуском): window.__afForcedMove = { only: ["push", ...], skip: [...], cleanOnly: true }
  // Нужны mode.challenge = auto и mode.apply = auto. Сетка сцены 100 px / 5 фт; автор в (500,500), цель-NPC в (600,500).
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afForcedMoveResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afForcedMove ?? {}) };
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

  // ---------- уборка (аварийная: window.__afForcedMove = {cleanOnly: true}) ----------
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


  // ---------- сценарии forced-move ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  // Стойкость СЛ 20, d20=1: провал/крит. провал -> толчок на 10 фт (степени проверяются по результату, шаги одинаковые)
  const mv = (mode, distance) => ({ to: "target", move: { mode, distance } });
  const rule = (mode, distance) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: [mv(mode, distance)], criticalFailure: [mv(mode, distance)] } } } });
  const posOf = (t, e) => { const d = e.T(t); return { x: d.x, y: d.y }; };

  /** PC-автор (500,500) и NPC-цель; правило брошено в цель при d20=1. Возвращает токены, карточку и стартовую позицию цели. */
  const shove = async (e, r, vx = 600, extra = null) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("автор"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, vx, 500, -1);
    await wait(700);
    if (extra) await extra(e, tP, tV);
    const item = await e.ruleItem(pc, r);
    await e.fix(1);
    const t0 = e.since();
    const m = await e.fire(item, tP, tV);
    await wait(1500);
    return { pc, vic, tP, tV, m, t0 };
  };
  const at = (p, x, y) => p.x === x && p.y === y;

  sc("push", "Толчок на 10 фт: цель сдвинута по прямой от автора (600 -> 800), в журнале moved", async (e, t) => {
    const { tV, m } = await shove(e, rule("push", 10));
    t.ok(!["success", "criticalSuccess"].includes(e.results(m)[tV.id]), `цель провалила (${e.results(m)[tV.id]})`);
    t.ok(await waitFor(() => at(posOf(tV, e), 800, 500), 6000), `позиция ${JSON.stringify(posOf(tV, e))}`);
    const ops = e.use(m)?.state?.challenge?.applied?.[tV.id]?.ops ?? [];
    t.ok(ops.some((o) => o.op === "moved" && o.from?.x === 600 && o.to?.x === 800), `журнал: ${JSON.stringify(ops.map((o) => o.op))}`);
  });

  sc("wall", "Упор в стену: толчок на 30 фт останавливается перед стеной (700), без вылета сквозь", async (e, t) => {
    const { tV } = await shove(e, rule("push", 30), 600, async (ee) => { await ee.scene.createEmbeddedDocuments("Wall", [{ c: [770, 300, 770, 800] }]); });
    t.ok(await waitFor(() => at(posOf(tV, e), 700, 500), 6000), `остановка перед стеной: ${JSON.stringify(posOf(tV, e))}`);
  });

  sc("pull", "Притяжение на 30 фт: цель (900) подтянута вплотную к автору (600), не на его клетку", async (e, t) => {
    const { tV } = await shove(e, rule("pull", 30), 900);
    t.ok(await waitFor(() => at(posOf(tV, e), 600, 500), 6000), `вплотную: ${JSON.stringify(posOf(tV, e))}`);
  });

  sc("undo", "Откат карточки (undoOps): позиция цели вернулась, повторное применение двигает заново", async (e, t) => {
    const { tV, m } = await shove(e, rule("push", 10));
    t.ok(await waitFor(() => at(posOf(tV, e), 800, 500), 6000), "сдвинута");
    await bound("undoOps", (await imp("apply.mjs")).undoOps(game.messages.get(m.id), tV.id));
    t.ok(await waitFor(() => at(posOf(tV, e), 600, 500), 6000), `вернулась: ${JSON.stringify(posOf(tV, e))}`);
  });

  sc("no-reaction", "Реагирующий Удар: толчок из-под носа держателя не шлёт ему подсказку (вынужденное перемещение — не ход)", async (e, t) => {
    let holderItem = null;
    const { m, t0 } = await shove(e, rule("push", 10), 600, async (ee) => {
      const holder = await ee.pc("страж", [await find("pf2e.actionspf2e", "reactive-strike")]);
      const tH = await ee.tok(holder, 600, 600, 1);   // под целью: исходная клетка цели в досягаемости
      holderItem = ee.A(tH).items.find((i) => i.slug === "reactive-strike");
      const c = await ee.combat([ee.scene.tokens.contents.find((x) => x.actor?.name.endsWith("автор")), tH], [20, 10]);
      await c.startCombat(); await wait(1200);
    });
    t.ok(!!holderItem, "у стража есть Реагирующий Удар");
    t.ok(!!e.use(m), "правило отработало");
    t.ok(!e.msgs(t0).some((x) => String(x.content).includes("data-af-react-strike")), "шёпота реакции нет");
  });

  // Область (from:"point"): карточка использования с targets:"area" + круглый регион pf2e (burst) с messageId; цели NPC бросают сами при d20=1.
  const areaRule = (distance) => ({ v: 1, onUse: { targets: "area", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target",
    byDegree: { failure: [{ to: "target", move: { mode: "push", distance, from: "point" } }], criticalFailure: [{ to: "target", move: { mode: "push", distance, from: "point" } }] } } } });
  /** Автор далеко в стороне (150,1050), цели NPC в клетках (x, 500) для x из xs; круг радиуса r в (cx, 550). Возвращает токены целей и сообщение. */
  // o: { author:[x,y], extra:async(e)=>число лишних целей (напр. PC, который не бросает), region:(tokenDoc)=>{shapes, areaShape} }
  const burst = async (e, distance, xs, cx, r, o = {}) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("автор"), tP = await e.tok(pc, ...(o.author ?? [100, 1000]), 1);
    const toks = [];
    for (const [i, x] of xs.entries()) toks.push(await e.tok(await e.foe(`цель ${i}`), x, 500, -1));
    const more = o.extra ? await o.extra(e) : 0;
    await wait(700);
    const item = await e.ruleItem(pc, areaRule(distance));
    await e.fix(1);
    const t0 = e.since();
    await e.aim(tP);
    await bound("item.toMessage", item.toMessage(undefined, { create: true }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
    if (!m) throw new Error("у карточки области нет снимка use");
    if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
    const rg = o.region ? o.region(e.T(tP)) : { shapes: [{ type: "circle", hole: false, x: cx, y: 550, radius: r }], areaShape: "burst" };
    const [region] = await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}взрыв`, color: "#aa0000", shapes: rg.shapes, behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: rg.areaShape } } }]);
    await waitFor(() => (e.use(m)?.state?.area?.keys?.length ?? 0) >= xs.length + more, 10000);
    await wait(2500);
    return { toks, m, tP, region };
  };

  sc("point", "from:point: цель (600) вытолкнута от центра взрыва (550) вправо на 10 фт (-> 800), а не по лучу от автора (он внизу слева)", async (e, t) => {
    const { toks: [v], m } = await burst(e, 10, [600], 550, 150);
    t.ok((e.use(m)?.state?.area?.keys ?? []).includes(v.id), `цель не попала в область: ${JSON.stringify(e.use(m)?.state?.area)}; проверка testInsideRegion`);
    t.ok(await waitFor(() => at(posOf(v, e), 800, 500), 6000), `позиция ${JSON.stringify(posOf(v, e))}, ждали (800,500); от автора вышло бы по диагонали вверх-вправо`);
    const ops = e.use(m)?.state?.challenge?.applied?.[v.id]?.ops ?? [];
    t.ok(ops.some((o) => o.op === "moved" && o.to?.x === 800), `журнал: ${JSON.stringify(ops)}`);
  });

  sc("order", "Порядок в auto: три цели в ряд (600/700/800) выталкиваются на 5 фт от центра (550) — все сдвинуты (700/800/900), дальняя первой", async (e, t) => {
    const { toks, m } = await burst(e, 5, [600, 700, 800], 550, 400);
    t.ok(Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length === 3, `результатов ${Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length} из 3: ${JSON.stringify(e.results(m))}`);
    for (const [i, v] of toks.entries()) t.ok(await waitFor(() => at(posOf(v, e), 700 + i * 100, 500), 6000), `цель ${i}: ${JSON.stringify(posOf(v, e))}, ждали (${700 + i * 100},500) — ближняя упёрлась в неподвинутую соседку, если порядок «ближние первыми»`);
  });

  sc("emanation", "from:point у эманации: центр области = токен-носитель (bounds симметрична), цель (1100) выталкивается на 10 фт (-> 1300), без noPoint", async (e, t) => {
    const { toks: [v], m, tP, region } = await burst(e, 10, [1100], 0, 0, { author: [1000, 500],
      region: (d) => ({ areaShape: "emanation", shapes: [{ type: "emanation", hole: false, gridBased: true, radius: 200, base: { type: "token", x: d._source.x, y: d._source.y, width: d._source.width, height: d._source.height, shape: d._source.shape } }] }) });
    const b = region.bounds, c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    t.ok(c.x === 1050 && c.y === 550, `центр region.bounds ${JSON.stringify(c)}, токен-носитель (1050,550); bounds ${JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height })}`);
    const ap = (await imp("move.mjs")).areaPoint(e.use(m), region);
    t.ok(ap && ap.x === 1050 && ap.y === 550, `areaPoint ${JSON.stringify(ap)}`);
    t.ok(!notes.some((n) => /noPoint|центр области не найден|area centre/i.test(n)), `заметки: ${notes.join(" / ")}`);
    t.ok(await waitFor(() => at(posOf(v, e), 1300, 500), 6000), `позиция ${JSON.stringify(posOf(v, e))}, ждали (1300,500)`);
  });

  sc("auto-all-undo", "Пакет auto: после отката двух строк и переброса одной откатанные чужие заново не применяются (autoAll)", async (e, t) => {
    const { toks, m } = await burst(e, 5, [600, 700, 800], 550, 400);
    for (const [i, v] of toks.entries()) t.ok(await waitFor(() => at(posOf(v, e), 700 + i * 100, 500), 6000), `пакет: цель ${i} ${JSON.stringify(posOf(v, e))}`);
    t.ok(e.use(m)?.state?.challenge?.autoAll === true, `autoAll ${e.use(m)?.state?.challenge?.autoAll}`);
    const { undoOps } = await imp("apply.mjs"), { recordResult } = await imp("saves.mjs");
    await bound("undo 2", undoOps(game.messages.get(m.id), toks[2].id));
    await bound("undo 1", undoOps(game.messages.get(m.id), toks[1].id));
    t.ok(at(posOf(toks[1], e), 700, 500) && at(posOf(toks[2], e), 800, 500), "обе вернулись");
    await bound("переброс цели 2", recordResult(m.id, toks[2].id, { degree: 1, total: 1, rollMessageId: "af-reroll", isReroll: true }));
    t.ok(await waitFor(() => at(posOf(toks[2], e), 900, 500), 6000), `цель 2 применена: ${JSON.stringify(posOf(toks[2], e))}`);
    await wait(1500);
    t.ok(at(posOf(toks[1], e), 700, 500), `цель 1 откатана и не применена заново: ${JSON.stringify(posOf(toks[1], e))}`);
  });

  sc("waiting", "Ожидание бросков: PC-цель не бросает — бросившая NPC не двигается сама, виден счётчик «ждём» и «Применить всё», кнопка двигает", async (e, t) => {
    const { toks: [v], m } = await burst(e, 5, [600], 550, 400, { extra: async (ee) => { const u = game.users.find((x) => !x.isGM); if (!u) throw new Skip("нет игрока-владельца для PC-цели"); const p = await ee.pc("игрок"); await p.update({ ownership: { default: 0, [u.id]: 3 } }); await ee.tok(p, 600, 700, 1); return 1; } });
    t.ok(Object.keys(e.use(m)?.state?.challenge?.results ?? {}).includes(v.id), `NPC бросил: ${JSON.stringify(e.results(m))}`);
    t.ok(at(posOf(v, e), 600, 500), `цель ждёт, не двигалась: ${JSON.stringify(posOf(v, e))}`);
    t.ok(!e.use(m)?.state?.challenge?.autoTried?.[v.id], "autoTried бросившему не ставится");
    const box = e.dom(m)?.querySelector(".paf-bulk");
    t.ok(!!box?.querySelector('button[data-action=apply][data-token=all]'), `«Применить всё» есть: ${box?.textContent?.replace(/\s+/g, " ")}`);
    t.ok(/1/.test(box?.querySelector(".paf-pending:last-of-type")?.textContent ?? ""), `строка ожидания: ${box?.textContent?.replace(/\s+/g, " ")}`);
    box?.querySelector('button[data-action=apply][data-token=all]')?.click();
    t.ok(await waitFor(() => at(posOf(v, e), 700, 500), 6000), `после «Применить всё»: ${JSON.stringify(posOf(v, e))}`);
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} forced-move | ${s.id}`, err); }
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
  window.__afForcedMoveResult = result;
  return result;
}
