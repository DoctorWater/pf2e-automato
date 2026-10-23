// 0.5g3: перенос правил PA с событием (бросок, урон, ход, создание/снятие эффекта) в записи onEvent на предмете-владельце группы.
// Чистые функции без чтения файлов: tools/pa-port.mjs передаёт в них свои помощники (stepsOf, rankOf, optStrings, OWN) — так нет цикла импорта.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isPredicate } from "../scripts/predicate.mjs";
import { ROOT, PACKS } from "./lib.mjs";

/** triggerType PA -> событие onEvent. Броски (attack-roll / skill-check / perception-check) — запись, только если правило не про собственный бросок предмета. */
export const EV_ON = { "attack-roll": "attack-roll", "skill-check": "skill-check", "perception-check": "skill-check", "damage-roll": "damage-roll", "damage-taken": "damage-taken", "end-turn": "turn-end", "start-turn": "turn-start", "create-item": "effect-created", "delete-item": "effect-deleted" };
/** События, которые правило PA выражает всегда (раньше были долгом `on-damage-roll` / `trigger:*`). */
export const EV_ALWAYS = new Set(["damage-roll", "damage-taken", "end-turn", "start-turn", "create-item", "delete-item"]);
export const EV_ROLLS = new Set(["attack-roll", "skill-check", "perception-check"]);

// Опции, которые events.mjs кладёт в набор (как pf2e-automations): опции броска и источника pf2e, исход, области, цель и опции бросавшего.
// Голые слова — настоящие опции pf2e (панаш, трейты через item:trait:* у них нет голой формы). Остальное — синтетика PA, она остаётся долгом.
const EV_PREFIX = /^(?:feat|feature|spell|spellcasting|self|target|origin|item|action|class|ancestry|heritage|outcome|domain|damage-taken|sub-item)(?::|$)/;   // sub-item:<slug> — вложенный предмет оружия (events.mjs messageOptions)
const EV_BARE = new Set(["panache", "finisher", "finisher:confident", "agile", "finesse", "stunning-blows", "critical-specialization", "hunted-prey", "first-attack"]);
const EV_EFFECT = /^effect(?::|$)/;   // опции эффекта: только у create-item / delete-item
// опции PA, которые у владельца записи выполнены сами собой (аура Чемпиона есть у любого, кто держит черту «Аура отваги»): условия не добавляют
const EV_IMPLIED = new Set(["champions-aura"]);
const EV_SYN = { "shield:block": "damage-taken:shield" };   // PA ищет «shield … absorb» в тексте карточки; у нас — щит поглотил урон (appliedDamage.shield)

// вариант черты по классу (tumble-behind-rogue / -swashbuckler) — та же группа, что и tumble-behind-<другой класс>
const CLASS_SUFFIX = /-(?:alchemist|barbarian|bard|champion|cleric|druid|fighter|gunslinger|inventor|investigator|magus|monk|oracle|psychic|ranger|rogue|sorcerer|summoner|swashbuckler|thaumaturge|witch|wizard)$/;

/** Строки предиката со всеми синонимами PA заменены на наши опции. */
// `action:strike` есть только у Ударов персонажа; у Удара NPC pf2e даёт `self:action:slug:strike` (pf2e.mjs:20351) — условие на оба
const synonyms = (p) => (p === "action:strike" ? { or: ["action:strike", "self:action:slug:strike"] } : typeof p === "string" ? EV_SYN[p] ?? p : Array.isArray(p) ? p.map(synonyms) : p && typeof p === "object" ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, synonyms(v)])) : p);

/**
 * Условие записи onEvent из предиката PA (без сравнений круга — их уже вынес rankOf). Тождества самого предмета (feat:<slug>, sourceId) не нужны:
 * правило и так лежит на предмете. Остальное должно состоять из опций, которые есть у нас. -> { when: предикат | null } | { fail: "event-predicate:<опция>" }.
 */
