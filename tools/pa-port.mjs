// Перенос pf2e-automations (PA) в нашу схему: механически переводимое -> rules/drafts/pa-port.json,
// остальное — rule:null с причиной (список причин = будущие примитивы схемы). Выход: tools/out/pa-port.json (сводка и «долги переноса»).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, ACCEPTED, AUTOMATIONS_CONFIG, cmp, readJson, readOut, writeJson, writeText, outPath, isMain, arg, stripHtml } from "./lib.mjs";
import { makeContext, BATCHES } from "./triage.mjs";
import { buildAutomationsIndex } from "../scripts/compat.mjs";
import { STEP_DAMAGE_TYPES, deriveFromMarkup, REPLACES, markReplace, validateRule, parseCheck, slugTypeKey, isSelfEffectOnly, slugCollides, lacksOwnRoll, immunityFromText, immunityDuration } from "../scripts/rules.mjs";
import { DEGREES } from "../scripts/util.mjs";
import { isPredicate } from "../scripts/predicate.mjs";
import { roundTrip } from "./validate.mjs";
import { paRules, simulate } from "./pa-sim.mjs";
import { CARRIERS } from "./pa-carriers.mjs";
import { EV_ON, EV_ALWAYS, EV_ROLLS, EVENT_HANDLERS, eventWhen, eventWho, withMarks } from "./pa-events.mjs";

// причины, где нужна ручная работа, а не новый примитив схемы
export const MANUAL_REASONS = new Set(["pa-own-effect", "effect-missing", "no-roll-def", "no-save-def", "invalid", "unknown", "unmatched", "cond-unknown", "slug-mismatch", "low"]);
// feat:/feature:/spell: — условие «у актёра есть чужой фит/заклинание», безвредно только если это сам предмет (OWN)
const IDENT = /^(?:origin:)?(?:item|action|consumable)(?::slug)?:[a-z0-9-]+$|^outcome:/;
const OWN = /^(?:origin:)?(feat|feature|spell):(?:slug:)?([a-z0-9-]+)$/;
const TIER = /-(minor|lesser|moderate|greater|major|true)$/;
const ABILITY = new Set(["action", "feat", "campaignFeature"]);
// обработчик PA повторяет selfEffect самого предмета (Hunt Prey у PC-действия); у копий NPC selfEffect нет — это долг 0.5e
const NATIVE_HANDLERS = new Set(["huntPrey"]);
// обработчик PA -> встроенный обработчик модуля (scripts/builtin), срабатывающий по признаку данных pf2e, а не по списку имён. Правило PA с таким handler
// не остаётся долгом; остальные правила группы (Swallow Whole: проверка Атлетики и эффект) переводятся как обычно.
export const BUILTIN_HANDLERS = {
  huntPrey: "hunt-prey", rageImmunity: "rage", deleteHoldingBreath: "suffocation", suffocatingEndTurn: "suffocation",
  grab: "strike-effects", grabImproved: "strike-effects", grapple: "strike-effects", push: "strike-effects", knockdown: "strike-effects",
  theOscillatingWave: "oscillating-wave", theOscillatingWaveRefocus: "oscillating-wave"
};
// 0.5g6 (отдельно от 0.5e: tests/builtin.pa-handlers.test.mjs ждёт у BUILTIN_HANDLERS подпачку 0.5e): щит прикрывает союзника, трата слота как реакция, чутьё, доля добычи
export const GROUP_HANDLERS = {
  shieldWarden: "shield-ward", shieldWardenDamageTaken: "shield-ward", devotedGuardian: "shield-ward", channelingBlock: "channeling-block",
  apparitionSense: "apparition-sense", wardensBoon: "prey-share", sharedPrey: "prey-share",
  extendSmite: "smite"   // 0.5g4: враг с меткой Кары совершил враждебное действие — Кара продлевается (scripts/builtin/smite.mjs)
};
// 0.5g6: эффекты PA без правил и описания (kind script в tools/pa-effects.json), которые ведёт встроенный обработчик: Life Link, Share Life (damage-link)
export const SCRIPT_EFFECTS = { eMGGHi8bIib0mMeF: "damage-link", uWkVsnSFdvIdGEwI: "damage-link" };
// 0.5g5: временная броня и щиты от эффекта (scripts/builtin/gear.mjs, флаг gear на эффектах пака)
export const GEAR_HANDLERS = Object.fromEntries(["armorInEarth", "hardwoodArmor", "metalCarapace", "hardwoodArmorShield", "metalCarapaceShield", "deleteArmorInEarth", "deleteHardwoodArmor", "deleteMetalCarapace", "deleteHardwoodArmorShield", "deleteMetalCarapaceShield", "blazingArmoryDelete"].map((h) => [h, "gear"]));
const builtinOf = (r) => (r.type === "handler" ? BUILTIN_HANDLERS[r.value] ?? GROUP_HANDLERS[r.value] ?? GEAR_HANDLERS[r.value] : SCRIPT_EFFECTS[/pf2e-automations\.effects\.Item\.(\w+)$/.exec(r.value)?.[1]]);
const isBuiltin = (r) => !!builtinOf(r);
const slugify = (s) => String(s).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const SAVES = ["fortitude", "reflex", "will"];
const IMM_UNITS = ["minutes", "hours", "days"];
const MARKER = "activity-marker";   // иконка активности исследования: не переносится по решению пользователя
const UNITS = { rounds: "rounds", minutes: "minutes", hours: "hours", days: "days" };

const tokensOf = (p, out = []) => {
  if (typeof p === "string") out.push(p);
  else if (Array.isArray(p)) p.forEach((x) => tokensOf(x, out));
  else if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) if (["or", "and", "not", "nor"].includes(k)) out.push(...(k === "not" ? ["not"] : []), ...tokensOf(v));   // операнды сравнений — числа и roll option, слугов в них нет
  return out;
};
/** Ключи предиката кроме or/and/not (gte, lt, eq…): сравнения мы не переносим, значит, правило может быть шире, чем у PA. */
export const predicateOps = (p, out = new Set()) => {
  if (Array.isArray(p)) p.forEach((x) => predicateOps(x, out));
  else if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) { if (!["or", "and", "not"].includes(k)) out.add(k); predicateOps(v, out); }
  return out;
};
/** Совместим ли триггер PA с типом документа. */
export const triggerFits = (tr, it) => {
  const act = ["action", "feat", "campaignFeature"].includes(it.type), live = act && it.actionType !== "passive";   // у пассива правило на использование мёртвое
  if (tr === "spell-cast") return it.type === "spell" || live;   // заклинание-подобная способность NPC — действие
  if (tr === "use") return live || (!act && it.type !== "spell");
  if (tr === "postInfo") return act;   // карточка пассивки в чате = её использование, как у PA (use.mjs useKindOf: feat/action -> "use")
  return !(act && it.actionType === "passive");
};
/** Чужие условия feat:/feature:/spell: предиката с полярностью (not переворачивает): [{tok, pol}]. */
export const foreignConds = (p, slug, pol = true, out = []) => {
  if (typeof p === "string") { const m = OWN.exec(p); if (m && m[2] !== slug) out.push({ tok: p, pol }); }
  else if (Array.isArray(p)) p.forEach((x) => foreignConds(x, slug, pol, out));
  else if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) if (k === "not") foreignConds(v, slug, !pol, out); else if (["or", "and", "nor"].includes(k)) foreignConds(v, slug, pol, out);
  return out;
};
const strongSlugs = (toks) => toks.map((t) => /^(?:origin:)?(?:item(?::slug)?|consumable|action):([a-z0-9-]+)$/.exec(t)?.[1]).filter(Boolean);

/** Степень в имени эффекта PA: «… (Success)», «Jinx Critical Failure» -> ключ DEGREES. */
export const nameDegree = (name) => {
  const m = /\((critical success|critical failure|success|failure)\)|\b(critical success|critical failure|success|failure)\s*$/i.exec(name ?? "");
  const w = (m?.[1] ?? m?.[2])?.toLowerCase();
  return w && w.replace(/ (\w)/, (_, c) => c.toUpperCase());
};
/** Срок эффекта {value,unit,expiry} с переопределением из правила PA {value?,unit?,expiry?}: единица и значение — из правила, недостающее — из эффекта. -> {duration|null, low?} */
export function overrideDuration(own, dur) {
  if (!dur || !(dur.unit || (dur.value != null && dur.value !== ""))) return { duration: own ?? null };
  const dice = typeof dur.value === "string" && DICE_DUR.test(dur.value.trim());   // «1d4» — бросается при выдаче (0.5g4)
  const unit = dur.unit ?? own?.unit, value = dice ? dur.value.trim().toLowerCase() : dur.value != null && dur.value !== "" ? +dur.value : own?.value;
  if (unit === "unlimited") return { duration: null };
  if (!UNITS[unit] || !(dice || (Number.isInteger(value) && value >= 0))) return { duration: null, low: "duration-override-unknown" };
  const expiry = dur.expiry ?? own?.expiry ?? null;
  const d = { value, unit, expiry: ["turn-start", "turn-end"].includes(expiry) ? expiry : null };
  return dice || d.value >= 1 || d.expiry === "turn-end" ? { duration: d } : { duration: null, low: "duration-override-unknown" };
}
const DICE_DUR = /^\d+d\d+$/i;
/** Срок правила PA совпадает со сроком самого эффекта. */
const sameDuration = (dur, own) => (dur.unit == null || dur.unit === own?.unit) && (dur.value == null || dur.value === "" || +dur.value === own?.value);
/** Срок правила PA у шага effect: отличается от срока самого эффекта — duration у шага (0.5g4); срока эффекта не знаем или правило невыразимо — без срока, причина в lows. -> {duration?} */
const stepDuration = (dur, own, lows) => {
  if (!dur || (own ? sameDuration(dur, own) : !(dur.unit && dur.value != null && dur.value !== ""))) return {};   // срока эффекта не знаем: берём лишь полное переопределение (значение и единица)
  const d = overrideDuration(own, dur);
  if (d.low || !d.duration) { lows.push(d.low ?? "effect-duration-override"); return {}; }
  return { duration: d.duration };
};

