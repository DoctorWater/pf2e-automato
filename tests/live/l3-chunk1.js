async () => {
  // Живой сценарий l3-chunk1: правила 3-го уровня героев (кусок 1) — Heal, Calm, Grim Tendrils, Dizzying Colors (шок на срок), Darkness, Shield (иммунитет после блока).
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в repeat-save.js / forced-move.js: временные «AF тест: …» актёры, сцена, бой; уборка в finally.
  // Правила берутся из rules/catalog.json (СЛ source:"spell" заменяется на 20), область — регион pf2e с messageId карточки. Настоящих персонажей не трогает.
  // Параметры (перед запуском): window.__afL3 = { only: ["heal-undead", ...], skip: [...], cleanOnly: true }
  // Результат: массив строк «PASS|FAIL|SKIP id: подробности» (то же в window.__afL3Result и console.table).
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL3 ?? {}) };
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



  // ---------- сценарии l3-chunk1 ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const SP = "Compendium.pf2e.spells-srd.Item.";
  const U = { heal: "rfZpqmj0AIIdkVIs", calm: "b515AZlB0sridKSq", grim: "k34hDOfIIMAxNL4a", dizzy: "UKsIOWmMx4hSpafl", dark: "4GE2ZdODgIQtg51c", shield: "TVKNbcgTee19PXZR", invis: "XXqE1eY3w3z6xJCB" };
  const jget = async (f) => (await fetch(`/modules/${MOD}/rules/${f}`)).json();
  /** Правило каталога по uuid заклинания; СЛ источника «spell» у мирового действия не определена -> фиксированная СЛ 20 (бросок цели — по её модификатору). */
  const catRule = async (id) => {
    const r = structuredClone((await jget("catalog.json")).bySource[SP + id]);
    if (!r) throw new Error(`нет правила ${id} в catalog.json`);
    const ch = r.onUse?.challenge; if (ch?.dc?.source) ch.dc = { value: 20 };
    return r;
  };
  const effOf = (a, uuid) => a.items.find((i) => i.type === "effect" && i._stats?.compendiumSource === uuid);
  const cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug) ?? null;
  const asUndead = (a) => a.update({ "system.traits.value": [...new Set([...(a.system.traits?.value ?? []), "undead"])] });

  /** Область: автор-PC и цели-NPC (кроме undead[i] — они «нежить») в круге; d20 цели — roll. -> {pc, tP, toks, m, region} */
  const area = async (e, rule, { n = 2, undead = [], roll = 1, combat = false, noRegion = false } = {}) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("автор"), tP = await e.tok(pc, 100, 1000, 1);
    const toks = [];
    for (let i = 0; i < n; i++) toks.push(await e.tok(await e.foe(`цель ${i}`), 500 + i * 100, 500, -1));
    await wait(700);
    for (const i of undead) await asUndead(e.A(toks[i]));
    const item = await e.ruleItem(pc, rule);
    let c = null;
    if (combat) { c = await e.combat([tP, ...toks], [20, ...toks.map(() => 10)]); await c.startCombat(); await wait(1200); }
    await e.fix(roll);
    const t0 = e.since();
    await e.aim(tP);
    await bound("item.toMessage", item.toMessage(undefined, { create: true }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
    if (!m) throw new Error("у карточки нет снимка use");
    if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
    let region = null;
    if (!noRegion) {
      [region] = await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#aa0000", shapes: [{ type: "circle", hole: false, x: 600 + (n - 1) * 50, y: 550, radius: 200 }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: "burst" } } }]);
      await waitFor(() => (e.use(m)?.state?.area?.keys?.length ?? 0) >= n, 10000);
    }
    await wait(2500);
    return { pc, tP, toks, m, region, c };
  };
  const rolled = (e, m, tok) => Object.keys(e.use(m)?.state?.challenge?.results ?? {}).includes(tok.id);

  sc("resolve", "resolveRule: Heal, Calm, Grim Tendrils, Dizzying Colors, Darkness, Invisibility — из catalog (не world, не pa/model), у Darkness нет зоны", async (e, t) => {
    const { resolveRule } = await imp("rules.mjs");
    for (const [k, id] of Object.entries(U)) {
      if (k === "shield") continue;
      const doc = await fromUuid(SP + id);
      if (!doc) { t.ok(false, `${k}: нет в паке`); continue; }
      const r = resolveRule(doc);
      t.ok(r?.source === "catalog", `${k}: source=${r?.source} (world — в мире снимок каталога перекрывает; обновить снимок)`);
      if (k === "grim") t.ok(r?.rule?.onUse?.targets === "area" && JSON.stringify(r.rule.onUse.challenge?.when) === '["target:mode:living"]', "grim: area + when living");
      if (k === "dark") t.ok(!r?.rule?.onUse?.zone && !!r?.rule?.onUse?.apply?.[0]?.note, "darkness: заметка без зоны");
    }
    const shield = resolveRule(await fromUuid(SP + U.shield));
    t.ok(!!shield?.rule?.onUse?.apply?.[0]?.unlessEffect, `Shield: у шага есть unlessEffect (source=${shield?.source}); если нет — добавить в catalog.campaign.json (он перекрывает catalog.json)`);
  });

  sc("heal-undead", "Heal (3 действия, область): Стойкость бросает только нежить; живой не бросает", async (e, t) => {
    const { toks: [live, dead], m } = await area(e, await catRule(U.heal), { undead: [1] });
    t.ok(rolled(e, m, dead), `нежить бросила: ${JSON.stringify(e.results?.(m) ?? {})}`);
    t.ok(!rolled(e, m, live), "живой не бросал");
  });

  sc("heal-nozone", "Heal 1–2 действия (области нет): ограничение — модуль молчит, испытаний нет (штатные кнопки карточки pf2e)", async (e, t) => {
    const { toks: [live, dead], m } = await area(e, await catRule(U.heal), { undead: [1], noRegion: true });
    t.ok(!e.use(m)?.state?.area?.keys?.length, `области нет: ${JSON.stringify(e.use(m)?.state?.area)}`);
    t.ok(!rolled(e, m, live) && !rolled(e, m, dead), "никто не бросал: без региона карточка Heal 1–2 действия не даёт целей (план §3.1)");
  });

  sc("calm-success", "Calm, успех Воли: эффект «−1 к атакам» на цели", async (e, t) => {
    const { toks: [a], m } = await area(e, await catRule(U.calm), { n: 1, roll: 20 });
    t.ok(["success", "criticalSuccess"].includes(deg(e.use(m)?.state?.challenge?.results?.[a.id]?.degree)), `исход ${deg(e.use(m)?.state?.challenge?.results?.[a.id]?.degree)}`);
    const fx = effOf(e.A(a), "Compendium.pf2e.spell-effects.Item.Qr5rgoZvI4KmFY0N");
    t.ok(!!fx === (deg(e.use(m)?.state?.challenge?.results?.[a.id]?.degree) === "success"), `эффект только при успехе (крит. успех — ничего): ${!!fx}`);
  });

  sc("calm-failure", "Calm, провал Воли: эффекта нет, только заметка по тексту", async (e, t) => {
    const { toks: [a], m } = await area(e, await catRule(U.calm), { n: 1, roll: 1 });
    t.ok(!effOf(e.A(a), "Compendium.pf2e.spell-effects.Item.Qr5rgoZvI4KmFY0N"), "эффект Calm не выдан");
  });

  sc("grim-undead", "Grim Tendrils: живая цель проваливает Стойкость и получает продолжительное кровотечение, нежить не бросает", async (e, t) => {
    const { toks: [live, dead], m } = await area(e, await catRule(U.grim), { undead: [1] });
    t.ok(rolled(e, m, live), "живой бросил");
    t.ok(!rolled(e, m, dead), "нежить не бросала");
    t.ok(!!cond(e.A(live), "persistent-damage"), "у живого продолжительный урон");
    t.ok(!cond(e.A(dead), "persistent-damage"), "у нежити нет");
  });

  sc("dizzy-critfail", "Dizzying Colors, крит. провал: шок (stunned без числа, на срок) + ослепление; шок снят к началу следующего хода заклинателя", async (e, t) => {
    const { toks: [a], c, pc } = await area(e, await catRule(U.dizzy), { n: 1, roll: 1, combat: true });
    const wrap = () => cond(e.A(a), "stunned")?.grantedBy ?? null;   // обёртка — тот, кто выдал stunned (имя локализовано, по тексту не ищем)
    t.ok(!!wrap(), "обёртка шока на срок создана");
    t.ok(!!wrap()?.name && !/\d/.test(wrap().name), `имя без числа: «${wrap()?.name}»`);
    t.ok(wrap()?.system?.duration?.unit === "rounds" && wrap()?.system?.duration?.expiry === "turn-start", `срок: ${JSON.stringify(wrap()?.system?.duration)}`);
    t.ok(!notes.some((n) => /RemovalPrevented/.test(n)), `нет RemovalPrevented: ${notes.join(" / ")}`);
    t.ok(!!cond(e.A(a), "stunned") && !!cond(e.A(a), "blinded"), "состояния stunned и blinded выданы");
    await bound("nextTurn", c.nextTurn()); await wait(2500);   // ход цели
    const mid = `${!!wrap()}/${cond(e.A(a), "stunned")?.value?.value ?? "—"}`;
    await bound("nextTurn", c.nextTurn()); await wait(2500);   // раунд 2: начало хода заклинателя
    t.ok(c.combatant?.actorId === pc.id, "ходит заклинатель, раунд 2");
    t.ok(!wrap() && !cond(e.A(a), "stunned"), `шок снят (в ход цели обёртка/значение было: ${mid})`);
    t.ok(!!cond(e.A(a), "blinded"), "ослепление (1 минута) осталось");
  });

  sc("darkness", "Darkness: только заметка, без зоны concealed", async (e, t) => {
    const { toks, m } = await area(e, await catRule(U.dark), { n: 1, noRegion: true });
    t.ok(!e.use(m)?.state?.zone && e.scene.regions.size === 0, `зоны нет (regions=${e.scene.regions.size})`);
    t.ok(!cond(e.A(toks[0]), "concealed"), "concealed не выдан");
  });

  sc("shield", "Щит -> блок -> Shield Immunity (10 мин) -> повторное сотворение не ставит эффект Щита", async (e, t) => {
    openChat(); needMode("mode.apply", "off", "button");
    const SHIELD_FX = "Compendium.pf2e.spell-effects.Item.Jemq5UknGdMO7b73", IMM = "Compendium.pf2e.spell-effects.Item.QF6RDlCoTvkVHRo4";
    const pc = await e.pc("жрец"), tP = await e.tok(pc, 500, 500, 1);
    await wait(700);
    await e.give(e.A(tP), await src(SHIELD_FX));
    const fx = await waitFor(() => effOf(e.A(tP), SHIELD_FX), 5000);
    t.ok(!!fx, "эффект Щита на актёре");
    if (!e.A(tP).attributes.shield?.raised) await e.A(tP).update({ "system.attributes.shield.raised": true }).catch(() => {});
    if (!e.A(tP).attributes.shield?.raised) throw new Skip(`щит не поднят: ${JSON.stringify(e.A(tP).attributes.shield)}`);
    // блок: applyDamage с shieldBlockRequest (обёртка модуля снимает Щит и выдаёт иммунитет)
    await bound("applyDamage", e.A(tP).applyDamage({ damage: 8, token: e.T(tP), shieldBlockRequest: true }));
    t.ok(await waitFor(() => !effOf(e.A(tP), SHIELD_FX), 8000), "эффект Щита снят");
    const imm = await waitFor(() => effOf(e.A(tP), IMM), 8000);
    t.ok(!!imm, "Shield Immunity выдан");
    t.ok(imm?.system?.duration?.unit === "minutes" && imm?.system?.duration?.value === 10, `10 минут: ${JSON.stringify(imm?.system?.duration)}`);
    // повторное сотворение: правило Щита (campaign/catalog) под иммунитетом
    const { resolveRule } = await imp("rules.mjs");
    const rule = structuredClone(resolveRule(await fromUuid(SP + U.shield))?.rule);
    t.ok(!!rule?.onUse?.apply?.[0]?.unlessEffect, "в правиле Щита есть unlessEffect (иначе проверка ниже бессмысленна)");
    const item = await e.ruleItem(e.A(tP), rule);
    await e.aim(tP);
    const t0 = e.since();
    await bound("item.toMessage", item.toMessage(undefined, { create: true }));
    await waitFor(() => e.msgs(t0).find((x) => x.flags?.[MOD]?.use), 8000);
    await wait(2500);
    t.ok(!effOf(e.A(tP), SHIELD_FX), "повторный Щит не поставлен");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} l3-chunk1 | ${s.id}`, err); }
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
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afL3Result = out;
  return out;
}
