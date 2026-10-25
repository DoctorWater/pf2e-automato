// affliction: стадии недугов (яд, болезнь, проклятие) — разбор текста «Saving Throw … Maximum Duration … Stage N …» в определение шага `affliction` (plan-affliction.md §3).
// Модель пишет обычное правило; здесь определение собирается кодом: провал -> стадия 1, крит. провал -> стадия 2, одинаковый def в обоих шагах.
// Нераспознанное остаётся текстом стадии (stages[].text) и попадает в unsure. Отчёт по документам: node tools/affliction.mjs
import { readOut, stripHtml, isMain } from "./lib.mjs";
import { afflictionStages, parseCheck, validateRule, DAMAGE_TYPES, AFFLICTION_KINDS } from "../scripts/rules.mjs";
import { STEP_TARGETS, BONUS_TYPES } from "../scripts/workshop/effect.mjs";
import { normalizeMods } from "../scripts/inline-effect.mjs";

const UNIT = { r: "rounds", m: "minutes", h: "hours", d: "days" };
const dur = (v, u) => ({ value: +v, unit: UNIT[u[0].toLowerCase()] });
const DUR_END = /\(\s*(\d+)\s*(round|minute|hour|day)s?\s*\)\s*[.,;]?\s*$/i;
const STAGE_MARK = /<strong>\s*Stage\s+(\d+)\s*<\/strong>/gi;
const SAVES = ["fortitude", "reflex", "will"];
const DASH = "[–−-]";
// «–10-foot status penalty to Speeds», «–2 status penalty to Fortitude saves»
const SPEED_MOD = new RegExp(`(${DASH})\\s?(\\d+)[- ]foot\\s+(status|circumstance|item)\\s+penalty\\s+to\\s+(?:all\\s+)?(?:its\\s+|your\\s+)?Speeds?`, "i");
const ROLL_MOD = new RegExp(`(${DASH})\\s?(\\d+)\\s+(status|circumstance|item)\\s+penalty\\s+to\\s+(AC|attack rolls|saving throws|Fortitude saves|Reflex saves|Will saves|Perception(?: checks)?|skill checks)`, "i");
const TARGET_OF = { ac: "ac", "attack rolls": "attack-roll", "saving throws": "saving-throw", "fortitude saves": "fortitude", "reflex saves": "reflex", "will saves": "will", perception: "perception", "perception checks": "perception", "skill checks": "skill-check" };