export function eventWhen(rest, item, on, { optStrings, OWN }) {
  // тождество самого предмета: его slug, его sourceId и варианты (у «Кувырка сзади» feat:tumble-behind-rogue / -swashbuckler — те же способности у копий NPC без этих фитов)
  const base = (x) => x?.replace(CLASS_SUFFIX, ""), own = (t) => { const o = OWN.exec(t)?.[2]; return o === item.slug || o?.startsWith(`${item.slug}-`) || (o && base(o) === base(item.slug)) ||t === `origin:item:sourceId:${item.source ?? item.uuid}`; };
  const terms = synonyms(rest.filter((x) => !(optStrings(x).length && optStrings(x).every((t) => own(t) || EV_IMPLIED.has(t)))));
  const effectEvent = on === "effect-created" || on === "effect-deleted";
  const bad = optStrings(terms).find((s) => !(/^-?d+(?:.d+)?$/.test(s) || EV_PREFIX.test(s) || EV_BARE.has(s) || (effectEvent && EV_EFFECT.test(s))));
  if (bad) return { fail: `event-predicate:${bad}` };
  if (terms.length && !isPredicate(terms)) return { fail: "event-predicate:structure" };
  return { when: terms.length ? terms : null };
}

/** Получатель шага PA в записи onEvent: Self* — владелец, Target* — другой участник события, Party — партия; счётчики и опции — владелец. SelfOr* (PA: цель либо сам) — не переносим. */
export const eventWho = (t) => (/^SelfOr/.test(t) ? null : /^Self|^TurnO|^(?:Increase|Decrease)BadgeEffect$|^ImmunitySelfEffect$|^OriginEffect$/.test(t) ? "self" : /^Party/.test(t) ? "party" : "target");

const OWN_PACK = (id) => `Compendium.pf2e-automato.effects.Item.${id}`;
const FEAT_FX = (id) => `Compendium.pf2e.feat-effects.Item.${id}`;
const slugsExtend = (slugs, rounds = 1) => slugs.map((slug) => ({ to: "self", extendEffect: { slug, rounds } }));

/**
 * handler-правила PA, которые выражаются данными (steps — шаги записи, side — владелец, once — один раз на эффект, challenge — испытание другого участника).
 * challenge.option: токен предиката saving-throw-правил той же группы (PA вызывает actorRollSaveThrow с extraRollOptions) — их шаги по степеням становятся byDegree.
 * Остальные handler-ы (диалоги, расчёт урона, свои флаги) требуют кода — см. отчёт 0.5g3, остаются долгом `handler:<имя>`.
 */
export const EVENT_HANDLERS = {
  // «Кувырок сзади»: после первого Удара (или провала) растворяется эффект «врасплох»; сам эффект ставит правило skill-check группы
  deleteTumbleBehindOffGuard: { steps: [{ to: "self", removeEffect: { uuid: OWN_PACK("Vh5E1Qgp34sTKfVs") } }] },
  deletePanache: { steps: [{ to: "self", removeEffect: { uuid: FEAT_FX("uBJsxCzNhje8m8jj") } }] },
  deleteSelfishShield: { steps: [{ to: "self", removeEffect: { uuid: FEAT_FX("h6nyMp4dtPXBfCJc") } }] },
  // «Боевое выступление»: Удар с уроном продлевает композицию на 1 раунд, но каждое сотворение — один раз (once: ключ шага один на эффект)
  martialPerformance: { once: true, steps: slugsExtend(["aura-inspire-courage", "aura-inspire-defense", "aura-song-of-strength"]) },
  // «Оглушающие удары»: цель бросает Стойкость против СЛ класса владельца; степени — из saving-throw правил группы с origin:item:stunning-blows
  stunningBlows: { challenge: { statistic: "fortitude", dc: { against: "class" }, traits: ["incapacitation"], option: "origin:item:stunning-blows" } },
  // «Погибель» (Bane): эффект ауры появился у врага — носитель бросает Волю против СЛ заклинателя (запись у заклинателя, side:"origin"); успех снимает эффект и даёт иммунитет, пока длится аура
  rollSavingThrowVsBane: { side: "origin", challenge: { statistic: "will", dc: { source: "spell" }, immunity: { slug: "bane", duration: { value: 1, unit: "minutes" }, degrees: ["success", "criticalSuccess"] }, byDegree: Object.fromEntries(["success", "criticalSuccess"].map((d) => [d, [{ to: "target", removeEffect: { slug: "spell-effect-bane" } }]])) } },
  applyBaneImmunity: { absorbed: true },   // иммунитет и снятие эффекта — степени испытания rollSavingThrowVsBane
  // «Оружие небожителя» (Celestial Armaments): крит. попадание оружием при эффекте — Стойкость цели против СЛ класса/заклинаний (большей), провал — Blinded на 1d4 раунда; степени — из saving-throw правила группы
  celestialArmaments: { when: ["item:chosen:celestial-armaments:weapon"], challenge: { statistic: "fortitude", dc: { against: "class-spell" }, option: "celestial-armaments-st" } },
  // «Защитная статуэтка» (Warding Statuette): попадание оружием с ней — выбранное существо рядом (5 фт: «adjacent»), в том числе сам владелец, получает +1 к КБ; владелец — вложенный предмет оружия (sub-item), его опция есть у броска
  wardingStatuetteAttack: { steps: [
    { to: "self", choose: { from: "allies", range: 5, of: "target", withSelf: true } },
    { to: "chosen", effect: { uuid: "Compendium.pf2e.equipment-effects.Item.gwiyabYi92R97bXZ" } }] },
  // «Охотник на чудовищ»: крит. успех Вспоминания (у мастера — и успех) метит жертву владельцу и союзнику по его выбору (choose); Monster Warden добавляет защиту
  monsterHunter: { steps: [
    { to: "self", effect: { uuid: FEAT_FX("W2tWq0gdAcnoz2MO") } },
    { to: "self", effect: { uuid: FEAT_FX("nlaxROgSSLVHZ1hx") }, when: ["feat:monster-warden"] },
    { to: "self", choose: { from: "allies" } },
    { to: "chosen", effect: { uuid: FEAT_FX("W2tWq0gdAcnoz2MO") } },
    { to: "chosen", effect: { uuid: FEAT_FX("nlaxROgSSLVHZ1hx") }, when: ["feat:monster-warden"] }] },
  // «Аура отваги»: в конце хода каждый союзник в ауре Чемпиона (15 фт) снижает Испуг на 1 (шаг condition с policy:"reduce")
  auraOfCourage: { steps: [{ to: "allies", range: 15, condition: { slug: "frightened", policy: "reduce" } }] }
};

