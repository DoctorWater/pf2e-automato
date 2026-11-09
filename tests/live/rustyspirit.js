async () => {
  // Живые сценарии героев мира RustySpirit (docs/plan-rustyspirit.md, P5): копии «AF тест: Дракончик / Марена / Еся», тестовая сцена создаётся и удаляется сценарием.
  // Окна выбора модуля отвечаются очередью e.answers (подпись или значение варианта; null — закрыть).
  // Параметры: window.__afRS = { only, skip, cleanOnly }. Результат — window.__afRSResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afRS ?? {}) };
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

  // ---------- уборка (аварийная: window.__afRS = {cleanOnly: true}) ----------
  // Бой удаляем с проверкой: молчаливый catch оставлял бой без сцены (сцену удаляли следом). Не удалился — повтор, потом предупреждение в консоль.
  const killCombat = async (c) => {
    for (let i = 0; i < 3 && game.combats.has(c.id); i++) { await game.combats.get(c.id).delete().catch((err) => console.warn("combat delete", c.id, err)); if (game.combats.has(c.id)) await wait(800); }
    if (game.combats.has(c.id)) console.warn("rustyspirit: бой не удалился", c.id);
  };
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    const mine = (n) => test(n) || (typeof n === "string" && n.startsWith("Тест: "));   // копии героев: «AF тест: » и «Тест: »
    // бои сцены (до её удаления), а также бои без сцены, чьи участники — наши копии
    const fights = game.combats.filter((c) => test(c.scene?.name) || (!c.scene && c.combatants.some((x) => mine(x.actor?.name) || mine(x.name))) || c.combatants.some((x) => test(x.actor?.name) || test(x.name) || test(game.scenes.get(x.sceneId)?.name)));
    for (const c of fights) await killCombat(c);
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const sceneIds = new Set(scenes.map((s) => s.id));
    const msgIds = new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene)).map((m) => m.id)]);
    const ids = [...msgIds].filter((id) => game.messages.has(id));
    if (ids.length) await ChatMessage.deleteDocuments(ids).catch(() => {});
    // удалённая карточка Поддержания (Сглаз, наговор фамильяра) завершает его: модуль асинхронно снимает связанные эффекты с токенов сцены —
    // сцену удаляем после этого, иначе удаление эффекта уходит на сервер уже без сцены («The Scene … does not exist»)
    if (ids.length || fights.length) await wait(1500);
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
      for (const c of game.combats.filter((c) => c.scene?.id === e.scene.id || c.combatants.some((x) => x.sceneId === e.scene.id))) await killCombat(c);   // бой — до ухода со сцены и до её удаления
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

  // ---------- сценарии RustySpirit ----------
  // Допущения о мире: актёры по id (Дракончик, Марена, Еся); у Марены в записях колдовства Evil Eye, Grim Tendrils, Slashing Gust, Figment; у Еси способность WF11;
  // у Дракончика Channel Elements, Eternal Torch, Scorching Column. Нет предмета — Skip с названием. Сетка 100 px / 5 фт.
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const ID = { dragon: "H6SR8fVSVCHrKOyZ", marena: "M1hLLa1XYRUIBnEz", esya: "OgH7nN3Eq0a7ol5O" };
  const FE = (id) => `Compendium.pf2e.feat-effects.Item.${id}`, SE = (id) => `Compendium.pf2e.spell-effects.Item.${id}`;
  const AURA = FE("pLurcSPQb2gjAzoP"), TORCH = FE("61qS86bjxg8HCJBY"), FIGMENT = SE("2Hg3a06gZCSnUgSA");
  const DEGREE_MOD = { criticalSuccess: 0, success: -10, failure: -11, criticalFailure: -20 };   // итог цели при d20 = 10: mod + 10, СЛ = dc
  const fxOf = (a, uuid) => a.itemTypes.effect.filter((i) => i._stats?.compendiumSource === uuid);
  const aura = (a) => a.itemTypes.effect.filter((i) => i.slug === "effect-kinetic-aura");
  const cnd = (a, slug) => a.itemTypes.condition.filter((c) => c.slug === slug);
  const bySlug = (a, type, slug) => a.itemTypes[type].find((i) => i.slug === slug) ?? null;
  const need = (it, what) => { if (!it) throw new Skip(`нет: ${what}`); return it; };
  const openChat = () => { try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };

  const copyHero = async (e, id, patch = (d) => d) => {
    const h = game.actors.get(id);
    if (!h) throw new Skip(`нет героя ${id}`);
    const d = h.toObject(); delete d._id; delete d.folder;
    const a = await e.add(patch({ ...d, name: h.name }));
    if (a.type !== "familiar") await a.update({ "system.attributes.hp.value": a.hitPoints.max });
    return a;
  };
  const withAnswers = async (e, labels, f) => { const d0 = e.dialogs.length; e.answers = [...labels]; await f(); await wait(2500); const n = e.dialogs.length - d0; e.answers = []; return { n, seen: e.dialogs.slice(d0) }; };
  const next = async (c, label) => { await bound(label, c.nextTurn()); await wait(2500); };
  const turnTo = async (c, a, n = 4) => { for (let i = 0; i < n && c.combatant?.actor?.uuid !== a.uuid; i++) await next(c, "ход"); return c.combatant?.actor?.uuid === a.uuid; };
  const move = async (e, tok, x, y) => {
    const d = e.T(tok);
    if (d.move) await bound("token.move", d.move([{ x, y }], { constrainOptions: { ignoreWalls: true }, autoRotate: false }));
    else await bound("token.update", d.update({ x, y }, { animate: false }));
    await wait(1500);
  };
  /** Спасбросок цели подкручивается так, чтобы при d20 = 10 выпала степень deg против СЛ dc. Прежняя подкрутка снимается. */
  const rigSave = async (e, G, stat, dc, deg) => {
    for (const i of G.itemTypes.effect.filter((i) => i.slug === "af-rig")) await i.delete();
    await e.rig(G, stat, dc + DEGREE_MOD[deg] - G.saves[stat].mod);
  };
  const rigAc = async (e, G, ac) => {
    for (const i of G.itemTypes.effect.filter((i) => i.slug === "af-rig")) await i.delete();
    await e.rig(G, "ac", ac - G.armorClass.value);
  };
  const dcOf = (spell) => spell.spellcasting.statistic.withRollOptions({ item: spell }).dc.value;

  /** Марена (500,500) + Еся (600,500, master = копия Марены) + враг (700,500); бой [Марена, враг], ход Марены. */
  const witchStage = async (e) => {
    openChat();
    const M0 = await copyHero(e, ID.marena);
    const F0 = await copyHero(e, ID.esya, (d) => { d.system.master = { ...(d.system.master ?? {}), id: M0.id }; return d; });
    const foe = await e.foe("враг");
    const tM = await e.tok(M0, 500, 500, 1), tF = await e.tok(F0, 600, 500, 1), tG = await e.tok(foe, 700, 500, -1);
    await wait(700);
    const M = e.A(tM), F = e.A(tF), G = e.A(tG);
    const c = await e.combat([tM, tG], [20, 10]);
    await c.startCombat(); await wait(1200);
    if (!(await turnTo(c, M))) throw new Error("не дошли до хода Марены");
    return { M, F, G, tM, tF, tG, c };
  };
  const castSpell = async (e, s, spell, answers = []) => {
    await e.aim(s.tM, s.tG); await e.fix(10);
    return withAnswers(e, answers, async () => { await bound("сотворение", spell.spellcasting.cast(spell, { consume: false })); await wait(1500); });
  };
  /** Карточка использования предмета (feat/action) «в чат»; -> сообщение. */
  const useCard = async (e, item) => {
    const t0 = e.since();
    await bound("item.toMessage", item.toMessage(undefined, { create: true }));
    return waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.origin?.uuid === item.uuid), 8000);
  };
  /** Область по карточке m: круг радиуса r px в (x,y); ждём, пока модуль заберёт область. -> регион */
  const placeRegion = async (e, m, x, y, r = 200) => {
    await waitFor(() => e.use(m)?.state?.awaitingRegion || e.use(m)?.state?.done, 8000);
    const [region] = await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#00aa55", shapes: [{ type: "circle", hole: false, x, y, radius: r }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: "burst" } } }]);
    await waitFor(() => (e.use(m)?.state?.area?.keys?.length ?? 0) >= 1 || region.behaviors.size, 10000);
    return region;
  };

  // ----- 1. WF11 -----
  const KEY = "af-test:frightened";
  const timedFear = (G) => api().applyCondition(G, { slug: "frightened", value: 1, duration: { value: 2, unit: "rounds", expiry: "turn-end", of: "target" } }, { key: KEY, source: "af-test" }, {});
  const wrapper = (G) => G.itemTypes.effect.find((i) => i.flags?.[MOD]?.meta?.key === KEY);

  sc("wf11-prolong", "WF11: Evil Eye + Еся в 15 фт — срок обёртки frightened 2 -> 3 раунда, флаг prolonged; повторный наговор не продлевает; окна выбора нет (один кандидат)", async (e, t) => {
    const s = await witchStage(e);
    const evil = need(bySlug(s.M, "spell", "evil-eye"), "Evil Eye у Марены");
    need(s.F.items.find((i) => i._stats?.compendiumSource?.endsWith("mu9OL8v4rmr9311e") || i.slug === "familiar-of-ongoing-misery"), "WF11 у Еси");
    await rigSave(e, s.G, "will", dcOf(evil), "success");   // наговор сам ничего не выдаёт: проверяем только способность
    await timedFear(s.G); await wait(800);
    const w0 = wrapper(s.G);
    t.ok(!!w0 && w0.system.duration.value === 2 && w0.system.duration.unit === "rounds", `обёртка со сроком: ${JSON.stringify(w0?.system.duration)}`);
    t.ok(cnd(s.G, "frightened").length === 1, "frightened выдан обёрткой");
    const r1 = await castSpell(e, s, evil, [s.G.name]);   // выбор существа — решение игрока «проклясть или нет», окно есть всегда; эффект один — без окна
    t.ok(!!(await waitFor(() => wrapper(s.G)?.flags?.[MOD]?.prolonged, 8000)), `флаг prolonged: ${JSON.stringify(wrapper(s.G)?.flags?.[MOD])} окна=[${r1.seen}]`);
    t.ok(wrapper(s.G)?.system.duration.value === 3, `срок +1 раунд: ${JSON.stringify(wrapper(s.G)?.system.duration)}`);
    t.ok(r1.n === 1, `одно окно (существо), эффект выбран сам: [${r1.seen}]`);
    const r2 = await castSpell(e, s, evil);
    t.ok(wrapper(s.G)?.system.duration.value === 3, `повтор не продлевает: ${JSON.stringify(wrapper(s.G)?.system.duration)} окна=[${r2.seen}]`);
    const ap = await import(`/modules/${MOD}/scripts/apply.mjs`);
    const diag = s.G.itemTypes.effect.map((x) => `${x.name}|${x.id}|${JSON.stringify(x.system.duration)}|pr=${!!x.flags?.[MOD]?.prolonged}|exp=${x.isExpired}`).join("; ");
    t.ok(r2.n === 0, `кандидатов больше нет — окна нет: [${r2.seen}] prolongable=[${ap.prolongable(s.G).map((x) => x.effect.name + "|" + x.effect.id)}] эффекты: ${diag}`);
  });

  sc("wf11-permanent", "WF11: у врага только бессрочное frightened — окна нет, ничего не продлено", async (e, t) => {
    const s = await witchStage(e);
    const evil = need(bySlug(s.M, "spell", "evil-eye"), "Evil Eye у Марены");
    await rigSave(e, s.G, "will", dcOf(evil), "success");
    await api().applyCondition(s.G, { slug: "frightened", value: 1 }, { key: "af-test:perm", source: "af-test" }, {}); await wait(800);
    t.ok(cnd(s.G, "frightened").length === 1, "бессрочное frightened есть");
    const r = await castSpell(e, s, evil);
    t.ok(r.n === 0, `окна нет: [${r.seen}]`);
    t.ok(!s.G.itemTypes.effect.some((i) => i.flags?.[MOD]?.prolonged), "ничего не помечено prolonged");
    t.ok(cnd(s.G, "frightened").length === 1, "состояние на месте");
  });

  // ----- 2. P2 -----
  const dragonStage = async (e, { foe = false } = {}) => {
    openChat();
    const D0 = await copyHero(e, ID.dragon);
    const tD = await e.tok(D0, 500, 500, 1);
    const g = foe ? await e.foe("враг") : null, tG = g ? await e.tok(g, 1500, 500, -1) : null;
    await wait(700);
    const D = e.A(tD);
    for (const a of aura(D)) await a.delete();
    return { D, tD, G: tG ? e.A(tG) : null, tG };
  };
  /** Карточку «Применить эффект» (self-effect) pf2e создаёт только через внутренний createUseActionMessage, снаружи его не вызвать: собираем карточку
   *  по шаблону pf2e (контекст self-effect, кнопка applyEffect) и жмём кнопку. */
  const channelCard = async (e, D, ce, ms = 6000) => {
    const t0 = e.since();
    const html = await foundry.applications.handlebars.renderTemplate("systems/pf2e/templates/chat/action/collapsed.hbs", { actor: D, data: await ce.getChatData(), selfEffect: true });
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: D }), content: html, flags: { pf2e: { context: { type: "self-effect", item: ce.id } } } });
    return waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.type === "self-effect"), ms);
  };
  const channel = async (e, D, ce) => {
    const m = await channelCard(e, D, ce);
    const b = m && await waitFor(() => e.dom(m)?.querySelector("button[data-action=applyEffect]"), 6000);
    if (!b) throw new Error("нет кнопки applyEffect в карточке Channel Elements");
    b.click();
    return waitFor(() => aura(D).length, 6000);
  };

  sc("p2-aura", "P2: Channel Elements — эффект кинетической ауры есть; Eternal Torch (без overflow) её не гасит; Scorching Column (overflow) — аура снята", async (e, t) => {
    const s = await dragonStage(e);
    const ce = need(bySlug(s.D, "action", "channel-elements"), "Channel Elements у Дракончика");
    t.ok(!!(await channel(e, s.D, ce)), `аура есть: ${s.D.itemTypes.effect.map((i) => i.slug)}`);
    t.ok(fxOf(s.D, AURA).length === 1, `источник эффекта ${AURA}: ${fxOf(s.D, AURA).length}`);
    const torch = need(bySlug(s.D, "feat", "eternal-torch"), "Eternal Torch у Дракончика");
    await useCard(e, torch); await wait(2500);
    t.ok(aura(s.D).length === 1, `без overflow аура держится: ${aura(s.D).length}`);
    const col = need(bySlug(s.D, "feat", "scorching-column"), "Scorching Column у Дракончика");
    await useCard(e, col);
    t.ok(!!(await waitFor(() => !aura(s.D).length, 8000)), `overflow погасил ауру: ${aura(s.D).length}`);
  });

  sc("p2-unconscious", "P2: состояние unconscious снимает кинетическую ауру", async (e, t) => {
    const s = await dragonStage(e);
    // у героя в мире уже лежат dying/unconscious: без снятия increaseCondition не создаёт предмет и createItem не приходит
    await s.D.deleteEmbeddedDocuments("Item", s.D.itemTypes.condition.filter((c) => ["unconscious", "dying"].includes(c.slug)).map((c) => c.id));
    const ce = need(bySlug(s.D, "action", "channel-elements"), "Channel Elements у Дракончика");
    t.ok(!!(await channel(e, s.D, ce)), "аура есть");
    await s.D.increaseCondition("unconscious");
    t.ok(!!(await waitFor(() => !aura(s.D).length, 8000)), `unconscious снял ауру: ${aura(s.D).length}, unconscious=${cnd(s.D, "unconscious").length}`);
  });

  // ----- 3. P3 -----
  sc("p3-zone", "P3: Scorching Column создаёт зону (срок 2 раунда); враг входит в неё движением — 1 урон огнём", async (e, t) => {
    const s = await dragonStage(e, { foe: true });
    const col = need(bySlug(s.D, "feat", "scorching-column"), "Scorching Column у Дракончика");
    await channel(e, s.D, need(bySlug(s.D, "action", "channel-elements"), "Channel Elements у Дракончика"));   // импульс — только при ауре (impulse-gate)
    const m = await useCard(e, col);
    t.ok(!!m && !!e.use(m), "карточка с use");
    const region = await placeRegion(e, m, 1000, 550);
    const b = await waitFor(() => region.behaviors.find((x) => x.type === `${MOD}.zone`), 8000);
    t.ok(!!b, `зона на регионе: ${[...region.behaviors].map((x) => x.type)}`);
    t.ok(b?.system.roundsLeft === 2, `срок зоны 2 раунда: ${b?.system.roundsLeft}`);
    t.ok(b?.system.expiresAt == null, `без срока в секундах: ${b?.system.expiresAt}`);
    const hp0 = s.G.hitPoints.value;
    await move(e, s.tG, 950, 500);
    if (!(await waitFor(() => s.G.hitPoints.value < hp0, 10000)) && m) await e.applyAll(game.messages.get(m.id));
    const lost = hp0 - s.G.hitPoints.value;
    t.ok(lost === 1, `вход в зону: урон 1 (ур. 1: 2*floor(0/3)+1), потеряно ${lost}`);
  });

  // ----- 4. P4 -----
  sc("p4-gust", "P4: Slashing Gust — крит. попадание даёт продолжительное кровотечение, обычное попадание — нет", async (e, t) => {
    const s = await witchStage(e);
    const gust = need(bySlug(s.M, "spell", "slashing-gust"), "Slashing Gust у Марены");
    const total = 10 + gust.spellcasting.statistic.check.mod;   // d20 = 10
    const bleed = () => s.G.itemTypes.condition.find((c) => c.slug === "persistent-damage" && c.system.persistent?.damageType === "bleed");
    for (const [crit, ac] of [[false, total - 5], [true, total - 10]]) {
      const tag = crit ? "крит" : "обычное";
      for (const c of cnd(s.G, "persistent-damage")) await c.delete().catch(() => {});
      await rigAc(e, s.G, ac); await wait(500);
      await e.aim(s.tM, s.tG); await e.fix(10);
      await bound("сотворение", gust.spellcasting.cast(gust, { consume: false })); await wait(1200);
      const t1 = e.since();
      await bound("атака заклинанием", gust.rollAttack(SHIFT()));
      // roll:"system" — снимок use ложится на бросок атаки, не на карточку сотворения
      const att = await waitFor(() => e.msgs(t1).find((m) => /attack-roll/.test(m.flags?.pf2e?.context?.type ?? "") && e.use(m)), 8000);
      t.ok(!!att, `${tag}: атака с use`);
      t.ok(att?.flags?.pf2e?.context?.outcome === (crit ? "criticalSuccess" : "success"), `${tag}: исход ${att?.flags?.pf2e?.context?.outcome}`);
      if (crit && att && !(await waitFor(bleed, 3000))) await e.applyAll(att);
      await waitFor(bleed, crit ? 6000 : 3000);
      await wait(1500);
      t.ok(!!bleed() === crit, `${tag}: кровотечение ${!!bleed()}`);
      if (crit && bleed()) t.ok(/d4/.test(String(bleed().system.persistent?.formula ?? "")), `формула ${bleed().system.persistent?.formula}`);
    }
  });

  // ----- 5. регресс -----
  sc("reg-evil-eye", "Регресс: Evil Eye, провал Воли — sickened 1", async (e, t) => {
    const s = await witchStage(e);
    const evil = need(bySlug(s.M, "spell", "evil-eye"), "Evil Eye у Марены");
    await rigSave(e, s.G, "will", dcOf(evil), "failure");
    const t0 = e.since();
    await castSpell(e, s, evil);
    const m = e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === evil.uuid && x.flags?.[MOD]?.use);
    if (!(await waitFor(() => cnd(s.G, "sickened").length, 12000)) && m) await e.applyAll(game.messages.get(m.id));
    t.ok(!!(await waitFor(() => cnd(s.G, "sickened").length, 6000)), `sickened: ${cnd(s.G, "sickened").length} результаты=${JSON.stringify(m && e.results(m))}`);
    t.ok((cnd(s.G, "sickened")[0]?.value ?? 0) === 1, `значение ${cnd(s.G, "sickened")[0]?.value}`);
  });

  sc("reg-grim-tendrils", "Регресс: Grim Tendrils, провал Стойкости — продолжительное кровотечение", async (e, t) => {
    const s = await witchStage(e);
    const gt = need(bySlug(s.M, "spell", "grim-tendrils"), "Grim Tendrils у Марены");
    await rigSave(e, s.G, "fortitude", dcOf(gt), "failure");
    await e.aim(s.tM); await e.fix(10);
    const t0 = e.since();
    await bound("сотворение", gt.spellcasting.cast(gt, { consume: false }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === gt.uuid && x.flags?.[MOD]?.use), 10000);
    t.ok(!!m, "карточка с use");
    if (!m) return;
    await placeRegion(e, m, 750, 550, 120);   // линия 30 фт заменена кругом вокруг врага: модулю важен состав области, не форма
    const bleed = () => s.G.itemTypes.condition.find((c) => c.slug === "persistent-damage" && c.system.persistent?.damageType === "bleed");
    if (!(await waitFor(bleed, 15000))) await e.applyAll(game.messages.get(m.id));
    t.ok(!!(await waitFor(bleed, 6000)), `кровотечение: ${!!bleed()} результаты=${JSON.stringify(e.results(m))}`);
  });

  sc("reg-eternal-torch", "Регресс: Eternal Torch — эффект на себе", async (e, t) => {
    const s = await dragonStage(e);
    const torch = need(bySlug(s.D, "feat", "eternal-torch"), "Eternal Torch у Дракончика");
    await channel(e, s.D, need(bySlug(s.D, "action", "channel-elements"), "Channel Elements у Дракончика"));   // импульс — только при ауре (impulse-gate)
    await e.aim(s.tD, s.tD);   // цель — сам Дракончик (targets: selected)
    const m = await useCard(e, torch);
    if (!(await waitFor(() => fxOf(s.D, TORCH).length, 6000)) && m) await e.applyAll(m);
    t.ok(!!(await waitFor(() => fxOf(s.D, TORCH).length === 1, 6000)), `эффект факела: ${fxOf(s.D, TORCH).length} (${s.D.itemTypes.effect.map((i) => i.name)})`);
  });

  sc("reg-figment", "Регресс: Figment (Марена) — эффект на себе", async (e, t) => {
    openChat();
    const M0 = await copyHero(e, ID.marena), tM = await e.tok(M0, 500, 500, 1);
    await wait(700);
    const M = e.A(tM), fig = need(bySlug(M, "spell", "figment"), "Figment у Марены");
    await e.aim(tM); await e.fix(10);
    const t0 = e.since();
    await withAnswers(e, [], async () => { await bound("сотворение", fig.spellcasting.cast(fig, { consume: false })); await wait(1500); });
    const m = e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === fig.uuid);
    if (!(await waitFor(() => fxOf(M, FIGMENT).length, 6000)) && m) await e.applyAll(m);
    t.ok(!!(await waitFor(() => fxOf(M, FIGMENT).length === 1, 6000)), `эффект Вымысла: ${fxOf(M, FIGMENT).length} (${M.itemTypes.effect.map((i) => i.name)})`);
  });

  // ----- 6. паки A–F (аудит 2026-11-06): лимиты, урон по итогам, зоны, Поддержание, предметы, дальность -----
  // Предупреждения модуля ловит перехват ui.notifications (notes); смотрим по ключевым словам, не по точному тексту. Копии героев удаляет уборка каркаса
  // (флаги hexTurn/reactionSpent/overflowRound, фокус и эффекты лежат на копиях), реальные герои не затрагиваются.
  const LAMBAST = "Compendium.pf2e.sky-kings-tomb-bestiary.Actor.NHbYudz9IZYGGJYF.Item.22Ohdl0fgqNIs2mn";
  const PHASE_FX = SE("61Hl31nyzt63vvX9");
  const warnsFrom = (n0) => notes.slice(n0).filter((n) => n.startsWith("warn:"));
  const nextRound = async (c) => { await bound("раунд", c.nextRound()); await wait(2500); };
  /** Сотворение Марены на токен tok (null — без цели). consume: настоящее списание слота/фокуса. -> {n, seen, msg (карточка сотворения или null), warns} */
  const castTo = async (e, s, spell, tok, { consume = false, answers = [] } = {}) => {
    await (tok ? e.aim(s.tM, tok) : e.aim(s.tM)); await e.fix(10);
    const n0 = notes.length, t0 = e.since();
    const r = await withAnswers(e, answers, async () => { await bound("сотворение", spell.spellcasting.cast(spell, { consume })); await wait(1500); });
    return { ...r, msg: e.msgs(t0).find((m) => m.flags?.pf2e?.origin?.uuid === spell.uuid) ?? null, warns: warnsFrom(n0) };
  };
  /** Карточка предмета «в чат» без ожидания снимка use: блок виден по отсутствию сообщения. */
  const tryCard = async (e, item, att, ...targets) => {
    if (att) await e.aim(att, ...targets);
    const n0 = notes.length, t0 = e.since();
    await bound("item.toMessage", item.toMessage(undefined, { create: true }));
    await wait(2000);
    return { msg: e.msgs(t0).find((m) => m.flags?.pf2e?.origin?.uuid === item.uuid) ?? null, warns: warnsFrom(n0) };
  };
  const focusOf = (a) => a.system.resources?.focus?.value;

  // ----- пак A: лимиты использования -----
  sc("a-hex-once", "A: один наговор за ход — Evil Eye проходит, второй Evil Eye и Phase Familiar блокируются (фокус не списан), следующий ход — наговор проходит", async (e, t) => {
    const s = await witchStage(e);
    const evil = need(bySlug(s.M, "spell", "evil-eye"), "Evil Eye у Марены"), phase = need(bySlug(s.M, "spell", "phase-familiar"), "Phase Familiar у Марены");
    if ((s.M.system.resources?.focus?.max ?? 0) < 1) throw new Skip("у копии Марены нет фокус-пула (max < 1)");
    await s.M.update({ "system.resources.focus.value": 1 }); await wait(300);
    await rigSave(e, s.G, "will", dcOf(evil), "success");
    const r1 = await castTo(e, s, evil, s.tG);
    t.ok(!!r1.msg, `первый наговор прошёл: карточка ${!!r1.msg}`);
    const key = `${s.c.id}:${s.c.round}:${s.c.turn}`;
    t.ok(!!(await waitFor(() => e.A(s.tM).flags?.[MOD]?.hexTurn === key, 5000)), `отметка hexTurn=${s.M.flags?.[MOD]?.hexTurn}, ждали ${key}`);
    const r2 = await castTo(e, s, evil, s.tG);
    t.ok(!r2.msg, `второй Evil Eye блокирован: карточка ${!!r2.msg}`);
    t.ok(r2.warns.some((w) => /наговор/i.test(w)), `предупреждение о наговоре: [${r2.warns}]`);
    const r3 = await castTo(e, s, phase, s.tF, { consume: true });
    t.ok(!r3.msg, `Phase Familiar блокирован: карточка ${!!r3.msg}`);
    t.ok(r3.warns.some((w) => /наговор/i.test(w)), `предупреждение у Phase Familiar: [${r3.warns}]`);
    t.ok(focusOf(s.M) === 1, `фокус не списан: ${focusOf(s.M)}`);
    await next(s.c, "ход врага");
    if (!(await turnTo(s.c, s.M))) throw new Error("не дошли до следующего хода Марены");
    const r4 = await castTo(e, s, phase, s.tF, { consume: true });
    t.ok(!!r4.msg, `в следующий ход наговор проходит: карточка ${!!r4.msg} предупреждения [${r4.warns}]`);
    t.ok(focusOf(s.M) === 0, `фокус списан один раз: ${focusOf(s.M)}`);
  });

  sc("a-channel-active", "A: «Проведение стихийной энергии» при активной ауре — карточки нет, предупреждение, аура одна", async (e, t) => {
    const s = await dragonStage(e);
    const ce = need(bySlug(s.D, "action", "channel-elements"), "Channel Elements у Дракончика");
    t.ok(!!(await channel(e, s.D, ce)), "первая аура есть");
    const n0 = notes.length;
    const m = await channelCard(e, s.D, ce, 3000);
    t.ok(!m, `вторая карточка Проведения не создана: ${!!m}`);
    t.ok(warnsFrom(n0).some((w) => /уже активна/i.test(w)), `предупреждение «аура уже активна»: [${warnsFrom(n0)}]`);
    t.ok(aura(s.D).length === 1, `аура одна: ${aura(s.D).length}`);
  });

  sc("a-reaction-round", "A: реакция с листа дважды за раунд — вторая блок (флаг reactionSpent), новый раунд — можно", async (e, t) => {
    const s = await witchStage(e);
    // у копий нет подходящей реакции — временное действие-реакция (гейт смотрит system.actionType.value = reaction)
    const [rx] = await e.give(s.M, { type: "action", name: "AF реакция", system: { slug: "af-reaction", actionType: { value: "reaction" }, actions: { value: null }, description: { value: "<p>тест</p>" } } });
    const r1 = await tryCard(e, rx);
    t.ok(!!r1.msg, `первая реакция прошла: ${!!r1.msg} [${r1.warns}]`);
    const spent = () => s.M.flags?.[MOD]?.reactionSpent;
    t.ok(!!(await waitFor(() => spent()?.round === 1, 5000)), `флаг reactionSpent: ${JSON.stringify(spent())}`);
    const r2 = await tryCard(e, rx);
    t.ok(!r2.msg, `вторая в том же раунде блокирована: ${!!r2.msg}`);
    t.ok(r2.warns.some((w) => /реакци/i.test(w)), `предупреждение о реакции: [${r2.warns}]`);
    await nextRound(s.c);
    const r3 = await tryCard(e, rx);
    t.ok(!!r3.msg, `в новом раунде снова можно: ${!!r3.msg} [${r3.warns}]`);
  });

  // ----- пак B: урон по итогам -----
  /** Дракончик с аурой, враг далеко (1500); при combat — бой [враг, Дракончик], ход Дракончика. Колонна — s.col. */
  const colStage = async (e, { combat = false } = {}) => {
    const s = await dragonStage(e, { foe: true });
    s.col = need(bySlug(s.D, "feat", "scorching-column"), "Scorching Column у Дракончика");
    const ce = need(bySlug(s.D, "action", "channel-elements"), "Channel Elements у Дракончика");
    if (combat) {
      s.c = await e.combat([s.tG, s.tD], [20, 10]);
      await s.c.startCombat(); await wait(1200);
      if (!(await turnTo(s.c, s.D))) throw new Error("не дошли до хода Дракончика");
    }
    await channel(e, s.D, ce);   // импульс — только при ауре
    await e.aim(s.tD, s.tG);
    return s;
  };
  const zoneOf = (region) => region.behaviors.find((x) => x.type === `${MOD}.zone`);
  const regionAlive = (e, region) => e.scene.regions.has(region.id);

  sc("b-column-link", "B: Scorching Column — ссылка урона опасной местности погашена (paf-dealt), одна кнопка «Урон»; бросок по погашенной формуле не связывается, бросок кнопкой связан", async (e, t) => {
    const s = await colStage(e);
    const DR = CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll" || r.CLASS_NAME === "DamageRoll");
    if (!DR) throw new Skip("нет класса DamageRoll в CONFIG.Dice.rolls");
    const m = await useCard(e, s.col);
    t.ok(!!m && !!e.use(m), "карточка с use");
    await placeRegion(e, m, 800, 550);
    const dom = await waitFor(() => { const el = e.dom(m); return el?.querySelector(".paf-damage-box button") && el; }, 8000);
    t.ok(!!dom?.querySelector(".paf-dealt"), "ссылка урона зоны погашена (span.paf-dealt)");
    t.ok(dom?.querySelectorAll(".paf-damage-box button").length === 1, `кнопок «Урон»: ${dom?.querySelectorAll(".paf-damage-box button").length}`);
    // бросок по погашенной формуле (как клик по ссылке зоны) — раньше, чем кнопка: связанная карточка второй раз не связывается и дала бы ложный проход
    const roll = await new DR("{1[fire]}").evaluate();
    const t1 = e.since();
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: s.D }), rolls: [roll], flags: { pf2e: { context: { type: "damage-roll", options: [] }, origin: { uuid: s.col.uuid, type: "feat", actor: s.D.uuid } } } });
    await wait(2500);
    const fake = e.msgs(t1).find((x) => x.flags?.pf2e?.context?.type === "damage-roll");
    t.ok(!!fake, "сообщение урона по формуле зоны создано");
    t.ok(!fake?.flags?.[MOD]?.basicDamage, `погашенная формула не связана: ${JSON.stringify(fake?.flags?.[MOD]?.basicDamage)}`);
    const t2 = e.since();
    (e.dom(m)?.querySelector(".paf-damage-box button"))?.click();
    const dmg = await waitFor(() => e.msgs(t2).find((x) => x.flags?.pf2e?.context?.type === "damage-roll" && x.id !== fake?.id && x.flags?.[MOD]?.basicDamage), 10000);
    t.ok(!!dmg, `бросок кнопкой связан (flags.${MOD}.basicDamage): ${JSON.stringify(e.msgs(t2).filter((x) => x.flags?.pf2e?.context?.type === "damage-roll").map((x) => !!x.flags?.[MOD]?.basicDamage))}`);
  });

  sc("b-tendrils-table", "B: Grim Tendrils — таблица множителей [2,1,0.5,0] на уроне; провал ×1, успех ×½ (кнопка «Нанести»)", async (e, t) => {
    const s = await witchStage(e);
    const gt = need(bySlug(s.M, "spell", "grim-tendrils"), "Grim Tendrils у Марены");
    const g2 = await e.foe("враг 2"), tG2 = await e.tok(g2, 700, 600, -1);
    await wait(700);
    const G2 = e.A(tG2), dc = dcOf(gt);
    await rigSave(e, s.G, "fortitude", dc, "failure"); await rigSave(e, G2, "fortitude", dc, "success");
    const prev = setting("mode.apply");
    await game.settings.set(MOD, "mode.apply", "button");   // нанесение — кнопкой ГМа
    try {
      await e.aim(s.tM, s.tG, tG2); await e.fix(10);
      const t0 = e.since();
      await bound("сотворение", gt.spellcasting.cast(gt, { consume: false }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === gt.uuid && x.flags?.[MOD]?.use), 10000);
      t.ok(!!m, "карточка с use");
      if (!m) return;
      await placeRegion(e, m, 725, 550, 200);   // круг вокруг обоих врагов: важен состав области
      if (!(await waitFor(() => Object.keys(e.results(m)).length >= 2, 15000))) await e.applyAll(game.messages.get(m.id));
      const res = Object.values(e.results(m)).sort().join();
      t.ok(res === "failure,success", `степени целей: ${res}`);
      const hp1 = s.G.hitPoints.value, hp2 = G2.hitPoints.value, t1 = e.since();
      await e.aim(s.tM, s.tG);
      await bound("урон заклинания", gt.rollDamage(SHIFT()));
      const dmg = await waitFor(() => e.msgs(t1).find((x) => x.flags?.pf2e?.context?.type === "damage-roll" && x.flags?.[MOD]?.basicDamage), 10000);
      t.ok(!!dmg, "урон связан с карточкой");
      if (!dmg) return;
      t.ok(JSON.stringify(dmg.flags[MOD].basicDamage.table) === "[2,1,0.5,0]", `table: ${JSON.stringify(dmg.flags[MOD].basicDamage.table)}`);
      const btn = await waitFor(() => e.dom(dmg)?.querySelector("[data-af-basic-apply]"), 8000);
      t.ok(!!btn, "кнопка «Нанести» (режим button)");
      btn?.click();
      await waitFor(() => s.G.hitPoints.value < hp1 && G2.hitPoints.value < hp2, 12000); await wait(1500);
      const R = game.messages.get(dmg.id).rolls[0].total, l1 = hp1 - s.G.hitPoints.value, l2 = hp2 - G2.hitPoints.value;
      t.ok(l1 === R, `провал ×1: потеряно ${l1} из ${R}`);
      t.ok(l2 > 0 && l2 < l1 && Math.abs(l2 - R / 2) <= 1, `успех ×½: потеряно ${l2} из ${R}`);
    } finally { await game.settings.set(MOD, "mode.apply", prev); }
  });

  sc("b-persistent-button", "B: Lambast (чистый продолжительный урон по степени) — до спасбросков «ещё нет»; провал накладывается, успех нет; повтор не дублирует", async (e, t) => {
    openChat();
    const A0 = await e.pc("Заклинатель", [await src(LAMBAST)]);   // подмена Burning Demand: у него смешанный урон (обычный + продолжительный), у Lambast — чистый и только при провале
    const f1 = await e.foe("враг 1"), f2 = await e.foe("враг 2");
    const tA = await e.tok(A0, 500, 500, 1), tF1 = await e.tok(f1, 700, 500, -1), tF2 = await e.tok(f2, 700, 600, -1);
    await wait(700);
    const lam = need(bySlug(e.A(tA), "action", "lambast"), "Lambast у временного персонажа"), F1 = e.A(tF1), F2 = e.A(tF2);
    const prev = setting("mode.challenge");
    await game.settings.set(MOD, "mode.challenge", "button");   // спасброски не бросаются сами: до них «ещё нет»
    try {
      await e.fix(10);
      await rigSave(e, F1, "will", 18, "failure"); await rigSave(e, F2, "will", 18, "success");
      await e.aim(tA, tF1, tF2);
      const m = await useCard(e, lam);
      if (!m || !(await waitFor(() => e.use(m), 8000))) throw new Error("у карточки Lambast нет снимка use");
      if (!e.use(m).rule?.onUse?.challenge) throw new Skip("у правила Lambast нет испытания — кнопка накладывает всем сразу");
      // правило Lambast само накладывает продолжительный урон по степени (byDegree.persistent): ссылка в описании погашена, кнопки «Наложить» нет — так и задумано
      const pers = (a) => cnd(a, "persistent-damage").length;
      t.ok(!e.dom(m)?.querySelector(".paf-damage-box button"), "кнопки продолжительного урона нет: урон наносит правило");
      t.ok(pers(F1) + pers(F2) === 0, `до спасбросков ничего не наложено: ${pers(F1)}/${pers(F2)}`);
      // mode.challenge=button: модуль бросает только по цели (only) — как кнопка «Бросить» в строке цели
      const run = async () => {
        const sv = await imp("saves.mjs");
        for (const k of [tF1.id, tF2.id]) await sv.runChallenge(game.messages.get(m.id), { only: k });
        await waitFor(() => Object.keys(game.messages.get(m.id)?.flags?.[MOD]?.use?.state?.challenge?.results ?? {}).length >= 2, 10000);   // итоги пишутся после бросков асинхронно
        await wait(500);
        {   // правило Lambast выведено из разметки (confidence low) — даже в auto шаги идут кнопкой ГМа «Применить всё» (effectiveMode); повтор идемпотентен
          // то же, что кнопка «Применить всё» (chat.mjs: callGM("applyByDegree", id, "all")); щелчок скриптом по перерисовываемой карточке ненадёжен
          await (await imp("util.mjs")).callGM("applyByDegree", m.id, "all");
          await waitFor(() => pers(F1), 5000);
        }
      };
      await run();
      await waitFor(() => Object.keys(e.results(m)).length >= 2, 10000);
      t.ok(e.results(m)[F1.id] === "failure" || Object.values(e.results(m)).includes("failure"), `итоги: ${JSON.stringify(e.results(m))}`);
      const st = game.messages.get(m.id)?.flags?.[MOD]?.use?.state?.challenge ?? {};
      t.ok(pers(F1) === 1, `провал — наложено: ${pers(F1)} (F1 ${tF1.id}, F2 ${tF2.id}; итоги ${JSON.stringify(Object.fromEntries(Object.entries(st.results ?? {}).map(([k, r]) => [k, r.degree])))}; применено ${JSON.stringify(Object.keys(st.applied ?? {}))}; кнопки ${[...(e.dom(game.messages.get(m.id))?.querySelectorAll(".pf2e-automato button") ?? [])].map((b) => JSON.stringify(b.dataset)).join(" ")})`);
      t.ok(pers(F2) === 0, `успех — не наложено: ${pers(F2)}`);
      await run();
      t.ok(pers(F1) === 1, `повтор не дублирует: ${pers(F1)}`);
    } finally { await game.settings.set(MOD, "mode.challenge", prev); }
  });

  // ----- пак C: зоны -----
  /** Колонна на ходу Дракончика в бою [враг, Дракончик] -> {s, m, region, b}. Основание в 30 фт (дальность 60). */
  const columnZone = async (e, t) => {
    const s = await colStage(e, { combat: true });
    const m = await useCard(e, s.col);
    const region = await placeRegion(e, m, 800, 550);
    const b = await waitFor(() => zoneOf(region), 8000);
    t.ok(!!b, "зона на регионе");
    return { s, m, region, b };
  };
  const SUS = () => imp("sustain.mjs");

  sc("c-zone-turn", "C: срок колонны по ходу автора (endRound/maxRound), имя поведения = название с листа; без Поддержания регион удалён к концу следующего хода", async (e, t) => {
    const { s, region, b } = await columnZone(e, t);
    t.ok(b?.name === s.col.name, `имя поведения «${b?.name}», с листа «${s.col.name}»`);
    t.ok(b?.name !== "Scorching Column" || s.col.name === "Scorching Column", "не английский label каталога");
    t.ok(b?.system.endRound === 2 && b?.system.roundsLeft == null, `endRound ${b?.system.endRound}, roundsLeft ${b?.system.roundsLeft}`);
    t.ok(b?.system.maxRound === 11, `maxRound (1 + sustainMax 10): ${b?.system.maxRound}`);
    await next(s.c, "ход врага"); await next(s.c, "ход Дракончика, раунд 2");
    t.ok(regionAlive(e, region), "в свой следующий ход Дракончика зона ещё стоит");
    await next(s.c, "ход врага, раунд 3");
    t.ok(!!(await waitFor(() => !regionAlive(e, region), 8000)), "после следующего хода без Поддержания регион удалён");
  });

  sc("c-zone-sustain", "C: «Поддержать» в следующий ход продлевает зону — endRound +1, регион жив; без повторного Поддержания кончается", async (e, t) => {
    const { s, m, region, b } = await columnZone(e, t);
    const sus = await SUS();
    await next(s.c, "ход врага"); await next(s.c, "ход Дракончика, раунд 2");
    const r = await bound("Поддержание", sus.run(s.D.uuid, sus.anchorKey(m.id), "support"));
    t.ok(r?.result === "fresh", `Поддержание засчитано: ${JSON.stringify(r)}`);
    t.ok(!!(await waitFor(() => b.system.endRound === 3, 6000)), `endRound +1: ${b?.system.endRound}`);
    await next(s.c, "ход врага, раунд 3");
    t.ok(regionAlive(e, region), "после Поддержания регион жив");
    await next(s.c, "ход Дракончика, раунд 3"); await next(s.c, "ход врага, раунд 4");
    t.ok(!!(await waitFor(() => !regionAlive(e, region), 8000)), "без второго Поддержания регион удалён");
  });

  sc("c-zone-dismiss", "C: «Прекратить» (Dismiss) якоря удаляет регион колонны сразу", async (e, t) => {
    const { s, m, region } = await columnZone(e, t);
    const sus = await SUS();
    t.ok(!!sus.findAnchor(s.D, sus.anchorKey(m.id)), "якорь Поддержания есть");
    await bound("Прекращение", sus.run(s.D.uuid, sus.anchorKey(m.id), "dismiss"));
    t.ok(!!(await waitFor(() => !regionAlive(e, region), 8000)), "регион удалён сразу");
  });

  sc("c-area-far", "C: регион колонны (flags.pf2e.origin) на ~80 фт от Дракончика не создаётся, предупреждение; на ~30 фт — создаётся", async (e, t) => {
    const s = await dragonStage(e);
    const col = need(bySlug(s.D, "feat", "scorching-column"), "Scorching Column у Дракончика");
    const origin = { uuid: col.uuid, type: "feat", actor: s.D.uuid, token: s.tD.uuid };
    const mk = (x) => ({ name: `${PFX}область`, color: "#00aa55", shapes: [{ type: "circle", hole: false, x, y: 550, radius: 100 }], behaviors: [], flags: { pf2e: { origin, areaShape: "burst" } } });
    const c0 = e.scene.regions.size, n0 = notes.length;
    const far = await e.scene.createEmbeddedDocuments("Region", [mk(2250)]);   // клетка 22 при токене в клетке 5: ~80 фт
    t.ok(!far.length && e.scene.regions.size === c0, `далёкий регион не создан: вернулось ${far.length}, регионов ${e.scene.regions.size}/${c0}`);
    t.ok(warnsFrom(n0).some((w) => /дальше дальности/i.test(w)), `предупреждение о дальности: [${warnsFrom(n0)}]`);
    const near = await e.scene.createEmbeddedDocuments("Region", [mk(1250)]);   // ~30 фт
    t.ok(near.length === 1 && e.scene.regions.size === c0 + 1, `ближний регион создан: ${near.length}`);
  });

  // ----- пак D: Поддержание эффектов заклинаний -----
  /** Марена кастует Figment на себя (ход Марены, бой [Марена, враг]); есть якорь и эффект. */
  const figStage = async (e, t) => {
    const s = await witchStage(e);
    const fig = need(bySlug(s.M, "spell", "figment"), "Figment у Марены"), sus = await SUS();
    const r = await castTo(e, s, fig, null);
    if (!r.msg) throw new Error("нет карточки сотворения Figment");
    if (!(await waitFor(() => fxOf(s.M, FIGMENT).length, 6000))) await e.applyAll(r.msg);
    s.key = sus.anchorKey(r.msg.id); s.sus = sus;
    t.ok(!!(await waitFor(() => sus.findAnchor(s.M, s.key), 6000)), "якорь Поддержания есть");
    t.ok(fxOf(s.M, FIGMENT).length === 1, `эффект Вымысла есть: ${fxOf(s.M, FIGMENT).length}`);
    return s;
  };

  sc("d-figment-drop", "D: Figment — круг Марены без Поддержания: якорь и эффект Вымысла сняты", async (e, t) => {
    const s = await figStage(e, t);
    await next(s.c, "ход врага"); await next(s.c, "ход Марены, раунд 2"); await next(s.c, "конец хода Марены без Поддержания");
    t.ok(!!(await waitFor(() => !s.sus.findAnchor(s.M, s.key), 8000)), "якорь снят");
    t.ok(!!(await waitFor(() => !fxOf(s.M, FIGMENT).length, 8000)), `эффект Вымысла снят: ${fxOf(s.M, FIGMENT).length}`);
  });

  sc("d-figment-sustain", "D: Figment — с Поддержанием в круге Марены якорь и эффект живы", async (e, t) => {
    const s = await figStage(e, t);
    await next(s.c, "ход врага"); await next(s.c, "ход Марены, раунд 2");
    const r = await bound("Поддержание", s.sus.run(s.M.uuid, s.key, "support"));
    t.ok(r?.result === "fresh", `Поддержание засчитано: ${JSON.stringify(r)}`);
    await next(s.c, "конец хода Марены с Поддержанием"); await wait(1500);
    t.ok(!!s.sus.findAnchor(s.M, s.key), "якорь жив");
    t.ok(fxOf(s.M, FIGMENT).length === 1, `эффект Вымысла жив: ${fxOf(s.M, FIGMENT).length}`);
  });

  // ----- пак E: предметы -----
  sc("e-torch-limit", "E: лимит Вечных факелов = мод. Телосложения; n+1-й — блок с предупреждением (при 0 — первый же)", async (e, t) => {
    const s = await dragonStage(e);
    const torch = need(bySlug(s.D, "feat", "eternal-torch"), "Eternal Torch у Дракончика"), ce = need(bySlug(s.D, "action", "channel-elements"), "Channel Elements у Дракончика");
    const n = Math.max(0, s.D.abilities.con.mod);
    if (n > 3) throw new Skip(`мод. Телосложения ${n}: слишком много факелов для прогона`);
    const allies = [];
    for (let i = 0; i <= n; i++) allies.push(await e.tok(await e.foe(`союзник ${i + 1}`), 700 + i * 100, 500, 1));   // каждый факел — на своего носителя
    await wait(700);
    await channel(e, s.D, ce);
    const active = () => e.scene.tokens.contents.flatMap((tk) => tk.actor?.itemTypes.effect ?? []).filter((i) => i._stats?.compendiumSource === TORCH && !i.isExpired).length;
    for (let i = 0; i < n; i++) {
      const r = await tryCard(e, torch, s.tD, allies[i]);
      t.ok(!!r.msg, `факел ${i + 1} из ${n} проходит: [${r.warns}]`);
      if (r.msg && !(await waitFor(() => active() === i + 1, 6000))) await e.applyAll(r.msg);
      t.ok(active() === i + 1, `действующих факелов ${active()}, ждали ${i + 1}`);
    }
    const r = await tryCard(e, torch, s.tD, allies[n]);
    t.ok(!r.msg, `факел ${n + 1}-й (лимит ${n}) блокирован: ${!!r.msg}`);
    t.ok(r.warns.some((w) => /факел/i.test(w)), `предупреждение о лимите факелов: [${r.warns}]`);
    t.ok(active() === n, `факелов осталось ${active()}`);
  });

  sc("e-phase-familiar", "E: Phase Familiar — реакция onDamaged: шёпот по урону по Есе, урон ждёт решения, фокус и реакция, сопротивление 5 против триггерного урона, эффект снят; на врага — эффекта нет", async (e, t) => {
    const s = await witchStage(e);
    const phase = need(bySlug(s.M, "spell", "phase-familiar"), "Phase Familiar у Марены");
    await s.M.update({ "system.resources.focus.value": 1 });
    await next(s.c, "ход врага");
    // урон врага по Есе: карточка урона Удара (без броска атаки)
    await e.aim(s.tG, s.tF);
    const t0 = e.since(), st = e.strike(s.G);
    if (!st) throw new Error("у врага нет ближнего Удара");
    await bound("урон Удара врага", st.damage({ event: SHIFT() }));
    const dmg = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "damage-roll"), 8000);
    if (!dmg) throw new Error("нет карточки урона");
    const hint = await waitFor(() => e.msgs(t0).find((m) => m.flags?.[MOD]?.damaged?.token === s.tF.uuid), 8000);
    t.ok(!!hint, "шёпот реакции Марене по урону по Есе");
    if (!hint) return;
    t.ok(hint.flags[MOD].damaged.state === "pending" && hint.whisper.includes(game.user.id), `подсказка pending, ГМ в адресатах: ${hint.flags[MOD].damaged.state}`);
    t.ok(e.dom(hint)?.querySelector('[data-af-damaged="use"]')?.textContent?.trim() === phase.name, `кнопка — название с листа: «${e.dom(hint)?.querySelector('[data-af-damaged="use"]')?.textContent?.trim()}»`);
    const hp0 = s.F.hitPoints.value, total = dmg.rolls[0].total;
    let applied = false;
    const p = s.F.applyDamage({ damage: dmg.rolls[0], token: s.tF, item: dmg.item, rollOptions: new Set(dmg.flags.pf2e.context.options ?? []) }).then(() => { applied = true; });
    await wait(1500);
    t.ok(!applied && s.F.hitPoints.value === hp0, `урон ждёт решения: применён ${applied}, ОЗ ${s.F.hitPoints.value}/${hp0}`);
    e.dom(hint)?.querySelector('[data-af-damaged="use"]')?.click();
    await bound("урон после реакции", p, 20000);
    const lost = hp0 - s.F.hitPoints.value, expect = Math.min(hp0, Math.max(0, total - 5));
    t.ok(lost === expect, `урон с сопротивлением 5: потеряно ${lost}, ждали ${expect} (бросок ${total})`);
    t.ok(focusOf(s.M) === 0, `фокус потрачен: ${focusOf(s.M)}`);
    t.ok(!!s.M.getFlag(MOD, "reactionSpent"), "реакция Марены отмечена");
    t.ok(e.msgs(t0).some((m) => m.flags?.pf2e?.origin?.uuid === phase.uuid), "карточка сотворения Phase Familiar");
    t.ok(!!(await waitFor(() => !fxOf(s.F, PHASE_FX).length, 6000)), `эффект снят после триггерного урона: ${fxOf(s.F, PHASE_FX).length}`);
    t.ok(game.messages.get(hint.id)?.flags[MOD].damaged.state === "used", `подсказка used: ${game.messages.get(hint.id)?.flags[MOD].damaged.state}`);
    // второй урон в том же раунде — реакции нет, подсказки нет
    const t1 = e.since();
    await bound("второй урон", st.damage({ event: SHIFT() }));
    await wait(2500);
    t.ok(!e.msgs(t1).some((m) => m.flags?.[MOD]?.damaged), "реакция потрачена — второй подсказки нет");
    await s.M.update({ "system.resources.focus.value": 1 });
    if (!(await turnTo(s.c, s.M))) throw new Error("не дошли до следующего хода Марены");   // наговор — один за ход
    const r2 = await castTo(e, s, phase, s.tG);
    if (r2.msg && !(await waitFor(() => fxOf(s.G, PHASE_FX).length, 4000))) await e.applyAll(r2.msg);
    await wait(1500);
    t.ok(!fxOf(s.G, PHASE_FX).length, `на враге эффекта нет: ${fxOf(s.G, PHASE_FX).length} (карточка ${!!r2.msg}, предупреждения [${r2.warns}])`);
  });

  sc("e-wf11-curse", "E: WF11 — враг с иммунитетом к curse не кандидат продления", async (e, t) => {
    const s = await witchStage(e);
    const evil = need(bySlug(s.M, "spell", "evil-eye"), "Evil Eye у Марены");
    need(s.F.items.find((i) => i._stats?.compendiumSource?.endsWith("mu9OL8v4rmr9311e") || i.slug === "familiar-of-ongoing-misery"), "WF11 у Еси");
    const ap = await import(`/modules/${MOD}/scripts/apply.mjs`);
    await rigSave(e, s.G, "will", dcOf(evil), "success");
    await timedFear(s.G); await wait(800);
    t.ok(ap.prolongable(s.G).length === 1, `без иммунитета кандидат есть: ${ap.prolongable(s.G).length}`);
    await e.give(s.G, { type: "effect", name: "AF иммунитет", system: { slug: "af-immune-curse", rules: [{ key: "Immunity", type: ["curse"] }] } }); await wait(800);
    t.ok(s.G.system.attributes.immunities?.some?.((i) => i.type === "curse"), `иммунитет к curse: ${JSON.stringify(s.G.system.attributes.immunities?.map?.((i) => i.type))}`);
    // иммунитет отсекает кандидата выбором существа (choose.from:"enemies"), а не prolongable: проверяем итогом сотворения ниже
    const r = await castTo(e, s, evil, s.tG);
    t.ok(!wrapper(s.G)?.flags?.[MOD]?.prolonged, `срок не продлён: ${JSON.stringify(wrapper(s.G)?.system.duration)}`);
    t.ok(r.n === 0, `окна выбора нет: [${r.seen}]`);
  });

  // ----- пак F: дальность не-заклинаний -----
  sc("f-flying-flame-range", "F: Летающее пламя — цель на 55 фт: far в снимке и предупреждение; на 20 фт — нет", async (e, t) => {
    const s = await dragonStage(e, { foe: true });
    const ff = need(bySlug(s.D, "feat", "flying-flame"), "Flying Flame у Дракончика");
    await channel(e, s.D, need(bySlug(s.D, "action", "channel-elements"), "Channel Elements у Дракончика"));
    const dist = () => e.T(s.tD).object?.distanceTo?.(e.T(s.tG).object);
    for (const [x, ft, far] of [[1600, 55, true], [900, 20, false]]) {
      await move(e, s.tG, x, 500);
      t.ok(Math.abs(dist() - ft) <= 5, `расстояние после остановки ${dist()} (ждали ~${ft})`);
      const n0 = notes.length, t0 = e.since();
      const m = await e.fire(ff, s.tD, s.tG);
      const tg = e.use(m).targets ?? [];
      t.ok(tg.some((x) => x.far) === far, `${ft} фт: far в снимке ${JSON.stringify(tg.map((x) => x.far ?? null))}`);
      const warned = warnsFrom(n0).some((w) => /вне дальности/i.test(w)) || e.msgs(t0).some((x) => /вне дальности/i.test(x.content ?? ""));
      t.ok(warned === far, `${ft} фт: предупреждение «вне дальности» ${warned}`);
    }
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  const applyPrev = setting("mode.apply");
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами
    if (applyPrev !== "auto") await game.settings.set(MOD, "mode.apply", "auto");   // по умолчанию button: результаты не выдаются сами
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} rustyspirit | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      // шум ядра/pf2e при уборке: всплывающий текст токена дорисовывается после удаления сцены (не модуль)
      const errs = notes.filter((n) => /^(console\.error|uncaught)/.test(n) && !/createScrollingText|showFloatyText|reading 'position'\) at set y/.test(n));
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
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afRSResult = out;
  return out;
}
