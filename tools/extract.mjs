// Паки pf2e (LevelDB 8.6.1, запасной вариант — json 8.4.1) -> tools/out/items.json (+ html.json с сырой разметкой, refs.json со справочниками).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RU_PACKS, DATA, readJson, writeJson, outPath, stripHtml, cut, isMain } from "./lib.mjs";
import { openPacks } from "./packs.mjs";
import { sluggify } from "../scripts/util.mjs";

const TOP_TYPES = new Set(["action", "feat", "campaignFeature", "spell", "consumable", "equipment", "weapon", "armor", "shield", "treasure", "ammo"]);
const EMBED_TYPES = new Set(["action", "feat", "spell", "melee"]);
const DESC_MAX = 1500;
// @Localize[PF2E.…] -> текст из lang/en.json установленной системы (глоссарий способностей NPC хранится там, а не в паке)
const LANG = join(DATA, "systems/pf2e/lang/en.json");
const lang = existsSync(LANG) ? readJson(LANG) : {};
export const localize = (html) => html.replace(/@Localize\[([^\]]+)\]/g, (m, k) => { const v = k.split(".").reduce((o, p) => o?.[p], lang); return typeof v === "string" ? v : m; });

const cost = (sys, type) => {
  if (type === "spell") return sys.time?.value ?? null;
  const t = sys.actionType?.value;
  return t === "action" ? String(sys.actions?.value ?? 1) : t ?? null;
};
const areaOf = (a) => (a ? [a.type, a.value && `${a.value}ft`].filter(Boolean).join(" ") : null);

/** Документ pf2e -> нормализованная запись + сырой html. ctx = {pack, uuid, ru:{name,description}|null, embedded}. */
export function normItem(doc, { pack, uuid, ru = null, embedded = null }) {
  const sys = doc.system ?? {};
  const type = doc.type;
  const html = localize(type === "melee" ? (sys.attackEffects?.value ?? []).join(", ") : sys.description?.value ?? "");
  const traits = sys.traits?.value ?? [];
  const lvl = sys.level?.value ?? null;
  const save = sys.defense?.save;
  const target = typeof sys.target === "string" ? sys.target : sys.target?.value;
  const dur = sys.duration ? [sys.duration.sustained && "sustained", sys.duration.value].filter(Boolean).join(" ") : null;
  const rules = sys.rules ?? [];
  const rec = {
    uuid, pack, type, slug: sys.slug ?? sluggify(doc.name), name: doc.name, nameRu: ru?.name ?? null,
    level: lvl, rank: type === "spell" ? (traits.includes("cantrip") ? 0 : lvl) : null,
    traits, rarity: sys.traits?.rarity ?? null, category: sys.category ?? null,
    actionType: type === "spell" ? null : sys.actionType?.value ?? (type === "melee" ? "melee" : null), cost: cost(sys, type),
    frequency: sys.frequency ? `${sys.frequency.max ?? sys.frequency.value}/${sys.frequency.per}` : null,
    range: sys.range?.value || null, area: areaOf(sys.area), defense: save?.statistic ? { save: save.statistic, basic: !!save.basic } : null,
    duration: dur || null, target: target || null,
    selfEffect: sys.selfEffect?.uuid ?? null, ruleKeys: [...new Set(rules.map((r) => r.key).filter(Boolean))],
    auraEffects: rules.some((r) => r.key === "Aura" && r.effects?.length > 0),   // Aura без effects — только шаблон, системой ничего не применяется
    descEn: cut(stripHtml(html), DESC_MAX), descRu: ru?.description ? cut(stripHtml(ru.description), DESC_MAX) : null,
    source: doc._stats?.compendiumSource ?? null,
    embedded, dupTop: null, dupCount: 1
  };
  return { rec, html };
}

export const normText = (html) => stripHtml(html).toLowerCase().replace(/\s+/g, " ");
const descKey = (type, slug, html) => `${type}|${slug}|${normText(html)}`;

async function main() {
  const t0 = Date.now();
  const src = await openPacks();
  const items = [], htmlOf = {}, refs = { conditions: {}, effects: {}, grants: {} };
  const topText = new Map(), seen = new Map();
  const pending = [];   // встроенные берём после верхнего уровня, чтобы ловить дубли компендия

  for await (const { pack, isActor, docs } of src.packs()) {
    const ruPath = join(RU_PACKS, `pf2e.${pack}.json`);
    const ru = existsSync(ruPath) ? readJson(ruPath).entries ?? {} : {};
    for (const d of docs) {
      if (pack === "conditionitems") refs.conditions[d.system.slug] = { id: d._id, name: d.name, nameRu: ru[d.name]?.name ?? null };
      else if (d.type === "effect") {
        const u = `Compendium.pf2e.${pack}.Item.${d._id}`;
        refs.effects[u] = d.name;
        // состояния, которые эффект выдаёт сам (GrantItem на conditionitems): id состояния
        const g = (d.system.rules ?? []).filter((r) => r.key === "GrantItem").map((r) => /conditionitems\.Item\.(\w+)/.exec(r.uuid ?? "")?.[1]).filter(Boolean);
        if (g.length) refs.grants[u] = g;
      }
      if (!isActor) {
        if (!TOP_TYPES.has(d.type)) continue;
        const { rec, html } = normItem(d, { pack, uuid: `Compendium.pf2e.${pack}.Item.${d._id}`, ru: ru[d.name] });
        items.push(rec); htmlOf[rec.uuid] = html;
        if (["action", "feat", "spell", "campaignFeature"].includes(rec.type)) { const k = `${rec.slug}|${normText(html)}`; if (!topText.has(k)) topText.set(k, rec.uuid); }
      } else {
        const ruItems = ru[d.name]?.items ?? {};
        for (const it of d.items ?? []) if (EMBED_TYPES.has(it.type) && !(it.type === "melee" && !it.system?.attackEffects?.value?.length)) {
          pending.push({ it, pack, ru: ruItems[it.name], embedded: { actor: d.name, actorUuid: `Compendium.pf2e.${pack}.Actor.${d._id}` } });
        }
      }
    }
  }
  for (const p of pending) {
    const uuid = `${p.embedded.actorUuid}.Item.${p.it._id}`;
    const { rec, html } = normItem(p.it, { pack: p.pack, uuid, ru: p.ru, embedded: p.embedded });
    const key = descKey(rec.type, rec.slug, html);
    const prev = seen.get(key);
    if (prev) { prev.dupCount++; continue; }
    // дубль компендия — только при совпадении slug И текста (одноимённые способности NPC часто разные)
    rec.dupTop = rec.type === "melee" ? null : topText.get(`${rec.slug}|${normText(html)}`) ?? null;
    seen.set(key, rec); items.push(rec); htmlOf[uuid] = html;
  }
  const by = {};
  for (const i of items) { const k = `${i.embedded ? "embedded" : "top"}:${i.type}`; by[k] = (by[k] ?? 0) + 1; }
  writeJson(outPath("items.json"), { meta: { pf2eVersion: src.version, source: src.source, extractedAt: new Date().toISOString(), counts: by, total: items.length }, items });
  writeJson(outPath("html.json"), htmlOf);
  writeJson(outPath("refs.json"), refs);
  console.log(`extract: ${items.length} документов (pf2e ${src.version}, ${src.source}), ${((Date.now() - t0) / 1000).toFixed(1)} c`, by);
}

if (isMain(import.meta.url)) await main();
