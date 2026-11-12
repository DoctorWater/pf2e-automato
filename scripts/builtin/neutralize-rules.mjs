// Нейтрализация переключателей pf2e, которые модуль вычисляет сам (CLAUDE.md §1.5): переключаемое RollOption с опцией из реестра
// получает ignored = true — pf2e не кладёт его в actor.synthetics.toggles (лист, Token Action HUD) и не гасит нашу опцию в beforeRoll.
// Точка — статическая game.pf2e.RuleElements.fromOwnedItem (pf2e.mjs:45299; её зовёт ItemPF2e#prepareRuleElements, 45454): через неё идут
// правила предметов всех типов. Данные мира не пишутся: без модуля или при режиме «выкл» pf2e возвращает переключатель.
// BaseSpeed, DamageDice и прочее pf2e не гасим — они работают от самой опции.
import { MOD, L } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { resetIndex, shouldYield } from "../compat.mjs";
import { slugOf } from "../rules.mjs";
import { NO_REACTIONS } from "../workshop/effect.mjs";
import { mechOf } from "../mech.mjs";

/** Подгруппа A «вид скорости на это перемещение» (8 фитов, pf2e 8.6.1): у каждого toggleable RollOption + BaseSpeed fly под ней; опция = slug фита. */
export const FLIGHT = ["take-wing", "take-flight", "soaring-flight", "fledgling-flight", "winglet-flight", "evanescent-wings", "dragons-flight", "benefactors-wings"];

/** Реестр: опция -> вид режима модуля (settings.mjs mode.<вид>), по которому она вычисляется. Полёт делает макрос turn-flight.mjs под mode.macro. */
export const REGISTRY = { "pack-attack": "computed", ...Object.fromEntries(FLIGHT.map((o) => [o, "macro"])) };

/** Чистая: гасим только переключаемый RollOption с опцией из owned; mode "off" — не трогаем. */
export const shouldNeutralize = (rule, owned, mode = "auto") =>
  mode !== "off" && rule?.key === "RollOption" && rule.toggleable === true && !!owned?.has(rule.option);

/** Опции реестра, режим которых не «выкл» и у которых готова обвязка (gates: kind -> bool; нет записи — готово). */
export const ownedOptions = (get = modeOf, ready = (k) => gates[k] !== false) => new Set(Object.entries(REGISTRY).filter(([, kind]) => get(kind) !== "off" && ready(kind)).map(([o]) => o));

const gates = { computed: false };   // computed включается, когда встали обёртки урона (computed-options.mjs)
let ownedCache = null;
const owned = () => (ownedCache ??= ownedOptions());
/** Вид режима готов исполнять работу (computed: обёртка урона встала); до этого переключатели этого вида не гасим. */
export function setReady(kind, ok) { gates[kind] = !!ok; ownedCache = null; }

let marks = new WeakMap();   // актёр -> Map(опция -> Set(предмет)); нет записи — у актёра ничего не погашено (гейт для computed-options)
export const neutralizedOf = (actor) => marks.get(actor) ?? null;
export const clearMarks = (actor) => { marks.delete(actor); };

/** Постоянное состояние способности NPC (M6): slug -> uuid состояния для GrantItem inMemoryOnly (как у Zombie Hulk в pf2e) и запрет реакций. */
export const PERMANENT = { slow: { grant: "Compendium.pf2e.conditionitems.Item.xYTAsEpcJE1Ccni3", cond: "slowed", noReactions: true } };   // cond — slug состояния для строки Мастерской

/** Чистая: предмет (документ или _source) — способность NPC из таблицы PERMANENT -> запись таблицы | null. Актёр — явный (у _source предмета его нет). */
export const permanentBase = (item, actorType) => (actorType === "npc" && (item?.type === "action" || item?.type === "feat") ? PERMANENT[slugOf(null, item)] ?? null : null);

/** Как исполняет рантайм: mech.permanent:false (Мастерская: «не накладывать») — null. Читает и _source (флаги там же). */
export const permanentOf = (item, actorType) => (mechOf(item).permanent === false ? null : permanentBase(item, actorType));

/** Чистая: у актёра уже есть документ этого состояния (часть бестиариев кладёт Slowed прямо в существо: Ofalth Zombie, Zombie Owlbear). */
export const hasCondDoc = (actor, cond) => !!cond && (actor?._source?.items ?? []).some((i) => i.type === "condition" && i.system?.slug === cond);

/** Чистая: среди правил предмета уже есть GrantItem именно этого состояния (другой GrantItem выдаче не мешает). */
export const grantsCond = (rules, p) => (rules ?? []).some((r) => r?.key === "GrantItem" && r.uuid === p.grant);