/** Один блок «Stage N …» (HTML без метки) -> стадия схемы + признак «часть текста не разобрана». known — slug-и состояний, названных ссылками в документе (для «and fatigued» без ссылки). */
function parseStage(html, { condSlug, known }) {
  const out = { duration: null, damage: [], persistent: null, conditions: [], mods: null, text: "" };
  let t = stripHtml(html), ref = null, bad = false;
  const whole = t;
  const d = DUR_END.exec(t);
  if (d) { out.duration = dur(d[1], d[2]); t = t.replace(DUR_END, ""); }
  if (/\bor\s+@Damage\[/i.test(t)) bad = true;   // «@Damage … or @Damage» — альтернатива, не сумма
  const asStage = /\bas\s+stage\s+(\d+)\b/i.exec(t);
  if (asStage) { ref = +asStage[1]; t = t.replace(asStage[0], ""); }
  // @Damage[1d10[poison]], @Damage[1d6[persistent,bleed]]
  t = t.replace(/@Damage\[((?:[^[\]]|\[[^\]]*\])*)\](?:\{[^}]*\})?(?:\s+damage)?/gi, (_m, inner) => {
    const m = /^\(?\s*(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*\)?\[([a-z,\s-]+)\]$/i.exec(inner.split("|")[0].trim());
    if (!m) { bad = true; return " "; }
    const formula = m[1].replace(/\s+/g, ""), types = m[2].toLowerCase().split(/[,\s]+/);
    const type = types.find((x) => DAMAGE_TYPES.includes(x));
    if (!type) bad = true;
    else if (types.includes("persistent")) out.persistent ??= { formula, damageType: type };
    else out.damage.push({ formula, damageType: type });
    return " ";
  });
  t = t.replace(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s+persistent\s+([a-z]+)(?:\s+damage)?/gi, (m, f, ty) => (DAMAGE_TYPES.includes(ty.toLowerCase()) ? (out.persistent ??= { formula: f.replace(/\s+/g, ""), damageType: ty.toLowerCase() }, " ") : m));
  t = t.replace(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s+([a-z]+)(?:\s+damage)?/gi, (m, f, ty) => (DAMAGE_TYPES.includes(ty.toLowerCase()) ? (out.damage.push({ formula: f.replace(/\s+/g, ""), damageType: ty.toLowerCase() }), " ") : m));
  const add = (slug, value) => { if (!out.conditions.some((c) => c.slug === slug)) out.conditions.push({ slug, ...(value != null && { value }) }); };
  t = t.replace(/@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g, (m, uuid, label = "") => {
    const slug = condSlug(uuid);
    if (!slug) return m;
    add(slug, /(\d+)\s*$/.exec(label)?.[1] ? +/(\d+)\s*$/.exec(label)[1] : null);
    return " ";
  });
  for (const slug of known) {
    const re = new RegExp(`\\b${slug.replace(/-/g, "[ -]")}\\b(?:\\s+(\\d+))?`, "i");
    t = t.replace(re, (_m, v) => (add(slug, v ? +v : null), " "));
  }
  const mods = [];
  t = t.replace(SPEED_MOD, (_m, _s, n, type) => (mods.push({ speed: { type: type.toLowerCase(), value: -+n } }), " "));
  t = t.replace(ROLL_MOD, (_m, _s, n, type, tg) => {
    const target = TARGET_OF[tg.toLowerCase()];
    if (STEP_TARGETS.includes(target) && BONUS_TYPES.includes(type.toLowerCase())) mods.push({ bonus: { target, type: type.toLowerCase(), value: -+n } });
    return " ";
  });
  if (mods.length && !normalizeMods(mods).error) out.mods = normalizeMods(mods).mods;
  else if (mods.length) bad = true;
  // остаток: связки и знаки не в счёт, любое слово — непонятая часть (сюжетное, «carrier with no ill effect», «dead»)
  const rest = t.replace(/\b(?:and|or|the|a|an|of)\b|damage|[\s,.;:()—–-]/gi, "");
  if (rest || bad) { out.text = whole.replace(DUR_END, "").trim(); bad = true; }
  return { stage: out, ref, unsure: bad };
}

// признаки механики в тексте вне стадий: такое правило не собираем, а в долг
const MECH = /n't\b|cannot|immune|persist|reduc|instead|remain|\bonly\b|\bnote\b|cumulative|\blasts\b|whenever|each round|\bper round\b|first time|\battack\b|\btrigger\b|critical|doubl|halve|regain|\bGM\b|@UUID|@Check|@Damage|\bDC\b|saving throw|\d+ (?:round|minute|hour|day)|\bcondition\b|\bmust\b/i;
const LABELS = /^(saving throw|onset|maximum duration|activate|craft requirements|price|frequency|requirements)$/i;

/**
 * Первый непустой текст вне блоков «Stage N» -> строка | "". Допустимо только вводное описание до первой стадии и без механики (MECH).
 * Общий для конвертера и checkAffliction.
 */
export function outsideText(html) {
  const secs = [[]];
  for (const m of html.matchAll(/<hr\s*\/?>|<p[^>]*>[\s\S]*?<\/p>/gi)) {
    if (/^<hr/i.test(m[0])) secs.push([]); else secs.at(-1).push(m[0]);
  }
  for (const ps of secs) {
    const items = ps.map((p) => ({ p, plain: stripHtml(p).trim(), label: /^<p[^>]*>\s*<strong>\s*([^<]*?)\s*<\/strong>/i.exec(p)?.[1] })).filter((x) => x.plain);
    const first = items.findIndex((x) => x.label != null && /^stage\s+\d+$/i.test(x.label));
    for (const [i, x] of items.entries()) {
      if (x.label == null) { if (MECH.test(x.plain) || (first >= 0 && i > first)) return x.plain; continue; }
      if (/^stage\s+\d+$/i.test(x.label)) {
        const extra = x.p.replace(/^<p[^>]*>|<\/p>$/gi, "").split(/<br\s*\/?>/i).map((t) => t.trim()).find((t) => stripHtml(t).trim() && !/^<strong>\s*Stage\s+\d+/i.test(t));
        if (extra) return stripHtml(extra).trim();
      } else if (!LABELS.test(x.label) && !/^\([a-z, -]+\)$/i.test(x.plain.slice(x.label.length).trim())) return x.plain;   // «Название (poison)» — заголовок, не текст
    }
  }
  return "";
}

