// Группа «Удар -> спасбросок -> состояние»: пассивка NPC, на которую ссылается attackEffects Удара того же актёра, текст вида
// «A creature damaged by X's claw must succeed at a @Check[fortitude|dc:21] save or be Slowed 1 until the end of X's next turn (Slowed 2 on a critical failure)».
// Правило onUse.challenge (statistic, dc, byDegree failure/criticalFailure -> condition); Удар запускает его сам (strike-link.mjs выводит onEvent).
// Берём только однозначное: весь текст — одна фраза «триггер -> спасбросок -> одно состояние»; остальное — в skipped с причиной (ложное правило хуже отсутствия).
// Запуск: node tools/strike-save-cond.mjs -> rules/catalog.strike-save.json (bySource: uuid документа -> правило; у одинаковых текстов копий много, у каждой свой uuid).
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ROOT, readOut, writeText, isMain } from "./lib.mjs";
import { validateRule } from "../scripts/rules.mjs";
import { roundTrip } from "./validate.mjs";
import { strikeLinks } from "./onhit.mjs";
import { sluggify } from "../scripts/util.mjs";

// состояния, которые можно наложить на цель: без отношений (friendly...), видимости, dying/persistent-damage и служебных
const CONDS = new Set(["blinded", "clumsy", "confused", "dazzled", "deafened", "doomed", "drained", "enfeebled", "fascinated", "fatigued", "fleeing", "frightened", "grabbed", "immobilized", "off-guard", "paralyzed", "petrified", "prone", "restrained", "sickened", "slowed", "stunned", "stupefied", "unconscious"]);
const VALUED = new Set(["clumsy", "doomed", "drained", "enfeebled", "frightened", "sickened", "slowed", "stunned", "stupefied"]);
const UNITS = { round: "rounds", minute: "minutes", hour: "hours", day: "days" };
const NUM = { one: 1, two: 2, three: 3 };

