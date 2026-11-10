// Переопределения встроенных механизмов на предмете: flags.pf2e-automato.mech (отдельно от флага rule: правило-флаг имеет высший приоритет в resolveRule,
// пустое правило ради переключателя отключило бы мировой каталог, каталог и разметку). Чистый модуль (без Foundry): его читают рантайм и Мастерская.
//   recharge: false | "1d6" — «не ограничивать» / свой срок в раундах;  req: false — не проверять требование;  strike: false — не запускать Ударом;
//   maneuvers: ["disarm", …] — подмножество таблицы манёвров;  permanent: false — не накладывать постоянное состояние.
// Неизвестные и невалидные ключи отбрасываются молча (как itemFlagRule): чужой флаг ничего не ломает.
import { MOD, flagPath, forcedReplace, forcedDelete } from "./util.mjs";
import { parseDice, rechargeFull, rechargeIds } from "./builtin/limit-text.mjs";

export const MANEUVERS = ["disarm", "shove", "reposition", "trip"];

/** Предметы, на которые действуют лимиты использования: тот же фильтр, что в preCreate (impulse-gate). */
const USE_ITEMS = new Set(["spell", "action", "feat"]);
export const isUseItem = (item) => USE_ITEMS.has(item?.type);

const diceOf = (s) => { const d = String(s ?? "").replace(/\s+/g, "").toLowerCase().replace(/к/g, "d"); return parseDice(d) ? d : null; };   // «1к6» — как 1d6 (кириллица на русской раскладке)

/** Чистая: сырой флаг -> объект только с допустимыми ключами. */
export function normalizeMech(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (raw.recharge === false) out.recharge = false;
  else if (typeof raw.recharge === "string" && diceOf(raw.recharge)) out.recharge = diceOf(raw.recharge);
  for (const k of ["req", "strike", "permanent"]) if (raw[k] === false) out[k] = false;
  if (Array.isArray(raw.maneuvers)) { const l = MANEUVERS.filter((m) => raw.maneuvers.includes(m)); if (l.length) out.maneuvers = l; }
  return out;
}

/** Переопределения предмета (документ или _source). */
export const mechOf = (item) => normalizeMech(item?.flags?.[MOD]?.mech);

const namesOf = (i) => [i?.name, i?.slug, i?.flags?.babele?.originalName];   // перевод и исходное английское имя: подпись броска бывает на любом

/** M1 без переопределения: {dice, ids} по тексту описания; ids — предметы актёра, на которые ложится замок (подпись броска = имя своего предмета и/или другой способности актёра);
 *  null — перезарядки нет или она чужая и такой способности у актёра нет. Тип предмета — как у лимитов в рантайме. */
export function rechargeBase(item) {
  const r = isUseItem(item) ? rechargeFull(item.system?.description?.value) : null;
  if (!r) return null;
  const others = [...(item.actor?.items ?? [])].map((i) => ({ id: i.id, names: namesOf(i) }));
  const ids = rechargeIds(r.label, namesOf(item), item.id, others, r.cant);
  return ids.length ? { dice: r.dice, ids } : null;
}

/** M1 как исполняет рантайм: null — перезарядки нет (текста нет, «не ограничивать»); иначе {dice} с учётом своего срока. */
export function rechargeEntry(item) {
  const r = rechargeBase(item), m = mechOf(item).recharge;
  return r && m !== false ? { dice: m ?? r.dice, ids: r.ids } : null;
}

/** Форма окна: {recharge:{off,dice}, req:{off}, strike:{off}, maneuvers:{auto,list:{ключ: bool}}, permanent:{off}}. */
export const mechToForm = (m) => ({
  recharge: { off: m.recharge === false, dice: typeof m.recharge === "string" ? m.recharge : "" },
  req: { off: m.req === false }, strike: { off: m.strike === false }, permanent: { off: m.permanent === false },
  maneuvers: { auto: !m.maneuvers, list: Object.fromEntries(MANEUVERS.map((k) => [k, !!m.maneuvers?.includes(k)])) }
});

const on = (v) => v === true || v === "true";

/**
 * Убирает переопределение, равное значению по умолчанию (срок как в тексте, список манёвров как автоматический): оно ничего не меняет,
 * а в предмете висело бы пилюлей «Изменено». base — {dice, maneuvers} из найденных механизмов предмета.
 */
export function pruneMech(m, base = {}) {
  const o = { ...m };
  if (typeof o.recharge === "string" && o.recharge === diceOf(base.dice)) delete o.recharge;
  if (o.maneuvers && base.maneuvers && MANEUVERS.every((k) => o.maneuvers.includes(k) === base.maneuvers.includes(k))) delete o.maneuvers;
  return o;
}

/** Форма -> флаг (нормализованный и без значений по умолчанию; пустой объект — флага нет). */
export const formToMech = (f, base) => pruneMech(normalizeMech({
  recharge: on(f.recharge.off) ? false : f.recharge.dice,
  ...(on(f.req.off) && { req: false }), ...(on(f.strike.off) && { strike: false }), ...(on(f.permanent.off) && { permanent: false }),
  maneuvers: on(f.maneuvers.auto) ? undefined : MANEUVERS.filter((k) => on(f.maneuvers.list[k]))
}), base);

/** Ключи строк ошибок формы (workshop.mech.err.*); пусто — можно сохранять. */
export function mechErrors(f) {
  const err = [];
  if (!on(f.recharge.off) && String(f.recharge.dice ?? "").trim() && !diceOf(f.recharge.dice)) err.push("workshop.mech.err.dice");
  if (!on(f.maneuvers.auto) && !MANEUVERS.some((k) => on(f.maneuvers.list[k]))) err.push("workshop.mech.err.maneuvers");
  return err;
}

/**
 * Что записать в предмет: каждая часть — только если менялась. Без правки правила флаг rule не пишется (раньше пустое onUse перекрывало
 * мир, каталог и разметку, а разметка становилась доверенной). mech: пусто — флаг удаляется.
 */
export function savePatch({ ruleDirty, rule, areaPatch, mechDirty, mech }) {
  return {
    ...(ruleDirty && { ...forcedReplace(flagPath("rule"), rule), ...areaPatch }),
    ...(mechDirty && (Object.keys(mech ?? {}).length ? forcedReplace(flagPath("mech"), mech) : forcedDelete(flagPath("mech"))))
  };
}
