async () => {
  // Живые сценарии weapon-poison (шаг `coat`, носитель яда на оружии): plan-weapon-poison.md §7 и §10. Вкладка активного ГМа-лидера, ничего вручную не нажимать.
  // Приёмы — как в strike-gate.js. Яд — расходник «AF яд …» с правилом coat во флаге (validateRule), использование — consume() (сообщение use модуля), не каталог.
  // Окно выбора оружия (askChoice) отвечает харнесс: e.pick = подстрока/имя варианта (null — закрыть окно = отмена).
  // Параметры (перед запуском): window.__afWeaponPoison = { only: ["apply", ...], skip: [...], cleanOnly: true }
  // Настройки мира mode.effect / mode.challenge / mode.apply на время прогона = auto и возвращаются в конце; сценарии режимов меняют их сами и возвращают.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afWeaponPoisonResult. В detail — «инфо» (опции Ударов, origin урона и т.п.) для разбора.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afWeaponPoison ?? {}) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000, step = 150) => {
    const end = Date.now() + ms, env = cur;
    if (env) env.step = `ждём: ${String(fn).replace(/\s+/g, " ").slice(0, 100)}`;
    while (Date.now() < end) { if (!env || env.dead) return null; try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(step); }
    return null;
  };
  class Skip extends Error {}
  const bound = (label, p, ms = 30000) => {
    const env = cur; if (env) env.step = label;
    let tm;
    return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`завис шаг «${label}» (>${ms / 1000} с)`)), ms); })]).finally(() => clearTimeout(tm));
  };
  const hangInfo = (e) => `последний шаг: ${e.step}; закрыто окон бросков: [${e.windows}]; окна модуля: [${e.dialogs}]; открыто: [${[...foundry.applications.instances.values(), ...Object.values(ui.windows ?? {})].map((a) => a.constructor.name).join(", ")}]`;
  let cur = null;
  const DEG = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const deg = (v) => (typeof v === "number" ? DEG[v] : v);
  const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });
  const api = () => game.modules.get(MOD).api;
  const imp = (f) => import(`/modules/${MOD}/scripts/${f}`);
  const setting = (k) => game.settings.get(MOD, k);
  const short = (v, n = 300) => String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, n);

  // ---------- уборка (аварийная: window.__afWeaponPoison = {cleanOnly: true}) ----------
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name) || test(game.scenes.get(x.sceneId)?.name)))) await c.delete().catch(() => {});
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const sceneIds = new Set(scenes.map((s) => s.id));
    const msgIds = new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene) || test(m.speaker?.alias)).map((m) => m.id)]);
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
  const MODES = ["mode.effect", "mode.challenge", "mode.apply"], modePrev = Object.fromEntries(MODES.map((k) => [k, setting(k)]));
  const setMode = (k, v) => game.settings.set(MOD, k, v);
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };

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
  const held = (d, name, hands = 1) => { d.name = name; d.system.equipped = { carryType: "held", handsHeld: hands }; return d; };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";
  const POISON_DC = 22;   // гоблин при d20=10: итог 10+Стойкость — провал (не крит.), если Стойкость в 3..11

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null, pick: null, created: [], n: 0 };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    const hookItem = Hooks.on("createItem", (it) => { if (it.type === "effect" && it.flags?.[MOD]?.coat) e.created.push({ weapon: it.flags[MOD].coat.weapon, armed: it.flags[MOD].coat.armed ?? null, poison: it.flags[MOD].coat.poison }); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {   // окно выбора оружия: отвечаем по e.pick, иначе закрываем (отмена)
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          const sel = el.querySelector("select[name=choice]"), labels = sel ? [...sel.options].map((o) => o.textContent.trim()) : [];
          e.dialogs.push(`${el.querySelector(".window-title")?.textContent?.trim() ?? el.id}: ${labels.join(" / ")}`);
          const o = sel && e.pick ? [...sel.options].find((x) => x.textContent.trim() === e.pick) ?? [...sel.options].find((x) => x.textContent.includes(e.pick)) : null;
          if (o) { sel.value = o.value; el.querySelector("button[data-action=ok]")?.click(); } else foundry.applications.instances.get(el.id)?.close();
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
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: все проверки — на этом актёре
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
      Hooks.off("createChatMessage", hook); Hooks.off("createItem", hookItem);
      try { await e.fix(null); } catch { /* ok */ }
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      document.querySelectorAll(".paf-dialog").forEach((el) => foundry.applications.instances.get(el.id)?.close());
      const left = await sweep([...e.tracked]);
      await viewCombat(prevCombat);
      return left;
    };
    return e;
  };

  // ---------- общие приёмы сценариев ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const STAGE = (c) => ({ duration: { value: 1, unit: "rounds" }, conditions: c });
  const DEF = (name) => ({ name, kind: "poison", save: { statistic: "fortitude" }, maxDuration: { value: 6, unit: "rounds" },
    stages: [STAGE([{ slug: "sickened", value: 1 }]), STAGE([{ slug: "clumsy", value: 1 }]), { conditions: [{ slug: "slowed", value: 1 }] }] });
  /** Правило расходника-яда, как оно будет в бою: onUse.apply[0].coat.challenge (недуг на провал и крит. провал). */
  const POISON = (name, dc = POISON_DC, duration = null) => ({ v: 1, label: name, onUse: { targets: "self", apply: [{ to: "self", coat: { weapon: "choose", ...(duration && { duration }),
    challenge: { statistic: "fortitude", dc: { value: dc }, basic: false, rollerRole: "target", traits: ["poison", "injury"],
      byDegree: { failure: [{ to: "target", affliction: { stage: 1, def: DEF(name) } }], criticalFailure: [{ to: "target", affliction: { stage: 2, def: DEF(name) } }] } } } }] } });
  const SWORD = "AF меч", CLUB = "AF дубинка", RAPIER = "AF рапира", XBOW = "AF арбалет";
  const W = (a, name) => [...a.itemTypes.weapon, ...a.itemTypes.melee].find((w) => w.name === name);
  const sp = (a, w) => a.system.actions.find((s) => s.item?.id === w.id);
  const coatsOf = (a) => a.itemTypes.effect.filter((i) => i.flags?.[MOD]?.coat);
  const carrier = (a, w) => coatsOf(a).find((i) => i.flags[MOD].coat.weapon === w.id) ?? null;
  const armedOf = (c) => c?.flags?.[MOD]?.coat?.armed ?? null;
  const afflOf = (a) => a.items.find((i) => i.flags?.[MOD]?.meta?.affliction) ?? null;
  const hosts = (e, t0) => e.msgs(t0).filter((m) => m.flags?.[MOD]?.use?.state?.event);
  const hit = (m) => ["success", "criticalSuccess"].includes(m?.flags?.pf2e?.context?.outcome);
  const outcome = (m) => m?.flags?.pf2e?.context?.outcome;
  const heal = (a) => a.update({ "system.attributes.hp.value": a.hitPoints.max });

  /** PC «владелец» с тремя оружиями (меч — рубящее, дубинка — дробящее, рапира — колющее) и цель-гоблин. */
  const arena = async (e, { ammo = false, vicPc = false } = {}) => {
    openChat();
    const items = [held(await equip("longsword"), SWORD), held(await equip("club"), CLUB), held(await equip("rapier"), RAPIER)];
    if (ammo) { items.push(held(await equip("crossbow"), XBOW, 2)); const b = await equip("bolts"); b.system.quantity = 20; items.push(b); }
    const pc = await e.pc("владелец", items), vic = vicPc ? await e.pc("жертва") : await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, vicPc ? 1 : -1);
    await wait(700);
    await e.A(tP).update({ "system.resources.heroPoints.value": 2 });
    return { tP, tV, pc: e.A(tP), vic: e.A(tV) };
  };
  /** Расходник-яд у актёра. */
  const dose = async (e, a, name, { qty = 3, dc = POISON_DC, duration = null } = {}) => {
    const rule = POISON(name, dc, duration), v = api().validateRule(rule);
    if (!v.ok) throw new Error(`правило яда невалидно: ${v.errors.map(String).join("; ")}`);
    const [it] = await e.give(a, { type: "consumable", name, system: { slug: `af-poison-${++e.n}-${e.id}`, quantity: qty, category: "poison", traits: { value: ["poison", "injury"] }, uses: { value: 1, max: 1, autoDestroy: true } }, flags: { [MOD]: { rule } } });
    return it;
  };
  /** Использовать яд (consume): окно выбора отвечает харнесс по e.pick. -> сообщение use. */
  const usePoison = async (e, p, pick = e.pick) => {
    e.pick = pick;
    const t0 = e.since();
    await bound("consume", p.consume());
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.[MOD]?.use && x.flags?.pf2e?.origin?.type === "consumable"), 10000);
    if (!m) throw new Error(`у сообщения consume «${p.name}» нет снимка use (правило не найдено или модуль не слушает)`);
    if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
    await waitFor(() => e.use(m)?.state?.done, 15000);
    await wait(500);
    return game.messages.get(m.id);
  };
  /** Подкрутка бонуса атаки оружия: при d20=10 итог = КЗ+2 (попал), 19 — крит, 2 — промах, 1 — крит. промах (натуральная 1 ухудшает). Эффект с предикатом item:id — только это оружие. */
  const rigged = new Set();
  const rig = async (e, att, def, w) => {
    const a = e.A(att), ac = e.A(def).attributes.ac.value, key = `${a.uuid}|${w.id}|${ac}`;
    if (rigged.has(key)) return;
    for (const r of a.itemTypes.effect.filter((x) => x.slug === `af-rig-${w.id}`)) await r.delete();
    await wait(150);
    const s = sp(a, w);
    if (!s || !Number.isFinite(s.totalModifier)) throw new Skip(`у Удара «${w.name}» нет totalModifier (pf2e изменил API)`);
    await e.give(a, { type: "effect", name: "AF rig", system: { slug: `af-rig-${w.id}`, rules: [{ key: "FlatModifier", selector: "attack-roll", value: ac + 2 - 10 - s.totalModifier, predicate: [`item:id:${w.id}`] }] } });
    rigged.add(key); await wait(150);
  };
  const swing = async (e, att, def, w, d20, { wait: pause = 2500 } = {}) => {
    await rig(e, att, def, w);
    await e.fix(d20); await e.aim(att, def);
    const t0 = e.since(), s = sp(e.A(att), w);
    if (!s) throw new Error(`у «${w.name}» нет Удара`);
    await bound(`бросок Удара ${w.name}`, s.variants[0].roll({ event: SHIFT() }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.type === "attack-roll"), 8000);
    if (!m) throw new Error("сообщение атаки не появилось");
    if (pause) await wait(pause);
    return m;
  };
  const rollDamage = async (e, att, def, w, crit = false) => {
    await e.aim(att, def);
    const t0 = e.since(), s = sp(e.A(att), w);
    await bound(`бросок урона ${w.name}`, crit ? s.critical({ event: SHIFT() }) : s.damage({ event: SHIFT() }));
    const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.type === "damage-roll"), 8000);
    if (!m) throw new Error("сообщение урона не появилось");
    return m;
  };
  /** Применить урон из сообщения к цели: кнопка чата pf2e (токен выделен), иначе applyDamage (info: «урон: applyDamage»). -> damage-taken | null (полный иммунитет/сопротивление: сообщения может не быть). */
  const applyDamage = async (e, def, m, { pause = 3000, heal: h = true } = {}) => {
    const v = e.A(def);
    if (h) await heal(v);
    e.T(def).object.control({ releaseOthers: true });
    await wait(300);
    const t0 = e.since();
    const btn = await waitFor(() => e.dom(m)?.querySelector("button[data-action=apply-damage]"), 3000);
    if (btn) btn.click();
    else { e.fallback = true; await bound("applyDamage", v.applyDamage({ damage: m.rolls[0], token: e.T(def), item: m.item, rollOptions: new Set(m.flags.pf2e.context?.options ?? []) })); }
    const taken = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.appliedDamage || x.flags?.pf2e?.context?.type === "damage-taken"), 6000);
    if (pause) await wait(pause);
    return taken;
  };
  /** Удар + (по желанию) урон и его применение. */
  const flow = async (e, att, def, w, d20, { dmg = false, crit = false, apply = true, pause } = {}) => {
    const atk = await swing(e, att, def, w, d20), r = { atk };
    if (dmg) { r.dmg = await rollDamage(e, att, def, w, crit); if (apply) r.taken = await applyDamage(e, def, r.dmg, { pause }); }
    return r;
  };
  const reroll = async (e, m, d20) => {
    if (!game.pf2e?.Check?.rerollFromMessage) throw new Skip("нет game.pf2e.Check.rerollFromMessage");
    await e.fix(d20);
    const t0 = e.since();
    await bound("переброс за очко героя", game.pf2e.Check.rerollFromMessage(m, { heroPoint: true }));
    const n = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.type === "attack-roll"), 8000);
    if (!n) throw new Error("переброшенное сообщение не появилось");
    await wait(2500);
    return n;
  };
  const optsOf = (m, re) => (m?.flags?.pf2e?.context?.options ?? []).filter((o) => re.test(o));
  const L = (k, d) => (d ? game.i18n.format(`PF2E_AUTOMATO.${k}`, d) : game.i18n.localize(`PF2E_AUTOMATO.${k}`));
  const whispers = (e, t0, key, d) => e.msgs(t0).filter((m) => String(m.content).includes(L(key, d)));
  /** Яд нанесён на оружие: общая часть (арена, яд, нанесение на меч). */
  const armedSword = async (e, { qty = 3, name = "AF яд A" } = {}) => {
    const x = await arena(e);
    x.sword = W(x.pc, SWORD); x.club = W(x.pc, CLUB); x.rapier = W(x.pc, RAPIER);
    x.p = await dose(e, x.pc, name, { qty });
    x.m = await usePoison(e, x.p, SWORD);
    return x;
  };

  // ---------- сценарии ----------
  sc("apply", "Нанесение: окно выбора (дубинка помечена), носитель на мече, срок «без срока», правило валидно; повтор кнопки той же карточки — ни окна, ни второго носителя", async (e, t) => {
    const x = await armedSword(e);
    t.ok(e.dialogs.length === 1, `окно выбора появилось один раз (${e.dialogs.length})`);
    t.info(`окно: ${e.dialogs[0]}`);
    t.ok(e.dialogs[0]?.includes(L("coat.noSP")), "у дубинки в окне пометка «не колющее и не рубящее»");
    const c = carrier(x.pc, x.sword);
    t.ok(c, "носитель на мече");
    t.ok(coatsOf(x.pc).length === 1, `носитель один (${coatsOf(x.pc).length})`);
    t.ok(c?.system.duration?.unit === "unlimited", `срок без ограничения (${c?.system.duration?.unit})`);
    t.ok(c?.flags[MOD].coat.ammo === false && c.flags[MOD].coat.challenge?.dc?.value === POISON_DC, `coat: ammo=${c?.flags[MOD].coat.ammo}, СЛ ${c?.flags[MOD].coat.challenge?.dc?.value}`);
    t.ok(c && api().validateRule(c.flags[MOD].rule).ok, "правило носителя проходит validateRule");
    t.ok(x.p.quantity === 2, `доза списана pf2e (3 -> ${x.p.quantity})`);
    const n = e.dialogs.length;
    await bound("runUse (повтор кнопки)", api().runUse(x.m.id)); await wait(1500);
    t.ok(coatsOf(x.pc).length === 1 && e.dialogs.length === n, `повтор: носитель один (${coatsOf(x.pc).length}), нового окна нет`);
    t.ok(x.p.quantity === 2, `повтор дозу не списал (${x.p.quantity})`);
  });

  const hitCase = (id, title, name, challenge) => sc(id, title, async (e, t) => {
    const x = await armedSword(e);
    const w = W(x.pc, name);
    // для другого оружия — вторая доза с другим выбором
    const p2 = name === SWORD ? null : await dose(e, x.pc, "AF яд B", { qty: 2 });
    if (p2) await usePoison(e, p2, name);
    const c = carrier(x.pc, w), t0 = e.since();
    t.ok(c, `носитель на «${name}»`);
    const { atk, taken } = await flow(e, x.tP, x.tV, w, 10, { dmg: true });
    t.ok(hit(atk), `Удар попал (${outcome(atk)})`);
    t.ok(!!taken, "урон применён (damage-taken есть)");
    t.info(`origin.actor урона: ${taken?.flags?.pf2e?.origin?.actor}; опции урона: ${short(optsOf(taken, /item|damage|origin/).slice(0, 8))}`);
    t.ok(!carrier(x.pc, w), "яд потрачен");
    const h = hosts(e, t0);
    t.ok(h.length === (challenge ? 1 : 0), `карточек испытания ${h.length}, ожидалось ${challenge ? 1 : 0}`);
    if (challenge) {
      const a = await waitFor(() => afflOf(x.vic), 6000);
      t.ok(!!a && a.system.badge?.value === 1, `недуг стадии 1 у цели (${a?.name}, стадия ${a?.system.badge?.value}; исход ${short(e.results(h[0]))})`);
    } else t.ok(!afflOf(x.vic), "недуга нет");
    await flow(e, x.tP, x.tV, w, 10, { dmg: true });   // следующий Удар яда не получает
    t.ok(hosts(e, t0).length === (challenge ? 1 : 0), "второй Удар новой карточки не дал");
  });
  hitCase("hit-slashing", "Попадание рубящим (меч) + урон применён -> одно испытание, яд потрачен, недуг ст. 1", SWORD, true);
  hitCase("hit-piercing", "Попадание колющим (рапира) + урон -> испытание", RAPIER, true);
  hitCase("bludgeon", "Дробящее оружие (дубинка): попадание и урон -> яд потрачен без испытания", CLUB, false);

  sc("miss", "Промах: яд остаётся (не взведён), испытания нет; следующее попадание его взводит", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    const { atk } = await flow(e, x.tP, x.tV, x.sword, 2);
    t.ok(!hit(atk) && outcome(atk) === "failure", `промах (${outcome(atk)})`);
    t.ok(carrier(x.pc, x.sword) && !armedOf(carrier(x.pc, x.sword)), "носитель на месте, не взведён");
    t.ok(hosts(e, t0).length === 0, "испытания нет");
    const r = await flow(e, x.tP, x.tV, x.sword, 10);
    t.ok(hit(r.atk) && armedOf(carrier(x.pc, x.sword))?.target === e.T(x.tV).uuid, `попадание взвело яд на цель (${short(armedOf(carrier(x.pc, x.sword)))})`);
  });

  sc("critfail", "Крит. промах: яд потрачен без испытания", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    const { atk } = await flow(e, x.tP, x.tV, x.sword, 1);
    t.ok(outcome(atk) === "criticalFailure", `крит. промах (${outcome(atk)})`);
    t.ok(!carrier(x.pc, x.sword), "яд потрачен");
    t.ok(hosts(e, t0).length === 0 && !afflOf(x.vic), "испытания и недуга нет");
  });

  /** Бой: владелец ходит первым. Конец его хода — nextTurn (pf2e.endTurn -> событие turn-end). */
  const duel = async (e, x) => {
    const c = await e.combat([x.tP, x.tV], [20, 10]);
    await c.startCombat(); await wait(1200);
    if (c.combatant?.actor?.id !== x.pc.id) throw new Error("первый ход не у владельца");
    return c;
  };
  const endTurn = async (c) => { await bound("nextTurn", c.nextTurn()); await wait(2500); };

  sc("no-damage", "Попал, урон не применён. Вне боя: следующий Удар (любой исход) тратит без испытания. В бою: следующие Удары яд не несут и не тратят, конец хода владельца — трата без испытания", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    const { atk } = await flow(e, x.tP, x.tV, x.sword, 10);
    t.ok(hit(atk) && armedOf(carrier(x.pc, x.sword)), "вне боя: взведён");
    t.ok(hosts(e, t0).length === 0, "до урона испытания нет");
    const r2 = await flow(e, x.tP, x.tV, x.sword, 2);
    t.ok(!hit(r2.atk) && !carrier(x.pc, x.sword), `вне боя: следующий Удар (${outcome(r2.atk)}) потратил яд`);
    t.ok(hosts(e, t0).length === 0, "без испытания");
    await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    t.ok(hosts(e, t0).length === 0 && !afflOf(x.vic), "дальнейшие Удары с уроном испытания не дают");
    // в бою
    const p = await dose(e, x.pc, "AF яд B", { qty: 2 }); await usePoison(e, p, SWORD);
    const c = await duel(e, x), t1 = e.since();
    const r3 = await flow(e, x.tP, x.tV, x.sword, 10);
    const tgt = armedOf(carrier(x.pc, x.sword))?.target;
    t.ok(hit(r3.atk) && !!tgt, `в бою: взведён (${short(tgt)})`);
    await flow(e, x.tP, x.tV, x.sword, 2); await flow(e, x.tP, x.tV, x.sword, 10);
    const cc = carrier(x.pc, x.sword);
    t.ok(!!cc && armedOf(cc)?.target === tgt, "в бою: следующие Удары (промах, попадание) яд не тратят и цель не меняют");
    await endTurn(c);
    t.ok(await waitFor(() => !carrier(x.pc, x.sword), 6000), "конец хода владельца потратил яд");
    t.ok(hosts(e, t1).length === 0 && !afflOf(x.vic), "без испытания");
  });

  const effect = (a, name, rules) => a.createEmbeddedDocuments("Item", [{ type: "effect", name, system: { slug: sluggify(name), rules } }]);
  const sluggify = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");

  sc("resist-zero", "Урон сведён к 0 сопротивлением и иммунитетом цели (pf2e сообщения не пишет, appliedDamage: null): яд ждёт конца хода владельца, трата без испытания", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    const c = await duel(e, x);
    await effect(x.vic, "AF resist", [{ key: "Resistance", type: "slashing", value: 50 }]); await wait(500);
    const r = await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    const hp0 = x.vic.hitPoints.value, max = x.vic.hitPoints.max;
    t.ok(hit(r.atk) && hp0 === max, `попал, ОЗ не убыли (${hp0}/${max})`);
    t.info(`сопротивление: damage-taken ${r.taken ? "есть" : "нет"}, appliedDamage ${r.taken?.flags?.pf2e?.appliedDamage ? "есть" : "нет"}`);
    t.ok(!!carrier(x.pc, x.sword) && hosts(e, t0).length === 0, "до конца хода яд взведён, испытания нет");
    await endTurn(c);
    t.ok(await waitFor(() => !carrier(x.pc, x.sword), 6000), "сопротивление: конец хода потратил яд");
    t.ok(hosts(e, t0).length === 0 && !afflOf(x.vic), "сопротивление: испытания и недуга нет");
    // иммунитет к рубящему (ход владельца снова в раунде 2)
    await endTurn(c);
    for (const i of x.vic.itemTypes.effect) await i.delete();
    await effect(x.vic, "AF imm slashing", [{ key: "Immunity", type: ["slashing"] }]); await wait(500);
    const p = await dose(e, x.pc, "AF яд B", { qty: 2 }); await usePoison(e, p, SWORD);
    const r2 = await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    t.info(`иммунитет: damage-taken ${r2.taken ? "есть" : "нет"}, appliedDamage ${r2.taken?.flags?.pf2e?.appliedDamage ? "есть" : "нет"}`);
    await endTurn(c); await endTurn(c);
    t.ok(await waitFor(() => !carrier(x.pc, x.sword), 6000), "иммунитет: яд потрачен концом хода");
    t.ok(hosts(e, t0).length === 0 && !afflOf(x.vic), "иммунитет: испытания и недуга нет");
  });

  sc("temp-hp", "Урон целиком ушёл во временные ОЗ: урон нанесён — испытание есть (по правилу)", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    await x.vic.update({ "system.attributes.hp.temp": 100 }); await wait(400);
    const r = await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    const ap = r.taken?.flags?.pf2e?.appliedDamage;
    t.info(`temp-HP: appliedDamage updates=${short(ap?.updates)}, hp цели ${x.vic.hitPoints.value}/${x.vic.hitPoints.max}, temp ${x.vic.attributes.hp.temp}`);
    t.ok(hit(r.atk) && !!ap, "попал, damage-taken с appliedDamage пришло");
    t.ok((ap?.updates ?? []).some((u) => u.path === "system.attributes.hp.temp"), "в updates — временные ОЗ");
    t.ok(!carrier(x.pc, x.sword), "яд потрачен");
    t.ok(hosts(e, t0).length === 1, `испытание запущено (${hosts(e, t0).length})`);
  });

  sc("two-strikes", "Два Удара до урона (разные цели): испытание одно — по урону первой цели; урон второй яд не трогает", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    const vic2 = await e.foe("цель 2"), tV2 = await e.tok(vic2, 600, 600, -1);
    await wait(700);
    const c = await duel(e, x);
    const a2 = e.A(tV2);
    const r1 = await flow(e, x.tP, x.tV, x.sword, 10);
    const tgt = armedOf(carrier(x.pc, x.sword))?.target;
    t.ok(hit(r1.atk) && tgt === e.T(x.tV).uuid, `первый Удар взвёл яд на цель 1 (${short(tgt)})`);
    const r2 = await flow(e, x.tP, tV2, x.sword, 10);
    t.ok(hit(r2.atk) && armedOf(carrier(x.pc, x.sword))?.target === tgt, "второй Удар яд не несёт и цель не меняет");
    const d2 = await rollDamage(e, x.tP, tV2, x.sword);
    await applyDamage(e, tV2, d2);
    t.ok(!!carrier(x.pc, x.sword) && hosts(e, t0).length === 0 && !afflOf(a2), "урон второй цели: яд цел, испытания нет");
    const d1 = await rollDamage(e, x.tP, x.tV, x.sword);
    await applyDamage(e, x.tV, d1);
    t.ok(!carrier(x.pc, x.sword) && hosts(e, t0).length === 1, `урон первой цели: яд потрачен, испытаний ${hosts(e, t0).length}`);
    t.ok(!!(await waitFor(() => afflOf(x.vic), 6000)) && !afflOf(a2), "недуг — у первой цели");
  });

  sc("known-limit", "KNOWN LIMIT (plan §3.5/§10): рубящее обнулено сопротивлением, огонь оружия прошёл — ожидается ложное испытание (текущее поведение)", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    await effect(x.vic, "AF resist", [{ key: "Resistance", type: "slashing", value: 50 }]);
    await effect(x.pc, "AF fire", [{ key: "FlatModifier", selector: "strike-damage", damageType: "fire", value: 5, predicate: [`item:id:${x.sword.id}`] }]);
    await wait(500);
    const r = await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    t.ok(!!r.taken?.flags?.pf2e?.appliedDamage, "ОЗ убыли (огонь прошёл)");
    t.ok(!carrier(x.pc, x.sword), "яд потрачен");
    t.ok(hosts(e, t0).length === 1, `known limit: испытание запущено (${hosts(e, t0).length}); это ложное срабатывание v1`);
    t.info(`разбивка урона: ${short(r.dmg?.rolls?.[0]?.formula)}; опции урона: ${short(optsOf(r.taken, /damage|item:damage/).slice(0, 8))}`);
  });

  sc("other-weapon", "Другое оружие того же актёра яд не тратит и не взводит", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    const r = await flow(e, x.tP, x.tV, x.club, 10, { dmg: true });
    t.ok(hit(r.atk) && !!r.taken, "дубинка попала, урон применён");
    const c = carrier(x.pc, x.sword);
    t.ok(c && !armedOf(c), "носитель на мече цел и не взведён");
    t.ok(hosts(e, t0).length === 0, "испытания нет");
  });

  sc("two-poisons", "Два оружия с разными ядами: каждый Удар — свой яд", async (e, t) => {
    const x = await armedSword(e, { name: "AF яд A" }), t0 = e.since();
    const pb = await dose(e, x.pc, "AF яд B", { qty: 2 }); await usePoison(e, pb, RAPIER);
    t.ok(carrier(x.pc, x.sword)?.flags[MOD].coat.poison === "AF яд A" && carrier(x.pc, x.rapier)?.flags[MOD].coat.poison === "AF яд B", "носители: меч — A, рапира — B");
    await flow(e, x.tP, x.tV, x.rapier, 10, { dmg: true });
    t.ok(!carrier(x.pc, x.rapier) && !!carrier(x.pc, x.sword) && !armedOf(carrier(x.pc, x.sword)), "рапира потратила B, меч с A не тронут");
    t.ok(await waitFor(() => afflOf(x.vic)?.name === "AF яд B", 6000), `недуг B (${afflOf(x.vic)?.name})`);
    // второй Удар за раз (множественный штраф/штраф «Тошноты» цели не учтены подкруткой) — d20 19: попадание с запасом, иначе промах давал ложный провал проверки
    const r2 = await flow(e, x.tP, x.tV, x.sword, 19, { dmg: true });
    t.ok(hit(r2.atk), `Удар мечом попал (${outcome(r2.atk)})`);
    t.ok(!carrier(x.pc, x.sword), "меч потратил A");
    t.ok(hosts(e, t0).length === 2, `всего испытаний ${hosts(e, t0).length}`);
    t.info(`меч: Удар ${outcome(r2.atk)}, взвод ${short(armedOf(carrier(x.pc, x.sword)))}, урон ${r2.taken ? "применён" : "нет"} (опции ${short(optsOf(r2.taken, /item:id|item:damage|damage-taken/).slice(0, 8))}), AC цели ${x.vic.attributes.ac.value}`);
  });

  sc("replace", "Замена: второй яд на тот же меч — заметка «заменён», старый снят, Удар даёт недуг нового", async (e, t) => {
    const x = await armedSword(e, { name: "AF яд A" }), t0 = e.since();
    const pb = await dose(e, x.pc, "AF яд B", { qty: 2 });
    await usePoison(e, pb, SWORD);
    t.ok(coatsOf(x.pc).length === 1 && carrier(x.pc, x.sword)?.flags[MOD].coat.poison === "AF яд B", `на мече один носитель — B (${coatsOf(x.pc).map((c) => c.flags[MOD].coat.poison)})`);
    t.ok(whispers(e, t0, "coat.replaced", { name: x.pc.name, old: "AF яд A", weapon: SWORD, poison: "AF яд B" }).length === 1, "шёпот «яд A заменён ядом B»");
    await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    t.ok(await waitFor(() => afflOf(x.vic)?.name === "AF яд B", 6000), `недуг нового яда (${afflOf(x.vic)?.name})`);
  });

  sc("replace-undo", "Откат карточки замены возвращает старый яд, снимает новый; откат карточки старого яда снимает пересозданный носитель", async (e, t) => {
    const x = await armedSword(e, { name: "AF яд A" }), mA = x.m;
    const pb = await dose(e, x.pc, "AF яд B", { qty: 2 });
    const mB = await usePoison(e, pb, SWORD);
    const { undoOps } = await imp("apply.mjs");
    await bound("undoOps замены", undoOps(game.messages.get(mB.id), "self"));
    t.ok(await waitFor(() => carrier(x.pc, x.sword)?.flags[MOD].coat.poison === "AF яд A", 6000), `вернулся яд A (${carrier(x.pc, x.sword)?.flags[MOD].coat.poison})`);
    t.ok(coatsOf(x.pc).length === 1, `носитель один (${coatsOf(x.pc).length})`);
    await bound("undoOps старого", undoOps(game.messages.get(mA.id), "self"));
    t.ok(await waitFor(() => coatsOf(x.pc).length === 0, 6000), "пересозданный носитель A снят откатом его карточки");
  });

  sc("undo-apply", "Откат карточки нанесения снимает носитель; «Дозапустить» ставит его снова", async (e, t) => {
    const x = await armedSword(e);
    const { undoOps } = await imp("apply.mjs");
    await bound("undoOps", undoOps(game.messages.get(x.m.id), "self"));
    t.ok(await waitFor(() => coatsOf(x.pc).length === 0, 6000), "носитель снят");
    await bound("runUse", api().runUse(x.m.id)); await wait(1500);
    t.ok(coatsOf(x.pc).length === 1, `после runUse носитель снова (${coatsOf(x.pc).length})`);
  });

  sc("undo-spend", "Откат траты (откат урона pf2e): носитель вернулся взведённым, карточка испытания и недуг сняты", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    const r = await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    t.ok(!carrier(x.pc, x.sword) && hosts(e, t0).length === 1, "яд потрачен, карточка испытания есть");
    await waitFor(() => afflOf(x.vic), 6000);
    const before = e.created.length, host = hosts(e, t0)[0];
    await r.taken.update({ "flags.pf2e.appliedDamage.isReverted": true });
    t.ok(await waitFor(() => carrier(x.pc, x.sword), 8000), "носитель восстановлен");
    t.ok(e.created.length > before && !!e.created.at(-1).armed?.target, `восстановлен взведённым (${short(e.created.at(-1)?.armed)})`);
    t.ok(await waitFor(() => !game.messages.has(host.id), 6000), "карточка испытания удалена");
    t.ok(await waitFor(() => !afflOf(x.vic), 6000), "недуг цели снят");
  });

  sc("reroll-arm", "Откат взвода: переброс попавшей атаки в промах — носитель не взведён, яд на месте", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    const { atk } = await flow(e, x.tP, x.tV, x.sword, 10);
    t.ok(armedOf(carrier(x.pc, x.sword)), "после попадания взведён");
    const n = await reroll(e, atk, 2);
    t.ok(!hit(n) && n.flags.pf2e.context.isReroll, `переброс — промах (${outcome(n)}, isReroll=${n.flags.pf2e.context.isReroll})`);
    const c = carrier(x.pc, x.sword);
    t.ok(c && !armedOf(c), `носитель на месте, не взведён (${short(armedOf(c))})`);
    t.ok(c && c.flags[MOD].rule.onEvent.length === 2, `правило — набор «не взведён» (${c?.flags[MOD].rule.onEvent.length} записи)`);
    t.ok(hosts(e, t0).length === 0, "испытания нет");
  });

  sc("reroll-spend", "Откат траты: крит. промах (трата) -> переброс в промах: носитель вернулся не взведённым; из взведённого: восстановлен со взводом", async (e, t) => {
    const x = await armedSword(e);
    const { atk } = await flow(e, x.tP, x.tV, x.sword, 1);
    t.ok(!carrier(x.pc, x.sword), "крит. промах потратил яд");
    const n = await reroll(e, atk, 2);
    const c = carrier(x.pc, x.sword);
    t.ok(!hit(n) && !!c && !armedOf(c), `после переброса носитель вернулся, не взведён (${outcome(n)}, ${short(armedOf(c))})`);
    // из взведённого состояния: Удар №2 снимает носитель (N), его переброс возвращает носитель со взводом (создание — хук createItem), затем N снимает снова
    await flow(e, x.tP, x.tV, x.sword, 10);
    t.ok(armedOf(carrier(x.pc, x.sword)), "взведён");
    const r2 = await flow(e, x.tP, x.tV, x.sword, 1);
    t.ok(!carrier(x.pc, x.sword), "следующий Удар потратил яд");
    const before = e.created.length;
    await reroll(e, r2.atk, 2);
    const back = e.created.slice(before).find((c) => c.weapon === x.sword.id);
    t.ok(!!back && !!back.armed?.target, `носитель восстановлен откатом траты со взводом (${short(back)})`);
  });

  sc("race", "Гонка: два урона применены без паузы -> одно испытание; две быстрые атаки -> один взвод; две карточки нанесения на одно оружие -> один носитель", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    await rig(e, x.tP, x.tV, x.sword); await e.fix(10); await e.aim(x.tP, x.tV);
    const s = sp(x.pc, x.sword);
    await bound("две атаки сразу", Promise.all([s.variants[0].roll({ event: SHIFT() }), s.variants[0].roll({ event: SHIFT() })]));
    await wait(3000);
    const c = carrier(x.pc, x.sword);
    t.ok(c && armedOf(c)?.target === e.T(x.tV).uuid, `носитель взведён (${short(armedOf(c))})`);
    t.ok(hosts(e, t0).length === 0, "испытания пока нет");
    const d1 = await rollDamage(e, x.tP, x.tV, x.sword), d2 = await rollDamage(e, x.tP, x.tV, x.sword);
    await heal(x.vic); e.T(x.tV).object.control({ releaseOthers: true }); await wait(300);
    const b1 = await waitFor(() => e.dom(d1)?.querySelector("button[data-action=apply-damage]"), 3000), b2 = e.dom(d2)?.querySelector("button[data-action=apply-damage]");
    if (b1 && b2) { b1.click(); b2.click(); }
    else { e.fallback = true; await bound("applyDamage x2", Promise.all([d1, d2].map((m) => x.vic.applyDamage({ damage: m.rolls[0], token: e.T(x.tV), item: m.item, rollOptions: new Set(m.flags.pf2e.context?.options ?? []) })))); }
    await wait(5000);
    t.ok(hosts(e, t0).length === 1, `одно испытание (${hosts(e, t0).length})`);
    t.ok(!carrier(x.pc, x.sword), "яд потрачен");
    // две карточки нанесения на одно оружие одновременно: носитель один
    const pa = await dose(e, x.pc, "AF яд C", { qty: 2 }), pb = await dose(e, x.pc, "AF яд D", { qty: 2 });
    e.pick = SWORD;
    await bound("два consume", Promise.all([pa.consume(), pb.consume()])); await wait(4000);
    t.ok(coatsOf(x.pc).length === 1, `два нанесения подряд: носитель один (${coatsOf(x.pc).length})`);
  });

  sc("mode-button", "effect = button: нанесение не создаёт носитель (шёпот needsAuto при нажатии «Применить»)", async (e, t) => {
    const x = await arena(e), t0 = e.since();
    const p = await dose(e, x.pc, "AF яд A");
    try {
      await setMode("mode.effect", "button");
      const m = await usePoison(e, p, SWORD);
      t.ok(coatsOf(x.pc).length === 0, "после consume носителя нет");
      await bound("applyUse", (await imp("use.mjs")).applyUse(m.id)); await wait(1500);
      t.ok(coatsOf(x.pc).length === 0, "после «Применить» носителя нет");
      t.ok(whispers(e, t0, "coat.needsAuto", { name: "AF яд A" }).length === 1, "шёпот needsAuto");
      t.ok(e.dialogs.length === 0, `окна выбора не было (${e.dialogs.length})`);
    } finally { await setMode("mode.effect", "auto"); }
  });

  sc("mode-challenge-off", "challenge = off: взвод, урон -> яд потрачен без карточки и недуга", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    try {
      await setMode("mode.challenge", "off");
      await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
      t.ok(!carrier(x.pc, x.sword), "яд потрачен");
      t.ok(hosts(e, t0).length === 0 && !afflOf(x.vic), "карточки и недуга нет");
    } finally { await setMode("mode.challenge", "auto"); }
  });

  sc("ammo", "Арбалет с боеприпасом: Удар любого исхода тратит яд, испытания нет (промах и попадание)", async (e, t) => {
    const { takesAmmo } = await imp("coat.mjs");
    const x = await arena(e, { ammo: true }), t0 = e.since();
    const xb = W(x.pc, XBOW);
    t.info(`арбалет: expend=${xb.system.expend}, ammo.builtIn=${xb.system.ammo?.builtIn}, takesAmmo=${takesAmmo(xb)}`);
    if (!takesAmmo(xb)) throw new Skip("арбалет не расходует боеприпасы по признаку модуля (expend)");
    const load = async () => { const b = x.pc.itemTypes.ammo.find((i) => i.slug === "bolts"); if (!(await xb.attach(b, { quantity: 1, stack: true }))) throw new Error("арбалет не зарядился"); await wait(400); };
    for (const [d20, label] of [[2, "промах"], [10, "попадание"]]) {
      const p = await dose(e, x.pc, `AF яд ${label}`, { qty: 2 });
      await usePoison(e, p, XBOW);
      const c = carrier(x.pc, xb);
      t.ok(c?.flags[MOD].coat.ammo === true, `${label}: носитель с ammo=true`);
      await load();
      const { atk } = await flow(e, x.tP, x.tV, xb, d20);
      t.ok(!carrier(x.pc, xb), `${label}: яд потрачен (${outcome(atk)})`);
      t.ok(!armedOf(c), `${label}: взвода нет`);
      t.info(`${label}: опции атаки ${short(optsOf(atk, /ammo|item:id|item:ammo|reload/).slice(0, 8))}`);
    }
    t.ok(hosts(e, t0).length === 0 && !afflOf(x.vic), "испытаний и недуга нет");
    const bow = await equip("shortbow"); t.info(`короткий лук: expend=${bow.system.expend}, takesAmmo=${takesAmmo({ system: bow.system })}`);
  });

  sc("cancel", "Закрытие окна выбора: расходник списан, носитель не создан; «Дозапустить» повторяет выбор", async (e, t) => {
    const x = await arena(e);
    const p = await dose(e, x.pc, "AF яд A", { qty: 3 });
    const m = await usePoison(e, p, null);
    t.ok(e.dialogs.length === 1, `окно было (${e.dialogs.length})`);
    t.ok(coatsOf(x.pc).length === 0, "носителя нет");
    t.ok(p.quantity === 2, `доза списана pf2e (${p.quantity})`);
    e.pick = SWORD;
    await bound("runUse", api().runUse(m.id)); await wait(2000);
    t.ok(e.dialogs.length === 2 && carrier(x.pc, W(x.pc, SWORD)), `после «Дозапустить»: окно снова (${e.dialogs.length}) и носитель на мече`);
    t.ok(p.quantity === 2, `доза второй раз не списана (${p.quantity})`);
  });

  sc("last-dose", "Последняя доза (pf2e удаляет расходник сразу): носитель и испытание идут из снимка use", async (e, t) => {
    const x = await arena(e), t0 = e.since();
    const p = await dose(e, x.pc, "AF яд A", { qty: 1 }), pid = p.id;
    await usePoison(e, p, SWORD);
    t.ok(!x.pc.items.has(pid), "расходник удалён");
    const sword = W(x.pc, SWORD);
    t.ok(!!carrier(x.pc, sword), "носитель создан");
    await flow(e, x.tP, x.tV, sword, 10, { dmg: true });
    t.ok(hosts(e, t0).length === 1 && !carrier(x.pc, sword), `испытание ${hosts(e, t0).length}, яд потрачен`);
  });

  sc("immune", "Цель иммунна к яду: яд потрачен, недуга нет", async (e, t) => {
    const x = await armedSword(e), t0 = e.since();
    await effect(x.vic, "AF imm poison", [{ key: "Immunity", type: ["poison"] }]); await wait(500);
    const r = await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    t.ok(!!r.taken && !carrier(x.pc, x.sword), "урон прошёл, яд потрачен");
    await wait(2000);
    t.ok(!afflOf(x.vic), "недуга нет");
    t.info(`карточек испытания: ${hosts(e, t0).length}${hosts(e, t0)[0] ? `, исход ${short(e.results(hosts(e, t0)[0]))}` : ""}`);
  });

  sc("envenom", "Envenom (PC): срок turn-end — носитель живёт до конца следующего хода владельца; после истечения Удар яда не взводит", async (e, t) => {
    const x = await arena(e);
    const sword = W(x.pc, SWORD);
    const c = await e.combat([x.tP, x.tV], [20, 10]);
    await c.startCombat(); await wait(1200);
    t.ok(c.combatant?.actor?.id === x.pc.id, "первый ход — у владельца");
    const p = await dose(e, x.pc, "AF Envenom", { qty: 2, duration: { value: 1, unit: "rounds", expiry: "turn-end" } });
    await usePoison(e, p, SWORD);
    const car = carrier(x.pc, sword);
    t.ok(car && car.system.duration.expiry === "turn-end" && car.system.duration.value === 1, `носитель со сроком (${short(car?.system.duration)})`);
    const next = async () => { await bound("nextTurn", c.nextTurn()); await wait(2500); };
    await next(); await next();
    t.ok(c.round === 2 && c.combatant?.actor?.id === x.pc.id, `раунд ${c.round}, ход владельца`);
    t.ok(!!carrier(x.pc, sword), "в следующий ход владельца носитель ещё жив");
    await next();
    t.ok(await waitFor(() => !carrier(x.pc, sword), 8000), "после конца хода носитель истёк");
    await next();   // ход владельца в раунде 3
    const t0 = e.since();
    const r = await flow(e, x.tP, x.tV, sword, 10, { dmg: true });
    t.ok(hit(r.atk) && hosts(e, t0).length === 0 && !afflOf(x.vic), "Удар после истечения яда не получает");
  });

  sc("npc", "NPC: яд из инвентаря на melee гоблина; Удар NPC -> испытание цели; опции и origin урона неслинкованного токена", async (e, t) => {
    const { coatCandidates, hasSP } = await imp("coat.mjs");
    openChat();
    const base = await e.foe("гоблин"), vic = await e.pc("жертва");
    const tA = await e.tok(base, 500, 500, -1), tV = await e.tok(vic, 600, 500, 1);
    await wait(700);
    const a = e.A(tA), t0 = e.since();
    t.ok(a && a.uuid !== base.uuid, `токен развязан (${a?.uuid})`);
    const cands = coatCandidates(a), w = cands.find(hasSP);
    t.info(`кандидаты NPC: ${cands.map((c) => `${c.name}[${c.type}]${hasSP(c) ? "" : "!sp"}`).join(", ")}`);
    if (!w) throw new Skip("у NPC нет оружия с колющим/рубящим уроном");
    const p = await dose(e, a, "AF яд NPC", { qty: 2 });
    await usePoison(e, p, w.name);
    t.ok(!!carrier(a, w), `носитель на «${w.name}» (type ${w.type})`);
    const r = await flow(e, tA, tV, w, 10, { dmg: true });
    t.ok(hit(r.atk) && !!r.taken, `Удар NPC попал (${outcome(r.atk)}), урон применён`);
    t.ok(!carrier(a, w) && hosts(e, t0).length === 1, `яд потрачен, испытаний ${hosts(e, t0).length}`);
    t.ok(cands.every((c) => c.type === "melee") && new Set(cands.map((c) => c.name)).size === cands.length, "кандидаты NPC — только melee, без дублей по имени");
    t.info(`linkedWeapon у melee: ${short(cands.map((c) => [c.name, c.flags?.pf2e?.linkedWeapon ?? null]))}`);
    t.info(`NPC атака: ${short(optsOf(r.atk, /item:id|action|strike|item:slug/).slice(0, 8))}; урон: ${short(optsOf(r.dmg, /item:id|item:damage|damage:type/).slice(0, 8))}`);
    t.info(`damage-taken.origin.actor=${r.taken?.flags?.pf2e?.origin?.actor}; токен-актёр=${a.uuid}; базовый=${base.uuid}; speaker.token=${r.taken?.speaker?.token}`);
  });

  sc("npc-copies", "Два несвязанных токена одного NPC: яд у A, Удар B — ничего (носитель A цел); Удар A — взвод и испытание", async (e, t) => {
    const { coatCandidates, hasSP } = await imp("coat.mjs");
    openChat();
    const base = await e.foe("гоблин"), vic = await e.pc("жертва");
    const tA = await e.tok(base, 500, 500, -1), tB = await e.tok(base, 500, 700, -1), tV = await e.tok(vic, 600, 600, 1);
    await wait(700);
    const aA = e.A(tA), aB = e.A(tB), t0 = e.since();
    t.ok(aA && aB && aA.uuid !== aB.uuid, "токены развязаны");
    const wA = coatCandidates(aA).find(hasSP);
    if (!wA) throw new Skip("у NPC нет оружия с колющим/рубящим уроном");
    const wB = aB.items.get(wA.id);
    await usePoison(e, await dose(e, aA, "AF яд NPC", { qty: 2 }), wA.name);
    t.ok(!!carrier(aA, wA), "носитель у A");
    const rB = await flow(e, tB, tV, wB, 10, { dmg: true });
    t.ok(hit(rB.atk), `Удар копии B попал (${outcome(rB.atk)})`);
    t.ok(carrier(aA, wA) && !armedOf(carrier(aA, wA)) && coatsOf(aB).length === 0 && hosts(e, t0).length === 0, "носитель A не взведён и не потрачен, у B носителя нет, испытаний нет");
    const rA = await flow(e, tA, tV, wA, 10, { dmg: true });
    t.ok(hit(rA.atk) && !carrier(aA, wA) && hosts(e, t0).length === 1, `Удар A: попал, яд потрачен, испытаний ${hosts(e, t0).length}`);
  });

  sc("options", "Проверка опций pf2e: item:id в атаке и уроне, item:damage:type:*, origin.actor у damage-taken (в detail)", async (e, t) => {
    const x = await armedSword(e);
    const r = await flow(e, x.tP, x.tV, x.sword, 10, { dmg: true });
    const id = `item:id:${x.sword.id}`;
    t.ok(optsOf(r.atk, /^item:id:/).includes(id), `атака: ${id}`);
    t.ok(optsOf(r.dmg, /^item:id:/).includes(id), `урон: ${id}`);
    t.info(`атака: ${short(optsOf(r.atk, /^(item:id|self:action|action:|item:slug|item:category|item:group|item:damage|item:ammo|ammo)/))}`);
    t.info(`урон: ${short(optsOf(r.dmg, /^(item:id|item:damage|damage:|item:slug|item:category|item:group|self:action)/))}`);
    const pf = r.taken?.flags?.pf2e;
    t.ok(!!pf?.origin?.actor, `damage-taken.flags.pf2e.origin.actor = ${pf?.origin?.actor} (актёр ${x.pc.uuid})`);
    t.info(`damage-taken: origin=${short(pf?.origin, 200)}; context.origin=${short(pf?.context?.origin, 120)}; опции=${short((pf?.context?.options ?? []).filter((o) => /item|damage|origin/.test(o)).slice(0, 12))}; updates=${short(pf?.appliedDamage?.updates)}`);
    t.info(`кнопка чата: ${e.fallback ? "applyDamage (кнопка не найдена)" : "apply-damage"}`);
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);
    for (const k of MODES) await setMode(k, "auto");
    for (const s of pick) {
      const infos = [];
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); }, info(m) { infos.push(m); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0; rigged.clear();
      try {
        e = await newEnv(s.id); cur = e;
        const run = s.run(e, t); run.catch(() => {});
        let timer;
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут 240 с; ${hangInfo(e)}`)), 240000); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} weapon-poison | ${s.id}`, err); }
      } finally {
        for (const k of MODES) { try { await setMode(k, "auto"); } catch { /* ok */ } }
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      if (infos.length) detail += ` | инфо: ${infos.join(" ; ")}`;
      if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 3).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    for (const k of MODES) { try { await setMode(k, modePrev[k]); } catch { /* ok */ } }
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  const table = rows.map((r) => `${r.id.padEnd(18)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afWeaponPoisonResult = result;
  return result;
}