/** Усиление «Heightened (3rd) … range is touch / targets 1 willing creature» с кругом <= rank: с него заклинание можно наложить на другого (Ночное зрение). */
export const heightenedTargets = (html, rank) => [...stripHtml(html ?? "").matchAll(/Heightened\s*\((\d+)(?:st|nd|rd|th)\)\s*([\s\S]*?)(?=Heightened\s*\(|$)/g)].some((m) => +m[1] <= rank && /\b(?:targets?|touch)\b/i.test(m[2]));
/** Одинаковые шаги с разными rank, вместе покрывающие круги 1..10 (Ускорение «до 6» и «с 7»), — один шаг без rank: PA делил их на разные числа целей, шаг один и тот же. */
export function mergeRanks(list) {
  const key = (a) => JSON.stringify({ ...a, rank: undefined });
  const out = [], done = new Set();
  for (const a of list) {
    const k = key(a);
    if (!a.rank || done.has(k)) { if (!a.rank || !done.has(k)) out.push(a); continue; }
    const same = list.filter((b) => b.rank && key(b) === k), seen = new Set();
    for (const b of same) for (let r = b.rank.min ?? 1; r <= (b.rank.max ?? 10); r++) seen.add(r);
    done.add(k);
    if (seen.size === 10) out.push({ ...a, rank: undefined });
    else out.push(...same);
  }
  return out.map((a) => { const { rank, ...rest } = a; return rank ? a : rest; });
}
const BADGE_TEXT = { sBB3VElfaqa9ZYyL: /\{Enfeebled (\d+)\}/ };   // эффект нашего пака -> где в тексте предмета его значок (PA прибавляет 1 и создаёт со значком пака; тексты копий расходятся)
const RANK_KEYS = new Set(["origin:item:level", "origin:item:rank", "item:level", "item:rank"]);
/** Сравнения круга/уровня предмета на верхнем уровне предиката (там И) -> {rank: {min?,max?}|null, rest: предикат без них}. lge — опечатка PA, читаем как gte. */
export function rankOf(p) {
  let min = null, max = null;
  const rest = [];
  for (const x of Array.isArray(p) ? p : p == null ? [] : [p]) {
    const e = x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 1 ? Object.entries(x)[0] : [];
    const [k, v] = e;
    if (["gte", "lge", "gt", "lt", "lte"].includes(k) && Array.isArray(v) && v.length === 2 && RANK_KEYS.has(v[0]) && Number.isInteger(v[1])) {
      const lo = { gte: v[1], lge: v[1], gt: v[1] + 1 }[k], hi = { lt: v[1] - 1, lte: v[1] }[k];
      if (lo != null) min = Math.max(min ?? 1, lo);
      if (hi != null) max = Math.min(max ?? 10, hi);
    } else rest.push(x);
  }
  const ok = (min == null || (min >= 1 && min <= 10)) && (max == null || (max >= 1 && max <= 10)) && (min == null || max == null || min <= max);
  return ok && (min != null || max != null) ? { rank: { ...(min != null && { min }), ...(max != null && { max }) }, rest } : { rank: null, rest: Array.isArray(p) ? p : p == null ? [] : [p] };
}

// Условие шага `when` (0.5g2): предикат PA без круга и тождеств предмета, если он целиком из настоящих опций pf2e (автор, цель, предмет, исход).
// Синтетические опции PA (channeling-block, mType:…) остаются «условием» для ручного разбора. У спасброска «self» PA — сам спасающийся, у нас автор: там условие не переносим.
// Только то, что реально собирает whenOptions (apply.mjs): опции автора (feat/feature/self), цели (target), origin сообщения, предмета (item), исход. spellcasting:*, spell:*, action:* pf2e в эти наборы не кладёт — остаются долгом.
const WHEN_OPT = /^(?!origin:item:sourceId)(?:feat|feature|self|target|origin|outcome):|^target$/;   // item:* нет: в рантайме это предмет правила, а не предмет броска (оружие в событии)   // sourceId — синтетическая опция PA
const WHEN_TRIGGERS = new Set(["use", "spell-cast", "postInfo", "self-effect", "skill-check", "attack-roll", "perception-check"]);
const optStrings = (p, out = []) => {
  if (typeof p === "string") out.push(p);
  else if (Array.isArray(p)) p.forEach((x) => optStrings(x, out));
  else if (p && typeof p === "object") for (const v of Object.values(p)) optStrings(v, out);
  return out;
};
const selfToTarget = (p) => (typeof p === "string" ? p.replace(/^self:/, "target:") : Array.isArray(p) ? p.map(selfToTarget) : p && typeof p === "object" ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, selfToTarget(v)])) : p);
/** rest — предикат без круга; drop(строка) — тождества предмета и исхода: термин, целиком из них (в т.ч. or/not над ними), в условие не идёт — как и раньше он игнорировался. -> массив when | null. */
export function whenOf(rest, drop) {
  const terms = rest.filter((x) => /"(?:gt|gte|lt|lte|lge|eq)"/.test(JSON.stringify(x)) || !optStrings(x).every((s) => drop(s)));   // сравнения — всегда условие
  return terms.length && isPredicate(terms) && optStrings(terms).every((s) => /^-?\d+(?:\.\d+)?$/.test(s) || WHEN_OPT.test(s)) ? terms : null;
}
/** Условие и его отрицание дают один шаг (Taunt: фит меняет лишь дальность) — шаг один, без условия. */
export function mergeWhen(list) {
  const key = (a) => JSON.stringify({ ...a, when: undefined });
  const neg = (w) => (w.length === 1 ? (typeof w[0]?.not === "string" ? [w[0].not] : typeof w[0] === "string" ? [{ not: w[0] }] : null) : null);
  const out = [];
  for (const a of list) {
    const twin = a.when && neg(a.when) ? out.findIndex((b) => b.when && key(b) === key(a) && JSON.stringify(b.when) === JSON.stringify(neg(a.when))) : -1;
    if (twin >= 0) { const { when, ...rest } = out[twin]; out[twin] = rest; } else out.push(a);
  }
  return out;
}
/** Slug эффекта в roll options pf2e: slug имени без префикса effect-/spell-effect-/stance- (EffectPF2e#getRollOptions). */
const optSlug = (name) => slugify(name).replace(/^(?:spell-)?(?:effect|stance)-/, "");
/** «Effect: Jinx Immunity», «Rousing Splash Immunity 10 minutes» -> slug иммунитета (jinx, rousing-splash). */
const immunitySlug = (name) => optSlug(name).replace(/-?immunity(?:-.*)?$/, "");
/** Опции «эффект-иммунитет PA есть» (self:effect:jinx-immunity…): у challenge/check иммунитет — свойство самого испытания, шаг-условие не нужен. */
const immunityOpt = (ctx, t) => { const m = /^(?:self|target|origin):effect:(.+)$/.exec(t); return !!m && Object.values(ctx.paEffects ?? {}).some((e) => e.kind === "immunity" && optSlug(e.name) === m[1]); };
/** Опция «есть наш эффект-метка иммунитета» (свой эффект пака, kind own): у PA slug без числа срока («…-immunity-minutes»). -> uuid эффекта | undefined. */
const immGate = (ctx, t) => {
  const m = /^(?:self|target|origin):effect:(.+)$/.exec(t), norm = (s) => s.replace(/-\d+(?=-|$)/g, "");
  const id = m && Object.entries(ctx.paEffects ?? {}).find(([, e]) => e.kind === "own" && /immunity/i.test(e.name) && norm(optSlug(e.name)) === norm(m[1]))?.[0];
  return id && `Compendium.pf2e-automato.effects.Item.${id}`;
};
/** Условие «эффект самого шага есть / нет» у шага значка лишнее: шаг сам смотрит на наличие эффекта (slug сравниваем, чужие эффекты остаются). -> предикат без них | null. */
const noPresence = (w, slug, gates = new Set()) => {
  const own = (t) => typeof t === "string" && (t === `self:effect:${slug}` || t === `target:effect:${slug}` || gates.has(t));
  const k = w.filter((t) => !own(t) && !own(t?.not));
  return k.length ? k : null;
};
/** Опция «эффект PA есть» -> опция состояния, если эффект PA у нас — одно состояние (pf2e выдаёт self:condition:<slug>). Эффект PA без точного эквивалента -> null (долг). Свой эффект пака и эффекты pf2e, которых нет в карте PA, остаются как есть. */
export function mapEffectOpts(p, paEffects, effects = {}) {
  let ok = true;
  const walk = (x) => {
    if (typeof x === "string") {
      const m = /^(self|target|origin):effect:(.+)$/.exec(x), e = m && Object.values(paEffects ?? {}).find((v) => optSlug(v.name) === m[2]);
      if (!e || e.kind === "own") return x;
      if (e.kind === "conditions" && e.steps.length === 1) return `${m[1]}:condition:${e.steps[0].slug}`;
      // эффект PA заменён эффектом pf2e (Bless: aura-bless -> bless): опция по slug замены
      if (e.kind === "pf2e" && effects[e.uuid]) return `${m[1]}:effect:${optSlug(effects[e.uuid])}`;
      ok = false;
      return x;
    }
    if (Array.isArray(x)) return x.map(walk);
    return x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x;
  };
  const out = walk(p);
  return ok ? out : null;
}

/** Один шаг PA -> наш шаг apply. Возвращает {steps[]} | {fail}. */
function stepsOf(r, who, ctx) {
  const names = [];   // имена эффектов PA, давших шаги (степень в имени сверяется с outcome: предиката)
  const out = stepsOf1(r, who, { ...ctx, paNames: names });
  return out.fail ? out : { ...out, names };
}
function stepsOf1(r, who, ctx) {
  const sub = (u) => ctx.subst?.[u] ?? u;   // пропавший id эффекта -> единственная ссылка на эффект в тексте предмета
  const mkTo = (to) => (x) => ({ to, ...x });
  /** Эффект PA -> шаги: свой пак / эквивалент pf2e (ссылка), только состояния (шаги condition), иконка активности (пропуск). Карта — tools/pa-effects.json. */
  const paEffect = (u, to, dur = null, lows = []) => {
    const id = /^Compendium\.pf2e-automations\.effects\.Item\.(\w+)$/.exec(u)?.[1], e = ctx.paEffects?.[id];
    if (!e) return { fail: "pa-own-effect" };
    if (e.kind !== "immunity" && e.kind !== "equipment") ctx.paUsed?.add(id);
    ctx.paNames?.push(e.name);
    if (e.kind === "script") return { fail: "script-effect" };
    if (e.kind === "own") return { uuid: `Compendium.pf2e-automato.effects.Item.${id}`, ...(e.replace && { replace: true }), ownDur: e.dur };
    if (e.kind === "pf2e") return { uuid: e.uuid, ownDur: e.dur };
    if (e.kind === "conditions") {
      const d = overrideDuration(e.duration, dur);
      if (d.low) lows.push(d.low);
      return { steps: e.steps.map((c) => mkTo(to)({ condition: { slug: c.slug, ...(c.value != null && { value: c.value }), policy: "max" }, ...(d.duration && { duration: { ...d.duration, of: "origin" } }) })) };
    }
    if (e.kind === "marker") return { steps: [] };
    if (e.kind === "immunity") {   // «X Immunity» PA: slug — из имени, срок — из имени («… 10 minutes») либо из текста предмета; степени уточнит immunityFromText
      const m = /(\d+)\s+(minute|hour|day)s?\b/i.exec(e.name), du = m ? { value: +m[1], unit: `${m[2].toLowerCase()}s` } : immunityDuration(ctx.html), slug = immunitySlug(e.name);
      if (slug && du) return { immunity: { slug, duration: du } };
      return immunityFromText(ctx.html).has ? { fail: "immunity-after-save" } : { absent: true };   // в тексте иммунитета нет вовсе (Ill Omen): PA его выдумал — шаг пропускаем, правило low
    }
    return { fail: "pa-own-equipment" };
  };
  /** Ссылка на эффект -> {steps}|{fail}: шаг effect либо то, во что эффект PA переведён. */
  const effect = (u, to, dur = null) => {
    if (u.startsWith("Compendium.pf2e-automations.")) {
      const lows = [], p = paEffect(u, to, dur, lows);
      if (p.fail) return p;
      if (p.immunity) return { steps: [], immunity: p.immunity };
      if (p.absent) return { steps: [], low: ["immunity-not-in-text"] };
      if (p.steps) return lows.length ? { ...p, low: lows } : p;
      return ctx.effects[p.uuid] ? { steps: [mkTo(to)({ effect: { uuid: p.uuid, ...(p.replace && { replace: true }) }, ...stepDuration(dur, p.ownDur, lows) })], ...(lows.length && { low: lows }) } : { fail: "effect-missing" };
    }
    // эффект Workbench, который мы написали сами под тем же id (pa-effects.authored.mjs): тот же путь, что у эффекта PA нашего пака
    if (u.startsWith("Compendium.xdy-pf2e-workbench.")) { const id = /(\w+)$/.exec(u)?.[1]; return ctx.paEffects?.[id]?.authored ? effect(`Compendium.pf2e-automations.effects.Item.${id}`, to, dur) : { fail: "external-effect" }; }
    // срок правила PA, отличный от срока эффекта pf2e, — duration у шага (See the Unseen: 8 часов против 10 минут); срока эффекта не знаем — шаг без срока, как раньше
    const lows = [], d = stepDuration(dur, ctx.effectDur?.[sub(u)], lows);
    return ctx.effects[sub(u)] || /\.conditionitems\./.test(u) ? { steps: [mkTo(to)({ effect: { uuid: sub(u) }, ...d })], ...(lows.length && { low: lows }) } : { fail: "effect-missing" };
  };
  const cond = (s) => {
    const m = /^([a-z-]+?)(?:\s+(\d+))?$/.exec(String(s).trim());
    return m && ctx.condSlugs.has(m[1]) ? { condition: { slug: m[1], ...(m[2] && { value: +m[2] }), policy: "max" } } : null;
  };
  const kind = r.target.replace(/^(?:SelfOrTargets?|Self|Targets?|Party)/, "") || r.target;
  const mk = (x) => ({ to: who, ...x });
  if (r.values) {   // complex
    const out = [];
    let markers = 0;
    const lows = [];
    let immunity = null;
    for (const v of r.values) {
      if (v.immunities?.length) {   // иммунитет после испытания: срок и slug — из значения PA; вместе с состояниями в одном значении срок не разделить
        const d = v.duration ?? {};
        if (immunity || v.immunities.length !== 1 || !/^[a-z0-9-]+$/.test(v.immunities[0]) || v.conditions?.length || v.effects?.length || !(Number.isInteger(+d.value) && +d.value >= 1 && IMM_UNITS.includes(d.unit))) return { fail: "immunity-after-save" };
        immunity = { slug: v.immunities[0], duration: { value: +d.value, unit: d.unit } };
        continue;
      }
      const dur = v.duration && Object.keys(v.duration).length ? v.duration : null;
      const hasVal = dur && dur.value != null && dur.value !== "";   // срок значения PA переопределяет срок эффекта (иногда лишь единицу: 1 раунд -> 1 минута); к шагам эффектов он применяется в effect()
      const dice = hasVal && DICE_DUR.test(String(dur.value).trim());   // кубик («1d4») — duration со строкой, бросается при выдаче; иная запись (формула) — долг
      if (hasVal && !dice && !Number.isInteger(+dur.value)) return { fail: "dice-duration" };
      const d = hasVal && UNITS[dur.unit] ? { value: dice ? String(dur.value).trim().toLowerCase() : +dur.value, unit: dur.unit, expiry: ["turn-start", "turn-end"].includes(dur.expiry) ? dur.expiry : null, of: "origin" } : null;
      for (const c of v.conditions ?? []) { const s = cond(c); if (!s) return { fail: "cond-unknown" }; out.push(mk({ ...s, ...(d && (dice || d.value >= 1) && { duration: d }) })); }
      for (const e of v.effects ?? []) { const x = effect(e, who, dur); if (x.fail) return x; if (!x.steps.length && x.low?.includes("immunity-not-in-text")) return { fail: "immunity-after-save" }; if (x.immunity) { if (immunity) return { fail: "immunity-after-save" }; immunity = x.immunity; continue; } out.push(...x.steps); lows.push(...x.low ?? []); markers += !x.steps.length && !x.low?.length; }
    }
    return out.length || immunity ? { steps: out, immunity, ...(lows.length && { low: [...new Set(lows)] }) } : { fail: markers ? MARKER : "unknown" };
  }
  // choiceSetSelection PA — готовый выбор ChoiceSet эффекта (Aldori: 5 / 10 временных ОЗ): шаг effect.choice (apply.mjs подставляет selection)
  if (kind === "Effect") { const x = effect(r.value ?? "", who); return x.fail ? x : x.immunity ? { steps: [], immunity: x.immunity } : x.low?.includes("immunity-not-in-text") ? x : !x.steps.length ? { fail: MARKER } : r.choiceSetSelection != null ? { ...x, steps: x.steps.map((s) => (s.effect ? { ...s, choice: r.choiceSetSelection } : s)) } : x; }
  if (kind === "AddCondition") { const s = cond(r.value); return s ? { steps: [mk(s)] } : { fail: "cond-unknown" }; }
  // снять состояние целиком (Встать, Стабилизация) / повтор увеличивает значок эффекта (Кража тени)
  if (kind === "RemoveCondition") { const slug = String(r.value ?? "").trim(); return ctx.condSlugs.has(slug) ? { steps: [mk({ removeCondition: { slug } })] } : { fail: "cond-unknown" }; }
  if (kind === "IncreaseBadgeEffect") {
    // PA прибавляет 1; шаг значка из текста предмета — таблица BADGE_TEXT (Кража тени: «Enfeebled 2 за применение, не больше 4»)
    const re = BADGE_TEXT[String(r.value ?? "").split(".").pop()];
    const m = re?.exec(ctx.html ?? ""), n = m ? +m[1] : null;   // значок при создании и шаг прибавки = число в тексте этой копии
    const crit = !!re && /on a critical (?:hit|success)/i.test(stripHtml(ctx.html ?? ""));   // другое число при крит. попадании: у правила PA степени нет — не выразить
    const x = effect(r.value ?? "", who);
    return x.fail ? x : x.steps.length ? { steps: x.steps.map((s) => (s.effect ? { ...s, effect: { ...s.effect, badge: "increment", ...(n > 1 && { by: n, start: n }) } } : s)), ...((crit || (re && !n)) && { low: [crit ? "badge-crit" : "badge-text"] }) } : { fail: MARKER };
  }
  // SelfDamage/TargetDamage: «формула[тип]» (Tamper: @actor.level[fire]) -> шаг damage; урон применяется pf2e без карточки с кнопками
  if (kind === "Damage") {
    const m = /^(.+?)\[([a-z]+)\]$/.exec(String(r.value ?? "").trim());
    return m && STEP_DAMAGE_TYPES.includes(m[2]) ? { steps: [mk({ damage: { formula: m[1], damageType: m[2] } })] } : { fail: "damage-step" };
  }
  // TurnOnOption/TurnOffOption: опция актёра автора (domain "all", как toggleRollOption у PA)
  if (r.target === "TurnOnOption" || r.target === "TurnOffOption") { const o = String(r.value ?? "").trim(); return /^\S+$/.test(o) ? { steps: [{ to: "self", rollOption: { domain: "all", option: o, ...(r.target === "TurnOffOption" && { value: false }) } }] } : { fail: "turn-on-option" }; }
  // союзники в радиусе (Живые щиты): PA кладёт эффект им, а у TargetAllyWithinRange ещё и на себя
  if (r.target === "OnlyAllyWithinRange" || r.target === "TargetAllyWithinRange") {
    const range = Number.isInteger(+r.range) && +r.range >= 5 ? +r.range : null, x = range ? effect(r.value ?? "", "allies") : { fail: `target-${r.target}` };
    if (x.fail) return x;
    if (!x.steps.length) return { fail: MARKER };
    return { ...x, steps: [...x.steps.map((s) => ({ ...s, range })), ...(r.target === "TargetAllyWithinRange" ? effect(r.value ?? "", "self").steps : [])] };
  }
  return { fail: `target-${r.target}` };
}

