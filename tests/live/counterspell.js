async () => {
  // Живые сценарии удержания сотворения (M4, шаг 2: hold.mjs, причина "counter") БЕЗ диспетчера: флаг ставится вручную через api.markCounterHold на карточку сотворения.
  // Ожидание: пока удержано — эффект не исполняется (нет регионов/целей/спасбросков/урона), кнопки скрыты, плашка с «Выпустить»/«Отменить»;
  // «Выпустить» — исполняется ровно один раз; «Отменить» — ничего, кнопки скрыты; «Вернуть» после отмены = выпуск.
  // Копии «AF тест: …» и сцена создаются и удаляются сценарием. Параметры: window.__afCS = { only, skip, cleanOnly }. Результат — window.__afCSResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afCS ?? {}) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let cur = null;
  const waitFor = async (fn, ms = 8000, step = 150) => {
    const end = Date.now() + ms, env = cur;
    while (Date.now() < end) { if (!env || env.dead) return null; try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(step); }
    return null;
  };
  class Skip extends Error {}
  const bound = (label, p, ms = 30000) => {
    let tm;
    return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`завис шаг «${label}» (>${ms / 1000} с)`)), ms); })]).finally(() => clearTimeout(tm));
  };
  const DEG = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });
  const api = () => game.modules.get(MOD).api;
  const setting = (k) => game.settings.get(MOD, k);

  // ---------- уборка ----------
  const killCombat = async (c) => { for (let i = 0; i < 3 && game.combats.has(c.id); i++) { await game.combats.get(c.id).delete().catch(() => {}); if (game.combats.has(c.id)) await wait(800); } };
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name) || test(game.scenes.get(x.sceneId)?.name)))) await killCombat(c);
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const sceneIds = new Set(scenes.map((s) => s.id));
    const ids = [...new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene)).map((m) => m.id)])].filter((id) => game.messages.has(id));
    for (const s of scenes) if (s.regions.size) await s.deleteEmbeddedDocuments("Region", s.regions.map((r) => r.id)).catch(() => {});
    if (ids.length) await ChatMessage.deleteDocuments(ids).catch(() => {});
    for (const s of scenes) await s.delete().catch(() => {});
    for (const a of game.actors.filter((a) => test(a.name))) await a.delete().catch(() => {});
    return game.actors.filter((a) => test(a.name)).length + game.scenes.filter((s) => test(s.name)).length;
  };
  if (opts.cleanOnly) return { left: await sweep() };

  // ---------- окружение прогона ----------
  const prevScene = game.scenes.viewed, prevCombat = game.combats.viewed;
  const pfSet = game.user.flags.pf2e?.settings ?? {};
  const origFlags = { showCheckDialogs: pfSet.showCheckDialogs, showDamageDialogs: pfSet.showDamageDialogs };
  const tbPrev = game.settings.get(MOD, "useToolbeltTargetHelper");
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  const ceOrig = console.error;
  console.error = function (...a) { const er = a.find((x) => x instanceof Error); if (er) notes.push(`console.error: ${String(a[0]).slice(0, 80)} ${String(er.stack ?? er.message).replace(/\s+/g, " ").slice(0, 500)}`); return ceOrig.apply(this, a); };
  const onErr = (ev) => { const er = ev.error ?? ev.reason; notes.push(`uncaught: ${String(er?.stack ?? er?.message ?? ev.message).replace(/\s+/g, " ").slice(0, 500)}`); };
  window.addEventListener("error", onErr); window.addEventListener("unhandledrejection", onErr);
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));

  const idx = {};
  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    idx[pack] ??= await p.getIndex({ fields: ["system.slug"] });
    const e = idx[pack].find((i) => i.system?.slug === slug);
    if (!e) throw new Skip(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(e._id)).toObject();
  };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), answers: [], stop: false, d20: null };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна модуля: ответ из e.answers (число действий и т. п.), иначе закрыть; окна бросков pf2e — «Бросок»
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          const sel = el.querySelector("select[name=choice]"), want = e.answers.length ? e.answers.shift() : null;
          const o = sel && want != null ? [...sel.options].find((x) => x.value === String(want) || x.textContent.toLowerCase().includes(String(want).toLowerCase())) : null;
          const btn = !sel && want != null ? el.querySelector(`button[data-action='${want}']`) : null;   // окно ГМа (sharedDialog) — кнопки вариантов, не список
          if (o) { sel.value = o.value; el.querySelector("button[data-action=ok]")?.click(); } else if (btn) btn.click(); else foundry.applications.instances.get(el.id)?.close();
        }
        for (const app of [...Object.values(globalThis.ui?.windows ?? {}), ...foundry.applications.instances.values()]) {
          const aid = app.appId ?? app.id;
          if (seen.has(aid) || !/damage|modifiers|урон|check/i.test(`${app.constructor.name} ${app.title}`)) continue;
          seen.add(aid);
          const root = app.element?.[0] ?? app.element, bs = root?.querySelectorAll?.("button");
          (root?.querySelector?.("button.roll") ?? bs?.[bs.length - 1])?.click();
        }
        await wait(150);
      }
    })();
    const live = () => { if (e.dead) throw new Error("сценарий остановлен"); };
    e.add = (data) => live() ?? Actor.create({ folder: game.folders.find((f) => f.type === "Actor" && f.name === "Тестовые копии (автоматизация)")?.id ?? null, ownership: { default: 0 }, ...data, name: PFX + data.name });
    e.foe = async (name) => { const a = await e.add({ ...(await fromUuid(GOBLIN)).toObject(), name }); await a.update({ "system.attributes.hp.value": a.hitPoints.max }); return a; };
    e.give = (a, ...docs) => live() ?? a.createEmbeddedDocuments("Item", docs);
    e.tok = async (a, x, y, disposition) => { live(); const [t] = await e.scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition }]); return t; };
    e.T = (t) => e.scene.tokens.get(t.id);
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;
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
    };
    e.since = () => Date.now();
    e.msgs = (t0) => game.messages.contents.filter((m) => m._stats.createdTime >= t0);
    e.dom = (m) => document.querySelector(`#chat [data-message-id="${m?.id}"]`);
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.gate = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.gate ?? {};
    e.dispose = async () => {
      e.dead = true; e.stop = true;
      await wait(2500);
      if (prevScene && prevScene.id !== e.scene.id && game.scenes.has(prevScene.id)) { await prevScene.view().catch(() => {}); await wait(1000); }
      Hooks.off("createChatMessage", hook);
      try { await e.fix(null); } catch { /* ok */ }
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      document.querySelectorAll(".paf-dialog").forEach((el) => foundry.applications.instances.get(el.id)?.close());
      return sweep([...e.tracked]);
    };
    return e;
  };

  // ---------- общие шаги ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const victim = async (e, name) => { const a = await e.foe(name); await a.update({ "system.details.alliance": "party" }); return a; };
  const rigSave = async (e, G, stat, dc, deg) => {
    for (const i of G.itemTypes.effect.filter((i) => i.slug === "af-rig")) await i.delete();
    await e.rig(G, stat, dc + ({ criticalSuccess: 0, success: -10, failure: -11, criticalFailure: -20 })[deg] - G.saves[stat].mod);
  };
  /** NPC-заклинатель с врождённой записью и заклинанием slug (опционально — правило модуля в флаге). -> {A0, sp0, entry} */
  const caster = async (e, slug, rule = null) => {
    const A0 = await e.foe("заклинатель");
    const [entry] = await e.give(A0, { type: "spellcastingEntry", name: "AF", system: { ability: { value: "cha" }, spelldc: { value: 0, dc: 20 }, tradition: { value: "arcane" }, prepared: { value: "spontaneous" }, slots: Object.fromEntries([1, 2, 3, 4, 5].map((r) => [`slot${r}`, { max: 5, value: 5 }])) } });   // спонтанная с ячейками: врождённое — один каст в день
    const d = await find("pf2e.spells-srd", slug); d.system.location = { value: entry.id };
    if (rule) { const v = api().validateRule(rule); if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`); d.flags = { ...d.flags, [MOD]: { ...d.flags?.[MOD], rule } }; }
    const [sp0] = await e.give(A0, d);
    return { A0, sp0, entry };
  };
  /** Следующая карточка сотворения этого заклинания рождается удержанной (как поставит диспетчер M4 в onPreCreate). hold=false — обычная. */
  /** Карточка сотворения (не «в чат»): context.type "spell-cast" pf2e ставит только заклинаниям со спасброском, признак — cast-a-spell в origin. */
  const isCast = (m, sp) => m.flags?.pf2e?.origin?.uuid === sp.uuid && !!m.flags.pf2e.origin.rollOptions?.includes("origin:action:slug:cast-a-spell");
  const castCard = async (e, ent, sp, rank, hold) => {
    const t0 = e.since();
    const h = hold ? Hooks.on("preCreateChatMessage", (m) => { if (isCast(m, sp)) { api().markCounterHold(m); Hooks.off("preCreateChatMessage", h); } }) : null;
    try { await bound("cast", ent.cast(sp, { rank, message: true })); } finally { if (h) Hooks.off("preCreateChatMessage", h); }
    return waitFor(() => e.msgs(t0).find((x) => isCast(x, sp)), 8000);
  };
  const region = async (e, m, x, y, r) => (await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#00aa55", shapes: [{ type: "circle", hole: false, x, y, radius: r }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: "burst", origin: { uuid: m.item?.uuid, type: m.item?.type, actor: m.actor?.uuid, token: m.token?.uuid } } } }]))[0];
  /** Что в DOM карточки видно из кнопок (после скрытия классом). Плашка .paf-hold не считается. */
  const visibleButtons = (e, m) => {
    const root = e.dom(m);
    if (!root) return ["нет DOM"];
    return [...root.querySelectorAll(".card-buttons button, .message-buttons button, .spell-button button, .paf-damage-box button, .paf-area-box button, .paf-maneuver-box button, .pf2e-automato button, [data-action=spell-damage], [data-action=spell-save], [data-action=spell-template]")]
      .filter((b) => !b.closest(".paf-hold") && b.offsetParent !== null).map((b) => b.dataset.action || b.textContent.trim());
  };
  const plaqueBtn = (e, m, which) => e.dom(m)?.querySelector(`.paf-hold button[data-hold=${which}]`);
  const saveMsgs = (e, t0) => e.msgs(t0).filter((x) => x.flags?.pf2e?.context?.type === "saving-throw");
  const dmgMsgs = (e, t0, uuid) => e.msgs(t0).filter((x) => x.flags?.pf2e?.context?.type === "damage-roll" && x.flags?.pf2e?.origin?.uuid === uuid);

  // ---------- сценарии ----------
  const fireballSetup = async (e) => {
    const { A0, sp0, entry } = await caster(e, "fireball"), V1 = await victim(e, "жертва 1"), V2 = await victim(e, "жертва 2");
    const tA = await e.tok(A0, 600, 1000, -1), t1 = await e.tok(V1, 1300, 1000, 1), t2 = await e.tok(V2, 1300, 1200, 1);   // заклинатель вне собственного шара (r 400 от 1300,1100)
    await wait(900);
    await rigSave(e, e.A(t1), "reflex", 20, "failure"); await rigSave(e, e.A(t2), "reflex", 20, "success");
    await e.fix(10); await e.aim(tA);
    return { tA, t1, t2, sp: e.A(tA).items.get(sp0.id), ent: e.A(tA).items.get(entry.id) };
  };

  sc("fireball-release", "Огненный шар: удержано — ничего не исполняется и кнопок нет; «Выпустить» — область, спасброски обеих целей ровно один раз", async (e, t) => {
    openChat();
    const { t1, t2, sp, ent } = await fireballSetup(e);
    const t0 = e.since(), hp1 = e.A(t1).hitPoints.value;
    const m = await castCard(e, ent, sp, 3, true);
    t.ok(!!m && e.gate(m).hold === "counter", `карточка удержана (${JSON.stringify(e.gate(m))})`);
    t.ok(m?.flags?.["xdy-pf2e-workbench"]?.noAutoDamageRoll === true || !game.modules.get("xdy-pf2e-workbench")?.active, "Workbench: noAutoDamageRoll");
    const r = await region(e, m, 1300, 1100, 400);   // шаблон поставлен, пока держится
    await wait(5000);
    t.ok(!e.use(m)?.state?.area && !Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length, `область/результаты не взяты (${JSON.stringify(e.use(m)?.state?.area)})`);
    t.ok(saveMsgs(e, t0).length === 0 && !e.use(m)?.state?.done, "спасбросков и исполнения нет");
    t.ok(e.A(t1).hitPoints.value === hp1 && dmgMsgs(e, t0, sp.uuid).length === 0, "урона нет");
    t.ok(e.dom(m)?.classList.contains("paf-counter-block"), "класс paf-counter-block на корне");
    const vis = visibleButtons(e, m);
    t.ok(vis.length === 0, `кнопки скрыты (${vis})`);
    if (game.modules.get("pf2e-toolbelt")?.active) t.ok([...(e.dom(m)?.querySelectorAll(".pf2e-toolbelt-target-targetRows") ?? [])].every((el) => el.offsetParent === null), "строки целей Toolbelt скрыты");
    else t.ok(true, "Toolbelt не активен — проверка строк пропущена");
    t.ok(!!plaqueBtn(e, m, "release") && !!plaqueBtn(e, m, "cancel"), "плашка: «Выпустить» и «Отменить»");
    plaqueBtn(e, m, "release")?.click();
    t.ok(await waitFor(() => (e.use(m)?.state?.area?.keys?.length ?? 0) >= 2, 12000), "после выпуска: цели области взяты (resumeRegion)");
    t.ok(await waitFor(() => Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length >= 2, 14000), "спасброски обеих целей");
    await wait(4000);
    t.ok(saveMsgs(e, t0).length === 2, `спасбросков ровно 2 (${saveMsgs(e, t0).length})`);
    t.ok(!e.dom(m)?.classList.contains("paf-counter-block") && !e.dom(m)?.querySelector(".paf-hold"), "класс и плашка сняты");
    t.ok(!!r, "регион был");
  });

  sc("fireball-cancel", "Огненный шар: «Отменить» — ничего, кнопки скрыты, плашка «Вернуть»; «Вернуть» — исполняется один раз", async (e, t) => {
    openChat();
    const { t1, sp, ent } = await fireballSetup(e);
    const t0 = e.since(), hp1 = e.A(t1).hitPoints.value;
    const m = await castCard(e, ent, sp, 3, true);
    t.ok(!!m && e.gate(m).hold === "counter", "удержана");
    (await waitFor(() => plaqueBtn(e, m, "cancel"), 6000))?.click();   // плашка дорисовывается после создания карточки
    t.ok(await waitFor(() => e.gate(m).cancelled === true && !e.gate(m).hold, 6000), `отменена (${JSON.stringify(e.gate(m))})`);
    await region(e, m, 1300, 1100, 400);
    await wait(5000);
    t.ok(!e.use(m)?.state?.area && saveMsgs(e, t0).length === 0 && !e.use(m)?.state?.done, "после отмены область, спасброски и исполнение не стартуют");
    t.ok(e.A(t1).hitPoints.value === hp1, "урона нет");
    t.ok(await waitFor(() => e.dom(m)?.classList.contains("paf-counter-block"), 4000), "класс paf-counter-block");
    t.ok(visibleButtons(e, m).length === 0, `кнопки скрыты (${visibleButtons(e, m)})`);
    t.ok(!!plaqueBtn(e, m, "release") && !plaqueBtn(e, m, "cancel"), "плашка: только «Вернуть»");
    plaqueBtn(e, m, "release")?.click();
    t.ok(await waitFor(() => Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length >= 2, 16000), "«Вернуть»: спасброски пошли");
    await wait(4000);
    t.ok(saveMsgs(e, t0).length === 2, `ровно один раз (${saveMsgs(e, t0).length} спасбросков)`);
  });

  sc("cancel-region", "Огненный шар: «Отменить» убирает мгновенный шаблон этого сотворения со сцены", async (e, t) => {
    openChat();
    const { sp, ent } = await fireballSetup(e);
    const m = await castCard(e, ent, sp, 3, true);
    t.ok(!!m && e.gate(m).hold === "counter", "удержана");
    const r = await region(e, m, 1300, 1100, 400);
    t.ok(!!r && e.scene.regions.has(r.id), "шаблон стоит");
    (await waitFor(() => plaqueBtn(e, m, "cancel"), 6000))?.click();
    t.ok(await waitFor(() => e.gate(m).cancelled === true, 6000), "отменена");
    t.ok(await waitFor(() => !e.scene.regions.has(r.id), 6000), "шаблон удалён");
  });

  sc("missiles", "Волшебная стрела (variable-cast): удержано — урона нет; «Выпустить» — снаряды бросаются один раз, столько же, сколько без удержания", async (e, t) => {
    openChat();
    const { A0, sp0, entry } = await caster(e, "force-barrage"), V1 = await victim(e, "цель");
    const tA = await e.tok(A0, 1000, 1000, -1), t1 = await e.tok(V1, 1200, 1000, 1);
    await wait(900);
    const sp = e.A(tA).items.get(sp0.id), ent = e.A(tA).items.get(entry.id);
    await e.aim(tA, t1);
    // эталон: без удержания
    e.answers.push("2");
    let t0 = e.since();
    const base = await castCard(e, ent, sp, 1, false);
    await waitFor(() => dmgMsgs(e, t0, sp.uuid).length >= 1, 15000);
    await wait(3000);
    const expected = dmgMsgs(e, t0, sp.uuid).length;
    t.ok(!!base && expected >= 1, `эталон без удержания: ${expected} бросков урона`);
    // с удержанием
    await e.aim(tA, t1);
    e.answers.push("2");
    t0 = e.since();
    const m = await castCard(e, ent, sp, 1, true);
    t.ok(!!m && e.gate(m).hold === "counter", "удержана");
    t.ok(await waitFor(() => game.messages.get(m.id)?.flags?.[MOD]?.cast?.actions === 2, 8000), "число действий выбрано (окно осталось)");
    t.ok(await waitFor(() => game.messages.get(m.id)?.flags?.[MOD]?.cast?.missilesHeld === true, 5000), "снаряды отложены (missilesHeld)");
    await wait(3000);
    t.ok(dmgMsgs(e, t0, sp.uuid).length === 0, "урона нет, пока удержано");
    t.ok(visibleButtons(e, m).length === 0, `кнопки скрыты (${visibleButtons(e, m)})`);
    plaqueBtn(e, m, "release")?.click();
    t.ok(await waitFor(() => dmgMsgs(e, t0, sp.uuid).length >= expected, 15000), "после выпуска снаряды брошены");
    await wait(4000);
    t.ok(dmgMsgs(e, t0, sp.uuid).length === expected, `ровно один раз: ${dmgMsgs(e, t0, sp.uuid).length} из ${expected}`);
    t.ok(game.messages.get(m.id)?.flags?.[MOD]?.cast?.missilesHeld === false, "отметка снята");
  });

  sc("use-apply", "Заклинание с onUse.apply: удержано — эффекта нет; «Отменить» — нет и после; «Вернуть» — состояние наложено", async (e, t) => {
    openChat();
    const rule = { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "frightened", value: 1 } }] } };
    const { A0, sp0, entry } = await caster(e, "sure-strike", rule);
    const tA = await e.tok(A0, 1000, 1000, -1);
    await wait(900);
    const sp = e.A(tA).items.get(sp0.id), ent = e.A(tA).items.get(entry.id);
    const cnd = () => e.A(tA).itemTypes.condition.find((c) => c.slug === "frightened")?.value ?? 0;
    await e.aim(tA);
    const m = await castCard(e, ent, sp, 1, true);
    t.ok(!!m && !!(await waitFor(() => e.use(m), 6000)), "карточка со снимком use");
    await wait(4000);
    t.ok(cnd() === 0 && !e.use(m)?.state?.done, `эффект не наложен (${cnd()})`);
    (await waitFor(() => plaqueBtn(e, m, "cancel"), 6000))?.click();   // плашка дорисовывается после создания карточки
    t.ok(await waitFor(() => e.gate(m).cancelled === true, 6000), "отменена");
    await wait(4000);
    t.ok(cnd() === 0 && !e.use(m)?.state?.done, "после отмены эффекта нет");
    plaqueBtn(e, m, "release")?.click();
    t.ok(await waitFor(() => cnd() === 1, 10000), `«Вернуть»: испуг 1 (${cnd()})`);
    await wait(3000);
    t.ok(cnd() === 1 && e.A(tA).itemTypes.condition.filter((c) => c.slug === "frightened").length === 1, "ровно один раз");
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  const applyPrev = setting("mode.apply");
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);
    if (applyPrev !== "auto") await game.settings.set(MOD, "mode.apply", "auto");
    for (const s of pick) {
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0;
      try {
        e = await newEnv(s.id); cur = e;
        const run = s.run(e, t); run.catch(() => {});
        let timer;
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("таймаут 170 с")), 170000); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} counterspell | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
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
    if (prevCombat) { try { await ui.combat.initialize({ combat: prevCombat }); } catch { /* ok */ } }
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afCSResult = out;
  return out;
}
