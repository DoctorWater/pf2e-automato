async () => {
  // Живой сценарий полёта «на перемещение» (Встать на крыло, Zip! Zoom!): копия «AF тест: Дракончик» из мира RustySpirit, тестовая сцена создаётся и удаляется.
  // Проверяется: переключателя нет; после использования fly 15 (25 с Zip! Zoom!); после перемещения токена эффект снят (в бою и вне боя); строка про падение в карточке.
  // Параметры: window.__afTM = { only, cleanOnly }. Результат — window.__afTMResult. Нужен активный ГМ (эффект кладёт он).
  const MOD = "pf2e-automato", PFX = "AF тест: ", DRAGON = "H6SR8fVSVCHrKOyZ";
  const opts = { only: null, ...(window.__afTM ?? {}) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000, step = 150) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(step); }
    return null;
  };
  class Skip extends Error {}
  const bound = (label, p, ms = 30000) => {
    let tm;
    return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`завис шаг «${label}» (>${ms / 1000} с)`)), ms); })]).finally(() => clearTimeout(tm));
  };

  // ---------- уборка (аварийная: window.__afTM = {cleanOnly: true}) ----------
  const test = (n) => typeof n === "string" && n.startsWith(PFX);
  const killCombat = async (c) => {
    for (let i = 0; i < 3 && game.combats.has(c.id); i++) { await game.combats.get(c.id).delete().catch((err) => console.warn("combat delete", c.id, err)); if (game.combats.has(c.id)) await wait(800); }
  };
  const sweep = async (extraMsgIds = []) => {
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name)))) await killCombat(c);
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id)), sceneIds = new Set(scenes.map((s) => s.id));
    const ids = [...new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene)).map((m) => m.id)])].filter((id) => game.messages.has(id));
    if (ids.length) await ChatMessage.deleteDocuments(ids).catch(() => {});
    for (const s of scenes) await s.delete().catch(() => {});
    for (const a of game.actors.filter((a) => test(a.name))) await a.delete().catch(() => {});
    return game.actors.filter((a) => test(a.name)).length + game.scenes.filter((s) => test(s.name)).length;
  };
  if (opts.cleanOnly) return { left: await sweep() };

  const prevScene = game.scenes.viewed, prevCombat = game.combats.viewed;
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };

  const idx = {};
  const find = async (pack, slug) => {
    const p = game.packs.get(pack);
    if (!p) throw new Error(`нет пака ${pack}`);
    idx[pack] ??= await p.getIndex({ fields: ["system.slug"] });
    const e = idx[pack].find((i) => i.system?.slug === slug);
    if (!e) throw new Skip(`нет в ${pack}: ${slug}`);
    const o = (await p.getDocument(e._id)).toObject(); delete o._id;
    return o;
  };

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { id, tracked: new Set() };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    e.hero = async (...feats) => {
      const h = game.actors.get(DRAGON);
      if (!h) throw new Skip(`нет героя ${DRAGON}`);
      const d = h.toObject(); delete d._id; delete d.folder;
      const a = await Actor.create({ ...d, name: PFX + h.name, folder: null, ownership: { default: 0 } });
      await a.createEmbeddedDocuments("Item", await Promise.all(feats.map((s) => find("pf2e.feats-srd", s))));
      return a;
    };
    e.tok = async (a, x, y) => {
      const [t] = await e.scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition: 1 }]);
      return t;
    };
    e.combat = async (tok) => {   // единственный участник: его ход после startCombat
      const c = await Combat.create({ scene: e.scene.id, active: true });
      await c.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, sceneId: e.scene.id, actorId: tok.actor.id, initiative: 20 }]);
      await viewCombat(c); await c.startCombat(); await wait(1200);
      return c;
    };
    e.dispose = async () => {
      await wait(2500);
      for (const c of game.combats.filter((c) => c.scene?.id === e.scene.id || c.combatants.some((x) => x.sceneId === e.scene.id))) await killCombat(c);
      if (prevScene && prevScene.id !== e.scene.id && game.scenes.has(prevScene.id)) { await prevScene.view().catch(() => {}); await wait(1000); }
      Hooks.off("createChatMessage", hook);
      const left = await sweep([...e.tracked]);
      await viewCombat(prevCombat);
      return left;
    };
    return e;
  };

  const toggles = (a, o) => Object.values(a.synthetics.toggles ?? {}).flatMap((d) => Object.keys(d)).filter((x) => x === o);
  const fly = (a) => a.system.movement.speeds.fly?.value ?? null;
  const effOf = (a, name) => a.itemTypes.effect.filter((i) => i.name === name);
  /** Использование путём pf2e (списание частоты, карточка) -> карточка. */
  const useAction = async (e, item) => {
    const t0 = Date.now();
    await bound("rollItemMacro", game.pf2e.rollItemMacro(item.uuid));
    return waitFor(() => game.messages.contents.find((m) => m._stats.createdTime >= t0 && m.flags?.pf2e?.origin?.uuid === item.uuid), 8000);
  };
  const move = async (e, tok, x, y, action) => {
    const d = e.scene.tokens.get(tok.id);
    await bound("token.move", d.move([{ x, y, ...(action && { action }) }], { constrainOptions: { ignoreWalls: true }, autoRotate: false }));
    await wait(1500);
  };

  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  /** Общая часть: переключателя нет, до использования fly нет, после — эффект с названием предмета и fly = speed, в карточке падение. */
  const useAndCheck = async (e, t, A, slug, speed) => {
    const item = A.items.find((i) => i.system.slug === slug);
    t.ok(!!item, `есть ${slug}`);
    t.ok(toggles(A, slug).length === 0, `переключателя ${slug} нет в synthetics.toggles (${toggles(A, slug)})`);
    t.ok(fly(A) === null, `до использования нет полёта (${fly(A)})`);
    const m = await useAction(e, item);
    t.ok(!!m, "карточка использования создана");
    await waitFor(() => effOf(A, item.name).length, 8000);
    t.ok(effOf(A, item.name).length === 1, `эффект «${item.name}» на актёре (${effOf(A, item.name).length})`);
    t.ok(await waitFor(() => fly(A) === speed, 4000), `fly = ${speed} (${fly(A)})`);
    t.ok(toggles(A, slug).length === 0, "переключателя нет и после использования");
    t.ok(!!m && m.content.includes(game.i18n.localize("PF2E_AUTOMATO.builtin.flight.fall")), "в карточке напоминание о падении");
    return item;
  };

  sc("take-wing", "В бою: Встать на крыло — fly 15; после перемещения эффект снят", async (e, t) => {
    const a = await e.hero("take-wing"), tk = await e.tok(a, 500, 500);
    await e.combat(tk);
    const A = e.scene.tokens.get(tk.id).actor, item = await useAndCheck(e, t, A, "take-wing", 15);
    await move(e, tk, 700, 500);
    t.ok(await waitFor(() => !effOf(A, item.name).length, 6000), "после перемещения эффект снят");
    t.ok(await waitFor(() => fly(A) === null, 3000), `fly снят (${fly(A)})`);
  });

  sc("zip-zoom", "В бою: Встать на крыло + Zip! Zoom! — fly 25; перемещение полётом снимает эффект", async (e, t) => {
    const a = await e.hero("take-wing", "zip-zoom"), tk = await e.tok(a, 500, 500);
    await e.combat(tk);
    const A = e.scene.tokens.get(tk.id).actor, item = await useAndCheck(e, t, A, "take-wing", 25);
    await move(e, tk, 800, 500, "fly");
    t.ok(await waitFor(() => !effOf(A, item.name).length, 6000), "после перемещения полётом эффект снят");
  });

  sc("no-combat", "Вне боя: эффект висит до первого перемещения", async (e, t) => {
    const a = await e.hero("take-wing"), tk = await e.tok(a, 500, 500);
    const A = e.scene.tokens.get(tk.id).actor, item = await useAndCheck(e, t, A, "take-wing", 15);
    await wait(2500);
    t.ok(effOf(A, item.name).length === 1, "без перемещения эффект остался");
    await move(e, tk, 700, 500);
    t.ok(await waitFor(() => !effOf(A, item.name).length, 6000), "после первого перемещения эффект снят");
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => !opts.only || opts.only.includes(s.id));
  try {
    for (const s of pick) {
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0;
      try {
        e = await newEnv(s.id);
        await Promise.race([s.run(e, t), new Promise((_, rej) => setTimeout(() => rej(new Error("таймаут 120 с")), 120000))]);
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} turn-movement | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 4).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afTMResult = out;
  return out;
}
