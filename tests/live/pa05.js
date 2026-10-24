async () => {
  // Живые сценарии механизмов пачки 0.5 (ROADMAP 0.5c–0.5g). Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в suite.js.
  // Параметры (перед запуском): window.__afPa05 = { only: ["badge", ...], skip: [...], cleanOnly: true }
  // Каждый сценарий: своя сцена и временные «AF тест: …» актёры, в конце ВСЁ удаляется. Проверяется состояние актёров и эффектов, не текст чата.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afPa05Result.
  // Непонятное место даёт fail/skip с detail, а не зависание: каждое ожидание ограничено, сценарий — 150 с.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afPa05 ?? {}) };
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

  // ---------- уборка (аварийная: window.__afPa05 = {cleanOnly: true}) ----------
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
  const FRIGHTFUL = "Compendium.pf2e.abomination-vaults-bestiary.Actor.BOaM3pAuWl06Q6IZ.Item.BPJS4QzIXUC3Zmwf";   // «Пугающее присутствие» с СЛ 22 (в глоссарии СЛ пуста)
  const ENGULF_FX = "Compendium.pf2e.bestiary-effects.Item.1cbIe569UD6paXad";    // Effect: Engulf and Swallow Whole (выдаёт Remaining Air)
  const RAGE_FX = "Compendium.pf2e.feat-effects.Item.z3uyCMBddrPK5umr";           // Effect: Rage
  const STAND = "Compendium.pf2e.actionspf2e.Item.OdIUybJ3ddfL7wzj";
  const BLESS = "Compendium.pf2e.spell-effects.Item.Gqy7K6FnbLtwGpud";            // счётчик-значок, для badge:"increment"
  const TONGUE_GRAB = "Compendium.pf2e.age-of-ashes-bestiary.Actor.oPXRJxxWrY2kz2qf.Item.wqr4H9kTRu8PWkfc";
  const HARDWOOD_FX = "Compendium.pf2e-automato.effects.Item.mxIt7zfVKgLZ8AeC";   // эффект модуля «Деревянный доспех» (флаг gear)

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
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка mode.${k.replace("mode.", "")} = ${setting(k)}`); };
  const yields = async (...groups) => { const { paHas } = await imp("builtin/lib.mjs"); const g = groups.find((x) => paHas(x)); if (g) throw new Skip(`уступка pf2e-automations: группа ${g}`); };
  const hp = (a) => a.system.attributes.hp.value;

  sc("challenge-immunity", "Пугающее присутствие NPC: провал -> испуган 2 + иммунитет; повтор — испытание не предлагается", async (e, t) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off");
    const mon = await e.foe("пугало"), vic = await e.foe("жертва");
    const tM = await e.tok(mon, 500, 500, -1), tV = await e.tok(vic, 800, 500, 1);
    await wait(700);
    const fp = (await e.give(e.A(tM), await src(FRIGHTFUL)))[0], va = e.A(tV);
    await e.rig(va, "will", 21 - 10 - va.saves.will.mod);   // d20=10, СЛ 22 -> итог 21: провал, не крит.
    await e.fix(10);
    const card = await e.fire(fp, tM, tV);
    t.ok(!!(await waitFor(() => Object.keys(e.results(card)).length, 12000)), "испытание брошено (авто NPC)");
    const d = Object.values(e.results(card))[0];
    t.ok(d === "failure", `исход: провал (${d}; СЛ карточки ${e.use(card)?.dc})`);
    await e.applyAll(card);
    t.ok(await waitFor(() => e.cond(va, "frightened")?.value === 2, 6000), `испуган 2 (${va.items.map((i) => i.slug)})`);
    // в auto иммунитет ставится следующим шагом после испуга (applyByDegree: applyOps, затем applyImmunity) — ждём, а не проверяем мгновенно
    t.ok(await waitFor(() => va.items.some((i) => i.type === "effect" && i.flags?.[MOD]?.immunity?.slug === "frightful-presence"), 6000), "эффект иммунитета на цели (flags.pf2e-automato.immunity.slug)");
    const t1 = e.since();
    const card2 = await e.fire(fp, tM, tV);
    await wait(3000);
    t.ok(!e.msgs(t1).some((m) => m.flags?.pf2e?.context?.type === "saving-throw"), "второе испытание: спасброска нет");
    t.ok(Object.keys(e.results(card2)).length === 0, "второе испытание: результатов нет");
    t.ok(e.cond(va, "frightened")?.value === 2, "испуган по-прежнему 2");
  });

  sc("suffocation", "Нехватка воздуха: Remaining Air со значком 1 удалён -> Удушье + Без сознания; Engulf удалён -> оба сняты", async (e, t) => {
    await yields("swallow-whole");
    const pc = await e.pc("утопающий");
    await e.tok(pc, 500, 500, 1);
    await wait(700);
    const [host] = await e.give(pc, await src(ENGULF_FX));
    const isAir = (i) => i.type === "effect" && i.slug === "effect-remaining-air", isSuf = (i) => i.type === "effect" && i.slug === "effect-suffocating";
    const air = await waitFor(() => pc.items.find(isAir), 6000);
    t.ok(!!air, "GrantItem выдал Remaining Air");
    if (!air) return;
    await air.update({ "system.badge.value": 1 });
    await air.decrease?.();   // pf2e на значке ниже минимума удаляет эффект сам
    if (pc.items.get(air.id)) await pc.items.get(air.id).delete();
    t.ok(await waitFor(() => pc.items.some(isSuf), 8000), `есть «Удушье» (${pc.items.map((i) => i.slug)})`);
    t.ok(await waitFor(() => e.cond(pc, "unconscious"), 6000), "есть «Без сознания»");
    await pc.items.get(host.id)?.delete();
    t.ok(await waitFor(() => !pc.items.some(isSuf) && !e.cond(pc, "unconscious"), 8000), `Engulf удалён: «Удушье» и «Без сознания» сняты (${pc.items.map((i) => i.slug)})`);
  });

  sc("improved-grab", "Удар NPC с improved-grab попал -> у цели grabbed без окна", async (e, t) => {
    openChat(); await yields("grab");
    const att = await e.foe("захватчик"), vic = await e.pc("жертва");
    const tA = await e.tok(att, 500, 500, -1), tV = await e.tok(vic, 600, 500, 1);
    await wait(700);
    const aa = e.A(tA), melee = aa.itemTypes.melee[0];
    if (!melee) throw new Error("у NPC нет ближнего Удара (melee)");
    await melee.update({ "system.attackEffects.value": ["improved-grab"] });
    await e.rig(aa, "attack-roll", 30); await e.rig(aa, "athletics", 30);   // попасть и преуспеть в Захвате при d20=10
    await e.fix(10);
    const t0 = e.since();
    const m = await e.hit(tA, tV);
    t.ok(!!m && ["success", "criticalSuccess"].includes(m.flags.pf2e.context.outcome), `Удар попал (${m?.flags?.pf2e?.context?.outcome})`);
    const g = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.options?.includes("action:grapple")), 10000);
    t.ok(!!g, "бесплатный Захват проведён модулем");
    const held = () => e.cond(vic, "grabbed") || e.cond(vic, "restrained");   // крит. успех Захвата — restrained
    let grabbed = await waitFor(held, 4000);
    if (!grabbed && g) { await e.applyAll(g); grabbed = await waitFor(held, 6000); }   // режим «Применить» по умолчанию — кнопка
    t.ok(!!grabbed, `цель схвачена или обездвижена (${vic.items.map((i) => i.slug)}; исход Захвата ${g?.flags?.pf2e?.context?.outcome})`);
    t.ok(e.dialogs.length === 0, `окон модуля не было (${e.dialogs})`);
  });

  sc("rage-immunity", "Ярость закончилась -> иммунитет к временным ОЗ от Ярости на 1 минуту", async (e, t) => {
    await yields("rage");
    const pc = await e.pc("яростный");
    await e.tok(pc, 500, 500, 1);
    await wait(700);
    const [rage] = await e.give(pc, await src(RAGE_FX));
    t.ok(rage?.slug === "effect-rage", `эффект Ярости создан (${rage?.slug})`);
    await pc.items.get(rage.id)?.delete();
    const imm = await waitFor(() => pc.items.find((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === "rage-immunity"), 8000);
    t.ok(!!imm, "иммунитет выдан (meta.key rage-immunity)");
    t.ok(imm?.slug === "effect-rage-temporary-hit-points-immunity", `slug иммунитета (${imm?.slug})`);
    t.ok(imm?.system.duration.value === 1 && imm?.system.duration.unit === "minutes", `срок 1 минута (${imm?.system.duration.value} ${imm?.system.duration.unit})`);
    t.ok(!pc.items.some((i) => i.slug === "effect-rage"), "Ярости на актёре нет");
  });

  sc("remove-condition", "Встать на лежащем: prone снят; откат возвращает", async (e, t) => {
    needMode("mode.effect", "off");
    const pc = await e.pc("лежащий");
    const tP = await e.tok(pc, 500, 500, 1);
    await wait(700);
    const [stand] = await e.give(pc, await src(STAND));
    await api().applyCondition(pc, { slug: "prone", policy: "max" });
    t.ok(!!(await waitFor(() => e.cond(pc, "prone"), 4000)), "исходно prone");
    const m = await e.fire(stand, tP);
    t.ok(await waitFor(() => !e.cond(pc, "prone"), 8000), "после Встать prone снят");
    t.ok(!!(await waitFor(() => e.use(m)?.state?.apply?.self?.ops?.length, 6000)), "шаг записан в state.apply.self.ops");
    await api().undoOps(game.messages.get(m.id), "self");
    t.ok(await waitFor(() => e.cond(pc, "prone"), 6000), "откат вернул prone");
  });

  /** Правило: onUse по выбранным целям; автор — PC, цель — NPC (его токен «развязан»: читать e.A). */
  const duel = async (e, apply) => {
    needMode("mode.effect", "off");
    const pc = await e.pc("автор"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 700, 500, -1);
    await wait(700);
    const item = await e.ruleItem(pc, { v: 1, onUse: { targets: "selected", apply } });
    return { pc, tP, tV, item, va: e.A(tV) };
  };

  sc("badge", "badge:increment: два применения -> значок +1 один раз за ключ, повтор не прибавляет", async (e, t) => {
    const { applyUse } = await imp("use.mjs");
    const { tP, tV, item, va } = await duel(e, [{ to: "target", effect: { uuid: BLESS, badge: "increment" } }]);
    const badge = () => va.itemTypes.effect.find((i) => i._stats?.compendiumSource === BLESS)?.system.badge?.value;
    const m1 = await e.fire(item, tP, tV);
    t.ok(await waitFor(() => badge() === 1, 6000), `первое применение создало эффект со значком 1 (${badge()})`);
    const m2 = await e.fire(item, tP, tV);
    t.ok(await waitFor(() => badge() === 2, 6000), `второе применение: значок 2 (${badge()})`);
    await applyUse(m2.id).catch((x) => notes.push(`applyUse: ${x}`)); await applyUse(m1.id).catch((x) => notes.push(`applyUse: ${x}`)); await wait(1000);
    t.ok(badge() === 2, `повтор «Применить» значок не прибавил (${badge()})`);
    t.ok(va.itemTypes.effect.filter((i) => i._stats?.compendiumSource === BLESS).length === 1, "копия эффекта одна");
  });

  sc("damage-step", "Шаг damage: ОЗ уменьшились; повторное «Применить» после «Отменить» урон не повторяет", async (e, t) => {
    const { applyUse } = await imp("use.mjs");
    const { tP, tV, item, va } = await duel(e, [{ to: "target", damage: { formula: "3d1", damageType: "untyped" } }]);   // 3d1 = ровно 3
    const hp0 = hp(va);
    const m = await e.fire(item, tP, tV);
    t.ok(await waitFor(() => hp(va) === hp0 - 3, 8000), `ОЗ ${hp0} -> ${hp(va)} (ждали -3)`);
    await waitFor(() => e.use(m)?.state?.damaged?.length, 4000);
    t.ok(e.use(m)?.state?.damaged?.length === 1, `журнал state.damaged: ${JSON.stringify(e.use(m)?.state?.damaged)}`);
    await api().undoOps(game.messages.get(m.id), tV.id);   // «Отменить»: урон модуль не откатывает — это делает карточка pf2e; имитируем её
    await va.update({ "system.attributes.hp.value": hp0 });
    await applyUse(m.id).catch((x) => notes.push(`applyUse: ${x}`)); await wait(1500);
    t.ok(hp(va) === hp0, `повторное «Применить» урон не повторило (ОЗ ${hp(va)} из ${hp0})`);
  });

  sc("damage-in-degree", "Шаг damage в challenge.byDegree (basic): провал рефлекса -> ОЗ уменьшились, карточка не зависла", async (e, t) => {
    needMode("mode.challenge", "off"); needMode("mode.apply", "off"); needMode("mode.effect", "off");
    const pc = await e.pc("автор"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 700, 500, -1);
    await wait(700);
    const item = await e.ruleItem(pc, { v: 1, onUse: { targets: "selected", challenge: { statistic: "reflex", dc: { value: 30 }, byDegree: { failure: [{ to: "target", damage: { formula: "3d1", damageType: "untyped", basic: true } }] } } } });
    const va = e.A(tV), hp0 = hp(va);
    await e.rig(va, "reflex", 29 - 10 - va.saves.reflex.mod);   // d20=10, СЛ 30 -> итог 29: провал, не крит.
    await e.fix(10);
    const card = await e.fire(item, tP, tV);
    t.ok(!!(await waitFor(() => Object.keys(e.results(card)).length, 12000)), "испытание брошено");
    const d = Object.values(e.results(card))[0];
    if (d !== "failure") throw new Skip(`исход ${d}, ждали failure`);
    await e.applyAll(card);
    t.ok(await waitFor(() => hp(va) < hp0, 8000), `ОЗ ${hp0} -> ${hp(va)}`);
    t.ok(await waitFor(() => e.use(card)?.state?.damaged?.length === 1, 4000), `журнал state.damaged: ${JSON.stringify(e.use(card)?.state?.damaged)}`);
    t.ok(!!e.use(card)?.state?.challenge?.applied?.[tV.id]?.ops?.length, "applyByDegree завершился, ops записаны (очередь не зависла)");
  });

  sc("reduce","condition.policy:reduce: frightened 2 -> 1; повтор не уменьшает снова", async (e, t) => {
    const { applyUse } = await imp("use.mjs");
    const { tP, tV, item, va } = await duel(e, [{ to: "target", condition: { slug: "frightened", value: 1, policy: "reduce" } }]);
    await api().applyCondition(va, { slug: "frightened", value: 2, policy: "max" });
    t.ok(e.cond(va, "frightened")?.value === 2, "исходно испуган 2");
    const m = await e.fire(item, tP, tV);
    t.ok(await waitFor(() => e.cond(va, "frightened")?.value === 1, 8000), `испуган 2 -> ${e.cond(va, "frightened")?.value ?? "снят"}`);
    await applyUse(m.id).catch((x) => notes.push(`applyUse: ${x}`)); await wait(1000);
    t.ok(e.cond(va, "frightened")?.value === 1, `повтор не уменьшил (${e.cond(va, "frightened")?.value ?? "снят"})`);
  });

  sc("onevent-strike", "onEvent attack-roll (Tongue Grab): попадание -> «схвачен, но не обездвижен» + off-guard, без immobilized", async (e, t) => {
    needMode("mode.macro", "off");
    const att = await e.foe("лягушка"), vic = await e.pc("жертва");
    const tA = await e.tok(att, 500, 500, -1), tV = await e.tok(vic, 600, 500, 1);
    await wait(700);
    const aa = e.A(tA), melee = aa.itemTypes.melee[0];
    if (!melee) throw new Error("у NPC нет ближнего Удара (melee)");
    await melee.update({ "system.attackEffects.value": ["tongue-grab"] });
    await e.give(aa, await src(TONGUE_GRAB));
    await e.rig(aa, "attack-roll", 30);
    await e.fix(10);
    const m = await e.hit(tA, tV);
    t.ok(!!m && ["success", "criticalSuccess"].includes(m.flags.pf2e.context.outcome), `Удар попал (${m?.flags?.pf2e?.context?.outcome})`);
    t.ok(!!(await waitFor(() => vic.items.find((i) => i.slug === "effect-grabbed-not-immobilized"), 10000)), `эффект «схвачен, но не обездвижен» (${vic.items.map((i) => i.slug)})`);
    t.ok(!!e.cond(vic, "off-guard"), "off-guard");
    t.ok(!e.cond(vic, "immobilized"), "immobilized нет");
  });

  sc("gear", "Деревянный доспех: временная броня надета, настоящая снята; снятие эффекта возвращает настоящую", async (e, t) => {
    needMode("mode.macro", "off"); await yields("hardwood-armor");
    const real = await equip("leather-armor");
    real.system.equipped = { carryType: "worn", inSlot: true };
    const pc = await e.pc("лесной", [real, held(await equip("greatsword"), 2)]);   // обе руки заняты: окно «выдать щит?» не появится
    await e.tok(pc, 500, 500, 1);
    await wait(700);
    const armor = pc.itemTypes.armor.find((a) => a.slug === "leather-armor");
    t.ok(!!armor?.system.equipped?.inSlot, "исходно настоящая броня надета");
    const [fx] = await e.give(pc, await src(HARDWOOD_FX));
    const temp = () => pc.itemTypes.armor.find((a) => a.flags?.[MOD]?.gearOf === fx.id);
    t.ok(await waitFor(() => temp()?.system.equipped?.inSlot, 8000), `временная броня надета (${pc.itemTypes.armor.map((a) => `${a.slug}:${a.system.equipped?.carryType}/${a.system.equipped?.inSlot}`)})`);
    t.ok(temp()?.system.temporary === true, "временная броня помечена system.temporary");
    t.ok(!pc.items.get(armor.id)?.system.equipped?.inSlot, "настоящая броня снята со слота");
    await pc.items.get(fx.id)?.delete();
    t.ok(await waitFor(() => !temp() && pc.items.get(armor.id)?.system.equipped?.inSlot, 8000), `после снятия эффекта настоящая надета, временной нет (${pc.itemTypes.armor.map((a) => `${a.slug}:${a.system.equipped?.carryType}/${a.system.equipped?.inSlot}`)})`);
  });

  sc("damage-link", "Life Link на союзнике: урон по союзнику -> часть ушла заклинателю (до применения)", async (e, t) => {
    needMode("mode.macro", "off"); await yields("life-link", "share-life");
    const caster = await e.pc("заклинатель"), ally = await e.pc("союзник");
    await e.tok(caster, 500, 500, 1); const tA = await e.tok(ally, 700, 500, 1);
    await wait(700);
    // эффект, как после сотворения Life Link (ранг 3: переносится до 5 урона); сам каст в ячейках 1-2 круга стенда невозможен
    await e.give(ally, { type: "effect", name: "AF Life Link", system: { slug: "effect-life-link", level: { value: 3 }, duration: { value: 10, unit: "minutes", sustained: false, expiry: "turn-start" },
      context: { origin: { actor: caster.uuid, token: null, item: null, spellcasting: null, rollOptions: [] }, target: { actor: ally.uuid, token: null }, roll: null } } });
    const a0 = hp(ally), c0 = hp(caster);
    await ally.applyDamage({ damage: 10, token: e.T(tA) });
    t.ok(hp(ally) === a0 - 5, `союзник получил 5 из 10 сразу (ОЗ ${a0} -> ${hp(ally)})`);
    t.ok(await waitFor(() => hp(caster) === c0 - 5, 8000), `заклинатель получил 5 (ОЗ ${c0} -> ${hp(caster)})`);
  });

  sc("when", "Шаг с when: условие выполнено — срабатывает, не выполнено — нет", async (e, t) => {
    const probe = await e.foe("проба"), trait = [...probe.traits][0];
    if (!trait) throw new Skip("у NPC нет черт для предиката");
    const { tP, tV, item, va } = await duel(e, [
      { to: "target", when: [`target:trait:${trait}`], condition: { slug: "frightened", value: 1 } },
      { to: "target", when: ["target:trait:af-nonexistent"], condition: { slug: "sickened", value: 1 } }
    ]);
    await e.fire(item, tP, tV);
    t.ok(await waitFor(() => e.cond(va, "frightened")?.value === 1, 8000), `when выполнено (target:trait:${trait}): испуган 1 (${va.items.map((i) => i.slug)})`);
    t.ok(!e.cond(va, "sickened"), "when не выполнено: тошноты нет");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} pa05 | ${s.id}`, err); }
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
  window.__afPa05Result = result;
  return result;
}
