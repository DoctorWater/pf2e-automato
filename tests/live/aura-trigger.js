async () => {
  // Живые сценарии aura-trigger (onEvent side:"near"): спасбросок от ауры носителя при входе в неё и в начале/конце хода внутри. plan-triggered-save.md, T3.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в zone-trigger.js. Носитель — NPC «AF тест: …» с флаг-правилом на временной способности (и Aura RE pf2e для сценариев с aura); жертва — PC или NPC союзной стороны.
  // Параметры (перед запуском): window.__afAuraTrigger = { only: ["enter-once", ...], skip: [...], cleanOnly: true }; id: enter-once, turn-end-per, outcomes, range, carrier-moves
  // «Триггер сработал» = новое сообщение с flags.pf2e-automato.use.state.event, ключ которого начинается с «trg:» (карточка hostChallenge). Нужны mode.challenge = auto.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afAuraTriggerResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afAuraTrigger ?? {}) };
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
  const api = () => game.modules.get(MOD).api;
  const setting = (k) => game.settings.get(MOD, k);

  // ---------- уборка (аварийная: window.__afAuraTrigger = {cleanOnly: true}) ----------
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name) || test(game.scenes.get(x.sceneId)?.name)))) await c.delete().catch(() => {});
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const sceneIds = new Set(scenes.map((s) => s.id));
    const msgIds = new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene)).map((m) => m.id)]);
    const ids = [...msgIds].filter((id) => game.messages.has(id));
    if (ids.length) await ChatMessage.deleteDocuments(ids).catch(() => {});
    for (const s of scenes) await s.delete().catch(() => {});   // регионы и их поведения уходят вместе со сценой
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
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };

  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    const idx = await p.getIndex({ fields: ["system.slug"] });
    const e = idx.find((i) => i.system?.slug === slug);
    if (!e) throw new Error(`нет в ${pack}: ${slug}`);
    return (await p.getDocument(e._id)).toObject();
  };
  const GOBLIN = "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4";

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна: наши .paf-dialog закрываются (отмена); окна бросков pf2e — жмём «Бросок»
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          e.dialogs.push(el.querySelector(".window-title")?.textContent?.trim() ?? el.id);
          foundry.applications.instances.get(el.id)?.close();
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
    e.foe = async (name, extra = {}) => {
      const a = await e.add({ ...foundry.utils.mergeObject((await fromUuid(GOBLIN)).toObject(), extra), name });
      await a.update({ "system.attributes.hp.value": a.hitPoints.max });
      return a;
    };
    e.pc = async (name) => {
      const a = await e.add({ name, type: "character", system: { details: { alliance: "party", languages: { value: ["common"] } } } });
      await a.createEmbeddedDocuments("Item", [await find("pf2e.ancestries", "human")]);
      await a.update({ "system.attributes.hp.value": a.hitPoints.max });
      return a;
    };
    e.tok = async (a, x, y, disposition) => {
      live();
      const [t] = await e.scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition }]);
      return t;
    };
    e.T = (t) => e.scene.tokens.get(t.id);
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: проверки — на этом актёре
    e.fix = async (n) => {
      if (n != null) live();
      if (e.d20 === null) e.d20 = CONFIG.Dice.randomUniform;
      CONFIG.Dice.randomUniform = n == null ? e.d20 : () => 1 - (n - 0.5) / 20;
      if (n != null && (await new Roll("1d20").evaluate()).total !== n) throw new Skip("не удалось зафиксировать d20 (CONFIG.Dice.randomUniform)");
    };
    e.since = () => Date.now();
    e.msgs = (t0) => game.messages.contents.filter((m) => m._stats.createdTime >= t0);
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.results = (m) => Object.fromEntries(Object.entries(e.use(m)?.state?.challenge?.results ?? {}).map(([k, v]) => [k, deg(v.degree)]));
    e.cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug) ?? null;
    e.combat = async (toks, inits) => {
      live();
      const c = await Combat.create({ active: true });
      await c.createEmbeddedDocuments("Combatant", toks.map((t, i) => ({ tokenId: t.id, sceneId: e.scene.id, actorId: t.actor.id, initiative: inits[i] })));
      await viewCombat(c);
      return c;
    };
    e.dispose = async () => {
      e.dead = true; e.stop = true;
      Hooks.off("createChatMessage", hook);
      try { await e.fix(null); } catch { /* ok */ }
      document.querySelectorAll(".paf-dialog").forEach((el) => foundry.applications.instances.get(el.id)?.close());
      const left = await sweep([...e.tracked]);
      await viewCombat(prevCombat);
      return left;
    };
    return e;
  };

  // ---------- сценарии aura-trigger ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const nextTurn = async (c) => { await bound("nextTurn", c.nextTurn()); await wait(2500); };
  /** Карточки триггеров ауры после t0 (ключ trg:…), по токену цели. */
  const hosts = (e, t0, tok = null) => e.msgs(t0).filter((m) => String(m.flags?.[MOD]?.use?.state?.event ?? "").startsWith("trg:") && (!tok || m.flags[MOD].use.targets?.[0]?.key === tok.id));
  const AURA_SLUG = "af-fear-aura", RADIUS = 30;   // 30 фт = зазор 6 клеток по 100 px
  const IN = [1400, 1000], OUT = [2000, 1000], BOSS = [1000, 1000];   // IN: зазор 3 клетки (20 фт), OUT: 9 клеток (50 фт)
  const FEAR = (extra = {}) => ({
    statistic: "will", dc: { value: 15 }, basic: false,   // d20=20 проходит у любого гоблина, d20=1 проваливает
    immunity: { slug: AURA_SLUG, duration: { value: 1, unit: "minutes" }, degrees: ["success", "criticalSuccess"], ...(extra.immunity ?? {}) },
    byDegree: { failure: [{ to: "target", who: "enemy", condition: { slug: "frightened", value: 1 } }], criticalFailure: [{ to: "target", who: "enemy", condition: { slug: "frightened", value: 2 } }] }
  });
  /** Предмет-носитель: правило флагом (мировой каталог не трогаем), по желанию Aura RE pf2e с тем же slug. */
  const carrierItem = (entries, withAura) => {
    const rule = { v: 1, onEvent: entries };
    const v = api().validateRule(rule);
    if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
    return { type: "action", name: `${PFX}аура страха`, system: { slug: "af-test-fear-aura", actionType: { value: "passive" }, description: { value: "<p>тест</p>" }, rules: withAura ? [{ key: "Aura", slug: AURA_SLUG, radius: RADIUS, effects: [] }] : [] }, flags: { [MOD]: { rule: v.rule } } };
  };
  const NEAR = (o) => ({ side: "near", challenge: FEAR(), ...o });

  /** NPC-носитель с аурой (враг, ходит первым), жертва (PC или NPC, союзник игроков) снаружи; бой начат. victim: "pc" | "foe". */
  const stage = async (e, entries, { withAura = true, victim = "pc", inside = false } = {}) => {
    openChat(); needMode("mode.challenge", "off");
    const boss = await e.foe("носитель"), vic = await (victim === "pc" ? e.pc("жертва") : e.foe("жертва", { system: { details: { alliance: "party" } } }));
    const tB = await e.tok(boss, BOSS[0], BOSS[1], -1), tV = await e.tok(vic, ...(inside ? IN : OUT), 1);
    await wait(700);
    await e.A(tB).createEmbeddedDocuments("Item", [carrierItem(entries, withAura)]);   // актёр токена: у NPC копия несвязанная
    if (withAura && !(await waitFor(() => e.T(tB).object?.auras?.has(AURA_SLUG), 8000))) throw new Skip("Aura RE pf2e не создала ауру на токене (token.auras)");
    const c = await e.combat([tB, tV], [30, 20]);
    await c.startCombat(); await wait(1200);
    return { boss, vic, tB, tV, c };
  };
  const move = async (e, tok, x, y) => {
    const d = e.T(tok);
    if (d.move) await bound("token.move", d.move([{ x, y }], { constrainOptions: { ignoreWalls: true }, autoRotate: false }));
    else await bound("token.update", d.update({ x, y }, { animate: false }));
    await wait(1500);
  };
  /** Диагностика в detail: ключи карточек, раунд/ход, исходы и состояния жертвы. */
  const diag = (e, t0, tV, c) => `[раунд ${c.round}/ход ${c.turn}; карточки: ${hosts(e, t0, tV).map((m) => `${m.flags[MOD].use.state.event.replace(/^trg:[^:]*:/, "")} ${JSON.stringify(e.results(m))}`).join(" | ")}; состояния: ${[...e.A(tV).itemTypes.condition].map((x) => `${x.slug}${x.value ?? ""}`)}; эффекты: ${e.A(tV).itemTypes.effect.map((x) => x.slug)}; mode challenge=${setting("mode.challenge")} apply=${setting("mode.apply")}]`;
  const immune = (a) => a.items.some((i) => i.type === "effect" && i.flags?.[MOD]?.immunity?.slug === AURA_SLUG);

  sc("enter-once", "enter: PC входит в ауру — одна карточка; выход и вход в том же раунде (per:round) — без второй", async (e, t) => {
    const { tV } = await stage(e, [NEAR({ on: "enter", aura: AURA_SLUG, per: "round" }), NEAR({ on: "turn-end", aura: AURA_SLUG, per: "round" })]);
    const t0 = e.since();
    await move(e, tV, ...IN);
    t.ok(await waitFor(() => hosts(e, t0, tV).length === 1, 8000), `вход: одна карточка (${hosts(e, t0, tV).length})`);
    await move(e, tV, ...OUT); await move(e, tV, ...IN);
    t.ok(hosts(e, t0, tV).length === 1, `вышел и зашёл в том же раунде: без второй (${hosts(e, t0, tV).length})`);
  });

  sc("turn-end-per", "per:round: конец хода внутри в том же раунде, что и вход — повтора нет; следующий раунд — снова", async (e, t) => {
    const { tV, c } = await stage(e, [NEAR({ on: "enter", aura: AURA_SLUG, per: "round" }), NEAR({ on: "turn-end", aura: AURA_SLUG, per: "round" })]);
    await e.fix(1);                          // провал: успех дал бы иммунитет, и раунд 2 молчал бы
    const t0 = e.since();
    await move(e, tV, ...IN);                // раунд 1, ход носителя
    t.ok(await waitFor(() => hosts(e, t0, tV).length === 1, 8000), "вход: карточка");
    await nextTurn(c); await nextTurn(c);    // ход жертвы раунда 1 и его конец (внутри)
    t.ok(hosts(e, t0, tV).length === 1, `конец хода внутри в том же раунде: повтора нет (${hosts(e, t0, tV).length}) ${diag(e, t0, tV, c)}`);
    await nextTurn(c); await nextTurn(c);    // раунд 2: ход носителя, ход жертвы и его конец
    t.ok(await waitFor(() => hosts(e, t0, tV).length === 2, 8000), `раунд 2: снова одна карточка (${hosts(e, t0, tV).length}) ${diag(e, t0, tV, c)}`);
  });

  sc("outcomes", "провал — испуг и карточка снова в следующем раунде; успех — иммунитет и тишина", async (e, t) => {
    const { tV, c } = await stage(e, [NEAR({ on: "turn-end", aura: AURA_SLUG, per: "round" })], { victim: "foe", inside: true });
    needMode("mode.apply", "off", "button"); needMode("mode.challenge", "button");   // NPC бросает сам и степени применяются сами только в auto
    const t0 = e.since();
    await e.fix(1);                          // провал
    await nextTurn(c); await nextTurn(c);    // конец хода жертвы, раунд 1
    t.ok(await waitFor(() => hosts(e, t0, tV).length === 1, 8000), "карточка");
    t.ok(await waitFor(() => !!e.cond(e.A(tV), "frightened"), 8000), `провал: испуг ${diag(e, t0, tV, c)}`);
    t.ok(!immune(e.A(tV)), "после провала иммунитета нет");
    const ch1 = hosts(e, t0, tV)[0]?.flags?.[MOD]?.use?.state?.challenge; t.ok(ch1 && Object.keys(ch1.results ?? {}).length > 0, `NPC бросил по карточке: результаты ${JSON.stringify(ch1?.results)}`);
    await e.cond(e.A(tV), "frightened")?.delete();
    await e.fix(20);                         // успех
    await nextTurn(c); await nextTurn(c);    // раунд 2: ход носителя, конец хода жертвы
    t.ok(await waitFor(() => hosts(e, t0, tV).length === 2, 8000), "раунд 2: вторая карточка");
    t.ok(await waitFor(() => immune(e.A(tV)), 8000), `успех: иммунитет к ауре (эффект с flags.immunity.slug) ${diag(e, t0, tV, c)}`);
    await nextTurn(c); await nextTurn(c);    // раунд 3
    t.ok(hosts(e, t0, tV).length === 2, `после иммунитета тишина (${hosts(e, t0, tV).length}) ${diag(e, t0, tV, c)}`);
  });

  sc("range", "range без Aura RE: вход внутрь 20 фт — карточка, остановка снаружи (50 фт) — нет", async (e, t) => {
    const { tV } = await stage(e, [NEAR({ on: "enter", range: 30 })], { withAura: false });
    const t0 = e.since();
    await move(e, tV, 1800, 1000);           // зазор 7 клеток = 40 фт — снаружи
    t.ok(hosts(e, t0, tV).length === 0, `остановился снаружи: карточек нет (${hosts(e, t0, tV).length})`);
    await move(e, tV, ...IN);
    t.ok(await waitFor(() => hosts(e, t0, tV).length === 1, 8000), `вошёл в 30 фт: карточка (${hosts(e, t0, tV).length})`);
  });

  sc("carrier-moves", "enter: носитель подходит к стоящей жертве — карточка жертве", async (e, t) => {
    const { tB, tV } = await stage(e, [NEAR({ on: "enter", aura: AURA_SLUG })], { victim: "foe" });
    const t0 = e.since();
    await move(e, tB, 1500, 1000);           // жертва на OUT (2000): зазор 4 клетки = 25 фт, был 9 клеток
    t.ok(await waitFor(() => hosts(e, t0, tV).length === 1, 8000), `носитель подошёл: карточка жертве (${hosts(e, t0, tV).length})`);
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} aura-trigger | ${s.id}`, err); }
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
  const table = rows.map((r) => `${r.id.padEnd(18)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afAuraTriggerResult = result;
  return result;
}
