// cast: активация снаряжения «вы сотворяете X» (plan-cast-activation.md). Эфемерное заклинание с ленивой записью заклинателя, ранг, мягкая частота, сброс отдыхом.
// Исполняет клиент, нажавший кнопку (владелец актёра или ведущий): запись заклинателя и карточка строятся одинаково на любом клиенте, ведущий применяет результат из сообщения.
import { MOD, L, flagPath, forcedDelete } from "./util.mjs";
import * as rules from "./rules.mjs";

/* ---------- чистая часть (юнит-тесты) ---------- */

export const ID = /^af-cast-([A-Za-z0-9]{16})-(.+)$/;
export const entryId = (item, id) => `af-cast-${item.id}-${id}`;

// СЛ по уровню (calculateDC pf2e, уровни 0..25) — запасная СЛ предмета, когда у владельца нет записи заклинателя и правило СЛ не задаёт
const DC_BY_LEVEL = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
export const levelDc = (level) => DC_BY_LEVEL[Math.min(Math.max(Math.trunc(level) || 0, 0), 25)];
// NPC «high»: таблица «Spell DC and Spell Attack Bonus» (GM Core стр. 122 / Monster Core; Archives of Nethys), колонка High, уровни -1..24; атака = СЛ - 8
const HIGH_DC = [16, 16, 17, 18, 20, 21, 22, 24, 25, 26, 28, 29, 30, 32, 33, 34, 36, 37, 38, 40, 41, 42, 44, 45, 46, 48];
export const highDc = (level) => HIGH_DC[Math.min(Math.max(Math.trunc(level) || 0, -1), 24) + 1];
export const highAttack = (level) => highDc(level) - 8;

/** Ведём ли собственный счётчик частоты: нет у способности со своей частотой pf2e (только показываем) и у «в день» для NPC (restForTheNight только у character). */
export const tracksUses = (item, per) => !!per && !item?.system?.frequency && (item?.actor?.type === "character" || per.unit !== "days");

/**
 * Источник заклинания с рангом и записью заклинателя (как createConsumableFromSpell, pf2e:39893): явный ранг — heightenedLevel не ниже базового;
 * кантрип — autoHeightenLevel (явный ранг или половина уровня предмета, вверх). `castRank` в toMessage не передаём: toMessage <-> loadVariant уходят в рекурсию.
 */
export function rankSource(src, itemLevel, rank, locationId) {
  const out = structuredClone(src), loc = out.system.location = { ...out.system.location, value: locationId };
  if ((out.system.traits?.value ?? []).includes("cantrip")) loc.autoHeightenLevel = rank ?? Math.ceil((Number(itemLevel) || 1) / 2);
  else if (rank != null) loc.heightenedLevel = Math.max(rank, out.system.level?.value ?? 1);
  return out;
}

// Окно частоты: uses раз за value единиц. Хранится {at:{time,combat,round}, log:[id сообщений]}; days закрывает только отдых (pf2e.restForTheNight)
const UNIT_SEC = { minutes: 60, hours: 3600 };
const windowOpen = (e, per, now) => !!e?.at && (per.unit === "rounds" ? !!e.at.combat && e.at.combat === now.combat && now.round - e.at.round < per.value
  : per.unit === "days" || now.time - e.at.time < per.value * UNIT_SEC[per.unit]);
/** Сколько использований осталось (null — частоты нет). now = {time, combat, round}. */
export const usesLeft = (e, per, now) => (per ? (windowOpen(e, per, now) ? Math.max(0, (per.uses ?? 1) - e.log.length) : per.uses ?? 1) : null);
/** Запись счётчика после использования: окно закрылось — начинается новое. */
export const withUse = (e, per, now, id) => (windowOpen(e, per, now) ? { at: e.at, log: [...e.log, id] } : { at: now, log: [id] });
/** Запись после удаления карточки: без её использования; пусто -> null (флаг снимается). Неизвестная карточка — запись как была. */
export function withoutUse(e, id) {
  if (!e?.log?.includes(id)) return e;
  const log = e.log.filter((x) => x !== id);
  return log.length ? { ...e, log } : null;
}

