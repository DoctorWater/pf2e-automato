async () => {
  // Живые сценарии zone-trigger (onUse.zone.triggers): спасбросок существа, когда оно входит в область, начинает или заканчивает в ней ход. plan-triggered-save.md, T2.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в repeat-save.js. Область — временный регион сцены «AF тест», поведение вешает api.attachZone (как createRegion).
  // Параметры (перед запуском): window.__afZoneTrigger = { only: ["start-turn", ...], skip: [...], cleanOnly: true }
  // «Триггер сработал» = новое сообщение с flags.pf2e-automato.use.state.event, ключ которого начинается с «trg:» (карточка hostChallenge). Нужны mode.challenge = auto.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afZoneTriggerResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afZoneTrigger ?? {}) };
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

  // ---------- уборка (аварийная: window.__afZoneTrigger = {cleanOnly: true}) ----------
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name)))) await c.delete().catch(() => {});
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
    e.foe = async (name) => {
      const a = await e.add({ ...(await fromUuid(GOBLIN)).toObject(), name });
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
      const c = await Combat.create({ scene: e.scene.id, active: true });
      await c.createEmbeddedDocuments("Combatant", toks.map((t, i) => ({ tokenId: t.id, sceneId: e.scene.id, actorId: t.actor.id, initiative: inits[i] })));
      await viewCombat(c);
      return c;
    };
    /** Прямоугольная область сцены с зоной: триггеры валидируются заранее; поведение вешает attachZone (как runRegion). */
    e.zone = async (rect, triggers, author, extra = {}) => {
      live();
      const rule = { v: 1, onUse: { targets: "area", zone: { duration: { seconds: 600 }, triggers, ...extra }, apply: [] } };
      const v = api().validateRule(rule);
      if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
      const [region] = await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#00aa00", shapes: [{ type: "rectangle", hole: false, x: rect[0], y: rect[1], width: rect[2], height: rect[3], rotation: 0 }], behaviors: [] }]);
      await bound("attachZone", api().attachZone(region, v.rule, { originUuid: "", originActor: author?.uuid ?? "", messageId: "", name: "AF облако" }));
      await wait(500);
      return region;
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

  // ---------- сценарии zone-trigger ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const nextTurn = async (c) => { await bound("nextTurn", c.nextTurn()); await wait(2500); };
  /** Карточки триггеров зоны после t0 (ключ trg:…), по токену цели. */
  const hosts = (e, t0, tok = null) => e.msgs(t0).filter((m) => String(m.flags?.[MOD]?.use?.state?.event ?? "").startsWith("trg:") && (!tok || m.flags[MOD].use.targets?.[0]?.key === tok.id));
  const CH = { statistic: "fortitude", dc: { value: 20 }, basic: false, byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } };
  const IN = [400, 400, 300, 300], OUT = [1500, 500];   // область 3x3 клетки; токен снаружи

  /** Автор-PC (ходит первым), NPC «внутри» (500,500) и NPC «снаружи»; бой начат. */
  const stage = async (e) => {
    openChat(); needMode("mode.challenge", "off");
    const pc = await e.pc("автор"), a = await e.foe("внутри"), b = await e.foe("снаружи");
    const tP = await e.tok(pc, 100, 100, 1), tA = await e.tok(a, 500, 500, -1), tB = await e.tok(b, OUT[0], OUT[1], -1);
    await wait(700);
    const c = await e.combat([tP, tA, tB], [30, 20, 10]);
    await c.startCombat(); await wait(1200);
    return { pc, tP, tA, tB, c };
  };
  const move = async (e, tok, x, y) => {
    const d = e.T(tok);
    if (d.move) await bound("token.move", d.move([{ x, y }], { constrainOptions: { ignoreWalls: true }, autoRotate: false }));
    else await bound("token.update", d.update({ x, y }, { animate: false }));
    await wait(1500);
  };

  sc("start-turn", "Триггер turn-start: NPC в области в начале хода бросает, вне области — нет", async (e, t) => {
    const { pc, tA, tB, c } = await stage(e);
    await e.zone(IN, [{ on: "turn-start", challenge: CH }], pc);
    await e.fix(1);
    const t0 = e.since();
    await nextTurn(c);   // ход «внутри»
    t.ok(hosts(e, t0, tA).length === 1, `внутри: одна карточка (${hosts(e, t0, tA).length})`);
    t.ok(!!e.cond(e.A(tA), "sickened") || ["failure", "criticalFailure"].includes(e.results(hosts(e, t0, tA)[0])?.[tA.id]), `бросок провален (d20=1): ${e.results(hosts(e, t0, tA)[0])?.[tA.id]}`);   // d20=1 — крит. провал
    await nextTurn(c);   // ход «снаружи»
    t.ok(hosts(e, t0, tB).length === 0, `снаружи: карточек нет (${hosts(e, t0, tB).length})`);
  });

  sc("enter-move", "Триггер enter: вход движением — бросок (одна карточка), создание области поверх токена — без броска", async (e, t) => {
    const { pc, tA, tB, c } = await stage(e);
    const t0 = e.since();
    await e.zone(IN, [{ on: "enter", challenge: CH }], pc);   // регион создан поверх «внутри»: movement == null, это не вход
    t.ok(hosts(e, t0).length === 0, `создание поверх токена: карточек нет (${hosts(e, t0).length})`);
    await e.fix(1);
    await move(e, tB, 500, 600);
    t.ok(await waitFor(() => hosts(e, t0, tB).length === 1, 8000), `вход движением: карточка (${hosts(e, t0, tB).length})`);
    await move(e, tB, 1500, 600);   // вышел и зашёл снова — ещё одна (per не задан)
    await move(e, tB, 500, 600);
    t.ok(await waitFor(() => hosts(e, t0, tB).length === 2, 8000), `повторный вход: вторая карточка (${hosts(e, t0, tB).length})`);
    t.ok(hosts(e, t0, tA).length === 0, "стоящий внутри токен карточек не получил");
  });

  sc("per-round", "per:round — вход и конец хода в одном раунде дают один бросок, в следующем раунде — снова", async (e, t) => {
    const { pc, tB, c } = await stage(e);
    await e.zone(IN, [{ on: "enter", per: "round", challenge: CH }, { on: "turn-end", per: "round", challenge: CH }], pc);
    await e.fix(1);
    const t0 = e.since();
    await move(e, tB, 500, 600);   // раунд 1, ход автора
    t.ok(await waitFor(() => hosts(e, t0, tB).length === 1, 8000), "вход: карточка");
    await nextTurn(c); await nextTurn(c);   // ход «внутри», ход «снаружи» (он в области)
    await nextTurn(c);                      // конец хода «снаружи» раунда 1
    t.ok(hosts(e, t0, tB).length === 1, `конец хода в том же раунде: без второй (${hosts(e, t0, tB).length})`);
    await nextTurn(c); await nextTurn(c); await nextTurn(c);   // раунд 2: автор, «внутри», «снаружи», конец его хода
    t.ok(await waitFor(() => hosts(e, t0, tB).length === 2, 8000), `раунд 2: вторая карточка (${hosts(e, t0, tB).length})`);
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} zone-trigger | ${s.id}`, err); }
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
  window.__afZoneTriggerResult = result;
  return result;
}