/**
 * html документа -> { def, unsure: [строки], dcMissing } | null (нет блоков Stage, нет спасброска или вида недуга).
 * opts: { name, traits: [трейты предмета], kind?, save?: { statistic, dc? } (защита из defense.save у заклинания), condSlug(uuid) -> slug | null }
 */
export function parseAffliction(html, { name, traits = [], kind = null, save = null, condSlug = () => null } = {}) {
  if (typeof html !== "string") return null;
  const marks = [...html.matchAll(STAGE_MARK)].map((m) => ({ n: +m[1], at: m.index, end: m.index + m[0].length }));
  if (marks.length < 2 || marks.some((m, i) => m.n !== i + 1)) return null;
  const head = html.slice(0, marks[0].at);
  // спасбросок до первой стадии (у NPC dc: бывает пуст); у заклинания без @Check — защита документа
  let sv = null, check = null;
  for (const m of html.matchAll(/@Check\[([^\]]*)\]/g)) {
    const c = parseCheck(m[1]), s = (c.type ?? "").split(",")[0];
    if (SAVES.includes(s) && m.index < marks[0].at) { check = c; sv = { statistic: s, ...(/^\d+$/.test(c.params.dc ?? "") && { dc: +c.params.dc }) }; break; }
  }
  sv ??= save?.statistic && SAVES.includes(save.statistic) ? { statistic: save.statistic, ...(save.dc != null && { dc: save.dc }) } : null;
  const traitList = [...traits, ...(check?.params.traits?.split(",") ?? [])];
  const k = kind ?? AFFLICTION_KINDS.find((x) => traitList.includes(x)) ?? /\((poison|disease|curse)\)/i.exec(stripHtml(head))?.[1]?.toLowerCase() ?? null;
  if (!sv || !AFFLICTION_KINDS.includes(k)) return null;
  const plainHead = stripHtml(head), unsure = [];
  const du = /Maximum Duration\s+(\d+)\s*(round|minute|hour|day)s?/i.exec(plainHead), on = /Onset\s+(\d+)(?!\w)\s*(round|minute|hour|day)s?/i.exec(plainHead);
  if (/<strong>\s*Onset/i.test(head) && !on) unsure.push("onset: not a plain number");
  if ([...head.matchAll(/@Check\[(?:fortitude|reflex|will)/g)].length > 1) unsure.push("second save check in head");
  const outside = outsideText(html);
  if (outside) unsure.push(`text outside stages: ${outside.slice(0, 70)}`);
  const known = [...new Set([...html.matchAll(/@UUID\[([^\]]+)\]/g)].map((m) => condSlug(m[1])).filter(Boolean))];
  const stages = [], refs = [];
  marks.forEach((m, i) => {
    const stop = html.slice(m.end).search(/<\/p>|<hr|<br|<\/li>|$/);
    const next = marks[i + 1]?.at ?? Infinity;
    const r = parseStage(html.slice(m.end, Math.min(next, m.end + stop)), { condSlug, known });
    stages.push(r.stage); refs.push(r.ref);
    if (r.unsure) unsure.push(`stage ${m.n}: ${r.stage.text}`);
  });
  // «as stage 2»: содержимое названной стадии, срок свой
  refs.forEach((ref, i) => {
    const src = ref && stages[ref - 1];
    if (src) stages[i] = { ...structuredClone(src), duration: stages[i].duration ?? src.duration };
  });
  // срок стадии: без него — срок соседа, если однозначен; «конечная» стадия без срока — только у болезни/проклятия без Maximum Duration
  const have = stages.filter((x) => x.duration), missing = stages.map((x, i) => (x.duration ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const uniq = [...new Map(have.map((x) => [`${x.duration.value}${x.duration.unit}`, x.duration])).values()];
    const endOk = !du && k !== "poison" && missing.length === 1 && missing[0] === stages.length - 1;
    if (!have.length) unsure.push("duration: no stage has one");
    else if (!endOk) {
      if (uniq.length === 1) missing.forEach((i) => { stages[i].duration = structuredClone(uniq[0]); });
      else unsure.push(`duration: stage ${missing[0] + 1} has none, neighbours differ`);
    }
  }
  if (!sv.dc) unsure.push("dc");
  const virulent = traits.includes("virulent") || /\bvirulent\b/i.test(plainHead);
  return {
    def: { name: name ?? "", kind: k, save: sv, maxDuration: du ? dur(du[1], du[2]) : null, onset: on ? dur(on[1], on[2]) : null, virulent, ...(traitList.length && { traits: [...new Set(traitList.filter((x) => /^[a-z0-9-]+$/.test(x) && !AFFLICTION_KINDS.includes(x) && x !== "virulent"))] }), stages },
    unsure
  };
}

