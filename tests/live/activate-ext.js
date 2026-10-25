async () => {
  // Живые сценарии activate-ext (plan-activate-ext §6 п.6): свой срок записи (duration) и иммунитет после спасброска самого заклинания (immunity).
  // (а) Cloak of Social Graces: Heroism 1 минута, откат снимает; (б) Invisibility: состояние на 1 минуту; (в) Bewitching Bloom: вариант Calm, срок «до конца хода»;
  // (г) Dominate у несвязанного токена NPC: успех -> иммунитет 24 ч и «цель иммунна» без броска; провал -> controlled + repeat, успешный повтор снимает controlled и обёртку;
  // (д) иммунитет охватывает автора: второй актёр-вампир не блокируется; (е) удаление сообщения возвращает счётчик (иммунитет остаётся), отмена снимает иммунитет.
  // Только вкладка ГМа: клиента игрока в tests/live эмулировать нечем — пункт плана «вести и с клиента игрока» остаётся ручным (авторы здесь — PC без пользователя, всё исполняет ГМ).
  // Состояние pf2e-automations (PA) пишется в result.pa и в detail каждой строки. Правила Heroism и Calm — из catalog.pa.json: при активном PA и сработавшей уступке
  // (state.yielded) сценарий проверяет именно уступку (модуль эффект не накладывает), без PA — сам срок. Invisibility и Dominate не из PA: проверяются всегда.
  // Прогон переключает mode.apply = auto (возвращает прежнее значение в конце). Нужен mode.challenge не off. Сетка сцены 100 px / 5 фт; автор в (500,500), цель-NPC в (600,500).
  // Параметры (перед запуском): window.__afActivateExt = { only: ["cloak", ...], skip: [...], cleanOnly: true }
  // Результат: { summary, pa, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afActivateExtResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afActivateExt ?? {}) };
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
  // pf2e: shift ИНВЕРТИРУЕТ настройку show*Dialogs; прогон ставит их в false, поэтому shift нужен только если окна включены.
  const api = () => game.modules.get(MOD).api;
  const imp = (f) => import(`/modules/${MOD}/scripts/${f}`);
  const setting = (k) => game.settings.get(MOD, k);
  const PA = { active: !!game.modules.get("pf2e-automations")?.active, yieldSetting: (() => { try { return !!game.settings.get(MOD, "yieldToAutomations"); } catch { return null; } })() };
  const paTag = `PA ${PA.active ? "вкл" : "выкл"}, yieldToAutomations=${PA.yieldSetting}`;

  // ---------- уборка (аварийная: window.__afActivateExt = {cleanOnly: true}) ----------
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
  const applyPrev = setting("mode.apply");
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
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null, pick: null, mark: 0 };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна: наши .paf-dialog: e.pick = data-action кнопки (id варианта), иначе закрываются; ChoiceSet pf2e — первый вариант; окна бросков pf2e — жмём «Бросок»
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          e.dialogs.push(el.querySelector(".window-title")?.textContent?.trim() ?? el.id);
          const b = e.pick != null ? el.querySelector(`button[data-action="${e.pick}"]`) : null;
          if (b) b.click(); else foundry.applications.instances.get(el.id)?.close();
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
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: все проверки и выдача — на этом актёре, не на исходном
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
    e.gear = async (actor, slug, activate) => {
      const rule = { v: 1, activate };
      const v = api().validateRule(rule);
      if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
      const d = await equip(slug);
      d.flags = { ...d.flags, [MOD]: { rule } };
      const [it] = await e.give(actor, d);
      return it;
    };
    e.card = async (item) => {
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
      if (!m) throw new Error(`у карточки «${item.name}» нет снимка use (правило не найдено или модуль не слушает)`);
      await waitFor(() => e.dom(m)?.querySelector(".pf2e-automato"), 6000);
      return game.messages.get(m.id);
    };
    e.btn = (m, castId) => e.dom(m)?.querySelector(`.pf2e-automato button[data-action="cast-item"]${castId ? `[data-cast="${castId}"]` : ""}`) ?? null;
    /** Нажать кнопку активации; -> сообщения активации (флаг activation), появившиеся после нажатия (ждём n штук; меньше за ms — что есть). */
    e.press = async (m, id, { n = 1, ms = 12000 } = {}) => {
      const t0 = e.mark = e.since(), b = e.btn(m, id);
      if (!b) throw new Error(`нет кнопки ${id ?? ""} на карточке`);
      b.click();
      const mine = () => e.msgs(t0).filter((x) => x.flags?.[MOD]?.activation);
      await waitFor(() => mine().length >= n, ms);
      return mine();
    };
    e.kind = (m) => (m.flags?.[MOD]?.use?.kind === "use" && !m.flags?.pf2e?.origin ? "use" : m.flags?.pf2e?.origin?.type === "spell" ? "spell" : "?");
    e.uses = (item, id) => item.flags?.[MOD]?.uses?.[id];
    e.combat = async (toks, inits) => {
      live();
      const c = await Combat.create({ scene: e.scene.id, active: true });
      await c.createEmbeddedDocuments("Combatant", toks.map((t, i) => ({ tokenId: t.id, sceneId: e.scene.id, actorId: t.actor.id, initiative: inits[i] })));
      await viewCombat(c);
      return c;
    };
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

  // ---------- сценарии activate-ext ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const sp = (id) => `Compendium.pf2e.spells-srd.Item.${id}`;
  const HEROISM = sp("KqvqNAfGIE5a9wSv"), INVIS = sp("XXqE1eY3w3z6xJCB"), CALM = sp("b515AZlB0sridKSq"), DOMINATE = sp("OsOhx3TGIZ7AhD0P");
  const HERO_EFFECT = "Compendium.pf2e.spell-effects.Item.l9HRQggofFGIxEse", CALM_EFFECT = "Compendium.pf2e.spell-effects.Item.Qr5rgoZvI4KmFY0N";
  const DAY = { value: 1, unit: "days" };
  const IMM = { slug: "dominate", label: "Dominate", duration: { value: 24, unit: "hours" }, degrees: ["success", "criticalSuccess"] };   // как у 15 NPC-активаций Dominate
  const DUR = (m) => (m ? `${m.system.duration.value} ${m.system.duration.unit}${m.system.duration.expiry ? `/${m.system.duration.expiry}` : ""}` : "нет");
  /** Эффекты актёра, созданные правилом сообщения (ключ meta «<id сообщения>:…»). */
  const meta = (a, ...ms) => a.itemTypes.effect.filter((x) => ms.some((m) => x.flags?.[MOD]?.meta?.key?.startsWith(`${m.id}:`)));
  const immEffects = (a) => a.itemTypes.effect.filter((x) => x.flags?.[MOD]?.immunity?.slug === "dominate");
  const hosts = (e, t0) => e.msgs(t0).filter((m) => m.flags?.[MOD]?.use?.state?.event);   // карточки повтора спасброска
  const carrier = (a) => a.items.find((i) => i.flags?.[MOD]?.meta?.repeat) ?? null;
  const nextTurn = async (c) => { await bound("nextTurn", c.nextTurn()); await wait(2500); };
  /** Откат как кнопка «Отменить»: по всем ключам целей сообщения. */
  const undoAll = async (m) => {
    const { undoOps } = await imp("apply.mjs"), st = game.messages.get(m.id).flags[MOD].use.state ?? {};
    for (const k of new Set([...Object.keys(st.apply ?? {}), ...Object.keys(st.challenge?.applied ?? {})])) await bound(`undoOps ${k}`, undoOps(game.messages.get(m.id), k));
  };
  /**
   * Правило пришло из PA (Heroism, Calm): при активном PA модуль может уступить (state.yielded) — тогда проверяем уступку и сценарий завершён (true).
   * Без PA уступки быть не должно. Правила не из PA (Invisibility, Dominate): уступка всегда ошибка (expectPa = false).
   */
  const yields = async (e, t, m, expectPa = true) => {
    const st = await waitFor(() => { const s = e.use(m)?.state; return s && (s.yielded || s.done || Object.keys(s).length) ? s : null; }, 12000);
    t.ok(!!st, "состояние правила появилось в сообщении");
    if (st?.yielded) {
      t.ok(expectPa && PA.active, `уступка PA (${st.yielded}) — допустима только у правила из PA при активном pf2e-automations (${paTag})`);
      await wait(1500);
      return true;
    }
    return false;
  };
  /** PC (500,500) и NPC-цель (600,500); предмет с правилом activate у PC (dc может быть функцией от модификатора Воли цели); карточка; цель — владелец (self) или NPC. */
  const stage = async (e, slug, activate, { self = false } = {}) => {
    openChat(); needMode("mode.challenge", "off");
    const pc = await e.pc("владелец"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const real = await equip(slug).then(() => slug, () => "warding-tattoo");   // правило — флаг, личность предмета не важна; нет в паке — любой известный
    const item = await e.gear(e.A(tP), real, typeof activate === "function" ? activate(e.A(tV).saves.will.mod) : activate);
    await e.aim(tP, self ? tP : tV);
    const card = await e.card(item);
    return { pc, vic, tP, tV, item, card };
  };

  sc("pack", "Сроки эффектов в паке pf2e.spell-effects (по паку, не по памяти): Heroism и See the Unseen 10 минут, Calm 1 минута — в detail", async (e, t) => {
    const hero = await fromUuid(HERO_EFFECT), calm = await fromUuid(CALM_EFFECT);
    const p = game.packs.get("pf2e.spell-effects"), ix = await p.getIndex({ fields: ["system.slug", "system.duration"] });
    const see = ix.find((i) => /see-the-unseen/.test(i.system?.slug ?? ""));
    t.ok(!!hero && hero.system.duration.value === 10 && hero.system.duration.unit === "minutes", `Heroism: ${DUR(hero)} (ждали 10 minutes)`);
    t.ok(!!calm && calm.system.duration.value === 1 && calm.system.duration.unit === "minutes", `Calm: ${DUR(calm)} (ждали 1 minutes)`);
    t.ok(!!see && see.system.duration?.value === 10 && see.system.duration?.unit === "minutes", `See the Unseen: ${see ? `${see.system.duration?.value} ${see.system.duration?.unit}` : "не найден по slug"} (ждали 10 minutes)`);
  });

  sc("cloak", "(а) Cloak of Social Graces: Heroism у владельца 1 минута вместо 10 пака; в метке activation duration; откат снимает [Heroism из PA: при PA — уступка]", async (e, t) => {
    const { tP, item, card } = await stage(e, "cloak-of-social-graces", [{ id: "heroism", label: "Heroism", spell: HEROISM, requires: "none", per: DAY, duration: { value: 1, unit: "minutes" } }], { self: true });
    const [m] = await e.press(card, "heroism");
    t.ok(!!m && e.kind(m) === "spell", `карточка заклинания: ${m && e.kind(m)} ${notes.join(" / ")}`);
    if (!m) return;
    t.ok(m.flags[MOD].activation.duration?.value === 1 && m.flags[MOD].activation.duration?.unit === "minutes", `метка activation.duration: ${JSON.stringify(m.flags[MOD].activation.duration)}`);
    if (await yields(e, t, m)) { t.ok(!meta(e.A(tP), m).length, "при уступке модуль эффект не накладывал"); return; }
    const eff = await waitFor(() => meta(e.A(tP), m)[0], 10000);
    t.ok(!!eff, "эффект Heroism создан правилом сообщения");
    if (!eff) return;
    t.ok(eff.system.duration.value === 1 && eff.system.duration.unit === "minutes", `срок эффекта ${DUR(eff)} (ждали 1 minutes, в паке 10)`);
    t.ok(eff._stats?.compendiumSource === HERO_EFFECT || /heroism/i.test(eff.slug ?? ""), `это эффект Heroism: ${eff.name} / ${eff._stats?.compendiumSource}`);
    t.ok(e.uses(item, "heroism")?.log?.length === 1, `счётчик списан: ${JSON.stringify(e.uses(item, "heroism"))}`);
    await undoAll(m);
    t.ok(!!(await waitFor(() => !meta(e.A(tP), m).length, 8000)), "откат снял эффект");
  });

  sc("invis", "(б) Invisibility: состояние невидимости на 1 минуту (в правиле заклинания 10); откат снимает [правило не из PA — без уступки]", async (e, t) => {
    const { tP, card } = await stage(e, "invisibility", [{ id: "invis", label: "Invisibility", spell: INVIS, rank: 2, per: DAY, duration: { value: 1, unit: "minutes" } }], { self: true });
    const [m] = await e.press(card, "invis");
    t.ok(!!m && e.kind(m) === "spell", `карточка заклинания: ${m && e.kind(m)}`);
    if (!m) return;
    if (await yields(e, t, m, false)) return;
    const w = await waitFor(() => meta(e.A(tP), m)[0], 10000);
    t.ok(!!w, "обёртка-эффект срока создана");
    t.ok(w?.system.duration.value === 1 && w?.system.duration.unit === "minutes", `срок обёртки ${DUR(w)} (ждали 1 minutes, в правиле 10)`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tP), "invisible"), 6000)), "состояние invisible у владельца");
    await undoAll(m);
    t.ok(!!(await waitFor(() => !e.cond(e.A(tP), "invisible") && !meta(e.A(tP), m).length, 8000)), "откат снял состояние и обёртку");
  });

  sc("bloom", "(в) Bewitching Bloom: вариант Calm (choices) со сроком «до конца хода» = {1, rounds, turn-end}; эффект на цели в области [Calm из PA: при PA — уступка]", async (e, t) => {
    const { tV, card } = await stage(e, "bewitching-bloom-white-poppy", [{ id: "bloom", label: "Bewitching Bloom", requires: "none", per: DAY, dc: 20, choices: [
      { id: "calm", spell: CALM, duration: { value: 1, unit: "rounds", expiry: "turn-end" } },
      { id: "sanctuary", spell: sp("8xRzLhwGL7Dgy3EZ"), duration: { value: 1, unit: "rounds", expiry: "turn-end" } }] }]);
    e.pick = "calm";
    await e.fix(1);   // Воля цели провалена -> эффект Calm
    const [m] = await e.press(card, "bloom");
    t.ok(!!m && e.kind(m) === "spell" && m.flags[MOD].activation.choice === "calm", `вариант calm: ${m && e.kind(m)}, choice ${m?.flags?.[MOD]?.activation?.choice}`);
    if (!m) return;
    t.ok(m.flags[MOD].activation.duration?.unit === "rounds" && m.flags[MOD].activation.duration?.expiry === "turn-end", `метка activation.duration у варианта: ${JSON.stringify(m.flags[MOD].activation.duration)}`);
    if (await yields(e, t, m)) { t.ok(!meta(e.A(tV), m).length, "при уступке модуль эффект не накладывал"); return; }
    await waitFor(() => e.use(m)?.state?.awaitingRegion || e.use(m)?.state?.done, 8000);
    await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#0000aa", shapes: [{ type: "circle", hole: false, x: 650, y: 550, radius: 80 }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: "burst" } } }]);
    t.ok(!!(await waitFor(() => (e.use(m)?.state?.area?.keys ?? []).includes(tV.id), 10000)), `область снята: ${JSON.stringify(e.use(m)?.state?.area)}`);
    const eff = await waitFor(() => meta(e.A(tV), m)[0], 12000);
    t.ok(!!eff, `эффект Calm у цели (результат ${JSON.stringify(e.results(m))})`);
    t.ok(eff?.system.duration.value === 1 && eff?.system.duration.unit === "rounds" && eff?.system.duration.expiry === "turn-end", `срок ${DUR(eff)} (ждали 1 rounds/turn-end; в паке 1 minutes)`);
  });

  // Dominate: СЛ = модификатор Воли цели + 6 -> d20=3 даёт провал (−3), d20=11 даёт успех (+5): никогда не крит. провал (там repeat нет) и не крит. успех
  const domEntry = (extra = {}) => (mod) => [{ id: "dom", label: "Dominate", spell: DOMINATE, dc: mod + 6, requires: "none", immunity: IMM, ...extra }];
  const SUCCESS = 11, FAIL = 3;   // не 1: натуральная 1 понижает степень на одну (pf2e) -> был бы крит. провал

  sc("dom-success", "(г) Dominate у NPC: успех спасброска -> иммунитет 24 ч (метка activation.immunity цела); второй каст — цель иммунна, без броска, без второго иммунитета", async (e, t) => {
    const { pc, tV, item, card } = await stage(e, "warding-tattoo", domEntry());
    await e.fix(SUCCESS);
    const [m] = await e.press(card, "dom");
    t.ok(!!m && e.kind(m) === "spell", `карточка заклинания: ${m && e.kind(m)}`);
    if (!m) return;
    if (await yields(e, t, m, false)) return;
    t.ok(!!(await waitFor(() => e.results(m)[tV.id], 12000)), `спасбросок цели: ${JSON.stringify(e.results(m))}`);
    t.ok(e.results(m)[tV.id] === "success", `исход success: ${e.results(m)[tV.id]}`);
    const imm = await waitFor(() => immEffects(e.A(tV))[0], 8000);
    t.ok(!!imm, "эффект-иммунитет у цели");
    t.ok(imm?.system.duration.value === 24 && imm?.system.duration.unit === "hours", `срок иммунитета ${DUR(imm)}`);
    t.ok(imm?.system.context?.origin?.actor === pc.uuid, `автор иммунитета — заклинатель: ${imm?.system.context?.origin?.actor}`);
    t.ok(m.flags[MOD].activation.immunity?.slug === "dominate" && game.messages.get(m.id).flags[MOD].activation.immunity?.slug === "dominate", "метка activation.immunity на месте");
    t.ok(!e.cond(e.A(tV), "controlled"), "при успехе controlled нет");
    const [m2] = await e.press(await e.card(item), "dom", { ms: 12000 });
    t.ok(!!m2, "второй каст создал карточку заклинания");
    if (!m2) return;
    await wait(5000);
    t.ok(!Object.keys(e.results(m2)).length, `цель иммунна — броска нет: ${JSON.stringify(e.results(m2))}`);
    t.ok(immEffects(e.A(tV)).length === 1 && !meta(e.A(tV), m2).length, `второго иммунитета и эффектов нет: ${immEffects(e.A(tV)).length}`);
  });

  sc("dom-fail", "(г) Dominate у NPC: провал -> controlled в обёртке (1 день) с repeat на конец хода, иммунитета нет; успешный повтор снимает и controlled, и обёртку", async (e, t) => {
    const { tP, tV, card } = await stage(e, "warding-tattoo", domEntry());
    const c = await e.combat([tP, tV], [20, 10]);
    await c.startCombat(); await wait(1200);
    await e.fix(FAIL);
    const [m] = await e.press(card, "dom");
    t.ok(!!m && e.kind(m) === "spell", `карточка заклинания: ${m && e.kind(m)}`);
    if (!m) return;
    if (await yields(e, t, m, false)) return;
    t.ok(!!(await waitFor(() => e.results(m)[tV.id], 12000)) && e.results(m)[tV.id] === "failure", `исход failure: ${JSON.stringify(e.results(m))}`);
    const car = await waitFor(() => carrier(e.A(tV)), 10000);
    t.ok(!!car, "носитель repeat создан");
    t.ok(!!(await waitFor(() => e.cond(e.A(tV), "controlled"), 6000)), "состояние controlled у цели");
    t.ok(car?.flags?.[MOD]?.meta?.repeat?.on === "turn-end", `meta.repeat: ${JSON.stringify(car?.flags?.[MOD]?.meta?.repeat)}`);
    t.ok(car?.system.duration.value === 1 && car?.system.duration.unit === "days", `срок обёртки ${DUR(car)} (ждали 1 days)`);
    t.ok(!immEffects(e.A(tV)).length, "иммунитета при провале нет (степени success/criticalSuccess)");
    t.ok(game.messages.get(m.id).flags[MOD].activation.immunity?.slug === "dominate", "метка activation не потеряна");
    const t0 = e.since();
    await nextTurn(c);   // ход цели
    await e.fix(SUCCESS);
    await nextTurn(c);   // конец хода цели: NPC бросает повтор сам
    const h = hosts(e, t0);
    t.ok(h.length === 1 && ["success", "criticalSuccess"].includes(e.results(h[0])?.[tV.id]), `карточка повтора одна, успех: ${h.length} / ${JSON.stringify(h[0] && e.results(h[0]))}`);
    t.ok(!!(await waitFor(() => !carrier(e.A(tV)) && !meta(e.A(tV), m).length, 8000)), "обёртка-носитель снята");
    t.ok(!!(await waitFor(() => !e.cond(e.A(tV), "controlled"), 6000)), "controlled снят вместе с обёрткой");
  });

  sc("two-authors", "(д) Два актёра-вампира: иммунитет цели к Dominate первого не мешает второму (охват — автор); повтор от первого — без броска", async (e, t) => {
    openChat(); needMode("mode.challenge", "off");
    const pc1 = await e.pc("вампир 1"), pc2 = await e.pc("вампир 2"), vic = await e.foe("цель");
    const t1 = await e.tok(pc1, 500, 500, 1), t2 = await e.tok(pc2, 500, 700, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const entry = domEntry()(e.A(tV).saves.will.mod);
    const i1 = await e.gear(e.A(t1), "warding-tattoo", entry), i2 = await e.gear(e.A(t2), "warding-tattoo", entry);
    await e.fix(SUCCESS);
    await e.aim(t1, tV);
    const [m1] = await e.press(await e.card(i1), "dom");
    if (!m1 || await yields(e, t, m1, false)) { t.ok(!!m1, "первая карточка"); return; }
    t.ok(!!(await waitFor(() => e.results(m1)[tV.id], 12000)) && !!(await waitFor(() => immEffects(e.A(tV)).length === 1, 8000)), `первый вампир: ${JSON.stringify(e.results(m1))}, иммунитетов ${immEffects(e.A(tV)).length}`);
    await e.aim(t2, tV);
    const [m2] = await e.press(await e.card(i2), "dom");
    t.ok(!!m2, "карточка второго вампира");
    if (!m2) return;
    t.ok(!!(await waitFor(() => e.results(m2)[tV.id], 12000)), `второй вампир: цель бросает: ${JSON.stringify(e.results(m2))}`);
    t.ok(!!(await waitFor(() => immEffects(e.A(tV)).length === 2, 8000)), `иммунитетов теперь два (по автору): ${immEffects(e.A(tV)).length}`);
    t.ok(new Set(immEffects(e.A(tV)).map((x) => x.system.context?.origin?.actor)).size === 2, "у иммунитетов разные авторы");
    await e.aim(t1, tV);
    const [m3] = await e.press(await e.card(i1), "dom");
    if (!m3) return t.ok(false, "повторная карточка первого вампира");
    await wait(5000);
    t.ok(!Object.keys(e.results(m3)).length, `первый вампир повторно: цель иммунна, броска нет: ${JSON.stringify(e.results(m3))}`);
  });

  sc("undo-delete", "(е) Удаление сообщения возвращает счётчик, но иммунитет остаётся; кнопка отмены (undoOps) снимает иммунитет и состояния; удаление ветки НЕ снимает эффекты", async (e, t) => {
    const { tV, item, card } = await stage(e, "warding-tattoo", domEntry({ per: DAY }));
    await e.fix(SUCCESS);
    const [m] = await e.press(card, "dom");
    t.ok(!!m, "карточка заклинания");
    if (!m || await yields(e, t, m, false)) return;
    t.ok(!!(await waitFor(() => immEffects(e.A(tV))[0], 12000)), "иммунитет создан");
    t.ok(!!(await waitFor(() => e.uses(item, "dom")?.log?.length === 1, 6000)), `счётчик списан: ${JSON.stringify(e.uses(item, "dom"))}`);
    await game.messages.get(m.id).delete();
    t.ok(!!(await waitFor(() => !e.uses(item, "dom"), 8000)), "удаление сообщения вернуло счётчик");
    t.ok(immEffects(e.A(tV)).length === 1, "иммунитет удаление не снимает");
    // чтобы второй каст бросал и stunned от него был свой: stunned первого каста удаление сообщения не снимает, при повторе он бы не создался (policy max) и отмена его не тронула бы
    await e.A(tV).deleteEmbeddedDocuments("Item", [...immEffects(e.A(tV)), e.cond(e.A(tV), "stunned")].filter(Boolean).map((x) => x.id));
    await e.fix(SUCCESS);
    const [m2] = await e.press(await e.card(item), "dom");
    t.ok(!!m2, "второй каст");
    if (!m2) return;
    t.ok(!!(await waitFor(() => immEffects(e.A(tV))[0] && e.results(m2)[tV.id], 12000)), `второй каст: иммунитет создан, ${JSON.stringify(e.results(m2))}`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tV), "stunned"), 6000)), "перед отменой состояние stunned от степени есть");
    await undoAll(m2);
    t.ok(!!(await waitFor(() => !immEffects(e.A(tV)).length, 8000)), "отмена (undoOps) сняла иммунитет");
    t.ok(!e.cond(e.A(tV), "stunned"), "и состояние stunned от степени");
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами
    if (applyPrev !== "auto") await game.settings.set(MOD, "mode.apply", "auto");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} activate-ext | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 3).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail: `[${paTag}] ${detail}` });
    }
  } finally {
    Object.assign(N, nOrig);
    foundry.applications.api.DialogV2.confirm = confirmPrev;
    try { await game.settings.set(MOD, "mode.apply", applyPrev); } catch { /* ok */ }
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  const table = rows.map((r) => `${r.id.padEnd(12)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, pa: PA, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afActivateExtResult = result;
  return result;
}
