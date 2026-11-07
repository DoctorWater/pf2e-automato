async () => {
  // Живые сценарии A21 Nymph's Grace (docs/plan-animist.md §3): копия Само, заклинание добавляется в «Focus Spells»; каркас — как у level1-animist.js,
  // окна выбора модуля отвечаются очередью e.answers.
  // Параметры: window.__afAnA21 = { only, skip, cleanOnly }. Результат — window.__afAnA21Result.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afAnA21 ?? {}) };
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

  // ---------- уборка (аварийная: window.__afAnA21 = {cleanOnly: true}) ----------
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
  const applyPrev = game.settings.get(MOD, "mode.apply");
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  const ceOrig = console.error;   // стек ошибок модуля (в уведомление попадает только сообщение)
  console.error = function (...a) { const er = a.find((x) => x instanceof Error); if (er) notes.push(`console.error: ${String(a[0]).slice(0, 80)} ${String(er.stack ?? er.message).replace(/\s+/g, " ").slice(0, 700)}`); return ceOrig.apply(this, a); };
  const onErr = (ev) => { const er = ev.error ?? ev.reason; notes.push(`uncaught: ${String(er?.stack ?? er?.message ?? ev.message).replace(/\s+/g, " ").slice(0, 700)}`); };
  window.addEventListener("error", onErr); window.addEventListener("unhandledrejection", onErr);
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
          const sel = el.querySelector("select[name=choice]"), opts = sel ? [...sel.options].map((o) => `${o.value}=${o.textContent.trim()}`) : [];
          e.dialogs.push(`${el.querySelector(".window-title")?.textContent?.trim() ?? el.id}: ${opts.join(" / ")}`);
          const want = e.answers?.length ? e.answers.shift() : null, o = sel && want != null ? [...sel.options].find((x) => x.value === want || x.textContent.toLowerCase().includes(String(want).toLowerCase())) : null;
          if (o) { sel.value = o.value; el.querySelector("button[data-action=ok]")?.click(); } else foundry.applications.instances.get(el.id)?.close();
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
      await wait(2500);   // модуль ещё дописывает флаги/эффекты карточек: сцену удаляем после, иначе «Scene … does not exist»
      for (const c of game.combats.filter((c) => c.scene?.id === e.scene.id)) await c.delete().catch(() => {});   // бой — до ухода со сцены и до её удаления
      if (prevScene && prevScene.id !== e.scene.id && game.scenes.has(prevScene.id)) { await prevScene.view().catch(() => {}); await wait(1000); }   // холст не должен рисовать удаляемую сцену
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


  // ---------- A21 Nymph's Grace (docs/plan-animist.md §3): аура 10 фт под Поддержанием, Воля при входе / начале хода, раз в раунд ----------
  // Окружение как у level1-animist.js: копия «Само (анимист)», заклинание добавляется в «Focus Spells». Токены: Само (500,500), союзник (600,500), гоблин: IN (700,500) = 5 фт, OUT (1200,500) = 30 фт.
  // Нужны режимы mode.challenge = button/auto и mode.apply = auto: NPC бросает сам, степень применяется сама.
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const dropPack = async () => {};
  const HERO = (name) => game.actors.find((a) => a.name === name && a.folder?.name === "Герои 1 ур. (автоматизация)");
  const heroCopy = async (e, name) => {
    const h = HERO(name);
    if (!h) throw new Skip(`нет героя «${name}»`);
    const d = h.toObject(); delete d._id; delete d.folder;
    const a = await e.add({ ...d, name });
    await a.update({ "system.attributes.hp.value": a.hitPoints.max });
    return a;
  };
  const anchors = (a) => a.itemTypes.effect.filter((i) => i.flags?.[MOD]?.meta?.source === "sustain");
  const withAnswers = async (e, labels, f) => { const d0 = e.dialogs.length; e.answers = [...labels]; await f(); await wait(2500); const n = e.dialogs.length - d0; e.answers = []; return { n, seen: e.dialogs.slice(d0) }; };
  const next = async (c, label) => { await bound(label, c.nextTurn()); await wait(2500); };
  const turnTo = async (c, a, n = 4) => { for (let i = 0; i < n && c.combatant?.actor?.uuid !== a.uuid; i++) { await next(c, "ход"); } return c.combatant?.actor?.uuid === a.uuid; };
  const hexPress = async (e, anc, how) => {
    const key = anc.flags[MOD].meta.key;
    const m = await waitFor(() => game.messages.contents.findLast((x) => x.flags?.[MOD]?.sustain?.key === key), 6000);
    const b = m && await waitFor(() => e.dom(m)?.querySelector(`[data-af-sustain="${how}"]`), 6000);
    if (!b) throw new Error(`нет кнопки ${how} в шёпоте якоря`);
    b.click(); await wait(2500);
  };

  const NY = "Compendium.pf2e.spells-srd.Item.SAmyaiVKTDrUNjot", AURA_FX = "Compendium.pf2e-automato.effects.Item.NymphGraceAura01";
  const IN = [700, 500], OUT = [1200, 500];
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const nySetup = async (e, { ally = false, goblinIn = false } = {}) => {
    try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ }
    needMode("mode.challenge", "off");
    const A0 = await heroCopy(e, "Само (анимист)"), g = await e.foe("гоблин");
    const tA = await e.tok(A0, 500, 500, 1), tG = await e.tok(g, ...(goblinIn ? IN : OUT), -1);
    let tAl = null;
    if (ally) tAl = await e.tok(await e.pc("союзник"), 600, 500, 1);
    await wait(700);
    const A = e.A(tA), G = e.A(tG), AL = tAl ? e.A(tAl) : null;
    let spell = A.itemTypes.spell.find((s) => s._stats?.compendiumSource === NY || s.sourceId === NY);
    if (!spell) {
      const entry = A.spellcasting.find((s) => s.system?.prepared?.value === "focus") ?? A.spellcasting.contents.find((s) => s.isPrepared || s.isSpontaneous);
      if (!entry) throw new Skip("у Само нет записи колдовства");
      const o = (await fromUuid(NY)).toObject(); delete o._id;
      o._stats = { ...o._stats, compendiumSource: NY };
      o.system.location = { ...(o.system.location ?? {}), value: entry.id };
      [spell] = await A.createEmbeddedDocuments("Item", [o]);
    }
    const dc = spell.spellcasting.statistic.withRollOptions({ item: spell }).dc.value;
    await e.rig(G, "will", dc - 11 - G.saves.will.mod);   // d20 = 10 -> итог dc - 1: провал
    const toks = [tA, tG, ...(tAl ? [tAl] : [])];
    const c = await e.combat(toks, [20, 10, 5].slice(0, toks.length));
    await c.startCombat(); await wait(1200);
    await e.fix(10);
    return { A, G, AL, tA, tG, tAl, spell, c };
  };
  const nyCast = async (e, s) => {
    await e.aim(s.tA);
    await withAnswers(e, [], async () => {
      await bound("сотворение", s.spell.spellcasting.cast(s.spell, { consume: false }));
      await waitFor(() => s.A.itemTypes.effect.some((i) => i._stats?.compendiumSource === AURA_FX), 8000);
    });
  };
  const move = async (e, tok, [x, y]) => {
    const d = e.T(tok);
    if (d.move) await bound("token.move", d.move([{ x, y }], { constrainOptions: { ignoreWalls: true }, autoRotate: false }));
    else await bound("token.update", d.update({ x, y }, { animate: false }));
    await wait(1500);
  };
  /** Карточки испытания ауры после t0 (ключ trg:…) по токену цели. */
  const hosts = (e, t0, tok = null) => e.msgs(t0).filter((m) => String(m.flags?.[MOD]?.use?.state?.event ?? "").startsWith("trg:") && (!tok || m.flags[MOD].use.targets?.[0]?.key === tok.id));
  const confused = (a) => a.itemTypes.condition.some((c) => c.slug === "confused");

  sc("an-a21-enter", "A21: вход врага в ауру — Воля, провал = confused; без якоря (до сотворения) запись молчит", async (e, t) => {
    const s = await nySetup(e);
    t.ok(await turnTo(s.c, s.A), "ход Само");
    const t0 = e.since();
    await move(e, s.tG, IN); await move(e, s.tG, OUT);
    t.ok(hosts(e, t0, s.tG).length === 0, `до сотворения вход без карточки (${hosts(e, t0, s.tG).length})`);
    await nyCast(e, s);
    t.ok(await waitFor(() => anchors(s.A).length === 1, 6000), "якорь Поддержания у Само");
    t.ok(s.A.itemTypes.effect.filter((i) => i._stats?.compendiumSource === AURA_FX).length === 1, "метка ауры у Само");
    const t1 = e.since();
    await move(e, s.tG, IN);
    t.ok(await waitFor(() => hosts(e, t1, s.tG).length === 1, 8000), `вход: одна карточка (${hosts(e, t1, s.tG).length})`);
    t.ok(await waitFor(() => Object.values(e.results(hosts(e, t1, s.tG)[0])).length > 0, 20000), "гоблин бросил Волю");
    t.ok(await waitFor(() => confused(s.G), 8000), "провал: confused у гоблина");
    t.ok(!confused(s.A), "Само не confused");
  });

  sc("an-a21-start", "A21: враг уже в ауре — начало его хода даёт Волю, провал = confused", async (e, t) => {
    const s = await nySetup(e, { goblinIn: true });
    t.ok(await turnTo(s.c, s.A), "ход Само");
    const t0 = e.since();
    await nyCast(e, s);
    await wait(2000);
    t.ok(hosts(e, t0, s.tG).length === 0, `сотворение при враге внутри не входит и хода не начинает: карточек ${hosts(e, t0, s.tG).length}`);
    await next(s.c, "конец хода Само");
    t.ok(s.c.combatant?.actor?.uuid === s.G.uuid, "ход гоблина");
    t.ok(await waitFor(() => hosts(e, t0, s.tG).length === 1, 8000), `начало хода: одна карточка (${hosts(e, t0, s.tG).length})`);
    t.ok(await waitFor(() => confused(s.G), 20000), "провал: confused у гоблина");
  });

  sc("an-a21-once", "A21: раз в раунд на цель — выход/вход и начало хода в том же раунде без второго броска; следующий раунд — снова", async (e, t) => {
    const s = await nySetup(e);
    t.ok(await turnTo(s.c, s.A), "ход Само");
    await nyCast(e, s);
    const t0 = e.since();
    await move(e, s.tG, IN);
    t.ok(await waitFor(() => hosts(e, t0, s.tG).length === 1, 8000), "вход: карточка 1");
    await move(e, s.tG, OUT); await move(e, s.tG, IN);
    t.ok(hosts(e, t0, s.tG).length === 1, `выход и вход в раунде 1: без второй (${hosts(e, t0, s.tG).length})`);
    await next(s.c, "конец хода Само");
    t.ok(s.c.combatant?.actor?.uuid === s.G.uuid, "ход гоблина");
    await wait(1500);
    t.ok(hosts(e, t0, s.tG).length === 1, `начало хода в том же раунде: без второй (${hosts(e, t0, s.tG).length})`);
    await next(s.c, "конец хода гоблина");
    t.ok(s.c.round === 2 && s.c.combatant?.actor?.uuid === s.A.uuid, `раунд 2, ход Само: r${s.c.round}`);
    await hexPress(e, anchors(s.A)[0], "support");
    await next(s.c, "конец хода Само R2");
    t.ok(await waitFor(() => hosts(e, t0, s.tG).length === 2, 8000), `раунд 2: начало хода — вторая карточка (${hosts(e, t0, s.tG).length})`);
  });

  sc("an-a21-friends", "A21: автор и союзник — не цели (ни вход, ни начало хода)", async (e, t) => {
    const s = await nySetup(e, { ally: true });
    t.ok(await turnTo(s.c, s.A), "ход Само");
    await nyCast(e, s);
    const t0 = e.since();
    await move(e, s.tAl, OUT); await move(e, s.tAl, [600, 500]);
    await next(s.c, "конец хода Само"); await next(s.c, "конец хода гоблина");
    t.ok(s.c.combatant?.actor?.uuid === s.AL.uuid, "ход союзника (внутри ауры)");
    await next(s.c, "конец хода союзника");
    t.ok(s.c.round === 2 && s.c.combatant?.actor?.uuid === s.A.uuid, "раунд 2, ход Само (в своей ауре)");
    await wait(1500);
    t.ok(hosts(e, t0).length === 0, `карточек испытания нет (${hosts(e, t0).length})`);
    t.ok(!confused(s.AL) && !confused(s.A), "ни союзник, ни Само не confused");
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами
    await game.settings.set(MOD, "mode.apply", "auto");   // степень применяется сама; прежнее значение вернём в finally
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} level1-an-a21 | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      // ошибки консоли и необработанные отказы — со стеком в FAIL (ждали: сообщения модуля пишутся уже после сценария)
      const errs = notes.filter((n) => /^(console\.error|uncaught)/.test(n));
      if (errs.length) { status = "fail"; detail += ` | ошибки: ${errs.slice(0, 3).join(" / ")}`; }
      else if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 4).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    console.error = ceOrig;
    window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr);
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await game.settings.set(MOD, "mode.apply", applyPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await dropPack();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afAnA21Result = out;
  return out;
}