/* ---------- метка TokenMark ---------- */
const packCache = {};
/** Есть ли в эффекте правило TokenMark (pf2e — по json-паку 8.4.1, свой — по packs/_source/effects). Нет источника — false. */
export function hasTokenMark(uuid) {
  const own = /^Compendium\.pf2e-automato\.effects\.Item\.(\w+)$/.exec(uuid ?? "");
  if (own) {
    const f = readdirSync(join(ROOT, "packs/_source/effects")).find((x) => x.endsWith(`_${own[1]}.json`));
    return !!f && (JSON.parse(readFileSync(join(ROOT, "packs/_source/effects", f), "utf8")).system?.rules ?? []).some((r) => r.key === "TokenMark");
  }
  const m = /^Compendium\.pf2e\.([\w-]+)\.Item\.(\w+)$/.exec(uuid ?? "");
  const file = m && join(PACKS, `${m[1]}.json`);
  if (!file || !existsSync(file)) return false;
  const arr = (packCache[m[1]] ??= JSON.parse(readFileSync(file, "utf8")));
  const doc = (Array.isArray(arr) ? arr : arr.entries ?? arr.items ?? Object.values(arr)).find((d) => d._id === m[2]);
  return !!doc && (doc.system?.rules ?? []).some((r) => r.key === "TokenMark");
}

/** Шаги onEvent: эффект с TokenMark всегда получает `mark:"enemy"` (метка на цель события из use.targets двойника, apply.mjs). Шаги onUse не трогаем: у них метка зависит от текста (Ghostbane Fulu — «вызвавший» существо, а не выбранная цель); у правил вердиктов g4 она проставлена вручную, проверяет тест. */
export function withMarks(rule, has = hasTokenMark) {
  if (!rule?.onEvent?.length) return rule;
  const fix = (l) => l?.map((s) => (s.effect && !s.mark && has(s.effect.uuid) ? { ...s, mark: "enemy" } : s));
  return { ...rule, onEvent: rule.onEvent.map((e) => ({ ...e, ...(e.apply && { apply: fix(e.apply) }), ...(e.challenge && { challenge: { ...e.challenge, byDegree: Object.fromEntries(Object.entries(e.challenge.byDegree).map(([d, l]) => [d, fix(l)])) } }) })) };
}
