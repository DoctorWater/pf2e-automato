// M3: Удар NPC запускает пассивную способность из его attackEffects (яд, болезнь, проклятие у Удара: «Укус... плюс Яд призрачной гнили»).
// Вывод запроса onEvent из onUse способности — во время чтения, каталог не переписывается. Только для проверенных правил (source catalog|world|flag):
// вывод из разметки сам не исполняется, а событие урона не должно запускать его шаги мимо ведущего.
import * as rules from "./rules.mjs";
import * as compat from "./compat.mjs";
import { modeOf } from "./settings.mjs";
import { sluggify } from "./util.mjs";
import { effectInfo } from "./builtin/strike-effects.mjs";
import { mechOf } from "./mech.mjs";

/** Slug предмета-носителя: так же схлопываются action и feat одного slug в eventItems. */
export const carrierSlug = (item) => rules.slugOf(null, item) || sluggify(item?.name ?? "") || null;

const TRUSTED = new Set(["catalog", "world", "flag"]);
const memo = new WeakMap();   // правило каталога -> Map(slug -> выведенное правило): копия делается один раз, каталог остаётся нетронутым

export const meleeOf = (actor) => actor?.itemTypes?.melee ?? [...(actor?.items ?? [])].filter((i) => i.type === "melee");
const carries = (strike, slug) => (strike?.system?.attackEffects?.value ?? []).includes(slug);

/** У другого предмета актёра уже есть запись onEvent про этот attackEffect (resOf(предмет) -> результат resolveRule): дубль не выводим. */
export const claimedBy = (item, slug, resOf) => [...(item.actor?.items ?? [])].some((i) => i !== item && JSON.stringify(resOf(i)?.rule?.onEvent?.map((e) => e.when) ?? []).includes(`"item:attack-effect:${slug}"`));

/**
 * Чистая: выведенное правило { v, label, yield, onEvent:[запись] } для пассивной способности, на которую ссылается attackEffects Удара того же актёра, иначе null.
 * res — результат resolveRule (rule, source). Пары нет, у способности уже есть onEvent (Rust Creep, Tongue Grab), нет испытания и шагов, есть частота
 * или это действие (расход частоты и запуск — решение ведущего через карточку) — null. Крит = попадание: запись одна на сообщение урона.
 * mech.strike:false (Мастерская: «не запускать Ударом») — null, ручная карточка возвращается.
 */
export const strikeLinkEntry = (res, item, strikes, claimed = () => false) => (mechOf(item).strike === false ? null : strikeLinkBase(res, item, strikes, claimed));

/** То же без переопределения предмета; trusted — какие источники правила годятся (Мастерская проверяет «нужно принять правило»). */
export function strikeLinkBase(res, item, strikes, claimed = () => false, trusted = TRUSTED) {
  const rule = res?.rule, u = rule?.onUse;
  if (!u || rule.onEvent?.length || !trusted.has(res.source) || u.check || !(u.challenge || u.apply?.length)) return null;
  if (!["action", "feat"].includes(item?.type) || item.system?.actionType?.value !== "passive" || item.system?.frequency) return null;
  const slug = carrierSlug(item);
  if (!slug || !strikes.some((s) => carries(s, slug)) || effectInfo(slug, () => item.system?.description?.value) || claimed(slug)) return null;   // Хватка/Нокдаун/Толчок Удара ведёт strike-effects: два пути — двойной эффект
  const byRule = memo.get(rule) ?? memo.set(rule, new Map()).get(rule), crit = rules.critOnlyEntry(item), key = crit ? `${slug}!` : slug;
  if (!byRule.has(key)) {
    const derived = {
      v: rule.v ?? 1, label: rule.label, yield: rule.yield ?? null,
      onEvent: [{ on: "damage-roll", side: "self", when: ["target", `item:attack-effect:${slug}`, ...(crit ? ["outcome:criticalSuccess"] : [])], ...(u.challenge && { challenge: structuredClone(u.challenge) }), ...(u.apply?.length && { apply: structuredClone(u.apply) }) }]
    };
    byRule.set(key, rules.validateRule(derived).ok ? derived : null);   // шаги onUse, которых нет у onEvent (coat, move), — запись не выводится, способность остаётся ручной
  }
  return byRule.get(key);
}

/** У записи есть исход: шаг применения или шаг хотя бы в одной степени испытания. Вывод из разметки для недугов со стадиями исхода не собирает (byDegree пуст): спасбросок бросится, а эффекта не будет. */
export const hasOutcome = (entry) => !!entry?.apply?.length || Object.values(entry?.challenge?.byDegree ?? {}).some((a) => a?.length);

/** Чистая по режимам: шаги записи исполнятся — испытание требует mode.challenge, применение (apply) — mode.effect = auto. */
export const modesRun = (entry, mode = modeOf) => (!entry?.challenge || mode("challenge") !== "off") && (!entry?.apply?.length || mode("effect") === "auto");

/**
 * Связь способности с Ударом для Мастерской -> { rule, strikes:[Удар], off } | null (связи нет). off: null — работает; "flag" — mech.strike:false;
 * "needRule" — Удар ссылается на способность, но правило только из разметки (вывод — для проверенных: «Принять распознанное»; noOutcome — в выводе нет исхода, принимать нечего); "mode" — режимы
 * выключили шаги записи; "yield" — уступка pf2e-automations. Порядок причин — как в Мастерской: предмет, правило, режим, уступка.
 */
export function strikeLinkState(item, resolve = rules.resolveRule) {
  const actor = item?.actor;
  if (!actor) return null;
  let res = null;
  const resolvedOf = (i) => { try { return resolve(i); } catch { return null; } };
  try { res = resolve(item); } catch { return null; }
  const strikes = meleeOf(actor), claimed = (slug) => claimedBy(item, slug, resolvedOf);
  let rule = strikeLinkBase(res, item, strikes, claimed), needRule = false;
  if (!rule && res?.source === "markup") { rule = strikeLinkBase(res, item, strikes, claimed, new Set(["markup"])); needRule = !!rule; }
  if (!rule) return null;
  const noOutcome = needRule && !hasOutcome(rule.onEvent[0]);   // правило из разметки без исхода принять нельзя: нужно правило (каталог/модель/руками), не «принять»
  const slug = carrierSlug(item);
  const bothOff = modeOf("effect") === "off" && modeOf("challenge") === "off";
  const rest = needRule ? "needRule" : bothOff || !modesRun(rule.onEvent[0]) ? "mode"   // шаги записи не исполняются (режим выключен)
    : compat.shouldYield(rule, { slug: rules.slugOf(null, item), sourceUuid: rules.sourceOf(null, item) }) ? "yield" : null;
  // needRule и ids — для строки Мастерской: режим, уступку и флаг она считает заново на каждый рендер (по настройкам и черновику), а не из off
  return { rule, strikes: strikes.filter((s) => carries(s, slug)), off: mechOf(item).strike === false ? "flag" : rest, needRule, noOutcome, ids: { slug: rules.slugOf(null, item), sourceUuid: rules.sourceOf(null, item) } };
}

/** Запрос Удару: способность выполняется самим модулем по урону Удара (режимы, уступка pf2e-automations учтены) -> { rule, strikes:[Удар] } | null. Для подсказки на карточке способности; контракт — истина/ложь. */
export function strikeLinked(item) {
  if (!item?.actor || (modeOf("effect") === "off" && modeOf("challenge") === "off")) return null;
  const s = strikeLinkState(item);
  return s && !s.off ? { rule: s.rule, strikes: s.strikes } : null;
}