/**
 * Что требуется от предмета, чтобы активация была доступна: имя условия, которое НЕ выполнено, иначе null.
 * Нет requires — по предмету: настраиваемый (investable) -> invested, иначе equipped; не физический предмет (способность NPC) — всегда выполнено.
 */
export function requirementOf(item, requires) {
  if (!item || requires === "none" || item.isEquipped === undefined) return null;
  const need = requires ?? (item.isInvested != null ? "invested" : "equipped");
  const ok = need === "invested" ? item.isInvested === true : need === "held" ? !!item.isHeld : !!item.isEquipped;
  return ok ? null : need;
}

/** «1/день», «2/час», «1/10 мин» — частота подписью кнопки. */
export const perText = (per, t) => t("cast.per", { uses: per.uses ?? 1, window: per.value > 1 ? `${per.value} ` : "", unit: t(`workshop.unitShort.${per.unit}`) });

/* ---------- запись заклинателя ---------- */

// лучшая запись владельца по СЛ (как у свитка, pf2e:51094; записи trick-* и наши в коллекцию не попадают)
const bestEntry = (actor) => actor.spellcasting?.filter((e) => !!e.statistic).reduce((a, e) => (!a || e.statistic.dc.value > a.statistic.dc.value ? e : a), null) ?? null;

/**
 * Порядок СЛ активации: текст правила -> СЛ по уровню предмета (запись владельца СЛ предмета не заменяет: у мага низкого уровня она была бы ниже, у воина записи нет).
 * Исключение — кантрип спеллхарта: своя запись владельца, если её СЛ выше (правило спеллхартов). -> {kind: "high" | "owner" | "level" | "text", dc?}
 */
export function pickDc(c, { itemLevel, heartCantrip = false, bestDc = null }) {
  if (c.dc?.level) return { kind: "high" };
  const dc = c.dc ?? levelDc(itemLevel);
  return heartCantrip && bestDc != null && bestDc > dc ? { kind: "owner" } : { kind: c.dc == null ? "level" : "text", dc };
}

// кантрип ли заклинание: по индексу пака (поле traits запрашивает ready()); индекса нет — не кантрип (СЛ предмета, не завышаем)
const isCantrip = (uuid) => { try { return !!fromUuidSync(uuid)?.system?.traits?.value?.includes("cantrip"); } catch { return false; } };

function buildEntry(actor, id, c, item) {
  const best = bestEntry(actor), high = !!c.dc?.level;
  const pick = pickDc(c, { itemLevel: item?.level, heartCantrip: !!item?.system?.traits?.value?.includes("spellheart") && isCantrip(c.spell), bestDc: best?.statistic.dc.value });
  const byLevel = pick.kind === "level", dc = high ? highDc(actor.level) : pick.dc ?? null;
  const common = { id, byLevel, name: L("cast.entry"), actor, category: "items", sort: 0, spells: null, isEphemeral: true, isFlexible: false, isFocusPool: false, canCast: () => true };
  if (pick.kind === "owner") return { ...common, original: best, statistic: best.statistic, tradition: best.tradition, attribute: best.attribute, get counteraction() { return best.counteraction; } };
  // базовый Statistic: PerceptionStatistic (конструктор perception) подмешивает Мудрость. Ранга и атрибута нет — СЛ ровно СЛ предмета; атака — СЛ-10, как у NPC pf2e
  const Statistic = Object.getPrototypeOf(actor.perception.constructor), { Modifier } = game.pf2e;
  const mod = (value) => new Modifier({ slug: "af-cast", label: common.name, modifier: value, type: "untyped" });
  const statistic = new Statistic(actor, {
    slug: "af-cast", label: common.name, domains: ["spell-attack-dc"],
    check: { type: "attack-roll", modifiers: [mod(c.attack ?? (high ? dc - 8 : dc - 10))], domains: ["spell-attack", "spell-attack-roll", "attack", "attack-roll"] },
    dc: { modifiers: [mod(dc - 10)], domains: ["spell-dc"] }
  });
  // createCounteractStatistic у pf2e внутренняя (берёт атрибут и ранг записи): собираем равную по модификатору без них
  const counteraction = new Statistic(actor, { slug: "counteract", label: "PF2E.Item.Spell.Counteract.Label", check: { type: "check", modifiers: [mod(c.counteract ?? c.attack ?? (high ? dc - 8 : dc - 10))] } });
  return { ...common, statistic, counteraction, tradition: null, attribute: null };
}

