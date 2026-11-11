// Переопределения встроенных механизмов на предмете: flags.pf2e-automato.mech (отдельно от флага rule: правило-флаг имеет высший приоритет в resolveRule,
// пустое правило ради переключателя отключило бы мировой каталог, каталог и разметку). Чистый модуль (без Foundry): его читают рантайм и Мастерская.
//   recharge: false | "1d6" | {on:"button", dice?} — «не ограничивать» / свой срок в раундах (авто после использования) / по кнопке на карточке (срок из текста, если dice нет);  req: false — не проверять требование;  strike: false — не запускать Ударом;
//   maneuvers: ["disarm", …] — подмножество таблицы манёвров;  permanent: false — не накладывать постоянное состояние.
// Неизвестные и невалидные ключи отбрасываются молча (как itemFlagRule): чужой флаг ничего не ломает.
import { MOD, sluggify, flagPath, forcedReplace, forcedDelete } from "./util.mjs";
import { parseDice, rechargeFull, rechargeIds } from "./builtin/limit-text.mjs";

export const MANEUVERS = ["disarm", "shove", "reposition", "trip"];

/** Предметы, на которые действуют лимиты использования: тот же фильтр, что в preCreate (impulse-gate). */
export const USE_ITEMS = new Set(["spell", "action", "feat"]);
export const isUseItem = (item) => USE_ITEMS.has(item?.type);

const diceOf = (s) => { const d = String(s ?? "").replace(/\s+/g, "").toLowerCase().replace(/к/g, "d"); return parseDice(d) ? d : null; };   // «1к6» — как 1d6 (кириллица на русской раскладке)

/** Чистая: сырой флаг -> объект только с допустимыми ключами. */
export function normalizeMech(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (raw.recharge === false) out.recharge = false;
  else if (typeof raw.recharge === "string" && diceOf(raw.recharge)) out.recharge = diceOf(raw.recharge);
  else if (raw.recharge?.on === "button" && (raw.recharge.dice == null || diceOf(raw.recharge.dice))) out.recharge = { on: "button", ...(raw.recharge.dice != null && { dice: diceOf(raw.recharge.dice) }) };
  for (const k of ["req", "strike", "permanent"]) if (raw[k] === false) out[k] = false;
  if (Array.isArray(raw.maneuvers)) { const l = MANEUVERS.filter((m) => raw.maneuvers.includes(m)); if (l.length) out.maneuvers = l; }
  return out;
}

/** Переопределения предмета (документ или _source). */
export const mechOf = (item) => normalizeMech(item?.flags?.[MOD]?.mech);

// Подпись броска в тексте не совпадает с именем единственной способности (другое название той же способности в описании): карта по slug, одна запись.
// ponytail: вручную; новые случаи добавлять сюда, пока их меньше порога примитива.
const RECHARGE_ALIAS = { "fog-of-chance": ["Fortune Fog"], "breath-weapon": ["Dragonstorm Breath"] };   // второе — Lesser Manifestation of Dahak (проверка названа Dragonstorm Breath)
// slug предмета бывает пуст (system.slug null у способностей NPC): запасной путь — slug исходного английского имени
const aliasOf = (i) => RECHARGE_ALIAS[i?.slug] ?? RECHARGE_ALIAS[sluggify(i?.flags?.babele?.originalName ?? i?.name ?? "")] ?? [];
const namesOf = (i) => [i?.name, i?.slug, i?.flags?.babele?.originalName, ...aliasOf(i)];   // перевод и исходное английское имя: подпись броска бывает на любом

/** Текст описания: {dice, ids, conditional} | null. ids — предметы актёра, на которые ложится замок (подпись броска = имя своего предмета и/или другой способности актёра); пусто — перезарядка чужая
 *  и такой способности у актёра нет. dice у условного броска может быть null (разные броски). Тип предмета — как у лимитов в рантайме. */
function rechargeText(item) {
  const r = isUseItem(item) ? rechargeFull(item.system?.description?.value) : null;
  if (!r) return null;
  const others = [...(item.actor?.items ?? [])].map((i) => ({ id: i.id, names: namesOf(i) }));
  return { dice: r.dice, ids: rechargeIds(r.label, namesOf(item), item.id, others, r.cant), conditional: !!r.conditional };
}

/** M1 без переопределения: {dice, ids} безусловной перезарядки по тексту; null — перезарядки нет, она условная (автозамка нет) или чужая. */
export function rechargeBase(item) {
  const r = rechargeText(item);
  return r && !r.conditional && r.ids.length ? { dice: r.dice, ids: r.ids } : null;
}

/** Текст, как есть: условная перезарядка тоже (для Мастерской и кнопки). */
export const rechargeTextOf = rechargeText;

