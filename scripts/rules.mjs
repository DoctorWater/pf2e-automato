import { MOD, DEGREES, sluggify } from "./util.mjs";
import { S } from "./settings.mjs";

export const RULE_VERSION = 1;

/* ---------- Валидация / нормализация (чистая, без Foundry) ---------- */

const TARGETS = ["self", "selected", "area"];
const PHASES = ["onUse", "afterChallenge", "onDegree", "zoneEnter", "zoneExit", "onReaction"];
const NOTIFY = ["owner", "gm"];
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x.length > 0;
const isInt = (x) => Number.isInteger(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

const APPLY_UNITS = ["rounds", "minutes", "hours", "days"];

function vApply(a, path, defTo, err) {
  if (!isObj(a)) { err.push(`${path}: ожидается объект`); return null; }
  const out = { to: a.to ?? defTo };
  if (!["self", "target"].includes(out.to)) err.push(`${path}.to: self|target`);
  const kinds = ["condition", "effect", "note"].filter((k) => a[k] != null);
  if (kinds.length !== 1) err.push(`${path}: ровно одно из condition/effect/note`);
  if (a.condition != null) {
    const c = a.condition;
    if (!isObj(c) || !isStr(c.slug)) err.push(`${path}.condition.slug: строка`);
    else {
      if (c.value != null && !(isInt(c.value) && c.value >= 1)) err.push(`${path}.condition.value: целое >= 1`);
      if (c.policy != null && !["max", "add"].includes(c.policy)) err.push(`${path}.condition.policy: max|add`);
      out.condition = { slug: c.slug, ...(c.value != null && { value: c.value }), policy: c.policy ?? "max" };
    }
  }
  if (a.duration != null) {
    const d = a.duration;
    if (a.condition == null) err.push(`${path}.duration: только вместе с condition`);
    else if (!isObj(d) || !(isInt(d.value) && (d.value >= 1 || (d.value === 0 && d.expiry === "turn-end"))) || !APPLY_UNITS.includes(d.unit)) err.push(`${path}.duration: {value:целое>=1 (0 — только с expiry:"turn-end": до конца текущего хода), unit:${APPLY_UNITS.join("|")}}`);
    else if (d.expiry != null && !["turn-start", "turn-end"].includes(d.expiry)) err.push(`${path}.duration.expiry: turn-start|turn-end|null`);
    else if (d.of != null && !["origin", "target"].includes(d.of)) err.push(`${path}.duration.of: origin|target`);
    else if (out.condition) out.duration = { value: d.value, unit: d.unit, expiry: d.expiry ?? null, of: d.of ?? "origin" };
  }
  if (a.effect != null) {
    if (!isObj(a.effect) || !isStr(a.effect.uuid)) err.push(`${path}.effect.uuid: строка`);
    else out.effect = { uuid: a.effect.uuid };
  }
  if (a.note != null) {
    if (!isStr(a.note)) err.push(`${path}.note: строка`); else out.note = a.note;
  }
  // who — только союзникам/врагам автора (по disposition токенов); mark — метка TokenMark эффекта на вражескую цель из целей;
  // unlessEffect — пропустить, если у получателя уже есть этот эффект (иммунитет вида «Наставление: невосприимчивость 1 ч»)
  if (a.who != null) { if (!["ally", "enemy"].includes(a.who)) err.push(`${path}.who: ally|enemy`); else out.who = a.who; }
  if (a.mark != null) { if (a.mark !== "enemy" || a.effect == null) err.push(`${path}.mark: "enemy", только с effect`); else out.mark = a.mark; }
  if (a.choice != null) { if (!(isStr(a.choice) || isNum(a.choice)) || a.effect == null) err.push(`${path}.choice: значение ChoiceSet, только с effect`); else out.choice = a.choice; }
  if (a.unlessEffect != null) { if (!isStr(a.unlessEffect)) err.push(`${path}.unlessEffect: uuid эффекта`); else out.unlessEffect = a.unlessEffect; }
  return out;
}

function vApplyList(list, path, defTo, err) {
  if (list == null) return [];
  if (!Array.isArray(list)) { err.push(`${path}: ожидается массив`); return []; }
  return list.map((a, i) => vApply(a, `${path}[${i}]`, defTo, err)).filter(Boolean);
}

function vZone(z, path, err) {
  if (!isObj(z)) { err.push(`${path}: объект или null`); return null; }
  const out = { condition: null, effect: null, duration: null, events: null };
  if (z.events != null) err.push(`${path}.events: зарезервировано (только null)`);
  if (z.condition != null) {
    if (!isObj(z.condition) || !isStr(z.condition.slug)) err.push(`${path}.condition.slug: строка`);
    else {
      if (z.condition.value != null && !(isInt(z.condition.value) && z.condition.value >= 1)) err.push(`${path}.condition.value: целое >= 1`);
      out.condition = { slug: z.condition.slug, ...(z.condition.value != null && { value: z.condition.value }) };
    }
  }
  if (z.effect != null) {
    if (!isObj(z.effect) || !isStr(z.effect.uuid)) err.push(`${path}.effect.uuid: строка`);
    else out.effect = { uuid: z.effect.uuid };
  }
  if (!out.condition && !out.effect) err.push(`${path}: нужно condition и/или effect`);
  if (z.duration != null) {
    const d = z.duration;
    if (!isObj(d)) err.push(`${path}.duration: объект или null`);
    else {
      out.duration = {};
      for (const k of ["seconds", "rounds"]) {
        if (d[k] == null) continue;
        if (!(isNum(d[k]) && d[k] > 0)) err.push(`${path}.duration.${k}: число > 0`); else out.duration[k] = d[k];
      }
      if (!Object.keys(out.duration).length) out.duration = null;
    }
  }
  return out;
}

function vChallenge(c, path, err) {
  if (!isObj(c)) { err.push(`${path}: объект или null`); return null; }
  const out = {};
  if (!isStr(c.statistic) || !/^[a-z0-9-]+$/.test(c.statistic)) err.push(`${path}.statistic: slug статистики`);
  out.statistic = c.statistic;
  const d = c.dc;
  if (!isObj(d)) err.push(`${path}.dc: объект`);
  else {
    const keys = ["value", "expr", "source", "against"].filter((k) => d[k] != null);
    if (keys.length !== 1) err.push(`${path}.dc: ровно одно из value/expr/source/against`);
    else {
      const k = keys[0];
      if (k === "value" && !isNum(d.value)) err.push(`${path}.dc.value: число`);
      else if (k === "source" && d.source !== "spell") err.push(`${path}.dc.source: spell`);
      else if ((k === "expr" || k === "against") && !isStr(d[k])) err.push(`${path}.dc.${k}: строка`);
      else out.dc = { [k]: d[k] };
    }
  }
  if (c.basic != null && typeof c.basic !== "boolean") err.push(`${path}.basic: boolean`);
  out.basic = !!c.basic;
  for (const k of ["traits", "options"]) {
    if (c[k] == null) continue;
    if (!Array.isArray(c[k]) || !c[k].every(isStr)) err.push(`${path}.${k}: массив строк`); else out[k] = [...c[k]];
  }
  if (c.rollerRole != null && c.rollerRole !== "target") err.push(`${path}.rollerRole: только target`);
  out.rollerRole = "target";
  out.byDegree = {};
  if (c.byDegree != null) {
    if (!isObj(c.byDegree)) err.push(`${path}.byDegree: объект`);
    else for (const [k, v] of Object.entries(c.byDegree)) {
      if (!DEGREES.includes(k)) { err.push(`${path}.byDegree.${k}: неизвестная степень`); continue; }
      const list = vApplyList(v, `${path}.byDegree.${k}`, "target", err);
      if (list.length) out.byDegree[k] = list;
    }
  }
  return out;
}

const DEFENSES = ["ac", "fortitude", "reflex", "will", "perception"];
const SLUG = /^[a-z0-9-]+$/;
const IMM_UNITS = ["minutes", "hours", "days"];

function vImmunity(im, path, err) {
  if (!isObj(im)) { err.push(`${path}: объект или null`); return null; }
  const out = {};
  if (!isStr(im.slug) || !SLUG.test(im.slug)) err.push(`${path}.slug: slug`); else out.slug = im.slug;
  if (im.uuid != null) { if (!isStr(im.uuid)) err.push(`${path}.uuid: строка`); else out.uuid = im.uuid; }
  if (im.label != null) { if (!isStr(im.label)) err.push(`${path}.label: строка`); else out.label = im.label; }
  if (im.duration != null) {
    const d = im.duration;
    if (!isObj(d) || !(isInt(d.value) && d.value >= 1) || !IMM_UNITS.includes(d.unit)) err.push(`${path}.duration: {value:целое>=1, unit:${IMM_UNITS.join("|")}}`);
    else out.duration = { value: d.value, unit: d.unit };
  }
  if (!out.uuid && !out.duration) err.push(`${path}: нужен uuid эффекта или duration`);
  return out;
}

/** Проверка автора против защиты цели (onUse.check, plan.md §1.1a). */
function vCheck(c, path, err) {
  if (!isObj(c)) { err.push(`${path}: объект или null`); return null; }
  const out = {};
  const stats = Array.isArray(c.statistic) ? c.statistic : [c.statistic];
  if (!stats.length || !stats.every((x) => isStr(x) && SLUG.test(x))) err.push(`${path}.statistic: slug или непустой массив slug`);
  else out.statistic = Array.isArray(c.statistic) ? [...c.statistic] : c.statistic;
  const v = c.vs;
  if (!isObj(v)) err.push(`${path}.vs: объект`);
  else {
    const keys = ["defense", "dc", "against"].filter((k) => v[k] != null);
    if (keys.length !== 1) err.push(`${path}.vs: ровно одно из defense/dc/against`);
    else {
      const k = keys[0];
      if (k === "defense" && !DEFENSES.includes(v.defense)) err.push(`${path}.vs.defense: ${DEFENSES.join("|")}`);
      else if (k === "dc" && !(isNum(v.dc) && v.dc > 0)) err.push(`${path}.vs.dc: число > 0`);
      else if (k === "against" && !(isStr(v.against) && SLUG.test(v.against))) err.push(`${path}.vs.against: slug статистики цели`);
      else out.vs = { [k]: v[k] };
    }
  }
  for (const k of ["traits", "options"]) {
    if (c[k] == null) continue;
    if (!Array.isArray(c[k]) || !c[k].every(isStr)) err.push(`${path}.${k}: массив строк`); else out[k] = [...c[k]];
  }
  if (c.mapIncreases != null) {
    if (!(isInt(c.mapIncreases) && c.mapIncreases >= 0 && c.mapIncreases <= 2)) err.push(`${path}.mapIncreases: 0..2`); else out.mapIncreases = c.mapIncreases;
  }
  if (c.immunity != null) { const im = vImmunity(c.immunity, `${path}.immunity`, err); if (im) out.immunity = im; }
  // roll:"system" — модуль сам не бросает (напр. атака заклинанием с карточки): степень берётся из броска pf2e (actions.mjs)
  if (c.roll != null) { if (c.roll !== "system") err.push(`${path}.roll: "system"`); else out.roll = "system"; }
  out.rollerRole = "author";
  out.byDegree = {};
  if (c.byDegree != null) {
    if (!isObj(c.byDegree)) err.push(`${path}.byDegree: объект`);
    else for (const [k, v2] of Object.entries(c.byDegree)) {
      if (!DEGREES.includes(k)) { err.push(`${path}.byDegree.${k}: неизвестная степень`); continue; }
      const list = vApplyList(v2, `${path}.byDegree.${k}`, "target", err);
      if (list.length) out.byDegree[k] = list;
    }
  }
  return out;
}

function vOnUse(u, err) {
  if (!isObj(u)) { err.push("onUse: объект или null"); return null; }
  const out = { targets: u.targets };
  if (!TARGETS.includes(u.targets)) err.push("onUse.targets: self|selected|area");
  if (u.excludeSelf != null && typeof u.excludeSelf !== "boolean") err.push("onUse.excludeSelf: boolean|null");
  out.excludeSelf = u.excludeSelf ?? null;
  out.zone = null;
  if (u.zone != null) {
    if (u.targets !== "area") err.push("onUse.zone: только при targets:\"area\"");
    out.zone = vZone(u.zone, "onUse.zone", err);
  }
  out.challenge = u.challenge != null ? vChallenge(u.challenge, "onUse.challenge", err) : null;
  out.check = null;
  if (u.check != null) {
    if (u.challenge != null) err.push("onUse.check и onUse.challenge взаимоисключающи");
    if (u.targets === "self") err.push("onUse.check: нужен targets selected|area");
    out.check = vCheck(u.check, "onUse.check", err);
  }
  out.apply = vApplyList(u.apply, "onUse.apply", "self", err);
  return out;
}

function vReaction(r, err) {
  if (!isObj(r)) { err.push("onAttacked: объект или null"); return null; }
  const out = { trigger: r.trigger };
  if (r.trigger !== "attack-on-self") err.push("onAttacked.trigger: attack-on-self");
  const b = r.bonus;
  if (!isObj(b) || b.stat !== "ac" || !isStr(b.type) || !isNum(b.value)) err.push("onAttacked.bonus: {stat:\"ac\", type, value}");
  else out.bonus = { stat: "ac", type: b.type, value: b.value };
  if (r.cost != null && r.cost !== "reaction") err.push("onAttacked.cost: reaction");
  out.cost = "reaction";
  if (r.notify != null && !(Array.isArray(r.notify) && r.notify.every((n) => NOTIFY.includes(n)))) err.push("onAttacked.notify: owner|gm");
  out.notify = Array.isArray(r.notify) ? [...r.notify] : ["owner", "gm"];
  return out;
}

function vMacros(list, err) {
  if (list == null) return [];
  if (!Array.isArray(list)) { err.push("macros: массив"); return []; }
  return list.flatMap((m, i) => {
    const p = `macros[${i}]`;
    if (!isObj(m) || !(isStr(m.uuid) || isStr(m.builtin))) { err.push(`${p}.uuid|builtin: строка`); return []; }
    if (!PHASES.includes(m.phase)) { err.push(`${p}.phase: ${PHASES.join("|")}`); return []; }
    const out = { phase: m.phase, ...(isStr(m.builtin) ? { builtin: m.builtin } : { uuid: m.uuid }) };
    if (m.degree != null) {
      if (m.phase !== "onDegree") err.push(`${p}.degree: только для phase:"onDegree"`);
      else if (!DEGREES.includes(m.degree)) err.push(`${p}.degree: неизвестная степень`);
      else out.degree = m.degree;
    }
    return [out];
  });
}

/** raw -> { ok, rule (нормализованное, с дефолтами), errors[] }. source/confidence в правило не попадают. */
export function validateRule(raw) {
  const err = [];
  if (!isObj(raw)) return { ok: false, rule: null, errors: ["правило: ожидается объект"] };
  if (raw.v !== RULE_VERSION) err.push(`v: ожидается ${RULE_VERSION}`);
  if (raw.yield != null && typeof raw.yield !== "boolean") err.push("yield: boolean|null");
  if (raw.label != null && typeof raw.label !== "string") err.push("label: строка");
  if (raw.onTurn != null) err.push("onTurn: зарезервировано (только null)");
  if (raw.onUse != null && raw.onAttacked != null) err.push("onUse и onAttacked взаимоисключающи");
  const rule = {
    v: RULE_VERSION,
    ...(typeof raw.label === "string" && { label: raw.label }),
    yield: typeof raw.yield === "boolean" ? raw.yield : null,
    onUse: raw.onUse != null ? vOnUse(raw.onUse, err) : null,
    onAttacked: raw.onAttacked != null ? vReaction(raw.onAttacked, err) : null,
    macros: vMacros(raw.macros, err),
    onTurn: null
  };
  if (!rule.onUse && !rule.onAttacked && !rule.macros.length && !err.length) err.push("правило пусто: нужно onUse, onAttacked или macros");
  return err.length ? { ok: false, rule: null, errors: err } : { ok: true, rule, errors: [] };
}

export const normalizeRule = (raw) => validateRule(raw).rule;

/* ---------- Slug / источник (§1.5) ---------- */

function liveItem(origin, item) {
  if (item) return item;
  if (origin?.uuid && typeof fromUuidSync === "function") {
    try { return fromUuidSync(origin.uuid) ?? null; } catch { /* предмета нет (расходник удалён) */ }
  }
  return null;
}

export function slugOf(origin, item = null) {
  if (isStr(origin?.slug)) return origin.slug;
  const it = liveItem(origin, item);
  const s = it?.slug ?? it?.system?.slug;
  if (isStr(s)) return s;
  const opt = (origin?.rollOptions ?? []).find((o) => typeof o === "string" && o.startsWith("origin:item:slug:"));
  if (opt) return opt.slice("origin:item:slug:".length);
  const orig = it?.flags?.babele?.originalName;
  return isStr(orig) ? sluggify(orig) : null;
}

export function sourceOf(origin, item = null) {
  const it = liveItem(origin, item);
  const s = it?._stats?.compendiumSource ?? it?.flags?.core?.sourceId ?? origin?.sourceId;
  return isStr(s) ? s : null;
}

/* ---------- Вывод из разметки (§1.3), синхронно ---------- */

// valued-состояния pf2e (значение берётся из подписи; у остальных value не ставится)
const VALUED = new Set(["clumsy", "doomed", "drained", "dying", "enfeebled", "frightened", "sickened", "slowed", "stunned", "stupefied", "wounded"]);
const SAVES = ["fortitude", "reflex", "will"];
const EFFECT_UUID = /^Compendium\.[^.]+\.[a-z0-9-]*effects[a-z0-9-]*\.Item\./i;
const COND_UUID = /^Compendium\.[^.]+\.conditionitems\.Item\./;
const AFTER_NUM = /^\s*(\d+)(?!\s*(?:раунд|минут|час|дн|сек|фут|round|minute|hour|day|sec|feet|ft))/i;

const normLabel = (s) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/[:：]\s*$/, "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

function labelMap(labels) {
  const m = new Map();
  for (const lang of Object.values(labels ?? {})) {
    if (!isObj(lang)) continue;
    for (const [deg, list] of Object.entries(lang)) if (DEGREES.includes(deg)) for (const l of list) m.set(normLabel(l), deg);
  }
  return m;
}

/** Параметры @Check[...] как у pf2e (pf2e:18895): type, key:value, флаги. */
export function parseCheck(inner) {
  const out = { type: null, flags: new Set(), params: {} };
  for (const tok of inner.split("|").map((t) => t.trim()).filter(Boolean)) {
    const i = tok.indexOf(":");
    if (i < 0) { if (out.type === null) out.type = tok; else out.flags.add(tok); continue; }
    out.params[tok.slice(0, i)] = tok.slice(i + 1);
  }
  out.type ??= out.params.type ?? null;
  return out;
}

function parseBlocks(html, map) {
  const markers = [];
  for (const m of html.matchAll(/<(strong|b)\b[^>]*>([\s\S]{1,60}?)<\/\1>/gi)) {
    const degree = map.get(normLabel(m[2]));
    if (degree) markers.push({ degree, start: m.index, end: m.index + m[0].length });
  }
  const blocks = {};
  markers.forEach((mk, i) => {
    const rest = html.slice(mk.end);
    const stop = rest.search(/<hr|<\/p>|<\/li>|<br/i);
    let end = stop < 0 ? html.length : mk.end + stop;
    if (markers[i + 1] && markers[i + 1].start < end) end = markers[i + 1].start;
    blocks[mk.degree] = (blocks[mk.degree] ?? "") + html.slice(mk.end, end);
  });
  return { blocks, markers };
}

function stripBlocks(html, markers) {
  // описание без блоков степеней — для разбора «вне блоков»
  let out = "", pos = 0;
  for (const mk of markers) {
    out += html.slice(pos, mk.start);
    const rest = html.slice(mk.end);
    const stop = rest.search(/<hr|<\/p>|<\/li>|<br/i);
    pos = stop < 0 ? html.length : mk.end + stop;
  }
  return out + html.slice(pos);
}

function linksOf(html, condSlug, hints) {
  const conds = [], effects = [];
  for (const m of html.matchAll(/@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g)) {
    const [, uuid, label = ""] = m;
    const slug = condSlug(uuid);
    if (slug) {
      let value = null;
      if (VALUED.has(slug)) {
        const inLabel = [...label.matchAll(/\d+/g)].pop();
        const after = AFTER_NUM.exec(html.slice(m.index + m[0].length));
        value = inLabel ? +inLabel[0] : after ? +after[1] : 1;
      }
      const prev = conds.find((c) => c.slug === slug);
      if (!prev) conds.push({ slug, value });
      else if (value > prev.value) prev.value = value;
    } else if (COND_UUID.test(uuid)) hints.unresolved.push(uuid);
    else if (EFFECT_UUID.test(uuid) && !effects.includes(uuid)) effects.push(uuid);
  }
  return { conds, effects };
}

// Состояния восприятия и off-guard в блоке степени обычно относятся к агенту/атакам, а не к цели -> только подсказка (K7 п.10).
const NOT_ON_TARGET = new Set(["concealed", "hidden", "undetected", "unnoticed", "invisible", "observed", "off-guard"]);
const IMMUNITY = /иммун|immun/i;
const condApply = (c, to) => ({ to, condition: { slug: c.slug, ...(c.value != null && { value: c.value }), policy: "max" } });

/**
 * itemLike = { type, slug, name?, system:{description:{value}, defense, area, target, selfEffect} }
 * labels = rules/labels.json; conditionSlugByUuid = (uuid) => slug|null.
 * Ветки взаимоисключающи, confidence — у правила целиком (см. README/отчёт).
 */
export function deriveFromMarkup(itemLike, labels, conditionSlugByUuid) {
  const html = itemLike?.system?.description?.value;
  if (!isStr(html)) return null;
  const sys = itemLike.system;
  const type = itemLike.type;
  const hints = { inflicts: [], conditions: [], effects: [], unresolved: [], excluded: [], template: false };
  const condSlug = (u) => conditionSlugByUuid?.(u) || null;

  const { blocks, markers } = parseBlocks(html, labelMap(labels));
  const outside = stripBlocks(html, markers);
  const hasTemplate = /@Template\[/.test(html);
  hints.template = hasTemplate;
  const area = hasTemplate || (type === "spell" && !!sys.area);

  // @Check: первое испытание-спасбросок
  let check = null;
  for (const m of html.matchAll(/@Check\[([^\]]*)\]/g)) {
    const c = parseCheck(m[1]);
    for (const i of (c.params.options ?? "").split(",")) if (i.startsWith("inflicts:")) hints.inflicts.push(i.slice(9));
    const t = (c.type ?? "").split(",")[0];
    if (!check && SAVES.includes(t)) check = { ...c, type: t };
  }
  const save = sys.defense?.save;

  const outLinks = linksOf(outside, condSlug, hints);
  hints.conditions = outLinks.conds.map((c) => c.slug);
  hints.effects = outLinks.effects;

  const mk = (onUse, confidence) => {
    const v = validateRule({ v: RULE_VERSION, ...(itemLike.name && { label: itemLike.name }), onUse });
    return v.ok ? { rule: v.rule, confidence, hints } : null;
  };
  const targetsOf = () => (area ? "area" : "selected");

  // A. испытание (defense.save либо @Check-спасбросок)
  if (save?.statistic || check) {
    let dc;
    const cdc = check?.params.dc;
    if (save?.statistic) dc = { source: "spell" };
    else if (cdc != null && /^-?\d+$/.test(cdc)) dc = { value: +cdc };
    else if (cdc != null) dc = { expr: cdc };
    else if (check.params.against) dc = { against: check.params.against };
    else dc = { expr: "markup" };
    const challenge = {
      statistic: save?.statistic ?? check.type, dc, basic: !!(save ? save.basic : (check.flags.has("basic") || check.params.basic === "true")),
      rollerRole: "target", byDegree: {}
    };
    const opts = (check?.params.options ?? "").split(",").filter((o) => o && !o.startsWith("inflicts:"));
    if (check?.params.traits) challenge.traits = check.params.traits.split(",");
    if (opts.length) challenge.options = opts;
    for (const [deg, text] of Object.entries(blocks)) {
      const { conds, effects } = linksOf(text, condSlug, hints);
      for (const c of conds) if (NOT_ON_TARGET.has(c.slug)) hints.excluded.push(`${deg}:${c.slug}`);
      const list = [...conds.filter((c) => !NOT_ON_TARGET.has(c.slug)).map((c) => condApply(c, "target")), ...effects.map((uuid) => ({ to: "target", effect: { uuid } }))];
      if (list.length) challenge.byDegree[deg] = list;
    }
    return mk({ targets: targetsOf(), excludeSelf: null, zone: null, challenge, apply: [] }, "high");
  }

  // пассивные черты/действия ничего не «используют»: догадки B1/B4 для них ложны (K7)
  const passive = (type === "action" || type === "feat") && sys.actionType?.value === "passive";

  // B1. область + состояние вне блоков — кандидат в зону (low)
  // off-guard вне блока — условный эффект («для пугала на 1 раунд»), не зона
  const zoneConds = outLinks.conds.filter((c) => c.slug !== "off-guard");
  if (!passive && area && zoneConds.length) {
    return mk({ targets: "area", excludeSelf: null, zone: { condition: { slug: zoneConds[0].slug }, effect: null, duration: null }, challenge: null, apply: [] }, "low");
  }
  // B2. заклинание: эффект на выбранные цели (high)
  const targetText = typeof sys.target === "string" ? sys.target : sys.target?.value;
  if (type === "spell" && outLinks.effects.length && (isStr(targetText) || area)) {
    return mk({ targets: targetsOf(), excludeSelf: null, zone: null, challenge: null, apply: outLinks.effects.map((uuid) => ({ to: "target", effect: { uuid } })) }, "high");
  }
  // B3. расходник: эффект на пьющего (high); яд/боеприпас/масло действуют не на пьющего -> low
  if (type === "consumable" && !hasTemplate && outLinks.effects.length) {
    const notDrunk = (sys.traits?.value ?? []).includes("poison") || ["poison", "ammo", "oil"].includes(sys.category);
    return mk({ targets: "self", excludeSelf: null, zone: null, challenge: null, apply: outLinks.effects.map((uuid) => ({ to: "self", effect: { uuid } })) }, notDrunk ? "low" : "high");
  }
  // B4. действие/черта без selfEffect: на себя или на цель неясно (low); с selfEffect делает система
  if (!passive && (type === "action" || type === "feat") && !sys.selfEffect && outLinks.effects.length) {
    // «иммунитет к …» получает цель, а не автор
    const onTarget = IMMUNITY.test(outside.replace(/<[^>]*>/g, " "));
    const to = onTarget ? "target" : "self";
    return mk({ targets: onTarget ? "selected" : "self", excludeSelf: null, zone: null, challenge: null, apply: outLinks.effects.map((uuid) => ({ to, effect: { uuid } })) }, "low");
  }
  return null;
}

/* ---------- Каталоги (§1.2) ---------- */

let labelsData = null;
let builtin = { bySource: new Map(), bySlug: new Map() };
const warn = (...a) => console.warn(`${MOD} |`, ...a);

/** Чистая сборка индексов из JSON каталогов; невалидные записи пропускаются и попадают в errors. */
export function buildCatalog(jsons) {
  const bySource = new Map(), bySlug = new Map(), byName = new Map(), errors = [];
  for (const j of jsons) {
    for (const [field, map] of [["bySource", bySource], ["bySlug", bySlug], ["byName", byName]]) {
      for (const [key, raw] of Object.entries(j?.[field] ?? {})) {
        const v = validateRule(raw);
        if (v.ok) map.set(key, v.rule); else errors.push(`${field}.${key}: ${v.errors.join("; ")}`);
      }
    }
  }
  return { bySource, bySlug, byName, errors };
}

/** Для тестов и loadCatalog: задать встроенные каталоги и метки степеней. */
export function initCatalog(jsons, labels) {
  const { errors, ...cat } = buildCatalog(jsons);
  builtin = cat;
  labelsData = labels;
  errors.forEach((e) => warn("каталог:", e));
  return errors;
}

export async function loadCatalog() {
  const get = async (name, optional = false) => {
    const resp = await fetch(foundry.utils.getRoute(`modules/${MOD}/rules/${name}`));
    if (!resp.ok) { if (!optional) warn(`не загружен rules/${name}: ${resp.status}`); return null; }
    return resp.json();
  };
  const [cat, campaign, labels] = await Promise.all([get("catalog.json"), get("catalog.campaign.json", true), get("labels.json")]);
  return initCatalog([cat, campaign].filter(Boolean), labels);
}
export const ready = loadCatalog;

let wCache = { raw: null, val: null };
export function worldCatalog() {
  let raw = null;
  try { raw = S.get("catalog"); } catch { /* настройки не зарегистрированы (node) */ }
  if (wCache.raw !== raw || !wCache.val) {
    const { errors, ...val } = buildCatalog([raw ?? {}]);
    errors.forEach((e) => warn("мировой каталог:", e));
    wCache = { raw, val };
  }
  return wCache.val;
}

export async function saveWorldRule(key /* {source?|slug?} */, rule) {
  if (!game.user.isGM) throw new Error("saveWorldRule: только ГМ");
  const field = key.source ? "bySource" : key.slug ? "bySlug" : null;
  if (!field) throw new Error("saveWorldRule: нужен key.source или key.slug");
  const name = key.source ?? key.slug;
  const cur = foundry.utils.deepClone(S.get("catalog") ?? {});
  cur.bySource ??= {}; cur.bySlug ??= {};
  if (rule === null) delete cur[field][name];
  else {
    const v = validateRule(rule);
    if (!v.ok) throw new Error(`saveWorldRule: ${v.errors.join("; ")}`);
    cur[field][name] = v.rule;
  }
  await S.set("catalog", cur);
}

export function itemFlagRule(item) {
  const raw = item?.flags?.[MOD]?.rule;
  if (!raw) return null;
  const v = validateRule(raw);
  if (!v.ok) { warn(`флаг rule у ${item.uuid ?? item.name} невалиден:`, v.errors); return null; }
  return v.rule;
}

/** Правила onAttacked из каталогов (ключ = source uuid | slug) — для reactions. */
export function onAttackedIndex() {
  const out = new Map();
  for (const cat of [builtin, worldCatalog()]) {   // мировой перекрывает встроенный
    for (const m of [cat.bySlug, cat.bySource]) for (const [k, r] of m) {
      if (r.onAttacked) out.set(k, r); else out.delete(k);
    }
  }
  return out;
}

/** Порядок §1.2: флаг -> world.bySource -> world.bySlug -> builtin.bySource -> builtin.bySlug -> разметка. */
export function resolveRule(source) {
  const origin = source?.origin ?? null;
  const item = liveItem(origin, source?.system ? source : (source?.item ?? null));
  const slug = slugOf(origin, item);
  const sourceUuid = sourceOf(origin, item);
  const found = (rule, src, confidence = "high") => ({ rule, source: src, slug, sourceUuid, confidence });

  const flag = itemFlagRule(item);
  if (flag) return found(flag, "flag");
  const w = worldCatalog();
  const r = (sourceUuid && w.bySource.get(sourceUuid)) || (slug && w.bySlug.get(slug));
  if (r) return found(r, "world");
  // byName — способности NPC без slug и источника (имя предмета как в мире; slug pf2e из имени ненадёжен для кириллицы)
  const named = !sourceUuid && !(item?.system?.slug) ? (item?.name ?? origin?.name ?? null) : null;
  const b = (sourceUuid && builtin.bySource.get(sourceUuid)) || (slug && builtin.bySlug.get(slug)) || (named && builtin.byName?.get(named));
  if (b) return found(b, "catalog");

  if (item?.system && labelsData) {
    const d = deriveFromMarkup(
      { type: item.type, slug, name: item.name, system: item.system }, labelsData,
      (uuid) => game.pf2e.ConditionManager.conditions.get(uuid)?.slug ?? null
    );
    if (d) return found(d.rule, "markup", d.confidence);
  }
  return null;
}