// Запись живёт, пока жив подготовленный актёр: Statistic держит синтетики на момент создания (actor.synthetics пересоздаётся при prepareData)
const cache = new WeakMap();
function entryFor(actor, item, c) {
  const id = entryId(item, c.id);
  let rec = cache.get(actor);
  if (rec?.sig !== actor.synthetics) cache.set(actor, rec = { sig: actor.synthetics, map: new Map() });
  if (!rec.map.has(id)) rec.map.set(id, buildEntry(actor, id, c, item));
  return rec.map.get(id);
}

/** Предмет актёра по id: и вложенный (спеллхарт, прикреплённый к оружию/доспеху, лежит в subitems родителя — как ищет сам pf2e, pf2e:44166). */
export const itemOf = (actor, id) => actor?.items.get(id) ?? actor?.inventory?.flatMap((i) => i.subitems?.contents ?? []).find((i) => i.id === id) ?? null;

let installed = false;
/**
 * ActorSpellcasting#get: id вида af-cast-<предмет>-<активация> -> запись по правилу предмета (так же pf2e делает записи trick-*, pf2e:33936).
 * Простая регистрация на время сотворения не годится: ChatMessagePF2e#item пересобирает заклинание на любом клиенте и в любой момент, а initialize()
 * стирает записи при каждом prepareData. Запись в contents/collections не кладётся: её не увидят getStatistic("spell-dc") и выбор записи для свитков.
 */
function install() {
  if (installed) return;
  const proto = new CONFIG.Actor.documentClass({ name: "af-cast", type: "npc" }).spellcasting.constructor.prototype, orig = proto.get;
  proto.get = function (id) {
    const m = typeof id === "string" ? ID.exec(id) : null;
    if (!m) return orig.call(this, id);
    const rec = cache.get(this.actor);
    if (rec?.sig === this.actor?.synthetics && rec.map.get(id)) return rec.map.get(id);   // запись уже есть — правило не разбираем заново
    const item = itemOf(this.actor, m[1]), c = item && rules.activateOf(rules.resolveRule(item)?.rule)?.find((x) => x.id === m[2]);
    return (c && entryFor(this.actor, item, c)) || orig.call(this, id);
  };
  installed = true;
}

/* ---------- окружение ---------- */

const clock = () => ({ time: game.time.worldTime, combat: game.combat?.id ?? null, round: game.combat?.round ?? 0 });
const usesOf = (item, id) => item?.flags?.[MOD]?.uses?.[id];

// заклинания точно нет: пака с таким id нет в мире либо его индекс загружен и не содержит документа (индекс не загружен — неизвестно, проверит castItem)
function missingSpell(uuid) {
  const { collection, documentId } = foundry.utils.parseUuid(uuid) ?? {};
  return uuid.startsWith("Compendium.") && (!collection || (collection.indexed && !collection.index.has(documentId)));
}

/** Состояние одной активации: {why: noSpell | не выполненное требование | null, left, dc (число|null), byLevel}. */
export function castInfo(item, c) {
  const actor = item?.actor;
  return {
    why: (missingSpell(c.spell) ? "noSpell" : null) ?? requirementOf(item, c.requires),
    left: tracksUses(item, c.per) ? usesLeft(usesOf(item, c.id), c.per, clock()) : null,
    dc: (actor && entryFor(actor, item, c)?.statistic.dc.value) ?? null,
    byLevel: !!(actor && entryFor(actor, item, c)?.byLevel)
  };
}

