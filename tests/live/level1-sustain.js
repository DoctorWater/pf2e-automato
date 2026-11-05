async () => {
  // Живые сценарии Поддержания, волна 1 (docs/plan-sustain.md): Information Overload у копии Фейи по гоблину — якорь, кнопки «Поддержать / Прекратить»,
  // пропуск в конце хода, последний по инициативе, Поддержание с листа pf2e. Режимы мира: challenge = auto, effect = auto, apply = button или auto.
  // Герои — временные копии «AF тест: …» из папки «Герои 1 ур. (автоматизация)». Параметры: window.__afL1Sustain = { only, skip, cleanOnly }. Результат — window.__afL1SustainResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL1Sustain ?? {}) };
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

  // ---------- уборка (аварийная: window.__afL1Sustain = {cleanOnly: true}) ----------
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

  // ---------- сценарии level1-sustain: Поддержание (plan-sustain.md, волна 1) ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const dropPack = async () => {};
  const IO = "Compendium.pf2e.spells-srd.Item.PesUKf0lIt5zRofj";
  const DEGREE_MOD = { criticalSuccess: 0, success: -10, failure: -11, criticalFailure: -20 };   // итог при d20 = 10: mod + 10
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
  const stup = (a) => a.itemTypes.condition.find((c) => c.slug === "stupefied") ?? null;
  const lastOf = (anc) => anc?.flags?.[MOD]?.sustain?.last ?? null;

  /** Фейя (копия) с Information Overload в записи ведьмы, гоблин с Волей под провал; бой по заданной инициативе. */
  const setup = async (e, inits) => {
    // открытый чат: иначе всплывающая карточка шёпота (ядро ChatLog#postNotification) падает, когда уборка удаляет сообщение во время анимации
    try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ }
    const w = await heroCopy(e, "Фейя (ведьма)"), g = await e.foe("гоблин");
    const tW = await e.tok(w, 500, 500, 1), tG = await e.tok(g, 600, 500, -1);
    await wait(700);
    const W = e.A(tW), entry = W.spellcasting.regular[0] ?? W.spellcasting.contents.find((s) => s.isPrepared || s.isSpontaneous);
    if (!entry) throw new Skip("у Фейи нет записи заклинаний");
    const o = (await fromUuid(IO)).toObject(); delete o._id;
    o._stats = { ...o._stats, compendiumSource: IO };
    o.system.location = { ...(o.system.location ?? {}), value: entry.id };
    const [spell] = await W.createEmbeddedDocuments("Item", [o]);
    const dc = spell.spellcasting.statistic.withRollOptions({ item: spell }).dc.value;
    const G = e.A(tG);
    await e.rig(G, "will", dc + DEGREE_MOD.failure - G.saves.will.mod);
    const c = await e.combat([tW, tG], inits);
    await c.startCombat(); await wait(1200);
    return { W, G, tW, tG, spell, dc, c };
  };
  /** Ход до актёра a (по кругу, не больше n шагов). */
  const turnTo = async (c, a, n = 4) => { for (let i = 0; i < n && c.combatant?.actor?.uuid !== a.uuid; i++) { await bound("nextTurn", c.nextTurn()); await wait(1500); } return c.combatant?.actor?.uuid === a.uuid; };
  const next = async (c, label) => { await bound(label, c.nextTurn()); await wait(2500); };
  /** Сотворение по гоблину, бросок Воли (d20 = 10 → провал), «Применить» (mode.apply = button). -> карточка. */
  const castIO = async (e, s) => {
    await e.aim(s.tW, s.tG); await e.fix(10);
    const t0 = e.since();
    await bound("сотворение", s.spell.spellcasting.cast(s.spell, { consume: false }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === s.spell.uuid && x.flags?.[MOD]?.use), 10000);
    if (!m) throw new Error("нет карточки сотворения с use");
    if (!(await waitFor(() => Object.keys(e.use(m)?.state?.challenge?.results ?? {}).length, 20000))) throw new Error(`нет броска Воли: ${JSON.stringify(e.use(m)?.state?.challenge)}`);
    if (!(await waitFor(() => stup(s.G), 2500))) await e.applyAll(game.messages.get(m.id));
    await waitFor(() => stup(s.G) && anchors(s.W).length, 8000);
    return game.messages.get(m.id);
  };
  /** Кнопка шёпота якоря: how = support | dismiss. */
  const press = async (e, anc, how) => {
    const key = anc.flags[MOD].meta.key;
    const m = await waitFor(() => game.messages.contents.findLast((x) => x.flags?.[MOD]?.sustain?.key === key), 6000);
    if (!m) throw new Error("нет шёпота с кнопками Поддержания");
    const b = await waitFor(() => e.dom(m)?.querySelector(`[data-af-sustain="${how}"]`), 6000);
    if (!b) throw new Error(`нет кнопки ${how} в шёпоте`);
    b.click(); await wait(2500);
  };

  sc("io-cycle", "Information Overload: сотворение → якорь и stupefied 1; конец хода сотворения — держится; кнопка «Поддержать» — держится; пропуск — снято всё", async (e, t) => {
    const s = await setup(e, [20, 10]);
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await castIO(e, s);
    t.ok(stup(s.G)?.value === 1, `stupefied 1 у гоблина: ${stup(s.G)?.value}`);
    t.ok(anchors(s.W).length === 1, `один якорь у Фейи: ${anchors(s.W).map((i) => i.name)}`);
    t.ok(lastOf(anchors(s.W)[0])?.round === s.c.round, `last = раунд сотворения: ${JSON.stringify(lastOf(anchors(s.W)[0]))}`);
    await next(s.c, "конец хода Фейи (сотворение)");
    t.ok(anchors(s.W).length === 1 && !!stup(s.G), "после хода сотворения якорь и stupefied на месте");
    await next(s.c, "конец хода гоблина");
    t.ok(s.c.combatant?.actor?.uuid === s.W.uuid && s.c.round === 2, `раунд 2, ход Фейи: r${s.c.round}`);
    const t0 = e.since();
    await press(e, anchors(s.W)[0], "support");
    t.ok(lastOf(anchors(s.W)[0])?.round === 2, `кнопка — last = 2: ${JSON.stringify(lastOf(anchors(s.W)[0]))}`);
    t.ok(e.msgs(t0).some((x) => x.flags?.pf2e?.origin?.slug === "sustain" || /sustain|поддерж/i.test(`${x.flavor ?? ""} ${x.content ?? ""}`)), "кнопка выложила Sustain pf2e");
    const n0 = e.msgs(t0).length;
    await press(e, anchors(s.W)[0], "support");
    t.ok(e.msgs(t0).length === n0, `повтор кнопки в том же раунде — без второго Sustain (${e.msgs(t0).length} vs ${n0})`);
    await next(s.c, "конец хода Фейи (поддержано)");
    t.ok(anchors(s.W).length === 1 && !!stup(s.G), "поддержано — держится");
    await next(s.c, "конец хода гоблина R2");
    await next(s.c, "конец хода Фейи R3 без Поддержания");
    t.ok(!!(await waitFor(() => !anchors(s.W).length, 6000)), "пропуск — якорь снят");
    t.ok(!!(await waitFor(() => !stup(s.G), 6000)), `пропуск — stupefied снят: ${stup(s.G)?.value}`);
  });

  sc("last-init", "Фейя последняя по инициативе: конец хода сотворения не считается пропуском; Поддержание с листа pf2e засчитывается", async (e, t) => {
    const s = await setup(e, [5, 20]);
    t.ok(await turnTo(s.c, s.W), "ход Фейи (последняя)");
    await castIO(e, s);
    t.ok(anchors(s.W).length === 1, "якорь есть");
    await next(s.c, "конец хода Фейи — переход раунда");
    t.ok(s.c.round === 2, `раунд 2: ${s.c.round}`);
    t.ok(anchors(s.W).length === 1 && !!stup(s.G), "переход раунда в конце её хода — не пропуск");
    await next(s.c, "конец хода гоблина R2");
    t.ok(s.c.combatant?.actor?.uuid === s.W.uuid, "ход Фейи R2");
    await bound("Sustain с листа", game.pf2e.actions.get("sustain").use({ actors: [s.W] })); await wait(2500);
    t.ok(lastOf(anchors(s.W)[0])?.round === 2, `Sustain pf2e засчитан: ${JSON.stringify(lastOf(anchors(s.W)[0]))}`);
    await next(s.c, "конец хода Фейи R2 (поддержано с листа)");
    t.ok(anchors(s.W).length === 1, "поддержано с листа — держится");
  });

  sc("dismiss", "Кнопка «Прекратить»: якорь и stupefied сняты сразу", async (e, t) => {
    const s = await setup(e, [20, 10]);
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await castIO(e, s);
    t.ok(anchors(s.W).length === 1 && !!stup(s.G), "якорь и stupefied есть");
    await press(e, anchors(s.W)[0], "dismiss");
    t.ok(!!(await waitFor(() => !anchors(s.W).length && !stup(s.G), 6000)), `после «Прекратить» пусто: якорей ${anchors(s.W).length}, stupefied ${stup(s.G)?.value}`);
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} level1-sustain | ${s.id}`, err); }
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
  window.__afL1SustainResult = out;
  return out;
}