const APPLIED = /\bappl(?:ied|y|ies|ying)\b[^.,]{0,40}?\b(?:to|on|onto)\b(?: the skin of)? (?:a|an|another|the) (?:[\w-]+ ){0,2}?(?:creature|undead|ally)\b(?!['’]s)/i;
/** Кому достаётся SelfOrTarget: "data" — у предмета есть цель или дальность; "text" — по тексту «наносится на существо»; null — на себя. */
export const targetKind = (item, html) => {
  const t = String(item.target ?? "").trim(), r = String(item.range ?? "").trim();
  if ((t && !/^(?:you|yourself|self)\.?$/i.test(t)) || (r && !/^self$/i.test(r))) return "data";
  return APPLIED.test(stripHtml(html ?? "")) ? "text" : null;
};

/** Правило PA -> {trigger, degrees:[]|null, steps, low:[причины понижения], foreign, selText} | {fail}. */
/**
 * Событийная часть правила PA (0.5g3: бросок, урон, ход, эффект, handler из EVENT_HANDLERS) -> часть с `ev` (запись onEvent) и `evSteps` | { fail }.
 * Запись лежит на предмете-владельце группы (side:"self"): условие — предикат PA без тождеств самого предмета, получатель шага — по цели PA (eventWho).
 */
function evPart(r, item, ctx, spec, bound = false) {
  const on = EV_ON[r.triggerType];
  if (!on) return { fail: `trigger:${r.triggerType}`, low: [] };
  if (!ctx.owner) return { fail: "event-carrier", low: [] };   // чужой slug в предикате (Strike у «Боевого выступления»): правило на фите-владельце, у этого документа — вердикт covered
  const { rank, rest } = rankOf(r.predicate);
  const mapped = mapEffectOpts(rest, ctx.paEffects, ctx.effects);
  if (!mapped) return { fail: "event-predicate:pa-effect", low: [] };
  const w = eventWhen(mapped, item, on, { optStrings, OWN });
  if (w.fail) return { ...w, low: [] };
  let steps = (spec?.steps ?? []).map((s) => ({ ...s })), low = [], names = [];
  if (!spec) {
    const who = eventWho(r.target);
    if (!who) return { fail: "event-selfortarget", low: [] };
    const s = stepsOf(r, who, ctx);
    if (s.fail) return { fail: s.fail, low: [] };
    if (s.immunity) return { fail: "immunity-after-save", low: [] };
    steps = s.steps; low = [...(s.low ?? [])]; names = s.names ?? [];
  }
  if (!steps.length && !spec?.challenge) return { fail: MARKER, low: [] };
  if (rank) steps = steps.map((x) => ({ ...x, rank }));
  const when = [...(w.when ?? []), ...(spec?.when ?? [])];   // spec.when — условия, которых нет в предикате PA (PA сверяет их кодом handler-а)
  const ev = { on, side: spec?.side ?? "self", ...(when.length && { when }), ...(spec?.once && { once: true }) };   // side:"origin" — запись лежит у автора эффекта (Bane: правило у заклинателя, спасается носитель эффекта)
  return { ev, evSteps: steps, evChallenge: spec?.challenge ?? null, trigger: on, degrees: null, steps: [], own: false, imm: null, low, bound, selfOrTarget: false, selText: false, foreign: [], names };
}

export function translatePart(r, item, ctx, { bound = false } = {}) {
  if (r.type === "handler") return EVENT_HANDLERS[r.value] ? (EVENT_HANDLERS[r.value].absorbed ? { fail: MARKER, low: [] } : evPart(r, item, ctx, EVENT_HANDLERS[r.value], bound)) : { fail: `handler:${r.value}` };   // absorbed — правило уже часть другой записи (степени испытания)
  const toks = tokensOf(r.predicate);
  const degrees = toks.map((t) => /^outcome:(\w+)$/.exec(t)?.[1]).filter((d) => DEGREES.includes(d));
  const { rank, rest } = rankOf(r.predicate);   // сравнения круга -> шаг rank {min,max}; прочие сравнения остаются «условием»
  const guard = /RemoveCondition$/.test(r.target) ? `${r.target.startsWith("Self") ? "self" : "target"}:condition:${r.value}` : null;   // «снять, если есть» — то же делает шаг removeCondition
  const extra = toks.filter((t) => !IDENT.test(t) && OWN.exec(t)?.[2] !== item.slug && t !== "not" && !/\s|-st$/.test(t) && t !== guard && !immunityOpt(ctx, t) && !immGate(ctx, t) && t !== `origin:item:sourceId:${item.source ?? item.uuid}`);   // sourceId своего предмета — привязка к нему же
  const predLows = [...extra.map((t) => `predicate:${t}`), ...[...predicateOps(rest)].map((k) => `predicate-op:${k}`)];
  const sid = `origin:item:sourceId:${item.source ?? item.uuid}`;
  // у спасброска PA «self» — бросающий, у нашего шага это получатель (target): self:* -> target:*, если цели PA в предикате нет
  const swapSelf = r.triggerType === "saving-throw" && toks.some((t) => /^self:/.test(t)) && !toks.some((t) => /^target(?::|$)/.test(t));
  const wh0 = WHEN_TRIGGERS.has(r.triggerType) || swapSelf ? whenOf(swapSelf ? selfToTarget(rest) : rest, (t) => IDENT.test(t) || OWN.exec(t)?.[2] === item.slug || /\s|-st$/.test(t) || t === guard || t === sid || !!immGate(ctx, t)) : null;
  const wh = wh0 && mapEffectOpts(wh0, ctx.paEffects, ctx.effects);   // slug эффекта PA -> состояние, либо долг
  const low = wh ? [] : [...predLows];   // условие переносится шагом when — понижать не за что (если ниже не окажется иммунитета)
  // иммунитет после испытания, привязанный slug'ом к самому предмету (аура-пассив): спасбросок идёт с карточки этого предмета — не чужое событие
  const immEff = (u) => ctx.paEffects?.[/^Compendium\.pf2e-automations\.effects\.Item\.(\w+)$/.exec(u ?? "")?.[1]]?.kind === "immunity";
  const immOnly = (!!r.values?.length && r.values.every((v) => v.immunities?.length || (v.effects?.length && !v.conditions?.length && v.effects.every(immEff)))) || (!r.values && immEff(r.value));   // без исхода в предикате — при любой степени
  // бросок самого действия (`[[/act slug]]` в тексте, slug в предикате): у активности исследования «пассив» значит лишь «без стоимости» — правило не мёртвое
  const ownAct = ["skill-check", "attack-roll", "perception-check"].includes(r.triggerType) && strongSlugs(toks).includes(item.slug) && (ctx.html ?? "").includes(`[[/act ${item.slug}`);
  if (!triggerFits(r.triggerType, item) && !ownAct && !(immOnly && strongSlugs(toks).includes(item.slug))) low.push(ABILITY.has(item.type) && item.actionType === "passive" ? "passive-event-trigger" : `trigger-type:${r.triggerType}/${item.type}`);
  // «Self» у реакции: PA ставит эффект реагирующему, а в тексте он может достаться другому («They gain…», PC-эффект на способности NPC) — проверяется вручную
  if (item.actionType === "reaction" && r.target.startsWith("Self") && !r.target.startsWith("SelfOr") && !["saving-throw", "skill-check", "attack-roll", "perception-check"].includes(r.triggerType)) low.push("reaction-self");   // при броске «Self» — бросавший, то есть цель (ловушка Swarming Bites)
  const tr = r.triggerType;
  const sel = r.target.startsWith("SelfOr");
  // без префикса PA применяет к mainActor (hooks/message.ts): значок и ступень состояния — на себя
  const self = (r.target.startsWith("Self") || ["IncreaseBadgeEffect", "DecreaseBadgeEffect", "IncreaseConditionByStep"].includes(r.target)) && !sel, party = r.target.startsWith("Party");
  if (EV_ALWAYS.has(tr)) return evPart(r, item, ctx, null, bound);   // урон, ход, создание/снятие эффекта — только событие onEvent
  const author = ["skill-check", "attack-roll", "perception-check"].includes(tr);
  const roll = author || tr === "saving-throw";
  if (roll && !degrees.length && !immOnly) return EV_ROLLS.has(tr) && !strongSlugs(toks).includes(item.slug) ? evPart(r, item, ctx, null, bound) : { fail: `roll-trigger:${tr}` };   // бросок другого действия без исхода в предикате — событие
  if (!roll && !["use", "spell-cast", "postInfo", "self-effect"].includes(tr)) return { fail: `trigger:${tr}` };
  if (!roll && degrees.length) return { fail: "outcome-on-use" };
  let who = tr === "saving-throw" ? "target" : self ? "self" : "target";
  const tk = sel ? targetKind(item, ctx.html) : null;
  if (sel) who = tk || (rank?.min != null && heightenedTargets(ctx.html, rank.min)) ? "target" : "self";
  if (party) who = "party";   // PartyEffect: участники партий автора
  const s = stepsOf(r, who, ctx);
  // «не при иммунитете» вне броска (Rousing Splash): шаги пропускаются, если у получателя уже есть наш эффект-иммунитет; сам эффект-метку ставим последним
  const gate = !roll && !s.fail ? toks.map((t) => immGate(ctx, t)).find(Boolean) : null;
  if (gate) s.steps = [...s.steps.filter((x) => x.effect?.uuid !== gate), ...s.steps.filter((x) => x.effect?.uuid === gate)].map((x) => ({ ...x, unlessEffect: gate }));
  if ((s.immunity || (!s.steps?.length && s.low?.includes("immunity-not-in-text"))) && !roll) return { fail: "immunity-after-save", low: [] };
  if (s.fail) return { ...s, low: predLows.filter((l) => l.startsWith("predicate-op:")) };   // условие на ранг у провалившегося правила — всё равно «условие на шаге» (0.5f)
  low.push(...s.low ?? []);
  const when = wh && !s.immunity ? wh : null;   // иммунитет — свойство испытания, не шага: условие ему не прикрутить
  if (wh && s.immunity) low.push(...predLows);
  // степень в имени эффекта PA («(Failure)») не совпадает с outcome: правила — PA перепутал степени (Aromatic Lure) либо эффект не тот
  if (roll && degrees.length && (s.names ?? []).some((n) => { const d = nameDegree(n); return d && !degrees.includes(d); })) low.push("effect-degree-mismatch");
  return { trigger: tr, degrees: roll ? degrees : null, steps: rank || when ? s.steps.map((x) => ({ ...x, ...(rank && { rank }), ...(when && { when }) })) : s.steps, own: strongSlugs(toks).includes(item.slug), ...(EV_ROLLS.has(tr) && !strongSlugs(toks).includes(item.slug) && { evCand: evPart(r, item, ctx, null, bound) }), beyondPa: !!rank && JSON.stringify(r.predicate).includes('"lge"'), imm: s.immunity ? { ...s.immunity, ...(degrees.length && { degrees: DEGREES.filter((d) => degrees.includes(d)) }) } : null, low, bound, selfOrTarget: sel, selText: tk === "text", foreign: foreignConds(r.predicate, item.slug), ...(swapSelf && wh && { swapped: true }) };
}

const CHECK_SKIP = new Set(["flat", "lore"]);
/** Оболочка проверки по тексту предмета: challenge (спасбросок цели) либо check (бросок автора). */
const derivedOf = (item, html, ctx) => deriveFromMarkup({ type: item.type, slug: item.slug, name: item.name, system: { description: { value: html }, defense: item.defense ? { save: { statistic: item.defense.save, basic: item.defense.basic } } : undefined, area: item.area ? {} : undefined, target: item.target ?? undefined, actionType: { value: item.actionType }, traits: { value: item.traits } } }, ctx.labels, ctx.condSlugByUuid, ctx.condNames);
const SKILLS = new Set(["acrobatics", "arcana", "athletics", "crafting", "deception", "diplomacy", "intimidation", "medicine", "nature", "occultism", "performance", "religion", "society", "stealth", "survival", "thievery", "perception"]);
/** Есть ли в документе спасбросок, который PA мог бы принять (защита, @Check или «Will save» в тексте). */
const hasSave = (item, html) => !!item.defense?.save || /@Check\[(?:fortitude|reflex|will)\b|\b(?:Fortitude|Reflex|Will)\s+(?:saves?|DC)\b|\bsaving throws?\b/i.test(stripHtml(html) + " " + html);
/** Статистики собственного действия по `[[/act <slug> statistic=x]]{Навык}` (бросок системы): с параметром statistic или названием навыка в фигурных скобках. */
const actStats = (item, html) => [...new Set([...html.matchAll(/\[\[\/act\s+([a-z0-9-]+)([^\]]*)\]\](?:\{([^}]*)\})?/gi)].filter((m) => m[1] === item.slug).map((m) => /statistic=([a-z-]+)/.exec(m[2])?.[1] ?? m[3]?.toLowerCase().trim()).filter((s) => SKILLS.has(s)))];
function shell(kind, item, html, ctx, own = false) {
  if (kind === "challenge") {
    const c = derivedOf(item, html, ctx)?.rule.onUse?.challenge;
    // копия NPC: СЛ, статистика и «базовый» — из текста самой копии (у копий одной способности они разные), поэтому в каталоге dc = {expr:"markup"}, а resolveRule берёт голову испытания из разметки
    if (c) return { ...c, ...(item.embedded && c.dc.value != null && { dc: { expr: "markup" } }), byDegree: {} };   // lifted: dc-markup определяется по самому правилу в sample.mjs
    if (item.defense) return { statistic: item.defense.save, dc: { source: "spell" }, basic: item.defense.basic, rollerRole: "target", byDegree: {} };
    // защиты в данных нет (копия заклинания у NPC, способность без СЛ): спасбросок из текста. @Check без числа — СЛ из описания копии (ГМ задаёт кнопкой), «Will save» у заклинания — СЛ заклинателя
    const inline = /@Check\[(fortitude|reflex|will)\b([^\]]*)\]/i.exec(html), word = item.type === "spell" ? /\b(Fortitude|Reflex|Will)\s+saves?\b/i.exec(stripHtml(html)) : null;
    if (inline) return { statistic: inline[1].toLowerCase(), dc: { expr: "markup" }, basic: /\|basic\b/.test(inline[2]), rollerRole: "target", byDegree: {} };
    return word ? { statistic: word[1].toLowerCase(), dc: { source: "spell" }, basic: false, rollerRole: "target", byDegree: {} } : null;
  }
  let stat = null;
  for (const m of html.matchAll(/@Check\[([^\]]*)\]/g)) { const t = (parseCheck(m[1]).type ?? "").split(",")[0]; if (t && !SAVES.includes(t) && !CHECK_SKIP.has(t)) { stat = t; break; } }
  const vs = (/\b(Perception|Will|Reflex|Fortitude)\s+DC/i.exec(html)?.[1] ?? (/\bAC\b/.test(html) ? "ac" : null))?.toLowerCase();
  const opts = item.type === "action" ? [`action:${item.slug}`] : undefined;
  if (stat && vs) return { statistic: stat, vs: { defense: vs }, ...(opts && { options: opts }), byDegree: {} };
  if (item.type === "spell" && item.traits.includes("attack")) return { statistic: "spell-attack", vs: { defense: "ac" }, roll: "system", byDegree: {} };
  // бросок действия без цели (Прыжок, Подъём, Прокорм): статистика из [[/act]] или @Check, степень задаёт система. Только если правило PA привязано к самому действию, а не к чужому броску
  const own_ = [stat, ...actStats(item, html)].filter(Boolean);
  if (!vs && own && own_.length) return { statistic: own_.length > 1 ? [...new Set(own_)] : own_[0], roll: "system", byDegree: {} };
  return null;
}

