async () => {
  // Живой сценарий «Работает само» в Мастерской (docs/plan-workshop-mechanisms.md): копии существ «AF тест: …» на временной сцене, окно Мастерской
  // открывается на предмете с механизмом; переключатели окна проверяются по рантайму (M1 «не ограничивать» → нет блока, M2 «не проверять» → нет блока,
  // M3 «не запускать Ударом» → ручная карточка, M5 выбор манёвров, M6 «не накладывать» → нет Slowed). Харнесс — как tests/live/rusthenge.js.
  // Параметры: window.__afWM = { only, skip, cleanOnly, keepOpen: "<id>" }. keepOpen: прогнать один сценарий и оставить окно, сцену и копии как есть
  // (для скриншота); убрать — window.__afWMKeep.cleanup(). Результат — window.__afWMResult.
  // Сценарии (id): recharge, req, strike, maneuvers, permanent, spirit, shape, mixed, derived.
  const MOD = "pf2e-automato", PFX = "AF тест: ", WS = "pf2e-automato-workshop";
  const opts = { only: null, skip: [], keepOpen: null, ...(window.__afWM ?? {}) };
  if (opts.keepOpen) opts.only = [opts.keepOpen];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let cur = null;
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
  const api = () => game.modules.get(MOD).api;
  const imp = (f) => import(`/modules/${MOD}/scripts/${f}`);

  // ---------- уборка (аварийная: window.__afWM = {cleanOnly: true}) ----------
  const killCombat = async (c) => {
    for (let i = 0; i < 3 && game.combats.has(c.id); i++) { await game.combats.get(c.id).delete().catch((err) => console.warn("combat delete", c.id, err)); if (game.combats.has(c.id)) await wait(800); }
  };
  const sweep = async (extraMsgIds = []) => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name) || c.combatants.some((x) => test(x.actor?.name) || test(x.name)))) await killCombat(c);
    const scenes = game.scenes.filter((s) => test(s.name));
    const actorIds = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const sceneIds = new Set(scenes.map((s) => s.id));
    const ids = [...new Set([...extraMsgIds, ...game.messages.filter((m) => actorIds.has(m.speaker?.actor) || sceneIds.has(m.speaker?.scene)).map((m) => m.id)])].filter((id) => game.messages.has(id));
    if (ids.length) await ChatMessage.deleteDocuments(ids).catch(() => {});
    for (const s of scenes) await s.delete().catch(() => {});
    for (const a of game.actors.filter((a) => test(a.name))) await a.delete().catch(() => {});
    for (const i of game.items.filter((i) => test(i.name))) await i.delete().catch(() => {});
    return game.actors.filter((a) => test(a.name)).length + game.scenes.filter((s) => test(s.name)).length + game.items.filter((i) => test(i.name)).length;
  };
  if (opts.cleanOnly) {
    foundry.applications.instances.get(WS)?.close({ force: true });
    return { left: await sweep() };
  }

  const prevScene = game.scenes.viewed, prevCombat = game.combats.viewed;
  const notes = [];
  const N = ui.notifications, nOrig = { warn: N.warn, error: N.error };
  const ceOrig = console.error;
  console.error = function (...a) { const er = a.find((x) => x instanceof Error); if (er) notes.push(`console.error: ${String(a[0]).slice(0, 80)} ${String(er.stack ?? er.message).replace(/\s+/g, " ").slice(0, 500)}`); return ceOrig.apply(this, a); };
  for (const k of Object.keys(nOrig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 120)}`); return nOrig[k].call(this, m, ...r); };
  const viewCombat = async (c) => { try { await ui.combat.initialize({ combat: c ?? null }); } catch (e) { console.warn("viewCombat", e); } };

  // ---------- источники (uuid по tools/out/items.json, pf2e 8.6.1) ----------
  const SRC = {
    goblin: "Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4",
    xotanispawn: "Compendium.pf2e.age-of-ashes-bestiary.Actor.JD6kdfZveObBe1mR",      // Дыхание с перезарядкой
    ghoul: "Compendium.pf2e.agents-of-edgewatch-bestiary.Actor.QBlBYsxySiBMxf22",     // Лихорадка гулей (attackEffects Удара)
    zombie: "Compendium.pf2e.agents-of-edgewatch-bestiary.Actor.ySpOZlKUbcxWhKQ6",    // Slow
    voz: "Compendium.pf2e.age-of-ashes-bestiary.Actor.UD7EwTQG2Sbl4d8R",              // Reach Spell у NPC
    grab: "Compendium.pf2e.bestiary-ability-glossary-srd.Item.Tkd8sH4pwFIPzqTr",
    telekinetic: "Compendium.pf2e.spells-srd.Item.mrDi3v933gsmnw25",
    magnetic: "Compendium.pf2e.spells-srd.Item.7dKtMehJ6YrXwJLR",
    spiritLink: "Compendium.pf2e.spells-srd.Item.yHujiDQPdtXW797e",
    reachSpell: "Compendium.pf2e.feats-srd.Item.BWomK7EVY0WXxWgh",
    ancestry: "Compendium.pf2e.ancestries.Item.IiG7DgeLWYrSNXuX"
  };
  const src = async (uuid) => {
    const d = await fromUuid(uuid).catch(() => null);
    if (!d) throw new Skip(`нет в паках: ${uuid}`);
    const o = d.toObject(); delete o._id; delete o.folder;
    return o;
  };

  // ---------- окружение одного сценария ----------
  const newEnv = async (id) => {
    const e = { dead: false, id, tracked: new Set(), step: "старт", stop: false, keep: false };
    const hook = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) e.tracked.add(m.id); });
    e.scene = await Scene.create({ name: `${PFX}сцена ${id}`, width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await e.scene.view(); await wait(700);
    const live = () => { if (e.dead) throw new Error("сценарий остановлен"); };
    e.copy = async (uuid, name) => { live(); return Actor.create({ ...(await src(uuid)), name: PFX + name, ownership: { default: 0 } }); };
    e.hero = async (name, ...itemUuids) => {
      live();
      const a = await Actor.create({ name: PFX + name, type: "character", ownership: { default: 0 }, system: { details: { alliance: "party", languages: { value: ["common"] } } } });
      await a.createEmbeddedDocuments("Item", await Promise.all([src(SRC.ancestry), ...itemUuids.map(src)]));
      return a;
    };
    e.tok = async (a, x, y) => {
      live();
      const [t] = await e.scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition: -1 }]);
      return t;
    };
    e.A = (t) => e.scene.tokens.get(t.id)?.actor;   // у NPC токен «развязан»: предметы — у синтетического актёра
    e.give = (a, ...docs) => { live(); return a.createEmbeddedDocuments("Item", docs); };
    e.combat = async (toks) => {
      live();
      const c = await Combat.create({ scene: e.scene.id, active: true });
      await c.createEmbeddedDocuments("Combatant", toks.map((t, i) => ({ tokenId: t.id, sceneId: e.scene.id, actorId: t.actor.id, initiative: 10 - i })));
      await viewCombat(c);
      await c.startCombat();
      return c;
    };
    e.dispose = async () => {
      e.dead = true; e.stop = true;
      await wait(1500);
      foundry.applications.instances.get(WS)?.close({ force: true });
      for (const c of game.combats.filter((c) => c.scene?.id === e.scene.id)) await killCombat(c);
      if (prevScene && prevScene.id !== e.scene.id && game.scenes.has(prevScene.id)) { await prevScene.view().catch(() => {}); await wait(800); }
      Hooks.off("createChatMessage", hook);
      const left = await sweep([...e.tracked]);
      await viewCombat(prevCombat);
      return left;
    };
    e.release = () => Hooks.off("createChatMessage", hook);
    return e;
  };

  // ---------- окно Мастерской ----------
  const root = () => document.getElementById(WS);
  const openWs = async (item) => {
    await api().openWorkshop({ item, mode: "automation" });
    await waitFor(() => root()?.querySelector(".ws-pipe"), 8000);
    await wait(500);
    return root();
  };
  const row = (id) => root()?.querySelector(`.ws-mech [data-mech="${id}"]`) ?? null;
  const pillOf = (id) => row(id)?.querySelector(".ws-pill:not([hidden])")?.textContent.trim() ?? "";   // пилюля «своё» всегда в разметке, скрыта атрибутом hidden
  const sumOf = (id) => row(id)?.querySelector(".ws-sum")?.textContent.trim() ?? "";
  const openRow = async (id) => {
    if (!row(id)?.querySelector(".ws-pfields")) { row(id)?.querySelector("button.ws-psum")?.click(); await waitFor(() => row(id)?.querySelector(".ws-pfields"), 4000); }
    await wait(150);
  };
  const setCheck = async (name, v) => {
    const el = root()?.querySelector(`input[name="${name}"]`);
    if (!el) throw new Error(`нет поля ${name}`);
    el.checked = v; el.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(500);
  };
  // переключатель «Работает ⇄ Выключено в предмете»: нативный чекбокс role=switch; включён = работает, поэтому «выключить» — снять
  const setOff = (id, off) => setCheck(`mech.${id}.off`, !off);
  // перезарядка: сегмент режима «Нет / После использования / По кнопке» (кнопки name="mech.recharge.mode-<v>"); найденный в тексте — с пометкой «(по тексту)»
  const pickRc = async (v) => { const b = root()?.querySelector(`[name="mech.recharge.mode-${v}"]`); if (!b) throw new Error(`нет кнопки режима ${v}`); b.click(); await wait(500); };
  const clickBtn = async (name, ms = 500) => {
    const el = root()?.querySelector(`[name="${name}"]`);
    if (!el || el.disabled) throw new Error(`кнопка ${name} ${el ? "недоступна" : "не найдена"}`);
    el.click(); await wait(ms);
  };
  const saveWs = async () => { await clickBtn("saveItem", 900); await wait(600); };
  const shot = async (e, id, t) => {   // keepOpen: оставляем всё как есть
    if (opts.keepOpen === id) { e.keep = true; }
  };

  // ---------- сценарии ----------
  const S = [];
  const sc = (id, title, run) => S.push({ id, title, run });
  const GOBLIN_STEP = { type: "action", name: "AF шаг", system: { slug: "af-step", actionType: { value: "action" }, actions: { value: 1 }, description: { value: "<p>тест</p>" } } };
  const useAction = async (item) => {
    const t0 = Date.now();
    await bound("rollItemMacro", game.pf2e.rollItemMacro(item.uuid));
    return waitFor(() => game.messages.contents.find((m) => m._stats.createdTime >= t0 && m.flags?.pf2e?.origin?.uuid === item.uuid), 8000);
  };

  sc("recharge", "M1 Перезарядка: строка, «не ограничивать» → блок снимается", async (e, t) => {
    const a0 = await e.copy(SRC.xotanispawn, "Ксотанис"), tk = await e.tok(a0, 1000, 1000), A = e.A(tk);
    const it = A.items.find((i) => i.type === "action" && /#recharge|#перезаряд/i.test(i.system.description?.value ?? ""));
    if (!it) throw new Skip("у копии нет способности с #Recharge");
    const { whyNot } = await imp("builtin/impulse-gate.mjs");
    const c = await e.combat([tk]);
    await A.update({ [`flags.${MOD}.rc_${it.id}`]: { c: c.id, until: c.round + 3 } });
    t.ok(whyNot(A, it) === "recharge", `до правки замок блокирует (${whyNot(A, it)})`);
    await openWs(it);
    t.ok(!!row("recharge"), "строка «Перезарядка»");
    t.ok(pillOf("recharge") === "", `пилюли нет, пока работает (${pillOf("recharge")})`);
    await openRow("recharge");
    const segDef = root().querySelector('[name="mech.recharge.mode-auto"]');   // по тексту — «После использования», выбран и помечен
    t.ok(!!root().querySelector('input[name="mech.recharge.dice"]') && segDef?.getAttribute("aria-pressed") === "true" && /по тексту/.test(segDef.textContent) && !root().querySelector('[name="mech.recharge.mode-default"]') && !!root().querySelector('[name="mech.recharge.mode-off"]') && !!root().querySelector('[name="mech.recharge.mode-button"]'), "поля: сегмент режима («После использования (по тексту)» выбран, варианта «Как в тексте» нет) и срок");
    t.ok(!root().querySelector('.ws-mech input[type="checkbox"]:not([role="switch"])'), "флажков-отрицаний в разделе нет");
    t.ok(!row("recharge").querySelector("button.ws-psum .ws-pill:not([aria-hidden])"), "пилюли кнопки строки скрыты от скринридера");
    t.ok(!!document.getElementById("ws-tip-recharge")?.textContent.trim() && row("recharge").querySelector(".ws-pchip")?.getAttribute("aria-describedby") === "ws-tip-recharge", "подсказка источника доступна без мыши (aria-describedby)");
    await pickRc("auto");   // свой срок — режим «После использования»
    const dice = root().querySelector('input[name="mech.recharge.dice"]');
    dice.value = "1к6"; dice.dispatchEvent(new Event("input", { bubbles: true })); dice.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(700);
    t.ok(/1d6/.test(sumOf("recharge")) && !!row("recharge").querySelector(".ws-dot:not([hidden])"), `«1к6» принято как 1d6, строка помечена «не сохранено» (${sumOf("recharge")})`);
    t.ok(root().querySelector('input[name="mech.recharge.dice"]') === dice, "change не перерисовывает поле срока (подвал остаётся на месте — клик «Сохранить» не теряется)");
    t.ok(/Изменено в предмете|Changed in the item/.test(pillOf("recharge")), `пилюля своего срока (${pillOf("recharge")})`);
    t.ok(root().querySelector('input[name="mech.recharge.dice"]')?.disabled === false, "срок доступен в режиме «После использования»");
    await shot(e, "recharge", t);
    await pickRc("off");
    t.ok(root().querySelector('input[name="mech.recharge.dice"]')?.disabled === true, "при «Выключено» срок недоступен");
    t.ok(!!root().querySelector('[name="resetDraft"]:not([disabled])'), "несохранённая правка: «Сбросить» доступна");
    t.ok(!root().querySelector('[name="saveItem"]').disabled, "«Сохранить» доступна");
    await saveWs();
    t.ok(it.flags?.[MOD]?.mech?.recharge === false, `флаг mech.recharge=false (${JSON.stringify(it.flags?.[MOD]?.mech)})`);
    t.ok(!it.flags?.[MOD]?.rule, "пустое правило не записано");
    t.ok(whyNot(A, it) === null, `блока нет (${whyNot(A, it)})`);
    t.ok(/Выключено в предмете|Off in the item/.test(pillOf("recharge")), `пилюля «выключено в предмете» (${pillOf("recharge")})`);
    const scope = root().querySelector(".ws-scope")?.textContent.trim() ?? "";
    t.ok(/только у этого токена|this token only/.test(scope) && !root().querySelector(".ws-head .ws-sub")?.textContent.match(/^(Запись|Saved to)/), `у раздела: куда пишется флаг, в шапке — нет (${scope})`);
    await it.update({ [`flags.${MOD}.mech`]: { recharge: "1d6" } });
    await wait(400);
    t.ok(whyNot(A, it) === "recharge", "свой срок вместо «не ограничивать»: блок вернулся");
    await openWs(it);
    t.ok(/1d6/.test(sumOf("recharge")), `сводка с 1d6 (${sumOf("recharge")})`);
  });

  sc("req", "M2 Требование: «не проверять» снимает блок", async (e, t) => {
    const a0 = await e.copy(SRC.goblin, "Гоблин"), tk = await e.tok(a0, 1000, 1000), A = e.A(tk);
    const made = await e.give(A, await src(SRC.grab), GOBLIN_STEP);   // у несвязанного токена порядок созданных не гарантирован
    const step = made.find((i) => i.system.slug === "af-step"), grab = made.find((i) => i !== step);
    const { whyNot } = await imp("builtin/impulse-gate.mjs");
    const c = await e.combat([tk]);
    t.ok(!!c.started, "бой начат");
    t.ok(!!(await useAction(step)), "предыдущее действие — не Удар");
    t.ok(whyNot(A, grab) === "req", `Хватка заблокирована (${whyNot(A, grab)})`);
    await openWs(grab);
    t.ok(!!row("req"), "строка «Требования»");
    t.ok(/Удар|Strike/.test(sumOf("req")), `сводка называет Удар (${sumOf("req")})`);
    await openRow("req");
    await shot(e, "req", t);
    await setOff("req", true);
    await saveWs();
    t.ok(grab.flags?.[MOD]?.mech?.req === false, "флаг mech.req=false");
    t.ok(whyNot(A, grab) === null, `блока нет (${whyNot(A, grab)})`);
    t.ok(/Выключено в предмете|Off in the item/.test(pillOf("req")), "пилюля");
  });

  sc("strike", "M3 Удар → способность: причина состояния, «не запускать Ударом» → ручная карточка", async (e, t) => {
    const a0 = await e.copy(SRC.ghoul, "Гуль"), tk = await e.tok(a0, 1000, 1000), A = e.A(tk);
    const it = A.items.find((i) => i.type === "action" && i.system.slug === "ghoul-fever");
    if (!it) throw new Skip("нет Ghoul Fever");
    const { strikeLinkState, strikeLinked } = await imp("strike-link.mjs");
    let st = strikeLinkState(it);
    if (!st) throw new Skip("Удар не ссылается на способность (связи нет)");
    await openWs(it);
    t.ok(!!row("strike"), "строка «От Удара»");
    await shot(e, "strike", t);
    if (st.off === "needRule") {
      t.ok(/принять|accepting/i.test(pillOf("strike")), `пилюля «нужно принять правило» (${pillOf("strike")})`);
      t.ok(strikeLinked(it) === null, "связь не работает до принятия");
      await clickBtn("accept", 900);
      await wait(600);
      st = strikeLinkState(it);
      t.ok(st?.off === null, `после «Принять»: работает (${st?.off})`);
    }
    t.ok(!!strikeLinked(it), "связь работает");
    await openWs(it);
    await openRow("strike");
    await setOff("strike", true);
    await saveWs();
    t.ok(it.flags?.[MOD]?.mech?.strike === false, "флаг mech.strike=false");
    t.ok(strikeLinked(it) === null, "ручная карточка возвращается (strikeLinked null)");
    t.ok(strikeLinkState(it)?.off === "flag", "причина — flag");
    t.ok(/Выключено в предмете|Off in the item/.test(pillOf("strike")), `пилюля (${pillOf("strike")})`);
  });

  sc("maneuvers", "M5 Манёвр заклинанием: выбор манёвров; у Magnetic Attraction полей нет", async (e, t) => {
    const hero = await e.hero("Телекинетик", SRC.telekinetic, SRC.magnetic);
    const tm = hero.items.find((i) => i.system.slug === "telekinetic-maneuver"), mg = hero.items.find((i) => i.system.slug === "magnetic-attraction");
    if (!tm || !mg) throw new Skip("нет заклинаний");
    const { maneuversOf } = await imp("builtin/maneuver.mjs");
    t.ok(maneuversOf(tm).length === 4, `по умолчанию 4 манёвра (${maneuversOf(tm)})`);
    await openWs(tm);
    t.ok(!!row("maneuvers"), "строка «Манёвры»");
    await openRow("maneuvers");
    await shot(e, "maneuvers", t);
    await clickBtn("mech.maneuvers.auto-false");
    for (const k of ["disarm", "shove", "reposition"]) await clickBtn(`mech.maneuvers.list-${k}`, 350);
    await saveWs();
    t.ok(JSON.stringify(tm.flags?.[MOD]?.mech?.maneuvers) === '["trip"]', `флаг maneuvers (${JSON.stringify(tm.flags?.[MOD]?.mech)})`);
    t.ok(JSON.stringify(maneuversOf(tm)) === '["trip"]', `на карточке остался один манёвр (${maneuversOf(tm)})`);
    t.ok(/Изменено в предмете|Changed in the item/.test(pillOf("maneuvers")) && /Кнопка на карточке|A button on the casting card/.test(sumOf("maneuvers")), `ручной список: пилюля и единственное число (${pillOf("maneuvers")} / ${sumOf("maneuvers")})`);
    await openWs(mg);
    t.ok(!!row("maneuvers"), "Magnetic Attraction: строка есть");
    t.ok(!row("maneuvers").querySelector("button.ws-psum"), "…но без полей (манёвр один)");
  });

  sc("permanent", "M6 Постоянное состояние: у Ofalth Zombie Slowed — документом pf2e (строка это говорит, «не накладывать» снимает только запрет реакций); у копии без документа «не накладывать» снимает и Slowed", async (e, t) => {
    const noReact = async (a) => (await import(`/modules/${MOD}/scripts/inline-effect.mjs`)).noReactions(a);
    const a0 = await e.copy(SRC.zombie, "Зомби"), tk = await e.tok(a0, 1000, 1000), A = e.A(tk);
    const it = A.items.find((i) => i.type === "action" && i.system.slug === "slow");
    if (!it) throw new Skip("нет Slow");
    const slowed = (x = A) => x.hasCondition("slowed");   // состояние из GrantItem inMemoryOnly живёт в actor.conditions, не в itemTypes
    t.ok(!!(await waitFor(slowed, 4000)) && (await noReact(A)), "до правки: Slowed и нет реакций");
    await openWs(it);
    t.ok(!!row("permanent"), "строка «Состояние»");
    t.ok(!/pf2e-automations/.test(pillOf("permanent")), "«уступает» не показывается");
    t.ok(/данных pf2e|pf2e data/.test(sumOf("permanent")), `сводка: состояние уже в данных pf2e (${sumOf("permanent")})`);
    await openRow("permanent");
    await shot(e, "permanent", t);
    await setOff("permanent", true);
    await saveWs();
    t.ok(it.flags?.[MOD]?.mech?.permanent === false, "флаг mech.permanent=false");
    t.ok(!!(await waitFor(async () => !(await noReact(A)), 6000)), "off: запрет реакций снят");
    t.ok(slowed(), "off: Slowed из данных pf2e остался");
    t.ok(/Запрет реакций выключен в предмете|Reaction ban off in the item/.test(pillOf("permanent")), `пилюля: только запрет реакций (${pillOf("permanent")})`);
    await it.update({ [`flags.${MOD}.-=mech`]: null });
    t.ok(!!(await waitFor(async () => noReact(A), 6000)), "флаг убран — запрет реакций вернулся");
    // копия без документа состояния: Slowed даёт только модуль
    const b0 = await e.copy(SRC.zombie, "Зомби без документа"), tb = await e.tok(b0, 1300, 1000), B = e.A(tb);
    const docs = B.itemTypes.condition.filter((c) => c.slug === "slowed" && B._source.items.some((x) => x._id === c.id));
    if (docs.length) await B.deleteEmbeddedDocuments("Item", docs.map((c) => c.id));
    t.ok(!!(await waitFor(() => slowed(B), 4000)), "без документа: Slowed от модуля");
    const ib = B.items.find((i) => i.type === "action" && i.system.slug === "slow");
    await ib.update({ [`flags.${MOD}.mech.permanent`]: false });
    t.ok(!!(await waitFor(() => !slowed(B), 6000)), "без документа: «не накладывать» снимает Slowed");
  });

  sc("spirit", "M7 Перенос ПЗ: только показ", async (e, t) => {
    const hero = await e.hero("Заклинатель", SRC.spiritLink);
    const it = hero.items.find((i) => i.system.slug === "spirit-link");
    if (!it) throw new Skip("нет Spirit Link");
    await openWs(it);
    t.ok(!!row("spirit"), "строка «Перенос ПЗ»");
    t.ok(!row("spirit").querySelector("button.ws-psum"), "без переключателей");
    t.ok(/сотворени|casting/i.test(sumOf("spirit")) && /ход|turn/i.test(sumOf("spirit")), `сводка: сразу и в начале хода (${sumOf("spirit")})`);
    await shot(e, "spirit", t);
  });

  sc("shape", "M8 Метамагия: у героя (флаг) и у NPC (по slug) — только показ", async (e, t) => {
    const hero = await e.hero("Метамаг", SRC.reachSpell);
    const it = hero.items.find((i) => i.system.slug === "reach-spell");
    if (!it) throw new Skip("нет Reach Spell");
    t.ok(!!(await waitFor(() => it.flags?.[MOD]?.spellshape, 8000)), "миграция записала флаг метамагии");
    await openWs(it);
    t.ok(!!row("shape"), "герой: строка метамагии");
    t.ok(sumOf("shape").includes(it.name), `сводка с названием предмета (${sumOf("shape")})`);
    t.ok(!/30/.test(sumOf("shape")), "без «+30 фт»");
    await shot(e, "shape", t);
    const a0 = await e.copy(SRC.voz, "Воз"), tk = await e.tok(a0, 1000, 1000), A = e.A(tk);
    const rs = A.items.find((i) => i.system.slug === "reach-spell");
    if (rs) { await openWs(rs); t.ok(!!row("shape"), "NPC: строка метамагии"); }
  });

  sc("mixed", "Правило и механизм вместе; только механизм (без пустого правила); без механизмов (раздела нет)", async (e, t) => {
    const a0 = await e.copy(SRC.goblin, "Гоблин"), tk = await e.tok(a0, 1000, 1000), A = e.A(tk);
    const rc = (n) => `<p>Нельзя снова [[/gmr 1d4 #Recharge ${n}]]{1d4 раунда}.</p>`;   // метка — имя самой способности: чужая метка блокирует другую способность
    const rule = { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "frightened", value: 1 } }] } };
    if (!api().validateRule(rule).ok) throw new Error("тестовое правило невалидно");
    await e.give(A,
      { type: "action", name: "AF с правилом", system: { slug: "af-both", actionType: { value: "action" }, actions: { value: 1 }, description: { value: rc("AF с правилом") } }, flags: { [MOD]: { rule } } },
      { type: "action", name: "AF только механизм", system: { slug: "af-only", actionType: { value: "action" }, actions: { value: 1 }, description: { value: rc("AF только механизм") } } },
      { type: "action", name: "AF без механизмов", system: { slug: "af-none", actionType: { value: "action" }, actions: { value: 1 }, description: { value: "<p>тест</p>" } } });
    // у несвязанного токена порядок созданных документов не гарантирован — берём по имени
    const byName = (n) => A.items.find((i) => i.name === n);
    const both = byName("AF с правилом"), only = byName("AF только механизм"), none = byName("AF без механизмов");
    await openWs(both);
    t.ok(!!row("recharge") && !!root().querySelector(".ws-pipe:not(.ws-mech) .ws-prow"), "правило и механизм: оба блока");
    await shot(e, "mixed", t);
    await openWs(only);
    t.ok(!!row("recharge"), "только механизм: строка есть");
    t.ok(!only.flags?.[MOD]?.rule, "правила в флаге нет");
    t.ok(!!root().querySelector('[name="startRule"]') && !root().querySelector('[name="row-roll"]') && /Правила нет|no rule/i.test(root().querySelector('[data-application-part="aside"] .ws-note')?.textContent ?? ""), "без правила: справа одна строка, конвейер свёрнут до «Создать правило»");
    t.ok(root().querySelector('[name="saveItem"]').disabled, "«Сохранить» недоступна без правок");
    t.ok(root().querySelector('[name="worldSave-slug"]').disabled, "«В мир → правило» недоступно: правила нет и не правили");
    await openRow("recharge");
    await pickRc("off");
    await saveWs();
    t.ok(only.flags?.[MOD]?.mech?.recharge === false && !only.flags?.[MOD]?.rule, "сохранился один mech, пустое onUse не записано");
    const msg = root().querySelector(".ws-foot-msg")?.textContent.trim() ?? "";
    t.ok(/(Правило|Rule): (нет|none)/.test(msg) && /(Встроенная автоматизация|Built-in automation): (изменено в предмете|changed in the item)/.test(msg), `статус подвала из двух частей (${msg})`);
    await openWs(none);
    t.ok(!root().querySelector(".ws-mech [data-mech]") && !!root().querySelector("[name=addRecharge]"), "без механизмов: строк нет, есть только «Добавить перезарядку»");
    await openWs(both);
    await it_sheetList(both, t);
  });
  const it_sheetList = async (item, t) => {
    await item.sheet.render(true);
    const tab = await waitFor(() => document.querySelector(".tab.automato .af-mech"), 8000);
    t.ok(!!tab, "вкладка листа: список «Работает само»");
    await item.sheet.close();
  };

  sc("derived", "Выведенный источник: «Для всех копий этого существа» → мировое правило подхватывает вторая копия", async (e, t) => {
    const a1 = await e.copy(SRC.ghoul, "Гуль 1"), a2 = await e.copy(SRC.ghoul, "Гуль 2");
    const t1 = await e.tok(a1, 1000, 1000), t2 = await e.tok(a2, 1300, 1000), A1 = e.A(t1), A2 = e.A(t2);
    const it1 = A1.items.find((i) => i.system.slug === "ghoul-fever"), it2 = A2.items.find((i) => i.system.slug === "ghoul-fever");
    if (!it1 || !it2) throw new Skip("нет Ghoul Fever");
    const rules = await imp("rules.mjs");
    const key = rules.worldKeyOf(it1, rules.resolveRule(it1), "source").source;
    t.ok(!!key && rules.keyDerived(it1, rules.resolveRule(it1)), `ключ выведен от существа (${key})`);
    await openWs(it1);
    const label = root().querySelector('[name="worldSave-source"]')?.textContent.trim();
    t.ok(/существ|creature/i.test(label ?? ""), `пункт меню «для всех копий существа» (${label})`);
    t.ok(!root().querySelector('[name="worldSave-source"]').disabled, "пункт доступен (noSource снят)");
    await shot(e, "derived", t);
    try {
      await clickBtn("worldSave-source", 1500);
      t.ok(rules.resolveRule(it2)?.source === "world", `вторая копия берёт мировое правило (${rules.resolveRule(it2)?.source})`);
      await it1.sheet.render(true);
      const meta = await waitFor(() => document.querySelector(".tab.automato .af-meta")?.textContent.includes(key) && document.querySelector(".tab.automato .af-meta"), 8000);
      t.ok(!!meta && /существ|creature/i.test(meta.textContent), "на листе у source пометка «выведен от существа»");
      await it1.sheet.close();
    } finally {
      await rules.saveWorldRule({ source: key }, null).catch((err) => console.warn("workshop-mechanisms: мировое правило не убрано", key, err));   // мировой каталог — вернуть как был
    }
  });

  // ---------- прогон ----------
  const rows = [];
  const pick = S.filter((s) => (!opts.only || opts.only.includes(s.id)) && !opts.skip.includes(s.id));
  try {
    for (const s of pick) {
      const t = { fails: [], n: 0, ok(c, label) { this.n++; if (!c) this.fails.push(label); } };
      let e = null, status = "ok", detail = "";
      notes.length = 0;
      try {
        e = await newEnv(s.id); cur = e;
        const run = s.run(e, t); run.catch(() => {});
        let timer;
        try { await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`таймаут 120 с; шаг: ${e.step}`)), 120000); })]); }
        finally { clearTimeout(timer); }
        if (t.fails.length) { status = "fail"; detail = t.fails.join("; "); } else detail = `${t.n} проверок`;
      } catch (err) {
        if (err instanceof Skip) { status = "skip"; detail = err.message; }
        else { status = "fail"; detail = `${t.fails.length ? t.fails.join("; ") + "; " : ""}ошибка: ${String(err?.message ?? err).slice(0, 400)}`; console.error(`${MOD} workshop-mechanisms | ${s.id}`, err); }
      } finally {
        if (e?.keep && opts.keepOpen === s.id) {
          const env = e;
          window.__afWMKeep = { id: s.id, cleanup: async () => { const left = await env.dispose(); return { left }; } };   // окно, сцена и копии остаются для скриншота
          detail += " | окно оставлено открытым: window.__afWMKeep.cleanup()";
        } else {
          const left = e ? await e.dispose().catch((x) => `dispose: ${x}`) : 0;
          if (left) { status = "fail"; detail += ` | после уборки осталось: ${left}`; }
        }
      }
      const errs = notes.filter((n) => /^(console\.error|uncaught)/.test(n) && !/createScrollingText|showFloatyText|reading 'position'\) at set y/.test(n));
      if (errs.length) { status = "fail"; detail += ` | ошибки: ${errs.slice(0, 3).join(" / ")}`; }
      else if (status === "fail" && notes.length) detail += ` | уведомления: ${notes.slice(0, 4).join(" / ")}`;
      rows.push({ id: s.id, title: s.title, status, detail });
    }
  } finally {
    Object.assign(N, nOrig);
    console.error = ceOrig;
    if (!window.__afWMKeep) { await sweep(); await prevScene?.view(); await viewCombat(prevCombat); }
  }
  const out = rows.map((r) => `${r.status === "ok" ? "PASS" : r.status.toUpperCase()} ${r.id}: ${r.detail}`);
  console.table(rows.map(({ id, status, detail }) => ({ сценарий: id, статус: status, подробности: detail })));
  window.__afWMResult = out;
  return out;
}