/** Чистая: исходники синтетических правил. Состояние — только там, где его не выдаёт сам предмет (GrantItem у 9 Slow) и нет документа состояния у существа; запрет реакций — всем. */
export function permanentSources(p, ownRules = [], hasDoc = false) {
  return [
    ...(p.noReactions ? [{ key: "RollOption", domain: "all", option: NO_REACTIONS }] : []),
    ...(p.grant && !hasDoc && !grantsCond(ownRules, p) ? [{ key: "GrantItem", uuid: p.grant, inMemoryOnly: true }] : [])
  ];
}

/** Дописывает к правилам предмета синтетические (в памяти, в документы не пишутся: off -> resetActors вернёт чистые правила). */
function addPermanent(rules, opts) {
  const item = opts?.parent, p = permanentOf(item, item?.actor?.type);
  if (!p || modeOf("effect") === "off") return;
  const all = globalThis.game?.pf2e?.RuleElements?.all;
  for (const src of permanentSources(p, item.system?.rules, hasCondDoc(item.actor, p.cond))) {
    try { if (all?.[src.key]) rules.push(new all[src.key](src, { ...opts, sourceIndex: null })); }
    catch (e) { console.warn(`${MOD} | permanent ${item.name}`, e); }
  }
}

export function wrapRules(wrapped, ...args) {
  const rules = wrapped(...args);
  try {
    addPermanent(rules, args[0]);
    const own = owned();
    if (!own.size) return rules;
    for (const r of rules) {
      if (!shouldNeutralize(r, own)) continue;   // дёшево; уступку считаем только у совпавших
      const item = r.item, actor = item?.actor;
      if (!actor || shouldYield(null, { slug: item.slug, sourceUuid: item._stats?.compendiumSource })) continue;
      r.ignored = true;
      const byOption = marks.get(actor) ?? marks.set(actor, new Map()).get(actor);
      (byOption.get(r.option) ?? byOption.set(r.option, new Set()).get(r.option)).add(item);
    }
  } catch (e) { console.warn(`${MOD} | neutralize-rules`, e); }
  return rules;
}

/** Обёртка метода: libWrapper (WRAPPER; this сохраняется), без него — прямая подмена. fn.call(this, wrapped, ...args). false — не встала. */
export function wrapMethod(path, obj, key, fn, what) {
  if (!obj?.[key]) return false;
  if (globalThis.game?.modules?.get("lib-wrapper")?.active && globalThis.libWrapper) {
    try { libWrapper.register(MOD, path, function (wrapped, ...a) { return fn.call(this, wrapped, ...a); }, "WRAPPER"); return true; }
    catch (e) {
      console.error(`${MOD} | ${what}: libWrapper.register`, e);
      if (game.user?.isGM) ui.notifications.warn(L("builtin.wrapFailed", { what, error: e?.message ?? e }));
      return false;
    }
  }
  const orig = obj[key];
  obj[key] = function (...a) { return fn.call(this, orig.bind(this), ...a); };
  return true;
}

let installed = false;
export const isInstalled = () => installed;
/** Идемпотентно; вызывать в init (до подготовки актёров) и повторно в ready. true — встала. */
export function install() {
  if (installed) return true;
  const RE = globalThis.game?.pf2e?.RuleElements;
  installed = !!RE && wrapMethod("game.pf2e.RuleElements.fromOwnedItem", RE, "fromOwnedItem", wrapRules, L("builtin.neutralizeName"));
  return installed;
}

const hasRegistered = (a) => (a?._source?.items ?? []).some((i) => permanentOf(i, a.type) || (i.system?.rules ?? []).some((r) => r?.key === "RollOption" && r.option in REGISTRY));

/** Пересобрать актёров с регистровыми переключателями (смена режима или уступки): правила построятся заново и пройдут через обёртку. */
export function resetActors() {
  marks = new WeakMap(); ownedCache = null;
  const toks = (game.scenes?.contents ?? []).flatMap((sc) => [...sc.tokens].filter((t) => !t.actorLink).map((t) => t.actor));
  for (const a of [...(game.actors ?? []), ...toks]) if (hasRegistered(a)) try { a.reset(); } catch (e) { console.warn(`${MOD} | neutralize-rules reset`, e); }
}

export function init() {
  install();
  Hooks.once("ready", () => { if (!installed && install()) resetActors(); });
  const keys = new Set([...new Set(Object.values(REGISTRY))].map((k) => `${MOD}.mode.${k}`).concat(`${MOD}.mode.effect`, `${MOD}.yieldToAutomations`, "pf2e-automations.rulesV3"));
  Hooks.on("updateSetting", (s) => { if (!keys.has(s.key)) return; resetIndex(); resetActors(); });   // индекс уступки — до пересборки (хук compat идёт раньше, но не полагаемся)
}
