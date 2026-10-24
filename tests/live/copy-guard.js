async () => {
  // Живой сценарий copy-guard: ограждение копий NPC (plan-copy-guard.md). Evil Eye у NPC: копия с изменённым текстом (frightened, как у Kepgeda) — правило источника
  // (Sickened) не применяется, правило выводится из разметки с низкой уверенностью и пометкой diverged (исполняет только кнопка ГМа); копия с текстом источника — правило каталога.
  // Вкладка активного ГМа-лидера, ничего вручную не нажимать. Временный актёр «AF тест: copy-guard» удаляется в конце.
  // Параметры (перед запуском): window.__afGuard = { cleanOnly: true } — аварийная чистка. Результат: { summary, table, rows:[{id,title,status,detail}] }, то же в window.__afGuardResult.
  const MOD = "pf2e-automato", PFX = "AF тест: ", NAME = `${PFX}copy-guard`;
  const SRC = "Compendium.pf2e.spells-srd.Item.f45JpY7Ph2cAJGW2";
  const opts = { cleanOnly: false, ...(window.__afGuard ?? {}) };
  const sweep = async () => { for (const a of game.actors.filter((a) => a.name === NAME)) await a.delete().catch(() => {}); return game.actors.filter((a) => a.name === NAME).length; };
  if (opts.cleanOnly) return { left: await sweep() };
  await sweep();

  const rules = await import(`/modules/${MOD}/scripts/rules.mjs`);
  const rows = [];
  const check = async (id, title, fn) => {
    try { const detail = await fn(); rows.push({ id, title, status: detail === true ? "ok" : "fail", detail: detail === true ? "" : detail }); }
    catch (e) { rows.push({ id, title, status: e.skip ? "skip" : "fail", detail: e.message }); }
  };
  const skip = (m) => Object.assign(new Error(m), { skip: true });
  const sick = (rule) => JSON.stringify(rule?.rule ?? rule ?? null).includes('"slug":"sickened"');
  const frightenedUuid = "Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL";
  const html = `<p>You fix your eye on the target. @Check[will|dc:20|basic:false] save.</p><hr /><p><strong>Failure</strong> The target is @UUID[${frightenedUuid}]{Frightened 1}.</p>`;
  let actor;
  try {
    const src = await fromUuid(SRC);
    if (!src) throw skip(`нет заклинания-источника ${SRC}`);
    actor = await Actor.create({ name: NAME, type: "npc" });
    const mk = (name, text) => ({ name, type: "spell", img: src.img, system: { ...src.toObject().system, slug: "evil-eye", description: { value: text } }, _stats: { compendiumSource: SRC } });
    const [changed, same] = await actor.createEmbeddedDocuments("Item", [mk("Evil Eye (другой текст)", html), mk("Evil Eye (текст источника)", src.system.description.value)]);
    const cat = rules.resolveRule(src);   // правило источника из каталога — опора сценария
    const base = rules.resolveRule(same);

    await check("catalog-has-rule", "у копии с текстом источника правило каталога с Sickened", async () => {
      if (!sick(base) || base?.source !== "catalog") throw skip(`в каталоге нет правила Sickened для ${SRC}: source=${base?.source}, sickened=${sick(base)}; источник: ${cat?.source}`);
      return true;
    });
    await check("changed-skips-catalog", "копия с другим текстом: правило источника не применяется, вывод из разметки low, diverged", async () => {
      const r = rules.resolveRule(changed);
      if (r?.source === "catalog") return `правило каталога применено к копии с текстом frightened: sickened=${sick(r)}, diverged=${JSON.stringify(r?.diverged)}`;
      if (sick(r)) return `в выведенном правиле остался Sickened: ${JSON.stringify(r?.rule?.onUse)}`;
      const d = r?.diverged ?? rules.divergedOf(changed);
      if (!d) return `нет diverged: source=${r?.source}, confidence=${r?.confidence}`;
      if (r && (r.source !== "markup" || r.confidence !== "low")) return `ожидалось markup/low, получено ${r.source}/${r.confidence}`;
      return d.kind === "other" && d.states.includes("frightened") ? true : `diverged=${JSON.stringify(d)}, ожидалось other [frightened]`;
    });
    await check("same-applies", "копия с тем же текстом получает правило каталога", async () => {
      if (base?.diverged || rules.divergedOf(same)) return `ложное расхождение: ${JSON.stringify(base?.diverged ?? rules.divergedOf(same))}`;
      return base?.source === "catalog" || `source=${base?.source}`;
    });
    await check("gm-button", "для копии с другим текстом выведенное правило ставит Frightened (не Sickened) и low: исполняет только кнопка ГМа", async () => {
      const r = rules.resolveRule(changed);
      if (!r) return "правило не выведено: у ГМа нет кнопки (diverged остаётся только пометкой)";
      const slugs = [...rules.ruleStates(r.rule)];
      if (!slugs.includes("frightened") || slugs.includes("sickened")) return `в выведенном правиле состояния [${slugs}], ожидалось frightened без sickened`;
      return r.confidence === "low" || `confidence=${r.confidence}: кнопки ГМа не будет`;
    });
    const fromPack = async (pack, slug) => {
      const p = game.packs.get(pack), i = p && (await p.getIndex({ fields: ["system.slug"] })).find((x) => x.system?.slug === slug);
      if (!i) throw skip(`нет в ${pack}: ${slug}`);
      return (await p.getDocument(i._id)).toObject();
    };
    await check("fixtures-kept", "Haste и Tongue Grab на NPC не отключаются", async () => {
      const haste = await fromPack("pf2e.spells-srd", "haste"), tongue = await fromPack("pf2e.bestiary-ability-glossary-srd", "tongue-grab");
      const items = await actor.createEmbeddedDocuments("Item", [haste, tongue]);
      const bad = items.filter((it) => rules.resolveRule(it)?.diverged || rules.divergedOf(it)).map((it) => `${it.name}: ${JSON.stringify(rules.divergedOf(it))}`);
      return bad.length ? `отключены: ${bad.join("; ")}` : true;
    });
    await check("reaction", "Nimble Dodge (персонаж): реакции собираются без ошибки, правило onAttacked найдено", async () => {
      const reactions = await import(`/modules/${MOD}/scripts/reactions.mjs`);
      const dodge = await fromPack("pf2e.feats-srd", "nimble-dodge");
      const pc = await Actor.create({ name: NAME, type: "character" });   // черту (feat) pf2e кладёт только персонажу
      try {
        await pc.createEmbeddedDocuments("Item", [dodge]);
        let list;
        try { list = reactions.reactionItems(pc); } catch (e) { return `reactionItems упал: ${e.message}`; }
        return list.some((x) => x.item.slug === "nimble-dodge") || `Nimble Dodge не найден среди реакций: [${list.map((x) => x.item.name)}] — в каталоге нет onAttacked`;
      } finally { await pc.delete(); }
    });
    await check("player-copy", "тот же текст у предмета персонажа не огораживается", async () => {
      const pc = await Actor.create({ name: NAME, type: "character" });
      try {
        const [it] = await pc.createEmbeddedDocuments("Item", [mk("Evil Eye PC", html)]);
        const r = rules.resolveRule(it);
        return r?.source === "catalog" || `у PC ожидалось правило каталога, получено source=${r?.source}`;
      } finally { await pc.delete().catch(() => {}); }
    });
  } catch (e) {
    rows.push({ id: "setup", title: "подготовка", status: e.skip ? "skip" : "fail", detail: e.message });
  } finally {
    await actor?.delete().catch(() => {});
    await sweep();
  }
  const summary = { ok: rows.filter((r) => r.status === "ok").length, fail: rows.filter((r) => r.status === "fail").length, skip: rows.filter((r) => r.status === "skip").length };
  const table = rows.map((r) => `${r.status.toUpperCase().padEnd(4)} ${r.id}: ${r.title}${r.detail ? ` — ${r.detail}` : ""}`);
  window.__afGuardResult = { summary, table, rows };
  console.table(rows);
  return { summary, table, rows };
}
