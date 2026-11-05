async () => {
  // Живые сценарии анимиста 1 уровня, первая партия (docs/plan-animist.md, docs/plan-sustain-pulse.md): копия Само, недостающий сосуд добавляется в «Focus Spells»; каркас и хелперы — как у level1-hexes,
  // окна выбора модуля отвечаются очередью e.answers (подпись или значение варианта; null — закрыть).
  // Параметры: window.__afL1An = { only, skip, cleanOnly }. Результат — window.__afL1AnResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL1An ?? {}) };
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

  // ---------- уборка (аварийная: window.__afL1An = {cleanOnly: true}) ----------
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

  // ---------- сценарии level1-familiar: способность фамильяра ведьмы (docs/plan-familiar.md) ----------
  // Только сценарии (без каркаса): вставляются в level1-familiar.js по образцу level1-sustain.js. Хелперы e.* и waitFor/bound/Skip — оттуда же.
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const dropPack = async () => {};
  const FAM_PREFIX = "AF тест: ";
  const FA = { WF01: "6ZmgkMHUGGb1mDhr", WF06: "HNoR0D2sKQaDNh5Z", WF07: "J5Wyh1EPmk848ivR", WF09: "ZCze1FY3Rmnvd6Dx", WF10: "bhpa7DVdMsaNfodz" };
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
  const mine = (a, uuid) => a.itemTypes.effect.filter((i) => i._stats?.compendiumSource === uuid);
  const wrapped = (a, slug) => a.itemTypes.effect.filter((i) => (i.system.rules ?? []).some((r) => r.key === "GrantItem" && String(r.uuid).endsWith(slug)));
  const FE = (id) => `Compendium.pf2e.feat-effects.Item.${id}`;

  /** Ответы окнам выбора модуля: очередь e.answers (подпись/значение варианта; null — закрыть), отвечает каркас. -> число окон за время f */
  const withAnswers = async (e, labels, f) => { const d0 = e.dialogs.length; e.answers = [...labels]; await f(); await wait(2500); const n = e.dialogs.length - d0; e.answers = []; return { n, seen: e.dialogs.slice(d0) }; };
  /** Копия Фейи + временный фамильяр с способностью wf из familiar-abilities; токены: Фейя (500,500), фамильяр (600,500), гоблин (700,500). */
  const setup = async (e, wf, { foe = true, inits = [20, 10] } = {}) => {
    try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ }
    const w = await heroCopy(e, "Фейя (ведьма)");
    const f = await e.add({ name: "фамильяр", type: "familiar", system: { master: { id: w.id } } });
    const src = await fromUuid(`Compendium.pf2e.familiar-abilities.Item.${FA[wf]}`);
    if (!src) throw new Skip(`нет способности ${wf}`);
    const d = src.toObject(); delete d._id; d._stats = { ...d._stats, compendiumSource: src.uuid };
    const [ab] = await f.createEmbeddedDocuments("Item", [d]);   // ГМ-копия: где её на самом деле кладёт GrantItem — сверить отдельно (шаг 0 плана)
    const tW = await e.tok(w, 500, 500, 1), tF = await e.tok(f, 600, 500, 1);
    const g = foe ? await e.foe("гоблин") : null, tG = g ? await e.tok(g, 700, 500, -1) : null;
    await wait(700);
    const W = e.A(tW), F = e.A(tF), G = tG ? e.A(tG) : null;
    const spells = W.itemTypes.spell;
    const evil = spells.find((s) => s.slug === "evil-eye"), plain = spells.find((s) => s.isCantrip && !s.traits.has("hex"));
    if (!evil) throw new Skip("у Фейи нет Evil Eye");
    const c = tG ? await e.combat([tW, tG], inits) : null;
    if (c) { await c.startCombat(); await wait(1200); }
    return { W, F, G, tW, tF, tG, ab, evil, plain, c };
  };
  const castOn = async (e, s, spell = s.evil, aimAt = s.tG) => {
    await e.aim(s.tW, aimAt); await e.fix(10);
    await bound("сотворение", spell.spellcasting.cast(spell, { consume: false }));
  };
  const next = async (c, label) => { await bound(label, c.nextTurn()); await wait(2500); };
  const turnTo = async (c, a, n = 4) => { for (let i = 0; i < n && c.combatant?.actor?.uuid !== a.uuid; i++) { await next(c, "ход"); } return c.combatant?.actor?.uuid === a.uuid; };

  // ---------- сценарии наговоров ведьмы, первая партия (docs/plan-hexes.md) ----------
  // Только тела sc(...) и свои хелперы: вставляются в каркас level1-familiar.js / level1-sustain.js (там есть S, sc, e.*, waitFor, bound, Skip, MOD, wait,
  // heroCopy, anchors, turnTo, next, withAnswers, DEG/deg). Наговор — по гоблину; Фейя — копия «Фейя (ведьма)», недостающий наговор добавляется в её запись колдовства.
  const HX = {
    W35: ["BItahht2hEHvR9Bt", "fortitude"], W23: ["PesUKf0lIt5zRofj", "will"], W22: ["MraZBLJ4Be3ogmWL", "reflex"], W31: ["GeUbPvwdZ4B4l0up", null],
    W24: ["UmXhuKrYZR3W16mQ", null], W33: ["TRlI5zAbNW2hDiH9", null], W25: ["4U2ZV1v38D0y2CRl", "fortitude"], W21: ["f45JpY7Ph2cAJGW2", "will"], W26: ["VNv96dJPi0WXKSFN", "will"]
  };
  const PA = "Compendium.pf2e-automato.effects.Item.", SE = "Compendium.pf2e.spell-effects.Item.";
  const DEGREE_MOD = { criticalSuccess: 0, success: -10, failure: -11, criticalFailure: -20 };   // итог при d20 = 10: mod + 10 (если каркас уже объявил — удалить)
  const fx = (a, uuid) => a.itemTypes.effect.filter((i) => i._stats?.compendiumSource === uuid);
  const cnd = (a, slug) => a.itemTypes.condition.filter((c) => c.slug === slug);
  const val = (a, slug) => Math.max(0, ...cnd(a, slug).map((c) => c.value ?? 1));
  const hasFx = (a, uuid) => fx(a, uuid).length > 0;

  /** Фейя (копия) + гоблин, бой [Фейя, гоблин]; наговор wx из HX в записи колдовства; спасбросок гоблина подкручен под степень deg (по СЛ колдовства). */
  const hexSetup = async (e, wx, deg = "failure", inits = [20, 10]) => {
    try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ }
    const [id, stat] = HX[wx], uuid = `Compendium.pf2e.spells-srd.Item.${id}`;
    const w = await heroCopy(e, "Фейя (ведьма)"), g = await e.foe("гоблин");
    const tW = await e.tok(w, 500, 500, 1), tG = await e.tok(g, 600, 500, -1);
    await wait(700);
    const W = e.A(tW), G = e.A(tG);
    let spell = W.itemTypes.spell.find((s) => s._stats?.compendiumSource === uuid || s.sourceId === uuid);
    if (!spell) {
      const entry = W.spellcasting.regular[0] ?? W.spellcasting.contents.find((s) => s.isPrepared || s.isSpontaneous);
      if (!entry) throw new Skip("у Фейи нет записи заклинаний");
      const o = (await fromUuid(uuid)).toObject(); delete o._id;
      o._stats = { ...o._stats, compendiumSource: uuid };
      o.system.location = { ...(o.system.location ?? {}), value: entry.id };
      [spell] = await W.createEmbeddedDocuments("Item", [o]);
    }
    const dc = spell.spellcasting.statistic.withRollOptions({ item: spell }).dc.value;
    if (stat) await e.rig(G, stat, dc + DEGREE_MOD[deg] - G.saves[stat].mod);
    const c = await e.combat([tW, tG], inits);
    await c.startCombat(); await wait(1200);
    return { W, G, tW, tG, spell, dc, c, stat, uuid };
  };
  /** Сотворение по гоблину (d20 = 10), ждём бросок цели и результат; «Применить» жмём, если ничего не выдалось само. -> карточка. */
  const hexCast = async (e, s, done, answers = []) => {
    await e.aim(s.tW, s.tG); await e.fix(10);
    const t0 = e.since();
    await withAnswers(e, answers, async () => {
      await bound("сотворение", s.spell.spellcasting.cast(s.spell, { consume: false }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === s.spell.uuid && x.flags?.[MOD]?.use), 10000);
      if (!m) throw new Error("нет карточки сотворения с use");
      if (s.stat && !(await waitFor(() => Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length, 20000))) throw new Error("нет броска спасброска");
      if (!(await waitFor(() => done(), 2500))) await e.applyAll(game.messages.get(m.id));
      await waitFor(done, 8000);
    });
    return e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === s.spell.uuid && x.flags?.[MOD]?.use);
  };
  /** Кнопка шёпота якоря: how = support | dismiss. */
  const hexPress = async (e, anc, how) => {
    const key = anc.flags[MOD].meta.key;
    const m = await waitFor(() => game.messages.contents.findLast((x) => x.flags?.[MOD]?.sustain?.key === key), 6000);
    const b = m && await waitFor(() => e.dom(m)?.querySelector(`[data-af-sustain="${how}"]`), 6000);
    if (!b) throw new Error(`нет кнопки ${how} в шёпоте якоря`);
    b.click(); await wait(2500);
  };
  /** Цикл Поддержания: раунд 2 — «Поддержать» держит; пропуск раунда 3 — якорь и привязанное сняты (gone). */
  const hexCycle = async (e, t, s, held, gone) => {
    t.ok(!!(await waitFor(() => anchors(s.W).length === 1, 6000)), `один якорь у Фейи: ${anchors(s.W).map((i) => i.name)}`);
    await next(s.c, "конец хода Фейи (сотворение)"); await next(s.c, "конец хода гоблина");
    t.ok(s.c.round === 2 && s.c.combatant?.actor?.uuid === s.W.uuid, `раунд 2, ход Фейи: r${s.c.round}`);
    await hexPress(e, anchors(s.W)[0], "support");
    await next(s.c, "конец хода Фейи (поддержано)");
    t.ok(held(), "поддержано — держится");
    await next(s.c, "конец хода гоблина R2"); await next(s.c, "конец хода Фейи R3 без Поддержания");
    t.ok(!!(await waitFor(() => !anchors(s.W).length, 6000)), "пропуск — якорь снят");
    t.ok(!!(await waitFor(gone, 6000)), "пропуск — привязанное снято");
  };

  // ---------- сценарии анимиста, первая партия (docs/plan-animist.md, шаги 2-3) ----------
  // Только хелперы an* и тела sc(...): вставляются в каркас level1-hexes.js (там есть S, sc, e.*, waitFor, bound, wait, Skip, MOD, heroCopy, anchors, turnTo, next, withAnswers,
  // fx/cnd/val/hasFx, PA, SE, hexPress, hexCycle). Герой — копия «Само (анимист)»; недостающее заклинание добавляется в запись «Focus Spells».
  // НЕ проверяется (нужен P1): пульс при Поддержании у Garden of Healing и Earth's Bile.
  const AN_SP = "Compendium.pf2e.spells-srd.Item.";
  const AN = {
    garden: "w4M6Vqvq8k6MOFvj", river: "ew4ToaTU3o8ahKio", devour: "wTldMJx0vyBAehrI", battle: "X4On99Nti8gjWywG", crown: "h2DLv8TQV0Z83tQp",
    workshop: "rzcXUF5YmJYxgxEa", bile: "PrlR2sLWeiuTcPF2", fear: "4koZzrnMXhhosn0D", guidance: "izcxFQFwf3woCnFs", splash: "zhDIiQlJmrd4UDNC", vine: "uZK2BYzPnxUBnDjr"
  };
  const AN_MOD = { criticalSuccess: 0, success: -10, failure: -11, criticalFailure: -20 };   // итог = 10 + mod броска цели при d20 = 10, СЛ = dc
  const anNow = (a, uuid) => a.itemTypes.effect.filter((i) => i._stats?.compendiumSource === uuid);

  /** Само (копия) + токены: Само (500,500), союзник (600,500, hp 1) при ally, гоблин (gx,500); бой [Само, гоблин]. stat/deg подкручивают спасбросок гоблина по СЛ колдовства. */
  const anSetup = async (e, key, { ally = false, gx = 700, stat = null, deg = "failure" } = {}) => {
    try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ }
    const uuid = AN_SP + AN[key];
    const A0 = await heroCopy(e, "Само (анимист)"), g = await e.foe("гоблин");
    const tA = await e.tok(A0, 500, 500, 1), tG = await e.tok(g, gx, 500, -1);
    let al = null, tAl = null;
    if (ally) { al = await e.pc("союзник"); tAl = await e.tok(al, 600, 500, 1); }
    await wait(700);
    const A = e.A(tA), G = e.A(tG), AL = tAl ? e.A(tAl) : null;
    if (AL) await AL.update({ "system.attributes.hp.value": 1 });
    let spell = A.itemTypes.spell.find((s) => s._stats?.compendiumSource === uuid || s.sourceId === uuid);
    if (!spell) {
      const entry = A.spellcasting.find((s) => s.system?.prepared?.value === "focus") ?? A.spellcasting.contents.find((s) => s.isPrepared || s.isSpontaneous);
      if (!entry) throw new Skip("у Само нет записи колдовства");
      const o = (await fromUuid(uuid)).toObject(); delete o._id;
      o._stats = { ...o._stats, compendiumSource: uuid };
      o.system.location = { ...(o.system.location ?? {}), value: entry.id };
      [spell] = await A.createEmbeddedDocuments("Item", [o]);
    }
    const dc = spell.spellcasting.statistic.withRollOptions({ item: spell }).dc.value;
    if (stat) await e.rig(G, stat, dc + AN_MOD[deg] - G.saves[stat].mod);
    const c = await e.combat([tA, tG], [20, 10]);
    await c.startCombat(); await wait(1200);
    return { A, W: A, G, AL, tA, tG, tAl, spell, dc, c, uuid };
  };
  /** Сотворение (d20 = 10) с целями aim; region — "emanation" (10 фт от Само) или {burst:[x,y]} (радиус 10 фт): область ставится по карточке. Ждём done(); «Применить», если само не выдалось. -> карточка */
  const anCast = async (e, s, { aim = [], region = null, done = () => true, answers = [] } = {}) => {
    await e.aim(s.tA, ...aim); await e.fix(10);
    const t0 = e.since(), mine = (x) => x.flags?.pf2e?.origin?.uuid === s.spell.uuid && x.flags?.[MOD]?.use;
    await withAnswers(e, answers, async () => {
      await bound("сотворение", s.spell.spellcasting.cast(s.spell, { consume: false }));
      const m = await waitFor(() => e.msgs(t0).find(mine), 10000);
      if (!m) throw new Error("нет карточки сотворения с use");
      if (region) {
        await waitFor(() => e.use(m)?.state?.awaitingRegion || e.use(m)?.state?.done, 8000);
        const d = e.T(s.tA)._source;
        const shape = region === "emanation" ? { type: "emanation", hole: false, gridBased: true, radius: 200, base: { type: "token", x: d.x, y: d.y, width: d.width, height: d.height, shape: d.shape } }
          : { type: "circle", hole: false, x: region.burst[0], y: region.burst[1], radius: 200 };
        await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#00aa55", shapes: [shape], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: region === "emanation" ? "emanation" : "burst" } } }]);
        await waitFor(() => (e.use(m)?.state?.area?.keys?.length ?? 0) >= 1, 10000);
      }
      if (!(await waitFor(() => done(), 4000))) await e.applyAll(game.messages.get(m.id));
      await waitFor(done, 8000);
    });
    return e.msgs(t0).find(mine);
  };
  /** Само под Поддержанием: сотворение, один якорь, один эффект eff; «Поддержать» держит (одна копия), пропуск раунда снимает и якорь, и эффект. Эффект eff — spell-effects. */
  const anSustained = async (e, t, key, eff) => {
    const s = await anSetup(e, key), E = SE + eff;
    t.ok(await turnTo(s.c, s.A), "ход Само");
    await anCast(e, s, { done: () => anNow(s.A, E).length > 0 });
    t.ok(anNow(s.A, E).length === 1, `эффект ${eff} у Само: ${anNow(s.A, E).length}`);
    await hexCycle(e, t, s, () => anNow(s.A, E).length === 1, () => anNow(s.A, E).length === 0);
  };

  sc("an-a23", "A23 Garden of Healing: лечение в эманации, метка под Поддержанием; Прекращение — эффект +1 к эмоциям, повторного лечения нет", async (e, t) => {
    const s = await anSetup(e, "garden", { ally: true, gx: 1200 });
    const MARK = PA + "GardnHealedMark1", LING = SE + "JhxAUu3JEyERedMd";
    t.ok(await turnTo(s.c, s.A), "ход Само");
    await anCast(e, s, { region: "emanation", done: () => anNow(s.AL, MARK).length > 0 });
    t.ok(s.AL.hitPoints.value > 1 && s.AL.hitPoints.value <= 5, `союзник вылечен 1d4: hp ${s.AL.hitPoints.value} (было 1)`);
    t.ok(anNow(s.AL, MARK).length === 1 && !anNow(s.AL, LING).length, "метка есть, бонуса пока нет");
    t.ok(!!(await waitFor(() => anchors(s.A).length === 1, 6000)), `один якорь: ${anchors(s.A).map((i) => i.name)}`);
    t.ok(s.A.itemTypes.effect.some((i) => i._stats?.compendiumSource === MARK), "Само в своей эманации тоже получила метку (excludeSelf:false — лечащий сосуд)");
    await hexPress(e, anchors(s.A)[0], "dismiss");
    t.ok(!!(await waitFor(() => !anchors(s.A).length && !anNow(s.AL, MARK).length, 6000)), "Прекращено: якорь и метка сняты");
    t.ok(!!(await waitFor(() => anNow(s.AL, LING).length === 1, 6000)), "после конца — эффект +1 круг. к спасброскам от эмоций (10 мин)");
    // повтор при действующем бонусе: лечения и метки нет
    const hp = s.AL.hitPoints.value;
    await anCast(e, s, { region: "emanation", done: () => true });
    await wait(3000);
    t.ok(s.AL.hitPoints.value === hp && !anNow(s.AL, MARK).length, `повтор при бонусе: hp ${hp} -> ${s.AL.hitPoints.value}, метки ${anNow(s.AL, MARK).length}`);
  });

  sc("an-a27", "A27 River Carving Mountains: эффект +10 фт и якорь; «Поддержать» держит; пропуск снимает", async (e, t) => {
    await anSustained(e, t, "river", "aaA6cgroFMRMsisy");
  });
  sc("an-a28", "A28 Devouring Dark Form: эффект формы под Поддержанием (выбор формы — окно ChoiceSet); пропуск снимает", async (e, t) => {
    await anSustained(e, t, "devour", "Le5Sewk43o7V60nO");
  });
  sc("an-a33", "A33 Embodiment of Battle: эффект под Поддержанием; пропуск снимает", async (e, t) => {
    await anSustained(e, t, "battle", "uiXWJVwWuMS3KvkV");
  });
  sc("an-a20", "A20 Crown of Prophets: эффект (клыки) под Поддержанием; пропуск снимает", async (e, t) => {
    await anSustained(e, t, "crown", "C2jiokGoehvLu0fi");
  });
  sc("an-a32", "A32 Traveling Workshop: эффект под Поддержанием (якорь 10 мин, не 8 ч — известное расхождение); пропуск снимает", async (e, t) => {
    await anSustained(e, t, "workshop", "qXWCvqt24iczeN8V");
  });

  sc("an-a25", "A25 Earth's Bile: Рефлекс basic по гоблину — урон огнём и дробящим, при провале персистентный огонь", async (e, t) => {
    const s = await anSetup(e, "bile", { stat: "reflex", deg: "failure" });
    const hp0 = s.G.hitPoints.value;
    t.ok(await turnTo(s.c, s.A), "ход Само");
    await anCast(e, s, { aim: [s.tG], region: { burst: [750, 550] }, done: () => s.G.hitPoints.value < hp0 });
    const lost = hp0 - s.G.hitPoints.value;
    t.ok(lost >= 2 && lost <= 8, `гоблин потерял ${lost} (1d4 огонь + 1d4 дробящий, провал ×1)`);
    const pd = s.G.itemTypes.condition.find((c) => c.slug === "persistent-damage");
    t.ok(!!pd && pd.system.persistent?.damageType === "fire", `персистентный огонь при провале: ${pd?.system.persistent?.damageType} ${pd?.system.persistent?.formula ?? pd?.system.persistent?.dc ?? ""}`);
  });

  sc("an-fear", "Fear: Воля гоблина — провал frightened 2, крит. провал frightened 3 + fleeing, успех frightened 1", async (e, t) => {
    const s = await anSetup(e, "fear", { stat: "will", deg: "failure" });
    t.ok(await turnTo(s.c, s.A), "ход Само");
    let prev = "failure";
    for (const [deg, f, fleeing] of [["failure", 2, false], ["criticalFailure", 3, true], ["success", 1, false]]) {
      if (deg !== prev) { await e.rig(s.G, "will", AN_MOD[deg] - AN_MOD[prev]); prev = deg; }
      for (const c of s.G.itemTypes.condition) await c.delete().catch(() => {});
      for (const i of s.G.itemTypes.effect.filter((i) => i.name !== "AF rig")) await i.delete().catch(() => {});
      await wait(800);
      await anCast(e, s, { aim: [s.tG], done: () => val(s.G, "frightened") > 0 });
      t.ok(val(s.G, "frightened") === f, `${deg}: frightened ${val(s.G, "frightened")}, ждали ${f}`);
      t.ok((cnd(s.G, "fleeing").length > 0) === fleeing, `${deg}: fleeing ${cnd(s.G, "fleeing").length > 0}`);
    }
  });

  sc("an-guidance", "Guidance: союзнику эффект Наставления и иммунитет на 1 час; повторный каст в иммунитете — без второго эффекта", async (e, t) => {
    const s = await anSetup(e, "guidance", { ally: true });
    const GU = SE + "3qHKBDF7lrHw8jFK", IM = SE + "3LyOkV25p7wA181H";
    t.ok(await turnTo(s.c, s.A), "ход Само");
    await anCast(e, s, { aim: [s.tAl], done: () => anNow(s.AL, GU).length > 0 });
    t.ok(anNow(s.AL, GU).length === 1 && anNow(s.AL, IM).length === 1, `эффект ${anNow(s.AL, GU).length}, иммунитет ${anNow(s.AL, IM).length}`);
    for (const i of anNow(s.AL, GU)) await i.delete();
    await anCast(e, s, { aim: [s.tAl] });
    await wait(2500);
    t.ok(anNow(s.AL, GU).length === 0 && anNow(s.AL, IM).length === 1, `повтор в иммунитете: эффект ${anNow(s.AL, GU).length}, иммунитет ${anNow(s.AL, IM).length}`);
  });

  sc("an-rousing-splash", "Rousing Splash: союзнику временные HP (эффект) и иммунитет 10 мин; повтор — без второй порции", async (e, t) => {
    const s = await anSetup(e, "splash", { ally: true });
    const RS = SE + "IYvzqymG4xOhqFir", IM = PA + "XWte9oUQ4x0sBHMq";
    t.ok(await turnTo(s.c, s.A), "ход Само");
    await anCast(e, s, { aim: [s.tAl], done: () => anNow(s.AL, RS).length > 0 });
    t.ok(anNow(s.AL, RS).length === 1 && anNow(s.AL, IM).length === 1, `эффект ${anNow(s.AL, RS).length}, иммунитет ${anNow(s.AL, IM).length}`);
    t.ok((s.AL.system.attributes.hp.temp ?? 0) > 0, `временные HP: ${s.AL.system.attributes.hp.temp}`);
    for (const i of anNow(s.AL, RS)) await i.delete();
    await anCast(e, s, { aim: [s.tAl] });
    await wait(2500);
    t.ok(anNow(s.AL, RS).length === 0, `повтор в иммунитете: эффект ${anNow(s.AL, RS).length}`);
  });

  sc("an-tangle-vine", "Tangle Vine: атака заклинанием по КЗ — успех: эффект (−10 фт), крит. успех: эффект + immobilized", async (e, t) => {
    const s = await anSetup(e, "vine"), TV = SE + "TwtUIEyenrtAbeiX", mod = s.spell.spellcasting.statistic.check.mod;
    const ac0 = s.G.armorClass.value;   // rig заменяет прежнюю подкрутку, а не прибавляет: считаем от исходного КЗ
    await e.rig(s.G, "ac", 10 + mod - 5 - ac0);   // итог атаки = 10 + mod: успех при КЗ = итог − 5
    t.ok(await turnTo(s.c, s.A), "ход Само");
    for (const [deg, crit] of [["success", false], ["criticalSuccess", true]]) {
      if (crit) await e.rig(s.G, "ac", 10 + mod - 10 - ac0);   // КЗ = итог − 10
      for (const c of s.G.itemTypes.condition) await c.delete().catch(() => {});
      for (const i of anNow(s.G, TV)) await i.delete().catch(() => {});
      await wait(800);
      // check.roll = system: снимок use ложится на бросок атаки (wantsSnapshot), не на карточку сотворения
      await e.aim(s.tA, s.tG); await e.fix(10);
      await bound("сотворение", s.spell.spellcasting.cast(s.spell, { consume: false })); await wait(1200);
      const t1 = e.since();
      await bound("атака заклинанием", s.spell.rollAttack(SHIFT()));
      const att = await waitFor(() => e.msgs(t1).find((m) => /attack-roll/.test(m.flags?.pf2e?.context?.type ?? "") && e.use(m)), 8000);
      t.ok(!!att, `${deg}: атака с use: ${att?.flags?.pf2e?.context?.outcome}`);
      if (att && !(await waitFor(() => anNow(s.G, TV).length > 0, 3000))) { await waitFor(() => e.block(att)?.querySelector("button[data-action^=apply]"), 6000); await e.applyAll(att); }
      await waitFor(() => anNow(s.G, TV).length > 0, 6000);
      await wait(2000);
      t.ok(anNow(s.G, TV).length === 1, `${deg}: эффект Tangle Vine ${anNow(s.G, TV).length}`);
      t.ok(s.G.hasCondition("immobilized") === crit, `${deg}: immobilized ${s.G.hasCondition("immobilized")} (GrantItem inMemoryOnly — в actor.conditions, не в items)`);
    }
  });
  // ---------- импульс при Поддержании (docs/plan-sustain-pulse.md): Garden of Healing (same), Earth's Bile (new) ----------
  const pulseCards = (e, t0) => e.msgs(t0).filter((m) => e.use(m)?.state?.pulse || e.use(m)?.pulse);
  /** «Поддержать» якоря и ожидание карточки импульса. -> { card, n } */
  const anPulse = async (e, s, t0) => {
    await hexPress(e, anchors(s.A)[0], "support");
    const card = await waitFor(() => pulseCards(e, t0)[0], 8000);
    return { card, n: pulseCards(e, t0).length };
  };
  const toR2 = async (e, s) => { await next(s.c, "конец хода Само"); await next(s.c, "ход гоблина"); return s.c.round === 2 && s.c.combatant?.actor?.uuid === s.A.uuid; };

  sc("an-a23-pulse", "A23 Garden of Healing, импульс: в R2 «Поддержать» — новая карточка лечит союзника в эманации; повтор кнопки — без второго импульса; пропуск R3 — якорь и метка сняты, бонус выдан", async (e, t) => {
    const s = await anSetup(e, "garden", { ally: true, gx: 1200 });
    const MARK = PA + "GardnHealedMark1", LING = SE + "JhxAUu3JEyERedMd";
    t.ok(await turnTo(s.c, s.A), "ход Само");
    await anCast(e, s, { region: "emanation", done: () => anNow(s.AL, MARK).length > 0 });
    t.ok(!!(await waitFor(() => anchors(s.A).length === 1, 6000)), "якорь после сотворения");
    await s.AL.update({ "system.attributes.hp.value": 1 });
    t.ok(await toR2(e, s), `раунд 2, ход Само: r${s.c.round}`);
    const t0 = e.since();
    const { card, n } = await anPulse(e, s, t0);
    t.ok(!!card && n === 1, `карточка импульса: ${n}`);
    if (card && !(await waitFor(() => s.AL.hitPoints.value > 1, 4000))) await e.applyAll(game.messages.get(card.id));
    t.ok(!!(await waitFor(() => s.AL.hitPoints.value > 1, 6000)), `импульс вылечил союзника: hp ${s.AL.hitPoints.value}`);
    t.ok(anNow(s.AL, MARK).length === 1, `метка одна: ${anNow(s.AL, MARK).length}`);
    await hexPress(e, anchors(s.A)[0], "support"); await wait(2500);
    t.ok(pulseCards(e, t0).length === 1, `повтор кнопки в раунде — импульсов ${pulseCards(e, t0).length}`);
    t.ok(anchors(s.A).length === 1, "якорь один, импульс не создал второй");
    await next(s.c, "конец хода Само R2"); await next(s.c, "ход гоблина R2"); await next(s.c, "Само R3 без Поддержания");
    t.ok(!!(await waitFor(() => !anchors(s.A).length && !anNow(s.AL, MARK).length, 6000)), "пропуск: якорь и метка сняты");
    t.ok(!!(await waitFor(() => anNow(s.AL, LING).length === 1, 6000)), "после конца — бонус +1 к спасброскам от эмоций");
  });

  sc("an-a25-pulse", "A25 Earth's Bile, импульс: в R2 «Поддержать» — карточка ждёт шаблон, по новой области урон гоблину; повтор кнопки — без второго импульса", async (e, t) => {
    const s = await anSetup(e, "bile", { stat: "reflex", deg: "failure" });
    t.ok(await turnTo(s.c, s.A), "ход Само");
    const hp0 = s.G.hitPoints.value;
    await anCast(e, s, { aim: [s.tG], region: { burst: [750, 550] }, done: () => s.G.hitPoints.value < hp0 });
    t.ok(!!(await waitFor(() => anchors(s.A).length === 1, 6000)), `якорь после сотворения: ${anchors(s.A).length}`);
    for (const c of s.G.itemTypes.condition.filter((x) => x.slug === "persistent-damage")) await c.delete();
    await s.G.update({ "system.attributes.hp.value": s.G.hitPoints.max });
    t.ok(await toR2(e, s), `раунд 2, ход Само: r${s.c.round}`);
    const hp1 = s.G.hitPoints.value, t0 = e.since();
    const { card, n } = await anPulse(e, s, t0);
    t.ok(!!card && n === 1, `карточка импульса: ${n}`);
    t.ok(!!(await waitFor(() => e.use(game.messages.get(card?.id))?.state?.awaitingRegion, 6000)), "карточка ждёт шаблон (new)");
    t.ok(/@Template|data-pf2-effect-area|template/i.test(game.messages.get(card?.id)?.content ?? ""), "в карточке есть шаблон области");
    await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область импульса`, color: "#aa5500", shapes: [{ type: "circle", hole: false, x: 750, y: 550, radius: 200 }], behaviors: [], flags: { pf2e: { messageId: card.id, areaShape: "burst" } } }]);
    await waitFor(() => (e.use(game.messages.get(card.id))?.state?.area?.keys?.length ?? 0) >= 1, 10000);
    if (!(await waitFor(() => s.G.hitPoints.value < hp1, 6000))) await e.applyAll(game.messages.get(card.id));
    t.ok(!!(await waitFor(() => s.G.hitPoints.value < hp1, 8000)), `импульс нанёс урон: ${hp1} → ${s.G.hitPoints.value}`);
    await hexPress(e, anchors(s.A)[0], "support"); await wait(2500);
    t.ok(pulseCards(e, t0).length === 1, `повтор кнопки в раунде — импульсов ${pulseCards(e, t0).length}`);
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
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут 170 с; ${hangInfo(e)}`)), 170000); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} level1-animist | ${s.id}`, err); }
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
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await dropPack();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afL1AnResult = out;
  return out;
}

