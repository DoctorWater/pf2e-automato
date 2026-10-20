async () => {
  // Харнесс pf2e-automato (plan.md §9). Вставить в консоль ГМа как есть: (async () => {...})() либо как выражение-функцию и вызвать.
  // Только временные актёры/сцена/макросы; игроков и их персонажей не трогает (отпечаток playersUntouched), чужие сообщения не удаляет. Сценарии с заглушками -> skipped.
  const MOD = "pf2e-automato";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const report = { module: null, warnings: [], rows: [], steps: [], errors: [], summary: null, cleanup: null };
  const step = (name, data = {}) => report.steps.push({ name, ...data });
  const add = (scenario, check, expected, actual, pass) => report.rows.push({ scenario, check, expected, actual, pass });
  const eq = (sn, check, expected, actual) => add(sn, check, expected, actual, JSON.stringify(expected) === JSON.stringify(actual));
  const ok = (sn, check, cond, actual = cond) => add(sn, check, true, actual, !!cond);
  const skip = (sn, why) => add(sn, "—", "—", why, "skipped");

  const waitFor = async (fn, { timeout = 10000, label = "" } = {}) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ }
      await wait(100);
    }
    step("timeout", { label });
    return null;
  };

  const mod = game.modules.get(MOD);
  const api = mod?.api;
  report.module = { active: !!mod?.active, version: mod?.version, api: api ? Object.keys(api).length : 0 };
  const protos = game.modules.contents.filter((m) => m.active && m.id.startsWith("pf2e-autoflow-proto")).map((m) => m.id);
  if (protos.length) report.warnings.push(`активны прототипы ${protos.join(", ")}: прогон недействителен`);
  if (!mod?.active || !api) { report.errors.push("модуль pf2e-automato не активен или нет api"); return report; }

  // --- заглушки: сценарии, зависящие от неготовых кусков, помечаются skipped ---
  const isStub = (f) => typeof f !== "function" || /throw new Error\(["'`]not implemented/.test(Function.prototype.toString.call(f));
  const stub = {
    use: isStub(api.runUse) || isStub(api.runRegion),
    saves: isStub(api.runChallenge) || isStub(api.recordResult) || isStub(api.applyByDegree),
    zone: isStub(api.attachZone) || isStub(api.sweepZone) || isStub(api.closeZone) || isStub(api.expireZones),
    macros: isStub(api.runMacros),
    reactions: isStub(api.onAttackMessage) || isStub(api.useReaction)
  };
  report.stubs = Object.entries(stub).filter(([, v]) => v).map(([k]) => k);

  // --- перехват ошибок ---
  const errs = [];
  const onErr = (e) => errs.push(String(e?.reason ?? e?.message ?? e).slice(0, 300));
  window.addEventListener("error", onErr); window.addEventListener("unhandledrejection", onErr);
  const origConsoleError = console.error;
  console.error = (...a) => {
    const s = a.map((x) => String(x?.stack ?? x?.message ?? x)).join(" ");
    if (/pf2e-automato/.test(s) && !/TokenMagic is not defined/.test(s)) errs.push(s.slice(0, 300));
    origConsoleError.apply(console, a);
  };

  // --- отпечаток игроков и настройки для отката ---
  const fingerprint = () => JSON.stringify(game.actors.filter((a) => a.hasPlayerOwner).map((a) => [a.id, a._stats.modifiedTime]).sort());
  const fpBefore = fingerprint();
  const SETTINGS = ["useToolbeltTargetHelper", "yieldToAutomations", "mode.zone", "mode.effect", "mode.challenge", "mode.apply", "mode.reaction", "mode.macro", "reaction.onlyWhenChanges"];
  const savedSettings = Object.fromEntries(SETTINGS.map((k) => [k, game.settings.get(MOD, k)]));
  const setS = (k, v) => game.settings.set(MOD, k, v);
  await setS("useToolbeltTargetHelper", false);   // восстанавливается в уборке; режим Toolbelt проверяет S14

  // уборка сообщений — только созданных этим клиентом за прогон (не чужие и не прочие ГМа)
  const createdMsgs = new Set();
  const msgHook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id && m._stats.createdTime >= t0) createdMsgs.add(m.id); });
  const prevScene = game.scenes.viewed;
  const actors = [], macros = [], worldKeys = [];
  let scene;

  // --- хелперы ---
  const conds = (a) => a.items.filter((i) => ["condition", "effect"].includes(i.type))
    .map((i) => `${i.type}:${i.system.slug ?? i.name}${i.flags?.[MOD]?.meta ? "*" + i.flags[MOD].meta.key : ""}`);
  const ours = (a) => a.items.filter((i) => i.flags?.[MOD]?.meta);
  const has = (a, slug, type = null) => a.items.some((i) => (!type || i.type === type) && (i.system.slug ?? "") === slug);
  const cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug);
  const tokOf = (td) => scene.tokens.get(td.id);
  const useOf = (m) => game.messages.get(m.id)?.flags?.[MOD]?.use;
  const ourCount = (list) => list.reduce((n, a) => n + ours(a).length, 0);
  const setVal = (el, v) => { if (el.type === "checkbox") el.checked = !!v; else el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  const clicked = [];
  // Только кнопки модуля (.pf2e-automato button[data-action]); кнопки карточек pf2e не трогаем.
  const click = async (msg, actions) => {
    const done = [];
    for (const act of actions) {
      const el = document.querySelector(`[data-message-id="${msg.id}"]`);
      for (const b of [...(el?.querySelectorAll(`.pf2e-automato button[data-action="${act}"]:not([disabled])`) ?? [])]) {
        b.click(); done.push(act); await wait(1200);
      }
    }
    clicked.push(...done);
    return done;
  };
  const stripOurs = async (list) => { for (const a of list) { const ids = ours(a).map((i) => i.id); if (ids.length) await a.deleteEmbeddedDocuments("Item", ids); } };

  try {
    // ================= подготовка =================
    scene = await Scene.create({ name: "AF Test", width: 2000, height: 1500, padding: 0, grid: { size: 100, distance: 5 }, tokenVision: false, navigation: false });
    await scene.view(); await wait(1500);
    try { await ui.sidebar?.activateTab?.("chat"); } catch { /* вкладка чата не критична */ }

    const mc = game.packs.get("pf2e.pathfinder-monster-core");
    const mk = async (id, label) => { const d = (await mc.getDocument(id)).toObject(); delete d._id; d.name = `AF ${label}`; d.folder = null; const a = await Actor.create(d); actors.push(a); return a; };
    const pyro = await mk("Ky5eNRvN71O0tY9l", "Поджигатель"), w1 = await mk("fLLKuOXwPq1Iq0U4", "Боец 1"), w2 = await mk("fLLKuOXwPq1Iq0U4", "Боец 2");
    const liarel = await Actor.create({ name: "AF Тест", type: "character", folder: null, ownership: { default: 0 } }); actors.push(liarel);
    const nimble = (await game.packs.get("pf2e.feats-srd").getDocument("dNH8OHEvx3vI9NBQ")).toObject(); delete nimble._id;
    await liarel.createEmbeddedDocuments("Item", [nimble]);
    const eqPack = game.packs.get("pf2e.equipment-srd");
    const eqIdx = await eqPack.getIndex({ fields: ["system.slug"] });
    const addEq = async (slug) => { const e = eqIdx.find((i) => i.system?.slug === slug); const d = await eqPack.getDocument(e._id); const [it] = await liarel.createEmbeddedDocuments("Item", [d.toObject()]); return it; };
    let smoke = await addEq("smoke-ball-lesser");
    const brew = await addEq("bravos-brew-lesser");
    // эффект для S9/S10 (без ChoiceSet)
    const findEffect = async () => {
      const ep = game.packs.get("pf2e.equipment-effects");
      const idx = await ep.getIndex({ fields: ["system.slug", "system.rules", "type"] });
      // только эффект БЕЗ ChoiceSet: иначе pf2e открывает окно выбора и S9/S10 виснут на ответе ГМа
      const plain = idx.filter((i) => i.type === "effect" && !(i.system?.rules ?? []).some((r) => r.key === "ChoiceSet"));
      const e = plain.find((i) => /spiderfoot|brew|bravo|брав/i.test(i.name)) ?? plain[0];
      return e ? { id: e._id, uuid: `Compendium.pf2e.equipment-effects.Item.${e._id}`, name: e.name } : null;
    };
    const clearEff = async (uuid) => { const ids = liarel.itemTypes.effect.filter((i) => i._stats.compendiumSource === uuid).map((i) => i.id); if (ids.length) await liarel.deleteEmbeddedDocuments("Item", ids); };
    // считаем только эффекты с нашим meta: тот же эффект может поставить pf2e-automations (напр. после S6); чужие — в step для диагностики
    const effCount = (uuid) => liarel.itemTypes.effect.filter((i) => i._stats.compendiumSource === uuid && i.flags?.[MOD]?.meta).length;
    const foreignEff = (sn, uuid) => { const f = liarel.itemTypes.effect.filter((i) => i._stats.compendiumSource === uuid && !i.flags?.[MOD]?.meta); if (f.length) step("foreign-effect", { sn, n: f.length, flags: f.map((i) => Object.keys(i.flags ?? {})) }); };
    const place = async (actor, cx, cy) => { const td = await actor.getTokenDocument({ x: cx * 100, y: cy * 100 }, { parent: scene }); const [t] = await scene.createEmbeddedDocuments("Token", [td.toObject()]); return t; };
    const tL = await place(liarel, 5, 5), tW1 = await place(w1, 10, 5), tW2 = await place(w2, 11, 6), tP = await place(pyro, 13, 5);
    await wait(1500);
    const A1 = () => tokOf(tW1).actor, A2 = () => tokOf(tW2).actor, AP = () => tokOf(tP).actor;
    const bf = pyro.items.find((i) => i.system.slug === "breathe-fire");
    step("setup", { tokens: scene.tokens.map((t) => t.name), stubs: report.stubs });

    // Персонажей игроков и владение игроку не трогаем: PC-бросок — только ручной чек-лист (README)

    const shot = { circle: (x, y, r) => ({ type: "circle", radius: r, x, y }), cone: (x, y) => ({ type: "cone", radius: 350, angle: 90, rotation: 180, x, y }) };
    // Путь A (inline @Template, pf2e:28795) / путь B (placeRegionFromItem, pf2e:3379)
    const regionData = (path, item, shape, areaShape, messageId) => ({
      name: item.name, shapes: [shape], color: "#ff6600", highlightMode: "coverage", displayMeasurements: true,
      visibility: CONST.REGION_VISIBILITY.ALWAYS,
      ...(path === "B" && { ownership: { [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } }),
      flags: { pf2e: { areaShape, messageId, origin: path === "B" ? { name: item.name, slug: item.slug, traits: [...(item.traits ?? [])], ...item.getOriginData() } : item.getOriginData() } }
    });
    const mkRegion = async (path, item, shape, areaShape, msg) => { const [r] = await scene.createEmbeddedDocuments("Region", [regionData(path, item, shape, areaShape, msg?.id)]); return r; };
    const cardMsg = async (item, extra) => {
      const m = await item.toMessage(undefined, { create: true, ...extra });
      const use = await waitFor(() => useOf(m), { label: `use flag ${item.name}` });
      return { m, use };
    };
    const clearRegions = async () => { const ids = scene.regions.map((r) => r.id); if (ids.length) await scene.deleteEmbeddedDocuments("Region", ids); await wait(800); };
    const castBF = async (item = bfx) => cardMsg(item, { actualCast: true, data: { castRank: item.rank } });

    // Временная копия предмета со своим slug и флагом-правилом (чтобы не пересекаться с pf2e-automations)
    const copyWith = async (owner, src, slug, rule, extra = {}) => {
      const d = src.toObject(); delete d._id; d._stats = {}; d.name = `AF ${slug}`; d.system.slug = slug;
      d.flags = { ...d.flags, [MOD]: { rule } }; Object.assign(d, extra);
      const [it] = await owner.createEmbeddedDocuments("Item", [d]); return it;
    };
    const sc = async (name, need, fn) => {
      const miss = need.filter((n) => stub[n]);
      if (miss.length) { skip(name, `заглушки: ${miss.join(", ")}`); return; }
      try { await fn(name); }
      catch (e) { add(name, "исключение", "нет", String(e?.stack ?? e).slice(0, 400), false); }
      try { await clearRegions(); await stripOurs([A1(), A2(), AP(), liarel]); } catch { /* уборка между сценариями */ }
      for (const t of canvas.tokens?.placeables ?? []) t.setTarget?.(false, { releaseOthers: false, groupSelection: true });
    };

    // breathe-fire покрыт pf2e-automations -> копия со своим slug и правилом из каталога с yield:false
    const bfRule = foundry.utils.deepClone(api.resolveRule({ item: bf })?.rule ?? {}); bfRule.yield = false;
    const bfx = await copyWith(pyro, bf, "af-test-bf", bfRule);

    // ================= S0: вкладка (K6) =================
    await sc("0 вкладка", [], async (S) => {
      const [it] = await liarel.createEmbeddedDocuments("Item", [{ type: "action", name: "AF sheet", system: { slug: "af-test-sheet", description: { value: "<p>test</p>" } } }]);
      worldKeys.push({ slug: "af-test-sheet" });
      await it.sheet.render(true);
      const sec = () => it.sheet.element?.[0]?.querySelector(".tab.automato");
      ok(S, "вкладка вставлена", await waitFor(sec, { label: "tab" }));
      it.sheet.element[0].querySelector('nav.sheet-tabs a[data-tab="automato"]').click();
      ok(S, "вкладка активна после клика", sec().classList.contains("active"));
      setVal(sec().querySelector('[data-f="label"]'), "AF draft");
      await it.sheet.render(); await wait(800);
      await waitFor(() => sec()?.querySelector('[data-f="label"]'), { label: "tab after rerender" });
      ok(S, "активна после ре-рендера", sec()?.classList.contains("active"));
      eq(S, "черновик пережил ре-рендер", "AF draft", sec()?.querySelector('[data-f="label"]')?.value);
      // правило: применить состояние себе + макрос
      const s = sec();
      setVal(s.querySelector('[data-f="kind"]'), "onUse");   // по умолчанию "none": без onUse строки apply в правило не попадают
      s.querySelector('[data-action="add-row"][data-list="apply"]').click();
      const row = s.querySelector('.af-rows[data-list="apply"] .af-row');
      setVal(row.querySelector('[data-r="to"]'), "self"); setVal(row.querySelector('[data-r="text"]'), "frightened"); setVal(row.querySelector('[data-r="value"]'), 1);
      s.querySelector('[data-action="add-row"][data-list="macros"]').click();
      const mrow = s.querySelector('.af-rows[data-list="macros"] .af-row');
      setVal(mrow.querySelector('[data-r="uuid"]'), "Macro.AFTEST000000000"); setVal(mrow.querySelector('[data-r="phase"]'), "afterChallenge");
      s.querySelector('[data-action="save-world"][data-scope="slug"]').click();
      const cat = await waitFor(() => game.settings.get(MOD, "catalog").bySlug?.["af-test-sheet"], { label: "world rule" });
      eq(S, "мировой каталог по slug (через callGM)", ["frightened", "Macro.AFTEST000000000"], [cat?.onUse?.apply?.[0]?.condition?.slug, cat?.macros?.[0]?.uuid]);
      sec().querySelector('[data-action="save-flag"]').click();
      const flag = await waitFor(() => it.flags?.[MOD]?.rule, { label: "flag rule" });
      eq(S, "флаг предмета", "Macro.AFTEST000000000", flag?.macros?.[0]?.uuid);
      await waitFor(() => sec()?.querySelector(".af-recognized"), { label: "tab after save" });
      ok(S, "блок «Распознано» показывает источник (флаг)", /флаг|flag/i.test(sec()?.querySelector(".af-recognized")?.textContent ?? ""));
      // невалидное правило не сохраняется: ошибки под формой
      setVal(sec().querySelector('[data-f="kind"]'), "none");
      sec().querySelector('.af-rows[data-list="macros"] [data-action="remove-row"]')?.click();
      sec().querySelector('[data-action="save-flag"]').click(); await wait(500);
      ok(S, "пустое правило отклонено с ошибкой", sec()?.querySelector(".af-errors li"));
      sec().querySelector('[data-action="reset-flag"]').click();
      ok(S, "сброс флага", await waitFor(() => !it.flags?.[MOD]?.rule, { label: "unset" }));
      await it.sheet.close();
      // предупреждение yield:false на покрытом предмете
      const groups = api.automationsGroups({ slug: brew.system.slug, sourceUuid: brew._stats.compendiumSource });
      if (!groups.length) skip(S, "pf2e-automations не покрывает бравую брагу");
      else {
        await brew.sheet.render(true);
        const bs = () => brew.sheet.element?.[0]?.querySelector(".tab.automato");
        await waitFor(bs, { label: "brew tab" });
        setVal(bs().querySelector('[data-f="yield"]'), "no");
        ok(S, "предупреждение при yield:false на покрытом", !bs().querySelector(".af-warn").hidden);
        setVal(bs().querySelector('[data-f="yield"]'), "yes");
        ok(S, "нет предупреждения при yield:true", bs().querySelector(".af-warn").hidden);
        await brew.sheet.close();
      }
      await it.delete();
    });

    // ================= S1: дымовая шашка — зона, оба пути =================
    await sc("1 зона (шашка)", ["use", "zone"], async (S) => {
      for (const path of ["A", "B"]) {
        const sn = `${S} путь ${path}`;
        await tokOf(tW1).update({ x: 1000, y: 500 }); await wait(800);
        const { m, use } = await cardMsg(smoke);
        ok(sn, "снимок записан автором", use);
        const reg = await mkRegion(path, smoke, shot.circle(1050, 550, 150), "burst", m);
        const both = await waitFor(() => has(A1(), "concealed", "condition") && has(A2(), "concealed", "condition"), { timeout: 12000, label: "concealed both" });
        ok(sn, "оба бойца concealed", both, { w1: conds(A1()), w2: conds(A2()) });
        ok(sn, "состояние с нашим meta.key zone:", ours(A1()).some((i) => i.flags[MOD].meta.key.startsWith("zone:")), conds(A1()));
        await api.sweepZone(reg); await api.sweepZone(reg);
        eq(sn, "двойной sweepZone не плодит документы", 2, ours(A1()).length + ours(A2()).length);
        await tokOf(tW1).update({ x: 300, y: 1200 });
        ok(sn, "вышел из зоны -> снято", await waitFor(() => !has(A1(), "concealed", "condition"), { timeout: 8000, label: "w1 left" }) && has(A2(), "concealed", "condition"));
        await reg.delete();
        ok(sn, "зона удалена -> снято у всех", await waitFor(() => !has(A2(), "concealed", "condition"), { timeout: 8000, label: "zone deleted" }));
      }
      await tokOf(tW1).update({ x: 1000, y: 500 }); await wait(800);
    });

    // ================= S2: огненное дыхание — конус, испытание, идемпотентность =================
    await sc("2 дыхание (конус, испытание)", ["use", "saves", "zone"], async (S) => {
      await tokOf(tW1).update({ x: 1000, y: 500 }); await wait(800);
      const { m, use } = await castBF();
      ok(S, "снимок на карточке заклинания", use);
      const cone = await mkRegion("B", bfx, shot.cone(1350, 550), "cone", m);
      const keysOk = await waitFor(() => { const k = useOf(m)?.state?.area?.keys ?? []; return k.includes(tW1.id) && k.includes(tW2.id); }, { timeout: 12000, label: "area keys" });
      ok(S, "state.area.keys содержит обоих бойцов", keysOk, useOf(m)?.state?.area?.keys);
      const res = await waitFor(() => { const r = useOf(m)?.state?.challenge?.results ?? {}; return r[tW1.id] && r[tW2.id] && r; }, { timeout: 15000, label: "NPC results" });
      ok(S, "результаты NPC без нажатий", res, Object.keys(useOf(m)?.state?.challenge?.results ?? {}));
      const txt = document.querySelector(`[data-message-id="${m.id}"] .pf2e-automato`)?.textContent ?? "";
      ok(S, "множитель урона в блоке", /[×x]\s?(0|½|1|2|0[.,]5)/i.test(txt), txt.replace(/\s+/g, " ").slice(0, 120));
      // идемпотентность (§9-12)
      const before = JSON.stringify(useOf(m)?.state?.challenge), cnt = ourCount([A1(), A2()]);
      await api.runUse(m.id); await api.runUse(m.id); await wait(1500);
      eq(S, "повторный runUse не меняет результаты", before, JSON.stringify(useOf(m)?.state?.challenge));
      eq(S, "повторный runUse не плодит документы", cnt, ourCount([A1(), A2()]));
      skip(S, "PC-бросок: ручной чек-лист (README, клиент игрока) — харнесс персонажей игроков не создаёт");
      await cone.delete(); await wait(800);
    });

    // ================= S3: расходник с областью =================
    await sc("3 расходник с областью", ["use", "zone"], async (S) => {
      const origin = smoke.getOriginData();
      const holder = { name: smoke.name, slug: smoke.slug, traits: [...smoke.traits], ...origin };
      await smoke.consume();
      const m = await waitFor(() => game.messages.contents.findLast((x) => x._stats.createdTime >= t0 && x.flags?.[MOD]?.use?.slug === "smoke-ball-lesser"), { label: "consume msg" });
      ok(S, "consume-снимок есть", m, m?.flags?.[MOD]?.use?.state);
      eq(S, "state.awaitingRegion", true, !!m?.flags?.[MOD]?.use?.state?.awaitingRegion);
      const [reg] = await scene.createEmbeddedDocuments("Region", [{ ...regionData("B", { name: holder.name, slug: holder.slug, traits: [], getOriginData: () => origin }, shot.circle(1050, 550, 150), "burst", m.id) }]);
      ok(S, "зона из карточки исполнена", await waitFor(() => has(A2(), "concealed", "condition"), { timeout: 12000, label: "zone from consume" }));
      await wait(1500);
      eq(S, "ровно один concealed у бойца", 1, A2().itemTypes.condition.filter((c) => c.slug === "concealed").length);
      eq(S, "ровно один наш документ у бойца", 1, ours(A2()).length);
      await reg.delete();
    });

    // ================= S4: переставленный шаблон =================
    await sc("4 переставленный шаблон", ["use", "saves", "zone"], async (S) => {
      await tokOf(tW1).update({ x: 1000, y: 500 }); await wait(800);
      const { m } = await castBF();
      const r1 = await mkRegion("B", bfx, shot.circle(1100, 550, 150), "burst", m);
      await waitFor(() => { const r = useOf(m)?.state?.challenge?.results ?? {}; return r[tW1.id] && r[tW2.id]; }, { timeout: 15000, label: "results 1" });
      const r2 = await mkRegion("B", bfx, shot.circle(1150, 650, 60), "burst", m);
      await waitFor(() => (useOf(m)?.state?.area?.keys ?? []).length === 1, { timeout: 10000, label: "keys replaced" });
      eq(S, "цели второго региона заменили первые", [tW2.id], useOf(m)?.state?.area?.keys);
      ok(S, "результат вне набора отброшен", !useOf(m)?.state?.challenge?.results?.[tW1.id], Object.keys(useOf(m)?.state?.challenge?.results ?? {}));
      ok(S, "первая зона закрыта", await waitFor(() => !scene.regions.get(r1.id) || useOf(m)?.state?.zone?.regionUuid !== r1.uuid, { timeout: 8000, label: "first closed" }));
      await clearRegions();
    });

    // ================= S5: истечение зоны =================
    await sc("5 истечение зоны", ["use", "zone"], async (S) => {
      smoke = await addEq("smoke-ball-lesser");   // S3 израсходовала прежнюю шашку
      const { m } = await cardMsg(smoke);
      const reg = await mkRegion("A", smoke, shot.circle(1150, 650, 100), "burst", m);
      ok(S, "зона создана", await waitFor(() => has(A2(), "concealed", "condition"), { timeout: 12000, label: "zone up" }));
      const b = reg.behaviors.contents.find((x) => x.type.includes("automato"));
      ok(S, "поведение зоны есть", b, reg.behaviors.map((x) => x.type));
      // время мира не трогаем: сдвигаем expiresAt в прошлое
      await b.update({ "system.expiresAt": game.time.worldTime - 1 });
      let e1 = null, e2 = null;
      try { await api.expireZones(); } catch (e) { e1 = String(e); }
      try { await api.expireZones(); } catch (e) { e2 = String(e); }
      eq(S, "expireZones дважды без ошибок", [null, null], [e1, e2]);
      ok(S, "состояние снято", await waitFor(() => !has(A2(), "concealed", "condition"), { timeout: 8000, label: "expired" }));
      ok(S, "регион удалён", await waitFor(() => !scene.regions.get(reg.id), { timeout: 8000, label: "region gone" }));
    });

    // ================= S6: бравая брага — уступка pf2e-automations =================
    await sc("6 брага (yield)", ["use"], async (S) => {
      const src = brew._stats.compendiumSource;
      if (!api.automationsCovers({ slug: brew.system.slug, sourceUuid: src })) { skip(S, "pf2e-automations не активен/не покрывает брагу"); return; }
      await brew.consume();
      const m = await waitFor(() => game.messages.contents.findLast((x) => x._stats.createdTime >= t0 && x.flags?.[MOD]?.use?.slug === "bravos-brew-lesser"), { label: "brew msg" });
      ok(S, "снимок есть", m);
      eq(S, "state.yielded", "pf2e-automations", m?.flags?.[MOD]?.use?.state?.yielded);
      await waitFor(() => liarel.itemTypes.effect.some((i) => i.system.slug?.startsWith("effect-bravos-brew")), { timeout: 12000, label: "brew effect by automations" });
      await wait(2500);
      eq(S, "ровно один effect-bravos-brew", 1, liarel.itemTypes.effect.filter((i) => i.system.slug?.startsWith("effect-bravos-brew")).length);
      eq(S, "у эффекта нет нашего meta", 0, ours(liarel).length);
      // дедуп при yield:false харнесс не обещает; предупреждение проверено в «0 вкладка»
    });

    // ================= S7: Frightful Presence =================
    await sc("7 Frightful Presence", ["use"], async (S) => {
      const gp = game.packs.get("pf2e.bestiary-ability-glossary-srd");
      const idx = await gp.getIndex({ fields: ["system.slug"] });
      const e = idx.find((i) => i.system?.slug === "frightful-presence");
      if (!e) { skip(S, "нет frightful-presence в пакете"); return; }
      const doc = (await gp.getDocument(e._id)).toObject(); delete doc._id;
      const [fp] = await pyro.createEmbeddedDocuments("Item", [doc]);
      canvas.tokens.setTargets([tW1.id, tW2.id]); await wait(500);
      if (!api.automationsCovers({ slug: "frightful-presence", sourceUuid: fp._stats.compendiumSource })) skip(`${S} yield`, "pf2e-automations не покрывает");
      else {
        const { use } = await cardMsg(fp);
        eq(`${S} yield`, "state.yielded", "pf2e-automations", use?.state?.yielded);
        await wait(3000);
        eq(`${S} yield`, "наших документов нет", 0, ourCount([A1(), A2()]));
        ok(`${S} yield`, "испытание не запускалось", !Object.keys(use?.state?.challenge?.results ?? {}).length);
      }
      // yield:false на копии с не покрытым slug: frightened по степеням, повторное «Применить» ничего не меняет
      if (stub.saves) { skip(`${S} yield:false`, "заглушки: saves"); return; }
      const rule = { v: 1, label: "AF fp", yield: false, onUse: { targets: "selected", zone: null, apply: [], challenge: { statistic: "will", dc: { value: 15 }, basic: false, rollerRole: "target",
        byDegree: { failure: [{ to: "target", condition: { slug: "frightened", value: 1, policy: "max" } }], criticalFailure: [{ to: "target", condition: { slug: "frightened", value: 2, policy: "max" } }] } } } };
      const cp = await copyWith(pyro, fp, "af-test-fp", rule);
      await stripOurs([A1(), A2()]);
      canvas.tokens.setTargets([tW1.id, tW2.id]); await wait(500);
      const sn = `${S} yield:false`;
      const { m, use } = await cardMsg(cp);
      ok(sn, "снимок без yielded", use && !use.state?.yielded);
      const res = await waitFor(() => { const r = useOf(m)?.state?.challenge?.results ?? {}; return r[tW1.id] && r[tW2.id] && r; }, { timeout: 15000, label: "fp results" });
      ok(sn, "результаты обоих", res, Object.keys(useOf(m)?.state?.challenge?.results ?? {}));
      await click(m, ["apply"]);
      await wait(2000);
      const want = (d) => ({ 0: 2, 1: 1 }[d] ?? null);
      const got = () => [tW1, tW2].map((t) => cond(tokOf(t).actor, "frightened")?.value ?? null);
      const exp = [tW1, tW2].map((t) => want(useOf(m)?.state?.challenge?.results?.[t.id]?.degree));
      eq(sn, "frightened по степеням", exp, got());
      const cnt = ourCount([A1(), A2()]);
      await click(m, ["apply"]); await wait(1500);
      eq(sn, "повторное «Применить» ничего не меняет", [cnt, exp], [ourCount([A1(), A2()]), got()]);
    });

    // ================= S8: макросы =================
    await sc("8 макросы", ["use", "saves", "macros", "zone"], async (S) => {
      globalThis.__afMacroLog = [];
      await setS("mode.apply", "auto");   // onDegree-макросы идут вместе с автоприменением
      const mkMacro = async (name, command) => { const mm = await Macro.create({ name: `AF ${name}`, type: "script", command }); macros.push(mm); return mm; };
      const log = (tag) => `(globalThis.__afMacroLog ??= []).push(["${tag}", scope.phase, scope.target?.name ?? null, scope.degree ?? null]);`;
      const mUse = await mkMacro("use", log("use")), mAfter = await mkMacro("after", log("after")), mDeg = await mkMacro("deg", log("deg"));
      const mThrow = await mkMacro("throw", `(globalThis.__afMacroLog ??= []).push(["throw"]); throw new Error("af-test throw");`);
      const rule = { v: 1, yield: false, onUse: { targets: "area", zone: null, apply: [], challenge: { statistic: "reflex", dc: { value: 15 }, basic: true, rollerRole: "target", byDegree: {} } },
        macros: [{ uuid: mUse.uuid, phase: "onUse" }, { uuid: mThrow.uuid, phase: "afterChallenge" }, { uuid: mAfter.uuid, phase: "afterChallenge" }, { uuid: mDeg.uuid, phase: "onDegree" }] };
      const cp = await copyWith(pyro, bf, "af-test-macros", rule);
      await tokOf(tW1).update({ x: 1000, y: 500 }); await wait(800);
      const { m } = await castBF(cp);
      const cone = await mkRegion("B", cp, shot.cone(1350, 550), "cone", m);
      await waitFor(() => { const r = useOf(m)?.state?.challenge?.results ?? {}; return r[tW1.id] && r[tW2.id]; }, { timeout: 15000, label: "macro results" });
      await waitFor(() => globalThis.__afMacroLog.some((x) => x[0] === "after"), { timeout: 8000, label: "after macro" });
      await click(m, ["apply"]); await wait(2500);
      const tags = globalThis.__afMacroLog.map((x) => x[0]);
      const n = (t) => tags.filter((x) => x === t).length;
      eq(S, "onUse ровно раз", 1, n("use"));
      eq(S, "afterChallenge ровно раз (после throw-макроса)", [1, 1], [n("throw"), n("after")]);
      eq(S, "onDegree по разу на цель", 2, n("deg"));
      await click(m, ["apply"]); await wait(1500);
      eq(S, "повторное «Применить» не вызывает макросы заново", [1, 1, 2], [n("use"), n("after"), globalThis.__afMacroLog.filter((x) => x[0] === "deg").length]);
      await setS("mode.apply", savedSettings["mode.apply"]);
      await cone.delete();
    });

    // ================= S9: низкоуверенное распознанное =================
    await sc("9 low-кнопка", ["use"], async (S) => {
      const eff = await findEffect();
      if (!eff) { skip(S, "в pf2e.equipment-effects нет ни одного эффекта"); return; }
      await clearEff(eff.uuid);   // мог остаться от S6 (ставит pf2e-automations)
      const [it] = await liarel.createEmbeddedDocuments("Item", [{ type: "action", name: "AF low", system: { slug: "af-test-low", description: { value: `<p>@UUID[${eff.uuid}]{Effect}</p>` } } }]);
      const { m, use } = await cardMsg(it);
      eq(S, "confidence", "low", use?.confidence);
      await wait(2500);
      eq(S, "исполнения нет", 0, effCount(eff.uuid)); foreignEff(S, eff.uuid);
      await click(m, ["apply-derived"]);
      ok(S, "после «Применить (распознано)» эффект есть", await waitFor(() => effCount(eff.uuid) > 0, { timeout: 8000, label: "derived effect" }));
      await click(m, ["apply-derived"]); await wait(1500);
      eq(S, "эффект ровно один", 1, effCount(eff.uuid));
    });

    // ================= S10: вне давности =================
    await sc("10 вне давности", ["use"], async (S) => {
      const eff = await findEffect();
      if (!eff) { skip(S, "в pf2e.equipment-effects нет ни одного эффекта"); return; }
      await clearEff(eff.uuid);
      const rule = { v: 1, yield: false, onUse: { targets: "self", zone: null, challenge: null, apply: [{ to: "self", effect: { uuid: eff.uuid } }] } };
      const [base] = await liarel.createEmbeddedDocuments("Item", [{ type: "action", name: "AF stale base", system: { slug: "af-test-stale-base" } }]);
      const it = await copyWith(liarel, base, "af-test-stale", rule);
      await setS("mode.effect", "auto");
      // готовый снимок kind:"card" (createChatMessage его не исполняет), затем kind:"use" и старый createdAt
      const mins = game.settings.get(MOD, "resumeMinutes");
      const snap = { v: 1, kind: "card", rule, src: "flag", confidence: "high", slug: "af-test-stale", sourceUuid: null,
        item: { uuid: it.uuid, name: it.name, type: "action", sourceId: null }, actor: liarel.uuid, token: tokOf(tL).uuid, dc: null, createdAt: Date.now(), targets: [], state: {} };
      const m = await ChatMessage.create({ content: "AF stale", speaker: ChatMessage.getSpeaker({ actor: liarel }), flags: { [MOD]: { use: snap } } });
      await m.update({ [`flags.${MOD}.use.kind`]: "use", [`flags.${MOD}.use.createdAt`]: Date.now() - (mins + 5) * 60000 });
      eq(S, "resumePending не берёт старый снимок", 0, await api.resumePending());
      await wait(2500);
      eq(S, "старый снимок не дозапущен автоматически", 0, effCount(eff.uuid)); foreignEff(S, eff.uuid);
      const done = await click(m, ["resume"]);
      ok(S, "кнопка «Дозапустить» есть и нажата", done.length > 0, done);
      ok(S, "после неё эффект применён", await waitFor(() => effCount(eff.uuid) > 0, { timeout: 8000, label: "resume effect" }));
      await wait(1500);
      eq(S, "эффект ровно один", 1, effCount(eff.uuid));
    });

    // ================= S11: «Ловкое уклонение» =================
    await sc("11 реакция", ["reactions"], async (S) => {
      await setS("reaction.onlyWhenChanges", false);   // чтобы любая попавшая атака давала подсказку, а не только меняющая исход
      const effBefore = liarel.itemTypes.effect.length;
      canvas.tokens.get(tW1.id)?.control({ releaseOthers: true });
      const strike = A1().system.actions.find((a) => a.type === "strike");
      let hint = null;
      for (let i = 0; i < 8 && !hint; i++) {
        canvas.tokens.setTargets([tL.id]); await wait(400);
        try { await Promise.race([strike.variants[0].roll({ event: new MouseEvent("click", { shiftKey: true }) }), wait(8000)]); } catch (e) { report.errors.push("strike: " + e.message); }
        hint = await waitFor(() => game.messages.contents.findLast((x) => x._stats.createdTime >= t0 && x.flags?.[MOD]?.reaction && !x.flags[MOD].reaction.used), { timeout: 3500, label: `hint try ${i}` });
      }
      if (!hint) {
        // диагностика: что видит модуль в последнем сообщении атаки, и срабатывает ли onAttackMessage напрямую
        const atk = game.messages.contents.findLast((x) => x._stats.createdTime >= t0 && /attack-roll/.test(x.flags?.pf2e?.context?.type ?? ""));
        const c = atk?.flags?.pf2e?.context;
        step("reaction-diag", { found: !!atk, type: c?.type, target: c?.target, dc: c?.dc, outcome: c?.outcome, degree: atk?.rolls?.[0]?.options?.degreeOfSuccess ?? atk?.rolls?.[0]?.degreeOfSuccess,
          items: liarel.items.filter((i) => i.type === "feat").map((i) => [i.system.slug, i._stats.compendiumSource]), mode: game.settings.get(MOD, "mode.reaction"), onlyWhenChanges: game.settings.get(MOD, "reaction.onlyWhenChanges") });
        if (atk) { try { await api.onAttackMessage(atk); } catch (e) { report.errors.push("onAttackMessage: " + e.message); }
          hint = await waitFor(() => game.messages.contents.findLast((x) => x._stats.createdTime >= t0 && x.flags?.[MOD]?.reaction && !x.flags[MOD].reaction.used), { timeout: 3000, label: "hint direct" });
          step("reaction-direct", { created: !!hint }); }
      }
      ok(S, "шёпот-подсказка с флагом reaction", hint, hint?.whisper?.length);
      if (hint) {
        ok(S, "подсказка — шёпот", hint.whisper.length > 0);
        document.querySelector(`[data-message-id="${hint.id}"] .pf2e-automato button[data-action="use-reaction"]`)?.click();
        ok(S, "reaction.used = true после кнопки", await waitFor(() => game.messages.get(hint.id)?.flags?.[MOD]?.reaction?.used, { timeout: 6000, label: "used" }));
      }
      ok(S, "вне боя reactionSpent не ставится", !liarel.getFlag(MOD, "reactionSpent"), liarel.getFlag(MOD, "reactionSpent"));
      eq(S, "на Лиарэль нет висящего эффекта", effBefore, liarel.itemTypes.effect.length);
    });

    // ================= S14: результат от Toolbelt (без нашего маркера) =================
    await sc("14 Toolbelt-эмуляция", ["use", "saves", "zone"], async (S) => {
      await setS("mode.challenge", "button");   // сами не бросаем: результаты приходят «извне»
      await tokOf(tW1).update({ x: 1000, y: 500 }); await wait(800);
      const { m } = await castBF();
      const cone = await mkRegion("B", bfx, shot.cone(1350, 550), "cone", m);
      await waitFor(() => { const k = useOf(m)?.state?.area?.keys ?? []; return k.includes(tW1.id) && k.includes(tW2.id); }, { timeout: 12000, label: "area keys tb" });
      // (а) хук Toolbelt: бросок и переброс. Вызываем только наши обработчики: pf2e-automations на том же хуке ждёт настоящий rollMessage
      const fireOurs = (name, re, payload) => { for (const h of Hooks.events[name] ?? []) if (re.test(String(h.fn))) h.fn(payload); };
      fireOurs("pf2e-toolbelt.rollSave", /toolbelt rollSave/, { data: { success: "failure", value: 12, die: 5 }, message: game.messages.get(m.id), roll: { total: 12 }, rollMessage: null, target: tokOf(tW1) });
      const r1 = await waitFor(() => useOf(m)?.state?.challenge?.results?.[tW1.id], { timeout: 6000, label: "toolbelt result" });
      eq(S, "хук rollSave: результат принят (failure=1, src toolbelt)", [1, 12, "toolbelt"], [r1?.degree, r1?.total, r1?.src]);
      fireOurs("pf2e-toolbelt.rerollSave", /toolbelt rerollSave/, { data: { success: "success", value: 19, die: 12 }, keptRoll: { total: 19 }, message: game.messages.get(m.id), newRoll: { total: 19 }, oldRoll: { total: 12 }, target: tokOf(tW1) });
      const r2 = await waitFor(() => { const r = useOf(m)?.state?.challenge?.results?.[tW1.id]; return r?.degree === 2 && r; }, { timeout: 6000, label: "toolbelt reroll" });
      eq(S, "хук rerollSave: результат заменён (success=2)", [2, 19], [r2?.degree, r2?.total]);
      // (б) обычное saving-throw-сообщение с origin-предметом и токеном цели, без нашего маркера
      try {
        await A2().saves.reflex.check.roll({ dc: { value: 15 }, origin: pyro, item: bfx, token: tokOf(tW2), skipDialog: true, extraRollOptions: [] });
        const r3 = await waitFor(() => useOf(m)?.state?.challenge?.results?.[tW2.id], { timeout: 8000, label: "plain save by origin" });
        eq(S, "saving-throw без маркера принят по origin+токену", "saving-throw", r3?.src);
      } catch (e) { skip(S, "бросок спасброска из харнесса не удался: " + String(e?.message ?? e).slice(0, 120)); }
      await setS("mode.challenge", savedSettings["mode.challenge"]);
      await cone.delete();
    });

    // ================= S12: права отправителя сокета (K7 п.1) =================
    await sc("12 права сокета", [], async (S) => {
      const player = game.users.find((u) => !u.isGM);
      if (!player) skip(`${S} игрок`, "нет пользователей-игроков (проверено юнит-тестом allowed)");
      else {
        // игрок — только как userId отправителя: обработчики отклоняют до любых изменений, данные игроков не читаются и не пишутся
        const as = (id, name, ...a) => api.HANDLERS[name].call({ socketdata: { userId: id } }, ...a);
        for (const n of ["applyByDegree", "undoApplied", "setDC", "resumeUse", "createZone"]) eq(S, `${n}: игрок отклонён`, "forbidden", (await as(player.id, n, "x", "y")).reason);
        for (const n of ["rollSaveFor", "useReaction", "applyUse", "applyDerived"]) eq(S, `${n}: не автор/не владелец отклонён`, "forbidden", (await as(player.id, n, "x", "y")).reason);
      }
      const [foreign] = await scene.createEmbeddedDocuments("Region", [{ name: "AF foreign", shapes: [shot.circle(300, 300, 50)] }]);
      const r = await as0(foreign.uuid);
      ok(S, "closeZone не удаляет чужой регион (без нашего поведения)", scene.regions.get(foreign.id), r);
      await foreign.delete();
      function as0(uuid) { return api.HANDLERS.closeZone.call({ socketdata: { userId: game.user.id } }, uuid); }
    });

    // ================= S13: low-зона (K7 п.3): регион без зоны до кнопки =================
    await sc("13 low-зона", ["use", "zone"], async (S) => {
      const html = `<p>Дым @Template[burst|distance:10] даёт @UUID[Compendium.pf2e.conditionitems.Item.DmAIPqOBomZ7H95W]{скрытость}.</p>`;
      const [it] = await liarel.createEmbeddedDocuments("Item", [{ type: "action", name: "AF lowzone", system: { slug: "af-test-lowzone", description: { value: html } } }]);
      await tokOf(tW1).update({ x: 1000, y: 500 }); await wait(800);
      const { m, use } = await cardMsg(it);
      eq(S, "confidence", "low", use?.confidence);
      const reg = await mkRegion("B", it, shot.circle(1050, 550, 150), "burst", m);
      await waitFor(() => useOf(m)?.state?.zone?.status === "pending", { timeout: 10000, label: "zone pending" });
      eq(S, "state.zone = pending с регионом", ["pending", reg.uuid], [useOf(m)?.state?.zone?.status, useOf(m)?.state?.zone?.regionUuid]);
      eq(S, "зона не создана до кнопки", 0, ourCount([A1(), A2()]));
      ok(S, "кнопки «Создать зону» нет (есть только derived)", !document.querySelector(`[data-message-id="${m.id}"] .pf2e-automato button[data-action="create-zone"]`));
      await click(m, ["apply-derived"]);
      ok(S, "после derived зона действует", await waitFor(() => has(A1(), "concealed", "condition"), { timeout: 10000, label: "derived zone" }));
      eq(S, "state.zone = active", "active", useOf(m)?.state?.zone?.status);
    });

    report.messages = game.messages.filter((m) => createdMsgs.has(m.id)).map((m) => ({
      id: m.id, af: Object.keys(m.flags).filter((k) => k.startsWith(MOD)), whisper: m.whisper.length,
      text: (() => { const d = document.createElement("div"); d.innerHTML = m.content; return d.textContent.replace(/\s+/g, " ").trim().slice(0, 160); })()
    }));
  } catch (e) {
    report.errors.push("harness: " + (e.stack ?? e).toString().slice(0, 600));
  } finally {
    report.errors.push(...errs);
    window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr);
    console.error = origConsoleError;
    // --- уборка ---
    const c = {};
    try { document.querySelectorAll(".pf2e-toolbelt-template-helper").forEach((d) => d.closest(".application, .app")?.querySelector("[data-action=close], .header-control.close, a.close")?.click()); } catch { /* диалога нет */ }
    try { for (const w of Object.values(ui.windows ?? {})) if (/AF /.test(w.title ?? "")) await w.close(); } catch { /* листы закрыты */ }
    try {
      for (const k of worldKeys) await api.callGM("saveCatalogRule", k, null);
      const cat = game.settings.get(MOD, "catalog");
      c.worldCatalogClean = !Object.keys(cat.bySlug ?? {}).some((s) => s.startsWith("af-test"));
    } catch (e) { c.worldCatalogError = String(e); }
    try { Hooks.off("createChatMessage", msgHook); const ids = [...createdMsgs].filter((id) => game.messages.has(id)); if (ids.length) await ChatMessage.deleteDocuments(ids); c.messagesDeleted = ids.length; } catch (e) { c.msgError = String(e); }
    try { if (macros.length) await Macro.deleteDocuments(macros.map((m) => m.id)); c.macrosDeleted = macros.length; } catch (e) { c.macroError = String(e); }
    try { if (actors.length) await Actor.deleteDocuments(actors.map((a) => a.id)); c.actorsDeleted = actors.length; } catch (e) { c.actorError = String(e); }
    try { if (scene) { await prevScene?.view(); await scene.delete(); } } catch (e) { c.sceneError = String(e); }
    for (const [k, v] of Object.entries(savedSettings)) { try { if (game.settings.get(MOD, k) !== v) await setS(k, v); } catch { /* настройка недоступна */ } }
    delete globalThis.__afMacroLog;
    c.playersUntouched = fingerprint() === fpBefore;
    c.clicked = clicked;
    report.cleanup = c;
    const count = (p) => report.rows.filter((r) => r.pass === p).length;
    report.summary = { passed: count(true), failed: count(false), skipped: count("skipped"), errors: report.errors.length, playersUntouched: c.playersUntouched };
  }
  return report;
}
