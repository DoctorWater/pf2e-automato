async () => {
  // Однократный перенос данных мира со старого id pf2e-autoflow на pf2e-automato (консоль активного ГМа).
  // Настройки мира, флаги сообщений/актёров/предметов/токенов/регионов/сцен, предметы незалинкованных токенов, типы поведений регионов.
  // Повторный запуск безопасен: переносится только то, что ещё под старым ключом.
  const OLD = "pf2e-autoflow", NEW = "pf2e-automato";
  const out = { settings: 0, docs: 0, deltaItems: 0, behaviors: 0, errors: [] };
  const flagsOf = (d) => d?._source?.flags?.[OLD];
  const move = async (doc) => {
    const f = flagsOf(doc);
    if (f === undefined) return;
    try {
      await doc.update({ [`flags.${NEW}`]: foundry.utils.mergeObject(foundry.utils.deepClone(doc._source.flags?.[NEW] ?? {}), f), [`flags.-=${OLD}`]: null }, { render: false });
      out.docs++;
    } catch (e) { out.errors.push(`${doc.uuid}: ${e.message}`); }
  };

  for (const s of game.settings.storage.get("world").filter((x) => x.key.startsWith(`${OLD}.`))) {
    const key = s.key.slice(OLD.length + 1);
    try {
      if (game.settings.settings.has(`${NEW}.${key}`)) await game.settings.set(NEW, key, s.value);
      await s.delete();
      out.settings++;
    } catch (e) { out.errors.push(`setting ${s.key}: ${e.message}`); }
  }

  for (const m of game.messages) await move(m);
  for (const c of [game.actors, game.items, game.journal, game.macros, game.scenes, game.users]) for (const d of c) await move(d);
  for (const a of game.actors) for (const i of a.items) await move(i);
  for (const s of game.scenes) {
    for (const r of s.regions) {
      await move(r);
      for (const b of r.behaviors) if (b.type.startsWith(`${OLD}.`)) {
        try { const data = b.toObject(); data.type = `${NEW}.${b.type.slice(OLD.length + 1)}`; delete data._id; await r.createEmbeddedDocuments("RegionBehavior", [data]); await b.delete(); out.behaviors++; }
        catch (e) { out.errors.push(`${b.uuid}: ${e.message}`); }
      }
    }
    for (const t of s.tokens) {
      await move(t);
      if (t.actorLink || !t.delta) continue;
      const items = (t.delta._source.items ?? []).filter((i) => i.flags?.[OLD] !== undefined);
      if (!items.length) continue;
      try {
        await t.actor.updateEmbeddedDocuments("Item", items.map((i) => ({ _id: i._id, [`flags.${NEW}`]: i.flags[OLD], [`flags.-=${OLD}`]: null })));
        out.deltaItems += items.length;
      } catch (e) { out.errors.push(`${t.uuid} items: ${e.message}`); }
    }
  }
  out.left = {
    settings: game.settings.storage.get("world").filter((x) => x.key.startsWith(`${OLD}.`)).length,
    messages: game.messages.filter((m) => flagsOf(m) !== undefined).length,
    actors: game.actors.filter((a) => flagsOf(a) !== undefined).length
  };
  return out;
}
