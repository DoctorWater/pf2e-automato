import { MOD, DEGREES, errText, sluggify } from "./util.mjs";
import { S, rev } from "./settings.mjs";

export const RULE_VERSION = 1;

/* ---------- Валидация / нормализация (чистая, без Foundry) ---------- */

const TARGETS = ["self", "selected", "area"];
const PHASES = ["onUse", "afterChallenge", "onDegree", "zoneEnter", "zoneExit", "onReaction"];
const NOTIFY = ["owner", "gm"];
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x.length > 0;
const isInt = (x) => Number.isInteger(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

const VIS_LEVELS = ["concealed", "hidden", "undetected", "unnoticed"];
const VIS_UNTIL = ["turn-end", "next-turn-end", "attack"];
const APPLY_UNITS = ["rounds", "minutes", "hours", "days"];
// типы урона pf2e (CONFIG.PF2E.damageTypes); apply.mjs перед созданием сверяет с живым CONFIG
export const DAMAGE_TYPES = ["acid", "bleed", "bludgeoning", "cold", "electricity", "fire", "force", "mental", "piercing", "poison", "slashing", "sonic", "spirit", "untyped", "vitality", "void"];
// формула продолжительного урона: кости и числа через +/-, как «1d6», «2d6+3» (глубже проверяет pf2e при создании)
const DICE = /^\d+(?:d\d+)?(?:\s*[+-]\s*\d+(?:d\d+)?)*$/i;
export const isDice = (s) => typeof s === "string" && DICE.test(s.trim());

// переменные pf2e в формуле продолжительного урона: «(@item.rank)d4», «(floor(@item.rank/2))d8»; хранятся как есть, подставляются при применении
export const hasVars = (s) => typeof s === "string" && s.includes("@");

// безопасный вычислитель группы: числа, + - * /, скобки, floor/ceil/round/min/max
function calc(src) {
  const t = src.match(/\d+(?:\.\d+)?|[a-z]+|[-+*/(),]|\S/g) ?? [];
  let i = 0;
  const bad = () => { throw new Error("calc"); };
  const FN = { floor: Math.floor, ceil: Math.ceil, round: Math.round, max: Math.max, min: Math.min };
  const expr = () => { let v = term(); while (t[i] === "+" || t[i] === "-") v = t[i++] === "+" ? v + term() : v - term(); return v; };
  const term = () => { let v = atom(); while (t[i] === "*" || t[i] === "/") v = t[i++] === "*" ? v * atom() : v / atom(); return v; };
  const atom = () => {
    const x = t[i++];
    if (x === "-") return -atom();
    if (x === "(") { const v = expr(); if (t[i++] !== ")") bad(); return v; }
    if (/^\d/.test(x ?? "")) return +x;
    if (Object.hasOwn(FN, x) && t[i++] === "(") { const a = [expr()]; while (t[i] === ",") { i++; a.push(expr()); } if (t[i++] !== ")") bad(); return FN[x](...a); }
    return bad();
  };
  const v = expr();
  if (i !== t.length || !Number.isFinite(v)) bad();
  return v;
}

/**
 * Подставляет @item.rank / @item.level / @actor.level и вычисляет группы в скобках: «(@item.rank)d4» -> «2d4».
 * -> строка или null (неизвестная переменная, группа не считается, отрицательное число).
 */
export function resolveFormula(f, { rank = 1, level = rank, actorLevel = level } = {}) {
  const s = String(f).replace(/\s+/g, "").replace(/@item\.rank(?![\w.])/g, rank).replace(/@item\.level(?![\w.])/g, level).replace(/@actor\.level(?![\w.])/g, actorLevel);
  if (s.includes("@")) return null;
  try {
    let out = "";
    for (let i = 0; i < s.length;) {
      if (s[i] !== "(") { out += s[i++]; continue; }
      let depth = 0, j = i;
      do { depth += s[j] === "(" ? 1 : s[j] === ")" ? -1 : 0; j++; } while (depth && j < s.length);
      if (depth) return null;
      const v = calc(s.slice(i + 1, j - 1));
      if (v < 0) return null;
      out += Math.floor(v);
      i = j;
    }
    return out;
  } catch { return null; }
}
/** Формула после подстановки равна нулю («0», «0d8»): шага нет (Oil Fire на 1 уровне: floor(1/2)). */
export const isZeroFormula = (s) => typeof s === "string" && /^0(?:d\d+)?$/i.test(s.trim());
/** Формула продолжительного урона: кубы, либо кубы с переменными pf2e (проверка при rank = level = 1). */
export const isPersFormula = (s) => isDice(s) || (hasVars(s) && isDice(resolveFormula(s)));
// шаг, если формула ненулевая хоть на каком-то уровне/ранге (floor(rank/2) на 1 — ноль, применение пропустит); константа «0» — не шаг
const isPersStep = (s) => isPersFormula(s) && (!hasVars(s) ? !isZeroFormula(s) : Array.from({ length: 20 }, (_, i) => resolveFormula(s, { rank: i + 1 })).some((f) => f && !isZeroFormula(f)));

/** Ошибка валидатора: key -> PF2E_AUTOMATO.rules.err.<key>, data -> подстановки ({path}, ...); текст получает потребитель (errText в util.mjs). */
const E = (key, path, more) => ({ key, data: { path, ...more }, toString() { return `${key} (${path})`; } });

function vApply(a, path, defTo, err) {
  if (!isObj(a)) { err.push(E("notObj", path)); return null; }
  const out = { to: a.to ?? defTo };
  if (!["self", "target"].includes(out.to)) err.push(E("apply.to", `${path}.to`));
  const kinds = ["condition", "effect", "note", "visibility", "persistent"].filter((k) => a[k] != null);
  if (kinds.length !== 1) err.push(E("apply.kind", path));
  if (a.condition != null) {
    const c = a.condition;
    if (!isObj(c) || !isStr(c.slug)) err.push(E("cond.slug", `${path}.condition.slug`));
    else {
      if (c.value != null && !(isInt(c.value) && c.value >= 1)) err.push(E("cond.value", `${path}.condition.value`));
      if (c.policy != null && !["max", "add"].includes(c.policy)) err.push(E("cond.policy", `${path}.condition.policy`));
      out.condition = { slug: c.slug, ...(c.value != null && { value: c.value }), policy: c.policy ?? "max" };
    }
  }
  if (a.duration != null) {
    const d = a.duration;
    if (a.condition == null) err.push(E("dur.needCond", `${path}.duration`));
    else if (!isObj(d) || !(isInt(d.value) && (d.value >= 1 || (d.value === 0 && d.expiry === "turn-end"))) || !APPLY_UNITS.includes(d.unit)) err.push(E("dur.bad", `${path}.duration`));
    else if (d.expiry != null && !["turn-start", "turn-end"].includes(d.expiry)) err.push(E("dur.expiry", `${path}.duration.expiry`));
    else if (d.of != null && !["origin", "target"].includes(d.of)) err.push(E("dur.of", `${path}.duration.of`));
    else if (out.condition) out.duration = { value: d.value, unit: d.unit, expiry: d.expiry ?? null, of: d.of ?? "origin" };
  }
  if (a.effect != null) {
    if (!isObj(a.effect) || !isStr(a.effect.uuid)) err.push(E("effect.uuid", `${path}.effect.uuid`));
    else out.effect = { uuid: a.effect.uuid };
  }
  if (a.note != null) {
    if (!isStr(a.note)) err.push(E("note.text", `${path}.note`)); else out.note = a.note;
  }
  if (a.visibility != null) {
    const v = a.visibility;
    if (!isObj(v) || !VIS_LEVELS.includes(v.level) || !["self", "target"].includes(v.of)) err.push(E("vis.bad", `${path}.visibility`));
    else if (v.of === out.to) err.push(E("vis.same", `${path}.visibility.of`));
    else if (v.until != null && !(Array.isArray(v.until) && v.until.every((u) => VIS_UNTIL.includes(u)))) err.push(E("vis.until", `${path}.visibility.until`));
    else out.visibility = { level: v.level, of: v.of, ...(v.until?.length && { until: [...new Set(v.until)] }) };
  }
  if (a.persistent != null) {
    const p = a.persistent;
    if (!isObj(p) || !isPersFormula(p.formula)) err.push(E("pers.formula", `${path}.persistent.formula`));
    else if (!DAMAGE_TYPES.includes(p.damageType)) err.push(E("pers.type", `${path}.persistent.damageType`));
    else if (p.dc != null && !(isInt(p.dc) && p.dc >= 1)) err.push(E("pers.dc", `${path}.persistent.dc`));
    else out.persistent = { formula: p.formula.trim().replace(/\s+/g, ""), damageType: p.damageType, ...(p.dc != null && { dc: p.dc }) };
  }
  // who — только союзникам/врагам автора (по disposition токенов); mark — метка TokenMark эффекта на вражескую цель из целей;
  // unlessEffect — пропустить, если у получателя уже есть этот эффект (иммунитет вида «Наставление: невосприимчивость 1 ч»)
  if (a.who != null) { if (!["ally", "enemy"].includes(a.who)) err.push(E("apply.who", `${path}.who`)); else out.who = a.who; }
  if (a.mark != null) { if (a.mark !== "enemy" || a.effect == null) err.push(E("apply.mark", `${path}.mark`)); else out.mark = a.mark; }
  if (a.choice != null) { if (!(isStr(a.choice) || isNum(a.choice)) || a.effect == null) err.push(E("apply.choice", `${path}.choice`)); else out.choice = a.choice; }
  if (a.unlessEffect != null) { if (!isStr(a.unlessEffect)) err.push(E("apply.unless", `${path}.unlessEffect`)); else out.unlessEffect = a.unlessEffect; }
  return out;
}

function vApplyList(list, path, defTo, err) {
  if (list == null) return [];
  if (!Array.isArray(list)) { err.push(E("notArr", path)); return []; }
  return list.map((a, i) => vApply(a, `${path}[${i}]`, defTo, err)).filter(Boolean);
}

function vZone(z, path, err) {
  if (!isObj(z)) { err.push(E("notObj", path)); return null; }
  const out = { condition: null, effect: null, duration: null, events: null };
  if (z.events != null) err.push(E("zone.events", `${path}.events`));
  if (z.condition != null) {
    if (!isObj(z.condition) || !isStr(z.condition.slug)) err.push(E("cond.slug", `${path}.condition.slug`));
    else {
      if (z.condition.value != null && !(isInt(z.condition.value) && z.condition.value >= 1)) err.push(E("cond.value", `${path}.condition.value`));
      out.condition = { slug: z.condition.slug, ...(z.condition.value != null && { value: z.condition.value }) };
    }
  }
  if (z.effect != null) {
    if (!isObj(z.effect) || !isStr(z.effect.uuid)) err.push(E("effect.uuid", `${path}.effect.uuid`));
    else out.effect = { uuid: z.effect.uuid };
  }
  if (!out.condition && !out.effect) err.push(E("zone.empty", path));
  if (z.duration != null) {
    const d = z.duration;
    if (!isObj(d)) err.push(E("zone.durObj", `${path}.duration`));
    else {
      out.duration = {};
      for (const k of ["seconds", "rounds"]) {
        if (d[k] == null) continue;
        if (!(isNum(d[k]) && d[k] > 0)) err.push(E("zone.durNum", `${path}.duration.${k}`)); else out.duration[k] = d[k];
      }
      if (!Object.keys(out.duration).length) out.duration = null;
    }
  }
  return out;
}

function vChallenge(c, path, err) {
  if (!isObj(c)) { err.push(E("notObj", path)); return null; }
  const out = {};
  if (!isStr(c.statistic) || !/^[a-z0-9-]+$/.test(c.statistic)) err.push(E("ch.stat", `${path}.statistic`));
  out.statistic = c.statistic;
  const d = c.dc;
  if (!isObj(d)) err.push(E("dc.none", `${path}.dc`));
  else {
    const keys = ["value", "expr", "source", "against"].filter((k) => d[k] != null);
    if (keys.length !== 1) err.push(E(keys.length ? "dc.many" : "dc.none", `${path}.dc`));
    else {
      const k = keys[0];
      if (k === "value" && !isNum(d.value)) err.push(E("dc.value", `${path}.dc.value`));
      else if (k === "source" && d.source !== "spell") err.push(E("dc.source", `${path}.dc.source`));
      else if ((k === "expr" || k === "against") && !isStr(d[k])) err.push(E("dc.str", `${path}.dc.${k}`));
      else out.dc = { [k]: d[k] };
    }
  }
  if (c.basic != null && typeof c.basic !== "boolean") err.push(E("ch.basic", `${path}.basic`));
  out.basic = !!c.basic;
  for (const k of ["traits", "options"]) {
    if (c[k] == null) continue;
    if (!Array.isArray(c[k]) || !c[k].every(isStr)) err.push(E("strList", `${path}.${k}`)); else out[k] = [...c[k]];
  }
  if (c.rollerRole != null && c.rollerRole !== "target") err.push(E("ch.roller", `${path}.rollerRole`));
  out.rollerRole = "target";
  out.byDegree = {};
  if (c.byDegree != null) {
    if (!isObj(c.byDegree)) err.push(E("degrees.obj", `${path}.byDegree`));
    else for (const [k, v] of Object.entries(c.byDegree)) {
      if (!DEGREES.includes(k)) { err.push(E("degrees.unknown", `${path}.byDegree.${k}`, { k })); continue; }
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
  if (!isObj(im)) { err.push(E("notObj", path)); return null; }
  const out = {};
  if (!isStr(im.slug) || !SLUG.test(im.slug)) err.push(E("imm.slug", `${path}.slug`)); else out.slug = im.slug;
  if (im.uuid != null) { if (!isStr(im.uuid)) err.push(E("imm.uuid", `${path}.uuid`)); else out.uuid = im.uuid; }
  if (im.label != null) { if (!isStr(im.label)) err.push(E("imm.label", `${path}.label`)); else out.label = im.label; }
  if (im.duration != null) {
    const d = im.duration;
    if (!isObj(d) || !(isInt(d.value) && d.value >= 1) || !IMM_UNITS.includes(d.unit)) err.push(E("imm.dur", `${path}.duration`));
    else out.duration = { value: d.value, unit: d.unit };
  }
  if (!out.uuid && !out.duration) err.push(E("imm.empty", path));
  return out;
}

/** Проверка автора против защиты цели (onUse.check, plan.md §1.1a). */
function vCheck(c, path, err) {
  if (!isObj(c)) { err.push(E("notObj", path)); return null; }
  const out = {};
  const stats = Array.isArray(c.statistic) ? c.statistic : [c.statistic];
  if (!stats.length || !stats.every((x) => isStr(x) && SLUG.test(x))) err.push(E("chk.stat", `${path}.statistic`));
  else out.statistic = Array.isArray(c.statistic) ? [...c.statistic] : c.statistic;
  const v = c.vs;
  if (!isObj(v)) err.push(E("chk.vsNone", `${path}.vs`));
  else {
    const keys = ["defense", "dc", "against"].filter((k) => v[k] != null);
    if (keys.length !== 1) err.push(E(keys.length ? "chk.vsMany" : "chk.vsNone", `${path}.vs`));
    else {
      const k = keys[0];
      if (k === "defense" && !DEFENSES.includes(v.defense)) err.push(E("chk.defense", `${path}.vs.defense`));
      else if (k === "dc" && !(isNum(v.dc) && v.dc > 0)) err.push(E("chk.dc", `${path}.vs.dc`));
      else if (k === "against" && !(isStr(v.against) && SLUG.test(v.against))) err.push(E("chk.against", `${path}.vs.against`));
      else out.vs = { [k]: v[k] };
    }
  }
  for (const k of ["traits", "options"]) {
    if (c[k] == null) continue;
    if (!Array.isArray(c[k]) || !c[k].every(isStr)) err.push(E("strList", `${path}.${k}`)); else out[k] = [...c[k]];
  }
  if (c.mapIncreases != null) {
    if (!(isInt(c.mapIncreases) && c.mapIncreases >= 0 && c.mapIncreases <= 2)) err.push(E("chk.map", `${path}.mapIncreases`)); else out.mapIncreases = c.mapIncreases;
  }
  if (c.immunity != null) { const im = vImmunity(c.immunity, `${path}.immunity`, err); if (im) out.immunity = im; }
  // roll:"system" — модуль сам не бросает (напр. атака заклинанием с карточки): степень берётся из броска pf2e (actions.mjs)
  if (c.roll != null) { if (c.roll !== "system") err.push(E("chk.roll", `${path}.roll`)); else out.roll = "system"; }
  out.rollerRole = "author";
  out.byDegree = {};
  if (c.byDegree != null) {
    if (!isObj(c.byDegree)) err.push(E("degrees.obj", `${path}.byDegree`));
    else for (const [k, v2] of Object.entries(c.byDegree)) {
      if (!DEGREES.includes(k)) { err.push(E("degrees.unknown", `${path}.byDegree.${k}`, { k })); continue; }
      const list = vApplyList(v2, `${path}.byDegree.${k}`, "target", err);
      if (list.length) out.byDegree[k] = list;
    }
  }
  return out;
}

function vOnUse(u, err) {
  if (!isObj(u)) { err.push(E("notObj", "onUse")); return null; }
  const out = { targets: u.targets };
  if (!TARGETS.includes(u.targets)) err.push(E("use.targets", "onUse.targets"));
  if (u.excludeSelf != null && typeof u.excludeSelf !== "boolean") err.push(E("use.excludeSelf", "onUse.excludeSelf"));
  out.excludeSelf = u.excludeSelf ?? null;
  out.zone = null;
  if (u.zone != null) {
    if (u.targets !== "area") err.push(E("zone.onlyArea", "onUse.zone"));
    out.zone = vZone(u.zone, "onUse.zone", err);
  }
  out.challenge = u.challenge != null ? vChallenge(u.challenge, "onUse.challenge", err) : null;
  out.check = null;
  if (u.check != null) {
    if (u.challenge != null) err.push(E("use.both", "onUse.check"));
    if (u.targets === "self") err.push(E("use.checkSelf", "onUse.check"));
    out.check = vCheck(u.check, "onUse.check", err);
  }
  out.apply = vApplyList(u.apply, "onUse.apply", "self", err);
  // self-шаги onUse.apply идут без цели: наблюдатель-автор не видит субъекта-«цель»
  out.apply.forEach((a, i) => { if (a.visibility && a.to === "self") err.push(E("vis.selfNoTarget", `onUse.apply[${i}].visibility`)); });
  return out;
}

function vReaction(r, err) {
  if (!isObj(r)) { err.push(E("notObj", "onAttacked")); return null; }
  const out = { trigger: r.trigger };
  if (r.trigger !== "attack-on-self") err.push(E("react.trigger", "onAttacked.trigger"));
  const b = r.bonus;
  if (!isObj(b) || b.stat !== "ac" || !isStr(b.type) || !isNum(b.value)) err.push(E("react.bonus", "onAttacked.bonus"));
  else out.bonus = { stat: "ac", type: b.type, value: b.value };
  if (r.cost != null && r.cost !== "reaction") err.push(E("react.cost", "onAttacked.cost"));
  out.cost = "reaction";
  if (r.notify != null && !(Array.isArray(r.notify) && r.notify.every((n) => NOTIFY.includes(n)))) err.push(E("react.notify", "onAttacked.notify"));
  out.notify = Array.isArray(r.notify) ? [...r.notify] : ["owner", "gm"];
  return out;
}

function vMacros(list, err) {
  if (list == null) return [];
  if (!Array.isArray(list)) { err.push(E("notArr", "macros")); return []; }
  return list.flatMap((m, i) => {
    const p = `macros[${i}]`;
    if (!isObj(m) || !(isStr(m.uuid) || isStr(m.builtin))) { err.push(E("macro.id", p)); return []; }
    if (!PHASES.includes(m.phase)) { err.push(E("macro.phase", `${p}.phase`)); return []; }
    const out = { phase: m.phase, ...(isStr(m.builtin) ? { builtin: m.builtin } : { uuid: m.uuid }) };
    if (m.degree != null) {
      if (m.phase !== "onDegree") err.push(E("macro.degreeOnly", `${p}.degree`));
      else if (!DEGREES.includes(m.degree)) err.push(E("degrees.unknown", `${p}.degree`, { k: m.degree }));
      else out.degree = m.degree;
    }
    return [out];
  });
}

/** raw -> { ok, rule (нормализованное, с дефолтами), errors[] }. source/confidence в правило не попадают. */
export function validateRule(raw) {
  const err = [];
  if (!isObj(raw)) return { ok: false, rule: null, errors: [E("rule.obj", "")] };
  if (raw.v !== RULE_VERSION) err.push(E("rule.version", "v", { v: RULE_VERSION }));
  if (raw.yield != null && typeof raw.yield !== "boolean") err.push(E("rule.yield", "yield"));
  if (raw.label != null && typeof raw.label !== "string") err.push(E("rule.label", "label"));
  if (raw.onTurn != null) err.push(E("rule.onTurn", "onTurn"));
  if (raw.onUse != null && raw.onAttacked != null) err.push(E("rule.both", "onUse"));
  const rule = {
    v: RULE_VERSION,
    ...(typeof raw.label === "string" && { label: raw.label }),
    yield: typeof raw.yield === "boolean" ? raw.yield : null,
    onUse: raw.onUse != null ? vOnUse(raw.onUse, err) : null,
    onAttacked: raw.onAttacked != null ? vReaction(raw.onAttacked, err) : null,
    macros: vMacros(raw.macros, err),
    onTurn: null
  };
  if (!rule.onUse && !rule.onAttacked && !rule.macros.length && !err.length) err.push(E("rule.empty", ""));
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

// конец блока степени: перенос/абзац/элемент списка или таблица (в таблице колонки по степеням и броску, это не продолжение блока)
const BLOCK_STOP = /<hr|<\/p>|<\/li>|<br|<table/i;

function parseBlocks(html, map) {
  const markers = [];
  // закрытая таблица — целиком (в ячейках бывают <p>); незакрытая — до конца абзаца
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>|<table\b[\s\S]*?(?=<\/p>|<hr|$)/gi)].map((t) => [t.index, t.index + t[0].length]);
  for (const m of html.matchAll(/<(strong|b)\b[^>]*>([\s\S]{1,60}?)<\/\1>/gi)) {
    const degree = map.get(normLabel(m[2]));
    // подпись внутри таблицы — заголовок колонки, не блок
    if (degree && !tables.some(([a, b]) => m.index >= a && m.index < b)) markers.push({ degree, start: m.index, end: m.index + m[0].length });
  }
  const blocks = {};
  markers.forEach((mk, i) => {
    const rest = html.slice(mk.end);
    const stop = rest.search(BLOCK_STOP);
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
    const stop = rest.search(BLOCK_STOP);
    pos = stop < 0 ? html.length : mk.end + stop;
  }
  return out + html.slice(pos);
}

function linksOf(html, condSlug, hints) {
  const conds = [], effects = [], timed = [];
  for (const m of html.matchAll(/@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g)) {
    const [, uuid, label = ""] = m;
    const slug = condSlug(uuid);
    if (slug) {
      let value = null, end = m.index + m[0].length;
      if (VALUED.has(slug)) {
        const inLabel = [...label.matchAll(/\d+/g)].pop();
        const after = AFTER_NUM.exec(html.slice(m.index + m[0].length));
        // «шок на 1 раунд»: срок вместо значения — не «stunned 1» (теряет все действия на срок); правилом не выразить
        if (!inLabel && !after && DURATION_ONLY.has(slug) && durNext(html.slice(end))) { if (!timed.includes(slug)) timed.push(slug); continue; }
        value = inLabel ? +inLabel[0] : after ? +after[1] : 1;
        if (!inLabel && after) end += after[0].length;
      }
      const prev = conds.find((c) => c.slug === slug);
      if (!prev) conds.push({ slug, value, at: m.index, end });
      else { prev.at = m.index; prev.end = end; if (value > prev.value) prev.value = value; }
    } else if (COND_UUID.test(uuid)) hints.unresolved.push(uuid);
    else if (EFFECT_UUID.test(uuid) && !effects.includes(uuid)) effects.push(uuid);
  }
  return { conds, effects, timed };
}

// Состояния восприятия и off-guard в блоке степени обычно относятся к агенту/атакам, а не к цели -> только подсказка (K7 п.10).
const NOT_ON_TARGET = new Set(["concealed", "hidden", "undetected", "unnoticed", "invisible", "observed", "off-guard"]);
const IMMUNITY = /иммун|immun/i;
const condApply = (c, to) => ({ to, condition: { slug: c.slug, ...(c.value != null && { value: c.value }), policy: "max" }, ...(c.duration && { duration: c.duration }) });

// Простым текстом не ищем: перечисленные выше, отношения и «продолжительный урон» (ложные совпадения).
const PLAIN_SKIP = new Set([...NOT_ON_TARGET, "persistent-damage", "friendly", "helpful", "hostile", "indifferent", "unfriendly", "malevolence", "cursebound", "broken", "controlled", "unnoticed"]);
const DUR = /(?<!\p{L})(?:в течение|на|for)\s+(\d+)\s*(раунд|минут|час|дн|ден|round|minute|hour|day)/giu;
const NEXT_TURN = /(?<!\p{L})(?:до|until)\s+(?:the\s+)?(начала|конца|start|end)\s+(?:of\s+)?(своего|его|ее|их|вашего|its|their|his|her|your)\s+(?:следующего|next)\s+(?:хода|turn)/giu;
// pf2e допускает «stunned на срок» вместо значения; шагом правила это не выразить: createTimed даёт значение 1 (теряет 1 действие, а не все)
export const DURATION_ONLY = new Set(["stunned"]);
const durNext = (s) => [DUR, NEXT_TURN].some((re) => new RegExp("^\\s*(?:" + re.source + ")", "iu").test(s));
const UNIT_OF = { р: "rounds", r: "rounds", м: "minutes", m: "minutes", ч: "hours", h: "hours", д: "days", d: "days" };
// перед состоянием без смысла «цель получает»: избавление, избегание, иммунитет, отрицание, условие
const STOP = /(?<!\p{L})(?:из(?![\p{L}-])|без|уже|если|не|ни|избег\p{L}*|избав\p{L}*|тер(?:я|ет|ял)\p{L}*|утрач\p{L}*|высвобо\p{L}*|снима\p{L}*|снят\p{L}*|прекращ\p{L}*|иммун\p{L}*|невосприимч\p{L}*|no longer|not|can't|can’t|cannot|immune|if|unless|removes?|removed|free from|recovers? from)(?![\p{L}])|(?<!\p{L})от\s+(?:\p{L}+\s+)?$|(?<!\p{L})ends?(?![\p{L}])(?!\s+of\b)/iu;
// получатель — автор («вы получаете…»), а не цель
const AUTHOR = /(?<!\p{L})(?:вы|вас|вам|вами|you)(?![\p{L}])/iu;
// альтернатива/условие после значения: «испуг 1 вместо испуга 2», «frightened 3 if …»
const ALT = /(?<!\p{L})(?:вместо|instead|if|если|unless)(?![\p{L}])/iu;
const blank = (s) => " ".repeat(s.length);
const normTerm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[\d:.,;()]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Состояния, упомянутые в блоке степени простым текстом («испуг 2», «frightened 2»), и длительность
 * («в течение 1 раунда», «for 1 round», «до начала своего следующего хода»): срок получает только состояние,
 * после которого он стоит вплотную (между ними одни пробелы).
 * Состояние без значения берётся, только если в описании оно есть ссылкой (linkedAll); иначе — в possible.
 * Мутирует conds, возвращает possible (slug[]).
 * ponytail: падежи — отбрасывается последняя буква имени и допускается до 2 букв окончания; без морфологии.
 */
function addPlainConds(text, conds, terms, linkedAll) {
  const flat = text.replace(/@UUID\[[^\]]*\](?:\{[^}]*\})?|<[^>]*>|&nbsp;/g, blank).toLowerCase().replace(/ё/g, "е");
  const bounds = [...flat.matchAll(/[.;!?](?=\s|$)/g)].map((m) => m.index);
  const sentStart = (i) => (bounds.filter((b) => b < i).pop() ?? -1) + 1;
  const sentEnd = (i) => bounds.find((b) => b >= i) ?? flat.length;
  const linked = new Set(conds.map((c) => c.slug));
  const possible = [];
  for (const [term, slug] of terms) {
    if (linked.has(slug)) continue;
    const stem = (term.length >= 5 ? term.slice(0, -1) : term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(?<![\\p{L}])" + stem + (term.length >= 4 ? "\\p{L}{0,2}" : "") + "(?![\\p{L}])", "gu");   // 3 буквы («шок») — только точное слово
    for (const m of flat.matchAll(re)) {
      const before = flat.slice(Math.max(sentStart(m.index), m.index - 40), m.index).split(",").pop();   // фраза до запятой
      if (STOP.test(before) || AUTHOR.test(flat.slice(sentStart(m.index), m.index).split(",").pop())) continue;
      const end = m.index + m[0].length;
      const after = AFTER_NUM.exec(flat.slice(end));
      if (VALUED.has(slug) && !after) {
        if (DURATION_ONLY.has(slug) && durNext(flat.slice(end)) && !possible.includes(slug)) possible.push(slug);
        continue;
      }
      const tail = flat.slice(end + (after?.[0].length ?? 0), Math.min(sentEnd(end), end + 40)).split(",")[0];
      const value = VALUED.has(slug) ? +after[1] : null;
      // «шок 3 (вместо шока 1)»: замена того же состояния меньшим значением — не альтернатива; «испуг 1 вместо испуга 2» — по-прежнему максимум
      const rep = new RegExp("^[\\s(]*(?:вместо|instead of)\\s+" + stem + "\\p{L}{0,3}(?![\\p{L}])\\s*(\\d+)?", "u").exec(tail);
      const isRep = rep && (rep[1] == null || +rep[1] <= value);
      if (ALT.test(isRep ? tail.slice(rep[0].length) : tail)) continue;   // условие после замены («… if undead») по-прежнему отсекает
      if (value == null && !linkedAll.has(slug)) { if (!possible.includes(slug)) possible.push(slug); continue; }
      const prev = conds.find((c) => c.slug === slug);
      if (!prev) conds.push({ slug, value, at: m.index, end: end + (after?.[0].length ?? 0), plain: true });
      else if (value > prev.value) prev.value = value;
    }
  }
  // «A, B или C» / «либо A, либо B»: выбор, не наложение — найденные простым текстом уходят в подсказку (ссылки остаются, как раньше)
  const byAt = [...conds].sort((x, y) => x.at - y.at);
  const OR = /(?<!\p{L})(?:или|либо|or|either)(?!\p{L})/u;
  for (let i = 0, j; i < byAt.length; i = j) {
    let alt = /(?<!\p{L})(?:либо|either)\s*$/u.test(flat.slice(Math.max(0, byAt[i].at - 12), byAt[i].at));
    for (j = i + 1; j < byAt.length; j++) {
      const gap = flat.slice(byAt[j - 1].end, byAt[j].at);
      if (!/^[\s,]*(?:(?:или|либо|or|either|and|и)[\s,]*)?$/u.test(gap)) break;
      alt ||= OR.test(gap);
    }
    if (alt) for (const c of byAt.slice(i, j)) if (c.plain) { conds.splice(conds.indexOf(c), 1); if (!possible.includes(c.slug)) possible.push(c.slug); }
  }
  // срок — только состоянию, после которого он стоит вплотную (между ними одни пробелы)
  const attach = (at, d) => {
    const c = conds.find((c) => c.end <= at && !flat.slice(c.end, at).trim());
    if (c && !c.duration) c.duration = d;
  };
  for (const m of flat.matchAll(DUR)) if (+m[1] >= 1 && UNIT_OF[m[2][0]]) attach(m.index, { value: +m[1], unit: UNIT_OF[m[2][0]] });
  for (const m of flat.matchAll(NEXT_TURN)) {
    attach(m.index, { value: 1, unit: "rounds", expiry: /^(начала|start)/.test(m[1]) ? "turn-start" : "turn-end", of: /^(вашего|your)/.test(m[2]) ? "origin" : "target" });
  }
  conds.sort((a, b) => a.at - b.at);
  return possible;
}

/* ---------- продолжительный урон в блоке степени ---------- */

// основы названий типов урона (ru: «огненного», «урона огнём»; en: slug) -> тип pf2e
const TYPE_STEMS = [["огн", "fire"], ["холод", "cold"], ["кислот", "acid"], ["электр", "electricity"], ["ментал", "mental"], ["яд", "poison"], ["дух", "spirit"], ["жизн", "vitality"], ["пустот", "void"], ["звук", "sonic"], ["сил", "force"], ["негатив", "void"], ["позитив", "vitality"], ["кровотеч", "bleed"],
  ["колющ", "piercing"], ["дроб", "bludgeoning"], ["рубящ", "slashing"], ...DAMAGE_TYPES.filter((x) => x !== "untyped").map((x) => [x.slice(0, 6), x]), ["pierc", "piercing"], ["bludgeon", "bludgeoning"], ["electr", "electricity"]];
const typeOfWord = (w) => TYPE_STEMS.find(([stem]) => w?.startsWith(stem))?.[1] ?? null;
const DICE_SRC = String.raw`\d+(?:[dдк]\d+)?(?:\s*[+-]\s*\d+)?`;
const PERS_RU = new RegExp(String.raw`(${DICE_SRC})\s+продолжительн\p{L}*\s+(?:(\p{L}+)\s+)?урон\p{L}*(?:\s+(?:от\s+)?(\p{L}+))?`, "gu");
const PERS_EN = new RegExp(String.raw`(${DICE_SRC})\s+persistent\s+(\p{L}+)\s+damage`, "gu");
// скобки убираем, если нет переменных: «(2d4)» -> «2d4»; «(@item.rank)d4» остаётся как есть
const diceOf = (s) => s.replace(/[дк]/g, "d").replace(/\s/g, "").replace(/[()]/g, (c) => (s.includes("@") ? c : ""));
// условие вне самого урона: «всякий раз, когда…», «пока остаётся в ауре»; урон предмету
const COND = /(?<!\p{L})(?:всякий раз|каждый раз|пока|whenever|each time|every time|as long as|while)(?![\p{L}])/u;
const RESTRICT = /(?<!\p{L})(?:creatures?|targets?|существ\p{L}*)\s[^.]{0,40}?(?:(?:has|have|with|с)\s[^.]{0,30}?(?:trait|черт\p{L}*|дескриптор\p{L}*))/iu;
const ITEM_DMG = /(?<!\p{L})(?:shoddy|items?|objects?|предмет\p{L}*|объект\p{L}*)(?![\p{L}])/u;

/**
 * Продолжительный урон блока степени: @Damage[1d6[persistent,fire]] и «1d6 продолжительного огненного урона» / «1d6 persistent fire damage».
 * Текст отбирается теми же правилами, что и состояния простым текстом: стоп-слова перед, «вы/you» в начале фразы, «вместо/if/если» после.
 * «или/or» рядом, неизвестный тип и нечисловая формула (@item.rank) — не шаг, а possible=true (подсказка ГМу).
 * -> { steps: [{formula, damageType}], possible }
 */
export function persistentOf(text, { outside = "", html = "" } = {}) {
  const steps = [];
  let possible = false;
  // урон только существам с чертой («Any creature that has the plant trait») — условие вне блоков; тип урона выбирает игрок — тот же дайс с разными типами в описании
  const restricted = RESTRICT.test(outside.replace(/<[^>]*>/g, " "));
  const types = new Map();
  for (const m of html.matchAll(/@Damage\[([^\[\],|]+?)\[([^\]]*)\]/g)) {
    const fl = m[2].split(",").map((x) => x.trim()), ty = fl.find((x) => DAMAGE_TYPES.includes(x));
    if (ty && fl.includes("persistent")) types.set(diceOf(m[1]), new Set([...(types.get(diceOf(m[1])) ?? []), ty]));
  }
  const add = (formula, damageType, dc) => {
    if (restricted || (types.get(formula)?.size ?? 0) > 1 || !isPersStep(formula) || !DAMAGE_TYPES.includes(damageType)) { possible = true; return; }
    if (!steps.some((p) => p.formula === formula && p.damageType === damageType)) steps.push({ formula, damageType, ...(dc && { dc }) });
  };
  // позиции совпадают с text: ссылки, теги и &nbsp; затёрты пробелами той же длины
  const flat = text.replace(/@UUID\[[^\]]*\](?:\{[^}]*\})?|<[^>]*>|&nbsp;/g, blank).replace(/@Damage\[(?:[^\[\]]|\[[^\]]*\])*\](?:\{[^}]*\})?/g, blank).toLowerCase().replace(/ё/g, "е");
  const bounds = [...flat.matchAll(/[.;!?](?=\s|$)/g)].map((m) => m.index);
  const sentStart = (i) => (bounds.filter((b) => b < i).pop() ?? -1) + 1;
  const sentEnd = (i) => bounds.find((b) => b >= i) ?? flat.length;
  // СЛ очистки: «СЛ … 17» / «DC 17» в предложении с упоминанием продолжительного урона
  const dcAt = (i) => {
    const from = flat.lastIndexOf(". ", i) + 1, to = flat.indexOf(". ", i), sent = flat.slice(from, to < 0 ? flat.length : to);   // предложение целиком, без деления по «;»
    return /продолжительн|persistent/.test(sent) ? +/(?<!\p{L})(?:сл|dc)(?![\p{L}:])[^.\d]{0,60}?(\d+)/u.exec(sent)?.[1] || undefined : undefined;
  };
  // true, если упоминание в позиции [i, end) не шаг: стоп-слова/«вы» перед, «вместо/если» и условия после, урон предмету
  // условие, не относящееся к самому урону («as long as they remain in the aura»), но не «as long as it takes this persistent damage»
  const condIn = (s) => { const c = COND.exec(s); return !!c && !/persistent|продолжительн|damage|урон/.test(s.slice(c.index)); };
  // link: у ссылок «вы» — только в начале фразы («You take @Damage»), не «…convinced you know … and takes @Damage»
  const skip = (i, end, link) => {
    const before = flat.slice(Math.max(sentStart(i), i - 40), i).split(",").pop(), prefix = flat.slice(sentStart(i), i);
    const tail = flat.slice(end, Math.min(sentEnd(end), end + 40)).split(",")[0], frag = prefix.split(",").pop();
    return STOP.test(before) || /(?:вместо|instead of)\s*$/u.test(before) || (link ? /^[^\p{L}]*(?:вы|you)(?![\p{L}])/u : AUTHOR).test(frag) || ALT.test(tail)
      || condIn(prefix) || condIn(flat.slice(end, sentEnd(end))) || ITEM_DMG.test(prefix) || ITEM_DMG.test(tail);
  };
  const isOr = (i, end) => /^\s*(?:или|либо|or)(?!\p{L})/u.test(flat.slice(end, Math.min(sentEnd(end), end + 40)).split(",")[0]) || /(?<!\p{L})(?:или|либо|or|either)\s*$/u.test(flat.slice(Math.max(sentStart(i), i - 40), i).split(",").pop());
  for (const m of text.matchAll(/@Damage\[((?:[^\[\]]|\[[^\]]*\])*)\](?:\{[^}]*\})?/g)) {
    const terms = [...m[1].matchAll(/([^\[\],|]+?)\[([^\]]*)\]/g)].map((t) => [t[1], t[2].split(",").map((f) => f.trim())]).filter(([, fl]) => fl.includes("persistent") || fl.includes("bleed"));
    if (!terms.length) continue;
    const end = m.index + m[0].length;
    if (skip(m.index, end, true)) continue;
    if (isOr(m.index, end)) { possible = true; continue; }
    for (const [f, fl] of terms) add(diceOf(f), fl.find((x) => DAMAGE_TYPES.includes(x)) ?? "untyped", dcAt(m.index));
  }
  for (const re of [PERS_RU, PERS_EN]) {
    for (const m of flat.matchAll(re)) {
      const end = m.index + m[0].length;
      if (skip(m.index, end)) continue;
      const damageType = re === PERS_EN ? typeOfWord(m[2]) : typeOfWord(m[2]) ?? typeOfWord(m[3]);
      if (isOr(m.index, end)) { possible = true; continue; }
      add(diceOf(m[1]), damageType, dcAt(m.index));
    }
  }
  return { steps, possible };
}

