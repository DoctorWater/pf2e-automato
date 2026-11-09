async () => {
  // Демо-сцена для вики и tests/live/step-buttons.js (чистый мир, например AF TEST): Эзрен и Валерос против трёх разбойников. Повторный запуск пересоздаёт всё (флаг world.afDemo).
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const a of game.actors.filter((a) => a.getFlag("world", "afDemo"))) await a.delete();
  for (const s of game.scenes.filter((s) => s.getFlag("world", "afDemo"))) await s.delete();
  const imp = async (pack, name, rename, extra = {}) => {
    const p = game.packs.get(pack);
    const e = (await p.getIndex()).find((x) => x.name === name || x.originalName === name);
    const src = (await p.getDocument(e._id)).toObject();
    src.name = rename;
    src.flags = { ...(src.flags ?? {}), world: { afDemo: true } };
    foundry.utils.mergeObject(src, extra);
    return Actor.create(src);
  };
  const ring = (img) => ({ "prototypeToken.texture.src": img, "prototypeToken.ring.enabled": false, img });
  const ezren = await imp("pf2e.iconics", "Ezren (Level 3)", "Эзрен");
  const valeros = await imp("pf2e.iconics", "Valeros (Level 3)", "Валерос");
  const foes = [];
  const foeImgs = ["icons/environment/people/spearfighter.webp", "icons/environment/people/infantry.webp", "icons/environment/people/archer.webp"];
  for (let i = 0; i < 3; i++) foes.push(await imp("pf2e.pathfinder-npc-core", "Bandit", `Разбойник ${i + 1}`, foundry.utils.expandObject({ ...ring(foeImgs[i]), "prototypeToken.name": `Разбойник ${i + 1}`, "prototypeToken.disposition": -1 })));
  // заклинания для съёмки: Ужас (испытание + состояния по степеням) и Масло (зона)
  const entry = ezren.spellcasting.find((e) => e.isPrepared || e.isSpontaneous) ?? ezren.spellcasting.contents[0];
  const spells = [];
  for (const uuid of ["Compendium.pf2e.spells-srd.Item.4koZzrnMXhhosn0D", "Compendium.pf2e.spells-srd.Item.Wu0xFpewMKRK3HG8"]) {
    const s = (await fromUuid(uuid)).toObject();
    s.system.location = { value: entry.id };
    spells.push(s);
  }
  await ezren.createEmbeddedDocuments("Item", spells);
  const scene = await Scene.create({ name: "Демо", width: 840, height: 540, padding: 0, backgroundColor: "#3b4a35", grid: { size: 60, distance: 5, color: "#000000", alpha: 0.25 }, tokenVision: false, navigation: false, flags: { world: { afDemo: true } } });
  await scene.activate(); await scene.view(); await wait(1500);
  const place = (a, x, y) => a.getTokenDocument({ x: x * 60, y: y * 60 }).then((t) => t.toObject());
  for (const a of [ezren, valeros]) await a.update({ "prototypeToken.name": a.name });   // у иконических героев имя токена — «Ezren (Level 3)»
  await scene.levels.contents[0]?.update({ "background.color": "#3d4a37" });   // v14: цвет фона — у уровня сцены
  await scene.createEmbeddedDocuments("Token", [await place(ezren, 3, 4), await place(valeros, 4, 1), await place(foes[0], 7, 2), await place(foes[1], 7, 4), await place(foes[2], 7, 6)]);
  await wait(1000);
  return { scene: scene.id, ezren: ezren.id, entry: entry?.name, spells: ezren.itemTypes.spell.filter((s) => /Ужас|Масло/.test(s.name)).map((s) => s.name), valerosShield: valeros.heldShield?.name ?? null, tokens: scene.tokens.map((t) => t.name) };
}
