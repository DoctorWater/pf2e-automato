async () => {
  // Живые сценарии новых форм пачки 1 (правила — из каталога модуля по uuid документа, предметы ставятся актёрам копией из компендиума с _stats.compendiumSource).
  //  trait-immunity   — Nightmare's Lament: активация вешает эффект ауры, turn-start врага в 15 фт -> Стойкость СЛ 23 (traits poison). Обычный враг: sickened 2; враг с иммунитетом к яду: ничего + предупреждение apply.immune (applyOps: черты предмета ∪ use.rule.onUse.challenge.traits).
  //  damage-immunity  — иммунитет к fire/sonic (типы урона, DAMAGE_ONLY) состояния не отменяет: испытание с чертой fire (правило-флаг на временном предмете) -> sickened ложится, предупреждения нет.
  //  bleeding-self    — Bleeding (onEvent attack-roll side:self): беходед попал Ударом по цели — карточка испытания у цели; промах и попадание ПО беходеду — ничего.
  //  exclude-self     — Baton of the Fallen (activate, onUse.excludeSelf, зона с триггерами enter/turn-start): владелец внутри зоны не в state.area.keys и карточек не получает; союзник и враг — получают.
  //  gate-hit         — Chained Charge (onEvent afterUse, шаги испытания принадлежат попаданию Ударом): промах после карточки — ничего; попадание — карточка испытания и (при mode.apply=auto) prone у цели.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Приёмы — как в strike-gate.js / aura-trigger.js / activate.js. Пишет в мир только «AF тест: …», всё убирает.
  // Параметры (перед запуском): window.__afBatch1 = { only: ["trait-immunity", ...], skip: [...], cleanOnly: true }
  // «Карточка испытания» = новое сообщение с flags.pf2e-automato.use.state.event. Нужны mode.challenge не off; сценарии с состояниями — mode.apply = auto, exclude-self — mode.zone = auto, иначе SKIP.
  // Результат: { summary, table, rows:[{id,title,status,detail}] }; то же — console.table и window.__afBatch1Result.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afBatch1 ?? {}) };
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

  // ---------- уборка (аварийная: window.__afBatch1 = {cleanOnly: true}) ----------
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
  const NL = "Compendium.pf2e.equipment-srd.Item.ASjNBiQfQfWppPJc";            // Nightmare's Lament
  const BLEED = "Compendium.pf2e.bestiary-family-ability-glossary.Item.KOnVQPlRY1CqcJXy";   // Bleeding
  const BATON = "Compendium.pf2e.equipment-srd.Item.YE3KSsxd4veXGPtJ";        // Baton of the Fallen
  const CHARGE = "Compendium.pf2e.adventure-specific-actions.Item.71ypBixnbV4bE5Hv";   // Chained Charge

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), dialogs: [], windows: [], step: "старт", stop: false, d20: null };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    // окна: наши .paf-dialog закрываются (отмена); ChoiceSet pf2e — первый вариант; окна бросков pf2e — жмём «Бросок»
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
    e.results = (m) => Object.fromEntries(Object.entries(e.use(m)?.state?.challenge?.results ?? {}).map(([k, v]) => [k, deg(v.degree)]));
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
      return it;
    };
    /** Мировой предмет-действие с правилом в флаге: rule валидируется заранее (ошибка — в detail). */
    e.ruleItem = async (actor, rule) => {
      const v = api().validateRule(rule);
      if (!v.ok) throw new Error(`правило невалидно: ${v.errors.map(String).join("; ")}`);
      const [it] = await actor.createEmbeddedDocuments("Item", [{ type: "action", name: "AF правило", system: { slug: `af-test-${id}`, actionType: { value: "action" }, actions: { value: 1 }, description: { value: "<p>тест</p>" } }, flags: { [MOD]: { rule } } }]);
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
    /** Нажать кнопку активации на карточке; -> сообщения активации (флаг activation), появившиеся после нажатия. */
    e.press = async (m, castId, { ms = 12000 } = {}) => {
      const t0 = e.since(), b = e.dom(m)?.querySelector(`.pf2e-automato button[data-action="cast-item"][data-cast="${castId}"]`);
      if (!b) throw new Error(`нет кнопки ${castId} на карточке`);
      if (b.disabled) throw new Skip(`кнопка активации ${castId} отключена: ${b.title}`);
      b.click();
      await waitFor(() => e.msgs(t0).some((x) => x.flags?.[MOD]?.activation), ms);
      return e.msgs(t0).filter((x) => x.flags?.[MOD]?.activation);
    };
    /** Предмет-действие с правилом -> карточка модуля со снимком use после done. */
    e.fire = async (item, att, ...targets) => {
      await e.aim(att, ...targets);
      const m = await e.card(item);
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
  const nextTurn = async (c) => { await bound("nextTurn", c.nextTurn()); await wait(2500); };
  /** Карточки испытаний модуля после t0 (use.state.event), по токену цели (targets[0].key), если задан. */
  const hosts = (e, t0, tok = null) => e.msgs(t0).filter((m) => m.flags?.[MOD]?.use?.state?.event && (!tok || m.flags[MOD].use.targets?.[0]?.key === tok.id));
  const hasImm = (a, type) => (a?.attributes?.immunities ?? []).some((i) => (i.type ?? i) === type);
  /** Экипировка копии предмета: investable — надето и вложено, иначе в руке. */
  const worn = (d) => { d.system.equipped = (d.system.traits?.value ?? []).includes("invested") ? { carryType: "worn", inSlot: true, invested: true } : { carryType: "held", handsHeld: 1 }; return d; };
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

  sc("trait-immunity", "Nightmare's Lament: аура 15 фт, яд СЛ 23 — обычный враг sickened 2; враг с иммунитетом к яду — ничего и предупреждение apply.immune", async (e, t) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const owner = await e.pc("владелец"), a = await e.foe("обычный враг"), b = await e.foe("ядоустойчивый враг", { system: { attributes: { immunities: [{ type: "poison" }] } } });
    const tO = await e.tok(owner, 1000, 1000, 1), tA = await e.tok(a, 1200, 1000, -1), tB = await e.tok(b, 1000, 1200, -1);   // зазор 1 клетка = 5 фт < 15 фт
    await wait(700);
    if (!hasImm(e.A(tB), "poison") || hasImm(e.A(tA), "poison")) throw new Skip("иммунитет к яду не задался у ядоустойчивого врага (system.attributes.immunities)");
    const item = await e.catalog(e.A(tO), NL, worn);
    await e.aim(tO);
    const card = await e.card(item);
    await e.press(card, "fuming-cloak");
    const ok = await waitFor(() => e.A(tO).itemTypes.effect.some((x) => x.slug === "aura-fuming-cloak"), 10000);
    t.ok(!!ok, `активация повесила эффект ауры на владельца: эффекты [${e.A(tO).itemTypes.effect.map((x) => x.slug)}]`);
    if (!ok) return;
    const c = await e.combat([tO, tA, tB], [30, 20, 10]);
    await e.fix(1);   // провал Стойкости СЛ 23
    const t0 = e.since();
    await nextTurn(c);   // ход обычного врага
    t.ok(!!(await waitFor(() => hosts(e, t0, tA).length === 1, 8000)), `обычный враг: одна карточка испытания (${hosts(e, t0, tA).length})`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tA), "sickened")?.value === 2, 8000)), `обычный враг: sickened 2 (${e.cond(e.A(tA), "sickened")?.value}); результаты ${JSON.stringify(e.results(hosts(e, t0, tA)[0]))}`);
    await nextTurn(c);   // ход ядоустойчивого
    await waitFor(() => hosts(e, t0, tB).length >= 1, 6000);
    await wait(1500);
    t.ok(!e.cond(e.A(tB), "sickened"), "ядоустойчивый враг: sickened нет");
    t.ok(notes.some((n) => n.startsWith("warn") && (n.includes(e.A(tB).name) || n.includes(tB.name))), `предупреждение apply.immune про ядоустойчивого врага; карточек у него ${hosts(e, t0, tB).length}; уведомления [${notes.join(" | ")}]`);
    t.ok(!notes.some((n) => n.includes("обычный враг")), "про обычного врага предупреждений нет");
  });

  sc("damage-immunity", "Иммунитет к fire/sonic (типы урона) состояние не отменяет: испытание с traits [fire] -> sickened ложится", async (e, t) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.apply", "off", "button");
    const pc = await e.pc("автор"), vic = await e.foe("огнеупорный", { system: { attributes: { immunities: [{ type: "fire" }, { type: "sonic" }] } } });
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    if (!hasImm(e.A(tV), "fire") || !hasImm(e.A(tV), "sonic")) throw new Skip("иммунитеты fire/sonic не задались (system.attributes.immunities)");
    const SICK = [{ to: "target", condition: { slug: "sickened", value: 1 } }];
    const item = await e.ruleItem(e.A(tP), { v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 50 }, basic: false, traits: ["fire"], byDegree: { failure: SICK, criticalFailure: SICK } } } });
    await e.fix(1);
    const m = await e.fire(item, tP, tV);
    t.ok(!!(await waitFor(() => e.results(m)[tV.id], 10000)), `испытание брошено: ${JSON.stringify(e.results(m))}`);
    t.ok(!!(await waitFor(() => e.cond(e.A(tV), "sickened"), 8000)), `sickened лёг несмотря на иммунитет к fire/sonic [${[...e.A(tV).itemTypes.condition].map((x) => x.slug)}]`);
    t.ok(!notes.some((n) => n.includes("огнеупорный")), `предупреждения об иммунитете нет [${notes.join(" | ")}]`);
  });

  sc("bleeding-self", "Bleeding (side:self, при попадании): беходед попал по цели — карточка у цели; промах и попадание по беходеду — ничего", async (e, t) => {
    openChat(); needMode("mode.challenge", "off");
    const mon = await e.foe("беходед"), vic = await e.pc("цель");
    const tM = await e.tok(mon, 500, 500, -1), tV = await e.tok(vic, 600, 500, 1);
    await wait(700);
    await e.catalog(e.A(tM), BLEED);
    await rigTo(e, tM, tV); await rigTo(e, tV, tM);
    const t0 = e.since();
    const mMiss = await swing(e, tM, tV, 1);
    t.ok(!OK_DEG.includes(outcome(mMiss)), `промах беходеда (${outcome(mMiss)})`);
    t.ok(hosts(e, t0).length === 0, `после промаха карточек нет (${hosts(e, t0).length})`);
    const m1 = await swing(e, tM, tV, 10);
    t.ok(OK_DEG.includes(outcome(m1)), `беходед попал (${outcome(m1)})`);
    t.ok(!!(await waitFor(() => hosts(e, t0, tV).length === 1, 8000)), `попадание: одна карточка у цели (${hosts(e, t0, tV).length}; всего ${hosts(e, t0).length})`);
    const t1 = e.since();
    const m2 = await swing(e, tV, tM, 10);
    t.ok(OK_DEG.includes(outcome(m2)), `цель попала по беходеду (${outcome(m2)})`);
    t.ok(hosts(e, t1).length === 0, `попадание ПО беходеду: карточек нет (${hosts(e, t1).length})`);
  });

  sc("exclude-self", "Baton of the Fallen: зона 30 фт с триггерами; владелец внутри — не в целях и без карточек, союзник и враг — с карточками", async (e, t) => {
    openChat(); needMode("mode.challenge", "off"); needMode("mode.zone", "off", "button");
    const owner = await e.pc("владелец"), ally = await e.pc("союзник"), foe = await e.foe("враг");
    const tO = await e.tok(owner, 1000, 1000, 1), tA = await e.tok(ally, 1200, 1000, 1), tF = await e.tok(foe, 1000, 1200, -1);
    await wait(700);
    const item = await e.catalog(e.A(tO), BATON, worn);
    await e.aim(tO);
    const c = await e.combat([tO, tA, tF], [30, 20, 10]);
    const card = await e.card(item);
    const [m] = await e.press(card, "gather-the-fallen");
    if (!m) throw new Error("активация не создала сообщение (кнопка нажата, activation-сообщения нет)");
    await waitFor(() => e.use(m)?.state?.awaitingRegion, 6000);
    await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}взрыв`, color: "#5500aa", shapes: [{ type: "circle", hole: false, x: 1000, y: 1000, radius: 400 }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: "burst" } } }]);   // как шаблон, брошенный из сообщения
    // правило с зоной: регион уходит в state.zone (state.area нет); владелец исключается на триггерах зоны (excludeSelf -> skipOrigin)
    t.ok(!!(await waitFor(() => e.use(m)?.state?.zone?.status === "active", 10000)), `зона активна: state ${JSON.stringify(e.use(m)?.state)?.slice(0, 400)}`);
    await e.fix(1);
    const t0 = e.since();
    await nextTurn(c);   // союзник: turn-start
    await nextTurn(c);   // враг: turn-start
    await nextTurn(c);   // раунд 2, владелец: turn-start
    t.ok(!!(await waitFor(() => hosts(e, t0, tA).length >= 1 && hosts(e, t0, tF).length >= 1, 8000)), `союзник: ${hosts(e, t0, tA).length}, враг: ${hosts(e, t0, tF).length} карточек`);
    t.ok(hosts(e, t0, tO).length === 0, `владелец карточек не получил (${hosts(e, t0, tO).length}; всего ${hosts(e, t0).length}, раунд ${c.round})`);
  });

  sc("gate-hit", "Chained Charge (afterUse): промах Ударом после карточки — ничего; попадание — карточка испытания у цели (и prone при mode.apply=auto)", async (e, t) => {
    openChat(); needMode("mode.challenge", "off");
    const pc = await e.pc("атакующий"), vic = await e.foe("цель");
    const tP = await e.tok(pc, 500, 500, 1), tV = await e.tok(vic, 600, 500, -1);
    await wait(700);
    const item = await e.catalog(e.A(tP), CHARGE);
    await rigTo(e, tP, tV);
    const t0 = e.since();
    await e.pf2eCard(item, tP, tV);
    const m1 = await swing(e, tP, tV, 1);
    t.ok(!OK_DEG.includes(outcome(m1)), `Удар промахнулся (${outcome(m1)})`);
    t.ok(hosts(e, t0).length === 0 && !e.cond(e.A(tV), "prone"), `после промаха карточек нет (${hosts(e, t0).length}), prone нет`);
    await e.pf2eCard(item, tP, tV);
    const m2 = await swing(e, tP, tV, 10);
    t.ok(OK_DEG.includes(outcome(m2)), `Удар попал (${outcome(m2)})`);
    t.ok(!!(await waitFor(() => hosts(e, t0, tV).length === 1, 8000)), `попадание: одна карточка у цели (${hosts(e, t0, tV).length}; всего ${hosts(e, t0).length})`);
    if (setting("mode.apply") === "auto") t.ok(!!(await waitFor(() => e.cond(e.A(tV), "prone"), 8000)), `при провале Рефлекса (СЛ 35) цель prone; результаты ${JSON.stringify(e.results(hosts(e, t0, tV)[0]))}`);
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} batch1 | ${s.id}`, err); }
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
  window.__afBatch1Result = result;
  return result;
}