/** [термин, slug] для простого текста: имена от вызывающего + подписи ссылок на состояния этого описания. */
function plainTerms(html, condNames, condSlug) {
  const out = new Map();
  const add = (name, slug) => {
    const t = isStr(name) ? normTerm(name) : "";
    if (slug && t.length >= 3 && !PLAIN_SKIP.has(slug) && !out.has(t)) out.set(t, slug);
  };
  for (const [n, s] of condNames ?? []) add(n, s);
  const linked = new Set();
  for (const m of html.matchAll(/@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g)) {
    const slug = condSlug(m[1]);
    if (slug) linked.add(slug);
    if (m[2]) add(m[2], slug);
  }
  return { terms: [...out], linked };
}

/**
 * itemLike = { type, slug, name?, system:{description:{value}, defense, area, target, selfEffect} }
 * labels = rules/labels.json; conditionSlugByUuid = (uuid) => slug|null.
 * Ветки взаимоисключающи, confidence — у правила целиком (см. README/отчёт).
 */
export function deriveFromMarkup(itemLike, labels, conditionSlugByUuid, condNames = null) {
  const html = itemLike?.system?.description?.value;
  if (!isStr(html)) return null;
  const sys = itemLike.system;
  const type = itemLike.type;
  const hints = { inflicts: [], conditions: [], effects: [], unresolved: [], excluded: [], possible: [], template: false };
  const condSlug = (u) => conditionSlugByUuid?.(u) || null;

  const { blocks, markers } = parseBlocks(html, labelMap(labels));
  const outside = stripBlocks(html, markers);
  const { terms, linked: linkedAll } = plainTerms(html, condNames, condSlug);
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
  hints.conditions = [...outLinks.conds.map((c) => c.slug), ...outLinks.timed];
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
      const { conds, effects, timed } = linksOf(text, condSlug, hints);
      for (const slug of [...timed, ...addPlainConds(text, conds, terms, linkedAll)]) if (!hints.possible.includes(`${deg}:${slug}`)) hints.possible.push(`${deg}:${slug}`);   // имя без ссылки и значения — только подсказка
      for (const c of conds) if (NOT_ON_TARGET.has(c.slug)) hints.excluded.push(`${deg}:${c.slug}`);
      const pers = persistentOf(text, { outside, html });
      if (pers.possible && !hints.possible.includes(`${deg}:persistent-damage`)) hints.possible.push(`${deg}:persistent-damage`);
      const list = [...conds.filter((c) => !NOT_ON_TARGET.has(c.slug)).map((c) => condApply(c, "target")), ...effects.map((uuid) => ({ to: "target", effect: { uuid } })), ...pers.steps.map((p) => ({ to: "target", persistent: p }))];
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
        if (v.ok) map.set(key, v.rule); else errors.push(`${field}.${key}: ${v.errors.map(errText).join("; ")}`);
      }
    }
  }
  return { bySource, bySlug, byName, errors };
}