const effName = (s) => String(s ?? "").toLowerCase().replace(/^(?:spell effect|effect|feat effect|stance|aura)\s*:\s*/, "").replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const ruleEffects = (r) => [r.value, ...(r.values ?? []).flatMap((v) => v.effects ?? [])].filter((u) => typeof u === "string" && u.startsWith("Compendium.") && !/\.conditionitems\./.test(u));
const ATTACKED_SAVE = /\b(?:attempts?|attempting|tries|trying)\s+to\s+attack\s+you\b|\bhostile action against\b/i;
const NOT_PF2E = /^Compendium\.(?:pf2e-automations|xdy-pf2e-workbench)\./;
const stepsAll = (rule) => (rule ? [...(rule.onUse?.apply ?? []), ...Object.values(rule.onUse?.challenge?.byDegree ?? {}).flat(), ...Object.values(rule.onUse?.check?.byDegree ?? {}).flat(), ...(rule.onEvent ?? []).flatMap((e) => [...(e.apply ?? []), ...Object.values(e.challenge?.byDegree ?? {}).flat()])] : []);

/** Правила группы для предмета, найденного по source, но со старым slug в предикате (предмет переименован): все правила, если slug-токены согласованы; у расходников — по суффиксу тира. */
function renamedRules(rules, item) {
  const strong = rules.map((r) => strongSlugs(tokensOf(r.predicate)));
  const names = new Set(strong.flat());
  if (item.type === "consumable") {
    if (new Set([...names].map((n) => n.replace(TIER, ""))).size > 1) return [];
    const tier = TIER.exec(item.slug)?.[1] ?? "";
    return rules.filter((r, i) => strong[i].some((n) => (TIER.exec(n)?.[1] ?? "") === tier));
  }
  return names.size <= 1 ? rules : [];
}

export { immunityFromText };   // живёт в scripts/rules.mjs: resolveRule берёт степени и охват иммунитета из текста копии