/** Нажатие кнопки: эфемерное заклинание -> карточка с флагом cast -> счётчик частоты (после сотворения). {ok, reason?} */
export async function castItem(item, id) {
  const actor = item?.actor, c = item && rules.activateOf(rules.resolveRule(item)?.rule)?.find((x) => x.id === id);
  // вывод из разметки (low) исполняет только ведущий: честность вывода не проверена
  if (!actor?.isOwner || !c || (rules.resolveRule(item).confidence === "low" && !game.user.isGM)) return { ok: false, reason: "forbidden" };
  const warn = (key) => { ui.notifications.warn(L(key)); return { ok: false, reason: key }; };
  const info = castInfo(item, c), spell = await fromUuid(c.spell);
  if (info.why) return warn(`cast.why.${info.why}`);
  if (spell?.type !== "spell") return warn("cast.why.noSpell");
  if (info.dc == null) return warn("cast.noCaster");
  if (info.left === 0 && !await foundry.applications.api.DialogV2.confirm({ window: { title: L("cast.againTitle") }, classes: ["paf-dialog"], content: `<p>${foundry.utils.escapeHTML(L("cast.again", { name: spell.name }))}</p>`, rejectClose: false })) return { ok: true, skipped: true };

  const src = rankSource(spell.toObject(), item.level, c.rank, entryId(item, id));
  const eph = new CONFIG.PF2E.Item.documentClasses.spell(src, { parent: actor, parentItem: item });   // как ConsumablePF2e#embeddedSpell (pf2e:50994)
  const msg = await eph.toMessage(null, { actualCast: true, create: false });
  if (!msg) return { ok: false, reason: "no-message" };
  msg.updateSource({
    "flags.pf2e.origin.rollOptions": [...(msg.flags.pf2e?.origin?.rollOptions ?? []), "origin:item:cast-by-activation"],
    [flagPath("cast")]: { item: item.uuid, id, dc: info.dc, rank: eph.rank, ...(info.byLevel && { byLevel: true }) }
  });
  const created = await ChatMessage.create(msg.toObject());
  if (tracksUses(item, c.per) && created) await item.update({ [flagPath("uses", id)]: withUse(usesOf(item, id), c.per, clock(), created.id) });
  return { ok: true };
}

// флаг снимается: у вложенного предмета pf2e сливает правку mergeObject без performDeletions — ключ «-=» не сработает, пишем null (usesOf видит пусто)
const unset = (item, path) => (item.parentItem ? { [path]: null } : forcedDelete(path));

/** pf2e.restForTheNight: счётчики «раз в день» (и прочие) предметов отдохнувшего актёра обнуляются. */
async function resetUses(actor) {
  const update = actor.items.filter((i) => i.flags?.[MOD]?.uses).map((i) => ({ _id: i.id, ...forcedDelete(flagPath("uses")) }));
  if (update.length) await actor.updateEmbeddedDocuments("Item", update);
  for (const sub of actor.inventory?.flatMap((i) => i.subitems?.contents ?? []).filter((i) => i.flags?.[MOD]?.uses) ?? []) await sub.update(unset(sub, flagPath("uses")));   // вложенные: правка уходит в родителя
}

/** Карточка активации удалена — использование возвращается (у того клиента, что её удалил). */
async function giveBack(message, options, userId) {
  const c = message.flags?.[MOD]?.cast;
  if (!c || userId !== game.user.id || options?.deleteAll) return;   // очистка лога — не отмена сотворения
  const item = await fromUuid(c.item), e = usesOf(item, c.id), next = withoutUse(e, message.id);
  if (!item || next === e) return;
  await item.update(next ? { [flagPath("uses", c.id)]: next } : unset(item, flagPath("uses", c.id)));
}

export function init() {
  Hooks.once("setup", install);
  Hooks.on("pf2e.restForTheNight", (actor) => resetUses(actor).catch((e) => console.error(`${MOD} | cast reset`, e)));
  Hooks.on("deleteChatMessage", (m, o, userId) => giveBack(m, o, userId).catch((e) => console.error(`${MOD} | cast give back`, e)));
}

export function ready() {
  install();   // не успели на setup (игра уже была готова при подключении модуля)
  game.packs.get("pf2e.spells-srd")?.getIndex({ fields: ["system.traits.value"] });   // имена заклинаний для кнопок: fromUuidSync берёт их из индекса
}