/**
 * Правило недуга: провал -> стадия 1, крит. провал -> стадия 2. base — правило модели/вывода: его испытание (навык, СЛ, basic, черты) и остальные степени остаются,
 * провал и крит. провал заменяются шагами недуга. Без base испытание строится из @Check текста.
 * -> { rule, def, unsure } | null (текст не разобран или правило не прошло валидатор: unsure говорит почему)
 */
export function afflictionRule(html, opts = {}) {
  const p = parseAffliction(html, { ...opts, save: opts.save ?? opts.base?.onUse?.challenge });
  if (!p) return null;
  const c = opts.base?.onUse?.challenge, step = (stage) => ({ to: "target", affliction: { stage, def: p.def } });
  const dc = p.def.save.dc != null ? { value: p.def.save.dc } : c?.dc ?? { expr: "markup" };
  const challenge = {
    statistic: c?.statistic ?? p.def.save.statistic, dc: c?.dc ?? dc, basic: false, rollerRole: "target",
    ...(c?.traits && { traits: c.traits }), ...(c?.options && { options: c.options }), ...(c?.when && { when: c.when }),
    byDegree: { ...c?.byDegree, failure: [step(1)], criticalFailure: [step(Math.min(2, p.def.stages.length))] }
  };
  const rule = { v: 1, ...(opts.name && { label: opts.name }), onUse: { targets: opts.base?.onUse?.targets ?? "selected", excludeSelf: null, zone: null, challenge, apply: opts.base?.onUse?.apply ?? [] } };
  const v = validateRule(rule);
  return v.ok ? { rule: v.rule, def: v.rule.onUse.challenge.byDegree.failure[0].affliction.def, unsure: p.unsure } : { rule: null, def: p.def, unsure: [...p.unsure, ...v.errors.map(String)] };
}

/**
 * Правило injury-яда (испытание цели при использовании) -> нанесение на оружие: onUse.challenge уходит в шаг coat, использование — на себя (plan-weapon-poison.md §5).
 * Остальные шаги onUse.apply остаются после coat. duration — срок яда (Envenom), без него яд держится до траты. -> валидное правило | null
 */
export function coatOf(rule, { duration = null } = {}) {
  const u = rule?.onUse;
  if (!u?.challenge || u.check || u.zone) return null;
  const coat = { v: 1, ...(rule.label && { label: rule.label }), onUse: { ...u, targets: "self", excludeSelf: null, challenge: null, apply: [{ to: "self", coat: { weapon: "choose", ...(duration && { duration }), challenge: { ...u.challenge, traits: u.challenge.traits ?? [...new Set([u.challenge.byDegree?.failure?.[0]?.affliction?.def?.kind, "injury"].filter(Boolean))] } } }, ...(u.apply ?? [])] } };
  const v = validateRule({ ...rule, ...coat });
  return v.ok ? v.rule : null;
}

function main() {
  const html = readOut("html.json"), { items } = readOut("items.json"), refs = readOut("refs.json");
  const byId = new Map(Object.entries(refs.conditions).map(([slug, c]) => [c.id, slug]));
  const condSlug = (u) => (u.includes(".conditionitems.") ? byId.get(u.split(".").pop()) ?? null : null);
  const seen = new Set();
  let n = 0, clean = 0, rule = 0, noParse = 0;
  const bad = [];
  for (const it of items) {
    const h = html[it.uuid];
    if (!afflictionStages(h) || seen.has(`${it.name}|${h}`)) continue;
    seen.add(`${it.name}|${h}`);
    n++;
    const r = afflictionRule(h, { name: it.name, traits: it.traits ?? [], condSlug, save: it.defense ? { statistic: it.defense.save } : null });
    if (!r) { noParse++; continue; }
    if (r.rule) rule++;
    if (r.rule && !r.unsure.length) clean++; else bad.push(`${it.name}: ${r.unsure.slice(0, 2).join(" | ").slice(0, 120)}`);
  }
  console.log(`документов со стадиями: ${n}; не разобрано (нет спасброска/вида): ${noParse}; правило собрано: ${rule}; без остатка: ${clean}`);
  console.log(bad.slice(0, 15).join("\n"));
}
if (isMain(import.meta.url)) main();
