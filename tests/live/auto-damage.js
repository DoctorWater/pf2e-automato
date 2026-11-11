async () => {
  // Автоурон по обычному спасброску (builtin/basic-damage.mjs): один раз, кнопки Toolbelt/pf2e у цели закрыты, после отката открыты;
  // с Dice So Nice урон (damage-taken) создаётся не раньше, чем waitFor3DAnimationByMessageID разрешился.
  // Синтетический сценарий: карточка use и сообщение урона собираются руками (без каста), нанесение идёт настоящим settle(). Не запускался автором правки.
  // Требования: вкладка ГМа = активный ГМ; временная сцена и актёры «AF тест: …» убираются в finally. Результат — window.__afAutoDamage.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  const fails = [], ok = (c, label) => { if (!c) fails.push(label); };
  const bd = await import(`/modules/${MOD}/scripts/builtin/basic-damage.mjs`);
  const prevApply = game.settings.get(MOD, "mode.apply"), prevScene = game.scenes.viewed;
  const made = { msgs: [] }, log = [];
  let scene, restore = null;
  try {
    await game.settings.set(MOD, "mode.apply", "auto");
    scene = await Scene.create({ name: `${PFX}автоурон`, width: 1200, height: 1000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await scene.view(); await wait(600);
    const mk = async (name, x) => {
      const a = await Actor.create({ name: `${PFX}${name}`, type: "npc", system: { attributes: { hp: { value: 100, max: 100 } }, details: { alliance: "opposition" } } });
      const [t] = await scene.createEmbeddedDocuments("Token", [{ name: a.name, actorId: a.id, x, y: 300, actorLink: true }]);
      return { a, t };
    };
    const C = await mk("кастер", 200), V = await mk("жертва", 500);
    const key = V.t.id;

    // карточка use с итогом спасброска «провал» (×1) и урон с заранее поставленной связью (link() не вмешается, наносит наш settle)
    const card = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: C.a }), content: "карточка (тест)",
      flags: { [MOD]: { use: { v: 1, kind: "use", rule: { onUse: { challenge: { statistic: "reflex", basic: true, byDegree: {} } } }, slug: "af-test", item: { uuid: null, name: "AF тест", type: "spell" },
        actor: C.a.uuid, token: C.t.uuid, dc: 20, createdAt: Date.now(), targets: [{ key, uuid: V.t.uuid, name: V.t.name, pc: false }],
        state: { challenge: { results: { [key]: { degree: 1, total: 5, src: "own" } } } } } } }
    });
    made.msgs.push(card.id);
    const DR = CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll");
    const roll = await new DR("10[fire]").evaluate();

    // порядок: момент разрешения анимации DSN vs создание damage-taken
    const dsn = game.dice3d, stamps = {};
    if (dsn?.waitFor3DAnimationByMessageID) {
      const orig = dsn.waitFor3DAnimationByMessageID;
      dsn.waitFor3DAnimationByMessageID = async function (id) { const r = await orig.call(this, id); stamps.animDone ??= performance.now(); stamps.animId = id; return r; };
      restore = () => { dsn.waitFor3DAnimationByMessageID = orig; };
    }
    const hookId = Hooks.on("createChatMessage", (m) => { if (m.flags?.pf2e?.context?.type === "damage-taken") (stamps.taken ??= performance.now(), log.push(`damage-taken ${m.id}`)); });
    const hp0 = V.a.hitPoints.value;
    const dmg = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: C.a }), rolls: [roll], flags: { pf2e: { context: { type: "damage-roll", options: [] } }, [MOD]: { basicDamage: { card: card.id, done: {}, table: [2, 1, 0.5, 0] } } }
    });
    made.msgs.push(dmg.id);
    await bd.settle(dmg.id);
    const taken = await waitFor(() => game.messages.contents.filter((m) => m.flags?.pf2e?.context?.type === "damage-taken" && m.flags.pf2e.context.options?.includes(bd.markerOf(dmg.id, key))), 8000);
    Hooks.off("createChatMessage", hookId);
    ok(taken?.length === 1, `damage-taken: ${taken?.length}`);
    taken?.forEach((m) => made.msgs.push(m.id));
    ok(hp0 - V.a.hitPoints.value === 10, `потеряно ОЗ: ${hp0 - V.a.hitPoints.value}`);
    await bd.settle(dmg.id);   // повтор: ничего нового
    ok(game.messages.filter((m) => m.flags?.pf2e?.context?.options?.includes(bd.markerOf(dmg.id, key))).length === 1, "повторный settle не нанёс второй раз");
    if (dsn?.waitFor3DAnimationByMessageID) ok(stamps.animId === dmg.id && stamps.animDone <= stamps.taken, `DSN: анимация ${stamps.animDone?.toFixed?.(0)} <= damage-taken ${stamps.taken?.toFixed?.(0)}`);
    else log.push("DSN не активен: порядок не проверен");

    // кнопки: строка цели (настоящая строка Toolbelt, если есть; иначе вставляем такую же) закрыта у нанесённого, открыта после отката
    const cur = () => game.messages.get(dmg.id);
    ok(!!bd.lockFor(cur().flags[MOD].basicDamage, key), "done[key] есть и не skipped/reverted");
    const rowOf = () => {
      const el = ui.chat.element.querySelector(`[data-message-id="${dmg.id}"]`);
      if (!el) return null;
      let row = el.querySelector(`section.damage-application[data-target-uuid="${V.t.uuid}"]`);
      if (!row) {
        row = document.createElement("section"); row.className = "damage-application"; row.dataset.targetUuid = V.t.uuid;
        row.innerHTML = `<button type="button" data-action="target-applyDamage" data-multiplier="1">Урон</button><button type="button" data-action="target-shieldBlock">Блок</button>`;
        el.querySelector(".message-content")?.append(row);
        log.push("строки Toolbelt нет — вставлена тестовая");
      }
      return row;
    };
    await ui.chat.updateMessage(cur()); await wait(500);
    let row = rowOf(); await wait(400);
    let hits = 0;
    row?.querySelectorAll("[data-action^=target-]").forEach((b) => b.addEventListener("click", () => hits++));
    const lockedNow = () => [...(row?.querySelectorAll("[data-action^=target-]") ?? [])].every((b) => b.getAttribute("aria-disabled") === "true");
    ok(!!row && lockedNow(), "кнопки цели закрыты (aria-disabled) после нанесения");
    row?.querySelector("[data-action=target-applyDamage]")?.click();
    ok(hits === 0, `клик по закрытой кнопке дошёл до обработчика: ${hits}`);

    // откат штатной кнопкой pf2e (isReverted) -> reverted в флаге -> кнопки снова доступны
    const takenMsg = taken?.[0];
    if (takenMsg) {
      await V.a.undoDamage?.(takenMsg.flags.pf2e.appliedDamage);
      await takenMsg.update({ "flags.pf2e.appliedDamage.isReverted": true });
      ok(!!(await waitFor(() => cur().flags[MOD].basicDamage.done[key]?.reverted, 6000)), "после отката done[key].reverted");
      ok(!bd.lockFor(cur().flags[MOD].basicDamage, key), "после отката цель не заблокирована");
      await ui.chat.updateMessage(cur()); await wait(600);
      row = rowOf(); await wait(400);
      ok(!!row && [...row.querySelectorAll("[data-action^=target-]")].every((b) => b.getAttribute("aria-disabled") !== "true"), "кнопки доступны после отката");
    }
  } catch (err) { fails.push(`ошибка: ${String(err?.stack ?? err).slice(0, 400)}`); }
  finally {
    restore?.();
    try { await game.settings.set(MOD, "mode.apply", prevApply); } catch { /* ok */ }
    const ids = [...made.msgs, ...game.messages.filter((m) => m.speaker?.scene === scene?.id || game.actors.some((a) => a.name?.startsWith(PFX) && a.id === m.speaker?.actor)).map((m) => m.id)].filter((id) => game.messages.has(id));
    if (ids.length) await ChatMessage.deleteDocuments([...new Set(ids)]).catch(() => {});
    await scene?.delete().catch(() => {});
    for (const a of game.actors.filter((a) => a.name?.startsWith(PFX))) await a.delete().catch(() => {});
    await prevScene?.view();
  }
  const res = { status: fails.length ? "FAIL" : "PASS", fails, log };
  window.__afAutoDamage = res;
  return res;
}
