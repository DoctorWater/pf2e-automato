async () => {
  // Инвентаризатор мира (ROADMAP §6.1). Вкладка ведущего, ничего не пишет в мир (только скачивает файл в браузере).
  // Проходит актёров мира и несвязанных актёров токенов на всех сценах; по каждому предмету/способности — статус:
  //   pf2e | automations | builtin | module | none  (первый подходящий в этом порядке; все подходящие — в `layers`).
  // Параметры (необязательно, перед запуском): window.__afInv = { save: true, full: false, types: [...] }
  //   save (по умолчанию true) — скачать inventory-world.json; full — вернуть полный JSON, а не только сводку.
  const MOD = "pf2e-automato";
  const opts = { save: true, full: false, ...(window.__afInv ?? {}) };
  const mod = game.modules.get(MOD);
  if (!mod?.active) return { error: `модуль ${MOD} не активен` };
  const base = foundry.utils.getRoute(`/modules/${MOD}/scripts`);
  const [rules, compat, tentacles, surprise, reactive, oneShot, onyx, blood, vcast, spellshape] = await Promise.all([
    "rules", "compat", "builtin/tentacular-limbs", "builtin/surprise-attack", "builtin/reactive-strike", "builtin/one-shot-one-kill",
    "builtin/onyx-dog", "builtin/blood-magic", "builtin/variable-cast", "builtin/spellshape"
  ].map((p) => import(`${base}/${p}.mjs`)));

  // Предметы без собственной автоматизации по определению (состояния, эффекты, ячейки, «приданое» персонажа) пропускаем.
  const TYPES = new Set(opts.types ?? ["action", "feat", "spell", "consumable", "equipment", "weapon", "melee", "armor", "shield", "backpack", "treasure"]);
  const ACTORS = new Set(["character", "npc", "familiar", "vehicle"]);
  // Способности, которым хватает хука по сообщению, без правила в каталоге.
  const HOOK_SLUGS = new Set([reactive.SLUG, surprise.SLUG, oneShot.SLUG, tentacles.SLUG, blood.BLOODLINE_SLUG]);
  // как tools/triage.mjs: pf2e — только selfEffect у action/feat или Aura RE с непустыми effects
  const TRACE = /@(?:UUID|Check|Damage|Template)\b|\[\[\/(?:r|act)\b/;   // след автоматизируемого эффекта в тексте
  const strip = (h) => String(h ?? "").replace(/<[^>]*>/g, " ").toLowerCase().replace(/\s+/g, " ").trim();

  const actors = new Map();
  for (const a of game.actors) if (ACTORS.has(a.type)) actors.set(a.uuid, a);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor && ACTORS.has(t.actor.type)) actors.set(t.actor.uuid, t.actor);

  const items = new Map();   // ключ -> запись
  const perActor = {};
  let total = 0;
  for (const actor of actors.values()) {
    const label = actor.token ? `${actor.name} [токен, ${actor.token.parent?.name ?? "?"}]` : actor.name;
    const stat = (perActor[label] ??= {});
    for (const item of actor.items) {
      if (!TYPES.has(item.type)) continue;
      total++;
      const slug = item.slug ?? item.system?.slug ?? null;
      const uuid = rules.sourceOf(null, item);
      const text = strip(item.system?.description?.value);
      const key = uuid ?? `${item.type}|${slug ?? item.name}|${text}`;   // без источника (NPC): slug + нормализованный текст, как tools/extract.mjs
      let rec = items.get(key);
      if (!rec) {
        const sys = item.system ?? {};
        const ruleKeys = [...new Set((sys.rules ?? []).map((r) => r.key).filter(Boolean))];
        const selfEffect = !!sys.selfEffect && ["action", "feat"].includes(item.type);
        const aura = (sys.rules ?? []).some((r) => r.key === "Aura" && r.effects?.length);
        const passive = ["action", "feat"].includes(item.type) && (sys.actionType?.value ?? "passive") === "passive";
        const groups = compat.automationsGroups({ slug, sourceUuid: uuid });
        let res = null;
        try { res = rules.resolveRule(item); } catch (e) { console.warn(`${MOD} inventory | resolveRule ${item.name}`, e); }
        const hook = (slug && HOOK_SLUGS.has(slug)) || onyx.isFigurine(item) || (item.type === "spell" && !!vcast.actionChoices(sys.time?.value))
          || (item.type === "feat" && !!item.flags?.[MOD]?.[spellshape.KEY]) || (item.type === "feat" && item.traits?.has?.("spellshape"));
        const macros = (res?.rule?.macros ?? []).filter((m) => m.builtin).map((m) => m.builtin);
        const builtin = [...new Set([...macros, ...(hook ? [slug ?? "hook"] : [])])];
        const layers = [];
        if (selfEffect || aura) layers.push("pf2e");
        if (groups.length) layers.push("automations");
        if (builtin.length) layers.push("builtin");
        if (res && !macros.length) layers.push(res.source === "markup" && res.confidence !== "high" ? "markup-low" : "module-high");
        if (!layers.length && !passive && TRACE.test(sys.description?.value ?? "")) layers.push("manual");
        const original = item.flags?.babele?.originalName;
        rec = {
          uuid, slug, type: item.type, name: original ?? item.name, ...(original && original !== item.name ? { nameRu: item.name } : {}),
          status: layers[0] ?? "none", layers,
          pf2e: { selfEffect, rules: [...new Set(ruleKeys)] },
          automations: groups,
          module: res ? { source: res.source, confidence: res.confidence, hints: res.hints ?? undefined } : null,
          builtin, actors: [], count: 0
        };
        items.set(key, rec);
      }
      rec.count++;
      if (!rec.actors.includes(label)) rec.actors.push(label);
      stat[rec.status] = (stat[rec.status] ?? 0) + 1;
    }
  }
  const list = [...items.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const tally = (f) => list.reduce((o, r) => { const k = f(r); o[k] = (o[k] ?? 0) + 1; return o; }, {});
  const byTypeStatus = {};
  for (const r of list) { (byTypeStatus[r.type] ??= {})[r.status] = (byTypeStatus[r.type][r.status] ?? 0) + 1; }
  const out = {
    meta: {
      generatedAt: new Date().toISOString(), world: game.world.id, pf2eVersion: game.system.version, moduleVersion: mod.version,
      automationsActive: !!game.modules.get("pf2e-automations")?.active, actors: actors.size, itemRows: total, uniqueItems: list.length
    },
    summary: { byStatus: tally((r) => r.status), byType: byTypeStatus, byActor: perActor },
    items: list
  };
  window.__afInventory = out;
  let saved = false;
  if (opts.save) {
    try { saveDataToFile(JSON.stringify(out, null, 1), "application/json", "inventory-world.json"); saved = true; }
    catch (e) { console.warn(`${MOD} inventory | saveDataToFile`, e); }
  }
  return opts.full ? out : { meta: out.meta, summary: out.summary, saved, hint: "полный результат: window.__afInventory (или window.__afInv = {full: true})" };
}
