async () => {
  // Живые сценарии способностей фамильяра ведьмы (docs/plan-familiar.md): копия Фейи + временный фамильяр «AF тест: фамильяр» (system.master), способность из familiar-abilities на фамильяре,
  // Evil Eye (hex) по гоблину. Окна выбора модуля отвечаются очередью e.answers (подпись или значение варианта; null — закрыть).
  // Параметры: window.__afL1Fam = { only, skip, cleanOnly }. Результат — window.__afL1FamResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afL1Fam ?? {}) };
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

  // ---------- уборка (аварийная: window.__afL1Fam = {cleanOnly: true}) ----------
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

  const cast = (e, s, spell = s.evil, ...aim) => async () => { await e.aim(s.tW, ...(aim.length ? aim : [s.tG])); await e.fix(10); await bound("сотворение", spell.spellcasting.cast(spell, { consume: false })); await wait(1500); };
  const stup = (a) => a.itemTypes.condition.find((c) => c.slug === "stupefied") ?? null;

  sc("wf10-cast", "WF10 при сотворении Evil Eye: окно существ в 20 фт от фамильяра (без него самого), stupefied 1; закрытое окно — ничего", async (e, t) => {
    const s = await setup(e, "WF10");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const r = await withAnswers(e, ["гоблин"], cast(e, s));
    t.ok(r.n >= 1, `окно выбора было: [${r.seen}]`);
    t.ok(!/фамильяр/.test(r.seen.join(" ")), `сам фамильяр не в кандидатах: [${r.seen}]`);
    t.ok(!!(await waitFor(() => stup(s.G), 6000)), `stupefied у гоблина: ${s.G.itemTypes.condition.map((c) => c.slug)} окна=[${r.seen}] items=[${s.G.items.filter((i) => ["effect","condition"].includes(i.type)).map((i) => i.name)}] msgs=[${game.messages.contents.slice(-4).map((m) => (m.flavor ?? "").slice(0,40) + "/" + (m.content ?? "").replace(/<[^>]+>/g, " ").replace(/s+/g, " ").slice(0, 120))}]`);
    const cond = stup(s.G), fx = s.G.itemTypes.effect.filter((i) => i.flags?.[MOD]?.meta);
    t.ok(true, `INFO срок: cond=${JSON.stringify(cond?.system.duration)} fx=${fx.map((i) => `${i.name}:${JSON.stringify(i.system.duration)}:${i.system.context?.origin?.actor === s.W.uuid}`)}`);
    for (const x of fx) await x.delete().catch(() => {});
    if (stup(s.G)) await stup(s.G).delete().catch(() => {});
    await wait(800);
    const r2 = await withAnswers(e, [null], cast(e, s));
    t.ok(r2.n >= 1 && !stup(s.G), `закрытое окно — эффекта нет (окон ${r2.n})`);
  });

  sc("not-hex", "Не-hex кантрип: способность не запускается, якоря нет", async (e, t) => {
    const s = await setup(e, "WF10");
    if (!s.plain) throw new Skip("нет не-hex кантрипа");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const r = await withAnswers(e, [], cast(e, s, s.plain));
    t.ok(r.n === 0, `окна нет: [${r.seen}]`);
    t.ok(!anchors(s.W).length, "якоря нет");
  });

  sc("down-and-notoken", "Фамильяр на 0 ОЗ — окна нет; токен убран — окна нет, один шёпот ГМу", async (e, t) => {
    const s = await setup(e, "WF10");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await s.F.update({ "system.attributes.hp.value": 0 });
    let r = await withAnswers(e, [], cast(e, s));
    t.ok(r.n === 0, `0 ОЗ — окна нет: [${r.seen}]`);
    await s.F.update({ "system.attributes.hp.value": s.F.hitPoints.max });
    const t0 = e.since();
    await s.tF.delete(); await wait(500);
    r = await withAnswers(e, [], cast(e, s));
    t.ok(r.n === 0, `нет токена — окна нет: [${r.seen}]`);
    const w = game.messages.contents.filter((x) => x.timestamp >= t0 && /токен|token/i.test(x.content ?? ""));
    t.ok(w.length === 1, `один шёпот про токен: ${w.length}`);
  });

  sc("wf07", "WF07: половина ОЗ — не кандидат, ниже половины — кандидат; Стойкость бросает гоблин, СЛ = СЛ колдовства Фейи", async (e, t) => {
    const s = await setup(e, "WF07");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const max = s.G.hitPoints.max, half = Math.ceil(max / 2);
    await s.G.update({ "system.attributes.hp.value": half });
    let r = await withAnswers(e, [], cast(e, s));
    t.ok(r.n === 0, `${half}/${max} ОЗ — окна нет: [${r.seen}]`);
    await s.G.update({ "system.attributes.hp.value": half - 1 });
    const t0 = e.since();
    r = await withAnswers(e, ["гоблин"], cast(e, s));
    t.ok(r.n >= 1, `${half - 1}/${max} — окно: [${r.seen}]`);
    const card = await waitFor(() => e.msgs(t0).find((x) => e.use(x)?.rule?.onUse?.challenge || e.use(x)?.state?.challenge), 8000);
    const u = e.use(card);
    t.ok(!!card, "карточка испытания");
    t.ok([s.tG.uuid, s.G.uuid].includes(u?.targets?.[0]?.uuid), `бросает гоблин: ${JSON.stringify(u?.targets?.map((x) => x.uuid))}`);
    const dc = s.evil.spellcasting.statistic.withRollOptions({ item: s.evil }).dc.value;
    t.ok((u?.dc?.value ?? u?.dc) === dc, `СЛ ${JSON.stringify(u?.dc)} = СЛ колдовства ${dc}`);
  });

  sc("wf01", "WF01: выбор −1, ChoiceSet эффекта не спрашивает второй раз; selection числом", async (e, t) => {
    const s = await setup(e, "WF01");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const r = await withAnswers(e, ["гоблин", "−1"], cast(e, s));
    t.ok(r.n >= 1, `окна: [${r.seen}]`);
    const eff = await waitFor(() => mine(s.G, FE("0JvxhEv83bAD5PGv"))[0], 6000);
    t.ok(!!eff, `эффект на гоблине: окна=[${r.seen}] fx=[${s.G.itemTypes.effect.map((i) => i.name)}]`);
    const sel = eff?.system.rules.find((x) => x.key === "ChoiceSet")?.selection;
    t.ok(sel === -1, `selection −1 числом: ${JSON.stringify(sel)}`);
    t.ok(s.G.armorClass.modifiers.some((m) => m.type === "status" && m.modifier === -1), `КБ гоблина: status −1 (${s.G.armorClass.modifiers.map((m) => `${m.type}${m.modifier}`)})`);
    t.ok(eff?.system.duration.expiry === "turn-start", `срок: ${JSON.stringify(eff?.system.duration)}`);
  });

  sc("wf09", "WF09: временные ОЗ 2 Фейе (1 ур.), автор эффекта — ведьма", async (e, t) => {
    const s = await setup(e, "WF09");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const r = await withAnswers(e, ["Фейя"], cast(e, s));
    t.ok(r.n >= 1, `окна: [${r.seen}]`);
    const eff = await waitFor(() => mine(s.W, FE("twvhTLrLEfr7dz1m"))[0], 6000);
    t.ok(!!eff, "эффект у Фейи");
    t.ok(s.W.system.attributes.hp.temp === 2, `временные ОЗ: ${s.W.system.attributes.hp.temp}`);
    t.ok(eff?.system.context?.origin?.actor === s.W.uuid, `автор эффекта — ведьма: ${eff?.system.context?.origin?.actor}`);
  });

  sc("wf06", "WF06: союзник у фамильяра (Фейя); срок turn-start, а не родной turn-end", async (e, t) => {
    const s = await setup(e, "WF06");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const r = await withAnswers(e, ["Фейя"], cast(e, s));
    t.ok(r.n >= 1, `окна: [${r.seen}]`);
    const eff = await waitFor(() => mine(s.W, FE("IgLMAwovQ9roTsRN"))[0], 6000);
    t.ok(!!eff, "эффект у Фейи");
    t.ok(eff?.system.duration.expiry === "turn-start", `срок: ${JSON.stringify(eff?.system.duration)}`);
  });

  sc("two-targets", "Две цели сотворения — одно окно способности", async (e, t) => {
    const s = await setup(e, "WF10");
    const g2 = await e.foe("гоблин 2"), tG2 = await e.tok(g2, 700, 600, -1);
    await wait(500);
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    const r = await withAnswers(e, [null, null], cast(e, s, s.evil, s.tG, tG2));
    t.ok(r.n === 1, `окон способности: ${r.n} [${r.seen}]`);
  });

  sc("wf10-sustain", "Поддержание Evil Eye (автоякорь): кнопка «Поддержать» в раунде 2 — окно способности; повтор — без окна; пропуск снимает якорь", async (e, t) => {
    const s = await setup(e, "WF10");
    t.ok(await turnTo(s.c, s.W), "ход Фейи");
    await withAnswers(e, [null], cast(e, s));
    t.ok(!!(await waitFor(() => anchors(s.W).length, 6000)), `автоякорь у Фейи: ${anchors(s.W).map((i) => i.name)}`);
    await next(s.c, "конец хода Фейи"); await next(s.c, "ход гоблина");
    t.ok(s.c.round === 2 && s.c.combatant?.actor?.uuid === s.W.uuid, `раунд 2, ход Фейи: r${s.c.round}`);
    const key = anchors(s.W)[0]?.flags[MOD].meta.key;
    const m = await waitFor(() => game.messages.contents.findLast((x) => x.flags?.[MOD]?.sustain?.key === key), 6000);
    const b = m && await waitFor(() => e.dom(m)?.querySelector('[data-af-sustain="support"]'), 6000);
    t.ok(!!b, `кнопка «Поддержать» видна ГМу (шёпот ${m ? "есть" : "нет"})`);
    if (!b) return;
    let r = await withAnswers(e, [null], async () => { b.click(); await wait(2500); });
    t.ok(r.n === 1, `Поддержание — окно способности: ${r.n}`);
    r = await withAnswers(e, [null], async () => { b.click(); await wait(2500); });
    t.ok(r.n === 0, `повтор в раунде — окна нет: ${r.n}`);
    await next(s.c, "конец хода Фейи (поддержано)"); await next(s.c, "ход гоблина R2"); await next(s.c, "Фейя R3 без Поддержания");
    t.ok(!!(await waitFor(() => !anchors(s.W).length, 6000)), "пропуск снял якорь");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} level1-familiar | ${s.id}`, err); }
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
  window.__afL1FamResult = out;
  return out;
}

