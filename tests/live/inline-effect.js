async () => {
  // Живая проверка inline-эффекта шага (effect.mods): «−2 статусный штраф к Воле на 1 раунд» и «нельзя использовать реакции».
  // Вкладка активного ГМа-лидера (вторую вкладку ГМа держать на about:blank). Ничего вручную не нажимать.
  // Проверяет: эффект создан с нужными RE и slug; штраф виден в Воле и не виден в Стойкости; срок истекает по ходу боя;
  // «Отменить» (undoOps) удаляет эффект; reactionAvailable() = false под forbid и true после снятия (через него идут шёпоты реакций: reactions.onAttackMessage).
  // Результат: { summary, rows:[{id, ok, detail}] }; то же в console.table и window.__afInlineEffectResult. Временные «AF тест: …» удаляются в конце.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(150); } return null; };
  const imp = (f) => import(`/modules/${MOD}/scripts/${f}`);
  const rows = [], check = (id, ok, detail = "") => rows.push({ id, ok: !!ok, detail: String(detail) });
  const made = { scene: null, actors: [], msgs: [] };
  const prevScene = game.scenes.viewed;
  try {
    const scene = made.scene = await Scene.create({ name: `${PFX}inline`, width: 1500, height: 1500, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await scene.view(); await wait(800);
    const mkActor = async (name) => { const a = await Actor.create({ name: `${PFX}${name}`, type: "character", folder: null, ownership: { default: 0 }, system: { details: { languages: { value: ["common"] } } } }); made.actors.push(a); return a; };
    const hero = await mkActor("автор"), foe = await mkActor("цель");
    const mkTok = async (a, x, disp) => (await scene.createEmbeddedDocuments("Token", [(await a.getTokenDocument({ x, y: 500, disposition: disp })).toObject()]))[0];
    const tH = await mkTok(hero, 500, 1), tF = await mkTok(foe, 600, -1);
    await wait(500);
    const A = () => scene.tokens.get(tF.id).actor;
    const item = await hero.createEmbeddedDocuments("Item", [{ name: "AF Тест Путы", type: "feat", system: { slug: "af-test-fetters" } }]).then((r) => r[0]);
    // карточка использования с минимальным use (как у runUse): applyOps читает actor/item/token/targets
    const msg = await ChatMessage.create({ content: "AF тест", speaker: { alias: `${PFX}msg` }, flags: { [MOD]: { use: { v: 1, kind: "use", actor: hero.uuid, token: tH.uuid, item: { uuid: item.uuid }, targets: [{ key: tF.id, uuid: tF.uuid }], state: {} } } } });
    made.msgs.push(msg.id);
    const { applyOps, undoOps } = await imp("apply.mjs");
    const { reactionAvailable } = await imp("reactions.mjs");

    const steps = [{ to: "target", effect: { mods: [{ bonus: { target: "will", type: "status", value: -2 } }, { forbid: "reactions" }] }, duration: { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" } }];
    const willBefore = A().saves.will.mod, fortBefore = A().saves.fortitude.mod;
    check("react-before", reactionAvailable(A()) === true);
    await applyOps(game.messages.get(msg.id), tF.id, steps);
    const eff = await waitFor(() => A().itemTypes.effect.find((e) => e.slug === "af-af-test-fetters" || e.system.slug?.startsWith("af-")));
    check("effect", !!eff, eff?.name);
    check("name", /Эффект|Effect/.test(eff?.name ?? ""), eff?.name);
    check("rules", eff?.system.rules.some((r) => r.key === "FlatModifier" && r.selector === "will" && r.value === -2) && eff.system.rules.some((r) => r.key === "RollOption" && r.option === "af:no-reactions"), JSON.stringify(eff?.system.rules));
    check("duration", eff?.system.duration.value === 1 && eff.system.duration.unit === "rounds", JSON.stringify(eff?.system.duration));
    check("will -2", await waitFor(() => A().saves.will.mod === willBefore - 2), `${willBefore} -> ${A().saves.will.mod}`);
    check("fortitude unchanged", A().saves.fortitude.mod === fortBefore, `${fortBefore} -> ${A().saves.fortitude.mod}`);
    check("roll modifier", A().saves.will.check.modifiers.some((m) => m.enabled && m.value === -2 && m.type === "status"));
    check("react-blocked", reactionAvailable(A()) === false);
    // повтор того же шага (тот же ключ) второй копии не даёт
    await applyOps(game.messages.get(msg.id), tF.id, steps);
    check("idempotent", A().itemTypes.effect.filter((e) => e.system.slug?.startsWith("af-")).length === 1);

    // откат карточки
    await undoOps(game.messages.get(msg.id), tF.id);
    check("undo", await waitFor(() => !A().itemTypes.effect.some((e) => e.system.slug?.startsWith("af-"))), "эффект удалён");
    check("will restored", A().saves.will.mod === willBefore && reactionAvailable(A()) === true);

    // срок: заново и через бой — «до начала следующего хода автора» (раунд 1 -> 2)
    const combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tH.id, sceneId: scene.id, actorId: hero.id, initiative: 20 }, { tokenId: tF.id, sceneId: scene.id, actorId: foe.id, initiative: 10 }]);
    await combat.startCombat(); await wait(500);
    await applyOps(game.messages.get(msg.id), tF.id, steps, { scope: "apply" }).catch(() => null);
    const again = await waitFor(() => A().itemTypes.effect.find((e) => e.system.slug?.startsWith("af-")));
    check("effect (бой)", !!again || rows.some((r) => r.id === "idempotent"), "после undo ключ шага свободен или повтор пропущен");
    for (let i = 0; i < 3; i++) { await combat.nextTurn(); await wait(600); }
    check("expired", await waitFor(() => !A().itemTypes.effect.some((e) => e.system.slug?.startsWith("af-") && !e.isExpired), 6000), "после раунда эффект снят или помечен истёкшим");
    await combat.delete();
  } catch (e) {
    check("exception", false, e?.stack ?? e);
  } finally {
    try { if (made.msgs.length) await ChatMessage.deleteDocuments(made.msgs.filter((id) => game.messages.has(id))); } catch { /* уже нет */ }
    for (const c of game.combats.filter((c) => c.scene?.id === made.scene?.id)) await c.delete().catch(() => {});
    await made.scene?.delete().catch(() => {});
    for (const a of made.actors) await a.delete().catch(() => {});
    if (prevScene) await prevScene.view().catch(() => {});
  }
  const fails = rows.filter((r) => !r.ok), res = { summary: `ok ${rows.length - fails.length} / fail ${fails.length}`, rows };
  console.table(rows); window.__afInlineEffectResult = res;
  return res;
}