/** Для тестов и loadCatalog: задать встроенные каталоги и метки степеней. */
export function initCatalog(jsons, labels) {
  const { errors, ...cat } = buildCatalog(jsons);
  builtin = cat;
  rev.n++;
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
    if (!v.ok) throw new Error(`saveWorldRule: ${v.errors.map(errText).join("; ")}`);
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

/** [имя, slug] состояний: slug (англ.) и локализованное имя из CONFIG.PF2E.conditionTypes. */
function runtimeCondNames() {
  const out = [];
  for (const [slug, key] of Object.entries(globalThis.CONFIG?.PF2E?.conditionTypes ?? {})) {
    out.push([slug.replace(/-/g, " "), slug], [game.i18n.localize(key), slug]);
  }
  return out;
}

/** Порядок §1.2: флаг -> world.bySource -> world.bySlug -> builtin.bySource -> builtin.bySlug -> разметка. */
export function resolveRule(source) {
  const origin = source?.origin ?? null;
  const item = liveItem(origin, source?.system ? source : (source?.item ?? null));
  const slug = slugOf(origin, item);
  const sourceUuid = sourceOf(origin, item);
  const found = (rule, src, confidence = "high", hints) => ({ rule, source: src, slug, sourceUuid, confidence, ...(hints && { hints }) });

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
      (uuid) => game.pf2e.ConditionManager.conditions.get(uuid)?.slug ?? null,
      runtimeCondNames()
    );
    if (d) return found(d.rule, "markup", d.confidence, d.hints);
  }
  return null;
}
