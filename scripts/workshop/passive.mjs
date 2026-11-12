// Мастерская, режим «Пассивное»: чистое ядро (без Foundry при импорте, node-тесты).
// Правила предмета (item._source.system.rules) <-> свойства палитры «Эффекта». Типизированным блок становится, только если
// правило восстанавливается из него один в один; всё остальное — raw с исходным объектом (orig), который при сохранении отдаётся как есть.
import * as fx from "./effect.mjs";
import { parseWhen, whenText, isPredicate } from "../predicate.mjs";

export const ABILITY_TYPES = new Set(["action", "feat"]);
const COND_UUID = /^Compendium\.[^.]+\.conditionitems\.Item\./;   // как в rules.mjs
const SUBST = /\{[a-z]+\|/i;   // подстановка pf2e {item|id}, {actor|…}: в типизированное свойство не берём

function deepEq(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && deepEq(a[k], b[k]));
}

const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === "string";
const has = (list, v) => isStr(v) && list.includes(v);

/** Правила блока в форме, пригодной для обновления существующего предмета: GrantItem — только inMemoryOnly (при item.update pf2e сам ничего не выдаёт). */
export function rulesOf(b, ctx) {
  return fx.rulesOf(b, ctx).map((r) => {
    if (b.kind !== "cond" || r.key !== "GrantItem") return r;
    const { onDeleteActions, ...rest } = r;
    return { ...rest, inMemoryOnly: true };
  });
}

/** Правило, которое нельзя править здесь: ChoiceSet и GrantItem без inMemoryOnly pf2e обрабатывает при создании предмета. */
export const readonlyRule = (r) => !!r && (r.key === "ChoiceSet" || (r.key === "GrantItem" && r.inMemoryOnly !== true));

/** Кандидат типизированного свойства по правилу; null — не подходит по типам. */
function candidate(r, ctx) {
  const n = r.value;
  switch (r.key) {
    case "FlatModifier": {
      if (!isInt(n) || n === 0 || !has(fx.BONUS_TYPES, r.type)) return null;
      const base = { sign: n < 0 ? -1 : 1, value: Math.abs(n), type: r.type };
      if (r.selector === "speed" || has(fx.SPEED_SEL, r.selector)) return { kind: "speed", ...base, sel: r.selector };   // speed — домен каждой скорости, по смыслу all-speeds
      if (has(fx.TARGETS, r.selector)) return { kind: "bonus", ...base, target: r.selector };
      const atk = fx.strikeSlug(r.selector, "attack"), dmg = atk ? null : fx.strikeSlug(r.selector, "damage");
      return atk || dmg ? { kind: "bonus", ...base, target: atk ? "attack-roll" : "damage", strike: atk ?? dmg } : null;
    }
    case "Resistance":
      if (!has(fx.RESIST_TYPES, r.type) || !isNum(n) || n <= 0) return null;
      if (r.exceptions !== undefined && !(Array.isArray(r.exceptions) && r.exceptions.every(isStr))) return null;
      return { kind: "resist", dmg: r.type, value: n, except: (r.exceptions ?? []).join(", ") };
    case "TempHP": return isNum(n) ? { kind: "temphp", value: n } : null;
    case "FastHealing": return isNum(n) ? { kind: "fastheal", value: n } : null;
    case "DamageDice": {
      const strike = r.selector === "strike-damage" ? "" : fx.strikeSlug(r.selector, "damage");
      return strike !== null && isInt(r.diceNumber) && has(fx.DICE, r.dieSize) && has(fx.DAMAGE_TYPES, r.damageType) ? { kind: "dmg", number: r.diceNumber, die: r.dieSize, dmgType: r.damageType, strike } : null;
    }
    case "Sense":
      if (!has(fx.SENSES, r.selector) || (r.acuity !== undefined && !has(fx.ACUITY, r.acuity)) || (r.range !== undefined && !isNum(r.range))) return null;
      return { kind: "sense", sense: r.selector, acuity: r.acuity ?? "imprecise", range: r.range ?? 30 };
    case "Note":
      return has(fx.TARGETS, r.selector) && isStr(r.text) && (r.title === undefined || isStr(r.title)) ? { kind: "note", target: r.selector, title: r.title ?? "", text: r.text } : null;
    case "Aura":
      return isNum(r.radius) && (r.slug === undefined || isStr(r.slug)) ? { kind: "aura", slug: r.slug ?? "", radius: r.radius } : null;
    case "TokenLight":
      return r.value && isNum(r.value.bright) && isNum(r.value.dim) ? { kind: "light", bright: r.value.bright, dim: r.value.dim } : null;
    case "GrantItem": {
      if (!isStr(r.uuid) || !COND_UUID.test(r.uuid) || r.inMemoryOnly !== true) return null;
      const slug = ctx.slugOf?.(r.uuid);
      if (!slug) return null;
      const al = r.alterations;
      return { kind: "cond", slug, uuid: "", name: "", valued: !!al, value: al?.[0]?.value ?? 1 };
    }
  }
  return null;
}