/** Правило «на себя» слабее текста: после спасброска стоит ссылка на состояние (derivedOf её не видит: «save to avoid becoming X»), либо есть область (шаблон) без спасброска. Область со спасброском «только урон» (дыхание) — нет. */
export const saveBeyondSelf = (html) => {
  const i = html.search(/@Check\[(?:fortitude|reflex|will)\b/);
  return i >= 0 ? /conditionitems\.Item\./.test(html.slice(i)) : /@Template\[/.test(html);
};

/** Группа PA + предмет -> {rule|null, confidence, reason, partial?, native?}. viaSource: группа найдена по source предмета, а не по slug. */
export function translateItem(item, html, group, ctx0, { slugOnly = false, viaSource = false } = {}) {
  let tierLink = false;
  // черта-выдавалка («вы получаете действие Taunt»): группа PA назвала действие, а у черты с тем же slug лишь выдача (GrantItem / ссылка на действие) — правило живёт на самом действии
  // (тип документа, на который указывает выдача, — действие с тем же slug, а не тип предметов группы)
  const acts = ctx0.actionBySlug?.get(item.slug) ?? [];
  if (!viaSource && !item.embedded && item.type === "feat" && item.actionType === "passive" && acts.length && (item.ruleKeys?.includes("GrantItem") || acts.some((a) => html.includes(a.uuid)))) return { rule: null, confidence: null, reason: "stub-grant", stub: true, stubActions: acts };
  if (item.selfEffect && group.rules.length && group.rules.every((r) => r.type === "handler" && NATIVE_HANDLERS.has(r.value))) return { rule: null, confidence: null, reason: "native:handler", native: true };
  const builtin = [...new Set(group.rules.filter(isBuiltin).map(builtinOf))];
  if (builtin.length) {
    group = { ...group, rules: group.rules.filter((r) => !isBuiltin(r)) };
    if (!group.rules.length) return { rule: null, confidence: null, reason: `builtin:${builtin.join(",")}`, builtin: true };
  }
  // 0.5g3: владелец группы (документ группы по uuid или по slug её имени) получает событийные правила целиком: slug в их предикате — чужое действие, а не фильтр
  const owner = viaSource || !!group.ownSlugs?.has(item.slug) || !!group.eventOwners?.has(item.slug);
  const isEv = (r) => (r.type === "handler" ? !!EVENT_HANDLERS[r.value] : EV_ALWAYS.has(r.triggerType) || EV_ROLLS.has(r.triggerType));
  let rules = group.rules.filter((r) => (owner && isEv(r)) || ((s) => !s.length || s.includes(item.slug))(strongSlugs(tokensOf(r.predicate))));
  if (!rules.length) {
    if (group.rules.length === 1) rules = group.rules;
    else if (viaSource) rules = renamedRules(group.rules, item);
    // тир, которого нет в предикатах PA (у Dragon's Blood Pudding — moderate/greater при правилах для базового и major): правила, все эффекты которых названы ссылкой в тексте этого документа
    if (!rules.length && viaSource) { rules = group.rules.filter((r) => ruleEffects(r).length && ruleEffects(r).every((u) => html.includes(u))); if (rules.length) tierLink = true; }
    if (!rules.length) return { rule: null, confidence: null, reason: "slug-mismatch" };
  }
  // пропавший id эффекта (в pf2e 8.6.1 его нет): единственная ссылка на существующий эффект в тексте предмета, не занятая другим шагом
  const eff = rules.flatMap(ruleEffects), missing = [...new Set(eff.filter((u) => !NOT_PF2E.test(u) && !ctx0.effects[u]))];
  const links = [...new Set([...html.matchAll(/@UUID\[(Compendium\.pf2e\.[a-z0-9-]*effects\.Item\.\w+)\]/g)].map((m) => m[1]))].filter((u) => ctx0.effects[u]);
  const subst = missing.length === 1 && links.length === 1 && !eff.includes(links[0]) ? { [missing[0]]: links[0] } : null;
  const paUsed = new Set();   // эффекты PA, через которые получены шаги (для выборки Критика: sample.mjs --subpack 0.5d)
  const ctx = { ...ctx0, html, subst, paUsed, owner };
  const parts = [], fails = [];
  // группа назвала этот самый документ по uuid (найден по source, в т.ч. переименованный); копия NPC и документ, найденный лишь по slug, сюда не входят
  const bound = () => viaSource;
  const failLow = [];
  let markers = 0;
  // handler с испытанием (Оглушающие удары): saving-throw-правила группы с тем же токеном в предикате дают степени испытания, отдельными частями они не идут
  const sib = new Map(rules.filter((r) => r.type === "handler" && EVENT_HANDLERS[r.value]?.challenge).map((r) => [r, group.rules.filter((s) => s.type !== "handler" && s.triggerType === "saving-throw" && tokensOf(s.predicate).includes(EVENT_HANDLERS[r.value].challenge.option))]));
  const consumed = new Set([...sib.values()].flat());
  for (const r of rules) {
    if (consumed.has(r)) continue;
    let p = translatePart(r, item, ctx, { bound: bound(r) });
    if (p.ev && p.evChallenge) {
      const byDegree = structuredClone(p.evChallenge.byDegree ?? {});   // готовые степени записи (Bane: снять эффект ауры) — плюс степени из saving-throw правил группы
      let bad = null;
      for (const s of sib.get(r) ?? []) { const q = translatePart(s, item, ctx, { bound: bound(s) }); if (q.fail) bad = q.fail; else for (const d of q.degrees ?? []) (byDegree[d] ??= []).push(...q.steps); }
      const { option, byDegree: _static, ...head } = p.evChallenge;
      p = bad || !Object.keys(byDegree).length ? { fail: bad ?? "event-challenge-steps", low: [] } : { ...p, evChallenge: { ...head, basic: false, rollerRole: "target", byDegree } };
    }
    if (p.fail === MARKER) markers++; else if (p.fail) { fails.push(p.fail); failLow.push(...p.low ?? []); } else parts.push(p);
  }
  // бросок чужого действия — запись onEvent, если подвести его под собственный бросок документа нельзя (нет ни СЛ, ни @Check в тексте)
  const foreignRolls = parts.filter((p) => p.evCand && p.degrees && p.trigger !== "saving-throw" && !p.own);
  if (foreignRolls.length && !shell("check", item, html, ctx, false)) for (const p of foreignRolls) if (!p.evCand.fail) Object.assign(p, p.evCand);
  const evParts = parts.filter((p) => p.ev), plain = parts.filter((p) => !p.ev);
  if (markers && !parts.length && !fails.length) return { rule: null, confidence: null, reason: MARKER };   // PA ставит только иконку активности
  // условие и его отрицание дают один и тот же результат (Taunt: feat:long-distance-taunt меняет лишь дальность) -> условие безвредно
  const sig = (p) => JSON.stringify([p.trigger, p.degrees, p.steps]);
  for (const p of parts) p.low = p.low.filter((l) => !p.foreign.some((f) => `predicate:${f.tok}` === l && parts.some((q) => q !== p && sig(q) === sig(p) && q.foreign.some((g) => g.tok === f.tok && g.pol !== f.pol))));
  // повтор увеличивает значок: «эффекта нет / он уже есть» — две половины одного шага, условие на наличие эффекта лишнее
  const badgeEff = new Set(parts.flatMap((p) => p.steps.filter((s) => s.effect?.badge).map((s) => s.effect.uuid)));
  // эффект в предикате PA назван иначе, чем наш (Bless: aura-bless при эффекте bless): «есть / нет» одного и того же эффекта у двух шагов группы — те же ворота присутствия
  const gates = new Set(), hasBadge = (s) => s.effect && badgeEff.has(s.effect.uuid);
  for (const q of parts) for (const s of q.steps) if (hasBadge(s)) for (const t of s.when ?? []) if (typeof t?.not === "string" && /^(?:self|target):effect:/.test(t.not) && parts.some((o) => o.steps.some((x) => hasBadge(x) && x.when?.includes(t.not)))) gates.add(t.not);
  if (badgeEff.size) for (const p of parts) if (p.steps.some((s) => s.effect && badgeEff.has(s.effect.uuid))) {
    p.low = p.low.filter((l) => !/^predicate:(?:self|target):effect:/.test(l));
    p.steps = p.steps.map((s) => { if (!s.when) return s; const { when, ...r } = s, w = noPresence(when, optSlug(ctx.effects?.[s.effect?.uuid] ?? ctx.paEffects?.[/\w+$/.exec(s.effect?.uuid ?? "")?.[0]]?.name ?? ""), gates); return w ? { ...r, when: w } : r; });
  }
  const build = () => {
    const apply = [], byDegree = {}, kinds = new Set(), lowAdd = [], imms = [...new Set(plain.filter((p) => p.imm).map((p) => JSON.stringify(p.imm)))].map((x) => JSON.parse(x));
    if (imms.length > 1) return { fail: "immunity-after-save" };
    for (const p of plain) {
      if (!p.degrees) apply.push(...p.steps);
      else { kinds.add(p.trigger === "saving-throw" ? "challenge" : "check"); if (p.steps.length) for (const d of p.degrees) (byDegree[d] ??= []).push(...p.steps); }
    }
    if (kinds.size > 1) return { fail: "both-roll-kinds" };
    // повтор увеличивает значок: простой шаг с тем же эффектом — половина того же шага (нет эффекта -> создать, есть -> +1), второй раз его не ставим
    const dropPlain = (l) => { const b = new Set(l.filter((a) => a.effect?.badge).map((a) => `${a.to}|${a.effect.uuid}|${JSON.stringify(a.rank ?? null)}`)); return l.filter((a) => a.effect?.badge || !a.effect || !b.has(`${a.to}|${a.effect.uuid}|${JSON.stringify(a.rank ?? null)}`)); };
    apply.splice(0, apply.length, ...mergeWhen(mergeRanks(dropPlain(apply))));
    for (const d of Object.keys(byDegree)) byDegree[d] = mergeWhen(mergeRanks(dropPlain(byDegree[d])));
    const u = { targets: apply.length && apply.every((a) => a.to !== "target") && !kinds.size ? "self" : item.area ? "area" : "selected", excludeSelf: null, zone: null, challenge: null, apply };
    if (kinds.size) {
      const k = [...kinds][0], sh = shell(k, item, html, ctx, plain.filter((p) => p.degrees && p.trigger !== "saving-throw").every((p) => p.own));
      // PA принимает спасбросок с этим slug, а в документе спасброска нет (пассив, Удар): правило PA тут не срабатывает никогда — ложное покрытие
      if (!sh) return { fail: k === "challenge" ? (hasSave(item, html) ? "no-save-def" : "no-roll-in-doc") : plain.some((p) => p.degrees && p.trigger !== "saving-throw" && !p.own) ? (plain.find((p) => p.evCand?.fail)?.evCand.fail ?? "roll-of-other-action") : "no-roll-def" };
      if (k === "check" && !sh.vs) u.targets = "self";   // бросок без цели: шаги — на автора
      // только иммунитет (в PA нет шагов по степеням): состояния — из текста, как их вывела бы разметка (каталог перекрывает разметку, иначе они бы пропали)
      // dc «из текста» (копии NPC): степени и иммунитет решает текст копии на лету (resolveRule/withMarkupHead) — в каталог их не замораживаем
      if (imms.length && k === "challenge" && !Object.keys(byDegree).length && sh.dc?.expr !== "markup") {
        const dv = derivedOf(item, html, ctx);
        Object.assign(byDegree, dv?.rule.onUse?.challenge?.byDegree ?? {});
        // разметка видела состояния, но не взяла (выбор, условие, срок-только): каталог перекрывает её и считался бы полным
        if (dv?.hints.possible.length) lowAdd.push(`text-possible:${[...new Set(dv.hints.possible.map((p) => p.split(":")[1]))].join("+")}`);
      }
      u[k] = { ...sh, byDegree, ...(imms.length && { immunity: imms[0] }) };
    }
    const seen = new Set();
    u.apply = apply.filter((a) => { const k = JSON.stringify(a); return !seen.has(k) && seen.add(k); });
    for (const [d, l] of Object.entries(byDegree)) { const sd = new Set(); byDegree[d] = l.filter((a) => { const k = JSON.stringify(a); return !sd.has(k) && sd.add(k); }); }
    // 0.5g3: записи onEvent (одинаковые склеиваются); onUse остаётся, только если есть обычные части
    const onEvent = [...new Map(evParts.map((p) => { const e = { ...p.ev, ...(p.evSteps.length && { apply: p.evSteps }), ...(p.evChallenge && { challenge: p.evChallenge }) }; return [JSON.stringify(e), e]; })).values()];
    const v = validateRule({ v: 1, label: item.name, ...(plain.length || !onEvent.length ? { onUse: u } : {}), ...(onEvent.length && { onEvent }) });
    return v.ok ? { rule: v.rule, lowAdd } : { fail: "invalid", detail: v.errors.map(String).join("; ") };
  };
  const built = parts.length ? build() : { fail: null };
  const allFails = [...fails, ...(built.fail ? [built.fail] : [])];
  const low = [...parts.flatMap((p) => p.low), ...(built.lowAdd ?? [])];
  // иммунитет — по тексту предмета, а не по PA: нет слова «immune» — PA выдумал (Miasma), правило сомнительно; степени и «ко всем существам вида» — из текста
  const immR = (built.rule?.onUse?.challenge ?? built.rule?.onUse?.check)?.immunity;
  const markupMode = built.rule?.onUse?.challenge?.dc?.expr === "markup";
  if (immR) {
    const t = immunityFromText(html);
    if (!t.has) { if (!markupMode) low.push("immunity-not-in-text"); }   // «текст решает»: нет иммунитета в английском тексте копии — нет и в правиле (withMarkupHead)
    else {
      if (t.degrees !== undefined) { if (t.degrees && t.degrees.length < DEGREES.length) immR.degrees = DEGREES.filter((d) => t.degrees.includes(d)); else delete immR.degrees; }
      if (t.anySource) immR.scope = "slug";
    }
  }
  // группа назвала свои предметы по uuid, а этот документ из компендия найден лишь по slug и другого типа, чем предметы группы, — скорее всего, другой предмет с тем же именем (армейская «Taunt» из Kingmaker)
  if (!viaSource && !item.embedded && group.srcTypes?.size && !group.srcTypes.has(item.type)) low.push("slug-only-other-item");
  const steps = stepsAll(built.rule);
  // «use this … again, any existing one ends» (Timber Sentinel, Living Bonfire, Hallowed Ground…): повтор заканчивает прежний эффект, шаг effect получает replace
  const replaces = !!built.rule && REPLACES.test(stripHtml(html));
  if (replaces) markReplace(built.rule.onUse);
  const lifted = new Set(tierLink ? ["tier-by-text-link"] : []);   // что из прежних ограничений снято признаками 0.5b (для выборки Критика: sample.mjs --subpack 0.5b)
  // 0.5g1 (sample.mjs --subpack 0.5g1): карточка пассивки как использование; self спасброска PA -> получатель шага
  if (ABILITY.has(item.type) && item.actionType === "passive" && parts.some((p) => p.trigger === "postInfo")) lifted.add("passive-postinfo");
  if (parts.some((p) => p.swapped)) lifted.add("save-self-target");
  // шаги из эффектов PA сверяются с текстом: на тех же степенях состояния или значения другие -> low (Touch of Idiocy: NPC-копия со старым текстом, сопоставленная с Stupefy)
  if (paUsed.size && built.rule?.onUse) {
    const k = built.rule.onUse.challenge ? "challenge" : built.rule.onUse.check ? "check" : null;
    const dv = k && derivedOf(item, html, ctx)?.rule.onUse?.[k]?.byDegree;
    const conds = (l) => (l ?? []).filter((a) => a.condition).map((a) => `${a.condition.slug}${a.condition.value ?? 1}`).sort().join(",");
    if (dv) for (const [deg, l] of Object.entries(built.rule.onUse[k].byDegree)) if (conds(dv[deg]) && conds(l) && conds(dv[deg]) !== conds(l)) { low.push(`steps-differ-from-text:${deg}`); break; }
  }
  // текст ссылается на собственный эффект предмета, а правило PA ставит другой (Liberating Step у Champion of Shelyn: сопротивление 10 против Champion's Resistance +2)
  {
    const own = [...new Set([...html.matchAll(/@UUID\[(Compendium\.pf2e\.[a-z0-9-]*effects\.Item\.\w+)\]/g)].map((m) => m[1]))].filter((u) => ctx.effects?.[u]);
    const ruleEff = steps.filter((a) => a.effect).flatMap((a) => [a.effect.uuid, ...(ctx.wraps?.[a.effect.uuid] ?? [])]);   // обёртка нашего пака с выбором ставит один из своих вариантов
    // эффект из пака модуля (0.5d) заменяет эффект pf2e осознанно — не сравниваем
    if (own.length && ruleEff.length && !steps.some((a) => a.effect?.uuid.startsWith("Compendium.pf2e-automato.")) && !own.some((u) => ruleEff.includes(u))) low.push("own-effect-in-text");
  }
  // каждая ссылка правила должна быть в тексте предмета: иначе PA сработал по соседнему предмету или ошибся. Эффект с именем самого предмета («Effect: Fly» у Fly) — его собственный
  for (const a of steps) {
    // доказательство, что эффект этого предмета: ссылка в тексте; группа PA названа по uuid этого документа (не при тирах-соседях: source не говорит, какой тир); либо имя эффекта = имя предмета (не для эффектов с выбором и расходников с тирами)
    if (a.effect && !html.includes(a.effect.uuid)) {
      const bySource = !ctx.tierSiblings?.(item) && parts.some((p) => p.bound && [...p.steps, ...(p.evSteps ?? [])].some((x) => x.effect?.uuid === a.effect.uuid));
      const byName = effName(ctx.effects[a.effect.uuid]) === effName(item.name) && !ctx.effectRisk?.[a.effect.uuid] && !ctx.tierSiblings?.(item);
      if (!bySource && !byName) low.push("effect-not-in-text"); else if (bySource && !byName) lifted.add("effect-by-source");
    }
    // ветка «цель уже в этом состоянии» (Захват продлевает Удержание, `target:condition:<то же>` в when) — продление того же состояния, ссылка на него в тексте не нужна (0.5g3)
    const extension = (a.when ?? []).includes(`target:condition:${a.condition?.slug}`);
    if (a.condition && a.condition.policy !== "reduce" && !extension && !html.includes(`conditionitems.Item.${ctx.condIds?.[a.condition.slug]}`)) low.push(`condition-not-in-text:${a.condition.slug}`);
  }
  // цель PA перенесена как есть: у расходника/снаряжения без «target» эффект, скорее всего, для владельца (Stormbreaker/Ghostbane Fulu); SelfOrTarget по тексту «наносится на существо» — исключение
  if (["consumable", "equipment"].includes(item.type) && !item.target && parts.some((p) => !p.selText && p.steps.some((a) => a.to === "target"))) low.push("to-target-no-item-target");
  // текст -> правило (узко): «you become/gain the @UUID[состояние]» без такого состояния ни в правиле, ни в GrantItem выданного эффекта
  if (built.rule) {
    const have = new Set((markupMode ? [...steps, ...stepsAll(derivedOf(item, html, ctx)?.rule)] : steps).flatMap((a) => [a.condition && ctx.condIds?.[a.condition.slug], ...(a.effect ? ctx.grants?.[a.effect.uuid] ?? [] : [])]).filter(Boolean));
    const slugById = Object.fromEntries(Object.entries(ctx.condIds ?? {}).map(([k, v]) => [v, k]));
    for (const m of html.matchAll(/\b(?:you|it|they|target|creature)\s+(?:become|becomes|are|is|gain|gains|have|has)\s+(?:the\s+)?@UUID\[Compendium\.pf2e\.conditionitems\.Item\.(\w+)\]|(?<!\b(?:before|from|avoid|avoiding|without|unless|not)\s)\bbecoming\s+@UUID\[Compendium\.pf2e\.conditionitems\.Item\.(\w+)\]/gi)) {
      const id = m[1] ?? m[2];
      if (!have.has(id)) low.push(`text-condition-missing:${slugById[id] ?? id}`);
    }
  }
  // правило слабее текста: в тексте спасбросок или шаблон области, а перенос — только «на себя» без испытания (Blight Breath, Thawing Candle)
  const u = built.rule?.onUse;
  // испытание срабатывает на чужое враждебное действие против владельца («когда тварь пытается напасть на вас — Воля») — не на использование предмета: нужен триггер onAttacked с испытанием (пачка 4)
  if (ATTACKED_SAVE.test(stripHtml(html)) && /@Check\[(?:fortitude|reflex|will)\b|\b(?:Fortitude|Reflex|Will) save/.test(html)) low.push("save-on-attacked");
  // и только если у этого спасброска/области есть то, что модуль автоматизирует (шаги по степеням, состояния без ссылки, зона): спасбросок «только урон» (дыхание, вторичный эффект) и аура без состояния — не то же, что PA, а урон модуль не применяет
  if (u && !u.challenge && u.targets === "self" && /@Check\[(?:fortitude|reflex|will)\b|@Template\[/.test(html)) {
    const d = derivedOf(item, html, ctx), du = d?.rule.onUse;
    if (!low.includes("save-on-attacked") && (du?.zone || (du?.challenge && (Object.keys(du.challenge.byDegree).length || d.hints.possible.length)))) low.push("text-has-save-or-area");
    // derivedOf не видит «save to avoid becoming X», «and is X on a failed save» и область без спасброска: состояние после спасброска или шаблон области при правиле «на себя» — не поднимаем
    else if (!low.includes("save-on-attacked") && saveBeyondSelf(html)) low.push("text-has-save-or-area");
    else lifted.add("save-without-steps");
  }
  if (!allFails.length && built.rule) {
    // pf2e делает это сам: единственный эффект правила — selfEffect самого документа (у копии NPC свой system.selfEffect, источник не в счёт)
    const se = item.selfEffect;
    const native = !!se && steps.length > 0 && !built.rule.onEvent && steps.every((a) => a.to === "self" && a.effect?.uuid === se && !a.effect.replace);
    return { rule: built.rule, confidence: low.length ? "low" : "high", reason: `translated: ${parts.length} part(s)${parts.some((p) => p.beyondPa) ? " (beyond-pa: lge)" : ""}${low.length ? "; " + [...new Set(low)].join(",") : ""}`, ...(lifted.size && { lifted: [...lifted] }), ...(paUsed.size && { paEffects: [...paUsed] }), ...(native && { native: true }), ...(slugOnly && { slugOnly: true }) };
  }
  return { rule: null, confidence: null, reason: allFails.length ? [...new Set([...allFails, ...failLow])].join("; ") : "unknown", ...(built.rule && { partial: built.rule }) };
}

/** «Долги переноса» из pa-port-report.md: строки таблиц, где колонка расхождений не «—». */
export function parseDebts(md) {
  const out = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length < 4 || /^-+$/.test(c[0].replace(/\s/g, "")) || ["Сущность", "Действие"].includes(c[0])) continue;
    const gap = c[c.length - 1];
    if (gap && gap !== "—") out.push({ entity: c[0], slug: /\(([a-z-]+)/.exec(c[0])?.[1] ?? null, gap });
  }
  return out;
}


/**
 * Черновики PA -> шипуемый каталог { v, bySource, bySlug }. Идут только high и принятые вручную (rules/drafts-accepted/pa-port.json, перекрывает по uuid).
 * Ручные каталоги (manual) главнее: запись, чей источник или slug там уже есть, отбрасывается. Черновики со статусом paStatus (covered/native/false-coverage) не переносятся.
 * bySlug — если все предметы с этим slug (в т.ч. NPC-копии без source) — одна способность: у всех одно и то же правило или правила нет вовсе.
 * Чужой предмет с тем же slug, копия со статусом native/false-coverage или сомнительное (low) правило закрывают slug: ложное совпадение хуже пропуска.
 * Возвращает outcome: uuid -> "ported" | причина, по которой черновик не попал в каталог.
 */
export function buildPaCatalog(drafts, accepted, items, manual) {
  const acc = new Map(accepted.map((d) => [d.uuid, d]));
  const all = drafts.map((d) => acc.get(d.uuid) ?? d);
  const itemBy = new Map(items.map((i) => [i.uuid, i])), draftBy = new Map(all.map((d) => [d.uuid, d]));
  const mSrc = new Set(manual.flatMap((c) => Object.keys(c.bySource ?? {}))), mSlug = new Set(manual.flatMap((c) => Object.keys(c.bySlug ?? {})));
  // имя у копий одной способности может отличаться; у испытания с СЛ из разметки (копии NPC) статистика, «базовое» и опции берутся из текста копии
  // area/selected: область берётся из данных документа, у NPC-копии заклинания её часто нет (Bless) — та же способность
  const sig = (r0) => {
    const r = r0.onUse?.targets === "area" ? { ...r0, onUse: { ...r0.onUse, targets: "selected" } } : r0, c = r.onUse?.challenge;
    if (c?.dc?.expr !== "markup") return JSON.stringify({ ...r, label: null });
    // степени, охват и срок иммунитета у «текст решает» берутся из текста копии (withMarkupHead) — копий не различают
    const { statistic, basic, options, traits, immunity, ...head } = c;
    return JSON.stringify({ ...r, label: null, onUse: { ...r.onUse, challenge: { ...head, ...(immunity && { immunity: { slug: immunity.slug, uuid: immunity.uuid } }) } } });
  };
  const keyOf = (i) => (i.embedded ? i.source ?? i.uuid : i.uuid);   // NPC-копии одного заклинания — один предмет
  const byItemSlug = {}, drafted = new Set();
  for (const i of items) { if (i.slug) (byItemSlug[i.slug] ??= []).push(i); if (draftBy.has(i.uuid)) drafted.add(keyOf(i)); }
  // type: ключ "slug@type" касается только документов этого типа; общий ключ — любых, кроме армейских (resolveRule)
  const slugVerdict = (slug, type = null) => {
    const sigs = new Map(), selfDocs = [];
    let bad = false, noSave = false;
    for (const i of (byItemSlug[slug] ?? []).filter((x) => (type ? x.type === type : x.type !== "campaignFeature"))) {
      const d = draftBy.get(i.uuid);
      if (d?.paStatus === "false-coverage" && d.noSave) { noSave = true; continue; }   // без спасброска в описании: «СЛ из текста» такому тёзке правила не даёт (resolveRule)
      // у документа свой selfEffect — pf2e применяет его сам; правило «ровно этот selfEffect» resolveRule на нём пропускает (isSelfEffectOnly), иное правило — двойное применение
      if (i.selfEffect && (!d || d.paStatus === "native" || d.paStatus === "covered")) { selfDocs.push(i.selfEffect); if (d?.rule) sigs.set(sig(d.rule), d.rule); continue; }
      if (!d) { bad ||= !mSrc.has(keyOf(i)) && !drafted.has(keyOf(i)); continue; }   // чужой предмет; копия предмета, у которого черновик есть, — тот же предмет
      if (d.paStatus === "covered") continue;
      if (d.paStatus && d.paStatus !== "port") { bad = true; continue; }
      if (d.rule) { bad ||= d.confidence !== "high" && !acc.has(d.uuid); sigs.set(sig(d.rule), d.rule); }
      else bad = true;   // тёзка без правила (долг, исключён вручную): ключ по slug поймал бы и его
    }
    bad ||= noSave && [...sigs.values()].some((r) => r.onUse?.challenge?.dc?.expr !== "markup");
    bad ||= selfDocs.some((se) => [...sigs.values()].some((r) => !isSelfEffectOnly(r, se)));
    return sigs.size > 1 ? "source-conflict" : bad || !sigs.size ? "slug-ambiguous" : null;
  };
  const verdicts = {}, skipped = {}, cand = [], bySource = {}, bySlug = {}, included = [], outcome = new Map();
  const skip = (k, d) => { skipped[k] = (skipped[k] ?? 0) + 1; outcome.set(d.uuid, k); };
  for (const d of all.sort((a, b) => cmp(a.uuid, b.uuid))) {
    if (d.paStatus && d.paStatus !== "port") { skip(d.paStatus, d); continue; }
    if (!d.rule) { skip(acc.has(d.uuid) ? "excluded-manually" : "no-rule", d); continue; }   // rule:null в drafts-accepted — явное исключение
    if (d.confidence !== "high" && !acc.has(d.uuid)) { skip("low", d); continue; }
    const v = validateRule(d.rule);
    if (!v.ok) { skip("invalid", d); continue; }
    if (!roundTrip(v.rule)) { skip("roundtrip", d); continue; }
    const it = itemBy.get(d.uuid);
    // копия NPC, найденная лишь по slug: её source — другой предмет, правило на него не вешаем
    const src = it?.embedded ? (d.slugOnly ? null : it.source) : d.uuid;
    if ((src && mSrc.has(src)) || mSlug.has(d.slug)) { skip("manual-wins", d); continue; }
    // общий slug-ключ, если все тёзки — одна способность; иначе ключ с типом, если однозначны тёзки этого типа
    const verdict = d.type === "campaignFeature" ? "campaign" : (verdicts[d.slug] ??= slugVerdict(d.slug));
    const typed = verdict && (verdicts[slugTypeKey(d.slug, d.type)] ??= slugVerdict(d.slug, d.type));
    if (!src && typed) { skip(typed, d); continue; }
    cand.push({ d, src, slug: !verdict ? d.slug : !typed ? slugTypeKey(d.slug, d.type) : null, rule: withMarks(v.rule) });
  }
  // один источник у нескольких предметов (копии в NPC) с разными правилами — не берём ни одно
  const rules = {}, inSrc = new Set(), inSlug = new Set();
  for (const c of cand) if (c.src) (rules[c.src] ??= new Set()).add(sig(c.rule));
  for (const c of cand) {
    if (c.src && rules[c.src].size > 1) { skip("source-conflict", c.d); continue; }
    if (c.src && (!bySource[c.src] || (c.rule.onUse?.targets === "area" && bySource[c.src].onUse?.targets !== "area"))) bySource[c.src] = c.rule;   // из копий одной способности — правило с областью
    if (c.slug) bySlug[c.slug] ??= c.rule;
    outcome.set(c.d.uuid, "ported");
    if (c.src ? !inSrc.has(c.src) : !inSlug.has(c.slug)) included.push({ ...c.d, catSource: c.src, catSlug: c.slug });   // для выборки — без дублей NPC-копий
    if (c.src) inSrc.add(c.src); else inSlug.add(c.slug);
  }
  return { cat: { v: 1, bySource, bySlug }, skipped, included, outcome };
}

/** Каталог: одна запись на строку (читаемые диффы). */
const serializeCatalog = (c) => `{"v":1,\n"bySource":{\n${Object.entries(c.bySource).map(([k, r]) => `${JSON.stringify(k)}:${JSON.stringify(r)}`).join(",\n")}\n},\n"bySlug":{\n${Object.entries(c.bySlug).map(([k, r]) => `${JSON.stringify(k)}:${JSON.stringify(r)}`).join(",\n")}\n}}\n`;

/** Группа PA найдена по slug лишь потому, что он упомянут в предикате чужого фита (Oscillating Wave: заклинания в `or` рядом с feature:): предмет — условие, а не предмет группы. */
export function falseCoverage(group, it, viaSource) {
  if (viaSource || group.ownSlugs?.has(it.slug)) return false;
  const hit = group.rules.filter((r) => { const t = tokensOf(r.predicate); return strongSlugs(t).includes(it.slug) || t.some((x) => OWN.exec(x)?.[2] === it.slug); });
  // триггер — slug в самом предикате (action:sense-motive, origin:item:quick-tempered); внутри or/and он лишь одно из условий фита
  const trigger = (r) => strongSlugs((Array.isArray(r.predicate) ? r.predicate : [r.predicate]).filter((x) => typeof x === "string")).includes(it.slug);
  return hit.length > 0 && hit.every((r) => !trigger(r) && foreignConds(r.predicate, it.slug).some((f) => /^(?:origin:)?(?:feat|feature):/.test(f.tok)));
}

/** Правила группы целиком про чужую черту/класс-фичу этой же группы (`feat:<её slug>` в предикате), а документ назван в них лишь как условие. */
export const triggerOnly = (group, it, viaSource) => !viaSource && !group.ownSlugs?.has(it.slug) && group.rules.length > 0
  && group.rules.every((r) => foreignConds(r.predicate, it.slug).some((f) => f.pol && /^(?:origin:)?(?:feat|feature):/.test(f.tok) && group.ownSlugs?.has(OWN.exec(f.tok)?.[2])));

/**
 * Группа найдена лишь по slug, и PA на этом документе либо не сработает, либо поставит не тот эффект. Триггеры PA смотрят на флаги сообщения (pf2e-automations/src: triggerType):
 * spell-cast — только заклинание, use — только предмет с sourceId (расходник/снаряжение), postInfo и броски — любой документ (на нём PA срабатывает, но это решает не эта функция).
 * Армейская способность (Kingmaker: Taunt, Feint, Darkvision) делит slug с обычными: PA на ней по postInfo срабатывает, но ставит эффект обычной способности — ложное покрытие по смыслу, не по триггеру.
 * Действие NPC «Flicker» — не заклинание Flicker; «Blight Breath» у нуккелави — не флакон.
 */
export const kindMismatch = (group, it, viaSource) => {
  if (viaSource || !group.srcTypes?.size) return false;
  if (it.type === "campaignFeature" && !group.srcTypes.has("campaignFeature")) return true;
  // владелец условия (feat:allegro у правила на чужое заклинание) — сам предмет группы, а не тёзка
  const owner = (r) => tokensOf(r.predicate).some((t) => OWN.exec(t)?.[2] === it.slug);
  const fits = (r) => (r.triggerType === "spell-cast" ? it.type === "spell" || owner(r) : r.triggerType === "use" ? !["spell", ...ABILITY].includes(it.type) : true);
  return group.rules.length > 0 && !group.rules.some(fits);
};

/** Сигнатура правила для сверки ручного и переведённого: механика, шаги по степеням, СЛ. */
const stepKey = (list) => (list ?? []).filter((a) => a.condition || a.effect).map((a) => `${a.to ?? "target"}:${a.condition ? a.condition.slug + (a.condition.value ?? 1) : a.effect.uuid}`).sort().join(",");
export function sigOf(r) {
  const u = r?.onUse;
  if (!u) return { mech: r?.onAttacked ? "reaction" : "other", steps: {} };
  const k = u.challenge ? "challenge" : u.check ? "check" : null, c = k && u[k];
  const mech = k ? `${k}:${c.statistic}${c.vs?.defense ? ":" + c.vs.defense : ""}` : r.macros?.length ? "macro" : u.zone ? "zone" : "apply";
  const steps = { apply: stepKey(u.apply), ...Object.fromEntries(Object.entries(c?.byDegree ?? {}).map(([d, l]) => [d, stepKey(l)])) };
  return { mech, steps, dc: c?.dc };
}
/**
 * Ручное правило по slug покрывает документ только если описывает ту же способность так же, как PA/текст:
 * covered | slug-collision (другая способность: другой тип или механика) | manual-gap (та же способность, правило расходится; immunity-after-save — нет иммунитета).
 * other — переведённое PA правило, иначе выведенное из текста; paFail — причина провала перевода PA.
 */
export const markersOf = (html) => [...new Set([...(html ?? "").matchAll(/@UUID\[([^\]]+)\]|@Check\[(\w+)|\[\[\/act (\w+)/g)].map((m) => m[1] ?? m[2] ?? m[3]))].sort().join("|");
const IMMUNITY = /immune\b[^.]{0,100}\b(?:for|until)\b/i;   // в тексте: иммунитет на срок; ручное правило должно задавать immunity
export function manualVerdict(manual, item, other, paFail, canon, html = "", sameMarkers = null) {
  if (!item.embedded && canon && canon.type !== item.type) return { status: "slug-collision", reasons: ["slug-collision", "type-differs"] };
  // иммунитет: нужен, если текст его обещает или перевод PA его даёт; закрыт, если у ручного правила он есть и срок/степени те же, что у перевода PA
  const immOf = (r) => (r?.onUse?.challenge ?? r?.onUse?.check)?.immunity;
  const want = immOf(other), have = immOf(manual);
  const imm = (!!want || paFail?.includes("immunity-after-save") || IMMUNITY.test(stripHtml(html))) && (!have || (!!want && JSON.stringify([have.duration, have.degrees]) !== JSON.stringify([want.duration, want.degrees])));
  if (!other) {
    if (sameMarkers === false) return { status: "slug-collision", reasons: ["slug-collision", "text"] };
    if (sameMarkers == null) return { status: "manual-gap", reasons: ["manual-gap", imm ? "immunity-after-save" : "unverified"] };
    return imm ? { status: "manual-gap", reasons: ["manual-gap", "immunity-after-save"] } : { status: "covered" };
  }
  const a = sigOf(manual), b = sigOf(other);
  if (a.mech !== b.mech) return { status: "slug-collision", reasons: ["slug-collision", "mech-differs"] };
  const dcBad = a.dc?.value != null ? b.dc?.value != null && a.dc.value !== b.dc.value : a.dc?.source === "spell" ? item.type !== "spell" && b.dc?.value != null : false;
  const degs = [...new Set([...Object.keys(a.steps), ...Object.keys(b.steps)])];
  const stepBad = a.mech !== "macro" && degs.some((d) => (a.steps[d] ?? "") !== (b.steps[d] ?? ""));
  if (dcBad || stepBad) return { status: "manual-gap", reasons: ["manual-gap", dcBad ? "dc" : "steps", ...(imm ? ["immunity-after-save"] : [])] };
  return imm ? { status: "manual-gap", reasons: ["manual-gap", "immunity-after-save"] } : { status: "covered" };
}

// подпачки ROADMAP §5.1: причина долга -> куда она относится
const E_HANDLERS = new Set(["knockdown", "push", "huntPrey", "deleteHoldingBreath", "suffocatingEndTurn", "grab", "grabImproved", "grapple", "rageImmunity", "theOscillatingWave", "theOscillatingWaveRefocus"]);
const SUBPACK_REASONS = {
  "0.5c": ["immunity-after-save", "roll-trigger"],
  "0.5d": ["pa-own-effect", "external-effect", "dice-duration"],
  "0.5f": ["increase-badge", "no-roll-def", "no-save-def", "remove-condition", "predicate-op"],   // остаток после 0.5f: сравнения круга (rank) уже шаг; чему не хватило — по причине; turn-on-option -> 0.5g (триггер от чужого использования + «у актёра есть черта»)
  "0.5g": ["roll-of-other-action", "turn-on-option", "pa-own-equipment", "script-effect","passive-event-trigger", "save-on-attacked", "trigger-type", "predicate", "on-damage-roll", "damage-step", "outcome-on-use", "party-effect", "choice-set", "target-OnlyAllyWithinRange", "both-roll-kinds", "event-predicate", "event-selfortarget", "event-carrier", "event-challenge-steps"]
};
const SUBPACK_ORDER = ["0.5e", "0.5g", "0.5d", "0.5c", "0.5f"];
/** Подпачка долга по причинам [«handler:x», «pa-own-effect»…]; первая по порядку SUBPACK_ORDER, всё прочее — остаток 0.5b (ручной разбор). */
export function subpackOf(reasons) {
  const has = new Set();
  for (const r of reasons) {
    const [k, v] = r.split(":");
    if (k === "handler") has.add(E_HANDLERS.has(v) ? "0.5e" : "0.5g");
    else for (const [sp, l] of Object.entries(SUBPACK_REASONS)) if (l.includes(k) || (k === "target" && l.some((x) => r.startsWith(x)))) has.add(sp);
  }
  return SUBPACK_ORDER.find((sp) => has.has(sp)) ?? "0.5b";
}

/**
 * Вердикты по способности, а не по документу: запись без uuid, с slug (и необязательными type и scope "npc"|"compendium" — копия в актёре или документ компендиума) относится ко всем черновикам с этим slug, у которых нет своей записи по uuid и статус port.
 * Правило записи не пишется, а берётся: accept:true — из черновика (перевод PA принят после чтения текста), accept:"markup" — выведенное из текста документа (PA ошибся или уступает тексту).
 * -> полный список записей по uuid (для buildPaCatalog / applyAccepted). Запись по uuid с полным rule остаётся как есть.
 */
export function resolveAccepted(accepted, drafts, derive) {
  const own = new Set(accepted.filter((a) => a.uuid).map((a) => a.uuid)), out = [];
  for (const a of accepted) {
    if (a.uuid && !a.accept) { const d = drafts.find((x) => x.uuid === a.uuid); out.push(d ? { slug: d.slug, type: d.type, name: d.name, status: "pa-port", ...(d.slugOnly && { slugOnly: true }), confidence: null, rule: null, ...a } : a); continue; }
    const docs = a.uuid ? drafts.filter((d) => d.uuid === a.uuid) : drafts.filter((d) => d.slug === a.slug && (!a.type || d.type === a.type) && (!a.scope || (a.scope === "npc") === d.uuid.includes(".Actor.")) && !own.has(d.uuid) && !["covered", "native", "false-coverage", "not-ported"].includes(d.paStatus));
    for (const d of docs) {
      const { uuid, slug: s, type, slug, accept, partial, ...rest } = a;   // partial — перечень пробелов (annotateGaps), в запись каталога не идёт
      const rule = accept === "markup" ? derive(d) : accept ? d.rule ?? d.partial ?? null : (a.rule ?? null);
      if (accept && !rule) throw new Error(`pa-port: вердикт accept без правила: ${d.uuid} (${d.name})`);
      out.push({ uuid: d.uuid, slug: d.slug, type: d.type, name: d.name, status: "pa-port", ...(d.slugOnly && { slugOnly: true }), confidence: accept ? "manual" : null, ...rest, rule });
    }
  }
  return [...new Map(out.map((a) => [a.uuid, a])).values()];   // по одному документу несколько записей — действует последняя (вердикт дописывается в конец файла)
}

/**
 * Ручной вердикт по документу (rules/drafts-accepted/pa-port.json), кроме самого правила: paStatus (covered | false-coverage | native) — статус вместо долга,
 * debt {subpack, reasons} — долг в подпачку, которую скрипт определить не может. Всегда с reason.
 */
export function applyAccepted(drafts, accepted) {
  const by = new Map(drafts.map((d) => [d.uuid, d]));
  for (const a of accepted) {
    const d = by.get(a.uuid);
    if (!d) continue;
    if (a.paStatus) Object.assign(d, { paStatus: a.paStatus, rule: null, confidence: null, reason: `${a.paStatus}: ${a.reason}`, partial: undefined });
    else if (a.debt) Object.assign(d, { paStatus: "port", debtReasons: a.debt.reasons, debtSubpack: a.debt.subpack, rule: null, confidence: null, reason: `${a.debt.reasons.join("; ")}: ${a.reason}`, partial: undefined });
  }
  return drafts;
}

/**
 * 0.5g4 п.35: вердикт с `partial: [пробел, …]` — правило перенесено, но по тексту оно неполно (то, чего схема не выражает). Такой документ засчитывается перенесённым, если правило не слабее PA;
 * слабее PA — долг, признака ему не ставят. Вердикт может нести правило (rule / accept) или быть чистой пометкой поверх выведенного правила. Совпадение — как у resolveAccepted (uuid либо slug + type + scope).
 */
export function annotateGaps(drafts, verdicts) {
  for (const a of verdicts) {
    if (!Array.isArray(a.partial)) continue;
    for (const d of drafts) if (a.uuid ? d.uuid === a.uuid : d.slug === a.slug && (!a.type || d.type === a.type) && (!a.scope || (a.scope === "npc") === d.uuid.includes(".Actor."))) d.gaps = a.partial;
  }
  return drafts;
}
/** Пометки без собственного правила (только partial) не входят в resolveAccepted: правило у документа уже есть. */
export const gapsOnly = (a) => Array.isArray(a.partial) && !a.rule && !a.accept && !a.paStatus && !a.debt;

/** Статусы false-coverage / pa-wrong, выставленные вручную (нет метки sim), сверяются с симулятором: fires(d) = PA срабатывает на документе. */
export function reconcileSim(drafts, fires, stats = {}) {
  for (const d of drafts) {
    if (!["false-coverage", "pa-wrong"].includes(d.paStatus)) continue;
    if (!d.sim) stats.manual = (stats.manual ?? 0) + 1;   // с меткой sim статус уже поставил симулятор; пересверяем лишь вердикт, перекрывший его вручную
    const f = fires(d), was = d.paStatus;
    d.paStatus = f ? "pa-wrong" : "false-coverage";
    d.sim = f ? "fires" : "no-fire";
    if (d.paStatus !== was) { stats[f ? "manualToWrong" : "manualToFalse"] = (stats[f ? "manualToWrong" : "manualToFalse"] ?? 0) + 1; d.reason = `${d.paStatus}: (симулятор PA) ${d.reason.replace(/^[a-z-]+:\s*/, "")}`; }
  }
  return drafts;
}

/** Итоговый статус черновика: ported | covered | native | false-coverage | debt (+ причины долга). */
export function statusOf(d, outcome) {
  if (["covered", "native", "false-coverage", "pa-wrong", "not-ported"].includes(d.paStatus)) return { status: d.paStatus };
  if (d.debtReasons) return { status: "debt", reasons: d.debtReasons };
  const o = outcome.get(d.uuid);
  if (o === "ported") return { status: "ported" };
  if (o === "manual-wins") return { status: "covered" };
  if (d.rule && o === "low") return { status: "debt", reasons: d.reason.split("; ")[1]?.split(",") ?? ["low"], low: true };
  if (d.rule) return { status: "debt", reasons: [o ?? "unknown"] };
  return { status: "debt", reasons: d.reason.split("; ") };
}

function main() {
  const { meta, items } = readOut("items.json");
  const html = readOut("html.json"), refs = readOut("refs.json"), tri = readOut("triage.json").items;
  const triBy = new Map(tri.map((t) => [t.uuid, t])), itBy = new Map(items.map((i) => [i.uuid, i]));
  const config = readJson(AUTOMATIONS_CONFIG);
  const catalogJsons = ["catalog.json", "catalog.campaign.json"].map((f) => readJson(join(ROOT, "rules", f)));
  const mSrc = new Set(catalogJsons.flatMap((c) => Object.keys(c.bySource ?? {}))), mSlug = new Set(catalogJsons.flatMap((c) => Object.keys(c.bySlug ?? {})));
  const canonOf = (slug) => { const k = ctx.slugKind?.get(slug); return k ? items.find((i) => !i.embedded && i.slug === slug && i.type === k.type && i.pack === k.pack) : null; };
  const tierN = {};
  for (const i of new Set(items.filter((x) => !x.embedded).map((x) => x.slug))) tierN[i.replace(TIER, "")] = (tierN[i.replace(TIER, "")] ?? 0) + 1;
  const tierSiblings = (it) => tierN[it.slug.replace(TIER, "")] > 1;
  const ctx = { ...makeContext({ refs, catalogJsons, items, labels: readJson(join(ROOT, "rules/labels.json")) }), grants: refs.grants, condIds: Object.fromEntries(Object.entries(refs.conditions).map(([k, c]) => [k, c.id])), effects: refs.effects, paEffects: readJson(join(ROOT, "tools/pa-effects.json")).effects, wraps: refs.wraps ?? {}, effectDur: refs.effectDur ?? {}, condSlugs: new Set(Object.keys(refs.conditions)), effectRisk: refs.effectRisk ?? {}, tierSiblings, actionBySlug: items.filter((i) => !i.embedded && i.type === "action").reduce((m, i) => m.set(i.slug, [...(m.get(i.slug) ?? []), i]), new Map()) };

  const groups = [];
  for (const g of config.groups) {
    const idx = buildAutomationsIndex([g])[0];
    if (idx) groups.push({ name: g.name, kind: g.group, rules: [...(g.baseRules ?? []), ...(g.complexRules ?? []), ...(g.handlerRules ?? [])], slugs: idx.slugs, uuids: idx.uuids, srcTypes: new Set([...idx.uuids].map((u) => itBy.get(u)?.type).filter(Boolean)), ownSlugs: new Set([...(g.source ?? []).filter((s) => !String(s).startsWith("Compendium.")), slugify(g.name)]),
      // предметы, названные собственным использованием группы (postInfo + origin:item:slug:X — тиры Warding Statuette): тоже владельцы событийных правил
      eventOwners: new Set((g.baseRules ?? []).filter((r) => r.triggerType === "postInfo").flatMap((r) => strongSlugs(tokensOf(r.predicate)))), docs: [] });
  }
  const bySlug = new Map(), byUuid = new Map();
  for (const g of groups) { for (const s of g.slugs) (bySlug.get(s) ?? bySlug.set(s, []).get(s)).push(g); for (const u of g.uuids) (byUuid.get(u) ?? byUuid.set(u, []).get(u)).push(g); }

  const paAll = paRules(config.groups), simOf = (it) => simulate(it, html[it.uuid] ?? "", paAll);
  const simStats = { heuristic: 0, confirmed: 0, returned: 0, noRoll: 0, noRollReturned: 0, fenced: 0, fencedWrong: 0 };
  const drafts = [], triCatalog = [];
  for (const it of items) {
    const t = triBy.get(it.uuid);
    if (!t || !["pa-port", "catalog"].includes(t.status)) continue;
    const src = it.embedded ? it.source : it.uuid;
    const gsAll = [...new Set([...(bySlug.get(it.slug) ?? []), ...(byUuid.get(src) ?? [])])];
    const viaSource = (g) => !!byUuid.get(src)?.includes(g);
    for (const g of gsAll) g.docs.push({ it, status: t.status, res: null });
    if (t.status === "catalog") { triCatalog.push(it.uuid); continue; }
    const gs0 = gsAll.filter((g) => !falseCoverage(g, it, viaSource(g)) && !kindMismatch(g, it, viaSource(g)));
    // документ — лишь условие правила чужой черты (Heroism в правиле Mentor of Legends: `origin:item:heroism` + `feat:mentor-of-legends`); у него есть и своя группа — берём её, правило черты живёт на черте
    const gsFilt = gs0.some((g) => !triggerOnly(g, it, viaSource(g))) ? gs0.filter((g) => !triggerOnly(g, it, viaSource(g))) : gs0;
    // эвристика говорит «ложное покрытие» — решает симулятор PA (tools/pa-sim.mjs): срабатывает — документ возвращается в перевод со всеми группами
    let simNone = false;
    if (!gsFilt.length && gsAll.length && !(src && mSrc.has(src))) { simStats.heuristic++; if (simOf(it).length) simStats.returned++; else { simStats.confirmed++; simNone = true; } }
    const gs = gsFilt.length ? gsFilt : simNone ? [] : gsAll;
    const base = { uuid: it.uuid, slug: it.slug, type: it.type, name: it.name, nameRu: it.nameRu, layer: 3, status: "pa-port", groups: gsAll.map((g) => g.name), batch: t.batchName };
    if (src && mSrc.has(src)) { drafts.push({ ...base, paStatus: "covered", confidence: null, reason: "covered: ручной каталог по источнику", rule: null }); continue; }
    if (!gs.length) { drafts.push({ ...base, paStatus: "false-coverage", sim: "no-fire", confidence: null, reason: `false-coverage: симулятор PA — ни одно правило на карточке/броске документа не срабатывает (группы: ${gsAll.map((g) => g.name).join(", ")})`, rule: null }); continue; }
    // у предмета несколько групп — берём группу с правилами; результаты склеиваются только по первой переводимой
    let best = null;
    for (const g of gs) {
      const r = translateItem(it, html[it.uuid] ?? "", g, ctx, { viaSource: viaSource(g), slugOnly: !viaSource(g) });
      g.docs.find((d) => d.it === it).res = r;
      if (!best || (r.rule && !best.rule)) best = { ...r, group: g.name };
    }
    const { native, builtin, slugOnly, group, stub, stubActions, ...res } = best;
    if (stub) {
      const nat = stubActions.some((a) => a.selfEffect);
      drafts.push({ ...base, paStatus: "covered", confidence: null, reason: `covered: черта лишь выдаёт действие «${it.slug}»; ${nat ? "действие покрыто родным selfEffect pf2e" : "правило PA лежит в каталоге ключом bySlug без типа и срабатывает на любом документе с этим slug — как у PA"}`, rule: null });
      continue;
    }
    // правило PA ждёт спасбросок с этим slug, а в документе спасброска нет (пассив «Slow» у зомби, Удар вместо заклинания): PA на нём не срабатывает — ложное покрытие
    const noRoll = !res.rule && res.reason.split("; ").every((x) => x === "no-roll-in-doc"), noRollFires = noRoll && simOf(it).length > 0;
    if (noRoll) { simStats.noRoll++; if (noRollFires) simStats.noRollReturned++; }
    if (noRoll && !noRollFires) { drafts.push({ ...base, paStatus: "false-coverage", sim: "no-fire", noSave: true, confidence: null, reason: "false-coverage: PA срабатывает по спасброску с этим slug, а в документе спасброска нет", rule: null }); continue; }
    // ручное правило по тому же slug: покрывает, только если описывает этот же предмет так же (иначе долг manual-gap / slug-collision)
    if (mSlug.has(it.slug)) {
      const manual = ctx.catalog.bySlug.get(it.slug);
      const html0 = html[it.uuid] ?? "";
      const derived = res.rule ?? (() => { const d = deriveFromMarkup({ type: it.type, slug: it.slug, name: it.name, system: { description: { value: html0 }, defense: it.defense ? { save: { statistic: it.defense.save, basic: it.defense.basic } } : undefined, area: it.area ? {} : undefined, target: it.target ?? undefined, actionType: { value: it.actionType }, traits: { value: it.traits } } }, ctx.labels, ctx.condSlugByUuid, ctx.condNames); return d?.rule ?? null; })();
      const canon = canonOf(it.slug);
      const v = manualVerdict(manual, it, derived, res.rule ? null : res.reason, ctx.slugKind?.get(it.slug), html0, canon ? markersOf(html[canon.uuid]) === markersOf(html0) : null);
      // тёзка, которого resolveRule к ручному правилу не пускает. Армейская способность и NPC со своим спасброском вместо проверки: PA здесь срабатывает (postInfo / бросок по slug), но эффект не тот — ложное покрытие по смыслу.
      // Делегирование [[/act slug]]: бросок делает базовое действие, на него срабатывают и PA, и наше ручное правило (scripts/actions.mjs) — покрыто.
      const mkRule = derivedOf(it, html0, ctx)?.rule;
      // + resolveRule не даёт правило-проверку/макрос по slug тёзке без источника и без броска в тексте (lacksOwnRoll)
      const fenced = (v.status === "slug-collision" && ((it.type === "campaignFeature" && v.reasons.includes("type-differs")) || (!it.source && slugCollides(manual, mkRule, it.slug, "")))) || (!it.source && lacksOwnRoll(manual, it.slug, html0));
      const delegated = v.status === "slug-collision" && !fenced && !it.source && slugCollides(manual, null, it.slug, html0);
      if (delegated) drafts.push({ ...base, paStatus: "covered", confidence: null, reason: "covered: делегирует базовому действию [[/act slug]], ручное правило сработает через actions.mjs", rule: null });
      else if (fenced) {
        // ручное правило по slug сюда не пускает resolveRule (другая механика у тёзки). PA на карточке срабатывает? тогда он ставит чужой эффект — pa-wrong; нет — ложное покрытие
        const fires = simOf(it).length > 0;
        simStats.fenced++; if (fires) simStats.fencedWrong++;
        drafts.push({ ...base, paStatus: fires ? "pa-wrong" : "false-coverage", sim: fires ? "fires" : "no-fire", confidence: null, reason: fires ? "pa-wrong: PA срабатывает на карточке, но ставит эффект другой способности-тёзки; ручное правило по slug здесь не применяется (resolveRule)" : "false-coverage: симулятор PA — не срабатывает; ручное правило по slug здесь не применяется (resolveRule)", rule: null });
      }
      else if (v.status === "covered") drafts.push({ ...base, paStatus: "covered", confidence: null, reason: "covered: ручной каталог по slug", rule: null });
      else drafts.push({ ...base, paStatus: v.status, debtReasons: v.reasons, confidence: null, reason: v.reasons.join(","), rule: null });
      continue;
    }
    drafts.push({ ...base, ...(native && { paStatus: "native" }), ...(builtin && { paStatus: "covered" }), ...(res.reason === MARKER && { paStatus: "not-ported" }), ...(slugOnly && it.embedded && { slugOnly: true }), confidence: res.confidence, reason: res.reason, rule: res.rule, ...(res.lifted && { lifted: res.lifted }), ...(res.paEffects && { paEffects: res.paEffects }), ...(res.partial && { partial: res.partial }) });
  }
  drafts.forEach((d) => { d.paStatus ??= "port"; });
  // ручной вердикт по документу (drafts-accepted/pa-port.json): paStatus — покрыто/ложное покрытие/pf2e делает сам; debt — долг в указанную подпачку
  // вердикты 0.5g4 лежат в своём файле и идут последними (при совпадении побеждает последняя запись)
  const ap = join(ACCEPTED, "pa-port.json"), ap4 = join(ACCEPTED, "pa-port.g4.json"), verdicts = [...(existsSync(ap) ? readJson(ap).items : []), ...(existsSync(ap4) ? readJson(ap4).items : [])];
  const acceptedItems = resolveAccepted(verdicts.filter((a) => !gapsOnly(a)), drafts, (d) => derivedOf(itBy.get(d.uuid), html[d.uuid] ?? "", ctx)?.rule ?? null);
  applyAccepted(drafts, acceptedItems);
  annotateGaps(drafts, verdicts);
  // ручные «ложное покрытие» / «pa-wrong» проверяет симулятор: срабатывает — это pa-wrong (эффект противоречит тексту), не срабатывает — ложное покрытие
  simStats.manual = 0; simStats.manualToWrong = 0; simStats.manualToFalse = 0;
  reconcileSim(drafts, (d) => simOf(itBy.get(d.uuid)).length > 0, simStats);

  // шипуемый каталог; included — для выборки Критика (tools/sample.mjs pa-port)
  const { cat, skipped, included, outcome } = buildPaCatalog(drafts, acceptedItems, items, catalogJsons);
  // правила-носители на эффектах (tools/pa-carriers.mjs): bySource по uuid эффекта, документа PA у них нет
  for (const [uuid, rule] of Object.entries(CARRIERS)) {
    const v = validateRule(rule);
    if (!v.ok || !roundTrip(v.rule)) throw new Error(`pa-carriers: ${uuid}: ${(v.errors ?? []).join("; ") || "форма не проходит туда-обратно"}`);
    cat.bySource[uuid] = withMarks(v.rule);
  }
  writeText(join(ROOT, "rules/catalog.pa.json"), serializeCatalog(cat));

  // сводка: у каждого документа ровно один статус
  const docs = { total: drafts.length + triCatalog.length, ported: 0, covered: triCatalog.length, native: 0, falseCoverage: 0, paWrong: 0, notPorted: 0, debt: 0 };
  const debt = { bySubpack: {}, byReason: {}, lowByReason: {}, handlers: {} };
  const fin = new Map(triCatalog.map((u) => [u, "covered"]));
  for (const d of drafts) {
    const s = statusOf(d, outcome);
    fin.set(d.uuid, s.status);
    d.finalStatus = s.status;
    if (s.status !== "debt") { docs[{ ported: "ported", covered: "covered", native: "native", "false-coverage": "falseCoverage", "pa-wrong": "paWrong", "not-ported": "notPorted" }[s.status]]++; continue; }
    docs.debt++;
    const keys = [...new Set(s.reasons.map((x) => x.split(":")[0]))];
    const sp = d.debtSubpack ?? subpackOf(s.reasons);
    d.debt = { subpack: sp, reasons: s.reasons };
    debt.bySubpack[sp] = (debt.bySubpack[sp] ?? 0) + 1;
    for (const k of keys) { const b = s.low ? debt.lowByReason : debt.byReason; b[k] = (b[k] ?? 0) + 1; }
    for (const m of d.reason.matchAll(/handler:([A-Za-z0-9_]+)/g)) debt.handlers[m[1]] = (debt.handlers[m[1]] ?? 0) + 1;
  }
  // сводка по группам PA
  const gs = { total: groups.length, ported: 0, script: 0, primitive: 0, manual: 0 }, gmanual = {};
  for (const g of groups) {
    const rs = g.docs.map((d) => (fin.get(d.it.uuid) !== "debt" ? "ok" : d.res?.rule ? "low" : d.res?.reason ?? "unmatched"));
    if (!rs.length) { gs.manual++; gmanual.unmatched = (gmanual.unmatched ?? 0) + 1; continue; }
    if (g.docs.every((d) => d.status === "catalog")) { gs.ported++; continue; }
    const fails = rs.filter((x) => x !== "ok").flatMap((x) => x.split("; ").map((y) => y.split(":")[0]));
    if (!fails.length) gs.script++;
    else if (fails.some((f) => MANUAL_REASONS.has(f))) { gs.manual++; for (const f of new Set(fails)) gmanual[f] = (gmanual[f] ?? 0) + 1; }
    else gs.primitive++;
  }
  const debts = existsSync(join(ROOT, "pa-port-report.md")) ? parseDebts(readFileSync(join(ROOT, "pa-port-report.md"), "utf8")) : [];
  const outside = docs.falseCoverage + docs.paWrong + docs.notPorted;   // вне знаменателя: ложное покрытие, PA ошибается (при выключении PA верное не теряется), не переносимое по решению
  // партиальные: перенесены (ported), но по тексту неполны; один пункт на slug и набор пробелов (копии NPC считаются в docs)
  const partial = new Map();
  for (const d of drafts.filter((x) => x.gaps && x.finalStatus === "ported")) { const k = `${d.slug}|${d.gaps.join("|")}`; const e = partial.get(k) ?? partial.set(k, { slug: d.slug, name: d.name, gaps: d.gaps, docs: 0 }).get(k); e.docs++; }
  for (const d of drafts.filter((x) => x.gaps && x.finalStatus !== "ported" && x.paStatus !== "covered" && x.paStatus !== "false-coverage")) console.warn(`pa-port: partial без переноса (${d.finalStatus}): ${d.slug} ${d.uuid}`);
  const partialList = [...partial.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  const paWrongList = drafts.filter((d) => d.paStatus === "pa-wrong").map((d) => ({ uuid: d.uuid, slug: d.slug, name: d.name, reason: d.reason }));
  const summary = { paVersion: config.version, docs: { ...docs, applicable: docs.total - outside, done: docs.ported + docs.covered + docs.native, partial: partialList.reduce((n, x) => n + x.docs, 0), percent: +((100 * (docs.ported + docs.covered + docs.native)) / (docs.total - outside)).toFixed(1) }, sim: simStats, paWrongList, partialList, debt: { total: docs.debt, ...debt }, groups: gs, manualReasonsByGroup: gmanual, catalog: { bySource: Object.keys(cat.bySource).length, bySlug: Object.keys(cat.bySlug).length, skipped }, debts };
  writeJson(outPath("pa-port.json"), summary);
  const head = `{"meta":${JSON.stringify({ batch: "pa-port", generatedAt: new Date().toISOString(), pf2eVersion: meta.pf2eVersion, paVersion: config.version, counts: docs })},\n"items":[\n`;
  writeText(join(ROOT, "rules/drafts/pa-port.json"), head + drafts.map((d) => JSON.stringify(d)).join(",\n") + "\n]}\n");

  // выборка Критика: только правила, которых не было в каталоге на ревизии --since (по умолчанию HEAD) или у которых правило изменилось
  const since = arg("since", "HEAD");
  let prev = { bySource: {}, bySlug: {} };
  try { prev = JSON.parse(execFileSync("git", ["show", `${since}:rules/catalog.pa.json`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 })); } catch { console.warn(`pa-port: нет rules/catalog.pa.json на ${since}, все правила считаются новыми`); }
  // ключ предмета — источник; по slug судим лишь копии без источника (slug-запись у предмета с источником — то же уже виденное правило)
  const differs = (c) => (c.catSource ? JSON.stringify(prev.bySource[c.catSource]) !== JSON.stringify(cat.bySource[c.catSource]) : JSON.stringify(prev.bySlug[c.catSlug]) !== JSON.stringify(cat.bySlug[c.catSlug]));
  const fresh = included.filter(differs);
  writeJson(outPath("pa-catalog.json"), { since, items: fresh, all: included.length });
  console.log("pa-port:", JSON.stringify({ docs: summary.docs, debt: summary.debt.bySubpack, catalog: summary.catalog, newRules: fresh.length }));
}

if (isMain(import.meta.url)) main();
