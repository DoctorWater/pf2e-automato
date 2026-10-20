async () => {
  // Живая проверка: макрос Workbench «Treat Wounds and Battle Medicine» вне боя и в бою. Временные актёры, сцена и бой, с уборкой.
  const MOD = "pf2e-automato";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const notes = []; const N = ui.notifications; const orig = { warn: N.warn, error: N.error, info: N.info };
  for (const k of Object.keys(orig)) N[k] = function (m, ...r) { notes.push(`${k}: ${String(m).slice(0, 200)}`); return orig[k].call(this, m, ...r); };
  const out = { notes, preCombats: game.combats.map((c) => ({ id: c.id, started: c.started, active: c.active })) };
  const prev = game.scenes.viewed;
  const myMsgs = new Set(); const hM = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) myMsgs.add(m.id); });
  const userFlags = foundry.utils.deepClone(game.user.flags.pf2e?.settings ?? {});
  const scene = await Scene.create({ name: "AF tmp tw", width: 2000, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
  let hero, pat, combat;
  const pressDialog = async (bm, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = [...document.querySelectorAll(".application, .app")].find((e) => e.querySelector('[name="useBattleMedicine"]'));
      if (el) {
        const sel = el.querySelector('[name="useBattleMedicine"]'); const opts = [...sel.options].map((o) => o.value);
        if (bm != null) { sel.value = bm ? "1" : "0"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
        const btn = [...el.querySelectorAll("button")].find((b) => /heal|лечи|ok|roll/i.test(b.textContent)) ?? el.querySelector("button.dialog-button, footer button");
        const t = btn?.textContent.trim(); btn?.click(); return { opts, btn: t };
      }
      await wait(150);
    }
    return null;
  };
  try {
    await game.user.update({ "flags.pf2e.settings.showCheckDialogs": false, "flags.pf2e.settings.showDamageDialogs": false });
    await scene.view(); await wait(800);
    hero = await Actor.create({ name: "AF tmp medic", type: "character", folder: null, ownership: { default: 0 }, system: { skills: { medicine: { rank: 1 } } } });
    const gob = await fromUuid("Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4");
    pat = await Actor.create({ ...gob.toObject(), name: "AF tmp patient", folder: null, ownership: { default: 0 } });
    const eq = game.packs.get("pf2e.equipment-srd"); const ei = await eq.getIndex({ fields: ["system.slug"] });
    const kit = (await eq.getDocument(ei.find((i) => /^healer-?s-toolkit$/.test(i.system?.slug ?? ""))._id)).toObject();
    kit.system.equipped = { carryType: "held", handsHeld: 2 };
    const fp = game.packs.get("pf2e.feats-srd"); const fi = await fp.getIndex({ fields: ["system.slug"] });
    const bm = (await fp.getDocument(fi.find((i) => i.system?.slug === "battle-medicine")._id)).toObject();
    await hero.createEmbeddedDocuments("Item", [kit, bm]);
    const mk = async (a, x, y, d) => (await scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y, disposition: d })).toObject() }]))[0];
    const tH = await mk(hero, 500, 500, 1), tP = await mk(pat, 600, 500, 1);
    await wait(800);
    const pA = () => scene.tokens.get(tP.id).actor;
    tH.object.control({ releaseOthers: true }); tP.object.setTarget(true, { releaseOthers: true });
    const pack = game.packs.get("xdy-pf2e-workbench.asymonous-benefactor-macros-internal");
    const macro = await pack.getDocument((await pack.getIndex()).find((e) => e.name === "XDY DO_NOT_IMPORT Treat Wounds and Battle Medicine")._id);
    const effs = () => pA().itemTypes.effect.map((e) => `${e.system.slug}${e.flags?.[MOD]?.meta ? "*" : ""}`);
    const run = async (label, bmChoice) => {
      const ids = pA().itemTypes.effect.map((e) => e.id); if (ids.length) await pA().deleteEmbeddedDocuments("Item", ids);
      const since = Date.now();
      const p = macro.execute({ actor: hero, token: tH.object });
      const dlg = await pressDialog(bmChoice);
      await Promise.race([p, wait(8000)]); await wait(2500);
      const roll = game.messages.contents.filter((m) => m._stats.createdTime >= since && m.flags.pf2e?.context?.type === "skill-check").at(-1);
      const use = roll && game.messages.get(roll.id)?.flags?.[MOD]?.use;
      const btns = roll ? [...(document.querySelector(`#chat [data-message-id="${roll.id}"]`)?.querySelectorAll(".pf2e-automato button[data-action]") ?? [])].map((b) => b.dataset.action) : [];
      out[label] = { msgs: game.messages.contents.filter((m) => m._stats.createdTime >= since).map((m) => `${m.flags.pf2e?.context?.type ?? "-"}:${m.flavor?.slice(0, 80) ?? ""}`), dlg, rolled: !!roll, outcome: roll?.flags.pf2e.context.outcome ?? null, slug: use?.slug ?? use?.rule?.slug ?? null, label: use?.item?.name ?? null, btns, patientEffects: effs() };
      for (const b of [...(document.querySelector(`#chat [data-message-id="${roll?.id}"]`)?.querySelectorAll(".pf2e-automato button[data-action^=apply]:not([disabled])") ?? [])]) { b.click(); await wait(1200); }
      out[label].afterClick = effs();
    };
    await run("outOfCombat", false);
    combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tH.id, sceneId: scene.id, actorId: hero.id }, { tokenId: tP.id, sceneId: scene.id, actorId: pat.id }]);
    await combat.update({ round: 1, turn: 0 }); await wait(500);
    out.activeStarted = !!game.combats.active?.started;
    await run("inCombat", true);
  } catch (e) { out.fatal = String(e?.stack ?? e).slice(0, 500); }
  finally {
    Hooks.off("createChatMessage", hM); Object.assign(N, orig);
    await game.user.update({ "flags.pf2e.settings": userFlags });
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
    try { await combat?.delete(); } catch { }
    if (myMsgs.size) await ChatMessage.deleteDocuments([...myMsgs].filter((id) => game.messages.has(id)));
    await prev?.view(); await scene.delete(); await hero?.delete(); await pat?.delete();
    out.cleanup = { leftActors: game.actors.filter((a) => /^AF tmp/.test(a.name)).length, combats: game.combats.size, msgs: myMsgs.size };
  }
  window.__afTw = out; return out;
}
