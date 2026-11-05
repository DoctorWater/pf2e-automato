async () => {
  // Живые сценарии наговоров ведьмы, первая партия (docs/plan-hexes.md); каркас и хелперы — как у level1-familiar: копия Фейи + временный фамильяр «AF тест: фамильяр» (system.master), способность из familiar-abilities на фамильяре,
  // Evil Eye (hex) по гоблину. Окна выбора модуля отвечаются очередью e.answers (подпись или значение варианта; null — закрыть).
  // Параметры: window.__afL1Hex = { only, skip, cleanOnly }. Результат — window.__afL1HexResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL1Hex ?? {}) };
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

  // ---------- уборка (аварийная: window.__afL1Hex = {cleanOnly: true}) ----------
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

  sc("hx-w35", "W35 Buzzing Bites: крит. провал — метка + минимум sickened 1; конец метки — иммунитет и снятие минимума; иммунная цель не получает повторно", async (e, t) => {
    const s = await hexSetup(e, "W35", "criticalFailure");
    const MARK = PA + "Vn57RpGjnNBtAfnj", MIN = PA + "BzzBitesCritEf01", IMM = PA + "BzzBitesImmune01";
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => hasFx(s.G, MIN));
    t.ok(hasFx(s.G, MARK), "метка заклинания на гоблине");
    t.ok(hasFx(s.G, MIN) && val(s.G, "sickened") >= 1, `минимум и sickened ≥ 1: ${val(s.G, "sickened")}`);
    // INFO: даёт ли Фейя без фамильяра якорь (у шагов этой записи sustain нет) — если нет, конец наговора только снятием метки
    t.ok(true, `INFO якорей у Фейи: ${anchors(s.W).length}`);
    for (const x of s.G.itemTypes.condition.filter((c) => c.slug === "sickened")) await s.G.decreaseCondition(x, { forceRemove: true }).catch(() => {});
    await wait(800);
    t.ok(val(s.G, "sickened") >= 1, `минимум не даёт снять sickened: ${val(s.G, "sickened")}`);
    for (const m of s.G.itemTypes.effect.filter((i) => i.name.includes("Buzzing Bites") && !i.name.includes("Immunity") && !i.name.includes("Critical"))) await m.delete();
    t.ok(!!(await waitFor(() => hasFx(s.G, IMM), 6000)), "конец наговора — иммунитет 1 минута");
    t.ok(!!(await waitFor(() => !hasFx(s.G, MIN), 6000)), "минимум снят вместе с наговором");
    await hexCast(e, s, () => true);
    t.ok(!hasFx(s.G, MIN) && !s.G.itemTypes.effect.some((i) => i.name === "Spell Effect: Buzzing Bites"), "иммунная цель — повторных эффектов нет");
  });

  sc("hx-w23", "W23 Information Overload: провал — stupefied 1; Поддержание держит, пропуск снимает", async (e, t) => {
    const s = await hexSetup(e, "W23", "failure");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => val(s.G, "stupefied") > 0);
    t.ok(val(s.G, "stupefied") === 1, `stupefied 1: ${val(s.G, "stupefied")}`);
    await hexCycle(e, t, s, () => val(s.G, "stupefied") === 1, () => val(s.G, "stupefied") === 0);
  });

  sc("hx-w22", "W22 Clinging Ice: провал — эффект −5 к Скоростям (одна копия); Поддержание держит, пропуск снимает", async (e, t) => {
    const s = await hexSetup(e, "W22", "failure");
    const ICE = SE + "2sMXAGZfdqiy10kk";
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => hasFx(s.G, ICE));
    t.ok(fx(s.G, ICE).length === 1, `один эффект: ${fx(s.G, ICE).length}`);
    const sel = fx(s.G, ICE)[0]?.system.rules.find((r) => r.key === "ChoiceSet")?.selection;
    t.ok(sel === -5, `выбор −5 при провале: ${JSON.stringify(sel)}`);
    await hexCycle(e, t, s, () => hasFx(s.G, ICE), () => !hasFx(s.G, ICE));
  });

  sc("hx-w31", "W31 Stoke the Heart: эффект RE на цели, один; Поддержание держит, пропуск снимает", async (e, t) => {
    const s = await hexSetup(e, "W31");
    const E = SE + "TpVkVALUBrBQjULn";
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => hasFx(s.G, E));
    t.ok(fx(s.G, E).length === 1, `один эффект: ${fx(s.G, E).length}`);
    const mods = s.G.synthetics?.modifiers?.damage ?? [];
    t.ok(true, `INFO бонус к урону: ${fx(s.G, E)[0]?.system.rules.map((r) => `${r.key}:${r.value}`)} / синтетика=${mods.length}`);
    await hexCycle(e, t, s, () => hasFx(s.G, E), () => !hasFx(s.G, E));
  });

  sc("hx-w24", "W24 Discern Secrets: эффект +1 и иммунитет на цели; повтор в минуту — без второго эффекта; Поддержание/пропуск", async (e, t) => {
    const s = await hexSetup(e, "W24");
    const E = SE + "pzbU0cdyRvE66XBi", IMM = PA + "DscrnSecrImm0001";
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => hasFx(s.G, E) && hasFx(s.G, IMM));
    t.ok(fx(s.G, E).length === 1 && fx(s.G, IMM).length === 1, `эффект и иммунитет по одному: ${fx(s.G, E).length}/${fx(s.G, IMM).length}`);
    await hexCast(e, s, () => true);
    t.ok(fx(s.G, E).length === 1 && fx(s.G, IMM).length === 1, `повтор — отказ по иммунитету: ${fx(s.G, E).length}/${fx(s.G, IMM).length}`);
    await hexCycle(e, t, s, () => hasFx(s.G, E), () => !hasFx(s.G, E));
    t.ok(hasFx(s.G, IMM), "иммунитет не привязан к якорю — остался");
  });

  sc("hx-w33", "W33 Share Vision: эффект у Фейи и гоблина; повторное сотворение заменяет оба (по одному, новые id), чужой Share Vision не тронут", async (e, t) => {
    const s = await hexSetup(e, "W33");
    const E = SE + "eQzFYXLYPrGc9EBI";
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => hasFx(s.W, E) && hasFx(s.G, E));
    t.ok(fx(s.W, E).length === 1 && fx(s.G, E).length === 1, `по одному у автора и цели: ${fx(s.W, E).length}/${fx(s.G, E).length}`);
    const ids = [fx(s.W, E)[0]?.id, fx(s.G, E)[0]?.id];
    const [foreign] = await s.G.createEmbeddedDocuments("Item", [{ ...fx(s.G, E)[0].toObject(), _id: undefined, system: { ...fx(s.G, E)[0].toObject().system, context: { origin: { actor: s.G.uuid, item: null, token: null, spellcasting: null, rollOptions: [] } } } }]);
    await hexCast(e, s, () => fx(s.W, E)[0]?.id !== ids[0]);
    t.ok(fx(s.W, E).length === 1 && fx(s.W, E)[0].id !== ids[0], `у автора заменён: ${fx(s.W, E).length}`);
    t.ok(!fx(s.G, E).some((i) => i.id === ids[1]) && fx(s.G, E).some((i) => i.id === foreign?.id), `у цели прежний от ведьмы заменён, чужой на месте: ${fx(s.G, E).length}`);
  });

  sc("hx-w25", "W25 Trade Death for Life: провал — выбранный союзник (Фейя) получает быстрое исцеление; Поддержание держит, пропуск снимает", async (e, t) => {
    const s = await hexSetup(e, "W25", "failure");
    const E = SE + "oNAqqcxPjzPCJJmW";
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const hp0 = s.G.hitPoints.value;
    const r = await hexCast(e, s, () => hasFx(s.W, E), ["Фейя"]);
    t.ok(hasFx(s.W, E), `быстрое исцеление у выбранной Фейи: ${s.W.itemTypes.effect.map((i) => i.name)} окна=[${e.dialogs.slice(-3)}] st=${JSON.stringify({ ...(e.use(r)?.state ?? {}), challenge: { ...(e.use(r)?.state?.challenge ?? {}), results: undefined } }).slice(0, 900)} mode=${game.settings.get("pf2e-automato", "mode.apply") ?? "?"} msgs=[${game.messages.contents.slice(-3).map((m) => (m.content ?? "").replace(/<[^>]+>/g, " ").replace(/s+/g, " ").slice(0, 150))}]`);
    t.ok(!hasFx(s.G, E), "у гоблина нет");
    t.ok(true, `INFO урон гоблину (кнопка карточки, не запись): ОЗ ${hp0} → ${s.G.hitPoints.value}; карточка ${r ? "есть" : "нет"}`);
    await hexCycle(e, t, s, () => hasFx(s.W, E), () => !hasFx(s.W, E));
  });

  for (const [wx, slug, name, floor] of [["W21", "sickened", "Evil Eye", "EvilEyeFloorEf01"], ["W26", "frightened", "Scrounger's Glee", "ScrngGleeFloor01"]]) {
    sc(`hx-${wx.toLowerCase()}`, `${wx} ${name}: провал — ${slug} 1 + минимум-эффект; крит. провал — ${slug} 2; минимум держит значение; Поддержание/пропуск; удаление минимума оставляет состояние`, async (e, t) => {
      const s = await hexSetup(e, wx, "failure"), F = PA + floor;
      t.ok(await turnTo(s.c, s.W), "ход Фейи");
      await hexCast(e, s, () => val(s.G, slug) > 0 && hasFx(s.G, F));
      t.ok(val(s.G, slug) === 1, `${slug} 1: ${val(s.G, slug)}`);
      t.ok(fx(s.G, F).length === 1, `один эффект минимума: ${fx(s.G, F).length}`);
      for (const c of cnd(s.G, slug).filter((x) => !x.grantedBy && !x.isLocked)) await s.G.decreaseCondition(c, { forceRemove: true }).catch(() => {});
      await wait(800);
      t.ok(val(s.G, slug) === 1, `минимум: после «снятия» значение ${val(s.G, slug)}`);
      await hexCycle(e, t, s, () => hasFx(s.G, F), () => !hasFx(s.G, F));
      // ручное условие «видит/слышит»: ГМ снимает только эффект минимума — состояние остаётся
      await hexCast(e, s, () => hasFx(s.G, F));
      const before = val(s.G, slug);
      for (const x of fx(s.G, F)) await x.delete();
      await wait(800);
      t.ok(before >= 1, `перед удалением минимума состояние есть: ${before}`);
      t.ok(val(s.G, slug) >= 1, `после удаления минимума состояние на месте: ${before} → ${val(s.G, slug)}`);
    });
    sc(`hx-${wx.toLowerCase()}-crit`, `${wx} ${name}: крит. провал — ${slug} 2`, async (e, t) => {
      const s = await hexSetup(e, wx, "criticalFailure");
      t.ok(await turnTo(s.c, s.W), "ход Фейи");
      await hexCast(e, s, () => val(s.G, slug) > 0 && hasFx(s.G, PA + floor));
      t.ok(val(s.G, slug) === 2, `${slug} 2: ${val(s.G, slug)}`);
    });
  }
  // ---------- последняя партия ведьмы (docs/audit-builds-l1.md §5) ----------
  // Свой словарь LX домешивается в HX (hexSetup берёт наговор только оттуда); новых записей колдовства отдельная функция не нужна.
  const LX = {
    FW: ["RA7VKcen3p56rVyZ", null], CK: ["YVK3JUkPVzHIeGXQ", null], IO: ["PesUKf0lIt5zRofj", "will"], IL: ["6ZIKB0151LUR19Rw", "will"],
    EN: ["J7Y7tl0bbdz7TcCc", "fortitude"], PP: ["R8bqnYiThB6MYTxD", "will"]
  };
  Object.assign(HX, LX);
  const FWE = SE + "ctMxYPGEpstvhW9C", OMEN = { failure: PA + "20Fr36wvCCZtygX3", criticalFailure: PA + "6vrf3APd1A3TdfT8" };

  sc("fw-sustain", "Forbidding Ward: эффект у союзника, якорь; Поддержать держит, пропуск снимает", async (e, t) => {
    const s = await hexSetup(e, "FW");
    const mer = await heroCopy(e, "Мерисиэль (плут-вор)"), tM = await e.tok(mer, 500, 600, 1);
    await wait(700);
    const M = e.A(tM);
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const aim0 = e.aim; e.aim = (c, ...ts) => aim0(c, ...ts, tM);   // цели: союзник + противник
    try { await hexCast(e, s, () => hasFx(M, FWE)); } finally { e.aim = aim0; }
    t.ok(hasFx(M, FWE), `эффект у союзника: ${M.itemTypes.effect.map((i) => i.name)}`);
    t.ok(!hasFx(s.W, FWE), "у Фейи нет");
    await hexCycle(e, t, s, () => hasFx(M, FWE), () => !hasFx(M, FWE));
  });

  sc("cackle", "Cackle: после Information Overload кнопка «Поддержать» якоря IO засчитывает Поддержание; якорь держится после конца хода", async (e, t) => {
    const s = await hexSetup(e, "IO", "failure");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => val(s.G, "stupefied") > 0);
    t.ok(val(s.G, "stupefied") === 1, "IO: stupefied 1");
    t.ok(!!(await waitFor(() => anchors(s.W).length === 1, 6000)), "якорь IO");
    await next(s.c, "конец хода Фейи (IO)"); await next(s.c, "конец хода гоблина");
    t.ok(s.c.round === 2 && s.c.combatant?.actor?.uuid === s.W.uuid, `раунд 2, ход Фейи: r${s.c.round}`);
    const [cid] = LX.CK, cuuid = `Compendium.pf2e.spells-srd.Item.${cid}`;
    let ck = s.W.itemTypes.spell.find((x) => x._stats?.compendiumSource === cuuid);
    if (!ck) {
      const entry = s.W.spellcasting.regular[0] ?? s.W.spellcasting.contents.find((x) => x.isPrepared || x.isSpontaneous);
      const o = (await fromUuid(cuuid)).toObject(); delete o._id; o._stats = { ...o._stats, compendiumSource: cuuid };
      o.system.location = { ...(o.system.location ?? {}), value: entry.id };
      [ck] = await s.W.createEmbeddedDocuments("Item", [o]);
    }
    const m = await hexCast(e, { ...s, spell: ck, stat: null }, () => true);
    t.ok(!!m && JSON.stringify(e.use(m)).includes("Поддержать"), "Cackle: карточка с заметкой «Поддержать»");
    await hexPress(e, anchors(s.W)[0], "support");
    await next(s.c, "конец хода Фейи (поддержано кнопкой якоря)");
    t.ok(anchors(s.W).length === 1 && val(s.G, "stupefied") === 1, `якорь IO держится после конца хода: якорей ${anchors(s.W).length}, stupefied ${val(s.G, "stupefied")}`);
  });

  sc("ill-omen", "Ill Omen: провал — эффект; INFO снятие после броска Удара цели", async (e, t) => {
    const s = await hexSetup(e, "IL", "failure");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => hasFx(s.G, OMEN.failure));
    t.ok(hasFx(s.G, OMEN.failure), `эффект на гоблине: ${s.G.itemTypes.effect.map((i) => i.name)}`);
    await next(s.c, "конец хода Фейи");
    t.ok(s.c.combatant?.actor?.uuid === s.G.uuid, "ход гоблина");
    await e.hit(s.tG, s.tW);   // бросок Удара цели по Фейе
    await wait(2500);
    t.ok(true, `INFO removeAfterRoll: после Удара эффект ${hasFx(s.G, OMEN.failure) ? "ОСТАЛСЯ" : "снят"}`);
  });

  sc("enfeeble", "Enfeeble: провал — слабость 2", async (e, t) => {
    const s = await hexSetup(e, "EN", "failure");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => val(s.G, "enfeebled") > 0);
    t.ok(val(s.G, "enfeebled") === 2, `enfeebled ${val(s.G, "enfeebled")}`);
  });

  sc("phantom-pain", "Phantom Pain: провал — тошнота 1 и продолжительный психический урон", async (e, t) => {
    const s = await hexSetup(e, "PP", "failure");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await hexCast(e, s, () => val(s.G, "sickened") > 0 && cnd(s.G, "persistent-damage").length > 0);
    t.ok(val(s.G, "sickened") === 1, `sickened ${val(s.G, "sickened")}`);
    const pd = cnd(s.G, "persistent-damage")[0];
    t.ok(!!pd, "продолжительный урон есть");
    t.ok(true, `INFO persistent: ${JSON.stringify(pd?.system?.persistent ?? null).slice(0, 120)}`);
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} level1-hexes | ${s.id}`, err); }
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
  window.__afL1HexResult = out;
  return out;
}

