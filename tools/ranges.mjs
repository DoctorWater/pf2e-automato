// Группа «дальность не-заклинаний»: у черт и действий нет system.range, дальность живёт только в английском тексте (tools/out/items.json).
// Пишем rules/ranges.json: {bySource: uuid -> запись, bySlug: slug -> запись, exceptions: slug -> причина}; рантайм — scripts/range.mjs (itemRange).
// Запись: {ft, area?, grow?}; area — дальность места области/точки (рантайм её не применяет: проверки места нет), grow {every, add} — «Level (+every) range increases by add feet».
// По slug запись идёт только если ВСЕ активные документы с этим slug дают то же самое (иначе общий slug у несвязанных способностей — только bySource). Запуск: node tools/ranges.mjs
import { join } from "node:path";
import { ROOT, readOut, stripHtml, writeJson, isMain } from "./lib.mjs";
import { sluggify } from "../scripts/util.mjs";

const DROP = /^(?:Trigger|Requirements?|Frequency|Prerequisites?|Access|Cost|Effect)\b/i;   // условия срабатывания — не дальность применения
const NOT_OF = String.raw`(?! of (?!you\b|yourself\b))`;   // «within 30 feet of you» — от автора; «of both runes / of your familiar / of the illusion» — другая точка отсчёта
const WITHIN = new RegExp(String.raw`\bwithin (\d+) (?:feet|foot)${NOT_OF}`, "gi");
const RANGE = /\b(?:has )?a range of (\d+) (?:feet|foot)/gi;
const PATH = /\b(?:from you|away from you) up to (\d+) (?:feet|foot)/gi;   // Летающее пламя: путь от автора до N фт (цели — вдоль пути)
const AREA = /@Template\[|\b(?:burst|cone|line|cylinder|emanation)\b|\bbottom\b|\b(?:square|space|spot|point|location)s? (?:\w+ ){0,3}within/i;   // ищем в 80 знаках ДО расстояния: у соседних фраз строки своя семантика
// «within N feet» не про дальность применения: триггер зоны/ауры, привязь, «подойти», «в начале хода» (Hallowed Earth, Manifest Eidolon, Steam Knight, Marathon Dash)
const NOT_REACH = /\b(?:ends?|starts?) (?:its|their|your) turn (?:\w+ )?within\b|\bremain within\b|\b(?:come|comes|is|are) within\b|\bsurroundings within\b|\bwithin \d+ feet would\b/i;
const AT_START = /^.{0,25}\bat the start\b/i;
/** Вручную: документы, где «range»/«within» — дальность чужого Удара или модификатор другого действия, а не применения самой способности. */
export const MANUAL = {
  "vitality-manipulating-stance": "дальность Удара стойки (30 фт), а не применения стойки",
  "hydraulic-maneuvers": "меняет дальность чужого действия (Trip), цели у самой черты нет",
  "in-tune": "перенос начала эмпатии заклинания на союзника — модификатор, цели нет",
  "silo-crop": "дальность 60 фт — условие знать о членах «урожая», не применение"
};
const HEIGHT = /Level \(\+(\d+)\)[^\n]*?\brange (?:increases|improves)[^\n]*?by (\d+) feet/i;

/** Чистая: текст описания -> {ft, area?, grow?} | {skip: причина} | null (дальности нет). */
export function rangeOf(descEn) {
  const full = stripHtml(descEn ?? "");
  const [headRaw, ...rest] = full.split(/\n---\n/);
  const head = headRaw.split("\n").filter((l) => !DROP.test(l)).join("\n");
  const hits = [];
  for (const re of [WITHIN, RANGE, PATH]) for (const m of head.matchAll(re)) {
    const s = head.lastIndexOf("\n", m.index) + 1, e = head.indexOf("\n", m.index);
    const line = head.slice(s, e < 0 ? undefined : e), before = head.slice(Math.max(s, m.index - 80), m.index + m[0].length);
    const clause = line.slice(Math.max(0, m.index - s - 60), m.index - s + m[0].length + 40);
    if (NOT_REACH.test(clause) || AT_START.test(head.slice(m.index + m[0].length, m.index + m[0].length + 40).replace(/^ of you /, ""))) continue;
    const tail = line.slice(m.index - s + m[0].length).split(/[.;]/)[0].slice(0, 80).replace(/\b[A-Z]\w*/g, "");   // названия с большой буквы («Shocking Burst») — не область; «range of 40 feet and explodes in a burst»: область — в хвосте предложения
    hits.push({ ft: Number(m[1]), sentence: before + tail });
  }
  if (!hits.length) return null;
  const fts = [...new Set(hits.map((h) => h.ft))];
  if (fts.length > 1) return { skip: `несколько расстояний (${fts.join("/")}): неясно, какое — дальность применения` };
  const area = hits.some((h) => AREA.test(h.sentence));
  const g = HEIGHT.exec(rest.join("\n"));
  return { ft: fts[0], ...(area && { area: true }), ...(g && { grow: { every: Number(g[1]), add: Number(g[2]) } }) };
}

/** Чистая: документы -> {bySource, bySlug, exceptions}. Берём только применяемые (не passive) feat/action. */
export function buildRanges(items) {
  const bySource = {}, groups = new Map(), exceptions = {};
  for (const it of items) {
    if (!["feat", "action"].includes(it.type) || !it.actionType || it.actionType === "passive") continue;
    const slug = it.slug || sluggify(it.name);
    if (MANUAL[slug]) { exceptions[slug] = MANUAL[slug]; continue; }
    const r = rangeOf(it.descEn);
    const g = groups.get(slug) ?? groups.set(slug, []).get(slug);
    g.push({ it, r });
  }
  const bySlug = {};
  for (const [slug, docs] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const hits = docs.filter((d) => d.r && !d.r.skip);
    const skips = docs.filter((d) => d.r?.skip);
    if (skips.length && !hits.length) { exceptions[slug] = skips[0].r.skip; continue; }
    if (!hits.length) continue;
    for (const d of hits) if (d.it.uuid) bySource[d.it.uuid] = d.r;
    const key = JSON.stringify(hits[0].r);
    if (hits.length === docs.length && hits.every((d) => JSON.stringify(d.r) === key)) bySlug[slug] = hits[0].r;
    else if (docs.length > hits.length) exceptions[slug] = "общий slug у несвязанных документов: только по uuid источника";
    else exceptions[slug] = "документы с общим slug дают разную дальность: только по uuid источника";
  }
  return { bySource, bySlug, exceptions };
}

if (isMain(import.meta.url)) {
  const out = buildRanges(readOut("items.json").items);
  writeJson(join(ROOT, "rules", "ranges.json"), { v: 1, ...out }, 1);
  console.log(`ranges: bySource ${Object.keys(out.bySource).length}, bySlug ${Object.keys(out.bySlug).length}, исключений ${Object.keys(out.exceptions).length}`);
}
