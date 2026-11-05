async () => {
  // Живые сценарии плута 1 уровня (plan.md §13.7, волна 2): Организатор, Пройдоха, Вовлекающий финт. Правила — rules/catalog.json и catalog.campaign.json (Финт).
  // Герои — временные копии «AF тест: …» из папки «Герои 1 ур. (автоматизация)» (сами герои не меняются). Эффекты — пак модуля (MstrmindOffGrd01, ScndrlOffGuard01, OvrxtFeint*).
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. mode.effect/apply/challenge = auto на время прогона (прежние — window.__afL1RogueModesPrev).
  // Параметры: window.__afL1Rogue = { only: [...], skip: [...], cleanOnly: true }. Результат: { summary, table, rows } и window.__afL1RogueResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL1Rogue ?? {}) };
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
  const hangInfo = (e) => `последний шаг: ${e.step}; закрыто окон бросков: [${e.windows}]; окна модуля: [${e.dialogs}]; открыто: [${[...foundry.applications.instances.values(), ...Object.values(ui.windows ?? {})].map((a) => a.constructor.name).join(", ")}]`;
  let cur = null;
  const DEG = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const deg = (v) => (typeof v === "number" ? DEG[v] : v);
  // pf2e: shift ИНВЕРТИРУЕТ настройку show*Dialogs; прогон ставит их в false, поэтому shift нужен только если окна включены (см. strike-gate.js)
  const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });
  const api = () => game.modules.get(MOD).api;
  const setting = (k) => game.settings.get(MOD, k);

  // ---------- уборка (аварийная: window.__afL1Rogue = {cleanOnly: true}) ----------
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name) || test(game.scenes.get(x.sceneId)?.name)))) await c.delete().catch(() => {});
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const sceneIds = new Set(scenes.map((s) => s.id));
    const msgIds = new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene)).map((m) => m.id)]);
    const ids = [...msgIds].filter((id) => game.messages.has(id));
    if (ids.length) await ChatMessage.deleteDocuments(ids).catch(() => {});
    for (const s of scenes) await s.delete().catch(() => {});   // регионы и их поведения уходят вместе со сценой
    for (const a of game.actors.filter((a) => test(a.name))) await a.delete().catch(() => {});
    return game.actors.filter((a) => test(a.name)).length + game.scenes.filter((s) => test(s.name)).length;
  };
  if (opts.cleanOnly) {
    for (const [k, v] of Object.entries(window.__afL1RogueModesPrev ?? {})) await game.settings.set(MOD, k, v).catch(() => {});
    delete window.__afL1RogueModesPrev;
    return { left: await sweep() };
  }

  // ---------- общее окружение прогона ----------
  const prevScene = game.scenes.viewed, prevCombat = game.combats.viewed;
  const pfSet = game.user.flags.pf2e?.settings ?? {};
  const origFlags = { showCheckDialogs: pfSet.showCheckDialogs, showDamageDialogs: pfSet.showDamageDialogs };
  const tbPrev = game.settings.get(MOD, "useToolbeltTargetHelper");
  const MODES = ["mode.effect", "mode.apply", "mode.challenge"], modesPrev = window.__afL1RogueModesPrev ?? Object.fromEntries(MODES.map((k) => [k, game.settings.get(MOD, k)]));
  window.__afL1RogueModesPrev = modesPrev;   // обрыв прогона: cleanOnly вернёт режимы
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 160)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };

  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    const idx = await p.getIndex({ fields: ["system.slug"] });
    const e = idx.find((i) => i.system?.slug === slug);
    if (!e) throw new Error(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(e._id)).toObject();
  };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null, pick: null };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна: наши .paf-dialog: e.pick = подпись варианта choose (или data-action кнопки), иначе закрываются (отмена); ChoiceSet pf2e — первый вариант; окна бросков pf2e — жмём «Бросок»
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          const opts = [...(el.querySelector("select[name=choice]")?.options ?? [])].map((o) => o.textContent.trim()), acts = [...el.querySelectorAll("button[data-action]")].map((b) => b.dataset.action);
          e.dialogs.push(`${el.querySelector(".window-title")?.textContent?.trim() ?? el.id}: ${opts.length ? opts.join(" / ") : acts.join(" / ")}`);
          // окно choose модуля — список <select name=choice> + «ok» (apply.mjs choiceHtml): e.pick — подпись варианта; иначе кнопка data-action
          const sel = el.querySelector("select[name=choice]"), o = sel && e.pick != null ? [...sel.options].find((x) => x.textContent.includes(e.pick)) : null;
          const b = !sel && e.pick != null ? el.querySelector(`button[data-action="${e.pick}"]`) : null;
          if (o) { sel.value = o.value; el.querySelector("button[data-action=ok]")?.click(); } else if (b) b.click(); else foundry.applications.instances.get(el.id)?.close();
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
    e.foe = async (name, extra = {}) => {
      const a = await e.add({ ...foundry.utils.mergeObject((await fromUuid(GOBLIN)).toObject(), extra), name });
      await a.update({ "system.attributes.hp.value": a.hitPoints.max });
      return a;
    };
    e.pc = async (name) => {
      const a = await e.add({ name, type: "character", system: { details: { alliance: "party", languages: { value: ["common"] } } } });
      await a.createEmbeddedDocuments("Item", [await find("pf2e.ancestries", "human")]);
      await a.update({ "system.attributes.hp.value": a.hitPoints.max });
      return a;
    };
    e.tok = async (a, x, y, disposition) => {
      live();
      const [t] = await e.scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition }]);
      return t;
    };
    e.T = (t) => e.scene.tokens.get(t.id);
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: проверки и выдача предметов — на этом актёре
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
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug) ?? null;
    e.strike = (a) => a.system.actions.find((s) => s.item?.isMelee);
    /** Копия документа из компендиума по uuid; _stats.compendiumSource ставится явно — по нему модуль находит правило каталога. */
    e.catalog = async (actor, uuid, patch = (d) => d) => {
      live();
      const doc = await fromUuid(uuid).catch(() => null);
      if (!doc) throw new Skip(`нет в паках: ${uuid}`);
      const d = doc.toObject(); delete d._id;
      d._stats = { ...d._stats, compendiumSource: uuid };
      const [it] = await actor.createEmbeddedDocuments("Item", [patch(d)]);
      const r = api().resolveRule(it);
      if (r?.source !== "catalog") throw new Skip(`source=${r?.source}`);
      return it;
    };
    /** Карточка предмета в чате (со снимком use модуля) -> сообщение; DOM блока модуля виден. */
    e.card = async (item) => {
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
      if (!m) throw new Error(`у карточки «${item.name}» нет снимка use (правило не найдено или модуль не слушает)`);
      await waitFor(() => e.dom(m)?.querySelector(".pf2e-automato"), 6000);
      return game.messages.get(m.id);
    };
    /** Предмет-действие с правилом -> карточка модуля со снимком use после done. */
    e.fire = async (item, att, ...targets) => {
      await e.aim(att, ...targets);
      const m = await e.card(item);
      if (e.use(m).src !== "catalog") throw new Skip(`снимок use: src=${e.use(m).src}`);
      if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
      await waitFor(() => e.use(m)?.state?.done, 10000);
      return game.messages.get(m.id);
    };
    /** Только карточка предмета (pf2e-сообщение с origin) — для afterUse снимок use не нужен. */
    e.pf2eCard = async (item, att, ...targets) => {
      await e.aim(att, ...targets);
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid), 8000);
      if (!m) throw new Error(`карточка «${item.name}» не появилась в чате`);
      await wait(700);   // timestamp карточки строго раньше броска
      return m;
    };
    e.hit = async (att, def) => {   // первый ближний Удар att по токену def; сообщение атаки
      await e.aim(att, def);
      const t0 = e.since(), s = e.strike(e.A(att));
      if (!s) throw new Error("у атакующего нет ближнего Удара");
      await bound("бросок Удара (variants[0].roll)", s.variants[0].roll({ event: SHIFT() }));
      return waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "attack-roll"), 8000);
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
  const OK_DEG = ["success", "criticalSuccess"];
  const outcome = (m) => m?.flags?.pf2e?.context?.outcome;

  const FX = (id) => `Compendium.pf2e-automato.effects.Item.${id}`;
  const MM = FX("MstrmindOffGrd01"), SCN = FX("ScndrlOffGuard01"), OXN = FX("OvrxtFeintNext01");
  const HERO = (name) => game.actors.find((a) => a.name === name && a.folder?.name === "Герои 1 ур. (автоматизация)");
  /** Временная копия героя из папки «Герои 1 ур.» (сам герой не трогается). */
  const heroCopy = async (e, name) => {
    const h = HERO(name);
    if (!h) throw new Skip(`нет героя «${name}»`);
    const d = h.toObject(); delete d._id; delete d.folder;
    const a = await e.add({ ...d, name });
    await a.update({ "system.attributes.hp.value": a.hitPoints.max });
    return a;
  };
  const effs = (a, uuid) => a.itemTypes.effect.filter((i) => i._stats?.compendiumSource === uuid);
  const markOf = (i) => i?.system?.rules?.find((r) => r.key === "TokenMark")?.uuid ?? null;
  const showEffs = (a, uuid) => effs(a, uuid).map((i) => `${markOf(i)?.split(".").pop()}:${i.system.duration.value}${i.system.duration.unit}`).join(",") || "—";
  /** Ближний Удар att по def с фиксированным d20 -> опции контекста броска. */
  const strikeOpts = async (e, att, def, d20 = 10) => {
    await e.fix(d20);
    const m = await e.hit(att, def);
    if (!m) throw new Error("нет сообщения атаки");
    await wait(1200);
    return m.flags.pf2e.context.options ?? [];
  };
  /** Действие pf2e (SingleCheckAction) от актёра токена att по цели def; dc — фиксированная СЛ или null (по цели). -> сообщение броска. */
  const act = async (e, slug, att, def, d20, dc, extra = {}) => {
    await e.aim(att, def);
    await e.fix(d20);
    const t0 = e.since();
    await bound(`action ${slug}`, game.pf2e.actions.get(slug).use({ actors: [e.A(att)], ...(dc != null && { difficultyClass: { value: dc } }), ...extra }));
    const m = await waitFor(() => e.msgs(t0).find((x) => (x.flags?.pf2e?.context?.options ?? []).some((o) => o === `action:${slug}` || o.startsWith(`action:${slug}:`))), 10000);
    if (!m) throw new Error(`нет сообщения ${slug}`);
    await wait(2500);
    return game.messages.get(m.id);
  };
  const statMod = (a, stat) => a.skills?.[stat]?.mod ?? a.getStatistic?.(stat)?.mod;

  sc("mastermind", "Организатор: RK по двум врагам — два эффекта с метками; крит по первому — 1 минута; off-guard только против помеченных; провал — ничего", async (e, t) => {
    const r = await heroCopy(e, "Мерисиэль (плут-организатор)"), g1 = await e.foe("гоблин 1"), g2 = await e.foe("гоблин 2"), g3 = await e.foe("гоблин 3");
    const tR = await e.tok(r, 500, 500, 1), t1 = await e.tok(g1, 600, 500, -1), t2 = await e.tok(g2, 600, 600, -1), t3 = await e.tok(g3, 400, 500, -1);
    await wait(700);
    const m = statMod(e.A(tR), "society");
    if (!Number.isFinite(m)) throw new Skip(`нет модификатора Общества: ${m}`);
    // СЛ — опознания цели (pf2e RecallKnowledgeActionVariant берёт её у цели, если СЛ не задана): так в сообщении есть цель
    const idc = e.A(t1).identificationDCs?.standard?.dc;
    if (!Number.isFinite(idc)) throw new Skip(`нет СЛ опознания: ${idc}`);
    const dS = Math.max(2, Math.min(19, idc - m)), dC = idc - m + 10 <= 19 ? Math.max(2, idc - m + 10) : 20;   // не хватает до крита — натуральная 20 (успех +1)
    const s1 = await act(e, "recall-knowledge", tR, t1, dS, null, { statistic: "society" });
    t.ok(s1.flags.pf2e.context.outcome === "success", `RK 1: ${s1.flags.pf2e.context.outcome} (d20 ${dS}, мод ${m}, СЛ ${idc})`);
    if (window.__afL1Rogue?.debug) t.ok(false, `DEBUG ctx: type=${s1.flags.pf2e.context.type} target=${JSON.stringify(s1.flags.pf2e.context.target)} opts=${(s1.flags.pf2e.context.options ?? []).filter((o) => /action|target$|secret/.test(o)).join(",")} events=${JSON.stringify(s1.flags[MOD]?.events ?? null).slice(0, 300)} blind=${s1.blind} whisper=${s1.whisper.length}`);
    t.ok(!!(await waitFor(() => effs(e.A(tR), MM).length === 1, 6000)), `эффект после RK 1: ${showEffs(e.A(tR), MM)}`);
    t.ok(markOf(effs(e.A(tR), MM)[0]) === e.T(t1).uuid, `метка на гоблине 1: ${showEffs(e.A(tR), MM)}`);
    await act(e, "recall-knowledge", tR, t2, dS, null, { statistic: "society" });
    t.ok(!!(await waitFor(() => effs(e.A(tR), MM).length === 2, 6000)), `второй враг — второй эффект: ${showEffs(e.A(tR), MM)}`);
    const c = await act(e, "recall-knowledge", tR, t1, dC, null, { statistic: "society" });
    t.ok(c.flags.pf2e.context.outcome === "criticalSuccess", `RK крит: ${c.flags.pf2e.context.outcome}`);
    const on1 = await waitFor(() => { const l = effs(e.A(tR), MM).filter((i) => markOf(i) === e.T(t1).uuid); return l.length === 1 && l[0].system.duration.unit === "minutes"; }, 6000);
    t.ok(!!on1 && effs(e.A(tR), MM).length === 2, `по гоблину 1 один эффект на минуту, всего 2: ${showEffs(e.A(tR), MM)}`);
    const o1 = await strikeOpts(e, tR, t1), o3 = await strikeOpts(e, tR, t3);
    t.ok(o1.includes("target:condition:off-guard"), "Удар по помеченному — цель застигнута врасплох");
    t.ok(!o3.includes("target:condition:off-guard"), "Удар по непомеченному — без off-guard");
    const f = await act(e, "recall-knowledge", tR, t3, 1, null, { statistic: "society" });
    t.ok(["failure", "criticalFailure"].includes(f.flags.pf2e.context.outcome) && effs(e.A(tR), MM).length === 2, `провал RK — эффекта нет (${f.flags.pf2e.context.outcome}; ${showEffs(e.A(tR), MM)})`);
  });

  sc("scoundrel", "Пройдоха: успешный Финт — эффект с меткой до конца следующего хода, off-guard только к ближним атакам плута; подсказка Шага", async (e, t) => {
    const r = await heroCopy(e, "Мерисиэль (плут-пройдоха)"), g = await e.foe("гоблин"), ally = await heroCopy(e, "Мерисиэль (плут-вор)");
    const tR = await e.tok(r, 500, 500, 1), tG = await e.tok(g, 600, 500, -1), tA = await e.tok(ally, 600, 600, 1);
    await wait(700);
    e.pick = "Обычный Финт";   // окно Вовлекающего финта — обычный Финт (подпись варианта)
    const per = e.A(tG).perception.dc.value, m = statMod(e.A(tR), "deception");
    const d20 = Math.max(2, Math.min(19, per - m));   // итог ровно СЛ — успех
    const t0 = e.since();
    const f = await act(e, "feint", tR, tG, d20, null);
    if (f.flags.pf2e.context.outcome !== "success") throw new Skip(`нужен успех Финта: ${f.flags.pf2e.context.outcome} (d20 ${d20}, мод ${m}, СЛ ${per})`);
    const ef = await waitFor(() => effs(e.A(tR), SCN)[0], 6000);
    t.ok(!!ef && markOf(ef) === e.T(tG).uuid, `эффект Пройдохи с меткой на гоблине: ${showEffs(e.A(tR), SCN)}`);
    t.ok(ef?.system.duration.value === 1 && ef?.system.duration.expiry === "turn-end", `срок 1 раунд до конца хода: ${JSON.stringify(ef?.system.duration)}`);
    t.ok(!e.cond(e.A(tG), "off-guard"), "на гоблине нет общего состояния off-guard");
    t.ok(!!(await waitFor(() => e.msgs(t0).some((x) => /Шагнуть/.test(x.content ?? "")), 4000)), "подсказка Шага пришла");
    t.ok(e.dialogs.length > 0, `окно выбора Вовлекающего финта было: [${e.dialogs}]`);
    const oR = await strikeOpts(e, tR, tG), oA = await strikeOpts(e, tA, tG);
    t.ok(oR.includes("target:condition:off-guard"), "ближний Удар плута — off-guard");
    t.ok(!oA.includes("target:condition:off-guard"), "Удар союзника — без off-guard");
  });

  sc("overextending", "Вовлекающий финт: «overextend» — штраф −2 только к атакам цели по плуту, снимается первой атакой; обычного исхода нет", async (e, t) => {
    const r = await heroCopy(e, "Мерисиэль (плут-пройдоха)"), g = await e.foe("гоблин"), ally = await heroCopy(e, "Мерисиэль (плут-вор)");
    const tR = await e.tok(r, 500, 500, 1), tG = await e.tok(g, 600, 500, -1), tA = await e.tok(ally, 600, 600, 1);
    await wait(700);
    e.pick = "Вовлекающий финт";
    const per = e.A(tG).perception.dc.value, m = statMod(e.A(tR), "deception");
    const d20 = Math.max(2, Math.min(19, per - m));
    const f = await act(e, "feint", tR, tG, d20, null);
    if (f.flags.pf2e.context.outcome !== "success") throw new Skip(`нужен успех Финта: ${f.flags.pf2e.context.outcome}`);
    const ef = await waitFor(() => effs(e.A(tG), OXN)[0], 6000);
    if (window.__afL1Rogue?.debug) t.ok(false, `DEBUG dialogs=[${e.dialogs}] goblin=[${e.A(tG).items.filter((i) => ["effect", "condition"].includes(i.type)).map((i) => i.slug)}] rogue=[${e.A(tR).itemTypes.effect.map((i) => i.slug)}] use=${JSON.stringify(f.flags[MOD]?.use?.state?.challenge?.applied ?? f.flags[MOD]?.use?.state ?? null).slice(0, 400)} notes=${notes.slice(0, 3)}`);
    t.ok(!!ef, "на гоблине эффект Вовлекающего финта");
    t.ok(markOf(ef) === e.T(tR).uuid, `метка на токене плута: ${markOf(ef)} vs ${e.T(tR).uuid}`);
    t.ok(!e.cond(e.A(tG), "off-guard") && !effs(e.A(tR), SCN).length, "обычный исход не применён (нет off-guard и эффекта Пройдохи)");
    const pen = (msg) => (msg?.flags?.pf2e?.modifiers ?? []).filter((x) => x.modifier === -2 && x.type === "circumstance" && x.enabled !== false).length > 0;
    await e.fix(10); const m1 = await e.hit(tG, tA); await wait(1500);
    t.ok(!pen(m1), "атака гоблина по союзнику — без штрафа");
    t.ok(effs(e.A(tG), OXN).length === 1, "атака по другому не снимает эффект");
    await e.fix(10); const m2 = await e.hit(tG, tR); await wait(2500);
    t.ok(pen(m2), `атака гоблина по плуту — штраф −2: ${(m2?.flags?.pf2e?.modifiers ?? []).map((x) => `${x.label}${x.modifier}`).join(",")}`);
    t.ok(!!(await waitFor(() => !effs(e.A(tG), OXN).length, 6000)), "после атаки по плуту эффект снят");
  });

  const YN = "Compendium.pf2e.feats-srd.Item.gjec0ts3wkFbjvHN";
  /** Урон Ударом att по def и применение кнопкой чата pf2e (токен def выделен). -> сообщение damage-taken | null */
  const killBlow = async (e, att, def) => {
    await e.aim(att, def); await e.fix(15);
    const s = e.strike(e.A(att)), t0 = e.since();
    await bound("бросок урона", s.damage({ event: SHIFT() }));
    const dm = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "damage-roll"), 8000);
    if (!dm) throw new Error("нет сообщения урона");
    await wait(800);
    e.T(def).object.control({ releaseOthers: true }); await wait(300);
    const t1 = e.since();
    const btn = await waitFor(() => e.dom(dm)?.querySelector("button[data-action=apply-damage]"), 4000);
    if (btn) btn.click(); else await bound("applyDamage", e.A(def).applyDamage({ damage: dm.rolls[0], token: e.T(def), item: dm.item, rollOptions: new Set(dm.flags.pf2e.context?.options ?? []) }));
    return waitFor(() => e.msgs(t1).find((x) => x.flags?.pf2e?.appliedDamage), 6000);
  };

  sc("youre-next", "Ты следующий: враг упал до 0 от урона плута — окно выбора врага в 60 фт (без упавшего и дальнего), Деморализация с +2 по выбранному, реакция потрачена; второй враг на 0 в том же раунде — окна нет", async (e, t) => {
    const r = await heroCopy(e, "Мерисиэль (плут-вор)");
    const g1 = await e.foe("гоблин 1"), g2 = await e.foe("гоблин 2"), g3 = await e.foe("гоблин 3"), gFar = await e.foe("гоблин далеко");
    const tR = await e.tok(r, 500, 500, 1), t1 = await e.tok(g1, 600, 500, -1), t2 = await e.tok(g2, 500, 900, -1), t3 = await e.tok(g3, 400, 500, -1), tF = await e.tok(gFar, 2100, 500, -1);
    await wait(700);
    for (const [tk, n] of [[t1, "гоблин 1"], [t2, "гоблин 2"], [t3, "гоблин 3"], [tF, "гоблин далеко"]]) await e.T(tk).update({ name: n });   // окно выбора подписывает токенами
    await e.catalog(e.A(tR), YN);
    for (const tk of [t1, t3]) await e.A(tk).update({ "system.attributes.hp.value": 1 });
    const c = await Combat.create({ scene: e.scene.id, active: true });   // в бою реакция тратится флагом reactionSpent (вне боя — нет)
    await c.createEmbeddedDocuments("Combatant", [tR, t1, t2, t3, tF].map((tk, i) => ({ tokenId: tk.id, sceneId: e.scene.id, actorId: tk.actor.id, initiative: 30 - i })));
    await viewCombat(c);
    await c.startCombat(); await wait(1200);
    e.pick = "гоблин 2";
    const d0 = e.dialogs.length, t0 = e.since();
    const taken = await killBlow(e, tR, t1);
    t.ok(!!taken && e.A(t1).hitPoints.value === 0, `гоблин 1 на 0 ОЗ: ${e.A(t1).hitPoints.value}`);
    const host = await waitFor(() => e.msgs(t0).find((m) => e.use(m)?.state?.event && e.use(m)?.targets?.[0]?.uuid === e.T(t2).uuid), 15000);
    t.ok(e.dialogs.length > d0, `окно выбора было: [${e.dialogs.slice(d0)}]`);
    const opts = e.dialogs.slice(d0).join(" | ");
    t.ok(/гоблин 2/.test(opts) && /гоблин 3/.test(opts) && !/гоблин 1|далеко/.test(opts), `кандидаты — живые враги в 60 фт без упавшего: ${opts}`);
    t.ok(!!host, "карточка проверки по гоблину 2");
    if (host) {
      const btn = await waitFor(() => e.dom(host)?.querySelector(".pf2e-automato button[data-action=roll-save]:not([disabled])"), 6000);
      if (btn) btn.click();
      await waitFor(() => Object.keys(e.use(host)?.state?.challenge?.results ?? {}).length, 15000);
    }
    const roll = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "skill-check" && (m.flags.pf2e.context.options ?? []).includes("youre-next")), 8000);
    const mods = (roll?.flags?.pf2e?.modifiers ?? []).filter((x) => x.enabled !== false);
    t.ok(!!roll, "бросок Запугивания с опцией youre-next");
    t.ok(mods.some((x) => x.modifier === 2 && x.type === "circumstance"), `+2 обстоятельства: ${mods.map((x) => `${x.label}${x.modifier}`).join(",")}`);
    t.ok(!!(await waitFor(() => e.A(t2).itemTypes.condition.some((x) => x.slug === "frightened") || Object.values(e.use(host)?.state?.challenge?.results ?? {}).some((x) => x.degree < 2), 8000)), `гоблин 2: испуган или проверка не удалась [${e.A(t2).itemTypes.condition.map((x) => x.slug)}]`);
    t.ok(!!e.A(tR).getFlag(MOD, "reactionSpent"), `реакция потрачена: ${JSON.stringify(e.A(tR).getFlag(MOD, "reactionSpent"))}`);
    const d1 = e.dialogs.length, t2s = e.since();
    await wait(5500);   // дедуп пачки 5 с: второй удар — новое событие
    await killBlow(e, tR, t3);
    await wait(3000);
    t.ok(e.A(t3).hitPoints.value === 0, `гоблин 3 на 0 ОЗ: ${e.A(t3).hitPoints.value}`);
    t.ok(e.dialogs.length === d1 && !e.msgs(t2s).some((m) => e.use(m)?.state?.event), `реакция уже потрачена — окна и карточки нет: [${e.dialogs.slice(d1)}]`);
  });

  const ND = "Compendium.pf2e.feats-srd.Item.dNH8OHEvx3vI9NBQ", TBF = "Compendium.pf2e.feats-srd.Item.YKqMuuC8j35NFh92", TBE = FX("Vh5E1Qgp34sTKfVs");
  const circFx = async (a, v) => (await a.createEmbeddedDocuments("Item", [{ type: "effect", name: `AF тест: щит +${v}`, img: "icons/svg/shield.svg", system: { rules: [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: v }] } }]))[0];

  sc("nimble-dodge", "Ловкое уклонение: прирост с учётом circumstance к КБ (щит +1 → +1, щит +2 → нет подсказки), не видит атакующего — нет подсказки", async (e, t) => {
    const r = await heroCopy(e, "Мерисиэль (плут-вор)"), g = await e.foe("гоблин");
    const tR = await e.tok(r, 500, 500, 1), tG = await e.tok(g, 600, 500, -1);
    await wait(700);
    if (!e.A(tR).items.some((i) => i.slug === "nimble-dodge")) await e.catalog(e.A(tR), ND);
    const hints = (m) => game.messages.filter((x) => x.flags?.[MOD]?.reaction?.attack === m?.id);
    const shot = async (label) => { await e.fix(10); const m = await e.hit(tG, tR); await wait(2500); const h = hints(m); return { m, n: h.length, bonus: h[0]?.flags?.[MOD]?.reaction?.bonus }; };
    let s = await shot("чисто");
    t.ok(s.n === 1 && s.bonus === 2, `без щита — подсказка +2: n=${s.n} bonus=${s.bonus}`);
    const f1 = await circFx(e.A(tR), 1); await wait(500);
    t.ok(e.A(tR).armorClass.modifiers.some((m) => m.type === "circumstance" && m.modifier === 1), `armorClass.modifiers видит circumstance +1: ${e.A(tR).armorClass.modifiers.map((m) => `${m.type}${m.modifier}`).join(",")}`);
    s = await shot("щит +1");
    t.ok(s.n === 1 && s.bonus === 1, `щит +1 — прирост +1: n=${s.n} bonus=${s.bonus}`);
    await f1.delete(); const f2 = await circFx(e.A(tR), 2); await wait(500);
    s = await shot("щит +2");
    t.ok(s.n === 0, `щит +2 — подсказки нет: n=${s.n}`);
    await f2.delete(); await wait(300);
    await e.A(tG).increaseCondition("hidden"); await wait(500);
    s = await shot("скрыт");
    t.ok(s.n === 0, `атакующий скрыт — подсказки нет: n=${s.n}`);
    await e.A(tG).decreaseCondition("hidden", { forceRemove: true }); await e.A(tR).increaseCondition("blinded"); await wait(500);
    s = await shot("ослеплён");
    t.ok(s.n === 0, `плут ослеплён — подсказки нет: n=${s.n}`);
  });

  sc("tumble-behind", "Перекат за спину: успех Акробатического прохода — метка на враге; Удар и урон по другому врагу эффект не снимают; Удар по помеченному — off-guard, урон снимает", async (e, t) => {
    const r = await heroCopy(e, "Мерисиэль (плут-вор)"), g1 = await e.foe("гоблин 1"), g2 = await e.foe("гоблин 2");
    const tR = await e.tok(r, 500, 500, 1), t1 = await e.tok(g1, 600, 500, -1), t2 = await e.tok(g2, 500, 600, -1);
    await wait(700);
    if (!e.A(tR).items.some((i) => i.slug === "tumble-behind-rogue" || i.slug === "tumble-behind")) await e.catalog(e.A(tR), TBF);
    const tt = await act(e, "tumble-through", tR, t1, 19, null);
    t.ok(["success", "criticalSuccess"].includes(tt.flags.pf2e.context.outcome), `Акробатический проход: ${tt.flags.pf2e.context.outcome}`);
    const ef = await waitFor(() => effs(e.A(tR), TBE)[0], 6000);
    t.ok(!!ef && markOf(ef) === e.T(t1).uuid, `эффект с меткой на гоблине 1: ${showEffs(e.A(tR), TBE)}`);
    const o2 = await strikeOpts(e, tR, t2, 15);
    t.ok(!o2.includes("target:condition:off-guard"), "Удар по гоблину 2 — без off-guard");
    const dmgOn = async (def) => { await e.aim(tR, def); await e.fix(15); const t0 = e.since(); await bound("урон", e.strike(e.A(tR)).damage({ event: SHIFT() })); const dm = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "damage-roll"), 8000); await wait(2000); return dm; };
    const d2 = await dmgOn(t2);
    t.ok(!!d2 && effs(e.A(tR), TBE).length === 1, `урон по гоблину 2 — эффект на месте: ${showEffs(e.A(tR), TBE)}`);
    const o1 = await strikeOpts(e, tR, t1, 15);
    t.ok(o1.includes("target:condition:off-guard"), "Удар по гоблину 1 — off-guard");
    t.ok(o1.includes("target:mark:enemy-tumble-behind"), `в опциях атаки есть метка цели: ${o1.filter((o) => o.startsWith("target:mark")).join(",") || "—"}`);
    t.ok(effs(e.A(tR), TBE).length === 1, "попадание без урона — эффект ещё на месте (снимет урон)");
    const d1 = await dmgOn(t1);
    const dOpts = d1?.flags?.pf2e?.context?.options ?? [];
    t.ok(dOpts.includes("target:condition:off-guard"), "урон по гоблину 1 — с off-guard (скрытая атака)");
    t.ok(dOpts.includes("target:mark:enemy-tumble-behind"), `в опциях урона есть метка цели: ${dOpts.filter((o) => o.startsWith("target:mark")).join(",") || "—"}`);
    t.ok(!!(await waitFor(() => !effs(e.A(tR), TBE).length, 6000)), `урон по помеченному снял эффект: ${showEffs(e.A(tR), TBE)}`);
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами
    for (const k of MODES) if (modesPrev[k] !== "auto") await game.settings.set(MOD, k, "auto");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} level1-rogue | ${s.id}`, err); }
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
    for (const k of MODES) try { await game.settings.set(MOD, k, modesPrev[k]); } catch { /* ok */ }
    delete window.__afL1RogueModesPrev;
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  const table = rows.map((r) => `${r.id.padEnd(18)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afL1RogueResult = result;
  return result;
}

