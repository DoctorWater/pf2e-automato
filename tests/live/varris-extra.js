async () => {
  // Уровень эффекта = круг сотворения (Умиротворение на 2-м круге) и предупреждение «нет цели» (Наставление без цели). Временные объекты.
  const MOD = "pf2e-automato";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const prev = game.scenes.viewed;
  const myMsgs = new Set(); const hM = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) myMsgs.add(m.id); });
  const scene = await Scene.create({ name: "AF tmp vx", width: 1000, height: 1000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false });
  let sorc, ally;
  try {
    await scene.view(); await wait(800);
    sorc = await Actor.create({ name: "AF tmp sorc", type: "character", folder: null, ownership: { default: 0 }, system: { details: { alliance: "party" } } });
    ally = await Actor.create({ name: "AF tmp ally", type: "character", folder: null, ownership: { default: 0 }, system: { details: { alliance: "party" } } });
    const [entry] = await sorc.createEmbeddedDocuments("Item", [{ type: "spellcastingEntry", name: "AF", system: { tradition: { value: "occult" }, prepared: { value: "spontaneous" }, ability: { value: "cha" }, slots: { slot1: { max: 2, value: 2 }, slot2: { max: 2, value: 2 } } } }]);
    const sp = (id) => fromUuid(`Compendium.pf2e.spells-srd.Item.${id}`).then((d) => { const o = d.toObject(); o.system.location = { value: entry.id }; return o; });
    await sorc.createEmbeddedDocuments("Item", [await sp("szIyEsvihc5e1w8n"), await sp("izcxFQFwf3woCnFs")]);
    const mk = async (a, x) => (await scene.createEmbeddedDocuments("Token", [(await a.getTokenDocument({ x, y: 300 })).toObject()]))[0];
    const tS = await mk(sorc, 300), tA = await mk(ally, 200);
    await wait(800);
    tS.object.control({ releaseOthers: true }); tA.object.setTarget(true, { releaseOthers: true });
    const soothe = sorc.itemTypes.spell.find((s) => s.slug === "soothe");
    await soothe.spellcasting.cast(soothe, { rank: 2 }); await wait(4000);
    const e = ally.itemTypes.effect.find((x) => x.slug === "spell-effect-soothe");
    out.soothe = { effectLevel: e?.level ?? null, castRank: game.messages.contents.at(-1)?.flags?.pf2e?.origin?.castRank ?? null };
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
    const g = sorc.itemTypes.spell.find((s) => s.slug === "guidance");
    const since = Date.now();
    await g.spellcasting.cast(g, { rank: g.rank }); await wait(3000);
    const card = game.messages.contents.find((m) => m._stats.createdTime >= since && m.flags.pf2e?.origin?.uuid === g.uuid);
    out.noTarget = (document.querySelector(`#chat [data-message-id="${card?.id}"] .pf2e-automato`)?.textContent ?? "").replace(/\s+/g, " ").trim();
  } catch (e) { out.fatal = String(e?.stack ?? e).slice(0, 400); }
  finally {
    Hooks.off("createChatMessage", hM);
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
    if (myMsgs.size) await ChatMessage.deleteDocuments([...myMsgs].filter((id) => game.messages.has(id)));
    await prev?.view(); await scene.delete(); await sorc?.delete(); await ally?.delete();
    out.cleanup = { leftActors: game.actors.filter((a) => /^AF tmp/.test(a.name)).length };
  }
  return out;
}