// слова, которых нет в «воде» (flavor) до и после главной фразы: механика, отрицание, цифры, разметка
const MECH = /@|\d|\{\{|\b(?:save|saves|saving|damage|damages|damaged|critical|crit|DC|immun\w*|resist\w*|can't|cannot|can|unless|instead|also|additional|again|new|reset\w*|increase\w*|decrease\w*|maximum|temporary|heal\w*|gain\w*|regain\w*|hit points|persistent|each|every|if|when|while|until|for|long|only|may|must|not|no|never|any)\b/i;
const SUBJ = String.raw`(?:(?:a|an|any|each|every)\s+)?(?:creature|target|enemy|foe)`;
const HIT = String.raw`(?:critically\s+)?(?:hit|struck|damaged|struck and damaged|hit and damaged)\s+(?:by|with)|(?:takes?|taking)\s+damage\s+from`;
const DUR = String.raw`(?:until the (?<w>end|start) of (?<who>[^.,()]{1,40}?)['’]s next turn|for (?<n>\d+|one|two|three) (?<u>round|minute|hour|day)s?)`;
const COND1 = /^(?:\{\{(\w+)\|([^}]*)\}\}|([A-Za-z-]+))(?:\s+(\d))?$/;
// соседние предложения: «can attempt a new save at the end of each of its turns» (без убывания СЛ) и иммунитет после спасброска
const REPEAT = /^(?:It|They|The (?:\w+ )?(?:creature|target)|A victim) can attempt a new (?:save|saving throw)(?: to (?:end (?:the|this) effect|recover))? at the end of each of (?:its|their) turns(?: to (?:end (?:the|this) effect|recover))?\.?$/i;
const IMM_ALL = /^(?:After attempting this save|Regardless of the result of the saving throw), (?:a|the) creature is temporarily immune (?:to (?<n>[\w' -]{1,40}?) )?(?:for (?<v>\d+) (?<u>minutes?|hours?|days?))\.?$/i;
const IMM_CS = /^On a critical success, (?:a|the) creature is (?:temporarily )?immune (?:to (?<n>[\w' -]{1,40}?) )?(?:for (?<v>\d+) (?<u>minutes?|hours?|days?))\.?$/i;
const IMM_OK = /^(?:A|The) creature (?:that )?succeeds(?: at (?:its|the) (?:save|saving throw))? is (?:then )?temporarily immune (?:to (?<n>[\w' -]{1,40}?) )?(?:for (?<v>\d+) (?<u>minutes?|hours?|days?))\.?$/i;

/** «Drained 2 and Doomed 1» / «Prone, and Deafened» -> [{slug, value}] | {skip}. */
function partsOf(str, byId) {
  const out = [];
  for (const raw of str.trim().split(/\s*,\s*and\s+|\s*,\s*|\s+and\s+/)) {
    const m = COND1.exec(raw.trim());
    if (!m) return { skip: /\{\{|\band\b|\bor\b/.test(str) ? "несколько состояний/выбор" : "иная формулировка результата" };
    const slug = m[1] ? byId[m[1]] : m[3].toLowerCase();
    const l = m[1] ? labelOf(m[2]) : { name: slug, value: null };
    if (!slug || !l || l.name.replace(/-/g, "") !== slug.replace(/-/g, "")) return { skip: "метка состояния не совпала со ссылкой" };
    const value = l.value ?? (m[4] ? +m[4] : null);
    if (!CONDS.has(slug)) return { skip: `состояние не из разрешённых: ${slug}` };
    if (VALUED.has(slug) ? value == null : value != null) return { skip: VALUED.has(slug) ? "значение состояния не указано" : "значение у состояния без значения" };
    out.push({ slug, value });
  }
  return out.length ? out : { skip: "иная формулировка результата" };
}
// A: «A creature [that is] damaged by X»; B: «When X hits/damages a creature with its Y, the creature»
const TRIG_A = new RegExp(String.raw`^${SUBJ}\s+(?:(?:that|who)\s+(?:is\s+|are\s+)?)?(?:${HIT})\s+[^,]{1,70}$`, "i");
const TRIG_B = new RegExp(String.raw`^(?:when|if|whenever)\s+[^,]{1,60}?\s+(?:critically\s+)?(?:hits?|damages?|strikes?|hits? and damages?)(?:\s+(?:a|an|the|any)\s+(?:creature|target|enemy|foe))?(?:\s+with\s+[^,]{1,50})?,\s*(?:the|that|this)\s+(?:creature|target|enemy|foe)$`, "i");
const SAVE_PARAMS = new Set(["dc", "traits", "showDC", "name", "options"]);

/** Метка состояния «Slowed 1» / «stunned» -> {name, value|null}. */
const labelOf = (s) => { const m = /^([A-Za-z-]+(?:\s[A-Za-z]+)?)\s*(\d)?$/.exec(s.trim()); return m && { name: m[1].toLowerCase().replace(/\s/g, "-"), value: m[2] ? +m[2] : null }; };

/** Текст -> токены: ссылки на состояния -> «{{id|метка}}». null, если есть чужая ссылка. */
function tokens(html) {
  let t = String(html ?? "").replace(/<\/?p[^>]*>|<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'");
  t = t.replace(/@UUID\[Compendium\.pf2e\.conditionitems\.Item\.(\w+)\]\{([^}]*)\}/g, "{{$1|$2}}");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Чистая: описание (английское) -> { rule } | { skip: причина }. condSlugById — id состояния pf2e -> slug (refs.conditions).
 * Однозначное: ровно один @Check спасброска, триггер «попал/нанёс урон Ударом», одно состояние по провалу, значение крит. провала в скобках,
 * срок «до конца/начала следующего хода X» или «на N раундов/…»; всё прочее (условие на цель, недуг, урон, выбор, иммунитет, второй исход) — skip.
 */
export function deriveStrikeSave(html, name, condSlugById, critKnown = false) {
  const t = tokens(html);
  if (!t) return { skip: "пусто" };
  if (/---|\bStage\b|Maximum Duration|Saving Throw\b/.test(t) || /\bonset\b/i.test(t)) return { skip: "недуг со стадиями" };
  const checks = [...t.matchAll(/@Check\[([^\]]*)\](?:\{[^}]*\})?/g)];
  if (checks.length !== 1) return { skip: checks.length ? "несколько спасбросков" : "нет @Check" };
  if (/@(?!Check\[)\w+\[/.test(t)) return { skip: "посторонняя разметка (урон/ссылка/шаблон)" };
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z@{])/);
  const mi = sentences.findIndex((s) => s.includes("@Check["));
  const main = sentences[mi];
  // соседние предложения: повторный спасбросок и иммунитет — разбираем; прочее — только «вода» без механики
  let repeat = false, immunity = null;
  // консервативно: после спасброска всё незнакомое — пропуск (там продолжение механики: «The creature is pulled toward it.»); до него — «вода», если не говорит о «the creature/target»
  for (const [i, s] of sentences.entries()) {
    if (i === mi) continue;
    let x;
    if (REPEAT.test(s)) repeat = true;
    else if ((x = IMM_ALL.exec(s))) immunity = { n: x.groups.n, value: +x.groups.v, unit: x.groups.u, degrees: null };
    else if ((x = IMM_OK.exec(s))) immunity = { n: x.groups.n, value: +x.groups.v, unit: x.groups.u, degrees: ["success", "criticalSuccess"] };
    else if ((x = IMM_CS.exec(s))) immunity = { n: x.groups.n, value: +x.groups.v, unit: x.groups.u, degrees: ["criticalSuccess"] };
    else if (i > mi || /\b(?:the|a|an|that|this)\s+(?:creature|target|victim|enemy|foe)\b/i.test(s) || MECH.test(s)) return { skip: /{{|@/.test(s) ? "в тексте ещё одно состояние/механика" : /DC (?:cumulatively )?decreas|cumulatively|increase|decrease|value/i.test(s) ? "рост значения / убывание СЛ (схема не умеет)" : "дополнительные условия в тексте" };
  }

  const m = /^(?<trig>.*?)\s*\bmust\s+(?:succeed\s+(?:(?:at|on)\s+)?|attempt\s+|make\s+)an?\s+@Check\[(?<chk>[^\]]*)\](?:\{[^}]*\})?\s*(?:save|saving throw)?\s*,?\s*or\s+(?<res>.+?)\.?$/i.exec(main);
  if (!m) return { skip: /\bsuccessful\b|negates|\bsave\b.*\bfail/i.test(main) ? "иная структура спасброска (успех отменяет/исход не «или»)" : "иная формулировка спасброска" };
  const { trig, chk, res } = m.groups;
  if (!TRIG_A.test(trig) && !TRIG_B.test(trig)) {
    if (/\b(?:non-?\w+|living|undead|humanoid|evil|good|lawful|chaotic|\w+ creature)\b/i.test(trig) && /creature|target/i.test(trig)) return { skip: "условие на цель (тип/мировоззрение/живое)" };
    return { skip: "триггер не «попал/нанёс урон Ударом»" };
  }
  // критическое попадание: запуск только на крит делает оверлей rules/crit-only.json (по uuid; critKnown); без записи правило сработало бы на любое попадание
  if (/\bcritical/i.test(trig) && !critKnown) return { skip: "триггер — критическое попадание (uuid нет в rules/crit-only.json)" };

  const params = chk.split("|");
  const statistic = params[0];
  if (!["fortitude", "reflex", "will"].includes(statistic)) return { skip: "не спасбросок" };
  const p = Object.fromEntries(params.slice(1).map((x) => { const i = x.indexOf(":"); return i < 0 ? [x, true] : [x.slice(0, i), x.slice(i + 1)]; }));
  if (Object.keys(p).some((k) => !SAVE_PARAMS.has(k))) return { skip: `параметры спасброска: ${Object.keys(p).filter((k) => !SAVE_PARAMS.has(k)).join(",")}` };
  if (!/^\d+$/.test(p.dc ?? "")) return { skip: "СЛ не число" };

  // результат: [be|become [knocked]] LIST [DUR] [(LIST2 on a critical failure)] [DUR] [as flavor]
  const VERB = /^(?:be|become|is|are)\s+(?:knocked\s+)?/i;
  if (!VERB.test(res)) return { skip: "иная формулировка результата" };
  let r = res.replace(VERB, "");
  r = r.replace(/\s+(?:as|from)\s+[^.]{1,100}$/i, (x) => (MECH.test(x) ? x : ""));
  let c2 = null;
  r = r.replace(/\s*\((?:or\s+)?([^()]+?)\s+on a critical failure\)|,\s*or\s+([^(),]+?)\s+on a critical failure$/i, (_, a, b) => { c2 = a ?? b; return ""; });
  const durs = [];
  r = r.replace(new RegExp(String.raw`\s*${DUR}`, "gi"), (x, ...a) => { durs.push(a.at(-1)); return ""; });
  if (durs.length > 1) return { skip: "две длительности" };
  const g = durs[0] ?? {};
  const parts = partsOf(r, condSlugById);
  if (parts.skip) return { skip: /damage|persistent|@/i.test(res) ? "урон/продолжительный урон в той же фразе" : /\b(?:until|for|permanent\w*)\b/i.test(r) ? "непонятная длительность" : parts.skip };
  const critParts = c2 == null ? parts : partsOf(c2, condSlugById);
  if (critParts.skip || critParts.length !== parts.length || critParts.some((c, i) => c.slug !== parts[i].slug)) return { skip: "крит. провал: иное состояние или значение не разобрано" };

  let duration;
  if (g.w) {
    // чей ход: названный в тексте носитель/цель; местоимение («its next turn») неоднозначно
    const target = /\b(?:creature|target|victim|enemy|foe)\b/i.test(g.who);
    duration = { value: 1, unit: "rounds", expiry: g.w.toLowerCase() === "end" ? "turn-end" : "turn-start", of: target ? "target" : "origin" };
  } else if (g.n) duration = { value: NUM[g.n.toLowerCase()] ?? +g.n, unit: UNITS[g.u.toLowerCase()], expiry: null };
  if (duration && parts.length > 1) return { skip: "срок при нескольких состояниях (неясно, к каким относится)" };
  if (repeat && (parts.length > 1 || duration)) return { skip: "повторный спасбросок при нескольких состояниях/сроке" };

  const step = (c) => ({ to: "target", condition: { slug: c.slug, ...(c.value != null && { value: c.value }), policy: "max" }, ...(duration && { duration }), ...(repeat && { repeat: { on: "turn-end", end: ["success", "criticalSuccess"] } }) });
  let imm;
  if (immunity) {
    const slug = sluggify(name);
    if (immunity.n && !sluggify(immunity.n).includes(slug)) return { skip: "иммунитет к другой способности" };
    imm = { slug, duration: { value: immunity.value, unit: immunity.unit.toLowerCase().replace(/s?$/, "s") }, ...(immunity.degrees && { degrees: immunity.degrees }) };
  }
  const challenge = {
    statistic, dc: { value: +p.dc }, basic: false, rollerRole: "target",
    ...(p.traits && { traits: String(p.traits).split(",") }),
    ...(p.options && { options: String(p.options).split(",").filter(Boolean) }),
    ...(imm && { immunity: imm }),
    byDegree: { failure: parts.map(step), criticalFailure: critParts.map(step) }
  };
  const v = validateRule({ v: 1, label: name, onUse: { targets: "selected", challenge } });
  if (!v.ok || !roundTrip(v.rule)) return { skip: "валидатор отклонил" };
  return { rule: v.rule, parsed: { statistic, dc: +p.dc, parts, critParts, duration: duration ?? null, repeat, immunity: imm ?? null } };
}

/** Чистая: документы -> { bySource, skipped:[{uuid,name,reason}], stats }. linked(it) — true/false/null (Удар актёра ссылается на способность). */
export function buildStrikeSave(items, condSlugById, linked = () => true, critBySource = {}) {
  const bySource = {}, skipped = [], stats = { docs: 0, rules: 0, noLink: 0 };
  for (const it of items) {
    if (!it.embedded || !["action", "feat"].includes(it.type) || it.actionType !== "passive" || !it.uuid) continue;
    if (!/@Check\[(?:fortitude|reflex|will)/.test(it.descEn ?? "")) continue;
    stats.docs++;
    if (linked(it) !== true) { stats.noLink++; continue; }
    const r = deriveStrikeSave(it.descEn, it.name, condSlugById, !!critBySource[it.uuid]);
    if (r.rule) { bySource[it.uuid] = r.rule; stats.rules++; } else skipped.push({ uuid: it.uuid, name: it.name, reason: r.skip });
  }
  return { bySource, skipped, stats };
}

function main() {
  const { items } = readOut("items.json"), refs = readOut("refs.json");
  const condSlugById = Object.fromEntries(Object.entries(refs.conditions).map(([slug, c]) => [c.id, slug]));
  const cache = {};
  const { bySource, skipped, stats } = buildStrikeSave(items, condSlugById, (it) => strikeLinks(it.uuid, it.slug, undefined, cache), JSON.parse(readFileSync(join(ROOT, "rules", "crit-only.json"), "utf8")).bySource);
  writeText(join(ROOT, "rules", "catalog.strike-save.json"), `{"v":1,\n"bySource":{\n${Object.entries(bySource).map(([k, r]) => `${JSON.stringify(k)}:${JSON.stringify(r)}`).join(",\n")}\n}}\n`);
  const why = {};
  for (const s of skipped) why[s.reason] = (why[s.reason] ?? 0) + 1;
  console.log("strike-save-cond:", JSON.stringify(stats), JSON.stringify(why));
}

if (isMain(import.meta.url)) main();
