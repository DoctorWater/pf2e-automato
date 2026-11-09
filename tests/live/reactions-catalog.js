async () => {
  // Живой прогон каталогов реакций: все правила onDamaged (builtin/damaged.mjs) и onFailed (builtin/failed.mjs) из rules/catalog.model.json + rules/catalog.json (+ campaign).
  // Запуск: вкладка ГМа (она же лидер и активный ГМ), сайдбар чата виден; chrome-devtools evaluate_script с sourcePath на этот файл.
  //   window.__afReact = { only: ["halfling-luck", "phase-familiar"], skip: [], group: "all"|"damaged"|"failed", limit: 5, timeout: 45000,
  //                        hero: "dJZCamJEuiu1epbf", hero2: "LUYfatRSuX7zW9Wy", familiar: "OgH7nN3Eq0a7ol5O", cleanOnly: false }   // всё необязательно, до запуска
  //   only/skip — slug (из label каталога, у одноимённых правил добавляется «~xxxx» — 4 символа id предмета; базовый slug берёт все дубли), полный uuid или id предмета.
  // Результат: массив строк «PASS|FAIL|SKIP <slug>: детали» + window.__afReactResult + console.table.
  //   PASS — все проверки правила прошли (число проверок в деталях); FAIL — упала проверка или ошибка (детали: что, плюс диагностика опций/уведомления);
  //   SKIP — прогнать нельзя: нет предмета в паках, предмет не кладётся персонажу, не выполнить требование, «не умею вызвать: <when>» (генератор не подобрал триггер).
  // Каждое правило: временная сцена, копия героя-владельца (предметы с onDamaged/onFailed у копии удаляются), предмет из компендиума по uuid-ключу каталога
  // (_stats.compendiumSource = ключ, правило берётся живым ruleOfItem), второй токен для who ally/any/familiar, бой. Сначала отрицательная проверка (триггер вне when/степени — подсказки нет),
  // затем положительная. Всё созданное удаляется (по id), сцена пользователя «Тест» не трогается, просматриваемые сцена и бой возвращаются. Настройки mode.apply/mode.reaction,
  // useToolbeltTargetHelper и флаги pf2e showCheckDialogs/showDamageDialogs на время прогона меняются и возвращаются.
  // Аварийно: window.__afReact = { cleanOnly: true } — удалит всё «AF тест: реакции…».
  const MOD = "pf2e-automato", PFX = "AF тест: ", TAG = `${PFX}реакции`;
  const opts = { only: null, skip: [], group: "all", limit: Infinity, timeout: 45000, hero: "dJZCamJEuiu1epbf", hero2: "LUYfatRSuX7zW9Wy", familiar: "OgH7nN3Eq0a7ol5O", ...(window.__afReact ?? {}) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  class Skip extends Error {}
  let cur = null;
  const waitFor = async (fn, ms = 8000, step = 150) => {
    const end = Date.now() + ms, env = cur;
    if (env) env.step = `ждём: ${String(fn).replace(/\s+/g, " ").slice(0, 110)}`;
    while (Date.now() < end) { if (!env || env.dead) return null; try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(step); }
    return null;
  };
  const bound = (label, p, ms = 25000) => {
    const env = cur; if (env) env.step = label;
    let tm;
    return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`завис шаг «${label}» (>${ms / 1000} с)`)), ms); })]).finally(() => clearTimeout(tm));
  };
  const hangInfo = (e) => `последний шаг: ${e.step}; окна: [${e.dialogs}]; открыто: [${[...foundry.applications.instances.values(), ...Object.values(ui.windows ?? {})].map((a) => a.constructor.name).join(", ")}]`;
  const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });   // pf2e инвертирует настройку: при выключенных окнах shift окно ПОКАЗАЛ бы
  const imp = (f) => import(`/modules/${MOD}/scripts/${f}`);
  const sluggify = (s) => String(s).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // ---------- каталог ----------
  const getJson = async (f) => { try { const r = await fetch(foundry.utils.getRoute(`modules/${MOD}/rules/${f}`)); return r.ok ? await r.json() : null; } catch { return null; } };
  const [model, cat] = await Promise.all([getJson("catalog.model.json"), getJson("catalog.json")]);
  const merged = { ...(model?.bySource ?? {}), ...(cat?.bySource ?? {}) };   // порядок как в rules.mjs: побеждает последний
  const entries = [];
  for (const [uuid, v] of Object.entries(merged)) for (const rule of Array.isArray(v) ? v : [v]) {
    for (const kind of ["damaged", "failed"]) if (rule?.[kind === "damaged" ? "onDamaged" : "onFailed"]) entries.push({ kind, uuid, rule, label: rule.label ?? uuid, tail: uuid.split(".").at(-1) });
  }
  const bases = new Map();
  for (const x of entries) { x.base = sluggify(x.label); bases.set(`${x.kind}:${x.base}`, (bases.get(`${x.kind}:${x.base}`) ?? 0) + 1); }
  for (const x of entries) x.id = bases.get(`${x.kind}:${x.base}`) > 1 ? `${x.base}~${x.tail.slice(0, 4)}` : x.base;
  const names = (x) => [x.id, x.base, x.uuid, x.tail];
  let pick = entries.filter((x) => (opts.group === "all" || opts.group === x.kind) && (!opts.only || opts.only.some((o) => names(x).includes(o))) && !opts.skip.some((o) => names(x).includes(o)));
  if (Number.isFinite(opts.limit)) pick = pick.slice(0, opts.limit);

  // ---------- уборка (по id созданного; аварийно — по префиксу) ----------
  const mine = (n) => typeof n === "string" && n.startsWith(TAG);
  const killCombat = async (c) => { for (let i = 0; i < 3 && game.combats.has(c.id); i++) { await game.combats.get(c.id).delete().catch(() => {}); if (game.combats.has(c.id)) await wait(800); } };
  const sweep = async (ids = null) => {
    for (const c of game.combats.filter((c) => mine(c.scene?.name) || c.combatants.some((x) => mine(x.actor?.name) || mine(x.name)))) await killCombat(c);
    const scenes = game.scenes.filter((s) => mine(s.name)), actors = game.actors.filter((a) => mine(a.name));
    const aIds = new Set(actors.map((a) => a.id)), sIds = new Set(scenes.map((s) => s.id));
    // свои сообщения прогона (ids) — только если ссылаются на тестового актёра/сцену: ГМ-учётку может делить пользователь (CLAUDE.md §4.2)
    const keys = [...aIds, ...sIds], ref = (m) => { const j = JSON.stringify(m.toObject()); return keys.some((k) => j.includes(k)); };
    const own = new Set(ids ?? []);
    const msgs = new Set(game.messages.filter((m) => aIds.has(m.speaker?.actor) || sIds.has(m.speaker?.scene) || (own.has(m.id) && keys.length && ref(m))).map((m) => m.id));
    const del = [...msgs].filter((id) => game.messages.has(id));
    if (del.length) await ChatMessage.deleteDocuments(del).catch(() => {});
    for (const s of scenes) await s.delete().catch(() => {});
    for (const a of actors) await a.delete().catch(() => {});
    return game.actors.filter((a) => mine(a.name)).length + game.scenes.filter((s) => mine(s.name)).length;
  };
  if (opts.cleanOnly) return { left: await sweep() };

  const heroSrc = game.actors.get(opts.hero) ?? game.actors.get(opts.hero2);
  if (!heroSrc) return ["SKIP: нет героя-владельца (hero / hero2)"];
  if (!game.users.activeGM?.isSelf) return ["SKIP: эта вкладка не активный ГМ (обработчики модуля не сработают)"];
  const [D, F, R, P, C] = await Promise.all([imp("builtin/damaged.mjs"), imp("builtin/failed.mjs"), imp("reactions.mjs"), imp("predicate.mjs"), imp("cast.mjs")]);

  // ---------- общее окружение ----------
  const prevScene = game.scenes.viewed, prevCombat = game.combats.viewed;
  const pfSet = game.user.flags.pf2e?.settings ?? {};
  const origFlags = { showCheckDialogs: pfSet.showCheckDialogs, showDamageDialogs: pfSet.showDamageDialogs };
  const prevSet = { apply: game.settings.get(MOD, "mode.apply"), reaction: game.settings.get(MOD, "mode.reaction"), tb: game.settings.get(MOD, "useToolbeltTargetHelper") };
  const allMsgs = new Set();
  const hookId = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) allMsgs.add(m.id); });
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error }, ceOrig = console.error;
  console.error = function (...a) { const er = a.find((x) => x instanceof Error); if (er) notes.push(`console.error: ${String(a[0]).slice(0, 80)} ${String(er.stack ?? er.message).replace(/\s+/g, " ").slice(0, 500)}`); return ceOrig.apply(this, a); };
  const onErr = (ev) => { const er = ev.error ?? ev.reason; notes.push(`uncaught: ${String(er?.stack ?? er?.message ?? ev.message).replace(/\s+/g, " ").slice(0, 500)}`); };
  window.addEventListener("error", onErr); window.addEventListener("unhandledrejection", onErr);
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const setFlags = (v) => game.user.update(Object.fromEntries(Object.entries(v).map(([k, x]) => x === undefined ? [`flags.pf2e.settings.-=${k}`, null] : [`flags.pf2e.settings.${k}`, x])));
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };
  const openChat = () => { try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };

  // ---------- компендиумы ----------
  const idx = {};
  const findPack = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Skip(`нет пака ${pack}`);
    idx[pack] ??= await p.getIndex({ fields: ["system.slug"] });
    const x = idx[pack].find((i) => i.system?.slug === slug);
    if (!x) throw new Skip(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(x._id)).toObject();
  };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного правила ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, dialogs: [], step: "старт", stop: false, d20: null, t00: Date.now() };
    e.scene = await Scene.create({ name: `${TAG} сцена ${id}`.slice(0, 120), width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    const seen = new Set();
    (async () => {   // окна: наши .paf-dialog закрываются, ChoiceSet pf2e — первый вариант, окна бросков — «Бросок»
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id); e.dialogs.push(el.querySelector(".window-title")?.textContent?.trim() ?? el.id);
          foundry.applications.instances.get(el.id)?.close();
        }
        for (const app of foundry.applications.instances.values()) {
          if (seen.has(app.id) || !app.element || !/Prompt|Picker/i.test(app.constructor.name)) continue;
          seen.add(app.id);
          if (Array.isArray(app.choices) && app.choices.length) { app.selection = app.choices[0]; app.close(); }
        }
        for (const app of [...Object.values(globalThis.ui?.windows ?? {}), ...foundry.applications.instances.values()]) {
          const aid = app.appId ?? app.id;
          if (seen.has(aid) || !/damage|modifiers|урон|check/i.test(`${app.constructor.name} ${app.title}`)) continue;
          seen.add(aid); e.dialogs.push(`${app.constructor.name} «${app.title}»`);
          const root = app.element?.[0] ?? app.element, bs = root?.querySelectorAll?.("button");
          (root?.querySelector?.("button.roll") ?? bs?.[bs.length - 1])?.click();
        }
        await wait(150);
      }
    })();
    const live = () => { if (e.dead) throw new Error("правило остановлено по таймауту"); };
    e.add = (data, role) => live() ?? Actor.create({ ...data, folder: game.folders.find((f) => f.type === "Actor" && f.name === "Тестовые копии (автоматизация)")?.id ?? null, ownership: { default: 0 }, name: `${TAG} — ${role}` });
    e.tok = async (a, x, y, disposition) => {
      live();
      const [t] = await e.scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition }]);
      return t;
    };
    e.T = (t) => e.scene.tokens.get(t.id);
    e.A = (t) => e.T(t)?.actor;
    e.aim = async (ctrl, ...targets) => {
      e.T(ctrl).object?.control({ releaseOthers: true });
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      for (const t of targets) e.T(t).object?.setTarget(true, { releaseOthers: false });
      await wait(300);
    };
    e.rig = (actor, rules) => live() ?? actor.createEmbeddedDocuments("Item", [{ type: "effect", name: "AF rig", system: { slug: "af-rig", rules } }]);
    e.fix = async (n) => {
      if (e.d20 === null) e.d20 = CONFIG.Dice.randomUniform;
      CONFIG.Dice.randomUniform = n == null ? e.d20 : () => 1 - (n - 0.5) / 20;
      if (n != null && (await new Roll("1d20").evaluate()).total !== n) throw new Skip("не удалось зафиксировать d20 (CONFIG.Dice.randomUniform)");
    };
    e.msgs = (t0) => game.messages.contents.filter((m) => m._stats.createdTime >= t0);
    e.dom = (m) => document.querySelector(`#chat [data-message-id="${m?.id}"]`);
    e.combat = async (toks, inits) => {
      live();
      const c = await Combat.create({ scene: e.scene.id, active: true });
      await c.createEmbeddedDocuments("Combatant", toks.map((t, i) => ({ tokenId: t.id, sceneId: e.scene.id, actorId: t.actor.id, initiative: inits[i] })));
      await viewCombat(c);
      await c.startCombat(); await wait(1200);
      return c;
    };
    e.dispose = async () => {
      e.dead = true; e.stop = true;
      await wait(2500);   // модуль дописывает флаги/эффекты карточек: сцену удаляем после
      for (const c of game.combats.filter((c) => c.scene?.id === e.scene.id || c.combatants.some((x) => x.sceneId === e.scene.id))) await killCombat(c);
      await wait(1500);   // «Конец раунда» и т.п. рождаются при удалении боя
      if (prevScene && game.scenes.has(prevScene.id)) { await prevScene.view().catch(() => {}); await wait(1000); }
      try { await e.fix(null); } catch { /* ok */ }
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      document.querySelectorAll(".paf-dialog").forEach((el) => foundry.applications.instances.get(el.id)?.close());
      const left = await sweep([...allMsgs].filter((id) => game.messages.get(id)?._stats.createdTime >= e.t00));
      await viewCombat(prevCombat);
      return left;
    };
    return e;
  };

  // ---------- подготовка владельца и предмета ----------
  const PHYS = new Set(["equipment", "armor", "shield", "weapon", "consumable", "backpack", "treasure"]);
  const OK_TYPES = new Set(["action", "feat", "spell", ...PHYS]);
  const strip = async (a) => {   // правила реакций самого героя не должны вмешиваться
    const ids = a.items.filter((i) => { const r = R.ruleOfItem(i); return r?.onDamaged || r?.onFailed; }).map((i) => i.id);
    if (ids.length) await a.deleteEmbeddedDocuments("Item", ids);
  };
  const copyActor = async (e, src, role, patch = (d) => d) => {
    const d = src.toObject(); delete d._id; delete d.folder;
    d.flags = { ...(d.flags ?? {}) }; delete d.flags[MOD];   // отметка потраченной реакции героя не должна переехать на копию
    const a = await e.add(patch(d), role);
    await strip(a);
    if (a.type !== "familiar") await a.update({ "system.attributes.hp.value": a.hitPoints.max });
    return a;
  };
  const freshPc = async (e, role) => {
    const a = await e.add({ type: "character", name: role, system: { details: { alliance: "party", languages: { value: ["common"] } } } }, role);
    await a.createEmbeddedDocuments("Item", [await findPack("pf2e.ancestries", "human")]);
    await a.update({ "system.attributes.hp.value": a.hitPoints.max });
    return a;
  };
  const isFocus = (data) => { const tr = data.system?.traits ?? {}; return (tr.value ?? []).includes("focus") || ((tr.value ?? []).includes("cantrip") && !(tr.traditions?.length)); };
  const ensureFocus = async (e, a) => {
    if (!(a.system.resources?.focus?.max >= 1)) await e.rig(a, [{ key: "ActiveEffectLike", path: "system.resources.focus.max", mode: "upgrade", value: 1 }]);
    await a.update({ "system.resources.focus.value": a.system.resources.focus.max });
  };
  /** Кладёт предмет правила владельцу и доводит до состояния «может использовать»: запись колдовства, экипировка, требования, полные ресурсы. -> item */
  const giveItem = async (e, owner, ent, d) => {
    const doc = await fromUuid(ent.uuid).catch(() => null);
    if (!doc) throw new Skip(`нет в паках: ${ent.uuid}`);
    const data = doc.toObject(); delete data._id;
    if (!OK_TYPES.has(data.type)) throw new Skip(`тип «${data.type}» не кладётся персонажу`);
    data._stats = { ...(data._stats ?? {}), compendiumSource: ent.uuid };
    if (data.type === "spell") {
      const focus = isFocus(data);
      const [entry] = await owner.createEmbeddedDocuments("Item", [{ type: "spellcastingEntry", name: "AF запись", system: { prepared: { value: focus ? "focus" : "innate" }, tradition: { value: "occult" }, ability: { value: "cha" }, proficiency: { value: 1 } } }]);
      data.system.location = { value: entry.id, ...(focus ? {} : { uses: { value: 1, max: 1 } }) };
    }
    let item;
    try { [item] = await owner.createEmbeddedDocuments("Item", [data]); } catch (err) { throw new Skip(`не кладётся персонажу: ${String(err?.message ?? err).slice(0, 150)}`); }
    if (!item) throw new Skip("предмет не создан");
    if (item.type === "spell" && isFocus(data)) await ensureFocus(e, owner);
    const f = item.system.frequency;
    if (f?.max != null && f.value !== f.max) await item.update({ "system.frequency.value": f.max });
    // требование: опция вида сущность:значение или слово invested/equipped/held (проверка — тем же requiresOk, что у модуля)
    const req = d.requires, okReq = () => D.requiresOk(req, item, owner, C.requirementOf);
    if (!okReq()) {
      if (req && req.includes(":")) {
        const m = /^stance:(.+)$/.exec(req);
        if (m) await owner.createEmbeddedDocuments("Item", [{ type: "effect", name: "AF стойка", system: { slug: m[1] } }]);
        else if (req === "shield:raised") {
          await item.update({ "system.equipped": { carryType: "held", handsHeld: 1 } }).catch(() => {});
          await owner.update({ "system.attributes.shield.raised": true }).catch(() => {});
        }
        await wait(500);
      } else if (item.isEquipped !== undefined) {
        for (const eq of [{ carryType: "worn", inSlot: true, invested: true }, { carryType: "worn", inSlot: true }, { carryType: "held", handsHeld: 1 }, { carryType: "held", handsHeld: 2 }]) {
          await item.update({ "system.equipped": eq }).catch(() => {});
          if (okReq()) break;
        }
      }
      if (!okReq()) throw new Skip(`не выполнить требование «${req ?? "по умолчанию (экипировка/вложение)"}» у копии`);
    }
    return item;
  };

  // ---------- генераторы триггеров (по предикату when: подбор по смоделированным опциям, как их строит модуль) ----------
  const subsets = (arr) => { let out = [[]]; for (const x of arr) out = out.concat(out.map((s) => [...s, x])); return out.sort((a, b) => a.length - b.length); };
  const SAVES = ["fortitude", "reflex", "will"], SKILLS = ["acrobatics", "arcana", "athletics", "crafting", "deception", "diplomacy", "intimidation", "medicine", "nature", "occultism", "performance", "religion", "society", "stealth", "survival", "thievery"];
  const STATS = { save: SAVES, skill: SKILLS, perception: ["perception"], attack: ["strike"] };
  const CTX = { save: "saving-throw", skill: "skill-check", perception: "perception-check", attack: "attack-roll" };
  const simF = (s) => new Set([`check:statistic:${s.stat}`, `check:type:${CTX[s.kind]}`, ...s.extras]);
  const whenOk = (when, set) => !when || P.testPredicate(when, set);
  const statsFor = (kind, toks) => { const all = STATS[kind]; return [...all.filter((s) => toks.includes(`check:statistic:${s}`)), ...all.filter((s) => !toks.includes(`check:statistic:${s}`))]; };
  const kindsOf = (d) => ["save", "skill", "perception", "attack"].filter((k) => d.check.includes(k));
  function findFailed(d) {
    const toks = [...new Set(F.tokensOf(d.when))], pool = toks.filter((t) => !/^check:(statistic|type):/.test(t));
    for (const extras of subsets(pool)) for (const kind of kindsOf(d)) for (const stat of statsFor(kind, toks)) {
      const s = { kind, stat, extras };
      if (whenOk(d.when, simF(s))) return s;
    }
    return null;
  }
  /** Отрицательный триггер: сначала мимо when (тип проверки подходит), иначе мимо степени. -> {spec, margin, why} */
  function negFailed(d, pos) {
    const toks = [...new Set(F.tokensOf(d.when))];
    if (d.when) for (const kind of kindsOf(d)) for (const stat of statsFor(kind, toks)) for (const extras of [[], pos.extras]) {
      const s = { kind, stat, extras };
      if (!whenOk(d.when, simF(s))) return { spec: s, margin: d.degree === "critFail" ? 15 : 5, why: `мимо when (${kind}/${stat}${extras.length ? ` +${extras}` : ""})` };
    }
    const m = d.degree === "critFail" ? 5 : d.degree === "failNotCrit" ? 15 : -5;
    return { spec: pos, margin: m, why: `мимо степени (${m === 5 ? "провал" : m === 15 ? "крит. провал" : "успех"} при degree ${d.degree})` };
  }
  const DT = ["force", "fire", "slashing", "acid", "bludgeoning", "cold", "electricity", "mental", "piercing", "poison", "sonic", "spirit", "vitality", "void", "bleed"];
  const simD = (c) => D.damageOptions({
    flags: { pf2e: { context: { options: [], sourceType: c.attack ? "attack" : undefined, outcome: c.outcome }, origin: c.spell ? { type: "spell" } : undefined } },
    rolls: [{ instances: [{ type: c.type }] }], item: c.spell === 2 ? { type: "spell", area: { value: 20 } } : c.spell ? { type: "spell" } : null
  });
  function genDamaged(d) {
    const wt = D.whenTypes(d.when), types = [...wt, ...DT.filter((t) => !wt.includes(t))], combos = [];
    for (const outcome of [undefined, "criticalSuccess", "success", "failure", "criticalFailure"]) for (const spell of [0, 1, 2]) for (const attack of [0, 1]) for (const type of types) combos.push({ type, attack, spell, outcome });
    combos.sort((a, b) => (a.attack + a.spell + (a.outcome ? 1 : 0)) - (b.attack + b.spell + (b.outcome ? 1 : 0)));
    const ok = (c) => whenOk(d.when, simD(c)), pos = combos.find(ok);
    if (!pos) return { pos: null };
    const neg = d.when ? [...types.map((type) => ({ ...pos, type })), ...combos].find((c) => !ok(c)) ?? null : null;
    return { pos, neg };
  }

  const ownerPerm = (m) => m.whisper?.includes(game.user.id);
  const used = (a, uuid) => a.itemTypes.effect.filter((i) => i._stats?.compendiumSource === uuid);

  // ---------- onFailed ----------
  const runFailed = async (e, t, ent) => {
    openChat();
    const who = ent.rule.onFailed.who ?? "self";
    const O = await copyActor(e, heroSrc, "Владелец");
    const A = who === "self" ? null : await freshPc(e, "Проваливший");
    const tO = await e.tok(O, 500, 500, 1), tA = A ? await e.tok(A, 600, 500, 1) : null;
    await wait(700);
    const owner = e.A(tO), ally = tA ? e.A(tA) : null, roller = ally ?? owner;
    const item = await giveItem(e, owner, ent, ent.rule.onFailed);
    const d = R.ruleOfItem(item)?.onFailed;
    if (!d) { t.ok(false, `правило onFailed не резолвится у копии предмета (источник ${item._stats?.compendiumSource})`); return; }
    const pos = findFailed(d);
    if (!pos) throw new Skip(`не умею вызвать: ${JSON.stringify(d.when)} (check ${d.check})`);
    const strike = (a) => a.system.actions.find((s) => s.item?.isMelee) ?? a.system.actions[0];
    const have = (a, s) => s.kind === "save" ? !!a.saves?.[s.stat] : s.kind === "skill" ? !!a.skills?.[s.stat] : s.kind === "perception" ? !!a.perception : !!strike(a);
    if (!have(roller, pos)) throw new Skip(`у проваливающего нет статистики ${pos.kind}/${pos.stat}`);
    const modOf = (a, s) => (s.kind === "save" ? a.saves[s.stat].mod : s.kind === "skill" ? a.skills[s.stat].mod : s.kind === "perception" ? a.perception.mod : strike(a).totalModifier) ?? 0;
    const msgType = CTX[pos.kind];
    await e.combat([tO, ...(tA ? [tA] : [])], [20, 10]);
    await e.fix(10);   // d20 = 10: итог = 10 + mod, СЛ = итог + margin даёт нужную степень
    const roll = async (spec, margin) => {
      const dc = 10 + modOf(roller, spec) + margin, t0 = Date.now(), base = { dc: { value: dc } };
      if (spec.kind === "attack") await bound("бросок Удара", strike(roller).variants[0].roll({ ...base, event: SHIFT(), options: spec.extras }));
      else {
        const p = { ...base, skipDialog: true, createMessage: true, extraRollOptions: spec.extras };
        await bound("бросок", spec.kind === "save" ? roller.saves[spec.stat].roll(p) : spec.kind === "skill" ? roller.skills[spec.stat].roll(p) : roller.perception.roll(p));
      }
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.type === CTX[spec.kind] && !x.flags.pf2e.context.isReroll && x.speaker?.actor === roller.id), 9000);
      return { m, t0 };
    };
    const hintOf = (t0, m) => e.msgs(t0).find((x) => F.hintOf(x)?.item === item.uuid && F.hintOf(x)?.message === m?.id);
    const diag = (m) => {
      try {
        const ctx = m.flags.pf2e.context, opt = F.optionsOf(m);
        return `исход ${ctx.outcome}, тип ${ctx.type}, typeOk ${F.typeOk(d.check, ctx.type)}, degreeOk ${F.degreeOk(d.degree, ctx.outcome)}, when ${whenOk(d.when, opt)}, noLuck ${F.noLuck(ctx, m.rolls?.[0])}, кандидатов ${F.candidates(m).length}, опции [${[...opt].filter((o) => /^(check|item|origin|action|damaging)/.test(o)).join(" ")}]`;
      } catch (err) { return `диагностика: ${err.message}`; }
    };
    // 1) отрицательная проверка — ресурсы ещё полные
    const neg = negFailed(d, pos);
    if (have(roller, neg.spec)) {
      const { m, t0 } = await roll(neg.spec, neg.margin);
      await wait(2500);
      const h = m && hintOf(t0, m);
      t.ok(!!m, `негатив (${neg.why}): сообщение броска`);
      t.ok(!!m && !h && !m.flags?.[MOD]?.gate?.hold, `негатив (${neg.why}): подсказки нет и удержания нет — подсказка ${!!h}, удержание ${m?.flags?.[MOD]?.gate?.hold}${m ? `; ${diag(m)}` : ""}`);
      if (h || m?.flags?.[MOD]?.gate?.hold) e.dom(h)?.querySelector('[data-af-failed="skip"]')?.click();
    } else notes.push(`негатив пропущен: нет статистики ${neg.spec.kind}/${neg.spec.stat}`);
    // 2) положительная: удержание, подсказка, переброс, цена
    const margin = d.degree === "critFail" ? 15 : 5;
    const { m: save1, t0 } = await roll(pos, margin);
    t.ok(!!save1, `бросок ${pos.kind}/${pos.stat}${pos.extras.length ? ` +${pos.extras}` : ""}: сообщение`);
    if (!save1) return;
    t.ok(save1.flags?.[MOD]?.gate?.hold === "reroll", `бросок удержан (gate.hold reroll): ${JSON.stringify(save1.flags?.[MOD]?.gate)}; ${diag(save1)}`);
    const h1 = await waitFor(() => hintOf(t0, save1), 8000);
    t.ok(!!h1, `подсказка у владельца появилась; ${diag(save1)}`);
    if (!h1) return;
    t.ok(F.hintOf(h1).state === "pending" && ownerPerm(h1), `подсказка pending, ГМ в адресатах: ${F.hintOf(h1).state}`);
    const btn = await waitFor(() => e.dom(h1)?.querySelector('[data-af-failed="use"]'), 5000);
    t.ok(btn?.textContent?.trim() === item.name, `кнопка — название с листа: «${btn?.textContent?.trim()}» (ждали «${item.name}»)`);
    const f0 = item.system.frequency?.value, focus0 = owner.system.resources?.focus?.value;
    const t1 = Date.now();
    btn?.click();
    const re = await waitFor(() => e.msgs(t1).find((x) => x.flags?.pf2e?.context?.type === msgType && x.flags.pf2e.context.isReroll), 14000);
    t.ok(!!re, "переброшенный бросок (isReroll)");
    if (d.keep === "new") t.ok(!game.messages.get(save1.id), "keep new: старое сообщение удалено pf2e");
    if (re) t.ok(!re.flags?.[MOD]?.gate?.hold, `переброс не удержан повторно: ${JSON.stringify(re.flags?.[MOD]?.gate)}`);
    t.ok(!!(await waitFor(() => F.hintOf(game.messages.get(h1.id))?.state === "used", 8000)), `подсказка used: ${F.hintOf(game.messages.get(h1.id))?.state}`);
    if (item.system.frequency?.max != null && item.type !== "spell") t.ok(!!(await waitFor(() => owner.items.get(item.id)?.system.frequency?.value === f0 - 1, 6000)), `частота списана: ${owner.items.get(item.id)?.system.frequency?.value} (было ${f0})`);
    if (item.type === "spell" && item.system.traits.value.includes("focus") && !item.system.traits.value.includes("cantrip")) t.ok(!!(await waitFor(() => owner.system.resources.focus.value === focus0 - 1, 6000)), `фокус потрачен: ${owner.system.resources.focus.value} (было ${focus0})`);
    if (F.hintOf(h1).reaction) t.ok(!!(await waitFor(() => owner.getFlag(MOD, "reactionSpent"), 5000)), "реакция владельца отмечена");
  };

  // ---------- onDamaged ----------
  const typeHit = (rt, ty) => rt === ty || (rt === "physical" && ["bludgeoning", "piercing", "slashing"].includes(ty)) || (rt === "energy" && ["acid", "cold", "electricity", "fire", "sonic", "force", "vitality", "void"].includes(ty));
  const runDamaged = async (e, t, ent) => {
    openChat();
    const who = ent.rule.onDamaged.who ?? "self";
    const O = await copyActor(e, heroSrc, "Владелец");
    let Pa = null;
    if (who === "ally") Pa = await freshPc(e, "Защищаемый");
    else if (who === "familiar") {
      const fam = game.actors.get(opts.familiar);
      if (!fam) throw new Skip(`нет актёра-фамильяра ${opts.familiar}`);
      Pa = await copyActor(e, fam, "Фамильяр", (d) => { d.system.master = { ...(d.system.master ?? {}), id: O.id }; return d; });
    }
    const foe = await (async () => { const a = await e.add({ ...(await fromUuid(GOBLIN)).toObject(), name: "Враг" }, "Враг"); await a.update({ "system.attributes.hp.value": a.hitPoints.max }); return a; })();
    const tO = await e.tok(O, 500, 500, 1), tP = Pa ? await e.tok(Pa, 600, 500, 1) : tO, tG = await e.tok(foe, 900, 500, -1);
    await wait(700);
    const owner = e.A(tO), P = e.A(tP), G = e.A(tG), docP = e.T(tP);
    for (const a of new Set([owner, P])) { await e.rig(a, [{ key: "FlatModifier", selector: "hp", value: 300 }]); await a.update({ "system.attributes.hp.value": a.hitPoints.max }); }
    const total = P.hitPoints.max >= 100 ? 40 : Math.max(6, Math.floor(P.hitPoints.max / 2));
    await e.combat([tO, tG], [20, 10]);
    // сообщение урона по цели P: бросок DamageRoll «<n>[тип]» + контекст pf2e
    let fire;
    const send = async (spec) => {
      const DR = CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll");
      const roll = await new DR(`${total}[${spec.type}]`).evaluate();
      const ctxFlags = { type: "damage-roll", sourceType: spec.attack ? "attack" : undefined, options: [], outcome: spec.outcome, target: { actor: P.uuid, token: docP.uuid }, domains: ["damage"] };
      const pf2e = { context: ctxFlags };
      if (spec.spell) pf2e.origin = { type: "spell", actor: G.uuid };
      if (spec.spell === 2) { fire ??= await findPack("pf2e.spells-srd", "fireball"); pf2e.casting = { id: null, embeddedSpell: fire }; }
      await e.aim(tG, tP);
      const t0 = Date.now();
      const m = await ChatMessage.create({ speaker: { scene: e.scene.id, token: tG.id, actor: G.id }, rolls: [roll], flags: { pf2e } });
      return { m, t0, roll };
    };
    const applyTo = (m) => P.applyDamage({ damage: m.rolls[0], token: docP, item: m.item, rollOptions: new Set(m.flags.pf2e.context.options ?? []) });
    const gen = genDamaged(ent.rule.onDamaged);
    if (!gen.pos) throw new Skip(`не умею вызвать: ${JSON.stringify(ent.rule.onDamaged.when)}`);
    // базовая линия без предмета: сколько цель теряет от этого урона сама (сопротивления/слабости героя)
    const hpMax = P.hitPoints.max;
    const b = await send(gen.pos);
    if (!b.m) throw new Error("нет сообщения базовой линии");
    await bound("базовый урон", applyTo(b.m), 15000); await wait(800);
    const base = hpMax - P.hitPoints.value;
    await P.update({ "system.attributes.hp.value": hpMax });
    await wait(500);
    const item = await giveItem(e, owner, ent, ent.rule.onDamaged);
    const d = R.ruleOfItem(item)?.onDamaged;
    if (!d) { t.ok(false, `правило onDamaged не резолвится у копии предмета (источник ${item._stats?.compendiumSource})`); return; }
    const hintOf = (t0, m) => e.msgs(t0).find((x) => D.hintOf(x)?.item === item.uuid && D.hintOf(x)?.message === m?.id);
    // 1) отрицательная проверка
    if (gen.neg) {
      const n = await send(gen.neg);
      await wait(2500);
      const h = hintOf(n.t0, n.m);
      t.ok(!!n.m && !h, `негатив (${JSON.stringify(gen.neg)}): подсказки нет — ${!!h}`);
      if (h) e.dom(h)?.querySelector('[data-af-damaged="skip"]')?.click();
    }
    // 2) положительная
    const { m: dmg, t0 } = await send(gen.pos);
    const opt = D.damageOptions(dmg);
    if (!whenOk(d.when, opt)) throw new Skip(`не умею вызвать: ${JSON.stringify(d.when)} (опции сообщения: ${[...opt].join(" ")})`);
    const hint = await waitFor(() => hintOf(t0, dmg), 9000);
    t.ok(!!hint, `подсказка у владельца появилась (триггер ${JSON.stringify(gen.pos)}, опции ${[...opt].join(" ")})`);
    if (!hint) return;
    t.ok(D.hintOf(hint).state === "pending" && ownerPerm(hint), `подсказка pending, ГМ в адресатах: ${D.hintOf(hint).state}`);
    const btn = await waitFor(() => e.dom(hint)?.querySelector('[data-af-damaged="use"]'), 5000);
    t.ok(btn?.textContent?.trim() === item.name, `кнопка — название с листа: «${btn?.textContent?.trim()}» (ждали «${item.name}»)`);
    const hp0 = P.hitPoints.value, hpO0 = owner.hitPoints.value, f0 = item.system.frequency?.value, focus0 = owner.system.resources?.focus?.value;
    let applied = false;
    const p = applyTo(dmg).then(() => { applied = true; });
    await wait(1500);
    t.ok(!applied && P.hitPoints.value === hp0, `урон ждёт решения: применён ${applied}, ОЗ ${P.hitPoints.value}/${hp0}`);
    btn?.click();
    await bound("урон после реакции", p, 20000);
    await wait(1200);
    const dec = D.hintOf(game.messages.get(hint.id))?.decision;
    t.ok(!!dec, "решение записано в подсказку");
    if (dec) {
      t.ok(!!d.damage?.halve === !!dec.halve && (d.damage?.reduce != null) === (dec.reduce != null) && !!d.damage?.redirect === !!dec.redirect && !!d.damage?.resist === !!dec.resist?.length && !!d.triggerOnly === !!dec.triggerOnly, `решение соответствует правилу: ${JSON.stringify({ ...dec, fx: undefined })}`);
      const ty = gen.pos.type;
      let rest = total, toOwner = 0;
      if (dec.reduce != null) rest = Math.max(0, total - dec.reduce);
      else if (dec.halve) rest = Math.floor(total / 2);
      else if (dec.redirect) { rest = dec.redirect === "half" ? Math.floor(total / 2) : 0; toOwner = total - rest; }
      const r = Math.max(0, ...(dec.resist ?? []).filter((x) => typeHit(x.type, ty)).map((x) => x.value));
      const expect = Math.max(0, rest - r), lost = hp0 - P.hitPoints.value;
      // эффект ответа (onUse.apply) может сам давать сопротивление (Phase Familiar: 5) — точное число из решения не выводится, только «не больше расчёта»
      const fxResp = (ent.rule.onUse?.apply ?? []).some((s) => s.effect?.uuid);
      if (fxResp) t.ok(lost <= expect && lost <= base, `урон цели с эффектом ответа: потеряно ${lost}, не больше ${Math.min(expect, base)} (бросок ${total})`);
      else if (base === total) t.ok(lost === expect, `урон цели: потеряно ${lost}, ждали ${expect} (бросок ${total}; решение ${JSON.stringify({ reduce: dec.reduce, halve: dec.halve, redirect: dec.redirect, resist: dec.resist })})`);
      else t.ok(lost <= base && (expect >= total || lost < base), `у цели свои сопротивления (базовая линия ${base} из ${total}): потеряно ${lost}, без реакции было бы ${base}; точная сверка пропущена`);
      if (toOwner && P !== owner) t.ok(hpO0 - owner.hitPoints.value === toOwner, `перенос владельцу: потеряно ${hpO0 - owner.hitPoints.value}, ждали ${toOwner}`);
    }
    // эффекты ответа (как use.mjs/damaged.useDamaged: шаги onUse.apply c effect.uuid; у self — на владельце, иначе на защищаемом)
    const steps = (R.ruleOfItem(item)?.onUse?.apply ?? []).filter((s) => s.effect?.uuid && s.to === (d.who === "self" ? "self" : "target"));
    const holder = d.who === "self" ? owner : P;
    for (const s of steps) {
      if (d.triggerOnly) t.ok(!!(await waitFor(() => !used(holder, s.effect.uuid).length, 8000)), `triggerOnly: эффект ответа снят после урона (${used(holder, s.effect.uuid).length})`);
      else t.ok(!!(await waitFor(() => used(holder, s.effect.uuid).length, 8000)), `эффект ответа лёг на ${holder.name}`);
    }
    t.ok(game.messages.get(hint.id)?.flags[MOD].damaged.state === "used", `подсказка used: ${game.messages.get(hint.id)?.flags[MOD].damaged.state}`);
    if (item.system.frequency?.max != null && item.type !== "spell") t.ok(!!(await waitFor(() => owner.items.get(item.id)?.system.frequency?.value === f0 - 1, 6000)), `частота списана: ${owner.items.get(item.id)?.system.frequency?.value} (было ${f0})`);
    if (item.type === "spell" && item.system.traits.value.includes("focus") && !item.system.traits.value.includes("cantrip")) t.ok(!!(await waitFor(() => owner.system.resources.focus.value === focus0 - 1, 6000)), `фокус потрачен: ${owner.system.resources.focus.value} (было ${focus0})`);
    t.ok(!!owner.getFlag(MOD, "reactionSpent"), "реакция владельца отмечена");
  };

  // ---------- прогон ----------
  const rows = [];
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);
    if (prevSet.apply !== "auto") await game.settings.set(MOD, "mode.apply", "auto");
    if (prevSet.reaction !== "auto") await game.settings.set(MOD, "mode.reaction", "auto");
    for (const ent of pick) {
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0;
      try {
        e = await newEnv(ent.id); cur = e;
        const run = (ent.kind === "failed" ? runFailed : runDamaged)(e, t, ent); run.catch(() => {});
        let timer;
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут ${opts.timeout / 1000} с; ${hangInfo(e)}`)), opts.timeout); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${ent.kind}, ${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.warn(`${MOD} reactions-catalog | ${ent.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      const errs = notes.filter((n) => /^(console\.error|uncaught)/.test(n) && /pf2e-automato|automato/i.test(n) && !/createScrollingText|showFloatyText|reading 'position'\) at set y/.test(n));
      if (errs.length) { status = "fail"; detail += ` | ошибки модуля: ${errs.slice(0, 3).join(" / ")}`; }
      else if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 4).join(" / ")}`;
      rows.push({ id: ent.id, kind: ent.kind, label: ent.label, status, detail });
    }
  } finally {
    Hooks.off("createChatMessage", hookId);
    Object.assign(N, nOrig); console.error = ceOrig;
    window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr);
    for (const [k, v] of [["mode.apply", prevSet.apply], ["mode.reaction", prevSet.reaction], ["useToolbeltTargetHelper", prevSet.tb]]) { try { await game.settings.set(MOD, k, v); } catch { /* ok */ } }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep([...allMsgs]);
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, kind, status, detail }) => ({ правило: id, группа: kind, статус: status, подробности: detail })));
  const sum = rows.reduce((a, r) => (a[r.status] = (a[r.status] ?? 0) + 1, a), {});
  window.__afReactResult = out;
  return [`ИТОГО ${JSON.stringify(sum)} из ${rows.length}`, ...out];
}
