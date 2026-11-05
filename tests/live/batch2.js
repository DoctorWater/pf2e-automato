async () => {
  // Живые сценарии новых форм пачки 2 (правила — из каталога модуля по uuid документа b02-self-ally-effects, confidence model; предметы ставятся копией из компендиума с _stats.compendiumSource).
  //  strike-hit-effect — Toxic Touch (Exception 2b, onEvent attack-roll afterUse без испытания): промах — пусто; попадание — persistent poison 1d6 и sickened 1 у цели.
  //  strike-hit-move   — Clobber (шаг move при Ударе): попадание — толчок на 5 фт (600 -> 700) и prone; промах — цель на месте.
  //  policy-add        — Fuel Impossible Spell (condition policy add): doomed 1, затем 2.
  //  policy-reduce     — Piercing Doom (policy reduce на попадание Ударом): doomed 2 -> 1 -> снят; промах не снижает.
  //  remove-condition  — Instant Recovery (removeCondition): fatigued снят.
  //  allies            — Song of Grace and Speed (to allies, range 30, срок 1 минута): бард и союзник рядом — quickened; союзник в 50 фт и враг — нет.
  // Пропущены: срок по рангу/уровню и onEvent вне afterUse — среди принятых model-правил b02 их нет (формы 6 и 7: последняя покрыта strike-hit-effect/policy-reduce — это onEvent без испытания).
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Прогон ставит mode.effect/apply/challenge (мировые) = auto; прежние значения — в window.__afBatch2ModesPrev, возвращаются в конце и при cleanOnly. Пишет в мир только «AF тест: …», всё убирает.
  // Параметры: window.__afBatch2 = { only: ["allies", ...], skip: [...], cleanOnly: true }. Результат: { summary, table, rows:[{id,title,status,detail}] } и window.__afBatch2Result.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afBatch2 ?? {}) };
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
  // pf2e: shift ИНВЕРТИРУЕТ настройку show*Dialogs; прогон ставит их в false, поэтому shift нужен только если окна включены (см. strike-gate.js)
  const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });
  const api = () => game.modules.get(MOD).api;
  const setting = (k) => game.settings.get(MOD, k);

  // ---------- уборка (аварийная: window.__afBatch2 = {cleanOnly: true}) ----------
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
  if (opts.cleanOnly) {
    for (const [k, v] of Object.entries(window.__afBatch2ModesPrev ?? {})) await game.settings.set(MOD, k, v).catch(() => {});
    delete window.__afBatch2ModesPrev;
    return { left: await sweep() };
  }

  // ---------- общее окружение прогона ----------
  const prevScene = game.scenes.viewed, prevCombat = game.combats.viewed;
  const pfSet = game.user.flags.pf2e?.settings ?? {};
  const origFlags = { showCheckDialogs: pfSet.showCheckDialogs, showDamageDialogs: pfSet.showDamageDialogs };
  const tbPrev = game.settings.get(MOD, "useToolbeltTargetHelper");
  const MODES = ["mode.effect", "mode.apply", "mode.challenge"], modesPrev = window.__afBatch2ModesPrev ?? Object.fromEntries(MODES.map((k) => [k, game.settings.get(MOD, k)]));
  window.__afBatch2ModesPrev = modesPrev;   // обрыв прогона: cleanOnly вернёт режимы
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 160)}`); return nOrig[k].call(this, m, ...r); };
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
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null, pick: null };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна: наши .paf-dialog: e.pick = подпись варианта choose (или data-action кнопки), иначе закрываются (отмена); ChoiceSet pf2e — первый вариант; окна бросков pf2e — жмём «Бросок»
    const seen = new Set();
    (async () => {
      while (!e.stop) {
        for (const el of document.querySelectorAll(".paf-dialog")) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          const opts = [...(el.querySelector("select[name=choice]")?.options ?? [])].map((o) => o.textContent.trim()), acts = [...el.querySelectorAll("button[data-action]")].map((b) => b.dataset.action);
          e.dialogs.push(`${el.querySelector(".window-title")?.textContent?.trim() ?? el.id}: ${opts.length ? opts.join(" / ") : acts.join(" / ")}`);
          // окно choose модуля — список <select name=choice> + «ok» (apply.mjs choiceHtml): e.pick — подпись варианта; иначе кнопка data-action
          const sel = el.querySelector("select[name=choice]"), o = sel && e.pick != null ? [...sel.options].find((x) => x.textContent.includes(e.pick)) : null;
          const b = !sel && e.pick != null ? el.querySelector(`button[data-action="${e.pick}"]`) : null;
          if (o) { sel.value = o.value; el.querySelector("button[data-action=ok]")?.click(); } else if (b) b.click(); else foundry.applications.instances.get(el.id)?.close();
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
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: проверки и выдача предметов — на этом актёре
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
    e.use = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.use;
    e.cond = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug) ?? null;
    e.strike = (a) => a.system.actions.find((s) => s.item?.isMelee);
    /** Копия документа из компендиума по uuid; _stats.compendiumSource ставится явно — по нему модуль находит правило каталога. */
    e.catalog = async (actor, uuid, patch = (d) => d) => {
      live();
      const doc = await fromUuid(uuid).catch(() => null);
      if (!doc) throw new Skip(`нет в паках: ${uuid}`);
      const d = doc.toObject(); delete d._id;
      d._stats = { ...d._stats, compendiumSource: uuid };
      const [it] = await actor.createEmbeddedDocuments("Item", [patch(d)]);
      const r = api().resolveRule(it);
      if (r?.source !== "catalog") throw new Skip(`source=${r?.source}`);
      return it;
    };
    /** Карточка предмета в чате (со снимком use модуля) -> сообщение; DOM блока модуля виден. */
    e.card = async (item) => {
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid && x.flags?.[MOD]?.use), 10000);
      if (!m) throw new Error(`у карточки «${item.name}» нет снимка use (правило не найдено или модуль не слушает)`);
      await waitFor(() => e.dom(m)?.querySelector(".pf2e-automato"), 6000);
      return game.messages.get(m.id);
    };
    /** Предмет-действие с правилом -> карточка модуля со снимком use после done. */
    e.fire = async (item, att, ...targets) => {
      await e.aim(att, ...targets);
      const m = await e.card(item);
      if (e.use(m).src !== "catalog") throw new Skip(`снимок use: src=${e.use(m).src}`);
      if (e.use(m).state?.yielded) throw new Skip(`правило уступает pf2e-automations (${e.use(m).state.yielded})`);
      await waitFor(() => e.use(m)?.state?.done, 10000);
      return game.messages.get(m.id);
    };
    /** Только карточка предмета (pf2e-сообщение с origin) — для afterUse снимок use не нужен. */
    e.pf2eCard = async (item, att, ...targets) => {
      await e.aim(att, ...targets);
      const t0 = e.since();
      await bound("item.toMessage", item.toMessage(undefined, { create: true }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.origin?.uuid === item.uuid), 8000);
      if (!m) throw new Error(`карточка «${item.name}» не появилась в чате`);
      await wait(700);   // timestamp карточки строго раньше броска
      return m;
    };
    e.hit = async (att, def) => {   // первый ближний Удар att по токену def; сообщение атаки
      await e.aim(att, def);
      const t0 = e.since(), s = e.strike(e.A(att));
      if (!s) throw new Error("у атакующего нет ближнего Удара");
      await bound("бросок Удара (variants[0].roll)", s.variants[0].roll({ event: SHIFT() }));
      return waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "attack-roll"), 8000);
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
  const openChat = () => { try { ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  const needMode = (k, ...bad) => { if (bad.includes(setting(k))) throw new Skip(`настройка ${k} = ${setting(k)}`); };
  const OK_DEG = ["success", "criticalSuccess"];
  const outcome = (m) => m?.flags?.pf2e?.context?.outcome;
  /** Подкрутка бонуса атаки: при d20=10 итог = КЗ+2 (попал, не крит), при d20=1 — промах (как в strike-gate.js). */
  const rigTo = async (e, att, def) => {
    const s = e.strike(e.A(att)), ac = e.A(def).attributes.ac.value;
    if (!s || !Number.isFinite(s.totalModifier)) throw new Skip("у Удара нет totalModifier (pf2e изменил API)");
    await e.rig(e.A(att), "attack-roll", ac + 2 - 10 - s.totalModifier);
  };
  const swing = async (e, att, def, d20) => {
    await e.fix(d20);
    const m = await e.hit(att, def);
    if (!m) throw new Error("сообщение атаки не появилось");
    await wait(2500);
    return m;
  };

  const cond2 = (a) => [...a.itemTypes.condition].map((x) => `${x.slug}${x.value ?? ""}`).join(",") || "—";
  const U = (n) => `Compendium.pf2e.${n}`;
  const TOXIC = U("actionspf2e.Item.Rp7gcG6Mxasurr8o"), CLOBBER = U("feats-srd.Item.nV9ykcwI4lSmD2PV"), FUEL = U("actionspf2e.Item.N9b6ZB71ssE1gGYJ"),
    DOOM = U("feats-srd.Item.4bKTV1UHBP3qSjzr"), RECOVERY = U("actionspf2e.Item.8UJaVPsT5FA8XH87"), SONG = U("feats-srd.Item.WoUwDqhA6i6abwen");
  const needApply = openChat;
  const pers = (a) => a.itemTypes.condition.find((c) => c.slug === "persistent-damage");
  /** Карточка предмета и Удар по цели с заданным d20; возвращает сообщение атаки. */
  const cardSwing = async (e, item, att, def, d20) => { await e.pf2eCard(item, att, def); return swing(e, att, def, d20); };

  sc("strike-hit-effect", "Toxic Touch (strikeHit, onEvent afterUse): промах — ничего; попадание — persistent poison 1d6 и sickened 1 у цели", async (e, t) => {
    needApply();
    const pc = await e.pc("атакующий"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const item = await e.catalog(e.A(tP), TOXIC);
    await rigTo(e, tP, tV);
    const m1 = await cardSwing(e, item, tP, tV, 1);
    t.ok(!OK_DEG.includes(outcome(m1)), `Удар промахнулся (${outcome(m1)})`);
    t.ok(!pers(e.A(tV)) && !e.cond(e.A(tV), "sickened"), `после промаха пусто [${cond2(e.A(tV))}]`);
    const m2 = await cardSwing(e, item, tP, tV, 10);
    t.ok(outcome(m2) === "success", `Удар попал не критом (${outcome(m2)})`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tV), "sickened")?.value === 1, 8000)), `sickened 1 у цели [${cond2(e.A(tV))}]`);
    const p = pers(e.A(tV));
    t.ok(p?.system?.persistent?.damageType === "poison" && /1d6/.test(String(p.system.persistent.formula ?? p.system.persistent.damage?.formula ?? JSON.stringify(p.system.persistent))), `persistent poison 1d6: ${JSON.stringify(p?.system?.persistent)}`);
    t.ok(!e.cond(e.A(tP), "sickened"), "у автора sickened нет");
  });

  sc("strike-hit-move", "Clobber (шаг move при Ударе): промах — цель на месте; окно choose «do» — толчок на 5 фт (600 -> 700) и prone; «no» — без толчка, prone есть", async (e, t) => {
    needApply();
    const pc = await e.pc("атакующий"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const item = await e.catalog(e.A(tP), CLOBBER);
    await rigTo(e, tP, tV);
    const m1 = await cardSwing(e, item, tP, tV, 1);
    t.ok(!OK_DEG.includes(outcome(m1)) && e.T(tV).x === 600 && !e.cond(e.A(tV), "prone"), `после промаха цель на месте: x=${e.T(tV).x} [${cond2(e.A(tV))}]`);
    e.pick = "Толкнуть цель";   // окно choose: толкнуть (подпись варианта)
    const m2 = await cardSwing(e, item, tP, tV, 10);
    t.ok(outcome(m2) === "success", `Удар попал не критом (${outcome(m2)})`);
    t.ok(!!(await waitFor(() => e.T(tV).x === 700 && e.T(tV).y === 500, 8000)), `«do»: толчок на 5 фт: позиция (${e.T(tV).x},${e.T(tV).y})`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tV), "prone"), 6000)), `«do»: цель prone [${cond2(e.A(tV))}]`);
    await e.T(tV).update({ x: 600 }); await e.A(tV).decreaseCondition("prone", { forceRemove: true }); await wait(700);
    e.pick = "Не толкать";   // окно choose: не толкать
    const m3 = await cardSwing(e, item, tP, tV, 10);
    t.ok(outcome(m3) === "success", `второй Удар попал (${outcome(m3)})`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tV), "prone"), 6000)), `«no»: prone есть [${cond2(e.A(tV))}]`);
    await wait(1500);
    t.ok(e.T(tV).x === 600, `«no»: цель не сдвинута: x=${e.T(tV).x}`);
  });

  sc("policy-add", "Fuel Impossible Spell (policy add): первая активация — doomed 1, вторая — doomed 2", async (e, t) => {
    needApply();
    const pc = await e.pc("заклинатель");
    const tP = await e.tok(pc, 500, 500, 1);
    await wait(700);
    const item = await e.catalog(e.A(tP), FUEL);
    await e.fire(item, tP);
    t.ok(!!(await waitFor(() => e.cond(e.A(tP), "doomed")?.value === 1, 8000)), `doomed 1 [${cond2(e.A(tP))}]`);
    await e.fire(item, tP);
    t.ok(!!(await waitFor(() => e.cond(e.A(tP), "doomed")?.value === 2, 8000)), `doomed 2 (добавилось, не max) [${cond2(e.A(tP))}]`);
  });

  sc("policy-reduce", "Piercing Doom (policy reduce, onEvent afterUse): doomed 2 -> попадание -> 1 -> попадание -> состояние снято; промах не снижает", async (e, t) => {
    needApply();
    const pc = await e.pc("атакующий"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    await e.A(tP).increaseCondition("doomed", { value: 2 });
    if (e.cond(e.A(tP), "doomed")?.value !== 2) throw new Skip(`doomed 2 не выставился [${cond2(e.A(tP))}]`);
    const item = await e.catalog(e.A(tP), DOOM);
    await rigTo(e, tP, tV);
    const m1 = await cardSwing(e, item, tP, tV, 1);
    t.ok(!OK_DEG.includes(outcome(m1)), `Удар промахнулся (${outcome(m1)})`);
    t.ok(e.cond(e.A(tP), "doomed")?.value === 2, `после промаха doomed 2 [${cond2(e.A(tP))}]`);
    const m2 = await cardSwing(e, item, tP, tV, 10);
    t.ok(OK_DEG.includes(outcome(m2)), `Удар попал (${outcome(m2)})`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tP), "doomed")?.value === 1, 8000)), `doomed 1 [${cond2(e.A(tP))}]`);
    const m3 = await cardSwing(e, item, tP, tV, 10);
    t.ok(OK_DEG.includes(outcome(m3)), `второй Удар попал (${outcome(m3)})`);
    t.ok(!!(await waitFor(() => !e.cond(e.A(tP), "doomed"), 8000)), `doomed снят на нуле [${cond2(e.A(tP))}]`);
  });

  sc("remove-condition", "Instant Recovery (removeCondition): fatigued у автора снимается", async (e, t) => {
    needApply();
    const pc = await e.pc("уставший");
    const tP = await e.tok(pc, 500, 500, 1);
    await wait(700);
    await e.A(tP).increaseCondition("fatigued");
    if (!e.cond(e.A(tP), "fatigued")) throw new Skip("fatigued не выставился");
    const item = await e.catalog(e.A(tP), RECOVERY);
    await e.fire(item, tP);
    t.ok(!!(await waitFor(() => !e.cond(e.A(tP), "fatigued"), 8000)), `fatigued снят [${cond2(e.A(tP))}]`);
  });

  sc("allies", "Song of Grace and Speed (to allies, range 30): quickened на 1 минуту у барда и союзника в 10 фт; союзник в 50 фт и враг — без", async (e, t) => {
    needApply();
    const bard = await e.pc("бард"), near = await e.pc("союзник рядом"), far = await e.pc("союзник далеко"), foe = await e.foe("враг");
    const tB = await e.tok(bard, 1000, 1000, 1), tN = await e.tok(near, 1200, 1000, 1), tF = await e.tok(far, 2000, 1000, 1), tE = await e.tok(foe, 1000, 1200, -1);
    await wait(700);
    const item = await e.catalog(e.A(tB), SONG);
    await e.fire(item, tB);
    const q = (tok) => e.cond(e.A(tok), "quickened");
    t.ok(!!(await waitFor(() => q(tB) && q(tN), 10000)), `quickened у барда (${!!q(tB)}) и союзника рядом (${!!q(tN)})`);
    const q0 = game.pf2e.ConditionManager.getCondition("quickened"), qUuid = q0?.uuid ?? q0?._stats?.compendiumSource ?? q0?.sourceId;
    const eff = e.A(tN).itemTypes.effect.find((x) => x.system.rules?.some((r) => r.key === "GrantItem" && r.uuid === qUuid) || x.flags?.[MOD]);
    t.ok(eff?.system.duration.value === 1, `срок эффекта 1 минута: ${JSON.stringify(eff?.system.duration)}`);
    await wait(1000);
    t.ok(!q(tF), `союзник в 50 фт без quickened [${cond2(e.A(tF))}]`);
    t.ok(!q(tE), `враг без quickened [${cond2(e.A(tE))}]`);
  });


  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами
    for (const k of MODES) if (modesPrev[k] !== "auto") await game.settings.set(MOD, k, "auto");
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} batch2 | ${s.id}`, err); }
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
    for (const k of MODES) try { await game.settings.set(MOD, k, modesPrev[k]); } catch { /* ok */ }
    delete window.__afBatch2ModesPrev;
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  const table = rows.map((r) => `${r.id.padEnd(18)} ${r.status.toUpperCase().padEnd(5)} ${r.detail}`).join("\n");
  const result = { summary: `ok ${cnt("ok")} / fail ${cnt("fail")} / skip ${cnt("skip")} из ${rows.length}`, table, rows };
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afBatch2Result = result;
  return result;
}
