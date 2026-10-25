async () => {
  // Живые сценарии activate (plan-activate §5.2, §10): сообщение активации kind:"use" со снимком, метка activation и общий useId, выбор варианта, «каст + добавка»,
  // область из текста Effect, раздельные счётчики, отмена диалога, возврат счётчика при удалении сообщения. Вкладка активного ГМа-лидера, ничего вручную не нажимать;
  // не играть под Gamemaster-игроком (двоит исполнение). Приёмы — как в cast-activation.js / choose-actions.js. Правило — флаг rule на копии предмета из компендиума.
  // Параметры (перед запуском): window.__afActivate = { only: ["horn", ...], skip: [...], cleanOnly: true }
  // Нужны mode.challenge = auto, mode.apply = auto (и mode.macro не off для сценария actions). Сетка сцены 100 px / 5 фт; автор в (500,500), цель-NPC в (600,500).
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afActivateResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afActivate ?? {}) };
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

  // ---------- уборка (аварийная: window.__afActivate = {cleanOnly: true}) ----------
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
  const confirmPrev = foundry.applications.api.DialogV2.confirm;
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };

  // ---------- компендиумы (slug — по 8.6.1) ----------
  const idx = {};
  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    idx[pack] ??= await p.getIndex({ fields: ["system.slug"] });
    const e = idx[pack].find((i) => i.system?.slug === slug);
    if (!e) throw new Skip(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(e._id)).toObject();
  };
  const equip = (s) => find("pf2e.equipment-srd", s);
  const spellUuid = async (slug) => { idx["pf2e.spells-srd"] ?? await find("pf2e.spells-srd", slug).catch(() => {}); return idx["pf2e.spells-srd"]?.find((i) => i.system?.slug === slug)?.uuid ?? (() => { throw new Skip(`нет заклинания ${slug}`); })(); };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null, pick: null, mark: 0, atDialog: [] };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна: наши .paf-dialog: e.pick = data-action кнопки (id варианта / число действий), иначе закрываются (отмена); ChoiceSet pf2e — первый вариант.
    // e.dialogs — «окно появилось», e.atDialog — сколько сообщений нашего пользователя существовало с e.mark в момент появления окна (диалог ДО ChatMessage.create).
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          e.dialogs.push(el.querySelector(".window-title")?.textContent?.trim() ?? el.id);
          e.atDialog.push(game.messages.contents.filter((m) => m._stats.createdTime >= e.mark && m.author?.id === game.user.id).length);
          const b = e.pick != null ? el.querySelector(`button[data-action="${e.pick}"]`) : null;
          if (b) b.click(); else foundry.applications.instances.get(el.id)?.close();
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
    e.fix = async (n) => {
      if (n != null) live();
      if (e.d20 === null) e.d20 = CONFIG.Dice.randomUniform;
      CONFIG.Dice.randomUniform = n == null ? e.d20 : () => 1 - (n - 0.5) / 20;
      if (n != null && (await new Roll("1d20").evaluate()).total !== n) throw new Skip("не удалось зафиксировать d20 (CONFIG.Dice.randomUniform)");
    };
    e.since = () => Date.now();
    e.msgs = (t0) => game.messages.contents.filter((m) => m._stats.createdTime >= t0);
    e.dom = (m) => document.querySelector(`#chat [data-message-id="${m?.id}"]`);
    e.cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug) ?? null;
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.results = (m) => Object.fromEntries(Object.entries(e.use(m)?.state?.challenge?.results ?? {}).map(([k, v]) => [k, deg(v.degree)]));
    /** Предмет-копия на актёре с правилом activate в флаге (rule валидируется заранее; ошибка — в detail). */
    e.gear = async (actor, slug, activate, patch = (d) => d) => {
      const rule = { v: 1, activate };
      const v = api().validateRule(rule);
      if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
      const d = await equip(slug);
      d.flags = { ...d.flags, [MOD]: { rule } };
      const [it] = await e.give(actor, patch(d));
      return it;
    };
    /** Карточка предмета в чате (со снимком use) -> сообщение; DOM блока модуля виден. */
    e.card = async (item) => {
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
      if (!m) throw new Error(`у карточки «${item.name}» нет снимка use (правило не найдено или модуль не слушает)`);
      await waitFor(() => e.dom(m)?.querySelector(".pf2e-automato"), 6000);
      return game.messages.get(m.id);
    };
    e.btn = (m, castId) => e.dom(m)?.querySelector(`.pf2e-automato button[data-action="cast-item"]${castId ? `[data-cast="${castId}"]` : ""}`) ?? null;
    /** Нажать кнопку активации на карточке; -> сообщения активации (флаг activation), появившиеся после нажатия (ждём n штук; меньше за ms — что есть). */
    e.press = async (m, id, { n = 1, ms = 12000 } = {}) => {
      const t0 = e.mark = e.since(), b = e.btn(m, id);
      if (!b) throw new Error(`нет кнопки ${id ?? ""} на карточке`);
      b.click();
      const mine = () => e.msgs(t0).filter((x) => x.flags?.[MOD]?.activation);
      await waitFor(() => mine().length >= n, ms);
      return mine();
    };
    /** Что за сообщение: "use" — сообщение использования модуля (без flags.pf2e.origin), "spell" — карточка заклинания pf2e. */
    e.kind = (m) => (m.flags?.[MOD]?.use?.kind === "use" && !m.flags?.pf2e?.origin ? "use" : m.flags?.pf2e?.origin?.type === "spell" ? "spell" : "?");
    e.of = (list, kind) => list.find((x) => e.kind(x) === kind) ?? null;
    /** Счётчик частоты записи на предмете. */
    e.uses = (item, id) => item.flags?.[MOD]?.uses?.[id];
    e.dispose = async () => {
      e.dead = true; e.stop = true;
      Hooks.off("createChatMessage", hook);
      foundry.applications.api.DialogV2.confirm = confirmPrev;
      try { await e.fix(null); } catch { /* ok */ }
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      document.querySelectorAll(".paf-dialog").forEach((el) => foundry.applications.instances.get(el.id)?.close());
      const left = await sweep([...e.tracked]);
      await viewCombat(prevCombat);
      return left;
    };
    return e;
  };


  // ---------- сценарии activate ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const ARC = "Compendium.pf2e.spells-srd.Item.kBhaPuzLUSwS6vVf";
  const SICK = { slug: "sickened", value: 1 };
  const FORT = { statistic: "fortitude", byDegree: { failure: [{ to: "target", condition: SICK }], criticalFailure: [{ to: "target", condition: SICK }] } };
  const AC1 = { to: "self", effect: { mods: [{ bonus: { target: "ac", type: "circumstance", value: 1 } }] }, duration: { value: 10, unit: "minutes" } };
  const DAY = { value: 1, unit: "days" };
  /** PC (500,500) и NPC-цель (600,500); предмет с правилом activate у PC; карточка предмета; цель выбрана. */
  const stage = async (e, slug, activate, { patch, level } = {}) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("владелец"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    if (level) { await e.A(tP).update({ "system.details.level.value": level }); await wait(300); }
    const item = await e.gear(e.A(tP), slug, activate, patch);
    await e.aim(tP, tV);
    const card = await e.card(item);
    return { pc, vic, tP, tV, item, card };
  };
  const meta = (a, m) => a.itemTypes.effect.filter((x) => x.flags?.[MOD]?.meta?.key?.startsWith(`${m.id}:`));

  sc("horn", "Horn of Blasting: кнопка 1 — испытание Стойкости цели; кнопка 2 — шаблон из текста Effect в сообщении активации -> зона/испытание; частота 1/день, второй клик — подтверждение", async (e, t) => {
    const HTML = `<p><strong>Activate</strong> Blast</p><p><strong>Effect</strong> A blast hits one target.</p><hr /><p><strong>Activate</strong> Cone</p><p><strong>Effect</strong> A @Template[type:cone|distance:30]{30-foot cone} of sound.</p>`;
    const { tV, item, card } = await stage(e, "horn-of-blasting", [
      { id: "blast", label: "Blast", dc: 28, requires: "none", onUse: { targets: "selected", challenge: FORT } },
      { id: "cone", label: "Cone", dc: 28, requires: "none", per: DAY, onUse: { targets: "area", challenge: FORT } }
    ], { patch: (d) => { d.system.description.value = HTML; return d; } });
    await e.fix(1);
    const [m1] = await e.press(card, "blast");
    t.ok(!!m1 && e.kind(m1) === "use", `сообщение использования: ${m1 && e.kind(m1)}`);
    if (!m1) return;
    const u = e.use(m1);
    t.ok(u.dc === 28 && !u.rule.activate && !m1.flags.pf2e?.origin && u.item.uuid === item.uuid, `снимок: dc ${u.dc}, rule ${Object.keys(u.rule)}, origin ${!!m1.flags.pf2e?.origin}`);
    t.ok(!!(await waitFor(() => e.results(m1)[tV.id], 10000)), `испытание цели: ${JSON.stringify(e.results(m1))}`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tV), "sickened"), 8000)), "по степени у цели sickened");
    t.ok(!e.uses(item, "blast"), "частоты у «blast» нет — счётчика нет");
    const [m2] = await e.press(card, "cone");
    t.ok(!!m2, "сообщение второй активации");
    if (!m2) return;
    t.ok(/@Template/.test(m2.content) && !/blast hits/i.test(m2.content), "в содержимом текст Effect этой активации с @Template, соседней — нет");
    t.ok(e.use(m2).state?.awaitingRegion === true && !Object.keys(e.results(m2)).length, `до шаблона: awaitingRegion ${e.use(m2).state?.awaitingRegion}, испытаний нет`);
    t.ok(!!(await waitFor(() => e.dom(m2)?.querySelector("[data-effect-area]"), 6000)), "@Template в сообщении активации обогатился в ссылку области");
    await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}конус`, color: "#aa0000", shapes: [{ type: "circle", hole: false, x: 650, y: 550, radius: 80 }], behaviors: [], flags: { pf2e: { messageId: m2.id, areaShape: "burst" } } }]);   // как шаблон, брошенный из сообщения
    t.ok(!!(await waitFor(() => (e.use(m2)?.state?.area?.keys ?? []).includes(tV.id), 10000)), `область снята: ${JSON.stringify(e.use(m2)?.state?.area)}`);
    t.ok(!!(await waitFor(() => e.results(m2)[tV.id], 10000)), `испытание по области: ${JSON.stringify(e.results(m2))}`);
    t.ok(e.uses(item, "cone")?.log?.length === 1, `счётчик «cone»: ${JSON.stringify(e.uses(item, "cone"))}`);
    const again = await e.press(await e.card(item), "cone", { ms: 4000 });
    t.ok(!again.length && e.dialogs.some((d) => /Активация|activation/i.test(d)), `второй клик: окно «использовано» [${e.dialogs}], новых сообщений ${again.length}`);
  });

  sc("tattoo", "Warding Tattoo: каст + добавка — две карточки с общим useId, бонус КД у владельца от ГМа; удаление возвращает счётчик ровно раз; эффекты снимает отмена, не удаление", async (e, t) => {
    const { tP, item, card } = await stage(e, "warding-tattoo", [{ id: "tattoo", spell: ARC, dc: 17, requires: "none", per: DAY, onUse: { targets: "self", apply: [AC1] } }]);
    const A = () => e.A(tP), ac0 = A().attributes.ac.value;
    const list = await e.press(card, "tattoo", { n: 2 }), sp = e.of(list, "spell"), us = e.of(list, "use");
    t.ok(!!sp && !!us && list.length === 2, `две карточки: ${list.map(e.kind)}`);
    if (!sp || !us) return;
    const id1 = us.flags[MOD].activation.useId;
    t.ok(!!id1 && sp.flags[MOD].activation.useId === id1, `общий useId: ${sp.flags[MOD].activation.useId} / ${id1}`);
    t.ok(sp.flags.pf2e.origin.rollOptions.includes("origin:item:cast-by-activation") && !us.flags.pf2e?.origin, "опция cast-by-activation у карточки заклинания; у сообщения активации origin нет");
    t.ok(!!(await waitFor(() => A().attributes.ac.value === ac0 + 1, 10000)), `КД ${ac0} -> ${A().attributes.ac.value}`);
    t.ok(meta(A(), us).length === 1, `эффект один раз, ключ <сообщение>:…: ${meta(A(), us).length}`);
    t.ok(e.uses(item, "tattoo")?.log?.join() === id1, `счётчик хранит useId: ${JSON.stringify(e.uses(item, "tattoo"))}`);
    await game.messages.get(sp.id).delete();
    t.ok(await waitFor(() => !e.uses(item, "tattoo"), 6000), "удаление карточки заклинания вернуло счётчик");
    t.ok(meta(A(), us).length === 1, "эффект удаление не снимает");
    // второе нажатие (счётчик свободен); удаление сообщения активации ПЕРВОГО нажатия (его useId уже возвращён) не должно вернуть счётчик второго
    const list2 = await e.press(await e.card(item), "tattoo", { n: 2 }), us2 = e.of(list2, "use");
    t.ok(list2.length === 2 && e.uses(item, "tattoo")?.log?.length === 1, `второе нажатие: ${list2.length} сообщ., счётчик ${JSON.stringify(e.uses(item, "tattoo"))}`);
    await game.messages.get(us.id).delete();
    await wait(1500);
    t.ok(e.uses(item, "tattoo")?.log?.length === 1, `удаление «чужого» (уже возвращённого) сообщения счётчик не тронуло: ${JSON.stringify(e.uses(item, "tattoo"))}`);
    // отмена: undoOps (как кнопка «Отменить») снимает эффект сообщения активации
    await waitFor(() => us2 && meta(A(), us2).length === 1, 8000);
    if (us2) await (await imp("apply.mjs")).undoOps(game.messages.get(us2.id), "self");
    t.ok(!!us2 && !!(await waitFor(() => meta(A(), us2).length === 0, 8000)), "отмена (undoOps) сняла эффект сообщения активации");
  });

  sc("gaze", "Archivist's Gaze: choices — диалог ДО сообщений; вариант с onUse -> сообщение использования с choice, вариант-заклинание -> карточка заклинания с записью «активация.вариант»", async (e, t) => {
    const rec = { id: "gaze", label: "Gaze", requires: "none", per: DAY, choices: [{ id: "peek", spell: ARC, dc: 20 }, { id: "read", label: "Read", onUse: { targets: "self", apply: [AC1] } }] };
    const { item, card } = await stage(e, "archivists-gaze", [rec]);
    e.pick = "read";
    const [m1] = await e.press(card, "gaze");
    t.ok(!!m1 && e.kind(m1) === "use" && m1.flags[MOD].activation.choice === "read", `вариант read: ${m1 && e.kind(m1)}, choice ${m1?.flags?.[MOD]?.activation?.choice}`);
    t.ok(e.dialogs.length === 1 && e.atDialog[0] === 0, `диалог один и до создания сообщений: [${e.dialogs}] / ${e.atDialog}`);
    const snapOn = m1 && e.use(m1).rule.onUse;   // снимок хранит нормализованное правило (excludeSelf: null и т.п.) — сверяем по существу
    t.ok(snapOn?.targets === "self" && snapOn?.apply?.length === 1 && snapOn.apply[0].effect?.mods?.[0]?.bonus?.target === "ac", `в снимке onUse выбранного варианта: ${JSON.stringify(snapOn)}`);
    t.ok(!!(await waitFor(() => e.uses(item, "gaze")?.log?.length === 1, 5000)), `списано один раз: ${JSON.stringify(e.uses(item, "gaze"))}`);   // press ждёт сообщений, счётчик пишется после них
    foundry.applications.api.DialogV2.confirm = async () => true;   // «всё равно» (лимит 1/день исчерпан)
    e.pick = "peek";
    const [m2] = await e.press(await e.card(item), "gaze");
    t.ok(!!m2 && e.kind(m2) === "spell" && m2.flags[MOD].activation.choice === "peek" && m2.flags[MOD].activation.dc === 20, `вариант peek: ${m2 && e.kind(m2)}, ${JSON.stringify(m2?.flags?.[MOD]?.activation)}`);
    t.ok(m2?.flags?.pf2e?.casting?.id === `af-cast-${item.id}-gaze.peek`, `запись заклинателя: ${m2?.flags?.pf2e?.casting?.id}`);
    item.actor.reset();   // кэш записей заклинателя сброшен: запись «gaze.peek» собирается заново разбором id в install()
    await wait(500);
    t.ok(game.messages.get(m2.id).item?.spellcasting?.statistic?.dc?.value === 20, `после reset СЛ записи варианта: ${game.messages.get(m2.id).item?.spellcasting?.statistic?.dc?.value}`);
    t.ok(e.uses(item, "gaze")?.log?.length === 2, "второе списание");
  });

  sc("cancel", "Отмена диалога выбора: ничего не создано, ничего не списано, кнопка снова активна", async (e, t) => {
    const { item, card } = await stage(e, "archivists-gaze", [{ id: "gaze", label: "Gaze", requires: "none", per: DAY, choices: [{ id: "peek", spell: ARC, dc: 20 }, { id: "read", label: "Read", onUse: { targets: "self", apply: [AC1] } }] }]);
    e.pick = null;
    const t0 = e.since(), list = await e.press(card, "gaze", { ms: 4000 });
    t.ok(!list.length && !e.msgs(t0).length, `сообщений нет: активаций ${list.length}, всего ${e.msgs(t0).length}`);
    t.ok(e.dialogs.length === 1 && e.atDialog[0] === 0, `окно было и до сообщений: [${e.dialogs}] / ${e.atDialog}`);
    t.ok(!e.uses(item, "gaze"), `частота не списана: ${JSON.stringify(e.uses(item, "gaze"))}`);
    t.ok(!!e.btn(card, "gaze") && !e.btn(card, "gaze").disabled, "кнопка активна");
  });

  sc("fearcutter", "Fearcutter: Cut Cruelty (каст) и Cut Fear (шаги) — один список, счётчики раздельны", async (e, t) => {
    const { tV, item, card } = await stage(e, "fearcutter", [
      { id: "cut-cruelty", label: "Cut Cruelty", spell: ARC, dc: 27, requires: "none", per: DAY },
      { id: "cut-fear", label: "Cut Fear", dc: 27, requires: "none", per: DAY, onUse: { targets: "selected", challenge: FORT } }
    ]);
    t.ok(!!e.btn(card, "cut-cruelty") && !!e.btn(card, "cut-fear"), "обе кнопки на одной карточке");
    await e.fix(1);
    const [c1] = await e.press(card, "cut-cruelty");
    t.ok(!!c1 && e.kind(c1) === "spell", `Cut Cruelty — карточка заклинания: ${c1 && e.kind(c1)}`);
    const [c2] = await e.press(card, "cut-fear");
    t.ok(!!c2 && e.kind(c2) === "use" && !e.dialogs.length, `Cut Fear без вопроса «использовано»: ${c2 && e.kind(c2)}, окна [${e.dialogs}]`);
    t.ok(!!c2 && !!(await waitFor(() => e.results(c2)[tV.id], 10000)), `испытание Cut Fear: ${c2 && JSON.stringify(e.results(c2))}`);
    t.ok(e.uses(item, "cut-cruelty")?.log?.length === 1 && e.uses(item, "cut-fear")?.log?.length === 1, `счётчики раздельны: ${JSON.stringify(item.flags?.[MOD]?.uses)}`);
    const again = await e.press(await e.card(item), "cut-fear", { ms: 4000 });
    t.ok(!again.length && e.dialogs.length === 1 && e.uses(item, "cut-cruelty")?.log?.length === 1, `повтор Cut Fear — окно, Cut Cruelty не тронут: [${e.dialogs}]`);
  });

  sc("giveback", "Активация без заклинания: удаление сообщения возвращает счётчик; очистка лога (deleteAll) — нет", async (e, t) => {
    const { item, card } = await stage(e, "horn-of-blasting", [{ id: "blast", label: "Blast", dc: 28, requires: "none", per: DAY, onUse: { targets: "self", apply: [AC1] } }]);
    const [m] = await e.press(card, "blast");
    t.ok(!!m && e.uses(item, "blast")?.log?.length === 1, `счётчик записан: ${JSON.stringify(e.uses(item, "blast"))}`);
    if (!m) return;
    Hooks.callAll("deleteChatMessage", game.messages.get(m.id), { deleteAll: true }, game.user.id);
    await wait(1500);
    t.ok(e.uses(item, "blast")?.log?.length === 1, "deleteAll счётчик не вернул");
    await game.messages.get(m.id).delete();
    t.ok(await waitFor(() => !e.uses(item, "blast"), 6000), "обычное удаление вернуло использование");
  });

  sc("twice", "Два нажатия подряд = два использования: два сообщения, два списания, шаги каждого исполнены ровно один раз", async (e, t) => {
    const { item, card } = await stage(e, "horn-of-blasting", [{ id: "blast", label: "Blast", dc: 28, requires: "none", per: { value: 1, unit: "days", uses: 2 }, onUse: { targets: "self", apply: [AC1] } }]);
    const [a] = await e.press(card, "blast");
    const [b] = await e.press(card, "blast");
    t.ok(!!a && !!b && a.id !== b.id, `два сообщения: ${a?.id} / ${b?.id}`);
    t.ok(e.uses(item, "blast")?.log?.length === 2, `два списания: ${JSON.stringify(e.uses(item, "blast"))}`);
    for (const m of [a, b]) {
      if (!m) continue;
      t.ok(!!(await waitFor(() => e.use(m)?.state?.done, 10000)), `${m.id}: исполнено (done)`);
      t.ok((e.use(m)?.state?.apply?.self?.ops ?? []).length === 1, `${m.id}: шагов self ровно один: ${JSON.stringify(e.use(m)?.state?.apply?.self?.ops)}`);
    }
  });

  sc("harrow", "Ранг {half:actor} и СЛ {against:class-spell}: ранг — половина уровня владельца вниз, СЛ — лучшая запись заклинателя (карточка заклинания и шаги без заклинания)", async (e, t) => {
    const { tP, tV, item } = await stage(e, "warding-tattoo", [
      { id: "harrow", spell: await spellUuid("fear"), rank: { half: "actor", min: 1 }, dc: { against: "class-spell" }, requires: "none" },
      { id: "stat", label: "Stat", dc: { against: "class-spell" }, requires: "none", onUse: { targets: "selected", challenge: FORT } }
    ], { level: 9 });
    const actor = e.A(tP);
    await actor.createEmbeddedDocuments("Item", [{ type: "spellcastingEntry", name: "AF запись", system: { ability: { value: "cha" }, prepared: { value: "spontaneous" }, tradition: { value: "arcane" }, proficiency: { value: 4 } } }, { type: "effect", name: "AF СЛ +20", system: { slug: "af-dc-plus", rules: [{ key: "FlatModifier", selector: "arcane-spell-dc", value: 20 }], duration: { value: -1, unit: "unlimited", sustained: false, expiry: null } } }]);   // СЛ записи заведомо выше любых других
    await wait(500);
    const ref = () => actor.getStatistic("class-spell")?.dc?.value, want = ref();   // эталон pf2e (не наша формула)
    t.ok(want > 30, `эталон class-spell ${want} (запись +20)`);
    await e.fix(1);
    const card2 = await e.card(item);
    const [h] = await e.press(card2, "harrow");
    t.ok(!!h && h.flags[MOD].activation.rank === 4 && h.flags.pf2e.origin.castRank === 4 && h.flags[MOD].activation.dc === want, `уровень ${actor.level}: ранг ${h?.flags?.[MOD]?.activation?.rank}, castRank ${h?.flags?.pf2e?.origin?.castRank}, dc ${h?.flags?.[MOD]?.activation?.dc} (ждали 4 / ${want})`);
    const [s] = await e.press(card2, "stat");
    t.ok(!!s && e.use(s).dc === want, `СЛ шагов без заклинания: ${s && e.use(s).dc}, ждали ${want}`);
    t.ok(!!s && !!(await waitFor(() => e.results(s)[tV.id], 10000)), "испытание по этой СЛ брошено");
    // вторая половина: классовая СЛ выше лучшей записи заклинателя (запись слабая, у владельца класс fighter)
    const fighter = await find("pf2e.classes", "fighter").catch(() => null);
    if (!fighter) { t.ok(false, "нет класса fighter в pf2e.classes — случай «класс выше записи» не проверен"); return; }
    await actor.deleteEmbeddedDocuments("Item", actor.itemTypes.effect.filter((x) => x.slug === "af-dc-plus").map((x) => x.id));
    await actor.updateEmbeddedDocuments("Item", actor.itemTypes.spellcastingEntry.map((x) => ({ _id: x.id, "system.proficiency.value": 1 })));
    await actor.createEmbeddedDocuments("Item", [fighter, { type: "effect", name: "AF СЛ −5", system: { slug: "af-dc-minus", rules: [{ key: "FlatModifier", selector: "arcane-spell-dc", value: -5 }], duration: { value: -1, unit: "unlimited", sustained: false, expiry: null } } }]);   // та же подготовка дала бы равенство — запись заведомо ниже класса
    await wait(700);
    const entryDc = actor.spellcasting.find((x) => x.statistic)?.statistic?.dc?.value ?? 0, classDc = actor.classDC?.dc?.value ?? 0, want2 = ref();
    t.ok(classDc > entryDc && want2 === classDc, `класс выше записи: класс ${classDc}, запись ${entryDc}, class-spell ${want2}`);
    const [h2] = await e.press(await e.card(item), "harrow");
    t.ok(!!h2 && h2.flags[MOD].activation.dc === want2, `dc карточки заклинания ${h2?.flags?.[MOD]?.activation?.dc}, ждали ${want2}`);
    const [s2] = await e.press(await e.card(item), "stat");
    t.ok(!!s2 && e.use(s2).dc === want2, `СЛ шагов ${s2 && e.use(s2).dc}, ждали ${want2}`);
  });

  sc("actions", "Переменное заклинание на пути активации: число действий спрашивается ДО сообщений, флаг awaitingActions не ставится, число уходит и в сообщение использования", async (e, t) => {
    needMode("mode.macro", "off");
    const { item, card } = await stage(e, "warding-tattoo", [{ id: "barrage", spell: await spellUuid("force-barrage"), dc: 20, requires: "none", onUse: { targets: "self", apply: [AC1] } }]);
    e.pick = "2";
    const list = await e.press(card, "barrage", { n: 2 }), sp = e.of(list, "spell"), us = e.of(list, "use");
    t.ok(!!sp && !!us, `две карточки: ${list.map(e.kind)}`);
    if (!sp || !us) return;
    t.ok(e.dialogs.length === 1 && e.atDialog[0] === 0, `окно действий до сообщений: [${e.dialogs}] / ${e.atDialog}`);
    t.ok(sp.flags[MOD].cast?.actions === 2 && sp.flags.pf2e.origin.rollOptions.includes("origin:item:cast:actions:2"), `cast.actions ${sp.flags[MOD].cast?.actions}`);
    t.ok(!e.use(sp)?.state?.awaitingActions && !e.use(us)?.state?.awaitingActions, "awaitingActions не ставился");
    t.ok(e.use(us).rollOptions?.includes("origin:item:cast:actions:2") && e.use(us).rollOptions.includes("origin:item:cast-by-activation"), `rollOptions снимка: ${JSON.stringify(e.use(us).rollOptions)}`);
    t.ok(!!(await waitFor(() => e.use(us)?.state?.done, 10000)), "добавка исполнена");
    t.ok(e.uses(item, "barrage") === undefined, "частоты нет — счётчика нет");
    t.ok(!!(await waitFor(() => e.msgs(e.mark).some((x) => x.flags?.pf2e?.context?.type === "damage-roll"), 10000)), "снаряды Силового залпа брошены (rollMissiles из castItem)");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} activate | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 3).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    foundry.applications.api.DialogV2.confirm = confirmPrev;
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  const table = rows.map((r) => `${r.id.padEnd(12)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afActivateResult = result;
  return result;
}
