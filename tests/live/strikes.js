async () => {
  // Устрашающий удар, Двойной финт, Двойной взмах — запуск с карточки черты; Удары бросает модуль. Временные актёры/сцена.
  const MOD = "pf2e-automato";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { notes: [] };
  const N = ui.notifications, orig = { warn: N.warn, info: N.info, error: N.error };
  for (const k of Object.keys(orig)) N[k] = function (m, ...r) { out.notes.push(`${k}: ${String(m).slice(0, 160)}`); return orig[k].call(this, m, ...r); };
  const prev = game.scenes.viewed;
  const myMsgs = new Set(); const hM = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) myMsgs.add(m.id); });
  const userFlags = foundry.utils.deepClone(game.user.flags.pf2e?.settings ?? {});
  const scene = await Scene.create({ name: "AF tmp strikes", width: 2000, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
  let hero, foe;
  try {
    await game.user.update({ "flags.pf2e.settings.showCheckDialogs": false, "flags.pf2e.settings.showDamageDialogs": false });
    await scene.view(); await wait(800);
    hero = await Actor.create({ name: "AF tmp striker", type: "character", folder: null, ownership: { default: 0 } });
    const gob = await fromUuid("Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4");
    foe = await Actor.create({ ...gob.toObject(), name: "AF tmp foe", folder: null, ownership: { default: 0 } });
    const eq = game.packs.get("pf2e.equipment-srd"), ei = await eq.getIndex({ fields: ["system.slug"] });
    const fp = game.packs.get("pf2e.feats-srd"), fi = await fp.getIndex({ fields: ["system.slug"] });
    const cp = game.packs.get("pf2e.classfeatures"), ci = await cp.getIndex({ fields: ["system.slug"] });
    const doc = async (pack, idx, slug) => (await pack.getDocument(idx.find((i) => i.system?.slug === slug)._id)).toObject();
    const held = (d, name) => { d.system.equipped = { carryType: "held", handsHeld: 1 }; if (name) d.name = name; return d; };
    await hero.createEmbeddedDocuments("Item", [
      held(await doc(eq, ei, "shortsword")), held(await doc(eq, ei, "shortsword"), "Короткий меч 2"),
      await doc(fp, fi, "intimidating-strike"), await doc(fp, fi, "twin-feint"), await doc(fp, fi, "double-slice"), await doc(cp, ci, "sneak-attack"),
      { type: "effect", name: "AF bonus", system: { slug: "af-bonus", rules: [{ key: "FlatModifier", selector: "strike-attack-roll", value: 30 }] } }
    ]);
    const mk = async (a, x, y, d) => (await scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y, disposition: d })).toObject() }]))[0];
    const tH = await mk(hero, 500, 500, 1), tF = await mk(foe, 600, 500, -1);
    await wait(800);
    const fA = () => scene.tokens.get(tF.id).actor;
    tH.object.control({ releaseOthers: true }); tF.object.setTarget(true, { releaseOthers: true });
    const use = async (slug) => {
      const ids = fA().items.filter((i) => ["condition", "effect"].includes(i.type)).map((i) => i.id); if (ids.length) await fA().deleteEmbeddedDocuments("Item", ids);
      const feat = hero.itemTypes.feat.find((f) => f.slug === slug);
      const since = Date.now();
      await feat.toMessage(undefined, { create: true });
      let clicked = null;
      for (let i = 0; i < 60 && !clicked; i++) {
        for (const app of foundry.applications.instances.values()) {
          if (!(app instanceof foundry.applications.api.DialogV2) || app.title !== feat.name) continue;
          const b = app.element.querySelector("button[data-action=ok]"); if (b) { clicked = b.textContent.trim(); b.click(); }
        }
        await wait(150);
      }
      await wait(6000);
      const msgs = game.messages.contents.filter((m) => m._stats.createdTime >= since);
      return {
        clicked,
        attacks: msgs.filter((m) => m.flags.pf2e?.context?.type === "attack-roll").map((m) => ({ item: m.item?.name, outcome: m.flags.pf2e.context.outcome, offGuard: m.flags.pf2e.context.options.includes("target:condition:off-guard"), map: m.flags.pf2e.modifiers?.find((x) => x.slug === "multiple-attack-penalty")?.modifier ?? 0 })),
        damage: msgs.filter((m) => m.flags.pf2e?.context?.type === "damage-roll").map((m) => ({ formula: m.rolls[0]?.formula, sneak: /precision|точн/i.test(m.rolls[0]?.formula ?? "") || m.flags.pf2e.context.options.includes("target:condition:off-guard") })),
        foe: fA().items.filter((i) => ["condition", "effect"].includes(i.type)).map((i) => `${i.system.slug}${i.system.value?.value ? ":" + i.system.value.value : ""}`),
        heroTemp: hero.itemTypes.effect.filter((e) => e.system.slug === "af-twin-feint-second").length
      };
    };
    out.intimidating = await use("intimidating-strike");
    out.twinFeint = await use("twin-feint");
    out.doubleSlice = await use("double-slice");
  } catch (e) { out.fatal = String(e?.stack ?? e).slice(0, 500); }
  finally {
    Object.assign(N, orig); Hooks.off("createChatMessage", hM);
    await game.user.update({ "flags.pf2e.settings": userFlags });
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
    if (myMsgs.size) await ChatMessage.deleteDocuments([...myMsgs].filter((id) => game.messages.has(id)));
    await prev?.view(); await scene.delete(); await hero?.delete(); await foe?.delete();
    out.cleanup = { leftActors: game.actors.filter((a) => /^AF tmp/.test(a.name)).length };
  }
  return out;
}
