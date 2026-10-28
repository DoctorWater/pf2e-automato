async () => {
  // Живой сценарий l3-chunk3: Lingering Composition (Затяжная композиция) — onEvent.check, extendEffect {cast:true}, refundFocus; бард-NPC (авто) и бард-персонаж (бросок кнопкой).
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в l3-chunk1.js: временные «AF тест: …» актёры, сцена, бой; уборка в finally. Настоящих персонажей не трогает.
  // Нужны режимы challenge = auto, effect = auto (apply: auto или button — «Применить» нажимается сам); путь PC — только если в мире есть пользователь-игрок (иначе SKIP).
  // Параметры (перед запуском): window.__afL3c = { only: ["npc-success", ...], skip: [...], cleanOnly: true }
  // Результат: массив строк «PASS|FAIL|SKIP id: подробности» (то же в window.__afL3cResult и console.table).
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL3c ?? {}) };
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

  // ---------- уборка (аварийная: window.__afRepeatSave = {cleanOnly: true}) ----------
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



  // ---------- сценарии l3-chunk3: Lingering Composition ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const SP = "Compendium.pf2e.spells-srd.Item.";
  const U = { linger: "irTdhxTixU9u9YUm", anthem: "IAjvwqgiDr3qGYxY", hymn: "gSUQlTDYoLDGAsCP" };
  const ANTHEM_FX = "Compendium.pf2e.spell-effects.Item.beReeFroAx24hj83";   // эффект, который аура Courageous Anthem раздаёт союзникам
  const ROUNDS = { criticalSuccess: 4, success: 3, failure: 1, criticalFailure: 1 };
  const effOf = (a, uuid) => a.items.find((i) => i.type === "effect" && i._stats?.compendiumSource === uuid);
  const castFx = (a, castId) => a.itemTypes.effect.find((x) => x.flags?.[MOD]?.meta?.message === castId);   // аура на барде, выданная именно этим сотворением

  /** Бард (NPC — «авто», либо временный персонаж с владельцем-игроком — «бросок кнопкой»), токен, записи заклинателя; фокус 1/1 (или focus/focus). -> { A, tok, spells } */
  const makeBard = async (e, { pc = false, focus = 1 } = {}) => {
    let actor;
    if (pc) {
      const player = game.users.find((u) => !u.isGM);
      if (!player) throw new Skip("нет пользователя-игрока: путь «бросок кнопкой» требует владельца-игрока");
      actor = await e.pc("бард-PC");
      await actor.update({ ownership: { default: 0, [player.id]: 3 } });
      if (!actor.hasPlayerOwner) throw new Skip("hasPlayerOwner=false у временного персонажа");
    } else {
      actor = await e.foe("бард-NPC");
      await actor.update({ "system.resources.focus": { value: focus, max: focus }, "system.details.alliance": "party" });   // союзник PC для pf2e и alliesIn: у NPC по умолчанию «противники»
    }
    if (pc) await e.rig(actor, "performance", 10);   // СЛ ГМа 21: без бонуса успех на d20 недостижим
    const tok = await e.tok(actor, 300, 1000, 1);
    await wait(700);
    const A = e.A(tok);
    const [entry] = await e.give(A, { type: "spellcastingEntry", name: "AF колдовство", system: { ability: { value: "cha" }, tradition: { value: "occult" }, prepared: { value: "spontaneous" }, proficiency: { value: 1 } } });
    const spells = {};
    for (const k of Object.keys(U)) {
      const o = await src(SP + U[k]);
      o._stats = { ...o._stats, compendiumSource: SP + U[k] };   // по нему правило находится в catalog.json
      o.system.location = { ...(o.system.location ?? {}), value: entry.id };
      spells[k] = (await e.give(A, o))[0];
    }
    await wait(500);
    // pf2e 8.6.1: максимум пула PC = число его заклинаний с чертой focus (не кантрипов), отдельного поля нет; Lingering и Hymn — focus
    if ((A.system.resources?.focus?.max ?? 0) < focus) throw new Skip(`у актёра нет пула фокуса ${focus}: ${JSON.stringify(A.system.resources?.focus)}`);
    await A.update({ "system.resources.focus.value": focus });
    return { A, tok, spells };
  };

  /** Сотворение «как у игрока» (запись заклинателя: тратит фокус, пишет карточку с origin-опциями). -> сообщение карточки */
  const castSpell = async (e, sp) => {
    const t0 = e.since();
    await bound(`сотворение ${sp.name}`, sp.spellcasting.cast(sp, {}));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === sp.uuid), 8000);
    if (!m) throw new Error(`нет карточки сотворения «${sp.name}»`);
    return m;
  };
  const hostOf = (castId) => game.messages.find((m) => m.flags?.[MOD]?.use?.state?.castMessage === castId);
  const nextRound = async (c, round) => {
    for (let i = 0; i < 40 && c.round < round; i++) { await bound("nextTurn", c.nextTurn()); await wait(700); }
    await wait(2500);
  };

  /**
   * Полный проход: Lingering -> [between] -> композиция. roll — степень, которую нужно выбросить (success считается от СЛ и модификатора, иначе 20 / 1).
   * -> { b, allies, foe, c, lcard, cast, host, degree, aura, dcExpect }
   */
  const run = async (e, { pc = false, roll = "success", between = null, spell = "anthem", combat = false, dcEdit = 0, focus = 1 } = {}) => {
    openChat(); needMode("mode.challenge", "off", "button"); needMode("mode.effect", "off"); needMode("mode.apply", "off");
    const b = await makeBard(e, { pc, focus });
    const foe = await e.tok(await e.foe("враг"), 1500, 1000, -1);
    const allies = [await e.tok(await e.pc("союзник 1"), 500, 1000, 1), await e.tok(await e.pc("союзник 2"), 700, 1000, 1)];
    await wait(700);
    const c = combat ? await e.combat([b.tok, ...allies, foe], [20, 10, 9, 5]) : null;
    if (c) { await c.startCombat(); await wait(1200); }
    const { levelDc } = await imp("cast.mjs");
    const dcExpect = (dcEdit || levelDc(Math.max(b.A.level, ...allies.map((t) => e.A(t).level))));
    const mod = b.A.getStatistic("performance")?.check?.mod ?? 0;
    if (roll === "success") { const n = dcExpect - mod; if (n < 2 || n > 19) throw new Skip(`успех не выбросить: СЛ ${dcExpect}, модификатор ${mod}`); await e.fix(n); }
    else await e.fix(roll === "crit" ? 20 : 1);

    await e.aim(b.tok, foe);
    const lcard = await castSpell(e, b.spells.linger);
    if (b.A.system.resources.focus.value !== focus - 1) throw new Error(`Lingering не потратил фокус: ${b.A.system.resources.focus.value}`);
    if (between === "strike") await e.hit(b.tok, foe);
    await e.aim(b.tok, foe);
    const cast = await castSpell(e, b.spells[spell]);
    const aura = await waitFor(() => castFx(b.A, cast.id), 10000);
    const host = await waitFor(() => hostOf(cast.id), 8000);
    let degree = null;
    if (host) {
      if (dcEdit) await host.update({ [`flags.${MOD}.use.dc`]: dcEdit });
      if (pc) {   // автор-PC: только кнопкой карточки-хозяина
        const btn = await waitFor(() => e.dom(host)?.querySelector(".pf2e-automato button[data-action=roll-save]:not([disabled])"), 8000);
        if (!btn) throw new Error("на карточке проверки нет кнопки броска");
        btn.click();
      }
      const res = await waitFor(() => Object.values(e.use(host)?.state?.challenge?.results ?? {})[0], 20000);
      degree = res ? deg(res.degree) : null;
      if (!(await waitFor(() => Object.keys(e.use(host)?.state?.challenge?.applied ?? {}).length, 6000))) {   // mode.apply = button: ГМ жмёт «Применить» строки (как на игре)
        const btn = await waitFor(() => e.dom(host)?.querySelector(".pf2e-automato button[data-action=apply]:not([disabled])"), 8000);
        applyBtn = btn ? "есть" : `нет (DOM карточки: ${!!e.dom(host)}, блок модуля: ${!!e.dom(host)?.querySelector(".pf2e-automato")}, кнопки: [${[...(e.dom(host)?.querySelectorAll(".pf2e-automato button") ?? [])].map((x) => x.dataset.action + (x.disabled ? "!" : "")).join(",")}])`;
        if (btn) btn.click();
        await waitFor(() => Object.keys(e.use(host)?.state?.challenge?.applied ?? {}).length, 8000);
      }
      await wait(1500);
    }
    lastRun = { b, host, cast, applyBtn };
    return { b, allies, foe, c, lcard, cast, host, degree, aura: castFx(b.A, cast.id) ?? aura, dcExpect };
  };
  let lastRun = null, applyBtn = null;
  /** Для строки FAIL: эффекты барда с meta, состояние карточки-хозяина, союзники и их альянс/уровень. */
  const diag = () => {
    if (!lastRun) return "";
    const { b, host, cast } = lastRun, u = host && (host.flags?.[MOD]?.use);
    const fx = b.A.itemTypes.effect.map((x) => `${x.slug}{msg:${x.flags?.[MOD]?.meta?.message === cast.id ? "cast" : x.flags?.[MOD]?.meta?.message},dur:${x.system.duration.value}${x.system.duration.unit}}`);
    return ` | диагностика: castId=${cast.id}; state.castMessage=${u?.state?.castMessage}; эффекты барда [${fx.join(", ")}]; applied=${JSON.stringify(u?.state?.challenge?.applied ?? null).slice(0, 400)}; results=${JSON.stringify(u?.state?.challenge?.results ?? null).slice(0, 200)}; альянс барда=${b.A.system.details?.alliance}, уровень=${b.A.level}; кнопка «Применить»=${lastRun.applyBtn}; linger=${JSON.stringify(u?.state?.linger ?? null)}`;
  };
  const hosts = (e, t0) => e.msgs(t0).filter((m) => m.flags?.[MOD]?.use?.state?.castMessage);

  sc("npc-success", "NPC-бард (авто), успех: аура на барде 3 раунда, у союзников эффект есть в начале 2-го и 3-го раундов, к началу 4-го снят; одна карточка", async (e, t) => {
    const t0 = e.since();
    const r = await run(e, { roll: "success", combat: true });
    t.ok(hosts(e, t0).length === 1, `одна карточка проверки на сообщение: ${hosts(e, t0).length}`);
    t.ok(r.degree === "success", `степень ${r.degree}`);
    t.ok(r.host && e.use(r.host).dc === r.dcExpect, `СЛ в use.dc = по уровню существ в эманации: ${e.use(r.host)?.dc} (ожидалась ${r.dcExpect})`);
    t.ok(r.aura?.system.duration.value === ROUNDS.success && r.aura.system.duration.unit === "rounds", `аура на барде: ${JSON.stringify(r.aura?.system.duration)}`);
    t.ok(r.allies.every((a) => !!effOf(e.A(a), ANTHEM_FX)), "у обоих союзников эффект Courageous Anthem есть");
    await nextRound(r.c, 2);
    t.ok(!!castFx(r.b.A, r.cast.id) && r.allies.every((a) => !!effOf(e.A(a), ANTHEM_FX)), "начало 2-го раунда: аура и эффекты союзников на месте");
    await nextRound(r.c, 3);
    t.ok(!!castFx(r.b.A, r.cast.id) && r.allies.every((a) => !!effOf(e.A(a), ANTHEM_FX)), "начало 3-го раунда: аура и эффекты союзников на месте");
    await nextRound(r.c, 4);
    t.ok(!castFx(r.b.A, r.cast.id) && r.allies.every((a) => !effOf(e.A(a), ANTHEM_FX)), "начало 4-го раунда: аура и эффекты союзников сняты");
    t.ok(r.b.A.system.resources.focus.value === 0, "успех: очко фокуса остаётся потраченным");
  });

  sc("npc-crit", "NPC-бард (авто), крит. успех: аура на барде 4 раунда", async (e, t) => {
    const r = await run(e, { roll: "crit" });
    t.ok(r.degree === "criticalSuccess", `степень ${r.degree}`);
    t.ok(r.aura?.system.duration.value === ROUNDS.criticalSuccess, `аура: ${JSON.stringify(r.aura?.system.duration)}`);
    t.ok(r.allies.every((a) => !!effOf(e.A(a), ANTHEM_FX)), "эффект у союзников");
  });

  sc("npc-fail", "NPC-бард (авто), провал: срок 1 раунд, очко фокуса вернулось, к началу 2-го раунда аура и эффекты сняты", async (e, t) => {
    const r = await run(e, { roll: "fail", combat: true });
    t.ok(["failure", "criticalFailure"].includes(r.degree), `степень ${r.degree}`);
    t.ok(r.aura?.system.duration.value === ROUNDS.failure, `аура не продлена: ${JSON.stringify(r.aura?.system.duration)}`);
    t.ok(r.b.A.system.resources.focus.value === 1, `фокус вернулся: ${r.b.A.system.resources.focus.value}/1`);
    await nextRound(r.c, 2);
    t.ok(!castFx(r.b.A, r.cast.id) && r.allies.every((a) => !effOf(e.A(a), ANTHEM_FX)), "начало 2-го раунда: всё снято");
  });

  sc("pc-button", "бард-персонаж (бросок кнопкой карточки), СЛ исправлена ГМом в use.dc: результат по новой СЛ, аура 3 раунда", async (e, t) => {
    const r = await run(e, { pc: true, roll: "success", dcEdit: 21 });
    t.ok(!!r.host, "карточка проверки есть");
    const res = Object.values(e.use(r.host)?.state?.challenge?.results ?? {})[0];
    t.ok(res?.dc === 21, `бросок против исправленной СЛ: ${res?.dc}`);
    t.ok(r.degree === "success", `степень ${r.degree}`);
    t.ok(r.aura?.system.duration.value === ROUNDS.success, `аура: ${JSON.stringify(r.aura?.system.duration)}`);
  });

  sc("strike-breaks", "Lingering -> Удар -> композиция: связь разорвана, карточки проверки нет, аура 1 раунд, фокус не возвращается", async (e, t) => {
    const t0 = e.since();
    const r = await run(e, { between: "strike", roll: "crit" });
    await wait(2500);
    t.ok(!r.host && hosts(e, t0).length === 0, "карточки проверки нет");
    t.ok(r.aura?.system.duration.value === 1, `аура не продлена: ${JSON.stringify(r.aura?.system.duration)}`);
    t.ok(r.b.A.system.resources.focus.value === 0, "фокус остался потраченным");
  });

  sc("hymn-negative", "Lingering -> Hymn of Healing (не кантрип): карточки проверки нет", async (e, t) => {
    const t0 = e.since();
    const r = await run(e, { spell: "hymn", roll: "crit", focus: 2 });
    await wait(2500);
    t.ok(!r.host && hosts(e, t0).length === 0, "карточки проверки нет");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} l3-chunk3 | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      if (status === "fail") { try { detail += diag(); } catch { /* ok */ } }
      if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 4).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    console.error = ceOrig;
    window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr);
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afL3cResult = out;
  return out;
}