/** Правило -> блок. Типизированный — только если rulesOf(блок) даёт ровно это правило; иначе raw (JSON как есть, ro — правится не здесь). */
export function blockOf(rule, ctx = {}) {
  let c = null;
  if (rule && typeof rule === "object" && !Array.isArray(rule) && !strings(rule).some((s) => SUBST.test(s))) {
    const { predicate, ...rest } = rule;
    c = candidate(rest, ctx);
    // условие становится полем when, только если запись when даёт тот же предикат (круг без потерь) и вид условие берёт
    if (c && predicate !== undefined) c = fx.WHEN_KINDS.has(c.kind) && isPredicate(predicate) && deepEq(parseWhen(whenText(predicate)), predicate) ? { ...c, when: whenText(predicate) } : null;
  }
  if (c) {
    const r = rulesOf(c, ctx);
    if (r.length === 1 && deepEq(r[0], rule)) return c;
  }
  return { kind: "raw", json: JSON.stringify(rule, null, 2), ...(readonlyRule(rule) && { ro: true }) };
}

export const readBlocks = (rules, ctx) => (rules ?? []).map((r) => ({ ...blockOf(r, ctx), orig: r }));

/** Правила блока для записи. Неизменённый блок отдаёт исходный объект (порядок ключей, форма чисел — байт в байт). */
export function emit(b, ctx) {
  if (b.orig !== undefined) {
    if (b.kind === "raw" && b.json === JSON.stringify(b.orig, null, 2)) return [b.orig];   // в том числе правило без key, которое raw разобрать не умеет
    const r = rulesOf(b, ctx);
    if (r.length === 1 && deepEq(r[0], b.orig)) return [b.orig];
    return r;
  }
  return rulesOf(b, ctx);
}
export const emitAll = (blocks, ctx) => blocks.flatMap((b) => emit(b, ctx));
const untouched = (b, ctx) => { const e = emit(b, ctx); return e.length === 1 && e[0] === b.orig; };

/** Ограничения для GrantItem из блоков: только состояния, и только в форме inMemoryOnly. Общее у «Пассивного» и мастера предмета. */
export function grantErrors(blocks, ctx) {
  const { t } = ctx, out = [];
  blocks.forEach((b, i) => {
    const bad = b.kind === "cond" ? !!b.uuid : b.kind === "raw" && fx.rulesOf(b, ctx).some((r) => r.key === "GrantItem" && !(r.inMemoryOnly === true && COND_UUID.test(String(r.uuid))));
    if (bad) out.push(t("workshop.err.block", { n: i + 1, what: t(`workshop.item.err.${b.kind === "cond" ? "condEffect" : "rawGrant"}`) }));
  });
  return out;
}

/** Ошибки сохранения; пустой список блоков допустим. Неизменённые блоки не проверяются (чужое правило не мешает сохранить остальное). */
export function validatePassive(blocks, ctx) {
  if (!blocks.length) return [];
  const checked = blocks.map((b) => (untouched(b, ctx) ? { kind: "temphp", value: 1 } : b));   // заглушка сохраняет нумерацию «свойство N»
  return [...fx.validate({ ...fx.blankModel(), name: "x", blocks: checked }, ctx), ...grantErrors(checked, ctx)];
}
