// Inline-эффект шага правила: `effect: { mods: [...] }` — числовой модификатор / слабость / сопротивление / запрет реакций без готового эффекта pf2e.
// Данные модели — только типизированные кубики (белый список ниже); Rule Elements строит код (rulesOf Мастерской), сырых RE из данных нет.
// Чистый модуль (без Foundry при импорте): им пользуются валидатор rules.mjs, apply.mjs, sheet.mjs, chat.mjs и node-тесты.
import { rulesOf, textOf, STEP_TARGETS, BONUS_TYPES, RESIST_TYPES, NO_REACTIONS } from "./workshop/effect.mjs";

export const MOD_KINDS = ["bonus", "speed", "resist", "weak", "forbid"];   // явный список, не весь KINDS Мастерской
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const MAX_MODS = 4;
const KEYS = { bonus: ["target", "type", "value"], speed: ["type", "value"], resist: ["dmg", "value", "except"], weak: ["dmg", "value"] };

/** mods шага -> { mods: нормализованный список, error: true|null }. Знак штраф/бонус не проверяем (источник правды — текст предмета). */
export function normalizeMods(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_MODS) return { mods: [], error: true };
  const out = [];
  for (const m of list) {
    if (!isObj(m) || Object.keys(m).length !== 1) return { mods: [], error: true };
    const [kind, v] = Object.entries(m)[0];
    if (!MOD_KINDS.includes(kind)) return { mods: [], error: true };
    if (kind === "forbid") { if (v !== "reactions") return { mods: [], error: true }; out.push({ forbid: "reactions" }); continue; }
    if (!isObj(v) || Object.keys(v).some((k) => !KEYS[kind].includes(k))) return { mods: [], error: true };
    const lim = kind === "bonus" || kind === "speed" ? 50 : 100;
    if (!isInt(v.value) || v.value === 0 || Math.abs(v.value) > lim || ((kind === "resist" || kind === "weak") && v.value < 0)) return { mods: [], error: true };
    if (kind === "bonus" && !(STEP_TARGETS.includes(v.target) && BONUS_TYPES.includes(v.type))) return { mods: [], error: true };
    if (kind === "speed" && !BONUS_TYPES.includes(v.type)) return { mods: [], error: true };
    if ((kind === "resist" || kind === "weak") && !RESIST_TYPES.includes(v.dmg)) return { mods: [], error: true };
    if (kind === "resist" && v.except != null && !(Array.isArray(v.except) && v.except.length <= 5 && v.except.every((x) => typeof x === "string" && SLUG.test(x)))) return { mods: [], error: true };
    out.push({ [kind]: { ...v, ...(v.except != null && { except: [...v.except] }) } });
  }
  if (new Set(out.map((m) => Object.keys(m)[0] + (m.bonus?.target ?? ""))).size !== out.length) return { mods: [], error: true };   // дубль кубика — ошибка модели, а не два одинаковых RE
  return { mods: out, error: null };
}

/** Кубик шага -> кубик Мастерской ({bonus:{value:-2}} -> {kind, sign, value}). */
export function blockOf(m) {
  const [kind, v] = Object.entries(m)[0];
  if (kind === "forbid") return { kind };
  const b = { kind, ...v };
  if (kind === "bonus" || kind === "speed") { b.sign = v.value < 0 ? -1 : 1; b.value = Math.abs(v.value); }
  if (kind === "resist") b.except = (v.except ?? []).join(",");
  return b;
}

/** slug у каждого RE: без него pf2e берёт slug из имени эффекта и схлопывает одинаковые FlatModifier (оставляет больший). */
export const rulesOfMods = (mods) => mods.flatMap((m) => rulesOf(blockOf(m))).map((r, i) => ({ ...r, slug: `af-${i}` }));
export const textOfMods = (mods, ctx) => mods.map((m) => textOf(blockOf(m), ctx)).join("; ");
/** На актёре есть эффект с запретом реакций: реакции модуля (reactionAvailable, Удар по реакции) подсказок не дают. */
/** Через roll options актёра, а не сырые правила: у истёкшего эффекта pf2e ставит правилам ignored. */
export const noReactions = (actor) => !!actor?.getRollOptions?.(["all"]).includes(NO_REACTIONS);

/** slug эффекта: детерминированный, по предмету-источнику (removeEffect/extendEffect находят его по slug; язык и номер не влияют). */
export const inlineSlug = (itemSlug) => `af-${String(itemSlug || "effect").replace(/^af-/, "")}`;
