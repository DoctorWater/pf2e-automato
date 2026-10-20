async () => {
  // Двойной взмах с парой оружия одной строкой (количество 2) — как у Муссарии. Временные актёры/сцена; запуск через карточку черты.
  const MOD = "pf2e-automato";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { notes: [] };
  const N = ui.notifications, orig = { warn: N.warn, info: N.info };
  for (const k of Object.keys(orig)) N[k] = function (m, ...r) { out.notes.push(`${k}: ${String(m).slice(0, 160)}`); return orig[k].call(this, m, ...r); };
  const prev = game.scenes.viewed;
  const myMsgs = new Set(); const hM = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) myMsgs.add(m.id); });
  const pres = [];
  const hP = Hooks.on("preCreateChatMessage", (m, d, o, uid) => { pres.push({ t: m.flags?.pf2e?.origin?.type ?? null, ctx2: m.flags?.pf2e?.context?.type ?? null, fl: Object.keys(m.flags ?? {}).join(","),  uid, me: game.user.id, ours: !!m.flags?.["pf2e-automato"], item: !!m.item }); });
  out.pres = pres;
  const userFlags = foundry.utils.deepClone(game.user.flags.pf2e?.settings ?? {});
  const scene = await Scene.create({ name: "AF tmp ds", width: 2000, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
  let hero, foe;
  try {
    await game.user.update({ "flags.pf2e.settings.showCheckDialogs": false, "flags.pf2e.settings.showDamageDialogs": false });
    await scene.view(); await wait(800);
    hero = await Actor.create({ name: "AF tmp pair", type: "character", folder: null, ownership: { default: 0 } });
    const gob = await fromUuid("Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4");
    foe = await Actor.create({ ...gob.toObject(), name: "AF tmp foe", folder: null, ownership: { default: 0 } });
    const blade = (await fromUuid(game.actors.get("sRFvHm4fhuEI3n9g").itemTypes.weapon[0]._stats.compendiumSource)).toObject();   // только читаем источник предмета Муссарии
    blade.system.quantity = 2; blade.system.equipped = { carryType: "held", handsHeld: 1 };
    const feat = (await fromUuid("Compendium.pf2e.feats-srd.Item.onde0SxLoxLBTnvm")).toObject();
    await hero.createEmbeddedDocuments("Item", [blade, feat, { type: "effect", name: "AF bonus", system: { slug: "af-bonus", rules: [{ key: "FlatModifier", selector: "strike-attack-roll", value: 30 }] } }]);
    const ds = hero.itemTypes.feat.find((f) => f.slug === "double-slice");
    const mk = async (a, x, y, d) => (await scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y, disposition: d })).toObject() }]))[0];
    const tH = await mk(hero, 500, 500, 1), tF = await mk(foe, 600, 500, -1);
    await wait(800);
    tH.object.control({ releaseOthers: true }); tF.object.setTarget(true, { releaseOthers: true });
    const since = Date.now();
    await ds.toMessage(undefined, { create: true });   // как кнопка «в чат» на листе
    let clicked = null;
    for (let i = 0; i < 60 && !clicked; i++) {
      for (const app of foundry.applications.instances.values()) {
        if (!(app instanceof foundry.applications.api.DialogV2) || !/Двойной|Double/i.test(app.title ?? "")) continue;
        const b = app.element.querySelector("button[data-action=ok]"); if (b) { clicked = b.textContent.trim(); b.click(); }
      }
      await wait(150);
    }
    await wait(6000);
    const msgs = game.messages.contents.filter((m) => m._stats.createdTime >= since);
    const card = msgs.find((m) => m.flags.pf2e?.origin?.uuid === ds.uuid);
    out.card = card ? { origin: card.flags.pf2e.origin, author: card.author?.id, created: card._stats.createdTime, since, af: card.flags[MOD] ? JSON.stringify(card.flags[MOD]).slice(0, 600) : null, targets: [...game.user.targets].map((t) => t.name), controlled: canvas.tokens.controlled.map((t) => t.name) } : "нет карточки";
    out.res = {
      clicked,
      attacks: msgs.filter((m) => m.flags.pf2e?.context?.type === "attack-roll").map((m) => ({ outcome: m.flags.pf2e.context.outcome, second: m.flags.pf2e.context.options.includes("double-slice-second"), total: m.rolls[0]?.total })),
      damage: msgs.filter((m) => m.flags.pf2e?.context?.type === "damage-roll").map((m) => ({ formula: m.rolls[0]?.formula, total: m.rolls[0]?.total })),
      whispers: msgs.filter((m) => m.whisper.length).map((m) => m.content.replace(/<[^>]+>/g, " ").slice(0, 140))
    };
  } catch (e) { out.fatal = String(e?.stack ?? e).slice(0, 500); }
  finally {
    Object.assign(N, orig); Hooks.off("createChatMessage", hM); Hooks.off("preCreateChatMessage", hP);
    await game.user.update({ "flags.pf2e.settings": userFlags });
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
    if (myMsgs.size) await ChatMessage.deleteDocuments([...myMsgs].filter((id) => game.messages.has(id)));
    await prev?.view(); await scene.delete(); await hero?.delete(); await foe?.delete();
    out.cleanup = { leftActors: game.actors.filter((a) => /^AF tmp/.test(a.name)).length };
  }
  return out;
}
