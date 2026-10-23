// 0.5g3: «при попадании Удара цель получает состояние» — пассивные способности NPC без броска и без спасброска (tongue-grab у лягушек, нить рыболова, паутина…).
// pf2e связывает такую способность с Ударом через его attackEffects (slug способности); events.mjs кладёт в набор опций `item:attack-effect:<slug>`.
// Правило: onEvent attack-roll владельца, условие — Удар с этой способностью и исход «успех»/«критический успех», шаг — состояние на цель.
// Запуск: node tools/onhit.mjs -> rules/catalog.onhit.json (bySlug "slug@action"); на предмет без Удара с такой связью правило не сработает никогда — безвредно.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, OUT, PACKS, readOut, writeText, isMain, stripHtml } from "./lib.mjs";
import { validateRule, slugTypeKey } from "../scripts/rules.mjs";
import { roundTrip } from "./validate.mjs";

const LINK = String.raw`@UUID\[Compendium\.pf2e\.conditionitems\.Item\.(\w+)\]\{([^}]*)\}`;
const ALL_LINKS = new RegExp(LINK, "g");
const SUBJECT = String.raw`(?:a|an|the|any) (?:[\w-]+ ){0,3}?(?:creature|target|enemy|foe)`;
// «Если X попал по существу <Ударом>, оно становится <Состояние>» / «Существо, по которому попал <Удар>, становится <Состояние>»;
// после состояния — разве что «by X» и срок «до конца своего следующего хода»
const FORMS = [
  new RegExp(String.raw`^(?:If|When) [^,]{1,80}?\bhits? ${SUBJECT}\b[^,]{0,60}, (?:that|the|this) (?:[\w-]+ )?(?:creature|target|enemy|foe) (?:becomes?|is) (?:automatically )?${LINK}(?<rest>[^.]*)\.?$`, "i"),
  new RegExp(String.raw`^(?:Any|A|An|The) (?:[\w-]+ ){0,3}?creature (?:that is )?hit by [^.]{1,80}? (?:becomes?|is) (?:automatically )?${LINK}(?<rest>[^.]*)\.?$`, "i")
];
const REST_OK = /^(?:\s+by [^.,]{1,40}|\s+in [^.,]{1,40})?(?:,? until the (?<w>end|start) of [^.,]{0,40}?next turn)?$/i;
// что состояние выдаёт само (GrantItem условия pf2e 8.6.1) и наш эффект-замена без этого (packs/_source/effects: «Grabbed (Not Immobilized)»)
const GRANTS = { grabbed: ["immobilized"] };
const NO_IMMOBILIZED = { grabbed: "Compendium.pf2e-automato.effects.Item.pAfGrabNoImmob01" };
const NEGATED =/n['’]t\b|\bnot\b|\bunless\b|\bcannot\b|\bno longer\b|\bwithout\b/i;
// «Средние и меньше»: pf2e кладёт цели `target:size:<номер>` (Крошечный 0 … Гигантский 5), сравнение — как у предикатов
const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const SIZE_GATE = /\b(tiny|small|medium|large|huge|gargantuan)\s+or\s+(smaller|larger)\b/i;

/**
 * Текст способности -> правило onEvent | null. condSlugById — id состояния pf2e -> slug.
 * Берём только однозначное: одно предложение «попал -> состояние» без спасброска, критов, второго состояния и размерного условия.
 */
export function deriveHit(html, { slug, name }, condSlugById) {
  const text = stripHtml(html ?? "");
  if (!text || /@Check\[|\bsave\b|\bsaving throw\b|\bcritical/i.test(text)) return null;   // спасбросок — испытание, крит — другая ветка
  let hit = null;
  const denied = new Set();   // состояния, которые текст прямо отрицает («the creature isn't Immobilized»)
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const m = FORMS.map((f) => f.exec(s)).find(Boolean);
    if (!m && NEGATED.test(s)) for (const l of s.matchAll(ALL_LINKS)) denied.add(condSlugById[l[1]]);
    if (m && !hit && REST_OK.test(m.groups.rest)) hit = { m, s };
    else if ([...s.matchAll(ALL_LINKS)].length && !NEGATED.test(s)) return null;   // другое состояние в тексте не в отрицании — правило неполное
    else if (/@Damage\[/.test(s) && !/\bsever/i.test(s)) return null;   // урон от захвата — отдельный шаг, которого нет: правило было бы слабее текста (разрыв конечности — справка)
  }
  if (!hit) return null;
  const size = SIZE_GATE.exec(hit.s);
  const sizeWhen = size ? [{ [size[2].toLowerCase() === "smaller" ? "lte" : "gte"]: ["target:size", SIZES.indexOf(size[1].toLowerCase())] }] : [];
  const [, id, label] = hit.m;
  const cond = condSlugById[id];
  if (!cond) return null;
  const value = /\s(\d)\s*$/.exec(label)?.[1];
  const w = REST_OK.exec(hit.m.groups.rest)?.groups.w?.toLowerCase();
  const duration = w && { duration: { value: 1, unit: "rounds", expiry: w === "end" ? "turn-end" : "turn-start", of: "origin" } };
  const step = { to: "target", condition: { slug: cond, ...(value && { value: +value }), policy: "max" }, ...duration };
  // состояние в 8.6.1 выдаёт ещё и другое через GrantItem (Схвачен -> Обездвижен), а текст это отрицает: «схвачен, но не обездвижен» = off-guard + эффект-метка пака, не само состояние
  const steps = (GRANTS[cond] ?? []).some((g) => denied.has(g)) && NO_IMMOBILIZED[cond]
    ? [{ to: "target", condition: { slug: "off-guard", policy: "max" }, ...duration }, { to: "target", effect: { uuid: NO_IMMOBILIZED[cond] } }] : [step];
  const raw = { v: 1, label: name, onEvent: [{ on: "attack-roll", side: "self", when: [`item:attack-effect:${slug}`, { or: ["outcome:success", "outcome:criticalSuccess"] }, ...sizeWhen], apply: steps }] };
  const v = validateRule(raw);
  return v.ok && roundTrip(v.rule) ? v.rule : null;
}

/** Есть ли у актёра Удар, чьи attackEffects называют эту способность (проверка по json-паку pf2e; нет пака/актёра — null). */
export function strikeLinks(uuid, slug, packs = PACKS, cache = {}) {
  const m = /^Compendium\.pf2e\.([^.]+)\.Actor\.([^.]+)\.Item\.[^.]+$/.exec(uuid);
  const f = m && join(packs, `${m[1]}.json`);
  if (!f || !existsSync(f)) return null;
  const arr = (cache[m[1]] ??= JSON.parse(readFileSync(f, "utf8")));
  const actor = (Array.isArray(arr) ? arr : arr.entries ?? arr.items ?? Object.values(arr)).find((x) => x._id === m[2]);
  return actor ? actor.items.some((x) => ["melee", "weapon"].includes(x.type) && (x.system?.attackEffects?.value ?? []).includes(slug)) : null;
}

/** Каталог из способностей NPC: слаг -> правило; копии с разными правилами одним ключом не выразить — в conflicts. */
export function buildOnhit(items, html, condSlugById, linked = () => null) {
  const bySlug = new Map(), stats = { docs: 0, linked: 0, noLink: 0, unknown: 0 };
  for (const it of items) {
    if (!it.embedded || it.type !== "action") continue;
    const rule = deriveHit(html[it.uuid], it, condSlugById);
    if (!rule) continue;
    stats.docs++;
    const l = linked(it);
    if (l === false) { stats.noLink++; continue; }   // Удар не называет способность: правило не сработало бы
    stats[l === null ? "unknown" : "linked"]++;
    (bySlug.get(it.slug) ?? bySlug.set(it.slug, new Map()).get(it.slug)).set(JSON.stringify({ ...rule, label: undefined }), rule);
  }
  const cat = {}, conflicts = [];
  for (const [slug, rules] of [...bySlug].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (rules.size === 1) cat[slugTypeKey(slug, "action")] = [...rules.values()][0];
    else conflicts.push(slug);
  }
  return { cat, conflicts, stats };
}

function main() {
  const { items } = readOut("items.json");
  const html = readOut("html.json"), refs = readOut("refs.json");
  const condSlugById = Object.fromEntries(Object.entries(refs.conditions).map(([slug, c]) => [c.id, slug]));
  const cache = {};
  const { cat, conflicts, stats } = buildOnhit(items, html, condSlugById, (it) => strikeLinks(it.uuid, it.slug, PACKS, cache));
  // для Критика: по одной записи на slug — правило, число копий и текст первой копии
  const by = new Map();
  for (const it of items) if (it.embedded && it.type === "action" && cat[slugTypeKey(it.slug, "action")]) (by.get(it.slug) ?? by.set(it.slug, []).get(it.slug)).push(it);
  const head = `# onhit: ${Object.keys(cat).length} способностей. Для каждой: правило совпадает с текстом (какое состояние, срок, размер цели)? ok / wrong (почему)\n`;
  writeText(join(OUT, "sample", "onhit.md"), head + [...by].map(([slug, list], i) => `\n## ${i + 1}. ${list[0].name} (${slug}, копий: ${list.length})\n${list[0].uuid}\nRULE: ${JSON.stringify(cat[slugTypeKey(slug, "action")].onEvent)}\nEN: ${stripHtml(html[list[0].uuid])}\n`).join(""));
  writeText(join(ROOT, "rules/catalog.onhit.json"), `{"v":1,\n"bySlug":{\n${Object.entries(cat).map(([k, r]) => `${JSON.stringify(k)}:${JSON.stringify(r)}`).join(",\n")}\n}}\n`);
  console.log("onhit:", JSON.stringify({ ...stats, slugs: Object.keys(cat).length, conflicts }));
}

if (isMain(import.meta.url)) main();
