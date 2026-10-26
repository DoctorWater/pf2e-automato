async () => {
  // Регрессионный набор живых сценариев pf2e-automato (ROADMAP §6.4). Вкладка активного ГМа-лидера, ничего вручную не нажимать.
  // Параметры (перед запуском): window.__afSuite = { only: ["flanking", ...], skip: [...], cleanOnly: true }
  // Каждый сценарий: свой сцена-стенд и временные «AF тест: …» актёры, в конце ВСЁ удаляется (актёры, сцена, токены, бои, сообщения).
  // Результат: { summary, table, rows }; те же строки — console.table и window.__afSuiteResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afSuite ?? {}) };
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
  let cur = null;   // текущее окружение: после dispose (в т.ч. по таймауту) ожидания и записи брошенного сценария прекращаются
  const DEG = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const deg = (v) => (typeof v === "number" ? DEG[v] : v);
  // pf2e: shift ИНВЕРТИРУЕТ настройку show*Dialogs (eventToRollParams). Прогон ставит их в false (окон нет), поэтому shift окно как раз ПОКАЗЫВАЕТ и бросок
  // ждёт его вечно. Shift — только если окна включены; на всякий случай окна модификаторов ниже закрываются кнопкой броска.
  const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });
  const modOn = (id) => !!game.modules.get(id)?.active;

  // ---------- уборка: всё, что начинается с «AF тест» (работает и как аварийная чистка: window.__afSuite = {cleanOnly: true}) ----------
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
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };   // initiative.roll бросает во viewed-бой

  // ---------- компендиумы ----------
  const idx = {};
  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    idx[pack] ??= await p.getIndex({ fields: ["system.slug"] });
    const e = idx[pack].find((i) => i.system?.slug === slug);
    if (!e) throw new Error(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(e._id)).toObject();
  };
  const spell = (s) => find("pf2e.spells-srd", s), feat = (s) => find("pf2e.feats-srd", s), equip = (s) => find("pf2e.equipment-srd", s);
  const held = (d, hands = 1) => { d.system.equipped = { carryType: "held", handsHeld: hands }; return d; };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", onDialog: null, stop: false, d20: null };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна: наши .paf-dialog — ответ сценария (onDialog) или отмена («Не применять», Магия крови); ChoiceSet pf2e — первый вариант
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          e.dialogs.push(el.querySelector(".window-title")?.textContent?.trim() ?? el.id);
          let handled = false;
          try { handled = !!(await e.onDialog?.(el)); } catch (err) { notes.push(`onDialog: ${err}`); }
          if (!handled) foundry.applications.instances.get(el.id)?.close();
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
    e.world = (re) => game.actors.find((a) => !a.name.startsWith(PFX) && re.test(a.name));
    e.copy = async (src, name) => {
      const d = src.toObject(); delete d._id; delete d._stats;
      const a = await e.add({ ...d, name });
      await a.update({ "system.attributes.hp.value": a.hitPoints?.max ?? a.system.attributes.hp.max });   // у мировых копий ПЗ бывает 0
      return a;
    };
    e.foe = async (name, extra = {}) => {
      const d = (await fromUuid(GOBLIN)).toObject();
      const a = await e.add({ ...d, ...extra, name });
      await a.update({ "system.attributes.hp.value": a.hitPoints.max });
      return a;
    };
    e.pc = async (name, items = [], extra = {}) => {
      const a = await e.add({ name, type: "character", system: { details: { alliance: "party", languages: { value: ["common"] } } }, ...extra });
      await a.createEmbeddedDocuments("Item", [await find("pf2e.ancestries", "human"), ...items]);   // ancestry даёт ПЗ
      await a.update({ "system.attributes.hp.value": a.hitPoints.max });
      return a;
    };
    /** Заклинатель: спонтанные ячейки 1-2 круга, при focus — ещё фокусная запись (focus-заклинания идут туда). */
    e.caster = async (name, spells, { focus = [], items = [] } = {}) => {
      const a = await e.pc(name, items, { system: { resources: { focus: { max: 1, value: 1 } }, details: { alliance: "party" } } });
      // порядок ответа createEmbeddedDocuments не гарантирован (заклинание попадало в фокусную запись) — записи по имени
      const made = await a.createEmbeddedDocuments("Item", [
        { type: "spellcastingEntry", name: "AF спонтанные", system: { tradition: { value: "occult" }, prepared: { value: "spontaneous" }, ability: { value: "cha" }, slots: { slot1: { max: 4, value: 4 }, slot2: { max: 4, value: 4 }, slot5: { max: 1, value: 1 } } } },
        { type: "spellcastingEntry", name: "AF фокус", system: { tradition: { value: "occult" }, prepared: { value: "focus" }, ability: { value: "cha" } } }
      ]);
      const entry = made.find((i) => i.name === "AF спонтанные"), fEntry = made.find((i) => i.name === "AF фокус");
      const docs = [];
      for (const s of spells) { const d = await spell(s); d.system.location = { value: entry.id }; docs.push(d); }
      for (const s of focus) { const d = await spell(s); d.system.location = { value: fEntry.id }; docs.push(d); }
      await a.createEmbeddedDocuments("Item", docs);
      return a;
    };
    e.slots = (a) => a.itemTypes.spellcastingEntry.length && Promise.all(a.itemTypes.spellcastingEntry.map((en) => en.update(Object.fromEntries(
      Object.entries(en.system.slots ?? {}).map(([k, v]) => [`system.slots.${k}.value`, v.max])))));
    e.tok = async (a, x, y, disposition) => {
      live();
      const [t] = await e.scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition }]);
      return t;
    };
    e.T = (t) => e.scene.tokens.get(t.id);
    e.aim = async (ctrl, ...targets) => {
      e.T(ctrl).object.control({ releaseOthers: true });
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      for (const t of targets) e.T(t).object.setTarget(true, { releaseOthers: false });
      await wait(300);
    };
    e.rig = (actor, selector, value) => live() ?? actor.createEmbeddedDocuments("Item", [{ type: "effect", name: "AF rig", system: { slug: "af-rig", rules: [{ key: "FlatModifier", selector, value }] } }]);
    /** d20 всегда n (CONFIG.Dice.randomUniform: грань = ceil((1-u)*граней)); null — вернуть случайный. */
    e.fix = async (n) => {
      if (n != null) live();
      if (e.d20 === null) e.d20 = CONFIG.Dice.randomUniform;
      CONFIG.Dice.randomUniform = n == null ? e.d20 : () => 1 - (n - 0.5) / 20;
      if (n != null && (await new Roll("1d20").evaluate()).total !== n) throw new Skip("не удалось зафиксировать d20 (CONFIG.Dice.randomUniform)");
    };
    e.since = () => Date.now();
    e.msgs = (t0) => game.messages.contents.filter((m) => m._stats.createdTime >= t0);
    e.attacks = (t0) => e.msgs(t0).filter((m) => m.flags?.pf2e?.context?.type === "attack-roll");
    e.block = (m) => document.querySelector(`#chat [data-message-id="${m?.id}"] .pf2e-automato`);
    e.dom = (m) => document.querySelector(`#chat [data-message-id="${m?.id}"]`);
    e.applyAll = async (m) => { for (const b of [...(e.block(m)?.querySelectorAll("button[data-action^=apply]:not([disabled])") ?? [])]) { live(); b.click(); await wait(1200); } };
    e.states = (a) => a.items.filter((i) => ["condition", "effect"].includes(i.type) && i.slug !== "af-rig").map((i) => `${i.slug}${i.system.value?.value ? ":" + i.system.value.value : ""}`);
    e.has = (a, slug) => a.items.some((i) => i.slug === slug);
    e.metaEffect = (a, key) => a.items.find((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === key);
    e.strike = (a, slug) => a.system.actions.find((s) => s.item?.slug === slug) ?? a.system.actions.find((s) => s.item?.isMelee);
    e.hit = async (att, def, strike = null) => {   // удар att по токену def (shift-клик без окна); сообщение атаки
      await e.aim(att, def);
      const t0 = e.since();
      await bound("бросок Удара (variants[0].roll)", (strike ?? e.strike(e.T(att).actor, "shortsword")).variants[0].roll({ event: SHIFT() }));
      return waitFor(() => e.attacks(t0)[0], 8000);
    };
    /** Каст с карточкой: { card, sp }; ждёт снимок use модуля. */
    e.cast = async (actor, slug, rank) => {
      const sp = actor.itemTypes.spell.find((s) => s.slug === slug);
      if (!sp) throw new Error(`нет заклинания ${slug}`);
      live();
      await e.slots(actor);
      const t0 = e.since();
      await sp.spellcasting.cast(sp, { rank: rank ?? sp.rank });
      const card = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.origin?.uuid === sp.uuid), 8000);
      if (card) await waitFor(() => game.messages.get(card.id)?.flags?.[MOD]?.use, 8000);
      return { card: card && game.messages.get(card.id), sp, t0 };
    };
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.results = (m) => Object.fromEntries(Object.entries(e.use(m)?.state?.challenge?.results ?? {}).map(([k, v]) => [k, deg(v.degree)]));
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
  const spellDC = (sp) => sp.spellcasting?.statistic?.dc?.value ?? null;

  sc("power-volley", "Силовой залп: 2 действия, 2 цели, урон по каждой с context.target, ячейка один раз", async (e, t) => {
    const v = e.world(/Варрис|Varris/i);
    const caster = v?.itemTypes.spell.some((s) => s.slug === "force-barrage") ? await e.copy(v, "Варрис") : await e.caster("маг", ["force-barrage"]);
    await e.slots(caster);
    const tC = await e.tok(caster, 500, 500, 1), f1 = await e.foe("цель 1"), f2 = await e.foe("цель 2");
    const t1 = await e.tok(f1, 800, 500, -1), t2 = await e.tok(f2, 800, 700, -1);
    await wait(700);
    e.onDialog = async (el) => {
      if (el.querySelector("[name=t0]")) { el.querySelector("[name=t0]").value = 1; el.querySelector("[name=t1]").value = 1; el.querySelector("[data-action=ok]").click(); return true; }
      const two = el.querySelector("[data-action='2']");
      if (two) { two.click(); return true; }
    };
    const sp = e.T(tC).actor.itemTypes.spell.find((s) => s.slug === "force-barrage");
    const slotKey = `slot${sp.rank}`, slot = () => sp.spellcasting?.system?.slots?.[slotKey]?.value;
    const before = slot();
    await e.aim(tC, t1, t2);
    const t0 = e.since();
    await sp.spellcasting.cast(sp, { rank: sp.rank });
    const dmg = () => e.msgs(t0).filter((m) => m.flags?.pf2e?.context?.type === "damage-roll" && m.flags.pf2e.origin?.uuid === sp.uuid);
    await waitFor(() => dmg().length >= 2, 15000);
    t.ok(dmg().length === 2, `урон: 2 броска (по цели), а не ${dmg().length}`);
    const targets = dmg().map((m) => m.flags.pf2e.context.target?.token);
    t.ok(new Set(targets).size === 2 && targets.includes(t1.uuid) && targets.includes(t2.uuid), `context.target на обеих целях (${targets.map((x) => x?.split(".").pop())})`);
    t.ok(dmg().every((m) => m.rolls[0]?.total > 0), "урон > 0");
    t.ok(e.dialogs.length >= 2, `окна: число действий и распределение (${e.dialogs.length})`);
    if (before != null) t.ok(before - slot() === 1, `ячейка потрачена один раз (${before} -> ${slot()})`);
  });

  sc("phantom-pain", "Фантомная боль: провал -> тошнота 1 и продолжительный 1d4 ментальный", async (e, t) => {
    const caster = await e.caster("маг", ["phantom-pain"]), foe = await e.foe("цель");
    const tC = await e.tok(caster, 500, 500, 1), tF = await e.tok(foe, 700, 500, -1);
    await wait(700);
    const sp = caster.itemTypes.spell[0], dc = spellDC(sp);
    if (dc == null) throw new Error("нет СЛ заклинаний");
    const fa = e.T(tF).actor;
    await e.rig(fa, "will", dc - 11 - fa.saves.will.mod);   // d20=10 -> итог dc-1: провал, не крит.
    await e.fix(10);
    await e.aim(tC, tF);
    const { card } = await e.cast(caster, "phantom-pain");
    t.ok(!!card, "карточка заклинания");
    t.ok(await waitFor(() => Object.keys(e.results(card)).length, 12000), "испытание брошено (авто NPC)");
    const d = Object.values(e.results(card))[0];
    t.ok(d === "failure", `исход: провал (${d})`);
    await e.applyAll(card); await wait(1500);
    const a = e.T(tF).actor, pers = a.itemTypes.condition.find((c) => c.slug === "persistent-damage")?.system.persistent;
    t.ok(a.getCondition("sickened")?.value === 1, `тошнота 1 (${e.states(a)})`);
    t.ok(pers?.damageType === "mental" && /1d4/.test(pers?.formula ?? ""), `продолжительный 1d4 ментальный (${JSON.stringify(pers)})`);
  });

  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };

  sc("tangle-vine", "Опутывающая лиана: атака заклинанием, «Применить», шёпот Освобождения с СЛ заклинаний, успех снимает", async (e, t) => {
    openChat();
    const caster = await e.caster("друид", ["tangle-vine"]), foe = await e.foe("цель");
    const tC = await e.tok(caster, 500, 500, 1), tF = await e.tok(foe, 700, 500, -1);
    await wait(700);
    await e.rig(caster, "spell-attack-roll", 30);
    await e.fix(10);
    await e.aim(tC, tF);
    const { card, sp } = await e.cast(caster, "tangle-vine");
    t.ok(!!card, "карточка заклинания");   // check.roll = system: снимок use ложится на бросок атаки (wantsSnapshot), не на карточку
    const t1 = e.since();
    await bound("атака заклинанием (rollAttack)", sp.rollAttack(SHIFT()));
    const att = await waitFor(() => e.msgs(t1).find((m) => /attack-roll/.test(m.flags?.pf2e?.context?.type ?? "")), 8000);
    t.ok(!!att, "атака заклинанием брошена");
    t.ok(await waitFor(() => e.use(att), 6000), "снимок use на броске атаки");
    await waitFor(() => e.block(att)?.querySelector("button[data-action^=apply]"), 6000);
    await e.applyAll(att); await wait(1500);
    t.ok(e.has(e.T(tF).actor, "spell-effect-tangle-vine"), `эффект лианы на цели (${e.states(e.T(tF).actor)})`);
    const w = await waitFor(() => game.messages.contents.findLast((m) => m.flags?.[MOD]?.escape?.actor === e.T(tF).actor.uuid), 6000);
    t.ok(!!w, "шёпот Освобождения");
    t.ok(w?.flags?.[MOD]?.escape?.dc === spellDC(sp), `СЛ освобождения = СЛ заклинаний (${w?.flags?.[MOD]?.escape?.dc} / ${spellDC(sp)})`);
    await e.rig(e.T(tF).actor, "skill-check", 30);
    const btn = await waitFor(() => (e.dom(w)?.querySelector("[data-af-escape=acrobatics]") ?? e.dom(w)?.querySelector("[data-af-escape]")), 6000);
    t.ok(!!btn, "кнопка Освобождения в шёпоте");
    btn?.click();
    t.ok(await waitFor(() => !e.has(e.T(tF).actor, "spell-effect-tangle-vine"), 12000), "успешное Освобождение сняло эффект");
  });

  sc("grapple-escape", "Захват -> Освобождение: шёпот жертве, успех снимает захват", async (e, t) => {
    openChat();
    const hero = await e.pc("герой"), foe = await e.foe("цель");
    const tH = await e.tok(hero, 500, 500, 1), tF = await e.tok(foe, 600, 500, -1);
    await wait(700);
    const fa = e.T(tF).actor, dc = fa.saves.fortitude.dc.value;
    await e.rig(hero, "athletics", dc - 10 - hero.skills.athletics.mod);   // d20=10 -> итог = СЛ: успех
    await e.fix(10);
    await e.aim(tH, tF);
    const t0 = e.since();
    await game.pf2e.actions.get("grapple").use({ actors: [hero], multipleAttackPenalty: 0 });
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.options?.includes("action:grapple")), 8000);
    t.ok(!!m, "бросок Захвата");
    await waitFor(() => e.block(m)?.querySelector("button[data-action^=apply]"), 6000);
    await e.applyAll(m);
    t.ok(await waitFor(() => e.T(tF).actor.getCondition("grabbed"), 6000), `цель схвачена (${e.states(e.T(tF).actor)}; исход ${m?.flags?.pf2e?.context?.outcome})`);
    const w = await waitFor(() => game.messages.contents.findLast((x) => x.flags?.[MOD]?.escape?.actor === e.T(tF).actor.uuid), 6000);
    t.ok(!!w, "шёпот Освобождения жертве");
    await e.rig(e.T(tF).actor, "skill-check", 30);
    const btn = await waitFor(() => e.dom(w)?.querySelector("[data-af-escape]"), 6000);
    t.ok(!!btn, "кнопка Освобождения");
    btn?.click();
    t.ok(await waitFor(() => !e.T(tF).actor.getCondition("grabbed"), 12000), "захват снят");
  });

  sc("flanking", "Тиски: два союзника по бокам -> off-guard и self:flanking; у NPC с 0 ПЗ тисков нет", async (e, t) => {
    const a = await e.pc("атакующий", [held(await equip("shortsword"))]);
    const b = await e.foe("напарник", { system: { details: { alliance: "party" } } });
    const foe = await e.foe("цель");
    const tA = await e.tok(a, 900, 1000, 1), tB = await e.tok(b, 1100, 1000, 1), tF = await e.tok(foe, 1000, 1000, -1);
    await wait(800);
    const opt = async () => (await e.hit(tA, tF))?.flags?.pf2e?.context?.options ?? [];
    let o = await opt();
    t.ok(o.includes("self:flanking"), "self:flanking в контексте (напарник жив)");
    t.ok(o.includes("target:condition:off-guard"), "target:condition:off-guard в контексте");
    await e.T(tB).actor.update({ "system.attributes.hp.value": 0 }); await wait(1000);
    o = await opt();
    t.ok(!o.includes("self:flanking"), "напарник NPC с 0 ПЗ: тисков нет");
  });

  sc("surprise-attack", "Внезапная атака: инициатива Обманом -> эффект, off-guard по не ходившим, снятие по ходам", async (e, t) => {
    const sur = await import(`/modules/${MOD}/scripts/builtin/surprise-attack.mjs`);
    const rogue = await e.pc("плут", [held(await equip("shortsword")), await feat("surprise-attack")]);
    const f1 = await e.foe("быстрый"), f2 = await e.foe("медленный");
    const tR = await e.tok(rogue, 500, 500, 1), t1 = await e.tok(f1, 700, 500, -1), t2 = await e.tok(f2, 700, 700, -1);
    await wait(700);
    const c = await e.combat([tR, t1, t2], [null, null, null]);
    await rogue.update({ "system.initiative.statistic": "deception" }); await wait(300);
    await e.fix(10);
    await bound("инициатива (initiative.roll)", rogue.initiative.roll({ event: SHIFT() }));
    const eff = () => e.metaEffect(rogue, "surprise-attack");
    t.ok(await waitFor(eff, 8000), "эффект Внезапной атаки после инициативы Обманом");
    const sigs = () => sur.sigsOf(eff()?.system.rules ?? []);
    t.ok(sigs().length === 2, `метки на двух существ (${sigs().length})`);
    const cmb = (tok) => c.combatants.find((x) => x.tokenId === tok.id);
    await c.setInitiative(cmb(t1).id, 100); await c.setInitiative(cmb(tR).id, 50); await c.setInitiative(cmb(t2).id, -5);
    const offGuard = async (tok) => (await e.hit(tR, tok))?.flags?.pf2e?.context?.options?.includes("target:condition:off-guard");
    t.ok(await offGuard(t2), "до начала боя: off-guard по не ходившему");
    await c.startCombat();   // ход быстрого
    t.ok(await waitFor(() => sigs().length === 1, 8000), "ход быстрого: его метка снята");
    t.ok(!(await offGuard(t1)), "ходивший не off-guard");
    t.ok(await offGuard(t2), "не ходивший по-прежнему off-guard");
    await c.nextTurn(); await wait(800); await c.nextTurn();   // плут -> медленный
    t.ok(await waitFor(() => !eff(), 8000), "метки кончились -> эффект снят");
  });

  const shapeFeat = async (e, actor, slug) => {
    const it = actor.items.find((i) => i.slug === slug);
    if (!(await waitFor(() => it.flags?.[MOD]?.spellshape, 6000))) throw new Error(`${slug}: миграция не убрала переключатель (флаг spellshape не записан)`);
    const t0 = e.since();
    await it.toMessage(undefined, { create: true });
    const eff = await waitFor(() => e.metaEffect(actor, "spellshape"), 8000);
    return { it, eff, t0 };
  };
  const areaOf = (e, card) => Number((e.dom(card)?.querySelector("[data-action=spell-template]")?.textContent ?? "").match(/\d+/)?.[0]) || null;

  sc("metamagic", "Метамагия: Обширное -> конус 20, «(потрачена)» после сотворения, снятие при следующем", async (e, t) => {
    const caster = await e.caster("маг", ["breathe-fire"], { items: [await feat("widen-spell")] });
    const foe = await e.foe("цель");
    const tC = await e.tok(caster, 500, 500, 1), tF = await e.tok(foe, 700, 500, -1);
    await wait(700);
    openChat();
    await e.aim(tC, tF);
    const base = (await e.cast(caster, "breathe-fire")).card;
    const a0 = await waitFor(() => areaOf(e, base), 5000);
    t.ok(a0 === 15, `без метамагии конус 15 (${a0})`);
    const { eff } = await shapeFeat(e, caster, "widen-spell");
    t.ok(!!eff, "эффект метамагии на заклинателе");
    const { card } = await e.cast(caster, "breathe-fire");
    const a1 = await waitFor(() => areaOf(e, card), 5000);
    t.ok(a1 === 20, `с Обширным конус 20 (${a1})`);
    t.ok(await waitFor(() => e.metaEffect(caster, "spellshape")?.flags?.[MOD]?.spentBy === card.id, 6000), "эффект помечен «потрачена» этим сообщением");
    await e.cast(caster, "breathe-fire");
    t.ok(await waitFor(() => !e.metaEffect(caster, "spellshape"), 8000), "следующее сотворение сняло эффект");
  });

  const runicOn = (actor) => actor.itemTypes.effect.some((i) => i._stats?.compendiumSource === "Compendium.pf2e.spell-effects.Item.GnWkI3T3LYRlm3X8");
  const rangeSetup = async (e, items = []) => {
    const caster = await e.caster("маг", ["runic-weapon"], { items }), ally = await e.pc("союзник", [held(await equip("shortsword"))]);   // оружие — цель ChoiceSet эффекта
    const tC = await e.tok(caster, 500, 500, 1), tA = await e.tok(ally, 700, 500, 1);   // 200 px = 10 фт
    await wait(700);
    openChat();
    await e.aim(tC, tA);
    return { caster, tC, tA };
  };

  sc("range", "Дальность: Рунное оружие на 10 фт без метамагии -> «вне дальности», кнопки «Применить» нет", async (e, t) => {
    const { caster, tA } = await rangeSetup(e);
    const { card } = await e.cast(caster, "runic-weapon");
    t.ok(!!card, "карточка сотворения");
    const far = e.use(card)?.targets?.some((x) => x.far);
    t.ok(!!far, "цель помечена far");
    await waitFor(() => /вне дальности|out of range/i.test(e.block(card)?.textContent ?? ""), 6000);
    t.ok(/вне дальности|out of range/i.test(e.block(card)?.textContent ?? ""), "в блоке «вне дальности»");
    t.ok(!e.block(card)?.querySelector("button[data-action^=apply]"), "кнопки «Применить» нет");
    await wait(4000);   // как дольше всего ждёт появления range-reach: иначе «эффекта нет» проверяется до автоприменения
    t.ok(!runicOn(e.T(tA).actor), "эффекта на союзнике нет");
  });

  sc("range-reach", "Дальнее заклинание + Рунное оружие на 10 фт -> в дальности", async (e, t) => {
    const { caster, tA } = await rangeSetup(e, [await feat("reach-spell")]);
    const { eff } = await shapeFeat(e, caster, "reach-spell");
    t.ok(!!eff, "эффект метамагии «Дальнее заклинание»");
    const { card } = await e.cast(caster, "runic-weapon");
    t.ok(!!card, "карточка сотворения");
    t.ok(!e.use(card)?.targets?.some((x) => x.far), "цель не far");
    t.ok(!/вне дальности|out of range/i.test(e.block(card)?.textContent ?? ""), "«вне дальности» нет");
    // mode.effect = auto — эффект вешает модуль, кнопки нет; button — кнопка «Применить»
    t.ok(await waitFor(() => runicOn(e.T(tA).actor) || e.block(card)?.querySelector("button[data-action^=apply]"), 6000), "эффект на союзнике или кнопка «Применить»");
  });

  sc("tentacles", "Руки-щупальца: эффект, досягаемость безоружных Ударов 10 фт", async (e, t) => {
    const caster = await e.caster("маг", [], { focus: ["tentacular-limbs"] });
    const tC = await e.tok(caster, 500, 500, 1);
    await wait(700);
    await e.aim(tC);
    await e.cast(caster, "tentacular-limbs");
    t.ok(await waitFor(() => e.metaEffect(caster, "tentacular-limbs"), 8000), "эффект «Руки-щупальца»");
    await wait(800);
    const fist = caster.system.actions.find((s) => s.item?.category === "unarmed" || s.slug === "fist");
    t.ok(!!fist && (fist.item.traits?.has?.("reach") || fist.item.system.traits.value.includes("reach")), "у безоружного Удара признак reach (10 фт)");
  });

  sc("reaction-hint", "Ответное действие: выстрел по персонажу с Ловким уклонением -> подсказка при любом исходе, одна на способность", async (e, t) => {
    const dodge = await feat("nimble-dodge");
    const pc = await e.pc("плут", [dodge, foundry.utils.deepClone(dodge)]);   // дубль способности: подсказка всё равно одна
    const foe = await e.foe("стрелок");
    const tP = await e.tok(pc, 500, 500, 1), tF = await e.tok(foe, 700, 500, -1);
    await wait(700);
    const hints = (m) => game.messages.filter((x) => x.flags?.[MOD]?.reaction?.attack === m.id);
    for (const [d20, name] of [[1, "промах"], [20, "попадание"]]) {
      await e.fix(d20);
      const att = await e.hit(tF, tP, e.strike(e.T(tF).actor));
      t.ok(!!att, `${name}: атака брошена`);
      await waitFor(() => hints(att).length, 6000); await wait(1500);
      t.ok(hints(att).length === 1, `${name} (${att?.flags?.pf2e?.context?.outcome}): подсказок ${hints(att).length}, ожидалась 1`);
    }
  });

  sc("shield-block", "Блок щитом: Щит + атака -> кнопка блока снижает урон", async (e, t) => {
    const pc = await e.caster("маг", ["shield"]), foe = await e.foe("нападающий");
    const tP = await e.tok(pc, 500, 500, 1), tF = await e.tok(foe, 600, 500, -1);
    await wait(700);
    openChat();
    await e.aim(tP, tP);
    await e.cast(pc, "shield");
    t.ok(await waitFor(() => pc.attributes.shield?.raised, 8000), "щит поднят");
    await e.aim(tF, tP);
    const strike = e.strike(e.T(tF).actor);
    const t0 = e.since();
    await bound("бросок урона (strike.damage)", strike.damage({ event: SHIFT() }));
    const dmg = await waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "damage-roll"), 8000);
    t.ok(!!dmg, "карточка урона");
    const w = await waitFor(() => game.messages.contents.findLast((m) => m.flags?.[MOD]?.shieldBlock?.message === dmg?.id), 8000);
    t.ok(!!w, "шёпот с кнопкой блока");
    const btn = await waitFor(() => e.dom(w)?.querySelector("[data-af-shield-block]"), 6000);
    t.ok(!!btn, "кнопка блока в DOM");
    const hp0 = pc.hitPoints.value, hardness = pc.attributes.shield?.hardness ?? 0;   // до клика: после Блока щитом эффект Щита снимается
    btn?.click();
    t.ok(await waitFor(() => game.messages.get(w.id)?.flags?.[MOD]?.shieldBlock?.used, 8000), "блок использован");
    const lost = hp0 - pc.hitPoints.value, total = dmg.rolls[0].total;
    t.ok(lost === Math.max(0, total - hardness), `потеряно ${lost}, ожидалось max(0, ${total} − твёрдость ${hardness})`);
  });

  const turnSetup = async (e, cond) => {
    openChat();
    const pc = await e.pc("герой"), foe = await e.foe("враг");
    const tP = await e.tok(pc, 500, 500, 1), tF = await e.tok(foe, 700, 500, -1);
    await wait(700);
    await pc.increaseCondition(cond, cond === "frightened" ? { value: 2 } : {});
    return { pc, c: await e.combat([tP, tF], [20, 10]) };
  };
  sc("frightened", "Испуг −1 в конце хода", async (e, t) => {
    const { pc, c } = await turnSetup(e, "frightened");
    await c.startCombat(); await wait(1000);
    t.ok(pc.getCondition("frightened")?.value === 2, "в начале хода испуг 2");
    await c.nextTurn();
    t.ok(await waitFor(() => pc.getCondition("frightened")?.value === 1, 8000), `в конце хода испуг 1 (${pc.getCondition("frightened")?.value})`);
  });

  sc("sickened", "Шёпот тошноты в начале хода с кнопкой; успех Стойкости снимает", async (e, t) => {
    const { pc, c } = await turnSetup(e, "sickened");
    await e.rig(pc, "fortitude", 30);
    await e.fix(10);
    await c.startCombat();
    const w = await waitFor(() => game.messages.contents.findLast((m) => m.flags?.[MOD]?.retch?.actor === pc.uuid), 10000);
    t.ok(!!w, "шёпот тошноты");
    const btn = await waitFor(() => e.dom(w)?.querySelector("[data-af-retch]"), 6000);
    t.ok(!!btn, "кнопка «Избавиться»");
    const dcInput = e.dom(w)?.querySelector("[data-af-retch-dc]");
    if (dcInput) dcInput.value = "15";
    btn?.click();
    t.ok(await waitFor(() => !pc.getCondition("sickened"), 12000), "успех Стойкости снял тошноту");
  });

  const TAH = "token-action-hud-core";
  sc("tah-reload", "Token Action HUD: кнопка «Перезарядить» у незаряженного арбалета", async (e, t) => {
    if (!modOn(TAH)) throw new Skip("Token Action HUD не активен");
    const pc = await e.pc("стрелок", [held(await equip("crossbow"), 2), { ...(await equip("bolts")), system: { ...(await equip("bolts")).system, quantity: 10 } }]);
    const tP = await e.tok(pc, 500, 500, 1);
    await wait(700);
    e.T(tP).object.control({ releaseOthers: true });
    Hooks.callAll("forceUpdateTokenActionHud");
    const btn = await waitFor(() => document.querySelector("[data-paf-reload] button"), 10000);
    t.ok(!!btn, "кнопка «Перезарядить» в HUD");
    btn?.click();
    t.ok(await waitFor(() => !document.querySelector("[data-paf-reload]"), 10000), "после перезарядки кнопка исчезла (оружие заряжено)");
  });

  sc("tah-cover", "Token Action HUD: укрытие переключается кнопкой", async (e, t) => {
    if (!modOn(TAH)) throw new Skip("Token Action HUD не активен");
    const pc = await e.pc("герой");
    const tP = await e.tok(pc, 500, 500, 1);
    await wait(700);
    e.T(tP).object.control({ releaseOthers: true });
    Hooks.callAll("forceUpdateTokenActionHud");
    const btn = await waitFor(() => document.querySelector("button[value^=pafCover]"), 10000);
    t.ok(!!btn, "кнопка укрытия в HUD");
    const levels = [...document.querySelectorAll("button[value^=pafCover]")].map((b) => b.value.split("|")[1]);
    t.ok(["lesser", "standard", "greater"].every((l) => levels.includes(l)), `три уровня укрытия в HUD: ${levels}`);
    const ac0 = pc.armorClass.value;
    document.querySelector('button[value="pafCover|lesser"]')?.click();
    t.ok(await waitFor(() => pc.itemTypes.effect.some((x) => /cover/.test(x.slug ?? "")), 8000), `эффект укрытия на актёре (${e.states(pc)})`);
    t.ok(await waitFor(() => pc.armorClass.value === ac0 + 1, 4000), `частичное укрытие: КБ ${ac0} → ${pc.armorClass.value} (ждали +1)`);
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами (Toolbelt проверяется отдельно)
    for (const s of pick) {
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0;
      try {
        e = await newEnv(s.id); cur = e;
        const run = s.run(e, t); run.catch(() => {});   // после таймаута сценарий упадёт на live() — не «Uncaught»
        let timer;
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут 150 с; ${hangInfo(e)}`)), 150000); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} suite | ${s.id}`, err); }
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
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  const table = rows.map((r) => `${r.id.padEnd(16)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afSuiteResult = result;
  return result;
}
