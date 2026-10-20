async () => {
  // Живая проверка: базовые действия (game.pf2e.actions + макрос Workbench), Двойной взмах, Устрашающий удар. Только временные актёры/сцена.
  const MOD = "pf2e-automato";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { passes: {}, errors: [] };
  const t0 = Date.now();
  const prev = game.scenes.viewed;
  const myMsgs = new Set(); const hM = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) myMsgs.add(m.id); });
  const hE = Hooks.on("error", (loc, e) => out.errors.push(String(e?.message ?? e).slice(0, 200)));
  const userFlags = foundry.utils.deepClone(game.user.flags.pf2e?.settings ?? {});
  const yieldPrev = game.settings.get(MOD, "yieldToAutomations");
  const answer = async (re, title, timeout = 6000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const app of foundry.applications.instances.values()) {
        if (!(app instanceof foundry.applications.api.DialogV2) || !title.test(app.title ?? "")) continue;
        const btn = [...(app.element?.querySelectorAll?.("button") ?? [])].find((b) => re.test(b.textContent));
        if (btn) { const t = btn.textContent.trim(); btn.click(); return t; }
      }
      await wait(150);
    }
    return null;
  };
  const waitFor = async (fn, timeout = 10000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { } await wait(150); } return null; };
  const scene = await Scene.create({ name: "AF tmp actions", width: 2000, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
  let foe, hero;
  try {
    await game.user.update({ "flags.pf2e.settings.showCheckDialogs": false, "flags.pf2e.settings.showDamageDialogs": false });
    await scene.view(); await wait(1000);
    const gob = await fromUuid("Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4");
    foe = await Actor.create({ ...gob.toObject(), name: "AF tmp foe", folder: null, ownership: { default: 0 } });
    hero = await Actor.create({ name: "AF tmp hero", type: "character", folder: null, ownership: { default: 0 }, system: { details: { languages: { value: ["common"] } } } });
    const mk = async (a, x, y, disp) => (await scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y, disposition: disp })).toObject() }]))[0];
    const tH = await mk(hero, 500, 500, 1), tF = await mk(foe, 600, 500, -1);
    await wait(800);
    const fA = () => scene.tokens.get(tF.id).actor;
    const state = (a) => a.items.filter((i) => ["condition", "effect"].includes(i.type) && i.system.slug !== "af-tmp-bonus").map((i) => `${i.system.slug ?? i.name}${i.system.value?.value ? ":" + i.system.value.value : ""}${i.flags?.[MOD]?.meta ? "*" : ""}`);
    const clear = async () => { const a = fA(); const ids = a.items.filter((i) => ["condition", "effect"].includes(i.type)).map((i) => i.id); if (ids.length) await a.deleteEmbeddedDocuments("Item", ids); const h = hero.items.filter((i) => ["condition", "effect"].includes(i.type) && i.system.slug !== "af-tmp-bonus").map((i) => i.id); if (h.length) await hero.deleteEmbeddedDocuments("Item", h); };
    const aim = async () => { tH.object.control({ releaseOthers: true }); tF.object.setTarget(true, { releaseOthers: true, groupSelection: false }); await wait(200); };
    const buttons = (m) => [...(document.querySelector(`#chat [data-message-id="${m.id}"]`)?.querySelectorAll(".pf2e-automato button[data-action]") ?? [])].map((b) => `${b.dataset.action}${b.disabled ? "(off)" : ""}`);
    const clickAll = async (m) => { const done = []; for (const b of [...(document.querySelector(`#chat [data-message-id="${m.id}"]`)?.querySelectorAll(".pf2e-automato button[data-action]:not([disabled])") ?? [])]) { if (!/^apply/.test(b.dataset.action)) continue; b.click(); done.push(b.dataset.action); await wait(1200); } return done; };
    const rollMsg = (since, slug) => game.messages.contents.filter((m) => m._stats.createdTime >= since && m.flags.pf2e?.context?.options?.includes(`action:${slug}`)).at(-1);
    const probe = async (label, slug, fire) => {
      await clear(); await aim();
      const since = Date.now();
      try { await fire(); } catch (e) { return { error: String(e?.stack ?? e).slice(0, 300) }; }
      const m = await waitFor(() => rollMsg(since, slug), 12000);
      if (!m) return { error: "нет сообщения броска" };
      const flagged = await waitFor(() => game.messages.get(m.id)?.flags?.[MOD]?.use, 4000);
      await wait(1500);
      const res = { heroBefore: state(hero), outcome: m.flags.pf2e.context.outcome, ourUse: !!flagged, result: flagged?.state?.challenge?.results?.[tF.id]?.degree ?? null, buttons: buttons(m), foeBefore: state(fA()) };
      res.clicked = await clickAll(m); await wait(800);
      res.foeAfter = state(fA()); res.hero = state(hero);
      return res;
    };
    const wbPack = game.packs.get("xdy-pf2e-workbench.asymonous-benefactor-macros-internal");
    const wbDem = wbPack ? await wbPack.getDocument((await wbPack.getIndex()).find((e) => e.name === "XDY DO_NOT_IMPORT Demoralize")._id) : null;

    const bonus = { type: "effect", name: "AF tmp bonus", system: { slug: "af-tmp-bonus", rules: [{ key: "FlatModifier", selector: "skill-check", value: 30, type: "untyped" }] } };
    for (const [y, plus] of [[yieldPrev, false], [false, false], [false, true]]) {
      await game.settings.set(MOD, "yieldToAutomations", y);
      const bonusItem = plus ? (await hero.createEmbeddedDocuments("Item", [bonus]))[0] : null;
      await wait(300);
      const P = out.passes[`yield=${y}${plus ? " +30" : ""}`] = {};
      P.demoralize = await probe("dem", "demoralize", () => game.pf2e.actions.get("demoralize").use({ actors: [hero] }));
      P.trip = await probe("trip", "trip", () => game.pf2e.actions.get("trip").use({ actors: [hero], multipleAttackPenalty: 0 }));
      P.feint = await probe("feint", "feint", () => game.pf2e.actions.get("feint").use({ actors: [hero] }));
      P.workbenchDemoralize = wbDem ? await probe("wb", "demoralize", async () => { const p = wbDem.execute({ actor: hero, token: tH.object }); await answer(/Boo/i, /demoralize/i); await p; }) : "нет макроса";
      if (bonusItem) await bonusItem.delete();
    }
    await game.settings.set(MOD, "yieldToAutomations", yieldPrev);

    // --- Двойной взмах и Устрашающий удар ---
    const add = async (u, patch = {}) => { const d = (await fromUuid(u)).toObject(); foundry.utils.mergeObject(d, patch); return (await hero.createEmbeddedDocuments("Item", [d]))[0]; };
    const eq = game.packs.get("pf2e.equipment-srd"); const eqIdx = await eq.getIndex({ fields: ["system.slug"] });
    const sword = eqIdx.find((i) => i.system?.slug === "shortsword");
    const held = { system: { equipped: { carryType: "held", handsHeld: 1 } } };
    await add(`Compendium.pf2e.equipment-srd.Item.${sword._id}`, held);
    await add(`Compendium.pf2e.equipment-srd.Item.${sword._id}`, { name: "Короткий меч 2", ...held });
    const feats = game.packs.get("pf2e.feats-srd"); const fIdx = await feats.getIndex({ fields: ["system.slug"] });
    const ds = await add(`Compendium.pf2e.feats-srd.Item.${fIdx.find((i) => i.system?.slug === "double-slice")._id}`);
    const is = await add(`Compendium.pf2e.feats-srd.Item.${fIdx.find((i) => i.system?.slug === "intimidating-strike")._id}`);
    const B = await import("/modules/pf2e-automato/scripts/builtin/index.mjs");
    await clear(); await aim();
    {
      const since = Date.now();
      const p = B.BUILTIN["double-slice"].run({ actor: hero, token: tH, item: ds, targets: [tF], message: null });
      const clicked = await answer(/./, /Двойной|Double/i);
      await Promise.race([p, wait(15000)]); await wait(1500);
      const msgs = game.messages.contents.filter((m) => m._stats.createdTime >= since);
      out.doubleSlice = {
        clicked, strikes: hero.system.actions.length, rollOptionRule: !!hero.rules.find((r) => r.key === "RollOption" && r.option === "double-slice-second"),
        attacks: msgs.filter((m) => m.flags.pf2e?.context?.type === "attack-roll").map((m) => ({ outcome: m.flags.pf2e.context.outcome, second: m.flags.pf2e.context.options.includes("double-slice-second"), total: m.rolls[0]?.total })),
        damage: msgs.filter((m) => m.flags.pf2e?.context?.type === "damage-roll").map((m) => ({ formula: m.rolls[0]?.formula, total: m.rolls[0]?.total, outcome: m.flags.pf2e.context.outcome })),
        toggleAfter: hero.rules.find((r) => r.key === "RollOption" && r.option === "double-slice-second")?.resolveValue?.() ?? null
      };
    }
    await clear(); await aim();
    {
      await B.BUILTIN["intimidating-strike"].run({ actor: hero, token: tH, item: is, targets: [tF], message: null });
      const armed = !!hero.getFlag(MOD, "intimidatingStrike");
      const s = hero.system.actions.find((a) => a.item?.slug === "shortsword");
      let tries = 0, atk, hit = false;
      while (tries++ < 6 && !hit) { atk = await s.variants[0].roll({ target: { document: tF } }); hit = (atk?.options?.degreeOfSuccess ?? 0) >= 2; if (!hit) await B.BUILTIN["intimidating-strike"].run({ actor: hero, token: tH, item: is, targets: [tF], message: null }); await wait(500); }
      if (hit) { await s[atk.options.degreeOfSuccess === 3 ? "critical" : "damage"]({ target: { document: tF } }); }
      await wait(2000);
      out.intimidatingStrike = { armed, tries, hitDegree: atk?.options?.degreeOfSuccess ?? null, foe: state(fA()), disarmed: !hero.getFlag(MOD, "intimidatingStrike") };
    }
  } catch (e) { out.fatal = String(e?.stack ?? e).slice(0, 500); }
  finally {
    Hooks.off("createChatMessage", hM); Hooks.off("error", hE);
    try { await game.settings.set(MOD, "yieldToAutomations", yieldPrev); } catch { }
    await game.user.update({ "flags.pf2e.settings": userFlags });
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
    if (myMsgs.size) await ChatMessage.deleteDocuments([...myMsgs].filter((id) => game.messages.has(id)));
    await prev?.view(); await scene.delete(); await foe?.delete(); await hero?.delete();
    out.cleanup = { leftActors: game.actors.filter((a) => /^AF tmp/.test(a.name)).length, yield: game.settings.get(MOD, "yieldToAutomations"), msgsDeleted: myMsgs.size };
  }
  return out;
}
