async () => {
  // Живые сценарии cast-activation (примитив cast): активация снаряжения «You cast X» — кнопка на карточке предмета, эфемерное заклинание, СЛ/ранг, частота, требование. plan-cast-activation.md.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в forced-move.js. Правило — флаг rule на копии предмета из компендиума (или на временной способности NPC).
  // Параметры (перед запуском): window.__afCast = { only: ["jolt", ...], skip: [...], cleanOnly: true }
  // Нужны mode.challenge = auto и mode.apply = auto. Сетка сцены 100 px / 5 фт; автор в (500,500), цель-NPC в (600,500).
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afCastResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afCast ?? {}) };
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

  // ---------- уборка (аварийная: window.__afCast = {cleanOnly: true}) ----------
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
    /** Предмет-копия на актёре с правилом cast в флаге (rule валидируется заранее; ошибка — в detail). */
    e.gear = async (actor, slug, cast, patch = (d) => d) => {
      const rule = { v: 1, cast };
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
    /** Нажать кнопку активации на карточке; -> сообщение сотворения (флаг cast) или null. */
    e.click = async (m, castId, ms = 12000) => {
      const t0 = e.since(), b = e.btn(m, castId);
      if (!b) throw new Error(`нет кнопки ${castId ?? ""} на карточке`);
      b.click();
      return waitFor(() => e.msgs(t0).find((x) => x.flags?.[MOD]?.activation && x.flags?.[MOD]?.activation?.id === (castId ?? x.flags[MOD].activation.id)), ms);
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

  // ---------- сценарии cast-activation ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const flagOf = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.activation;
  /** PC (500,500) и NPC-цель (600,500); предмет с правилом cast у PC; карточка предмета. */
  const stage = async (e, slug, cast, { pcItems = [], patch } = {}) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("владелец", pcItems), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const item = await e.gear(e.A(tP), slug, cast, patch);
    await e.aim(tP, tV);
    const card = await e.card(item);
    return { pc, vic, tP, tV, item, card };
  };
  const ARC = "Compendium.pf2e.spells-srd.Item.kBhaPuzLUSwS6vVf";

  sc("jolt", "Jolt Coil: кнопка на карточке -> заклинание с СЛ 17, у цели спасбросок, use.dc = 17, в опциях origin:item:cast-by-activation", async (e, t) => {
    const { tV, card } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: 17, requires: "none" }]);
    const b = e.btn(card);
    t.ok(!!b && !b.disabled, "кнопка есть и активна");
    t.ok(/17/.test(e.dom(card).querySelector(".paf-cast")?.textContent ?? ""), `в подписи СЛ 17: ${e.dom(card).querySelector(".paf-cast")?.textContent?.replace(/\s+/g, " ")}`);
    await e.fix(1);
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания");
    if (!m) return;
    t.ok(flagOf(m)?.dc === 17, `cast.dc = ${flagOf(m)?.dc}`);
    t.ok(m.flags.pf2e.origin.rollOptions.includes("origin:item:cast-by-activation"), "опция cast-by-activation");
    t.ok(await waitFor(() => e.use(m)?.dc === 17, 8000), `use.dc = ${e.use(m)?.dc}`);
    t.ok(await waitFor(() => e.results(m)[tV.id], 10000), `спасбросок цели: ${JSON.stringify(e.results(m))}`);
    t.ok(m.item?.name && m.item.spellcasting?.statistic?.dc?.value === 17, `message.item.spellcasting.statistic.dc = ${m.item?.spellcasting?.statistic?.dc?.value}`);
  });

  sc("fear", "Habu's Cudgel: Fear с СЛ 24, ранг 3 — правило каталога заклинания работает (крит. провал -> испуг)", async (e, t) => {
    const { tV, card } = await stage(e, "habus-cudgel", [{ id: "fear", spell: await spellUuid("fear"), rank: 3, dc: 24, requires: "none" }]);
    await e.fix(1);
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания");
    if (!m) return;
    t.ok(flagOf(m)?.rank === 3 && m.flags.pf2e.origin.castRank === 3, `ранг 3: cast.rank=${flagOf(m)?.rank}, castRank=${m.flags.pf2e.origin.castRank}`);
    t.ok(await waitFor(() => e.results(m)[tV.id] === "criticalFailure", 10000), `исход: ${JSON.stringify(e.results(m))}`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tV), "frightened"), 10000)), "у цели испуг по степени");
    t.ok(e.use(m)?.rule?.onUse?.challenge?.byDegree?.criticalFailure?.length > 0, "в снимке правило каталога Fear (не вывод из разметки)");
  });

  sc("attack", "Заклинание-атака: бонус атаки = СЛ − 10, rollAttack не падает, итог броска d20 + 10", async (e, t) => {
    const { card } = await stage(e, "habus-cudgel", [{ id: "frost", spell: await spellUuid("ray-of-frost"), dc: 20, requires: "none" }]);
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания");
    if (!m) return;
    const item = game.messages.get(m.id).item;
    t.ok(item?.isAttack, "заклинание — атака");
    const mod = item?.spellcasting?.statistic?.check?.mod;
    t.ok(mod === 10, `модификатор атаки ${mod}`);
    await e.fix(10);
    const t0 = e.since();
    await bound("rollAttack", item.rollAttack({ shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs }, 1));
    const r = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.type === "attack-roll"), 8000);
    t.ok(!!r && r.rolls?.[0]?.total === 20, `бросок атаки: ${r?.rolls?.[0]?.total}`);
  });

  sc("alive", "Карточка жива после пересборки актёра (prepareData) и «на другом клиенте» (холодная запись): СЛ, урон, развеивание", async (e, t) => {
    const { tP, card } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: 17, requires: "none" }]);
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания");
    if (!m) return;
    const actor = e.A(tP), dcOf = (it) => it?.spellcasting?.statistic?.dc?.value;
    const synth = actor.synthetics;
    await actor.update({ "system.details.blurb": "AF" });   // prepareData вручную pf2e/v14 не даёт; обновление пересобирает актёра: initialize() стирает записи заклинателя, наша живёт вне коллекции
    t.ok(actor.synthetics !== synth, "актёр пересобран (synthetics новые)");
    const item = game.messages.get(m.id).item;
    t.ok(dcOf(item) === 17, `после пересборки СЛ ${dcOf(item)}`);
    t.ok(!!(await item.getDamage()), "урон считается (getDamage)");
    const cr = await bound("rollCounteract", item.rollCounteract({ shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs })).then(() => "ok").catch((x) => `ошибка ${x?.message}`);
    t.ok(cr === "ok", `развеивание: ${cr}`);
    // «другой клиент»: свежий экземпляр актёра без кэша записей, заклинание — из встроенного в сообщение источника, как делает ChatMessagePF2e#item
    const fresh = new CONFIG.Actor.documentClass(actor.toObject(), { parent: null });
    const spell = new CONFIG.PF2E.Item.documentClasses.spell(m.flags.pf2e.casting.embeddedSpell, { parent: fresh });
    t.ok(dcOf(spell) === 17 && spell.rank >= 1, `холодная запись: СЛ ${dcOf(spell)}, ранг ${spell.rank}`);
  });

  sc("npc-high", "Несвязанный токен NPC: dc {level: high} — СЛ по уровню токена-актёра, предмет и карточка с адресом Scene…", async (e, t) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const npc = await e.foe("заклинатель"), vic = await e.foe("жертва");
    const tN = await e.tok(npc, 500, 500, -1), tV = await e.tok(vic, 600, 500, 1);
    await wait(700);
    const actor = e.A(tN);
    t.ok(!actor.token?.actorLink && actor.uuid.startsWith("Scene."), `токен несвязанный: ${actor.uuid}`);
    const item = await e.gear(actor, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: { level: "high" }, requires: "none" }]);
    await e.aim(tN, tV);
    const card = await e.card(item);
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания");
    if (!m) return;
    const { highDc } = await imp("cast.mjs"), want = highDc(actor.level);
    t.ok(flagOf(m)?.dc === want, `cast.dc = ${flagOf(m)?.dc}, ожидалось ${want} (уровень ${actor.level})`);
    t.ok(flagOf(m)?.item?.startsWith("Scene."), `адрес предмета ${flagOf(m)?.item}`);
    t.ok(game.messages.get(m.id).item?.spellcasting?.statistic?.dc?.value === want, "запись заклинателя находится по актёру токена");
  });

  sc("frequency", "Частота раз в день: второй клик спрашивает (отказ — без заклинания), подтверждение — сотворяет, restForTheNight сбрасывает", async (e, t) => {
    const { item, card } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: 17, per: { value: 1, unit: "days" }, requires: "none" }]);
    const first = await e.click(card);
    t.ok(!!first, "первое сотворение");
    t.ok(await waitFor(() => item.flags?.[MOD]?.uses?.["electric-arc"]?.log?.length === 1, 5000), `счётчик записан: ${JSON.stringify(item.flags?.[MOD]?.uses)}`);
    const card2 = await e.card(item);
    t.ok(/cast|использован|spent/i.test(e.btn(card2)?.closest(".paf-cast")?.textContent ?? ""), "на карточке пометка об использовании");
    const again = await e.click(card2, undefined, 4000);
    t.ok(!again && e.dialogs.some((d) => /Активация|activation/i.test(d)), `отказ в окне: нового сообщения нет, окна [${e.dialogs}]`);
    foundry.applications.api.DialogV2.confirm = async () => true;   // «всё равно»
    const third = await e.click(card2);
    t.ok(!!third, "после подтверждения сотворено");
    t.ok(item.flags?.[MOD]?.uses?.["electric-arc"]?.log?.length === 2, `использований 2: ${item.flags?.[MOD]?.uses?.["electric-arc"]?.log?.length}`);
    Hooks.callAll("pf2e.restForTheNight", item.actor);
    t.ok(await waitFor(() => !item.flags?.[MOD]?.uses?.["electric-arc"], 6000), "отдых сбросил счётчики");
  });

  sc("requires", "Требование: не настроен -> кнопка отключена с причиной; настроен — активна; requires none — активна без настройки", async (e, t) => {
    const { item, tP } = await stage(e, "electric-eelskin", [{ id: "thunderstrike", spell: await spellUuid("thunderstrike"), rank: 2, dc: 29 }], { patch: (d) => { d.system.equipped = { carryType: "worn", inSlot: false, invested: false }; return d; } });
    let card = await e.card(item);
    t.ok(e.btn(card)?.disabled === true, `не надет/не настроен: кнопка отключена (${e.btn(card)?.title})`);
    t.ok(!!e.btn(card)?.title, "причина в подсказке");
    await item.update({ "system.equipped": { carryType: "worn", inSlot: true, invested: true } });
    await wait(500);
    card = await e.card(item);
    t.ok(e.btn(card) && !e.btn(card).disabled, "настроен и надет: кнопка активна");
    await item.update({ "system.equipped": { carryType: "worn", inSlot: false, invested: false }, [`flags.${MOD}.rule`]: { v: 1, activate: [{ id: "thunderstrike", spell: await spellUuid("thunderstrike"), dc: 29, requires: "none" }] } });
    await wait(500);
    card = await e.card(item);
    t.ok(e.btn(card) && !e.btn(card).disabled, "requires none: активна без настройки");
  });

  sc("no-spell", "Заклинания нет в мире (пака нет): кнопка отключена с причиной, castItem отказывает без падения", async (e, t) => {
    const { item, card } = await stage(e, "jolt-coil", [{ id: "ghost", spell: "Compendium.af-nope.spells.Item.AAAAAAAAAAAAAAAA", dc: 17, requires: "none" }]);
    t.ok(e.btn(card)?.disabled === true && !!e.btn(card)?.title, `кнопка отключена: ${e.btn(card)?.title}`);
    const res = await api().castItem(item, "ghost");
    t.ok(res.ok === false && res.reason === "cast.why.noSpell", `castItem: ${JSON.stringify(res)}`);
  });

  sc("owner", "Права: владелец и ведущий видят кнопку, не владелец — нет; через buildViewModel с настоящими пользователями", async (e, t) => {
    const players = game.users.filter((u) => !u.isGM);
    if (players.length < 2) throw new Skip("нужно два игрока в мире (владелец и посторонний)");
    const [own, other] = players;
    const { pc, card } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: 17, requires: "none" }]);
    await pc.update({ ownership: { default: 0, [own.id]: 3 } });
    const { buildViewModel } = await imp("chat.mjs");
    const msg = game.messages.get(card.id);
    t.ok(buildViewModel(msg, own)?.cast?.length === 1, "владелец: кнопка");
    t.ok(buildViewModel(msg, game.user)?.cast?.length === 1, "ведущий: кнопка");
    t.ok(!buildViewModel(msg, other)?.cast, "посторонний: кнопки нет");
    t.ok((await api().castItem(null, "x")).ok === false, "castItem без предмета отказывает");
  });

  sc("cantrip", "Кантрип у предмета: ранг = ceil(уровень предмета / 2), сотворение не уходит в рекурсию", async (e, t) => {
    const { item, card } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: 17, requires: "none" }]);
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания (рекурсии нет)");
    if (!m) return;
    const want = Math.ceil(item.level / 2);
    t.ok(flagOf(m)?.rank === want && m.flags.pf2e.origin.castRank === want, `ранг ${flagOf(m)?.rank}, ожидался ${want} (уровень предмета ${item.level})`);
  });

  sc("hidden", "Запись заклинателя невидима другим: getStatistic(spell-dc), коллекция spellcasting и выбор записи для свитков не видят нашу", async (e, t) => {
    const { pc, tP, item, card } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: 17, requires: "none" }]);
    const actor = e.A(tP), before = { dc: actor.getStatistic("spell-dc")?.dc?.value ?? null, n: actor.spellcasting.size };
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания");
    if (!m) return;
    game.messages.get(m.id).item?.spellcasting;   // запись создана и лежит в кэше
    t.ok((actor.getStatistic("spell-dc")?.dc?.value ?? null) === before.dc, `spell-dc: ${before.dc} -> ${actor.getStatistic("spell-dc")?.dc?.value ?? null}`);
    t.ok(actor.spellcasting.size === before.n && ![...actor.spellcasting].some((x) => String(x.id).startsWith("af-cast")), "в spellcasting наших записей нет");
    t.ok(actor.spellcasting.get(`af-cast-${item.id}-electric-arc`)?.isEphemeral === true, "по id запись находится (ленивая)");
    t.ok(!actor.spellcasting.get(`af-cast-${item.id}-nope`), "чужой активации нет");
  });

  sc("give-back", "Удаление карточки сотворения возвращает использование (счётчик снят)", async (e, t) => {
    const { item, card } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: 17, per: { value: 1, unit: "days" }, requires: "none" }]);
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания");
    t.ok(await waitFor(() => item.flags?.[MOD]?.uses?.["electric-arc"]?.log?.length === 1, 5000), "счётчик записан");
    await game.messages.get(m.id).delete();
    t.ok(await waitFor(() => !item.flags?.[MOD]?.uses?.["electric-arc"], 6000), `счётчик снят: ${JSON.stringify(item.flags?.[MOD]?.uses)}`);
  });

  sc("no-caster", "Без СЛ в правиле: СЛ по уровню предмета (воин, пометка byLevel); у кантрипа спеллхарта с записью владельца — большая из двух", async (e, t) => {
    const { pc, item, card, tP } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, requires: "none" }]);
    const { levelDc } = await imp("cast.mjs");
    const m0 = await e.click(card);
    t.ok(!!m0 && flagOf(m0)?.dc === levelDc(item.level) && flagOf(m0)?.byLevel === true, `воин: cast.dc ${flagOf(m0)?.dc}, СЛ уровня ${levelDc(item.level)}, byLevel ${flagOf(m0)?.byLevel}`);
    t.ok(/СЛ по уровню|DC by item level/.test(e.dom(card)?.textContent ?? ""), "кнопка подписана «СЛ по уровню предмета»");
    // у владельца появилась запись; jolt-coil — спеллхарт, Electric Arc — кантрип: СЛ не ниже записи владельца (если выше — запись владельца)
    const actor = e.A(tP);
    await actor.createEmbeddedDocuments("Item", [{ type: "spellcastingEntry", name: "AF запись", system: { ability: { value: "cha" }, prepared: { value: "spontaneous" }, tradition: { value: "arcane" }, proficiency: { value: 4 } } }, { type: "effect", name: "AF СЛ +20", system: { slug: "af-dc-plus", rules: [{ key: "FlatModifier", selector: "arcane-spell-dc", value: 20 }], duration: { value: -1, unit: "unlimited", sustained: false, expiry: null } } }]);   // СЛ записи заведомо выше СЛ предмета
    await wait(500);
    const entry = actor.spellcasting.find((x) => x.statistic), want = entry?.statistic?.dc?.value;
    t.ok(want > levelDc(item.level), `у PC появилась запись с СЛ ${want} выше СЛ уровня ${levelDc(item.level)}`);
    const m = await e.click(await e.card(item));
    t.ok(!!m && flagOf(m)?.dc === want && !flagOf(m)?.byLevel, `кантрип спеллхарта: cast.dc = ${flagOf(m)?.dc}, СЛ записи ${want}`);
    t.ok(m && m.flags.pf2e.casting.id === entry.id, `запись карточки — настоящая: ${m?.flags?.pf2e?.casting?.id}`);
  });

  sc("item-dc", "СЛ по уровню предмета у мага (запись владельца выше СЛ предмета не подменяет её у заклинания не из спеллхарта и у не-кантрипа)", async (e, t) => {
    const { pc, item, card, tP } = await stage(e, "habus-cudgel", [{ id: "fear", spell: await spellUuid("fear"), requires: "none" }]);
    const { levelDc } = await imp("cast.mjs");
    const actor = e.A(tP);
    await actor.createEmbeddedDocuments("Item", [{ type: "spellcastingEntry", name: "AF запись", system: { ability: { value: "cha" }, prepared: { value: "spontaneous" }, tradition: { value: "arcane" }, proficiency: { value: 4 } } }, { type: "effect", name: "AF СЛ +20", system: { slug: "af-dc-plus", rules: [{ key: "FlatModifier", selector: "arcane-spell-dc", value: 20 }], duration: { value: -1, unit: "unlimited", sustained: false, expiry: null } } }]);   // СЛ записи заведомо выше СЛ предмета
    await wait(500);
    const want = actor.spellcasting.find((x) => x.statistic)?.statistic?.dc?.value;
    t.ok(want > levelDc(item.level), `запись мага с СЛ ${want} выше СЛ уровня ${levelDc(item.level)}`);
    const m = await e.click(card);
    t.ok(!!m && flagOf(m)?.dc === levelDc(item.level) && flagOf(m)?.byLevel === true, `cast.dc = ${flagOf(m)?.dc}, СЛ уровня предмета ${levelDc(item.level)}, byLevel ${flagOf(m)?.byLevel}`);
  });

  sc("no-freq", "Кантрип из разметки без блока Frequency (спеллхарт): частоты нет, второй клик без вопроса «использовано»", async (e, t) => {
    const { pc, tP } = await stage(e, "jolt-coil", [{ id: "x", spell: ARC, dc: 17, requires: "none" }]);
    const d = await equip("jolt-coil");
    d.name = PFX + "heart"; d.system.slug = "af-heart-test"; if (d._stats) d._stats.compendiumSource = null;
    d.system.description.value = `<p>The spell DC of any spell cast by activating this item is 17.</p><p><strong>Activate</strong> Cast a Spell</p><p><strong>Effect</strong> You cast @UUID[${ARC}]{Electric Arc}.</p>`;
    const [item] = await e.give(e.A(tP), d);
    const res = (await imp("rules.mjs")).resolveRule(item);
    t.ok(res?.rule?.activate?.length === 1 && res?.rule?.activate[0].per === undefined && res?.rule?.activate[0].dc === 17, `вывод: ${JSON.stringify(res?.rule?.activate)}`);
    const card = await e.card(item);
    t.ok(!!(await e.click(card)), "первое сотворение");
    t.ok(!!(await e.click(card)), "второе сотворение");
    t.ok(!e.dialogs.some((x) => /again|ещё раз|использ/i.test(x)) && !item.flags?.[MOD]?.uses, `без вопроса и без счётчика: окна [${e.dialogs}], uses ${JSON.stringify(item.flags?.[MOD]?.uses)}`);
  });

  sc("attached", "Спеллхарт, прикреплённый к оружию (subitems): кнопка на карточке работает, ChatMessage#item после prepareData жив, счётчик частоты пишется во вложенный предмет", async (e, t) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("владелец"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const actor = e.A(tP), rule = { v: 1, activate: [{ id: "electric-arc", spell: ARC, dc: 17, per: { value: 1, unit: "days" } }] };
    const coil = await equip("jolt-coil"); coil.flags = { ...coil.flags, [MOD]: { rule } };
    const [weapon, loose] = await e.give(actor, await equip("longsword"), coil);
    t.ok(await weapon.attach(loose), "спеллхарт прикреплён");
    const sub = await waitFor(() => actor.items.get(weapon.id)?.subitems?.contents?.[0], 5000);
    t.ok(!!sub && !actor.items.get(sub.id), "предмет вложенный: в actor.items его нет");
    if (!sub) return;
    await e.aim(tP, tV);
    const card = await e.card(sub);
    t.ok(!!e.btn(card) && !e.btn(card).disabled, "кнопка есть и активна");
    await e.fix(1);
    const m = await e.click(card);
    t.ok(!!m, "появилась карточка заклинания");
    if (!m) return;
    t.ok(flagOf(m)?.dc === 17, `cast.dc = ${flagOf(m)?.dc}`);
    t.ok(await waitFor(() => e.results(m)[tV.id], 10000), `спасбросок цели: ${JSON.stringify(e.results(m))}`);
    t.ok(await waitFor(() => actor.items.get(weapon.id)?.subitems.get(sub.id)?.flags?.[MOD]?.uses?.["electric-arc"]?.log?.length === 1, 6000), "счётчик записан во вложенный предмет");
    await actor.update({ "system.details.blurb": "AF" });   // пересборка актёра: запись заклинателя пересоздаётся ленивой обёрткой по id вложенного предмета
    await wait(500);
    t.ok(game.messages.get(m.id).item?.spellcasting?.statistic?.dc?.value === 17, `message.item после prepareData: dc ${game.messages.get(m.id).item?.spellcasting?.statistic?.dc?.value}`);
    await game.messages.get(m.id).delete();
    t.ok(await waitFor(() => !actor.items.get(weapon.id)?.subitems.get(sub.id)?.flags?.[MOD]?.uses?.["electric-arc"], 6000), "удаление карточки вернуло использование");
  });

  sc("low-rule", "Правило из разметки (low): кнопка только у ведущего, у владельца-игрока нет; расходник (палочка) не получает cast из разметки", async (e, t) => {
    const { pc, tP } = await stage(e, "jolt-coil", [{ id: "x", spell: ARC, dc: 17, requires: "none" }]);
    const d = await equip("jolt-coil");
    d.name = PFX + "low"; d.system.slug = "af-low-test"; if (d._stats) d._stats.compendiumSource = null;   // мимо каталога: правило только из разметки
    // мир может быть переведён (pf2ru) — разметка своя, английская; проверка вне абзаца заклинания ослабляет вывод до low
    const html = `<p>The spell DC of any spell cast by activating this item is 17.</p><p><strong>Activate</strong> Zap</p><p><strong>Effect</strong> You cast @UUID[${ARC}]{Electric Arc}.</p><p>@Check[reflex|dc:30]</p>`;
    d.system.description.value = html;
    const [item] = await e.give(e.A(tP), d);
    const res = (await imp("rules.mjs")).resolveRule(item);
    t.ok(res?.confidence === "low" && res.rule.activate?.length === 1, `вывод low: ${res?.confidence} cast ${res?.rule?.activate?.length}`);
    const card = await e.card(item), { buildViewModel } = await imp("chat.mjs"), msg = game.messages.get(card.id);
    t.ok(buildViewModel(msg, game.user)?.cast?.length === 1, "ведущий: кнопка");
    const own = game.users.find((u) => !u.isGM);
    if (own) { await pc.update({ ownership: { default: 0, [own.id]: 3 } }); t.ok(!buildViewModel(msg, own)?.cast, "владелец-игрок: кнопки нет (low)"); }
    const wand = new Item.implementation({ name: PFX + "палочка", type: "consumable", system: { slug: "af-wand-test", description: { value: html.replace("<p>@Check[reflex|dc:30]</p>", "") }, traits: { value: ["wand", "magical"] } } });
    const wr = (await imp("rules.mjs")).resolveRule(wand);
    t.ok(!wr?.rule?.activate, `расходник: cast из разметки нет (${wr?.source})`);
    t.ok(!!(await imp("rules.mjs")).resolveRule(new Item.implementation({ name: PFX + "доспех", type: "armor", system: { slug: "af-armor-test", description: { value: html.replace("<p>@Check[reflex|dc:30]</p>", "") } } }))?.rule?.activate, "контроль: тот же текст у снаряжения даёт cast");
  });

  sc("clear-log", "Очистка лога (deleteAll) не возвращает использование; обычное удаление — возвращает", async (e, t) => {
    const { item, card } = await stage(e, "jolt-coil", [{ id: "electric-arc", spell: ARC, dc: 17, per: { value: 1, unit: "days" }, requires: "none" }]);
    const m = await e.click(card);
    t.ok(await waitFor(() => item.flags?.[MOD]?.uses?.["electric-arc"]?.log?.length === 1, 5000), "счётчик записан");
    Hooks.callAll("deleteChatMessage", game.messages.get(m.id), { deleteAll: true }, game.user.id);   // как ChatLog flush; сообщения не трогаем
    await wait(1500);
    t.ok(item.flags?.[MOD]?.uses?.["electric-arc"]?.log?.length === 1, `счётчик остался: ${JSON.stringify(item.flags?.[MOD]?.uses)}`);
    await game.messages.get(m.id).delete();
    t.ok(await waitFor(() => !item.flags?.[MOD]?.uses?.["electric-arc"], 6000), "обычное удаление вернуло использование");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} cast-activation | ${s.id}`, err); }
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
  window.__afCastResult = result;
  return result;
}
