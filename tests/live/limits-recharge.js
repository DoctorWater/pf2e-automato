async () => {
  // Живые сценарии лимитов использования: перезарядка (#Recharge во встроенном броске описания) и требования к автору (Хватка и др., rules/use-limits.json). Копии «AF тест: …», сцена создаётся и удаляется сценарием.
  // Окна выбора модуля отвечаются очередью e.answers. Параметры: window.__afLR = { only, skip, cleanOnly }. Результат — window.__afLRResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { only: null, skip: [], ...(window.__afLR ?? {}) };
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

  // ---------- уборка (аварийная: window.__afLR = {cleanOnly: true}) ----------
  // Бой удаляем с проверкой: молчаливый catch оставлял бой без сцены (сцену удаляли следом). Не удалился — повтор, потом предупреждение в консоль.
  const killCombat = async (c) => {
    for (let i = 0; i < 3 && game.combats.has(c.id); i++) { await game.combats.get(c.id).delete().catch((err) => console.warn("combat delete", c.id, err)); if (game.combats.has(c.id)) await wait(800); }
    if (game.combats.has(c.id)) console.warn("rustyspirit: бой не удалился", c.id);
  };
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    const mine = (n) => test(n) || (typeof n === "string" && n.startsWith("Тест: "));   // копии героев: «AF тест: » и «Тест: »
    // бои сцены (до её удаления), а также бои без сцены, чьи участники — наши копии
    for (const c of game.combats.filter((c) => test(c.scene?.name) || (!c.scene && c.combatants.some((x) => mine(x.actor?.name) || mine(x.name))) || c.combatants.some((x) => test(x.actor?.name) || test(x.name) || test(game.scenes.get(x.sceneId)?.name)))) await killCombat(c);
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
      for (const c of game.combats.filter((c) => c.scene?.id === e.scene.id || c.combatants.some((x) => x.sceneId === e.scene.id))) await killCombat(c);   // бой — до ухода со сцены и до её удаления
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

  // Копии противников «AF тест: …» с их способностями; жертвы — гоблины на стороне партии (NPC бросают сами). Сетка 100 px / 5 фт.
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const EN = { spirit: "kLU5GWkHlFZhChxY", fox: "1E85fDMsHCCrOw0m", guard: "k4YZBN0sa876sJQk", sprout: "qbaMCMwu7xwk1Gi8" };
  const DEGREE_MOD = { criticalSuccess: 0, success: -10, failure: -11, criticalFailure: -20 };
  const copyFoe = async (e, id, name) => {
    const h = game.actors.get(id);
    if (!h) throw new Skip(`нет противника ${id}`);
    const d = h.toObject(); delete d._id; delete d.folder;
    return e.add({ ...d, name: name ?? h.name });
  };
  const victim = async (e, name, traits) => {
    const a = await e.foe(name);
    await a.update({ "system.details.alliance": "party", ...(traits && { "system.traits.value": [...a.system.traits.value, ...traits] }) });
    return a;
  };
  const rigSave = async (e, G, stat, dc, deg) => {
    for (const i of G.itemTypes.effect.filter((i) => i.slug === "af-rig")) await i.delete();
    await e.rig(G, stat, dc + DEGREE_MOD[deg] - G.saves[stat].mod);
  };
  const bySlug = (a, slug) => a.items.find((i) => i.system.slug === slug) ?? null;
  const cnd = (a, slug) => a.itemTypes.condition.find((c) => c.slug === slug)?.value ?? (a.itemTypes.condition.some((c) => c.slug === slug) ? true : 0);
  const openChat = () => { try { ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.("chat", "primary"); } catch { /* ok */ } };
  /** Использование действия путём pf2e (createUseActionMessage: списание частоты) -> карточка или null. */
  const useAction = async (e, item, ms = 8000) => {
    const t0 = e.since();
    await bound("rollItemMacro", game.pf2e.rollItemMacro(item.uuid));
    return waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.origin?.uuid === item.uuid), ms);
  };
  const area = async (e, m, x, y, r, shape) => {
    await waitFor(() => e.use(m)?.state?.awaitingRegion || e.use(m)?.state?.done, 8000);
    const made = await e.scene.createEmbeddedDocuments("Region", [{ name: `${PFX}область`, color: "#00aa55", shapes: [{ type: "circle", hole: false, x, y, radius: r }], behaviors: [], flags: { pf2e: { messageId: m.id, areaShape: shape, origin: { uuid: m.item?.uuid, type: m.item?.type, actor: m.actor?.uuid, token: m.token?.uuid } } } }]);   // origin — как у шаблона pf2e: по нему проверка дальности области
    if (made.length) await waitFor(() => (e.use(m)?.state?.area?.keys?.length ?? 0) >= 1, 10000);
    return made[0] ?? null;
  };
  const dmgOf = async (e, tAtt) => {
    const t0 = e.since(), s = e.strike(e.A(tAtt));
    await bound("урон Удара", s.damage({ event: SHIFT() }));
    return waitFor(() => e.msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "damage-roll"), 8000);
  };
  const withAlt = async (f) => { const k = game.keyboard.downKeys; k.add("AltLeft"); try { return await f(); } finally { k.delete("AltLeft"); } };


  // ---------- сценарии ----------
  const RC_DESC = "<p>The creature can't use this ability again for [[/gmr 1d4 #Recharge AF breath]]{1d4 rounds}.</p>";
  const breathData = (slug = "af-breath") => ({ type: "action", name: "AF дыхание", system: { slug, actionType: { value: "action" }, actions: { value: 1 }, description: { value: RC_DESC } } });
  const GRAB_DESC = "<p><strong>Requirements</strong> The monster's last action was a successful Strike that lists Grab in its damage entry, or the monster has a creature @UUID[Compendium.pf2e.conditionitems.Item.kWc1fhmv9LBiTuei]{Grabbed} or @UUID[Compendium.pf2e.conditionitems.Item.VcDeM8A5oI6VqhbM]{Restrained}</p><hr /><p><strong>Effect</strong> test</p>";
  const KNOCK_DESC = "<p><strong>Requirements</strong> The monster's last action was a successful Strike that lists Knockdown in its damage entry</p><hr /><p><strong>Effect</strong> test</p>";
  const WOLF_DESC = "<p>When the wolf succeeds at its jaws Strike, it can use this action immediately after to attempt to [[/act trip]] the target.</p>";
  const actionData = (name, slug, description) => ({ type: "action", name, system: { slug, actionType: { value: "action" }, actions: { value: 1 }, description: { value: description } } });
  const lockOf = (a, it) => a.flags?.[MOD]?.[`rc_${it.id}`];
  const rcWarn = /перезаряд|recharg/i, reqWarn = /требовани|requirement/i;
  const startCombat = async (e, toks, inits = [20, 10]) => { const c = await e.combat(toks, inits); await c.startCombat(); await wait(600); return c; };
  /** d20 и кубики перезарядки: 1d4 при u=0.5 даёт 3. Оригинал randomUniform сохраняет и возвращает e.fix(null). */
  const fixDice = async (e) => { await e.fix(10); CONFIG.Dice.randomUniform = () => 0.5; };
  const gmOnly = (m) => !!m?.whisper?.length && m.whisper.every((id) => game.users.get(id)?.isGM);
  const setLimits = (v) => game.settings.set(MOD, "mode.limits", v);

  // Дракон-копия и жертва в бою; предмет «AF дыхание» с встроенным броском #Recharge в описании — без источника (мировой предмет): разбор идёт в рантайме по тексту
  const dragonScene = async (e, { combat = true } = {}) => {
    openChat();
    const A0 = await e.foe("дракон"), V0 = await victim(e, "жертва");
    const it0 = (await e.give(A0, breathData()))[0];
    const tA = await e.tok(A0, 1000, 1000, -1), tV = await e.tok(V0, 1100, 1000, 1);
    await wait(700);
    const a = e.A(tA), it = a.items.get(it0.id);
    const c = combat ? await startCombat(e, [tA, tV]) : null;
    return { A0, V0, tA, tV, a, it, c };
  };

  sc("recharge", "Перезарядка (мировой предмет, #Recharge в описании): бросок на флаге, шёпот ГМу с тем же числом, блок, Alt, разблок через N раундов, откат при удалении карточки", async (e, t) => {
    const { tA, it, c } = await dragonScene(e);
    await fixDice(e);
    const t0 = e.since();
    const m1 = await useAction(e, it);
    t.ok(!!m1, "первое использование — карточка");
    const lock = await waitFor(() => lockOf(e.A(tA), it), 6000);
    t.ok(lock?.n === 3 && lock.until === c.round + 3 && lock.dice === "1d4" && lock.r?.[0] === 3 && lock.c === c.id, `число на флаге rc_<id>: ${JSON.stringify(lock)}`);
    const w = await waitFor(() => e.msgs(t0).find((m) => m.flags?.[MOD]?.builtin === "recharge"), 6000);
    t.ok(!!w && w.rolls?.[0]?.total === 3, `шёпот с готовым броском = число на флаге (${w?.rolls?.[0]?.total})`);
    t.ok(gmOnly(w), `NPC: шёпот только ГМу (получатели: ${w?.whisper?.length})`);
    const dom = await waitFor(() => e.dom(m1), 4000);
    if (dom) {
      const links = [...dom.querySelectorAll("a.inline-roll")].filter((x) => /recharge/i.test(x.dataset.flavor ?? ""));
      t.ok(links.length === 0 && dom.querySelectorAll(".paf-dealt").length >= 1, `ссылка #Recharge в карточке погашена (живых ${links.length})`);
    }
    // повтор в том же раунде — блок
    const n0 = notes.length;
    t.ok(!(await useAction(e, it, 2500)), "повтор в том же раунде: карточки нет");
    t.ok(notes.slice(n0).some((x) => rcWarn.test(x)), `предупреждение о перезарядке (${notes.slice(n0).join(" | ").slice(0, 160)})`);
    // Alt — использовать всё равно
    const m3 = await withAlt(() => useAction(e, it));
    t.ok(!!m3, "Alt: карточка есть");
    // раунд до срока — блок, на сроке — пускает
    await c.update({ round: lock.until - 1 });
    await wait(400);
    t.ok(!(await useAction(e, it, 2500)), "за раунд до срока: блок");
    await c.update({ round: lock.until });
    await wait(400);
    const m4 = await useAction(e, it);
    t.ok(!!m4, `в раунд срока (${lock.until}): пускает`);
    const lock2 = await waitFor(() => (lockOf(e.A(tA), it)?.until > lock.until ? lockOf(e.A(tA), it) : null), 6000);
    t.ok(!!lock2, `новый замок после использования (${JSON.stringify(lockOf(e.A(tA), it))})`);
    // удалили карточку — замок снят, повтор в тот же раунд проходит
    await game.messages.get(m4.id).delete();
    t.ok(!!(await waitFor(() => !lockOf(e.A(tA), it), 6000)), "удаление карточки сняло замок");
    t.ok(!!(await useAction(e, it)), "после отката повтор проходит");
  });

  sc("recharge-copies", "Две несвязанные копии одного NPC: замок у каждой свой", async (e, t) => {
    openChat();
    const A0 = await e.foe("дракон"), V0 = await victim(e, "жертва");
    await e.give(A0, breathData());
    const t1 = await e.tok(A0, 1000, 1000, -1), t2 = await e.tok(A0, 1000, 1200, -1), tV = await e.tok(V0, 1100, 1100, 1);
    await wait(700);
    const a1 = e.A(t1), a2 = e.A(t2), i1 = a1.items.find((i) => i.name === "AF дыхание"), i2 = a2.items.find((i) => i.name === "AF дыхание");
    t.ok(a1.uuid !== a2.uuid && i1.id === i2.id, `копии: разные актёры, один id предмета (${a1.uuid} / ${a2.uuid})`);
    await startCombat(e, [t1, t2, tV], [20, 15, 10]);
    await fixDice(e);
    t.ok(!!(await useAction(e, i1)), "копия 1: карточка");
    t.ok(!!(await waitFor(() => lockOf(e.A(t1), i1), 6000)), "замок у копии 1");
    t.ok(!lockOf(e.A(t2), i2), "у копии 2 замка нет");
    t.ok(!!(await useAction(e, i2)), "копия 2 пускает, хотя копия 1 в перезарядке");
    t.ok(!!(await waitFor(() => lockOf(e.A(t2), i2), 6000)), "замок у копии 2");
    t.ok(!(await useAction(e, i1, 2500)), "копия 1 повторно — блок");
    t.ok(!(await useAction(e, i2, 2500)), "копия 2 повторно — блок");
  });

  sc("recharge-off", "mode.limits=off: не бросаем и не ставим rc_*, блока и шёпота нет", async (e, t) => {
    const prev = setting("mode.limits");
    try {
      await setLimits("off");
      const { tA, it } = await dragonScene(e);
      await fixDice(e);
      const t0 = e.since();
      t.ok(!!(await useAction(e, it)), "первое использование");
      t.ok(!!(await useAction(e, it)), "повтор в том же раунде проходит (режим выключен)");
      await wait(1500);
      t.ok(!lockOf(e.A(tA), it), "флага rc_* нет");
      t.ok(!e.msgs(t0).some((m) => m.flags?.[MOD]?.builtin === "recharge"), "шёпота перезарядки нет");
    } finally { await setLimits(prev); }
  });

  sc("recharge-outside", "Вне боя: ни броска, ни блока, ссылка #Recharge в карточке живая", async (e, t) => {
    const { tA, it } = await dragonScene(e, { combat: false });
    const t0 = e.since();
    const m1 = await useAction(e, it);
    t.ok(!!m1, "карточка");
    t.ok(!!(await useAction(e, it)), "повтор проходит");
    await wait(1500);
    t.ok(!lockOf(e.A(tA), it), "флага rc_* нет");
    t.ok(!e.msgs(t0).some((m) => m.flags?.[MOD]?.builtin === "recharge"), "шёпота нет");
    const dom = e.dom(m1);
    if (dom) t.ok([...dom.querySelectorAll("a.inline-roll")].some((x) => /recharge/i.test(x.dataset.flavor ?? "")), "ссылка #Recharge не погашена");
  });

  // Требования: Хватка по канонической записи (slug «grab» + абзац Requirements с теми же состояниями), Удар с эффектом grab у гоблина
  const grabScene = async (e) => {
    openChat();
    const A0 = await e.foe("гоблин-хваталка"), V0 = await victim(e, "жертва");
    const mel = A0.items.find((i) => i.type === "melee");
    await mel.update({ "system.attackEffects.value": ["grab"] });
    await e.give(A0, actionData("Хватка", "grab", GRAB_DESC), actionData("Опрокидывание", "knockdown", KNOCK_DESC), actionData("AF волк-опрокидывание", "knockdown", WOLF_DESC));
    const tA = await e.tok(A0, 1000, 1000, -1), tV = await e.tok(V0, 1100, 1000, 1);
    await wait(700);
    const a = e.A(tA), item = (n) => a.items.find((i) => i.name === n);
    const c = await startCombat(e, [tA, tV]);
    const strike = async (d20, { target = true } = {}) => {
      await e.fix(d20);
      const t0 = e.since(), s = e.strike(e.A(tA));
      if (target) await e.aim(tA, tV);
      else { game.user.targets.forEach((x) => x.setTarget(false, { releaseOthers: false })); e.T(tA).object.control({ releaseOthers: true }); await wait(300); }
      await bound("Удар", s.variants[0].roll({ event: SHIFT() }));
      const m = await waitFor(() => e.msgs(t0).find((x) => x.flags?.pf2e?.context?.type === "attack-roll"), 8000);
      await wait(300);
      return m;
    };
    return { A0, V0, tA, tV, a, item, c, strike };
  };
  const actOf = (m) => game.messages.get(m?.id)?.flags?.[MOD]?.act;

  sc("grab-hit", "Хватка после попадания Ударом с эффектом grab: пускает; в штампе hit=true и fx", async (e, t) => {
    const g = await grabScene(e);
    const m = await g.strike(20);
    t.ok(!!m, "Удар брошен");
    const act = actOf(m);
    t.ok(act?.kind === "strike" && act.hit === true && act.fx?.includes("grab") && act.who === g.a.uuid && !!act.turn, `штамп на сообщении Удара: ${JSON.stringify(act)}`);
    t.ok(m?.flags?.pf2e?.context?.outcome === "success" || m?.flags?.pf2e?.context?.outcome === "criticalSuccess", `outcome в контексте: ${m?.flags?.pf2e?.context?.outcome}`);
    t.ok(!!(await useAction(e, g.item("Хватка"))), "Хватка: карточка есть");
  });

  sc("grab-miss", "Хватка после промаха: блок с предупреждением; Alt пускает; mode.limits=off пускает", async (e, t) => {
    const g = await grabScene(e);
    const m = await g.strike(1);
    t.ok(actOf(m)?.hit === false, `штамп: hit=false (${JSON.stringify(actOf(m))})`);
    const n0 = notes.length;
    t.ok(!(await useAction(e, g.item("Хватка"), 2500)), "после промаха: карточки нет");
    t.ok(notes.slice(n0).some((x) => reqWarn.test(x)), `предупреждение о требовании (${notes.slice(n0).join(" | ").slice(0, 200)})`);
    t.ok(!!(await withAlt(() => useAction(e, g.item("Хватка")))), "Alt: карточка есть");
    const prev = setting("mode.limits");
    try { await setLimits("off"); t.ok(!!(await useAction(e, g.item("Хватка"))), "mode.limits=off: карточка есть"); } finally { await setLimits(prev); }
  });

  sc("grab-no-target", "Хватка после Удара без цели: исхода нет (hit=null) — не блокируем", async (e, t) => {
    const g = await grabScene(e);
    const m = await g.strike(20, { target: false });
    t.ok(!!m, "Удар без цели брошен");
    const act = actOf(m);
    t.ok(act?.kind === "strike" && act.hit === null, `штамп: hit=null (${JSON.stringify(act)}; outcome ${m?.flags?.pf2e?.context?.outcome})`);
    t.ok(!!(await useAction(e, g.item("Хватка"))), "Хватка: карточка есть");
  });

  sc("grab-without-strike", "Хватка без Удара в этот ход (журнал есть, но прошлое действие — другое): блок", async (e, t) => {
    const g = await grabScene(e);
    await e.fix(20);
    t.ok(!!(await useAction(e, g.item("AF волк-опрокидывание"))), "посторонняя способность без требований — карточка (штамп use)");
    const n0 = notes.length;
    t.ok(!(await useAction(e, g.item("Хватка"), 2500)), "Хватка после постороннего действия: карточки нет");
    t.ok(notes.slice(n0).some((x) => reqWarn.test(x)), "предупреждение о требовании");
  });

  sc("grab-holds", "Хватка при держащем: после промаха пускает, если у цели Схвачен (автор не известен); Опрокидывание после Удара с одним grab — блок; одноимённая способность без абзаца Requirements — не блокируется", async (e, t) => {
    const g = await grabScene(e);
    await g.strike(1);
    t.ok(!(await useAction(e, g.item("Хватка"), 2500)), "до захвата: блок");
    await e.A(g.tV).increaseCondition("grabbed");
    await wait(600);
    t.ok(!!(await useAction(e, g.item("Хватка"))), "держит существо (Схвачен у цели): карточка есть");
    await g.strike(20);
    const n0 = notes.length;
    t.ok(!(await useAction(e, g.item("Опрокидывание"), 2500)), "Опрокидывание после Удара, где только grab: блок");
    t.ok(notes.slice(n0).some((x) => reqWarn.test(x)), "предупреждение о требовании");
    t.ok(!!(await useAction(e, g.item("AF волк-опрокидывание"))), "slug knockdown без абзаца Requirements: оверлей не подхватывает, блока нет");
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  const applyPrev = setting("mode.apply");
  const limitsPrev = setting("mode.limits");
  try {
    await setFlags({ showCheckDialogs: false, showDamageDialogs: false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // NPC бросают сами
    if (limitsPrev !== "auto") await game.settings.set(MOD, "mode.limits", "auto");   // прогон проверяет включённый режим; «off» сценарии включают сами
    if (applyPrev !== "auto") await game.settings.set(MOD, "mode.apply", "auto");   // по умолчанию button: результаты не выдаются сами
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
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} limits-recharge | ${s.id}`, err); }
      } finally {
        const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
        if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
      }
      // шум ядра/pf2e при уборке: всплывающий текст токена дорисовывается после удаления сцены (не модуль)
      const errs = notes.filter((n) => /^(console\.error|uncaught)/.test(n) && !/createScrollingText|showFloatyText|reading 'position'\) at set y/.test(n));
      if (errs.length) { status = "fail"; detail += ` | ошибки: ${errs.slice(0, 3).join(" / ")}`; }
      else if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 4).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    console.error = ceOrig;
    window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr);
    try { await game.settings.set(MOD, "mode.apply", applyPrev); } catch { /* ok */ }
    try { await game.settings.set(MOD, "mode.limits", limitsPrev); } catch { /* ok */ }
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { /* ok */ }
    try { await setFlags(origFlags); } catch { /* ok */ }
    await sweep();
    await prevScene?.view();
    await viewCombat(prevCombat);
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afLRResult = out;
  return out;
}
