async () => {
  // Живой сценарий l3-chunk4: Sanctuary (Убежище) — удержание атаки hold: preCreate-флаги, карточка Воли у нападающего, четыре степени, метки passed/stopped/barred, Подсечка, переброс, две атаки, режимы, конец заклинания.
  // Вкладка активного ГМа-лидера. Режимы мира: challenge = auto, effect = auto, apply = button (кнопку «Применить» на карточке Воли прогон жмёт сам), damageGate = auto. Только временные «AF тест: …» актёры/сцена/бой; реальных персонажей не трогает.
  // Пак: если «Spell Effect: Sanctuary» и три метки ещё не собраны в пак (node tools/build-packs.mjs при закрытом мире), прогон создаёт временные документы с теми же id в pf2e-automato.effects и удаляет их в конце.
  // Параметры (перед запуском): window.__afL3d = { only: ["held", ...], skip: [...], cleanOnly: true }. Результат: массив «PASS|FAIL|SKIP id: подробности» (window.__afL3dResult, console.table).
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL3d ?? {}) };
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

  // ---------- уборка (аварийная: window.__afL3d = {cleanOnly: true}) ----------
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

  // ---------- сценарии l3-chunk4: Sanctuary (удержание атаки, hold) ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const SP = "Compendium.pf2e.spells-srd.Item.";
  const SANC = "8xRzLhwGL7Dgy3EZ";
  const FXP = "Compendium.pf2e-automato.effects.Item.";
  const FX = { carrier: "SnctuaryEffect01", passed: "SnctPassedMark01", stopped: "SnctStoppedMark1", barred: "SnctBarredMark01" };
  const SLUG = { carrier: "spell-effect-sanctuary", passed: "effect-sanctuary-passed", stopped: "effect-sanctuary-stopped", barred: "effect-sanctuary-barred" };
  const NIMBLE = "Compendium.pf2e.feats-srd.Item.dNH8OHEvx3vI9NBQ";   // Проворное уклонение: onAttacked-правило (подсказка реакции)
  // Итог Воли при d20 = 10 — mod + 10: нужный модификатор = СЛ + DEGREE_MOD[степень] (крит. успех — итог СЛ + 10, успех — СЛ, провал — СЛ − 1, крит. провал — СЛ − 10)
  const DEGREE_MOD = { criticalSuccess: 0, success: -10, failure: -11, criticalFailure: -20 };
  const srcC = async (uuid) => { const o = await src(uuid); o._stats = { ...o._stats, compendiumSource: uuid }; return o; };   // по compendiumSource правило находится в каталоге
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const flag = (m, ...p) => foundry.utils.getProperty(game.messages.get(m.id) ?? m, `flags.${MOD}.${p.join(".")}`);
  const heldNow = (m) => flag(m, "gate", "hold") === true;
  const cancelledNow = (m) => flag(m, "gate", "cancelled") === true;
  const effBy = (a, key) => a.itemTypes.effect.find((x) => x.slug === SLUG[key]);
  const dmgButtons = (e, m) => e.dom(m)?.querySelectorAll(".message-buttons button[data-action$='-damage']").length ?? -1;
  const cardsOf = (m) => game.messages.filter((x) => String(x.flags?.[MOD]?.use?.state?.event ?? "").startsWith(`${m.id}:`));

  // эффекты пака: пак ещё не пересобран (node tools/build-packs.mjs при закрытом мире) — создаём временные документы с теми же id; убираются в конце прогона
  const madePack = [];
  const ensurePack = async () => {
    if (await fromUuid(FXP + FX.carrier).catch(() => null)) return;
    const pack = game.packs.get("pf2e-automato.effects");
    if (!pack) throw new Skip("нет пака pf2e-automato.effects");
    try { if (pack.locked) await pack.configure({ locked: false }); } catch (err) { throw new Skip(`пак заперт и не открывается: ${err.message}`); }
    const mk = (id, name, level, duration) => ({ _id: id, name, type: "effect", img: "icons/svg/aura.svg", system: { slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), level: { value: level }, duration, rules: [], description: { value: "" } } });
    const docs = [mk(FX.carrier, "Spell Effect: Sanctuary", 1, { value: 1, unit: "minutes", expiry: null, sustained: false }),
      mk(FX.passed, "Effect: Sanctuary Passed", 1, { value: 0, unit: "rounds", expiry: "turn-end", sustained: false }),
      mk(FX.stopped, "Effect: Sanctuary Stopped", 1, { value: 0, unit: "rounds", expiry: "turn-end", sustained: false }),
      mk(FX.barred, "Effect: Sanctuary Barred", 1, { value: 1, unit: "minutes", expiry: null, sustained: false })];
    for (const d of docs) madePack.push((await Item.implementation.create(d, { pack: pack.collection, keepId: true })).uuid);
    if (!(await fromUuid(FXP + FX.carrier).catch(() => null))) throw new Skip("не удалось создать временные эффекты в паке");
  };
  const dropPack = async () => { for (const u of madePack.splice(0)) await (await fromUuid(u).catch(() => null))?.delete().catch(() => {}); };

  /** Заклинатель-NPC с записью заклинаний и Убежищем (СЛ заклинания); защищённый (временный персонаж без владельца); токены. */
  const makeCast = async (e) => {
    await ensurePack();
    const caster = await e.foe("заклинатель");
    await caster.update({ "system.details.alliance": "party" });
    const ct = await e.tok(caster, 300, 1000, 1);
    const guard = await e.pc("защищённый", [await srcC(NIMBLE)]);
    const gt = await e.tok(guard, 400, 1000, 1);   // вплотную к заклинателю: Убежище — касание, на 10 фт модуль цель отсекает по дальности
    await wait(700);
    const C = e.A(ct);
    const [entry] = await e.give(C, { type: "spellcastingEntry", name: "AF колдовство", system: { ability: { value: "cha" }, tradition: { value: "divine" }, prepared: { value: "spontaneous" }, proficiency: { value: 1 } } });
    const o = await srcC(SP + SANC);
    o.system.location = { ...(o.system.location ?? {}), value: entry.id };
    const [spell] = await e.give(C, o);
    // посторонний эффект того же slug у самого заклинателя: «крит. успех» не должен его трогать
    const [own] = await e.give(C, { type: "effect", name: "Spell Effect: Sanctuary", system: { slug: SLUG.carrier, duration: { value: 1, unit: "minutes", expiry: null }, rules: [] } });
    await wait(500);
    return { C, ct, guard, gt, spell, own, G: e.A(gt) };
  };
  const spellDc = (cc) => cc.spell.spellcasting.statistic.withRollOptions({ item: cc.spell }).dc.value;
  /** Реальное сотворение Убежища на защищённого -> носитель на нём. */
  const castOn = async (e, cc, gt = cc.gt) => {
    await e.aim(cc.ct, gt);
    const t0 = e.since();
    await bound("сотворение Sanctuary", cc.spell.spellcasting.cast(cc.spell, { consume: false }));   // у записи нет ячеек: без consume:false pf2e отказывает, карточки нет
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === cc.spell.uuid), 8000);
    if (!m) throw new Error("нет карточки сотворения Убежища");
    // apply = button: шаг на персонажа-цель ждёт «Применить» ГМа — жмём, как ГМ на игре
    if (!(await waitFor(() => effBy(e.A(gt), "carrier"), 3000))) await e.applyAll(m);
    const fx = await waitFor(() => effBy(e.A(gt), "carrier"), 10000);
    if (!fx) throw new Error("носитель «Spell Effect: Sanctuary» не появился на защищённом");
    return fx;
  };
  /** Нападающий: NPC-гоблин, враг, +50 к атаке (попадание), Воля сдвинута так, чтобы при d20 = 10 выпала нужная степень против dc. */
  const makeFoe = async (e, { degree = "success", dc = 20 } = {}) => {
    const foe = await e.foe("нападающий");
    const ft = await e.tok(foe, 1500, 1000, -1);
    await wait(500);
    const A = e.A(ft);
    await e.rig(A, "attack-roll", 50);
    const base = A.saves.will.mod;
    await e.rig(A, "will", dc + DEGREE_MOD[degree] - base);
    return { foe, ft, A };
  };
  /** Все прямые враги видят d20 = 10: степень Воли определяется только модификатором. */
  const fix10 = (e) => e.fix(10);

  /** Ждём карточку испытания по атаке и применяем её (mode.apply = button: жмём «Применить»). -> карточка | null */
  const resolve = async (e, atk) => {
    const card = await waitFor(() => cardsOf(atk)[0], 12000);
    if (!card) return null;
    if (!(await waitFor(() => Object.keys(e.use(card)?.state?.challenge?.results ?? {}).length, 20000))) throw new Error(`у карточки нет броска Воли (results: ${JSON.stringify(e.use(card)?.state?.challenge?.results)})`);
    if (setting("mode.apply") !== "auto") {
      const btn = await waitFor(() => e.dom(card)?.querySelector(".pf2e-automato button[data-action=apply]:not([disabled])"), 8000);
      if (!btn) throw new Error(`на карточке нет кнопки «Применить» (кнопки: ${[...(e.dom(card)?.querySelectorAll(".pf2e-automato button") ?? [])].map((b) => b.dataset.action).join(",")})`);
      btn.click();
    }
    await waitFor(() => Object.keys(e.use(card)?.state?.challenge?.applied ?? {}).length, 8000);
    await wait(1500);
    return game.messages.get(card.id);
  };

  /** Старт теста: режимы, носитель, нападающий; d20 = 10. -> { cc, fo } */
  const setup = async (e, degree) => {
    openChat(); needMode("mode.challenge", "off", "button"); needMode("mode.effect", "off", "button"); needMode("mode.apply", "off"); needMode("mode.damageGate", "off");
    const cc = await makeCast(e);
    const fo = await makeFoe(e, { degree, dc: spellDc(cc) });
    await castOn(e, cc);
    await fix10(e);
    return { cc, fo, gt: cc.gt };
  };
  const attack = (e, fo, cc) => e.hit(fo.ft, cc.gt);

  sc("cast", "Сотворение Убежища: носитель на защищённом с автором-заклинателем", async (e, t) => {
    const cc = await makeCast(e);
    const fx = await castOn(e, cc);
    t.ok(fx.system.context?.origin?.actor === e.A(cc.ct).uuid, `автор носителя — заклинатель: ${fx.system.context?.origin?.actor}`);
    t.ok(fx._stats?.compendiumSource === FXP + FX.carrier, `источник носителя: ${fx._stats?.compendiumSource}`);
    t.ok(fx.system.duration.value === 1 && fx.system.duration.unit === "minutes", `срок: ${JSON.stringify(fx.system.duration)}`);
    t.ok(!!api().resolveRule(fx)?.rule?.onEvent?.some((x) => x.hold), "у носителя найдено правило с hold");
  });

  sc("held", "Атака по защищённому: удержана, кнопок урона нет, автоурона нет, одна карточка Воли у нападающего", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "success");
    const t0 = e.since();
    const atk = await attack(e, fo, cc);
    t.ok(!!atk, "сообщение атаки есть");
    t.ok(heldNow(atk), `флаг gate.hold на атаке (до решения): ${JSON.stringify(flag(atk, "gate"))}`);
    t.ok(game.messages.get(atk.id).flags?.["xdy-pf2e-workbench"]?.noAutoDamageRoll === true, `флаг Workbench noAutoDamageRoll: ${JSON.stringify(game.messages.get(atk.id).flags?.["xdy-pf2e-workbench"])}`);
    const card = await waitFor(() => cardsOf(atk)[0], 12000);
    t.ok(!!card, "карточка Воли создана");
    await wait(2500);
    t.ok(cardsOf(atk).length === 1, `карточка одна: ${cardsOf(atk).length}`);
    t.ok(dmgButtons(e, atk) === 0, `кнопок урона нет: ${dmgButtons(e, atk)}`);
    t.ok(!!e.dom(atk)?.querySelector(".paf-hold"), "плашка «Атака удержана» есть");
    t.ok(!e.msgs(t0).some((m) => m.flags?.pf2e?.context?.type === "damage-roll"), `автоурон не брошен (Workbench ${game.modules.get("xdy-pf2e-workbench")?.active ? "включён" : "выключен — проверка гонки не показательна"})`);
    t.ok(!!e.dom(atk)?.querySelector(".paf-hold button[data-hold=release]") && !!e.dom(atk)?.querySelector(".paf-hold button[data-hold=cancel]"), "у ГМа есть ручные «Выпустить» и «Отменить»");
  });

  sc("crit-success", "Крит. успех Воли: носитель снят с ЗАЩИЩЁННОГО (эффект заклинателя цел), атака выпущена, кнопки урона вернулись", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "criticalSuccess");
    const atk = await attack(e, fo, cc);
    const card = await resolve(e, atk);
    t.ok(!!card, "карточка есть и применена");
    t.ok(!effBy(e.A(gt), "carrier"), "носитель снят с защищённого");
    t.ok(!!e.A(cc.ct).itemTypes.effect.find((x) => x.id === cc.own.id) || !!e.A(cc.ct).itemTypes.effect.find((x) => x.slug === SLUG.carrier), "эффект с тем же slug у заклинателя цел");
    t.ok(!heldNow(atk) && !cancelledNow(atk), `атака выпущена: ${JSON.stringify(flag(atk, "gate"))}`);
    t.ok(!!(await waitFor(() => dmgButtons(e, atk) > 0, 6000)), `кнопки урона вернулись: ${dmgButtons(e, atk)}`);
    // следующая атака — без удержания
    const a2 = await attack(e, fo, cc);
    await wait(1500);
    t.ok(!cardsOf(a2).length && !heldNow(a2), "второй атаки удержание не ждёт (носителя нет)");
  });

  sc("success", "Успех Воли: метка passed на нападающем (автор — он сам), атака выпущена; вторая атака в тот же ход без карточки; после конца его хода — снова карточка", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "success");
    const c = await e.combat([fo.ft, gt], [20, 10]);
    await c.startCombat(); await wait(1200);
    const atk = await attack(e, fo, cc);
    const card = await resolve(e, atk);
    t.ok(!!card, "карточка применена");
    const mark = effBy(fo.A, "passed");
    t.ok(!!mark, "метка passed на нападающем");
    t.ok(mark?.system.context?.origin?.actor === fo.A.uuid, `автор метки — нападающий (ход его): ${mark?.system.context?.origin?.actor}`);
    t.ok(mark?.flags?.[MOD]?.meta?.by === e.A(cc.gt).uuid, `метка привязана к защищённому (meta.by): ${mark?.flags?.[MOD]?.meta?.by}`);
    t.ok(!heldNow(atk) && !cancelledNow(atk) && !!(await waitFor(() => dmgButtons(e, atk) > 0, 6000)), `атака выпущена, кнопки урона есть (${dmgButtons(e, atk)})`);
    t.ok(!!effBy(e.A(gt), "carrier"), "Убежище осталось");
    const a2 = await attack(e, fo, cc);
    await wait(1500);
    t.ok(!cardsOf(a2).length && !heldNow(a2) && !cancelledNow(a2), "вторая атака в этот ход: без карточки и без удержания");
    await bound("конец хода нападающего", c.nextTurn()); await wait(2500);
    t.ok(!effBy(fo.A, "passed"), "метка снялась в конце хода нападающего");
    await e.fix(10);
    const a3 = await attack(e, fo, cc);
    t.ok(!!(await waitFor(() => cardsOf(a3)[0], 12000)), "на следующий раз — новая карточка Воли");
  });

  sc("failure", "Провал Воли: атака отменена (плашка, кнопок урона нет, не выпускается), метка stopped, вторая атака в тот же ход отменяется без карточки, после конца хода — снова карточка", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "failure");
    const c = await e.combat([fo.ft, gt], [20, 10]);
    await c.startCombat(); await wait(1200);
    const atk = await attack(e, fo, cc);
    const card = await resolve(e, atk);
    t.ok(!!card, "карточка применена");
    t.ok(!!effBy(fo.A, "stopped"), "метка stopped");
    t.ok(!heldNow(atk) && cancelledNow(atk), `атака отменена: ${JSON.stringify(flag(atk, "gate"))}`);
    t.ok(dmgButtons(e, atk) === 0 && !!e.dom(atk)?.querySelector(".paf-hold"), `кнопок урона нет (${dmgButtons(e, atk)}), плашка есть`);
    t.ok(!!effBy(e.A(gt), "carrier"), "Убежище осталось");
    const a2 = await attack(e, fo, cc);
    await wait(1500);
    t.ok(!cardsOf(a2).length && cancelledNow(a2), "вторая атака отменена без карточки");
    await bound("конец хода нападающего", c.nextTurn()); await wait(2500);
    t.ok(!effBy(fo.A, "stopped"), "метка снялась в конце хода нападающего");
    await e.fix(10);
    const a3 = await attack(e, fo, cc);
    t.ok(!!(await waitFor(() => cardsOf(a3)[0], 12000)), "на следующий раз — новая карточка");
  });

  sc("crit-failure", "Крит. провал: метка barred до конца срока, все последующие атаки отменяются без карточек (и после смены хода)", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "criticalFailure");
    const c = await e.combat([fo.ft, gt], [20, 10]);
    await c.startCombat(); await wait(1200);
    const atk = await attack(e, fo, cc);
    t.ok(!!(await resolve(e, atk)), "карточка применена");
    const mark = effBy(fo.A, "barred");
    t.ok(!!mark && mark.system.duration.unit === "minutes", `метка barred: ${JSON.stringify(mark?.system.duration)}`);
    t.ok(cancelledNow(atk) && dmgButtons(e, atk) === 0, "атака отменена");
    await bound("конец хода нападающего", c.nextTurn()); await wait(1500);
    await bound("конец хода защищённого", c.nextTurn()); await wait(1500);
    await e.fix(10);
    const a2 = await attack(e, fo, cc);
    await wait(1500);
    t.ok(!cardsOf(a2).length && cancelledNow(a2) && !!effBy(fo.A, "barred"), "в следующий раунд: атака отменена без карточки, метка на месте");
  });

  sc("trip", "Подсечка (skill-check с attack): удерживается той же Волей; при провале состояние prone не ставится", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "failure");
    const trip = game.pf2e?.actions?.get?.("trip") ?? game.pf2e?.actions?.trip;
    if (!trip) throw new Skip("нет game.pf2e.actions trip");
    await e.aim(fo.ft, gt);
    const t0 = e.since();
    await bound("Подсечка", (trip.use ? trip.use({ actors: [fo.A], event: SHIFT() }) : trip({ actors: [fo.A], event: SHIFT() })));
    const sk = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "skill-check" && (m.flags.pf2e.context.traits ?? []).some((x) => (x.name ?? x) === "attack")), 10000);
    if (!sk) throw new Skip("проверка Подсечки не появилась (нет оружия/цели?)");
    t.ok(!!(await waitFor(() => cardsOf(sk)[0], 12000)), "карточка Воли по Подсечке");
    t.ok(!e.cond(cc.G, "prone"), "пока удержано — prone нет");
    await resolve(e, sk);
    t.ok(cancelledNow(sk), `проверка отменена: ${JSON.stringify(flag(sk, "gate"))}`);
    t.ok(!e.cond(e.A(gt), "prone"), "после провала Воли prone не поставлено");
  });

  sc("reroll", "Переброс атаки после разрешённой Воли: итог переносится (метка жива, второй карточки нет, переброшенная атака отменена по метке)", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "failure");
    const atk = await attack(e, fo, cc);
    t.ok(!!(await resolve(e, atk)), "карточка применена");
    const card = cardsOf(atk)[0];
    const check = game.pf2e?.Check;
    if (!check?.rerollFromMessage) throw new Skip("нет game.pf2e.Check.rerollFromMessage");
    const t0 = e.since();
    await bound("переброс атаки", check.rerollFromMessage(game.messages.get(atk.id), { keep: "new" }));
    const re = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "attack-roll" && m.flags.pf2e.context.isReroll), 10000);
    if (!re) throw new Skip("переброс не создал сообщение");
    await wait(2000);
    t.ok(!!effBy(fo.A, "stopped"), "метка stopped жива");
    t.ok(game.messages.has(card.id), "карточка Воли не тронута");
    t.ok(!cardsOf(re).length, "новой карточки Воли нет");
    t.ok(cancelledNow(re) && !heldNow(re), `переброшенная атака отменена по метке: ${JSON.stringify(flag(re, "gate"))}`);
  });

  sc("two-attacks", "Две быстрые атаки одной пары (с MAP): одна карточка Воли; провал отменяет обе", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "failure");
    await e.aim(fo.ft, gt);
    const s = e.strike(fo.A), t0 = e.since();
    await Promise.all([bound("атака 1", s.variants[0].roll({ event: SHIFT() })), bound("атака 2", s.variants[1].roll({ event: SHIFT() }))]);
    const atks = await waitFor(() => { const l = e.msgs(t0).filter((m) => m.flags?.pf2e?.context?.type === "attack-roll"); return l.length >= 2 ? l : null; }, 10000);
    if (!atks) throw new Skip("вторая атака не брошена");
    await wait(3000);
    const cards = game.messages.filter((m) => atks.some((a) => String(m.flags?.[MOD]?.use?.state?.event ?? "").startsWith(`${a.id}:`)));
    t.ok(cards.length === 1, `карточка одна на пару: ${cards.length}`);
    await resolve(e, atks.find((a) => cardsOf(a).length) ?? atks[0]);
    t.ok(atks.every(cancelledNow), `обе отменены: ${atks.map((a) => JSON.stringify(flag(a, "gate"))).join(" | ")}`);
  });

  sc("improved-grab", "Удар NPC с improved-grab: до Воли grabbed нет, после выпуска (успех) — есть; контроль без Убежища", async (e, t) => {
    needMode("mode.challenge", "off", "button"); needMode("mode.effect", "off", "button"); needMode("mode.apply", "off"); needMode("mode.damageGate", "off");
    const cc = await makeCast(e), gt = cc.gt;
    const fo = await makeFoe(e, { degree: "success", dc: spellDc(cc) });
    const melee = fo.A.itemTypes.melee.find((x) => x.isMelee) ?? fo.A.itemTypes.melee[0];
    if (!melee) throw new Skip("у нападающего нет melee-предмета");
    await melee.update({ "system.attackEffects.value": ["improved-grab"] });
    await e.rig(fo.A, "athletics", 50);   // Захват (Атлетика) — преуспеть при d20 = 10, как в pa05
    await fix10(e);
    const t0 = e.since();
    const control = await attack(e, fo, cc);
    const g = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.options?.includes("action:grapple")), 10000);
    await wait(1500);
    if (g && !e.cond(e.A(gt), "grabbed") && !e.cond(e.A(gt), "restrained")) { await e.applyAll(g); await wait(1500); }   // apply = button
    if (!e.cond(e.A(gt), "grabbed") && !e.cond(e.A(gt), "restrained")) throw new Skip(`контроль: без Убежища strike-effects не выдал grabbed (улучшенный захват, Удар попал? ${JSON.stringify(control?.flags?.pf2e?.context?.outcome)})`);
    for (const c of e.A(gt).itemTypes.condition.filter((x) => ["grabbed", "restrained"].includes(x.slug))) await c.delete().catch(() => {});
    await wait(800);
    await castOn(e, cc);
    await e.fix(10);
    const atk = await attack(e, fo, cc);
    await waitFor(() => cardsOf(atk)[0], 12000);
    await wait(2500);
    t.ok(!e.cond(e.A(gt), "grabbed") && !e.cond(e.A(gt), "restrained"), "пока удержано — grabbed нет");
    const t1 = e.since();
    await resolve(e, atk);
    // apply = button: как в контроле, результат Захвата ГМ применяет кнопкой
    const g2 = await waitFor(() => e.msgs(t1).find((x) => x.flags?.pf2e?.context?.options?.includes("action:grapple")), 10000);
    await wait(1500);
    if (g2 && !e.cond(e.A(gt), "grabbed") && !e.cond(e.A(gt), "restrained")) await e.applyAll(g2);
    t.ok(!!(await waitFor(() => e.cond(e.A(gt), "grabbed") || e.cond(e.A(gt), "restrained"), 8000)), "после выпуска — захват выдан");
  });

  sc("reaction-hint", "Подсказка реакции (Проворное уклонение защищённого): пока удержана — нет, после выпуска — есть", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "success");
    needMode("mode.reaction", "off");
    const hints = (t0) => e.msgs(t0).filter((m) => m.flags?.[MOD]?.reaction);
    const t0 = e.since();
    const atk = await attack(e, fo, cc);
    await waitFor(() => cardsOf(atk)[0], 12000);
    await wait(2000);
    t.ok(hints(t0).length === 0, `пока удержана — подсказки нет: ${hints(t0).length}`);
    await resolve(e, atk);
    t.ok(!!(await waitFor(() => hints(t0).length === 1, 8000)), `после выпуска — одна подсказка: ${hints(t0).length}`);
  });

  sc("manual", "Ручные кнопки и страховка: «Отменить» на плашке, закрытая карточка выпускает, режим challenge=off — удержания нет", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "success");
    // 1) ручная кнопка «Отменить»
    const a1 = await attack(e, fo, cc);
    await waitFor(() => cardsOf(a1)[0], 12000);
    const btn = await waitFor(() => e.dom(a1)?.querySelector(".paf-hold button[data-hold=cancel]"), 8000);
    t.ok(!!btn, "кнопка «Отменить» есть");
    btn?.click();
    t.ok(!!(await waitFor(() => cancelledNow(a1), 8000)), "атака отменена ГМом");
    t.ok(cardsOf(a1).length === 0, "висящая карточка Воли убрана");
    // 2) карточку удалили, не применив — атака выпускается
    const a2 = await attack(e, fo, cc);
    const card = await waitFor(() => cardsOf(a2)[0], 12000);
    await card?.delete();
    t.ok(!!(await waitFor(() => !heldNow(a2) && !cancelledNow(a2), 8000)), `после закрытия карточки атака выпущена: ${JSON.stringify(flag(a2, "gate"))}`);
    // 3) challenge=off: удержания нет
    const prev = setting("mode.challenge");
    await game.settings.set(MOD, "mode.challenge", "off");
    try {
      const a3 = await attack(e, fo, cc);
      await wait(1500);
      t.ok(flag(a3, "gate") === undefined && !cardsOf(a3).length, `challenge=off: атака идёт сразу, без удержания: ${JSON.stringify(flag(a3, "gate"))}`);
    } finally { await game.settings.set(MOD, "mode.challenge", prev); }
  });

  sc("two-guards", "Две защищённые цели: успех Воли против A не пропускает атаку по B (своя карточка Воли, метка passed у каждого защищённого своя)", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "success");
    const guard2 = await e.pc("защищённый 2", [await srcC(NIMBLE)]);
    const gt2 = await e.tok(guard2, 400, 1100, 1);
    await wait(700);
    await castOn(e, cc, gt2);
    await fix10(e);
    const c = await e.combat([fo.ft, cc.gt, gt2], [20, 10, 5]);
    await c.startCombat(); await wait(1200);
    const a1 = await attack(e, fo, cc);
    t.ok(!!(await resolve(e, a1)), "Воля против A разрешена");
    t.ok(!heldNow(a1) && !cancelledNow(a1), "атака по A выпущена");
    const a2 = await e.hit(fo.ft, gt2);
    t.ok(!!(await waitFor(() => cardsOf(a2)[0], 12000)), "атака по B: своя карточка Воли (метка A её не заменяет)");
    t.ok(heldNow(a2), "атака по B удержана до её Воли");
    await resolve(e, a2);
    const by = fo.A.itemTypes.effect.filter((x) => x.slug === SLUG.passed).map((x) => x.flags?.[MOD]?.meta?.by).sort();
    t.ok(by.length === 2 && by[0] !== by[1], `две метки passed с разными защищёнными: ${by.join(", ")}`);
  });

  sc("ends-on-attack", "Атака самого защищённого снимает Убежище; обычный бросок — нет", async (e, t) => {
    const { cc, fo, gt } = await setup(e, "success");
    void fo;
    const foe2 = await e.tok(await e.foe("мишень"), 700, 1000, -1);
    await wait(500);
    // нерелевантный бросок защищённого (Восприятие) носитель не трогает
    await bound("Восприятие", e.A(gt).perception.roll({ event: SHIFT(), createMessage: true }));
    await wait(1500);
    t.ok(!!effBy(e.A(gt), "carrier"), "после Восприятия Убежище на месте");
    await e.hit(gt, foe2);
    t.ok(!!(await waitFor(() => !effBy(e.A(gt), "carrier"), 8000)), "после Удара защищённого Убежище снято");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} l3-chunk4 | ${s.id}`, err); }
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
  window.__afL3dResult = out;
  return out;
}