/**
 * Перезарядка предмета с учётом переопределения: {dice, ids, mode: "auto"|"button"} | null.
 * false -> null; {on:"button"} -> по кнопке (срок свой или из текста); "1d4" -> авто (у нераспознанного замок на самом предмете);
 * флага нет: безусловный текст -> авто, условный со сроком -> по кнопке, иначе null.
 */
export function rechargeSpec(item) {
  if (!isUseItem(item)) return null;
  const m = mechOf(item).recharge;
  if (m === false) return null;
  const t = rechargeText(item), ids = t?.ids.length ? t.ids : [item.id];
  if (m && typeof m === "object") { const dice = m.dice ?? t?.dice; return dice ? { dice, ids, mode: "button" } : null; }
  if (typeof m === "string") return { dice: m, ids, mode: "auto" };
  if (!t?.ids.length || !t.dice) return null;
  return { dice: t.dice, ids: t.ids, mode: t.conditional ? "button" : "auto" };
}

/** M1 как исполняет рантайм (авто после использования): null — автозамка нет; иначе {dice, ids}. */
export function rechargeEntry(item) {
  const s = rechargeSpec(item);
  return s?.mode === "auto" ? { dice: s.dice, ids: s.ids } : null;
}

/** Форма окна: {recharge:{mode:"default"|"off"|"auto"|"button", dice}, req:{off}, strike:{off}, maneuvers:{auto,list:{ключ: bool}}, permanent:{off}}. */
export const mechToForm = (m) => ({
  recharge: { mode: m.recharge === false ? "off" : typeof m.recharge === "string" ? "auto" : m.recharge ? "button" : "default", dice: (typeof m.recharge === "string" ? m.recharge : m.recharge?.dice) ?? "" },
  req: { off: m.req === false }, strike: { off: m.strike === false }, permanent: { off: m.permanent === false },
  maneuvers: { auto: !m.maneuvers, list: Object.fromEntries(MANEUVERS.map((k) => [k, !!m.maneuvers?.includes(k)])) }
});

const on = (v) => v === true || v === "true";

/** Перезарядка, добавленная кнопкой «Добавить перезарядку» (f.recharge.added) и ещё не убранная: черновик, даже пока срока нет и формула флага пуста. */
export const rechargePending = (f) => !!f?.recharge.added && ["auto", "button"].includes(f.recharge.mode);

/**
 * Убирает переопределение, равное значению по умолчанию (срок как в тексте, список манёвров как автоматический): оно ничего не меняет,
 * а в предмете висело бы пилюлей «Изменено». base — {dice, maneuvers, rc} из найденных механизмов предмета; rc — режим перезарядки по умолчанию ("auto" | "button" | "none").
 * Перезарядка срезается, только если совпали и режим, и срок.
 */
export function pruneMech(m, base = {}) {
  const o = { ...m };
  const r = o.recharge, rc = base.rc;   // rc не задан (base без перезарядки) — только срок, как раньше
  if (r === false ? rc === "none" : typeof r === "string" ? (rc ?? "auto") === "auto" && r === diceOf(base.dice) : r && rc === "button" && (r.dice ?? base.dice ?? null) === (base.dice ?? null)) delete o.recharge;
  if (o.maneuvers && base.maneuvers && MANEUVERS.every((k) => o.maneuvers.includes(k) === base.maneuvers.includes(k))) delete o.maneuvers;
  return o;
}

// режим формы -> значение флага; «авто» без срока берёт срок из текста
const rechargeOut = (r, base) => r.mode === "off" ? false : r.mode === "auto" ? (String(r.dice ?? "").trim() || base?.dice || undefined) : r.mode === "button" ? { on: "button", ...(String(r.dice ?? "").trim() && { dice: r.dice }) } : undefined;

/** Форма -> флаг (нормализованный и без значений по умолчанию; пустой объект — флага нет). */
export const formToMech = (f, base) => pruneMech(normalizeMech({
  recharge: rechargeOut(f.recharge, base),
  ...(on(f.req.off) && { req: false }), ...(on(f.strike.off) && { strike: false }), ...(on(f.permanent.off) && { permanent: false }),
  maneuvers: on(f.maneuvers.auto) ? undefined : MANEUVERS.filter((k) => on(f.maneuvers.list[k]))
}), base);

/** Ключи строк ошибок формы (workshop.mech.err.*); пусто — можно сохранять. */
export function mechErrors(f, base) {
  const err = [], rc = f.recharge, given = String(rc.dice ?? "").trim();
  if (["auto", "button"].includes(rc.mode)) {
    if (given && !diceOf(given)) err.push("workshop.mech.err.dice");
    else if (!given && !base?.dice) err.push("workshop.mech.err.diceNeeded");   // срок обязателен там, где из текста его нет
  }
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
