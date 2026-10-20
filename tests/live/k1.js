async () => {
  // Живая проверка K1 «Зоны» (консоль активного ГМа). Только временные объекты, с уборкой.
  const A = game.modules.get("pf2e-automato").api;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const prev = game.scenes.viewed;
  const scene = await Scene.create({ name: "AF-K1-tmp", width: 2000, height: 2000, padding: 0, grid: { size: 100 }, navigation: false });
  const act = await Actor.create({ name: "AF-K1-npc", type: "npc" });
  const calls = [];
  const hE = Hooks.on("pf2e-automato.zoneEnter", () => calls.push("enter"));
  const hX = Hooks.on("pf2e-automato.zoneExit", () => calls.push("exit"));
  try {
    await scene.view(); await wait(800);
    const [tIn, tOut] = await scene.createEmbeddedDocuments("Token", [
      { name: "in", actorId: act.id, x: 500, y: 500, actorLink: false },
      { name: "out", actorId: act.id, x: 1500, y: 1500, actorLink: false }]);
    const [region] = await scene.createEmbeddedDocuments("Region", [{ name: "AF-zone", shapes: [{ type: "rectangle", x: 400, y: 400, width: 400, height: 400 }] }]);
    const rule = { onUse: { zone: { condition: { slug: "concealed" }, duration: { seconds: 60 } } } };
    const tok = (t) => scene.tokens.get(t.id);
    const has = (t) => !!A.findByKey(tok(t).actor, "zone:" + region.uuid);
    const cnt = (t) => tok(t).actor.items.filter((i) => i.slug === "concealed").length;

    const b = await A.attachZone(region, rule, { messageId: "" }); await wait(1200);
    out.attach = { inside: has(tIn), outside: has(tOut), behaviors: region.behaviors.size };
    await A.attachZone(region, rule, {}); await wait(500);
    out.reattach = { behaviors: region.behaviors.size, concealedIn: cnt(tIn), schemaHasEvents: "events" in b.system.schema.fields };

    await tok(tIn).update({ x: 1000, y: 1000 }); await wait(1800); out.exited = has(tIn);
    await tok(tIn).update({ x: 500, y: 500 }); await wait(1800); out.reentered = has(tIn);

    await region.update({ hidden: true }); await wait(1000); out.hidden = has(tIn);
    await region.update({ hidden: false }); await wait(1000); out.unhidden = has(tIn);

    await b.update({ "system.expiresAt": game.time.worldTime - 1 });
    let doubleErr = null; try { await Promise.all([A.expireZones(), A.expireZones()]); } catch (e) { doubleErr = String(e); }
    await wait(1000);
    out.expire = { regionLeft: scene.regions.has(region.id), has: has(tIn), doubleErr, calls: [...calls] };

    const [r2] = await scene.createEmbeddedDocuments("Region", [{ name: "z2", shapes: [{ type: "rectangle", x: 400, y: 400, width: 400, height: 400 }] }]);
    await A.attachZone(r2, rule, {});
    const [r3] = await scene.createEmbeddedDocuments("Region", [{ name: "z3", shapes: [{ type: "rectangle", x: 400, y: 400, width: 400, height: 400 }] }]);
    await A.attachZone(r3, rule, {}); await wait(1200);
    out.twoZones = cnt(tIn);
    let closeErr = null; try { await A.closeZone(r2.uuid); await A.closeZone(r2.uuid); } catch (e) { closeErr = String(e); }
    await r3.delete(); await wait(1200);
    out.afterCloseAndDelete = { concealed: cnt(tIn), closeErr };
  } catch (e) {
    out.error = String(e?.stack ?? e).slice(0, 600);
  } finally {
    Hooks.off("pf2e-automato.zoneEnter", hE); Hooks.off("pf2e-automato.zoneExit", hX);
    await prev?.view(); await scene.delete(); await act.delete();
  }
  return out;
}
