import { MOD, DEGREES, ENDS_EARLY, errText, sluggify } from "./util.mjs";
import { S, rev } from "./settings.mjs";
import { isPredicate } from "./predicate.mjs";

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

export const ESCAPE_STATS = ["athletics", "acrobatics", "unarmed"];

/** Шаг apply делает что-то с получателем (есть вид шага); note — только текст в блоке. */
export const STEP_KINDS = ["condition", "effect", "visibility", "persistent", "removeCondition", "removeEffect", "extendEffect", "rollOption", "damage", "choose"];
export const isActiveStep = (a) => STEP_KINDS.some((k) => a?.[k]);
// получатели шага: self — автор, target — цель, party — участники партий автора, allies — союзники автора в радиусе range футов от его токена,
// chosen — существо, которое автор выбрал предыдущим шагом choose (from: allies | enemies)
export const APPLY_TO = ["self", "target", "party", "allies", "chosen"];
export const CHOOSE_FROM = ["allies", "enemies", "options"];
/** Урон шага damage: типы урона и лечение (healing — формула лечит). */
export const STEP_DAMAGE_TYPES = ["healing", ...DAMAGE_TYPES];

function vApply(a, path, defTo, err, basicOk = false) {
  if (!isObj(a)) { err.push(E("notObj", path)); return null; }
  const out = { to: a.choose != null && a.to == null ? "self" : a.to ?? defTo };   // choose — выбор делает автор: получатель шага всегда «self»
  if (!APPLY_TO.includes(out.to) || (a.choose != null && out.to !== "self")) err.push(E("apply.to", `${path}.to`));
  // choose: автор-игрок выбирает союзника/врага (дальше шаги to:"chosen") или вариант (дальше шаги when: "choice:<value>"); prompt — вопрос в окне
  if (a.choose != null) {
    const c = a.choose, opts = Array.isArray(c?.options) ? c.options.map((o) => (typeof o === "string" ? { value: o } : o)) : null;
    if (!isObj(c) || !CHOOSE_FROM.includes(c.from) || (c.prompt != null && !isStr(c.prompt))
      || (c.from === "options" ? !(opts?.length && opts.every((o) => isObj(o) && isStr(o.value) && SLUG.test(o.value) && (o.label == null || isStr(o.label)) && (o.when == null || isPredicate(o.when))) && new Set(opts.map((o) => o.value)).size === opts.length) : c.options != null)
      || (c.range != null && !(c.from !== "options" && isInt(c.range) && c.range >= 5))
      || (c.of != null && !(c.from !== "options" && c.of === "target")) || (c.withSelf != null && !(c.withSelf === true && c.from === "allies"))) err.push(E("choose.bad", `${path}.choose`));
    // option.when — вариант виден, только если у автора выполнено условие (черта даёт вариант); of:"target" — радиус считается от цели события/карточки, а не от автора
    else out.choose = { from: c.from, ...(opts && { options: opts.map((o) => ({ value: o.value, ...(o.label && { label: o.label }), ...(o.when && { when: o.when }) })) }), ...(c.prompt && { prompt: c.prompt }), ...(c.range != null && { range: c.range }), ...(c.of && { of: c.of }), ...(c.withSelf && { withSelf: true }) };
  }  const kinds = [...STEP_KINDS, "note"].filter((k) => a[k] != null);
  if (kinds.length !== 1) err.push(E("apply.kind", path));
  // range — радиус в футах, только у союзников (Живые щиты, Сеятель)
  if (a.range != null) { if (out.to !== "allies" || !(isInt(a.range) && a.range >= 5)) err.push(E("apply.range", `${path}.range`)); else out.range = a.range; }
  else if (out.to === "allies") err.push(E("apply.range", `${path}.range`));
  if ((out.to === "party" || out.to === "allies" || out.to === "chosen") && a.visibility != null) err.push(E("apply.groupKind", path));
  // when — условие на шаге: предикат pf2e по roll options (черта, заклинание, исход, цель…); не выполнено — шаг пропускается
  if (a.when != null) { if (!isPredicate(a.when)) err.push(E("apply.when", `${path}.when`)); else out.when = a.when; }
  // шаги над эффектом получателя: снять (по slug/uuid, of:"origin" — только созданный автором), продлить на раунды, включить опцию RollOption
  if (a.removeEffect != null) {
    const r = a.removeEffect;
    if (!isObj(r) || (r.slug == null) === (r.uuid == null) || (r.slug != null && !(isStr(r.slug) && SLUG.test(r.slug))) || (r.uuid != null && !isStr(r.uuid)) || (r.of != null && r.of !== "origin")) err.push(E("rmEff.bad", `${path}.removeEffect`));
    else out.removeEffect = { ...(r.slug != null ? { slug: r.slug } : { uuid: r.uuid }), ...(r.of && { of: "origin" }) };
  }
  if (a.extendEffect != null) {
    const x = a.extendEffect;
    if (!isObj(x) || !isStr(x.slug) || !SLUG.test(x.slug) || !(isInt(x.rounds) && x.rounds >= 1)) err.push(E("extEff.bad", `${path}.extendEffect`));
    else out.extendEffect = { slug: x.slug, rounds: x.rounds };
  }
  if (a.rollOption != null) {
    const o = a.rollOption;
    if (!isObj(o) || !isStr(o.domain) || !SLUG.test(o.domain) || !isStr(o.option) || /\s/.test(o.option) || (o.value != null && typeof o.value !== "boolean")) err.push(E("rollOpt.bad", `${path}.rollOption`));
    else out.rollOption = { domain: o.domain, option: o.option, ...(o.value === false && { value: false }) };
  }
  // снять состояние (Встать, Стабилизация): удаляется целиком, значение не уменьшается
  if (a.removeCondition != null) {
    if (!isObj(a.removeCondition) || !isStr(a.removeCondition.slug) || !SLUG.test(a.removeCondition.slug)) err.push(E("rm.slug", `${path}.removeCondition.slug`));
    else out.removeCondition = { slug: a.removeCondition.slug };
  }
  // rank — шаг только при круге сотворения в пределах min..max (сравнения круга в предикатах PA); у предмета не заклинания считается уровень предмета
  if (a.rank != null) {
    const r = a.rank;
    if (!isObj(r) || (r.min == null && r.max == null) || [r.min, r.max].some((x) => x != null && !(isInt(x) && x >= 1 && x <= 10)) || (r.min != null && r.max != null && r.min > r.max)) err.push(E("apply.rank", `${path}.rank`));
    else out.rank = { ...(r.min != null && { min: r.min }), ...(r.max != null && { max: r.max }) };
  }
  if (a.condition != null) {
    const c = a.condition;
    if (!isObj(c) || !isStr(c.slug)) err.push(E("cond.slug", `${path}.condition.slug`));
    else {
      if (c.value != null && !(isInt(c.value) && c.value >= 1)) err.push(E("cond.value", `${path}.condition.value`));
      // reduce — снизить действующее значение на value (по умолчанию 1), на нуле состояние снимается; нет состояния — пропуск (Аура отваги)
      if (c.policy != null && !["max", "add", "reduce"].includes(c.policy)) err.push(E("cond.policy", `${path}.condition.policy`));
      else if (c.policy === "reduce" && a.duration != null) err.push(E("cond.reduceDur", `${path}.condition.policy`));
      out.condition = { slug: c.slug, ...(c.value != null && { value: c.value }), policy: c.policy ?? "max" };
    }
  }
  // duration: у состояния — срок обёртки-эффекта (of: чей ход считает); у эффекта — переопределение срока созданного эффекта (value — число или кубик «1d4», бросается при создании)
  if (a.duration != null) {
    const d = a.duration, dice = isStr(d?.value) && /^\d+d\d+$/i.test(d.value.trim());
    if (a.condition == null && a.effect == null) err.push(E("dur.needCond", `${path}.duration`));
    else if (!isObj(d) || !(dice || (isInt(d.value) && (d.value >= 1 || (d.value === 0 && d.expiry === "turn-end")))) || !APPLY_UNITS.includes(d.unit)) err.push(E("dur.bad", `${path}.duration`));
    else if (d.expiry != null && !["turn-start", "turn-end"].includes(d.expiry)) err.push(E("dur.expiry", `${path}.duration.expiry`));
    else if (d.of != null && (a.effect != null || !["origin", "target"].includes(d.of))) err.push(E("dur.of", `${path}.duration.of`));
    else if (out.condition) out.duration = { value: dice ? d.value.trim().toLowerCase() : d.value, unit: d.unit, expiry: d.expiry ?? null, of: d.of ?? "origin" };
    else if (a.effect != null) out.duration = { value: dice ? d.value.trim().toLowerCase() : d.value, unit: d.unit, expiry: d.expiry ?? null };
  }
  // damage — урон (или лечение, type "healing") по формуле: бросок и применение pf2e без кнопок, с учётом сопротивлений
  if (a.damage != null) {
    const g = a.damage;
    // basic: true — только в challenge.byDegree (нужна степень испытания); «обычное» испытание: по степени ×0 / ×½ / ×1 / ×2 (крит. успех — ничего), как у карточки урона pf2e; не лечению
    if (!isObj(g) || !isPersFormula(g.formula) || !STEP_DAMAGE_TYPES.includes(g.damageType) || (g.basic != null && (typeof g.basic !== "boolean" || (g.basic && (!basicOk || g.damageType === "healing"))))) err.push(E("dmg.bad", `${path}.damage`));
    else out.damage = { formula: g.formula.trim().replace(/\s+/g, ""), damageType: g.damageType, ...(g.basic && { basic: true }) };
  }
  if (a.effect != null) {
    if (!isObj(a.effect) || !isStr(a.effect.uuid)) err.push(E("effect.uuid", `${path}.effect.uuid`));
    else if (a.effect.badge != null && !["increment", "decrement", -1].includes(a.effect.badge)) err.push(E("effect.badge", `${path}.effect.badge`));
    // badge:"increment" — если такой эффект у получателя уже есть, его значок растёт на 1 вместо второй копии (Кража тени, Благословение);
    // badge:"decrement" (или -1) — значок уменьшается на 1, на нуле эффект снимается; нет эффекта — шаг пропущен, копия не создаётся
    else if (a.effect.replace != null && (a.effect.replace !== true || a.effect.badge != null)) err.push(E("effect.replace", `${path}.effect.replace`));   // replace:true — прежний эффект того же источника и автора на цели заканчивается, создаётся новый (Доспех из земли); со значком несовместимо
    else if (a.effect.by != null && !(a.effect.badge === "increment" && isInt(a.effect.by) && a.effect.by >= 1 && a.effect.by <= 10)) err.push(E("effect.badge", `${path}.effect.by`));   // by — на сколько растёт значок (Кража тени: 2)
    else if (a.effect.start != null && !(a.effect.badge === "increment" && isInt(a.effect.start) && a.effect.start >= 1 && a.effect.start <= 10)) err.push(E("effect.badge", `${path}.effect.start`));   // start — значок нового эффекта (Кража тени: Enfeebled 2 при первом применении)
    else out.effect = { uuid: a.effect.uuid, ...(a.effect.badge && { badge: a.effect.badge === "increment" ? "increment" : "decrement" }), ...(a.effect.by > 1 && { by: a.effect.by }), ...(a.effect.start > 1 && { start: a.effect.start }), ...(a.effect.replace && { replace: true }) };
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
  // escape — жертва сама проверкой снимает созданное этим шагом (Освобождение): stats — чем бросать, dc — готовая СЛ, dcStat — СЛ автора ("spell" или навык); без СЛ берётся use.dc
  if (a.escape != null) {
    const e = a.escape, stats = e?.stats ?? ["athletics", "acrobatics"];
    if (!isObj(e) || out.to !== "target" || (a.condition == null && a.effect == null)
      || !Array.isArray(stats) || !stats.length || !stats.every((s) => ESCAPE_STATS.includes(s))
      || (e.dc != null && !(isInt(e.dc) && e.dc >= 1)) || (e.dcStat != null && !isStr(e.dcStat))) err.push(E("apply.escape", `${path}.escape`));
    else out.escape = { stats: [...new Set(stats)], ...(e.dc != null && { dc: e.dc }), ...(e.dcStat != null && { dcStat: e.dcStat }) };
  }
  return out;
}

function vApplyList(list, path, defTo, err, basicOk = false) {
  if (list == null) return [];
  if (!Array.isArray(list)) { err.push(E("notArr", path)); return []; }
  const out = list.map((a, i) => vApply(a, `${path}[${i}]`, defTo, err, basicOk));
  // to:"chosen" — только после шага choose из allies/enemies в этом же списке
  let picked = false;
  out.forEach((a, i) => {
    if (a?.choose && a.choose.from !== "options") picked = true;
    else if (a?.to === "chosen" && !picked) err.push(E("apply.chosen", `${path}[${i}].to`));
  });
  return out.filter(Boolean);
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
  if (c.immunity != null) { const im = vImmunity(c.immunity, `${path}.immunity`, err); if (im) out.immunity = im; }
  if (c.when != null) { if (!isPredicate(c.when)) err.push(E("apply.when", `${path}.when`)); else out.when = c.when; }   // условие на цель: не выполнено — цель не бросает и не показана
  if (c.rollerRole != null && c.rollerRole !== "target") err.push(E("ch.roller", `${path}.rollerRole`));
  out.rollerRole = "target";
  out.byDegree = {};
  if (c.byDegree != null) {
    if (!isObj(c.byDegree)) err.push(E("degrees.obj", `${path}.byDegree`));
    else for (const [k, v] of Object.entries(c.byDegree)) {
      if (!DEGREES.includes(k)) { err.push(E("degrees.unknown", `${path}.byDegree.${k}`, { k })); continue; }
      const list = vApplyList(v, `${path}.byDegree.${k}`, "target", err, true);
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
  // scope:"slug" — иммунитет к способности любого автора («ко всем существам вида»); без поля — только к этому автору
  if (im.scope != null) { if (im.scope !== "slug") err.push(E("imm.scope", `${path}.scope`)); else out.scope = "slug"; }
  // degrees — при каких степенях ставится; нет поля или все четыре = при любой
  if (im.degrees != null) {
    const g = im.degrees;
    if (!Array.isArray(g) || !g.length || !g.every((x) => DEGREES.includes(x))) err.push(E("imm.degrees", `${path}.degrees`));
    else { const l = DEGREES.filter((x) => g.includes(x)); if (l.length < DEGREES.length) out.degrees = l; }
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
  // без vs — бросок только за степень (Прыжок, Подъём): СЛ задаёт система, модуль не бросает (roll:"system"), шаги — на самого автора
  if (v == null && c.roll === "system") { /* бросок без цели */ }
  else if (!isObj(v)) err.push(E("chk.vsNone", `${path}.vs`));
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
      const list = vApplyList(v2, `${path}.byDegree.${k}`, out.vs ? "target" : "self", err);
      if (!out.vs && v2 != null && list.some((a) => a.to === "target")) err.push(E("chk.selfSteps", `${path}.byDegree.${k}`));
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
    out.check = vCheck(u.check, "onUse.check", err);
    if (u.targets === "self" && out.check?.vs) err.push(E("use.checkSelf", "onUse.check"));
    if (out.check && !out.check.vs && (u.targets !== "self" || out.check.immunity)) err.push(E("chk.noVsSelf", "onUse.check"));
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

// onEvent (0.5g3): правило на предмете актёра срабатывает по событию. side — кто из участников события держит предмет:
// self — тот, кто бросает / получает урон / ходит / у кого эффект; target — цель броска (onAttacked — частный случай); origin — источник (автор эффекта, чья СЛ у броска).
export const EVENT_ON = ["attack-roll", "skill-check", "saving-throw", "damage-roll", "damage-taken", "spell-cast", "turn-start", "turn-end", "effect-created", "effect-deleted"];
export const EVENT_SIDES = ["self", "target", "origin"];
export const EVENT_TARGETED = new Set(["attack-roll", "skill-check", "damage-roll", "spell-cast"]);   // у остальных событий цели нет: side:"target" бессмысленна

function vEvent(e, i, err) {
  const path = `onEvent[${i}]`;
  if (!isObj(e)) { err.push(E("notObj", path)); return null; }
  const out = { on: e.on, side: e.side ?? "self" };
  if (!EVENT_ON.includes(e.on)) err.push(E("ev.on", `${path}.on`));
  if (!EVENT_SIDES.includes(out.side)) err.push(E("ev.side", `${path}.side`));
  else if (out.side === "target" && !EVENT_TARGETED.has(e.on)) err.push(E("ev.sideTarget", `${path}.side`));
  if (e.when != null) { if (!isPredicate(e.when)) err.push(E("apply.when", `${path}.when`)); else out.when = e.when; }
  if (e.once != null) { if (typeof e.once !== "boolean") err.push(E("ev.once", `${path}.once`)); else if (e.once) out.once = true; }   // once — один раз на эффект/состояние получателя, а не на каждое событие
  const apply = vApplyList(e.apply, `${path}.apply`, "self", err);
  if (apply.length) out.apply = apply;
  if (e.challenge != null) { const c = vChallenge(e.challenge, `${path}.challenge`, err); if (c) out.challenge = c; }
  if (!apply.length && e.challenge == null) err.push(E("ev.empty", path));
  return out;
}

function vEvents(list, err) {
  if (list == null) return [];
  if (!Array.isArray(list)) { err.push(E("notArr", "onEvent")); return []; }
  return list.map((e, i) => vEvent(e, i, err)).filter(Boolean);
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
  const events = vEvents(raw.onEvent, err);
  if (events.length) rule.onEvent = events;   // нет событий — поля нет (правила без него не меняются)
  if (!rule.onUse && !rule.onAttacked && !rule.macros.length && !events.length && !err.length) err.push(E("rule.empty", ""));
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
  // originalName раньше rollOptions: pf2e строит origin:item:slug как sluggify(name), у переведённого предмета (pf2ru/babele) без system.slug он кириллический
  const orig = it?.flags?.babele?.originalName;
  if (isStr(orig)) return sluggify(orig);
  const opt = (origin?.rollOptions ?? []).find((o) => typeof o === "string" && o.startsWith("origin:item:slug:"));
  const fromOpt = opt?.slice("origin:item:slug:".length);
  return isStr(fromOpt) && !/[Ѐ-ӿ]/.test(fromOpt) ? fromOpt : null;   // кириллический slug (перевод) заведомо не из каталога
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

const REF_DEG = { "critical success": "criticalSuccess", "critical failure": "criticalFailure", success: "success", failure: "failure", "критическом успехе": "criticalSuccess", "критическом провале": "criticalFailure", успехе: "success", провале: "failure" };
/** Блок начинается с «As failure, but…» / «Как при провале, но…» -> ключ степени, с которой он сделан. */
function refDegree(text) {
  const m = /^[\s:,.-]*(?:(?:same )?as|like)\s+(?:a\s+|an\s+)?(critical success|critical failure|success|failure)(?![\p{L}])|^[\s:,.-]*как при\s+(критическом\s+(?:успехе|провале)|успехе|провале)/iu.exec(text.replace(/<[^>]*>/g, " "));
  return m ? REF_DEG[(m[1] ?? m[2]).toLowerCase().replace(/\s+/g, " ")] ?? null : null;
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
const IMMUNITY = /иммун|невосприимч|immun/i;
const condApply = (c, to) => ({ to, condition: { slug: c.slug, ...(c.value != null && { value: c.value }), policy: "max" }, ...(c.duration && { duration: c.duration }) });

// Простым текстом не ищем: перечисленные выше, отношения и «продолжительный урон» (ложные совпадения).
const PLAIN_SKIP = new Set([...NOT_ON_TARGET, "persistent-damage", "friendly", "helpful", "hostile", "indifferent", "unfriendly", "malevolence", "cursebound", "broken", "controlled", "unnoticed"]);
const DUR = /(?<!\p{L})(?:в течение|на|for)\s+(\d+)\s*(раунд|минут|час|дн|ден|round|minute|hour|day)/giu;
const NEXT_TURN = /(?<!\p{L})(?:до|until)\s+(?:the\s+)?(начала|конца|start|end)\s+(?:of\s+)?(своего|его|ее|их|вашего|its|their|his|her|your)\s+(?:следующего|next)\s+(?:хода|turn)/giu;
// pf2e допускает «stunned на срок» вместо значения; шагом правила это не выразить: createTimed даёт значение 1 (теряет 1 действие, а не все)
export const DURATION_ONLY = new Set(["stunned"]);
const durNext = (s) => [DUR, NEXT_TURN].some((re) => new RegExp("^[\\s,]*(?:(?:both|all|each)\\s+)?(?:" + re.source + ")", "iu").test(s));
const UNIT_OF = { р: "rounds", r: "rounds", м: "minutes", m: "minutes", ч: "hours", h: "hours", д: "days", d: "days" };
// перед состоянием без смысла «цель получает»: избавление, избегание, иммунитет, отрицание, условие
const STOP = /(?<!\p{L})(?:из(?![\p{L}-])|без|уже|если|не|ни|избег\p{L}*|избав\p{L}*|тер(?:я|ет|ял)\p{L}*|утрач\p{L}*|высвобо\p{L}*|снима\p{L}*|снят\p{L}*|прекращ\p{L}*|иммун\p{L}*|невосприимч\p{L}*|no longer|not|can't|can’t|cannot|immune|if|unless|removes?|removed|free from|recovers? from)(?![\p{L}])|(?<!\p{L})от\s+(?:\p{L}+\s+)?$|(?<!\p{L})ends?(?![\p{L}])(?!\s+of\b)/iu;
// получатель — автор («вы получаете…»), а не цель
const AUTHOR = /(?<!\p{L})(?:вы|вас|вам|вами|you)(?![\p{L}])/iu;
// альтернатива/условие после значения: «испуг 1 вместо испуга 2», «frightened 3 if …»
const ALT = /(?<!\p{L})(?:вместо|instead|if|если|unless)(?![\p{L}])/iu;
// «на время действия заклинания»: срок берётся у самого документа (system.duration)
const ITEM_DUR = /(?<!\p{L})(?:for\s+the\s+(?:spell['’]?s?\s+)?duration(?:\s+of\s+the\s+spell)?|на\s+(?:все\s+)?время\s+действия|на\s+(?:весь\s+)?срок\s+действия|в\s+течение\s+(?:всего\s+)?(?:времени\s+)?действия)/gu;
// второе состояние «после первого»: одновременно оно не наступает, шагом правила последовательность не выразить
const SEQ = /(?<!\p{L})(?:then|afterwards?|затем|потом|после\s+того)(?!\p{L})|(?<!\p{L})(?:after|when)\s+(?:it|they|the\s+\p{L}+)\s+(?:recovers?|is\s+no\s+longer|are\s+no\s+longer)(?!\p{L})/u;
// текст меняет срок, который правило не выразит: «with a duration of 1 hour», «unlimited duration», «doesn't end when the spell's duration does»
const DUR_CHANGED = /(?<!\p{L})(?:(?:doesn['’]?t|does\s+not|don['’]?t)\s+end|duration\s+(?:of|is)|(?:unlimited|indefinite)\s+duration)(?!\p{L})|продолжительност\p{L}*/u;
/** system.duration pf2e ({value:"1 minute", sustained}) -> {value, unit} конечный срок; «sustained» — верхняя граница, как у эффектов pf2e. Иначе null. */
export function itemDuration(d) {
  const m = /^(?:up\s+to\s+)?(\d+)\s*(round|minute|hour|day)s?$/i.exec(String(d?.value ?? "").trim().replace(/^sustained\s+/i, ""));
  return m && +m[1] >= 1 ? { value: +m[1], unit: UNIT_OF[m[2][0].toLowerCase()] } : null;
}
const blank = (s) => " ".repeat(s.length);
const normTerm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[\d:.,;()]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Состояния, упомянутые в блоке степени простым текстом («испуг 2», «frightened 2»), и длительность
 * («в течение 1 раунда», «for 1 round», «до начала своего следующего хода»): срок получает только состояние,
 * после которого он стоит вплотную (между ними одни пробелы).
 * Состояние без значения берётся, только если в описании оно есть ссылкой (linkedAll); иначе — в possible.
 * itemDur — срок документа для «на время действия» (null — не выводится). flags: termText (в тексте есть срок), seq (последовательность состояний), keep (срок меняется текстом, «As failure, but for 1 minute» — срок блока-ссылки не у его состояний).
 * Мутирует conds, возвращает possible (slug[]).
 * ponytail: падежи — отбрасывается последняя буква имени и допускается до 2 букв окончания; без морфологии.
 */
function addPlainConds(text, conds, terms, linkedAll, itemDur = null, flags = {}) {
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
  // условная оговорка перед ссылкой («if the creature ends its turn adjacent…, it is Slowed 1»): состояние не безусловное — в подсказку
  for (const c of [...conds]) {
    // закрывшаяся скобка («(if flying)») не действует дальше; «if it's a creature / living» почти всегда выполнено — не условие
    const pre = flat.slice(sentStart(c.at), c.at).replace(/\([^()]*\)/g, " ");
    const kw = [...pre.matchAll(/(?<!\p{L})(?:if|unless|whenever|each time)(?!\p{L})/gu)].pop();
    if (!kw || (kw[0] === "if" && /^\s*(?:it'?s|it is|the (?:creature|target) is|they are)\s+(?:a |an )?(?:living|alive|creature|object)\b/u.test(pre.slice(kw.index + 2)))) continue;
    conds.splice(conds.indexOf(c), 1);
    if (!possible.includes(c.slug)) possible.push(c.slug);
  }
  // «A, B или C» / «либо A, либо B»: выбор, не наложение (в схеме выбора нет — prompt, ROADMAP §3): в подсказку, ссылки тоже, если вариантов не меньше двух
  const byAt = [...conds].sort((x, y) => x.at - y.at);
  const OR = /(?<!\p{L})(?:или|либо|or|either)(?!\p{L})/u;
  for (let i = 0, j; i < byAt.length; i = j) {
    let alt = /(?<!\p{L})(?:либо|either)\s*$/u.test(flat.slice(Math.max(0, byAt[i].at - 12), byAt[i].at));
    for (j = i + 1; j < byAt.length; j++) {
      const gap = flat.slice(byAt[j - 1].end, byAt[j].at);
      if (!/^[\s,]*(?:(?:или|либо|or|either|and|и)[\s,]*)?$/u.test(gap)) break;
      alt ||= OR.test(gap);
    }
    if (alt) for (const c of byAt.slice(i, j)) if (c.plain || j - i > 1) { conds.splice(conds.indexOf(c), 1); if (!possible.includes(c.slug)) possible.push(c.slug); }
  }
  // «Stunned 3, then slowed 2»: второе наступает после первого, а не вместе с ним — в подсказку, правило low
  const seqSorted = [...conds].sort((x, y) => x.at - y.at);
  for (let i = 1; i < seqSorted.length; i++) {
    const a = seqSorted[i - 1], b = seqSorted[i];
    if (b.at < a.end || bounds.some((x) => x >= a.end && x < b.at) || !SEQ.test(flat.slice(a.end, b.at)) || !conds.includes(b)) continue;
    flags.seq = true;
    conds.splice(conds.indexOf(b), 1);
    if (!possible.includes(b.slug)) possible.push(b.slug);
  }
  // срок — только состоянию, после которого он стоит вплотную (между ними одни пробелы)
  const attach = (at, d, chain = false) => {
    let c = conds.find((c) => c.end <= at && !flat.slice(c.end, at).trim());
    // «A and B for 1 minute» / «A, B and C until the start of its next turn»: срок всей цепочке, между состояниями которой только запятые и «and»/«и» (chain); испуг сам снижается каждый ход, срок не ему
    while (c) {
      if (!c.duration) c.duration = d;
      const prev = conds.filter((p) => p.slug !== "frightened" && p.end <= c.at && /^[\s,]*(?:(?:and|и)[\s,]*)?$/u.test(flat.slice(p.end, c.at))).sort((x, y) => x.end - y.end).pop();
      c = chain ? prev : null;
    }
  };
  for (const m of flat.matchAll(DUR)) {
    if (!(+m[1] >= 1 && UNIT_OF[m[2][0]])) continue;
    const d = { value: +m[1], unit: UNIT_OF[m[2][0]] };
    // «X and Y, both for 1 minute»: срок обоим (всем состояниям фразы без срока)
    if (/(?<!\p{L})(?:both|all|each)\s*$/u.test(flat.slice(0, m.index))) for (const c of conds) { if (c.at >= sentStart(m.index) && c.end <= m.index && !c.duration) c.duration = d; }
    else attach(m.index, d, true);
  }
  for (const m of flat.matchAll(ITEM_DUR)) if (itemDur) attach(m.index, itemDur, true);
  for (const m of flat.matchAll(NEXT_TURN)) {
    attach(m.index, { value: 1, unit: "rounds", expiry: /^(начала|start)/.test(m[1]) ? "turn-start" : "turn-end", of: /^(вашего|your)/.test(m[2]) ? "origin" : "target" }, true);
  }
  // срок броском («for [[/gmr 1d4 #rounds]]{1d4 rounds}»): condition.duration.value — кубик (apply.mjs бросает его сам); не дотянулся — состояние бессрочно ставить нельзя, в подсказку
  const ROLL_DUR = /\[\[\/g?m?r(?:oll)?\s+(\d+d\d+)[^\]]*?(?:#\s*(round|minute|hour|day)|\]\]\{[^}]*?(round|minute|hour|day))/giu;
  for (const m of flat.matchAll(ROLL_DUR)) {
    const unit = UNIT_OF[(m[2] ?? m[3])[0]], before = flat.slice(0, m.index);
    if (/(?<!\p{L})(?:for|в течение|на)\s*$/u.test(before)) attach(before.search(/(?<!\p{L})(?:for|в течение|на)\s*$/u), { value: m[1].toLowerCase(), unit }, true);
  }
  // в тексте есть срок (кроме иммунитета: «immune for 1 day»); состояния без срока он теперь касается — решает вызывающий (low)
  flags.termText = [DUR, NEXT_TURN, ITEM_DUR, ROLL_DUR].some((re) => [...flat.matchAll(re)].some((m) => !IMMUNITY.test(flat.slice(Math.max(sentStart(m.index), m.index - 60), m.index))));
  flags.keep = DUR_CHANGED.test(flat);
  const byPos = [...conds].sort((a, b) => a.at - b.at);
  for (const c of [...conds]) {
    if (c.duration) continue;
    // только текст до следующего состояния: бросок после него — срок того состояния, а не этого
    const next = byPos.find((x) => x.at >= c.end)?.at ?? Infinity, tail = flat.slice(c.end, Math.min(sentEnd(c.end), next));
    if (/(?:for|на|в течение)\s+\[\[\/g?m?r(?:oll)?\s+\d+d\d+[^\]]*?(?:#\s*(?:round|minute|hour|day)|\]\]\{[^}]*?(?:round|minute|hour|day))/i.test(tail)) { conds.splice(conds.indexOf(c), 1); if (!possible.includes(c.slug)) possible.push(c.slug); }
  }
  conds.sort((a, b) => a.at - b.at);
  return possible;
}

/* ---------- продолжительный урон в блоке степени ---------- */

// основы названий типов урона (ru: «огненного», «урона огнём», «режущего»; en: slug) -> тип pf2e
const TYPE_STEMS = [["огн", "fire"], ["холод", "cold"], ["кислот", "acid"], ["электр", "electricity"], ["ментал", "mental"], ["яд", "poison"], ["дух", "spirit"], ["жизн", "vitality"], ["пустот", "void"], ["звук", "sonic"], ["сил", "force"], ["негатив", "void"], ["позитив", "vitality"], ["кровотеч", "bleed"],
  ["колющ", "piercing"], ["дроб", "bludgeoning"], ["рубящ", "slashing"], ["режущ", "slashing"], ...DAMAGE_TYPES.filter((x) => x !== "untyped").map((x) => [x.slice(0, 6), x]), ["pierc", "piercing"], ["bludgeon", "bludgeoning"], ["electr", "electricity"]];
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

/* ---------- провал и критический провал прозой (описание без подписанных блоков) ---------- */

const MASK = /@\w+\[(?:[^\[\]]|\[[^\]]*\])*\](?:\{[^}]*\})?/g;
const THEY = String.raw`(?:it|they|(?:the|that|a)\s+(?:creature|target))`;
const FAIL_RE = new RegExp(String.raw`\bon\s+a\s+fail(?:ure|ed\s+save)\b|\bif\s+${THEY}\s+fails?(?:\s+(?:the|its|their)\s+(?:save|saving\s+throw))?\b|\bcreatures?\s+(?:that|who)\s+fails?\s+(?:its|their|the|this)\s+(?:save|saving\s+throw)(?:\s+against\s+[^,.]*?)?(?=\s+(?:also\s+)?(?:becomes?|is|are|takes?|gains?)\b)|\b(?:succeed\s+at|attempt)\s+(?:an?\s+|the\s+)?(?:\w+\s+)?(?:save|saving\s+throw)\b[^.;]{0,80}?\bor\b[^.;]{0,160}?(?=\b(?:be|becomes?|gains?)\b)`);
const CRIT_RE = new RegExp(String.raw`\bon\s+a\s+critical(?:ly)?\s+fail(?:ure|ed\s+save)\b|\bif\s+${THEY}\s+critically\s+fails?\b|\bcreatures?\s+(?:that|who)\s+critically\s+fails?\b(?:\s+(?:its|their|the|this)\s+(?:save|saving\s+throw)\b)?|\bcritical\s+failure\s+(?=increases?\b)`);
const FAIL_PRE_RE = new RegExp(String.raw`\bif\s+${THEY}\s+fails?\s+(?:an?|the|its|their)\s+(?:\w+\s+)?(?:save|saving\s+throw)\b`);
// состояние «пока оно ещё действует»: срок не выразить правилом — в подсказку (possible), не в шаг
const DEPENDENT = /^[^.;()@]{0,40}?\b(?:for\s+as\s+long\s+as|as\s+long\s+as|for\s+the\s+same\s+duration|while\s+(?:it|they|the\s+creature)\b)/i;

/**
 * Провал и критический провал, описанные предложением («must succeed at a save or become X (plus Y on a critical failure)», «On a failure, the creature is X»,
 * «A creature that fails its save becomes X», «A critical failure increases this condition to Y»), а не подписанными блоками. -> { blocks: {failure?, criticalFailure?}, possible: ["degree:slug"] }.
 * Блок критического провала без своих состояний (или с другими) начинается с «As failure»: наследует провал, как в подписанных блоках. Сомнительная форма — не разбирается вовсе.
 * ponytail: только эти обороты; успех и крит. успех прозой не берутся (там обычно иммунитет).
 */
export function proseBlocks(html, condSlug) {
  // «(… on a critical hit)» — не критический провал спасброска: скобку не читаем
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\([^()]*critical\s+(?:hit|strike)[^()]*\)/gi, blank);
  const flat = text.replace(MASK, blank).toLowerCase();
  const bounds = [-1, ...[...flat.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index), flat.length];
  let fail = null, crit = null;
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i] + 1, b = bounds[i + 1], s = flat.slice(a, b);
    // «The target becomes X if it fails a Will save (or Y on a critical failure)»: состояние стоит перед оборотом — провал — всё предложение
    const f = FAIL_PRE_RE.test(s) ? { index: 0, 0: "" } : FAIL_RE.exec(s), c = CRIT_RE.exec(s);
    // приказ на потом («compelled to drop Prone as its first action») — не состояние сейчас
    if ((!f && !c) || /\b(?:athletics|acrobatics|attack|flat)\b/.test(s) || /\b(?:compelled|forced)\s+to\b[^.]{0,80}\b(?:first\s+action|next\s+turn)\b|\bspend\s+all\s+(?:three|\w+)\s+actions?\b/.test(s)) continue;
    if (c && f && c.index < f.index) return { blocks: {}, possible: [] };
    const fe = f ? a + f.index + f[0].length : 0, cs = c ? a + c.index : 0, ce = c ? a + c.index + c[0].length : 0;
    let ft = f ? text.slice(fe, c ? cs : b) : null, ct = c ? text.slice(ce, b) : null;
    const bad = { blocks: {}, possible: [] }, letters = (x) => /[\p{L}\d]/u.test(x.replace(/^[\s,.:;)]+/, ""));
    if (c && !f && !letters(ct)) return bad;   // «X on a critical failure» без провала: форма неясна
    if (f && c) {
      const pre = ft, after = ct, open = pre.lastIndexOf("("), unclosed = open > pre.lastIndexOf(")");
      if (unclosed) {   // «… (or Y on a critical failure) for 1 round», «(on a critical failure, they are also Y)», «(plus Y on a critical failure for as long as…)»
        const inner = pre.slice(open + 1), j = after.indexOf(")"), inParen = j >= 0 ? after.slice(0, j) : after, rest = j >= 0 ? after.slice(j + 1) : "";
        ft = `${pre.slice(0, open)} ${rest}`;
        ct = `${/[\p{L}\d@]/u.test(inner) ? inner : ""} ${inParen}${/^\s*(?:for|until)\b/i.test(rest) ? rest : ""}`;
      } else if ([...pre.matchAll(/@UUID\[/g)].length >= 2 && !/@UUID\[/.test(after)) {   // «X, or Y on a critical failure»: Y стоит перед пометкой
        const cut = [...pre.matchAll(/@UUID\[/g)].at(-1).index;
        ft = pre.slice(0, cut); ct = `${pre.slice(cut)} ${after}`;
      } else if (!letters(after)) return bad;
      if (!/@UUID\[/.test(ct) && /^\s*(?:or\s+)?(?:for\s+)?\d+\s+(?:round|minute|hour|day)s?\W*$/i.test(ct)) {   // «(1 minute on a critical failure)», «(or for 1 minute on …)»: те же состояния на другой срок
        const ph = /for\s+\d+\s+(?:round|minute|hour|day)s?|until\s+the\s+end\s+of\s+its\s+next\s+turn/i;
        if (ph.test(ft)) ct = ft.replace(ph, `for ${/\d+\s+\w+/.exec(ct)[0]}`);   // иначе крит. провал наследует провал как есть
      } else if (!/@UUID\[/.test(ct)) {   // «([[/gmr 2d4 #rounds]] on a critical failure)», «(or [[/gmr 1d4 #rounds]]{1d4 rounds} on …)»: тот же срок броском
        const roll = /^\s*(?:or\s+)?(?:for\s+)?(\[\[\/g?m?r(?:oll)?\s+\d+d\d+[^\]]*\]\](?:\{[^}]*\})?)\W*$/i.exec(ct), ph = /for\s+\d+\s+(?:round|minute|hour|day)s?|until\s+the\s+end\s+of\s+its\s+next\s+turn/i;
        if (roll && ph.test(ft)) ct = ft.replace(ph, `for ${roll[1]}`);
      }
    }
    if (ft != null && fail == null && !/^[\s,:]*(?:you|your)\b/i.test(ft)) fail = ft;
    if (ct != null && crit == null) crit = ct;
  }
  const possible = [];
  // force — состояния, зависимые на провале: то же состояние крит. провала зависит так же («Frightened 1 as long as … in the aura (Frightened 2 on a critical failure)»)
  const strip = (t, deg, force = new Set()) => t.replace(/@UUID\[([^\]]+)\](?:\{[^}]*\})?/g, (m, u, off) => {
    const slug = condSlug(u);
    if (!slug) return m;
    const rest = t.slice(off + m.length), next = rest.indexOf("@UUID["), seg = next < 0 ? rest : rest.slice(0, next);
    if (!DEPENDENT.test(seg) && !force.has(slug)) return m;
    possible.push(`${deg}:${slug}`);
    return " ";
  });
  const slugs = (t) => new Set([...t.matchAll(/@UUID\[([^\]]+)\]/g)].map((m) => condSlug(m[1])).filter(Boolean));
  const blocks = {};
  if (fail != null) blocks.failure = strip(fail, "failure");
  if (crit == null && fail != null) blocks.criticalFailure = "As failure";   // pf2e: нет строки крит. провала — он равен провалу
  if (crit != null) {
    let t = strip(crit, "criticalFailure", new Set(possible.filter((x) => x.startsWith("failure:")).map((x) => x.slice(8))));
    if (t !== crit && !slugs(t).size) t = t.replace(/\binstead\b/gi, "also");   // «instead Doomed 2 for as long as…»: заменённое состояние ушло в подсказку, остальное от провала остаётся
    const mine = slugs(t), theirs = slugs(blocks.failure ?? "");
    // «(or Stunned 1 on a critical failure)» без общих состояний с провалом — замена, а не добавка (Otherworldly Laugh); с общими («(or Slowed 2 …)») — остальное от провала сохраняется
    const replaces = /^\s*or\b/i.test(crit) && mine.size > 0 && ![...mine].some((x) => theirs.has(x));   // без своих состояний у крит. провала — он наследует провал («or twice that», «or for 1 minute»)
    blocks.criticalFailure = fail != null && !/\bpermanent/i.test(t) && !replaces ? `As failure, ${t}` : t;
  }
  return { blocks, possible };
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
/** Текст «use this … again, any existing one ends» (Timber Sentinel, Living Bonfire, Hallowed Ground): повтор заканчивает прежний эффект. */
export const REPLACES = /\bagain\b[^.]{0,80}(?<!\b(?:until|once)\s+(?:the\s+)?)\b(?:existing|previous)\b[^.]{0,60}\bends?\b/i;   // «until/once the previous one ends» — запрет повтора, не замена (Turn the Wheel of Seasons)
/** Текст для детекторов: без разметки, ссылки — подписью, @Check-спасбросок — словом «save», @Template — «AREA»; heightened-приписка отброшена. */
const detectText = (html) => plainOf(String(html ?? "").replace(/@UUID\[[^\]]*\](?:\{([^}]*)\})?/g, "$1").replace(/@Check\[\s*(?:fortitude|reflex|will)[^\]]*\](?:\{[^}]*\})?/gi, " save ").replace(/@Template\[[^\]]*\](?:\{[^}]*\})?/g, " AREA ").replace(/@\w+\[[^\]]*\](?:\{([^}]*)\})?/g, "$1")).split(/\bHeightened\b/)[0];
// «Each enemy in…/All enemies within…/Enemies who…»; не «your enemies» (бонус), «against all enemies», «adjacent to any enemy», «enemy forces»
const ENEMY_AREA = /(?<!\b(?:your|an|of|against|vs\.?|another|other|all|any|each|every|adjacent to|next to|toward|from|for|than)\s)\b(?:(?:each|every|all|any)\s+(?:other\s+)?(?:living\s+)?(?:enem(?:y|ies)(?!\s+forces?)|foes?)\b|enemies\s+(?:in|within|inside|who|that|adjacent|standing|which|starting)\b)/i;
// область затрагивает и союзников («You and all allies in the area gain…») или «each creature in the area» раньше врагов — разделить шаги нечем
const ALLIES_TOO = /\b(?:an?|one|each|any|every|your)\s+(?:willing\s+)?ally\b|\bwilling\b|\b(?:all|each|your|any|other)\s+allies\s+(?:in|within|gain|get|receive|are|who|that|adjacent|take)\b|\ballies\s+(?:in|within|gain|get|receive|are)\b/i;
const CREATURES_FIRST = /\b(?:each|all|every)\s+creatures?\s+(?:in|within)\b/i;
/** Текст адресует только врагов автора: шагам «к цели» нужен who: "enemy". */
export function enemiesOnly(html) {
  const t = detectText(html), m = ENEMY_AREA.exec(t);
  return !!m && !ALLIES_TOO.test(t) && !CREATURES_FIRST.test(t.slice(0, m.index));
}
// второе испытание («must attempt another Will save with the following effects»): блоки степеней после него относятся к нему, а не к первому; «another save to end it» — не оно
const SECOND_SAVE = /\b(?:another|a\s+(?:new|second)|an\s+additional|new)\s+(?:\w+\s+)?(?:save|saving\s+throw)\b[^.]*?\b(?:the\s+following|these\s+results|as\s+follows)|(?:снова|повторн\p{L}*)\s+[^.]{0,40}спасбросок[^.]*?следующ/iu;
// «Make a Strike… If it hits / On a critical hit, the target must attempt a save»: испытание зависит от исхода Удара
const STRIKE_HIT = String.raw`(?:if\s+(?:the\s+Strike|it|that\s+Strike|this\s+Strike|the\s+attack|your\s+attack|you|he|she|they|the\s+target\s+is)\s+(?:hits?|succeeds?(?!\s+(?:at|on)\b)|damages?\b|(?:is|was)\s+(?:successful|a\s+(?:critical\s+)?(?:hit|success)))|if\s+successful|on\s+a\s+(?:critical\s+|successful\s+)?hit|on\s+a\s+success(?:ful\s+Strike)?|critical\s+success\s+on\s+your\s+attack\s+roll|(?:critically\s+)?hits?\s+(?:the|a|that|your)\s+(?:target|creature)|hit\s+by\s+(?:one\s+of\s+)?(?:these|this|the|that)\s+Strikes?|that\s+are\s+successful|critical(?:ly)?\s+hit(?!\s+by)|critically\s+succeed\s+(?:on|at|with)\s+a\s+Strike|(?:if|when)\s+(?:the\s+)?Strike\s+(?:hits|deals\s+damage|damages))`;
// save не «к спасброску» («–2 to its save», «the same save»): штраф, а не испытание; «triggering Strike» — Удар чужой, это триггер реакции
const STRIKE_GATE = new RegExp(String.raw`\bStrikes?\b(?<!triggering\s+Strike)[^]{0,300}?\b${STRIKE_HIT}\b[^.]{0,200}?(?<!\b(?:to|its|their|your|his|her|any|of|same)\s(?:(?!(?:attempt|make|succeed)\b)[\w–-]+\s){0,3})(?:\bsaves?\b|saving\s+throws?)`, "i");
/** Испытание привязано к исходу Удара: при использовании его не бросать (нужен примитив strike-gate, ROADMAP пачка 7). */
// Requirements/Trigger до Effect (или черты <hr>) — предусловие («ваше последнее действие — Удар, критически попавший»), а не сам Удар (Fearful Symmetry, Dreamcrusher, Violent Exorcism)
export const strikeGate = (html) => STRIKE_GATE.test(detectText(html).replace(/\b(?:Requirements?|Trigger)\b.{0,400}?(?=\bEffect\b|---)/g, " "));
/** Одно и то же who у всех шагов «к цели» всех степеней испытания -> оно, иначе null: испытание бросают только такие цели (saves.challengeTargets). */
export function challengeWho(ch) {
  const w = new Set(Object.values(ch?.byDegree ?? {}).flat().filter((a) => a.to === "target").map((a) => a.who ?? null));
  return w.size === 1 ? [...w][0] : null;
}
/** Шагам «к цели» (apply и степени испытания/проверки) ставит who. */
export function setWho(onUse, who) {
  for (const l of [onUse?.apply, ...Object.values(onUse?.challenge?.byDegree ?? {}), ...Object.values(onUse?.check?.byDegree ?? {})]) for (const a of l ?? []) if (a.to === "target") a.who ??= who;
}
/** Шагам effect (кроме значка) onUse ставит replace: true. */
export function markReplace(onUse) {
  for (const l of [onUse?.apply, ...Object.values(onUse?.challenge?.byDegree ?? {}), ...Object.values(onUse?.check?.byDegree ?? {})]) for (const a of l ?? []) if (a.effect && !a.effect.badge) a.effect.replace = true;
}
export function deriveFromMarkup(itemLike, labels, conditionSlugByUuid, condNames = null) {
  const html = itemLike?.system?.description?.value;
  if (!isStr(html)) return null;
  const sys = itemLike.system;
  const type = itemLike.type;
  const hints = { inflicts: [], conditions: [], effects: [], unresolved: [], excluded: [], possible: [], lowWhy: [], template: false };
  const condSlug = (u) => conditionSlugByUuid?.(u) || null;

  const { blocks, markers } = parseBlocks(html, labelMap(labels));
  const outside = stripBlocks(html, markers);
  const { terms, linked: linkedAll } = plainTerms(html, condNames, condSlug);
  const hasTemplate = /@Template\[/.test(html);
  hints.template = hasTemplate;
  const area = hasTemplate || (type === "spell" && !!sys.area);

  // @Check: первое испытание-спасбросок
  let check = null;
  const saveAts = [];
  for (const m of html.matchAll(/@Check\[([^\]]*)\]/g)) {
    const c = parseCheck(m[1]);
    if (SAVES.includes((c.type ?? "").split(",")[0])) saveAts.push(m.index);
    for (const i of (c.params.options ?? "").split(",")) if (i.startsWith("inflicts:")) hints.inflicts.push(i.slice(9));
    const t = (c.type ?? "").split(",")[0];
    // из нескольких спасбросков берём тот, что накладывает состояние (inflicts:), а не «or die» (Bloody Guillotine)
    const infl = (x) => (x.params.options ?? "").includes("inflicts:");
    if (SAVES.includes(t) && (!check || (!infl(check) && infl(c)))) check = { ...c, type: t, at: m.index };
  }
  const save = sys.defense?.save;
  const itemDur = itemDuration(sys.duration);

  const outLinks = linksOf(outside, condSlug, hints);
  hints.conditions = [...outLinks.conds.map((c) => c.slug), ...outLinks.timed];
  hints.effects = outLinks.effects;

  const mk = (onUse, confidence, extra = {}) => {
    if (REPLACES.test(plainOf(html))) markReplace(onUse);
    if (enemiesOnly(html)) setWho(onUse, "enemy");
    const v = validateRule({ v: RULE_VERSION, ...(itemLike.name && { label: itemLike.name }), onUse });
    return v.ok ? { rule: v.rule, confidence, hints, ...extra } : null;
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
    // подписанных блоков нет — провал и крит. провал берём из предложений
    if (!Object.keys(blocks).length) {
      // только текст этого спасброска: от его предложения до предложения со следующим спасброском (у документа их несколько — Holy Host, Bloody Guillotine)
      const sentAt = (i) => Math.max(html.lastIndexOf(". ", i), html.lastIndexOf("</p>", i), html.lastIndexOf("<p>", i), html.lastIndexOf("<hr", i)) + 1;
      const nextAt = saveAts.find((x) => x > (check?.at ?? -1) && check);
      const p = proseBlocks(check ? html.slice(sentAt(check.at), nextAt != null ? sentAt(nextAt) : html.length) : html, condSlug);
      Object.assign(blocks, p.blocks);
      for (const x of p.possible) if (!hints.possible.includes(x)) hints.possible.push(x);
    }
    const entries = {};
    for (const [deg, text] of Object.entries(blocks)) {
      const { conds, effects, timed } = linksOf(text, condSlug, hints);
      const fl = {};
      for (const slug of [...timed, ...addPlainConds(text, conds, terms, linkedAll, itemDur, fl)]) if (!hints.possible.includes(`${deg}:${slug}`)) hints.possible.push(`${deg}:${slug}`);   // имя без ссылки и значения — только подсказка
      for (const c of conds) if (NOT_ON_TARGET.has(c.slug)) hints.excluded.push(`${deg}:${c.slug}`);
      const pers = persistentOf(text, { outside, html });
      if (pers.possible && !hints.possible.includes(`${deg}:persistent-damage`)) hints.possible.push(`${deg}:persistent-damage`);
      entries[deg] = { conds, effects, pers: pers.steps, ref: refDegree(text), fl, ownDur: conds.some((c) => c.duration), neg: /(?<!\p{L})(?:instead|value|increase[sd]?|decrease[sd]?|вместо|значение)(?!\p{L})/iu.test(text.replace(/<[^>]*>/g, " ")) };
    }
    // «As failure, but Clumsy 2»: то, что блок не переопределил, берётся у названной степени; срок — у состояния с тем же именем. «but not/instead» — наследуем только срок
    for (let pass = 0; pass < 2; pass++) for (const e of Object.values(entries)) {
      const r = e.ref && entries[e.ref];
      if (!r || r === e) continue;
      for (const rc of r.conds) {
        const mine = e.conds.find((c) => c.slug === rc.slug);
        if (mine) { if (!mine.duration && rc.duration) mine.duration = rc.duration; } else if (!e.neg) e.conds.push({ ...rc });
      }
      if (!e.neg) {
        for (const u of r.effects) if (!e.effects.includes(u)) e.effects.push(u);
        if (!e.pers.length) e.pers = [...r.pers];
      }
    }
    // low: срок и последовательность, которых правилом не выразить, и повтор испытания (блоки степеней — не первого)
    const why = new Set();
    if (SECOND_SAVE.test(detectText(html.slice(0, markers[0]?.start ?? 0)))) why.add("second-save");
    for (const [deg, e] of Object.entries(entries)) {
      if (e.fl.seq) why.add("sequence");
      const termText = e.fl.termText || [e.ref, entries[e.ref]?.ref].some((r) => entries[r]?.fl.termText);
      // срок есть в тексте, но состоянию он не достался (не выводится, не вплотную, «не кончается со сроком заклинания»); убывающие сами — без срока
      if (e.conds.some((c) => !c.duration && !NOT_ON_TARGET.has(c.slug) && !ENDS_EARLY.has(c.slug) && c.slug !== "persistent-damage" && termText) || (e.fl.keep && e.conds.some((c) => c.duration)) || (e.ref && e.fl.termText && !e.ownDur && e.conds.some((c) => c.duration))) why.add("duration");
    }
    hints.lowWhy.push(...why);
    for (const [deg, e] of Object.entries(entries)) {
      const list = [...e.conds.filter((c) => !NOT_ON_TARGET.has(c.slug)).map((c) => condApply(c, "target")), ...e.effects.map((uuid) => ({ to: "target", effect: { uuid } })), ...e.pers.map((p) => ({ to: "target", persistent: p }))];
      if (list.length) challenge.byDegree[deg] = list;
    }
    // strikeGate: правило остаётся (голова испытания нужна ограждениям тёзок в resolveRule), но в рантайм и в «готово» не идёт
    return mk({ targets: targetsOf(), excludeSelf: null, zone: null, challenge, apply: [] }, why.size ? "low" : "high", strikeGate(html) ? { strikeGate: true } : {});
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
    try { return await resp.json(); } catch (e) { warn(`rules/${name}: битый JSON`, e); if (!optional) throw e; return null; }   // битый необязательный файл не должен ронять остальные каталоги
  };
  const [cat, campaign, pa, model, onhit, labels] = await Promise.all([get("catalog.json"), get("catalog.campaign.json", true), get("catalog.pa.json", true), get("catalog.model.json", true), get("catalog.onhit.json", true), get("labels.json")]);
  // при совпадении ключа побеждает последний: автоматический перенос PA — первым, проверенные вручную — после
  // model (tools/drafts.mjs): черновики пачек от Haiku/Sonnet, прошедшие валидатор и выборку
  return initCatalog([pa, model, onhit, cat, campaign].filter(Boolean), labels);   // onhit (tools/onhit.mjs): «при попадании Удара — состояние» по тексту; ручные каталоги главнее
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
  if (!game.user.isGM) throw new Error("saveWorldRule: только ведущий");
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

/** Правила с onEvent из каталогов (ключ = source uuid | slug) — для events.mjs. Пересборка только при смене каталога (встроенный/мировой). */
let evCache = { b: null, w: null, idx: null };
export function onEventIndex() {
  const w = worldCatalog();
  if (evCache.b === builtin && evCache.w === w) return evCache.idx;
  const idx = new Map();
  for (const cat of [builtin, w]) {   // мировой перекрывает встроенный
    for (const m of [cat.bySlug, cat.bySource]) for (const [k, r] of m) {
      if (r.onEvent?.length) idx.set(k, r); else idx.delete(k);
    }
  }
  evCache = { b: builtin, w, idx };
  return idx;
}

/** [имя, slug] состояний: slug (англ.) и локализованное имя из CONFIG.PF2E.conditionTypes. */
function runtimeCondNames() {
  const out = [];
  for (const [slug, key] of Object.entries(globalThis.CONFIG?.PF2E?.conditionTypes ?? {})) {
    out.push([slug.replace(/-/g, " "), slug], [game.i18n.localize(key), slug]);
  }
  return out;
}

/** Ключ bySlug с типом: "slug@type" — правило только для документов этого типа (у тёзки другого типа свой смысл). Без типа — для любого. */
export const slugTypeKey = (slug, type) => `${slug}@${type}`;
export const bySlugOf = (map, slug, type) => (type && map.get(slugTypeKey(slug, type))) || (type !== "campaignFeature" && map.get(slug)) || null;   // армейские способности (Kingmaker) делят slug с обычными действиями: общий slug-ключ их не касается

/** Правило — ровно selfEffect самого документа: pf2e применяет его сам, второй раз не нужно. */
export function isSelfEffectOnly(rule, selfEffect) {
  const u = rule?.onUse;
  return !!selfEffect && !!u && !u.challenge && !u.check && !u.zone && !rule.onAttacked && !rule.onEvent?.length && !rule.macros?.length && u.apply.length > 0
    && u.apply.every((a) => a.to === "self" && a.effect?.uuid === selfEffect && !a.effect.replace && !a.duration);
}

/**
 * Правило по slug (без источника у документа) не годится документу-тёзке: ручное правило «проверка автора» против способности NPC со спасброском (ловушка «Shove»).
 * derived — правило, выведенное из разметки этого документа.
 */
export const slugCollides = (rule, derived, slug = null, html = "") => !!rule?.onUse?.check && (!!derived?.onUse?.challenge || (!!slug && new RegExp(String.raw`\[\[/act ${slug}\b`).test(html)));

/**
 * Правило-проверка (onUse.check) или правило-макрос по slug не годится тёзке без источника, в чьём описании нет собственного броска: ни `[[/act <slug>]]`, ни `@Check` нужной статистики
 * (у макроса — любого `@Check`). Intimidating Strike у Zashathal делегирует `[[/act demoralize]]` (наш обработчик бросил бы Удар), Disarm у Werendegar бросков не имеет.
 */
export const lacksOwnRoll = (rule, slug, html) => {
  const stats = rule?.onUse?.check ? [rule.onUse.check.statistic].flat() : null, text = html ?? "";
  if (!stats && !rule?.macros?.length) return false;
  if (slug && new RegExp(String.raw`\[\[/act ${slug}\b`).test(text)) return false;
  // макрос — только копия, делегирующая чужому действию (`[[/act X]]`, X ≠ slug): Удар сам по себе нашей обработкой не лишний
  if (!stats) return [...text.matchAll(/\[\[\/act\s+([a-z0-9-]+)/g)].some((m) => m[1] !== slug);
  return !new RegExp(String.raw`@Check\[(?:${stats.join("|")})\b|\b(?:${stats.join("|")})\b`, "i").test(text);
};

/** dc {expr:"markup"}: голова испытания (статистика, СЛ, «базовое», опции) — из спасброска в тексте самого документа; копии одной способности у разных NPC различаются именно этим. */
const plainOf = (html) => String(html ?? "").replace(/<hr\s*\/?>/gi, "\n---\n").replace(/<\/(p|li|tr|h\d|div)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&rsquo;/g, "'").replace(/\s+/g, " ").trim();
const IMM_RE = /immun|(?:isn['’]t|can['’]t|cannot)\s+(?:be\s+)?affected\s+by\b[^.]*\bfor\s+\d+\s+(?:minute|hour|day)/i;

/**
 * Что текст говорит об иммунитете после испытания: {has, degrees: null (при любой) | [степени] | undefined (текст не уточняет), anySource: «ко всем существам вида»}.
 * Подпись степени перед фразой («Critical Success … immune») важнее оборота в предложении.
 */
export function immunityFromText(html) {
  html = String(html ?? "");
  const text = plainOf(html.replace(/@UUID\[[^\]]*\](?:\{([^}]*)\})?/g, "$1"));   // точки внутри Compendium.pf2e… не должны рвать предложения
  if (!IMM_RE.test(text)) return { has: false };
  const at = html.search(IMM_RE);
  const noCrit = !/<(?:strong|b)>\s*Critical Success/i.test(html);   // pf2e: нет строки крит. успеха — крит. успех = успех
  const mark = [...html.slice(0, at).matchAll(/<(?:strong|b)>\s*(Critical Success|Success|Failure|Critical Failure)\s*<\/(?:strong|b)>/gi)].pop();
  const sent = text.split(/(?<=[.!?])\s+/).find((s) => IMM_RE.test(s)) ?? "";
  const lc = (s) => s[0].toLowerCase() + s.slice(1).replace(/ (\w)/, (_, c) => c.toUpperCase());
  let degrees;
  if (mark && at - (mark.index + mark[0].length) < 400 && !/<hr/i.test(html.slice(mark.index, at))) degrees = lc(mark[1]) === "success" && noCrit ? ["success", "criticalSuccess"] : [lc(mark[1])];
  else if (/regardless|whether or not|no matter|after the (?:saving throw|save)/i.test(sent) || (/\b(?:is|are|it is) then\b|\bthen (?:temporarily )?immune/i.test(sent) && !/succe|fail/i.test(sent))) degrees = null;
  else if (/\b(?:and|,)\s+(?:is|are|it is|they are)\s+then\s+(?:temporarily\s+)?immun/i.test(sent)) degrees = null;   // «…or be X and is then immune» (Commanding Presence): при любом исходе
  else if (/\bon a (?:success|successful save)\b|\bif (?:it|they|the creature) succeeds\b/i.test(sent)) degrees = ["success", "criticalSuccess"];   // «…or become X; on a success, … immune» (Mindfog Aura)
  else if (/\bsave or (?:be|become)\b[^.]*\b(?:and|is|become|becomes)\b[^.]*immun/i.test(sent)) degrees = ["failure", "criticalFailure"];
  else if (/critical(?:ly)? succe/i.test(sent)) degrees = ["criticalSuccess"];
  else if (/succe(?:ed|ss)/i.test(sent)) degrees = ["success", "criticalSuccess"];
  else if (/\bfail/i.test(sent)) degrees = ["failure", "criticalFailure"];
  return { has: true, degrees, anySource: /(?:immune\s+to|affected\s+by)\s+(?:all|any|further)\b/i.test(sent) };
}

/** Срок иммунитета из предложения про него («immune … for 24 hours») -> {value, unit} | null. */
export function immunityDuration(html) {
  const text = plainOf(String(html ?? "").replace(/@UUID\[[^\]]*\](?:\{([^}]*)\})?/g, "$1"));
  const sent = text.split(/(?<=[.!?])\s+/).find((s) => IMM_RE.test(s)) ?? "";
  const FOR = /\bfor\s+(\d+)\s+(minute|hour|day)s?\b/i, at = sent.search(IMM_RE);
  const m = FOR.exec(sent.slice(Math.max(at, 0))) ?? FOR.exec(sent);   // срок, что после «immune» (Aura of Blinding Light: «Blinded for 1 minute and … immune for 1 day»)
  return m && +m[1] >= 1 ? { value: +m[1], unit: `${m[2].toLowerCase()}s` } : null;
}

/**
 * dc {expr:"markup"}: «текст копии решает». Голова испытания (статистика, СЛ, «базовое», опции) — из спасброска в тексте; степени — из текста, если в каталоге их нет;
 * иммунитет: каталог даёт slug, а степени, охват (scope) и срок — текст копии; английский текст без иммунитета — правило без иммунитета.
 */
function withMarkupHead(rule, derived, html = "") {
  const c = rule.onUse?.challenge, d = derived?.onUse?.challenge;
  if (c?.dc?.expr !== "markup" || !d || d.dc.source) return rule;
  const { options, traits, immunity, ...rest } = c;
  const byDegree = Object.keys(c.byDegree ?? {}).length ? c.byDegree : d.byDegree;
  // английский текст об иммунитете молчит — его нет и в правиле (PA ставит иммунитет и там, где текст требует повторять спасбросок); русский текст разбирать нечем — иммунитет каталога как есть
  let imm = immunity && (immunityFromText(html).has || /[Ѐ-ӿ]/.test(html)) ? immunity : null;
  if (immunity && immunityFromText(html).has) {
    const t = immunityFromText(html), { degrees, scope, duration, ...head } = immunity, du = immunityDuration(html);
    imm = { ...head, duration: du ?? duration, ...(t.degrees === undefined ? { ...(degrees && { degrees }) } : t.degrees && t.degrees.length < DEGREES.length && { degrees: DEGREES.filter((x) => t.degrees.includes(x)) }), ...(t.anySource && { scope: "slug" }) };
  }
  return { ...rule, onUse: { ...rule.onUse, challenge: { ...rest, byDegree, ...(imm && { immunity: imm }), statistic: d.statistic, dc: d.dc, basic: d.basic, ...(d.options && { options: d.options }), ...(d.traits && { traits: d.traits }) } } };
}

/** Есть ли у правила шаги, которые что-то применяют (apply, степени испытания/проверки, зона). */
const hasSteps = (r) => !!(r.onUse?.apply?.length || r.onUse?.zone || [r.onUse?.challenge, r.onUse?.check].some((c) => Object.values(c?.byDegree ?? {}).some((l) => l.length)));

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
  const type = item?.type ?? origin?.type ?? null;
  const r = (sourceUuid && w.bySource.get(sourceUuid)) || (slug && bySlugOf(w.bySlug, slug, type));
  if (r) return found(r, "world");
  // byName — способности NPC без slug и источника (имя предмета как в мире; slug pf2e из имени ненадёжен для кириллицы)
  const named = !sourceUuid && !(item?.system?.slug) ? (item?.name ?? origin?.name ?? null) : null;
  const bySrc = sourceUuid ? builtin.bySource.get(sourceUuid) : null;
  let memo, memoed = false;   // вывод из разметки один раз на вызов (ограждение тёзок, голова испытания и сам вывод)
  const derive = () => {
    if (!memoed) {
      memoed = true;
      memo = item?.system && labelsData ? deriveFromMarkup({ type: item.type, slug, name: item.name, system: item.system }, labelsData, (uuid) => game.pf2e.ConditionManager.conditions.get(uuid)?.slug ?? null, runtimeCondNames()) : null;
    }
    return memo;
  };
  let b = bySrc || (slug && bySlugOf(builtin.bySlug, slug, type)) || (named && builtin.byName?.get(named));
  if (b && !bySrc && item?.system) {   // правило нашлось только по slug: проверить, что это та же способность
    if (isSelfEffectOnly(b, item.system.selfEffect?.uuid)) b = null;
    else if (!sourceUuid && b.onUse?.check && slugCollides(b, derive()?.rule, slug, item.system.description?.value ?? "")) b = null;
    else if (!sourceUuid && slug && lacksOwnRoll(b, slug, item.system.description?.value ?? "")) b = null;
    // «СЛ из текста» у тёзки, в чьём описании спасброска нет (пассив с тем же slug): не его способность
    else if (!sourceUuid && b.onUse?.challenge?.dc?.expr === "markup" && labelsData && !derive()?.rule?.onUse?.challenge) b = null;
  }
  if (b) return found(b.onUse?.challenge?.dc?.expr === "markup" ? withMarkupHead(b, derive()?.rule, item?.system?.description?.value ?? "") : b, "catalog");

  const d = derive();
  // живой вывод из разметки сам не исполняется (выборки: ~половина high неверна): шаги — только кнопкой ведущего (low);
  // проверенные правила документов компендия приходят из каталога (rules/catalog.model.json). Голова без шагов (спасбросок) — как вывел
  if (d && !d.strikeGate) return found(d.rule, "markup", hasSteps(d.rule) ? "low" : d.confidence, d.hints);
  return null;
}
