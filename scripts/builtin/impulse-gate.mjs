// Лимиты использования, о которых pf2e знает только из описаний: таблица LIMITS «признак -> требование/лимит», следующий лимит — одна строка.
//   импульс — только при активной кинетической ауре; переполнение — одно за раунд; Проведение стихийной энергии — только без активной ауры;
//   наговор (hex) — один за ход; реакция с листа — одна за раунд (флаг reactionSpent, его же ставят реакции и Блок щитом модуля).
// Делаем как досягаемость (melee-reach.mjs): действия нет, предупреждение; Alt при клике — решение ГМа; unchecked() — свои сценарии модуля.
// Точки: (1) SpellcastingEntry#cast до списания слота/фокуса, (2) preCreateChatMessage — карточка использования любого пути (лист, cast.mjs).
// Атаку Стихийным взрывом без ауры pf2e не даёт сам («No kinetic gate», pf2e.mjs:24492).
// Файл по-прежнему зовётся impulse-gate: roundKey импортирует kinetic-aura.mjs (не наш файл).
import { L, MOD, guardActiveGM } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { combatOf } from "./lib.mjs";
import { AURA_SLUG } from "./kinetic-aura.mjs";

const traitsOf = (item) => item?.system?.traits?.value ?? [];
export const TORCH_EFFECT = "Compendium.pf2e.feat-effects.Item.61qS86bjxg8HCJBY";
const USE_TYPES = new Set([undefined, "self-effect", "spell-cast"]);
const CAST = "origin:action:slug:cast-a-spell";   // как use.mjs: карточка заклинания «в чат» без сотворения (context.type "spell-cast", pf2e.mjs:53345) — не использование

/** Раунд начатого боя; вне боя — null (ограничения «за раунд» нет). */
export const roundKey = (combat) => (combat?.started ? `${combat.id}:${combat.round}` : null);
/** Ход начатого боя (текущий ход любого участника); вне боя — null. */
export const turnKey = (combat) => (combat?.started ? `${combat.id}:${combat.round}:${combat.turn}` : null);

/**
 * Таблица. applies(c) — лимит касается этого предмета; fails(c) — требование нарушено; mark(c) — [флаг актёра, значение] после законного использования.
 * Порядок важен: первая сработавшая строка — причина (ключ builtin.limit.<reason>). c.kinetic === false — у актёра нет Channel Elements (строки импульса молчат).
 */
export const LIMITS = [
  { reason: "noAura", applies: (c) => c.kinetic !== false && c.traits.includes("impulse"), fails: (c) => !c.aura },
  { reason: "noHand", applies: (c) => c.kinetic !== false && c.traits.includes("impulse"), fails: (c) => c.handsFree === 0 },   // описание черты impulse: «only if you have a hand free»; pf2e считает hands.free по ancestry.hands и удерживаемым предметам (pf2e.mjs:35351)
  { reason: "overflow", applies: (c) => c.kinetic !== false && c.traits.includes("impulse") && c.traits.includes("overflow"), fails: (c) => !!c.round && c.overflowRound === c.round, mark: (c) => c.round && ["overflowRound", c.round] },
  { reason: "auraActive", applies: (c) => c.slug === "channel-elements", fails: (c) => c.auraEffect },   // «Your kinetic gate isn't active»
  { reason: "torches", applies: (c) => c.slug === "eternal-torch", fails: (c) => c.torches >= c.conMod },   // «maximum number of Eternal Torches equal to your Constitution modifier»; единственный предмет с таким лимитом (группы нет)
  { reason: "hex", applies: (c) => c.traits.includes("hex"), fails: (c) => !!c.turn && c.hexTurn === c.turn, mark: (c) => c.turn && ["hexTurn", c.turn] },
  { reason: "reaction", applies: (c) => c.reaction && c.actorType === "character", fails: (c) => c.reactionSpent, mark: (c) => c.round && c.inCombat && ["reactionSpent", c.reactionFlag] }   // NPC: реакций бывает несколько
];

/** Чистая: ключ причины блока или null. */
export function reasonOf(c) {
  return LIMITS.find((l) => l.applies(c) && l.fails(c))?.reason ?? null;
}

/** Чистая: сколько из эффектов — действующие Вечные факелы этого автора. */
export const countTorches = (effects, authorUuid) => effects.filter((e) => e._stats?.compendiumSource === TORCH_EFFECT && !e.isExpired && e.system?.context?.origin?.actor === authorUuid).length;

/** Чистая: по ленте (новые в конце) — свежая карточка Channel Elements этого актёра без последующего переполнения. */
export function channelPending(messages, actorId) {
  for (const m of [...messages].reverse()) {
    if (m.speaker?.actor !== actorId) continue;
    if (m.item?.slug === "channel-elements") return true;
    if (USE_TYPES.has(m.flags?.pf2e?.context?.type) && traitsOf(m.item).includes("overflow")) return false;
  }
  return false;
}

const isReaction = (item) => item?.system?.time?.value === "reaction" || item?.system?.actionType?.value === "reaction";

/** Контекст для таблицы; тяжёлое (аура, лента) — лениво. */
function ctxOf(actor, item) {
  const combat = combatOf(game.combats, actor), f = withPending(actor.flags?.[MOD], pendingOf(actor)), rs = f.reactionSpent, round = roundKey(combat);
  const inCombat = !!round;
  return {
    traits: traitsOf(item), slug: item.slug, actorType: actor.type, reaction: isReaction(item), round, turn: turnKey(combat), inCombat,
    kinetic: actor.type === "character" && actor.itemTypes.action.some((a) => a.slug === "channel-elements"),
    handsFree: actor.system?.hands?.free?.value, overflowRound: f.overflowRound, hexTurn: f.hexTurn,
    reactionSpent: !!rs && inCombat && rs.combat === combat.id && rs.round === combat.round,
    reactionFlag: inCombat ? { combat: combat.id, round: combat.round } : null,
    conMod: actor.abilities?.con?.mod ?? 0,
    // действующие факелы автора: эффект может висеть на ком угодно в сцене (на союзнике) — смотрим его самого и токены сцены
    get torches() {
      const holders = new Set([actor, ...(globalThis.canvas?.scene?.tokens ?? []).map((t) => t.actor).filter(Boolean)]);
      return countTorches([...holders].flatMap((h) => h.itemTypes.effect), actor.uuid);
    },
    get auraEffect() { return actor.itemTypes.effect.some((e) => e.slug === AURA_SLUG); },
    // ponytail: эффект ауры вешается кнопкой карточки Channel Elements; пока не нажали, ауру даёт сама карточка среди 10 последних сообщений
    // (Стихийный взрыв «как часть этого действия»). Аура, снятая «Отпустить» без сообщения, в эти 10 сообщений проскочит.
    get aura() { return this.auraEffect || channelPending(game.messages.contents.slice(-10), actor.id); }
  };
}

export function whyNot(actor, item) {
  return actor && item ? reasonOf(ctxOf(actor, item)) : null;
}

const altHeld = () => !!globalThis.game?.keyboard?.isModifierActive?.("Alt");

// Пропуски привязаны к вызову (актёр + slug предмета), не глобальные: чужое сотворение в тот же момент проверяется.
const key = (actor, item) => `${actor?.uuid}|${item?.slug}`;
const skips = new Map(), passes = new Map();
/** Действие модуля без проверки лимитов и без отметки (его сценарий уже решил, что оно законно: карточка трекера реакции и т. п.). Только для этого актёра и предмета. */
export async function unchecked(actor, item, fn) {
  const k = key(actor, item);
  skips.set(k, (skips.get(k) ?? 0) + 1);
  try { return await fn(); } finally { skips.set(k, skips.get(k) - 1); }
}

const PASS_MS = 15000;
/** Разовый пропуск: wrapCast уже решил (проверка или Alt), preCreate после списания фокуса не проверяет второй раз. Короткий срок — на случай, если карточки не будет. */
export const grantPass = (actor, item) => passes.set(key(actor, item), Date.now() + PASS_MS);
const takePass = (actor, item) => { const k = key(actor, item), t = passes.get(k); passes.delete(k); return t > Date.now(); };

/** true — действие блокировано (предупреждение показано). */
export function blocked(actor, item) {
  if (skips.get(key(actor, item)) || altHeld() || modeOf("limits") === "off") return false;
  let why = null;
  try { why = whyNot(actor, item); } catch (e) { console.warn(`${MOD} | use-limits`, e); }
  if (why) ui.notifications.warn(L(`builtin.limit.${why}`, { name: item.name, channel: actor.itemTypes.action.find((a) => a.slug === "channel-elements")?.name, n: actor.abilities?.con?.mod ?? 0 }));   // названия — как на листе (перевод)
  return !!why;
}

const PENDING_MS = 5000;
const pending = new Map();   // uuid актёра -> {marks, until}: отметка между preCreate и записью на актёра (createChatMessage); только клиент автора
/** Чистая: флаги актёра с ещё не записанными отметками. */
export const withPending = (flags, p, now = Date.now()) => (p && p.until > now ? { ...flags, ...p.marks } : flags ?? {});
const pendingOf = (actor) => pending.get(actor?.uuid);

/** Чистая по ctx: отметки законного использования {флаг: значение} (и по Alt тоже: действие совершено). */
export const marksFor = (c) => {
  const marks = {};
  for (const l of LIMITS) { const m = l.applies(c) && l.mark?.(c); if (m) marks[m[0]] = m[1]; }
  return marks;
};

/** Чистая: какие отметки с карточки ещё стоят на актёре в том же значении (их и откатываем при удалении карточки). */
export const staleMarks = (marks, flags) => Object.keys(marks ?? {}).filter((k) => JSON.stringify(flags?.[k]) === JSON.stringify(marks[k]));

/** preCreateChatMessage: карточка использования. false — сообщения нет. */
export function preCreate(message, data, options, userId) {
  if (userId !== game.user.id || !USE_TYPES.has(message.flags?.pf2e?.context?.type)) return;
  const actor = message.actor, item = message.item;
  if (!actor || !item || !["spell", "action", "feat"].includes(item.type)) return;
  if (item.type === "spell" && !message.flags?.pf2e?.origin?.rollOptions?.includes(CAST)) return;
  if (skips.get(key(actor, item))) return;
  try { wrapEphemeral([actor]); } catch { /* лимит всё равно проверит preCreate */ }
  if (!takePass(actor, item) && blocked(actor, item)) return false;
  try {
    const marks = marksFor(ctxOf(actor, item));
    if (Object.keys(marks).length) {
      message.updateSource({ [`flags.${MOD}.limitMarks`]: marks });   // на актёра пишет onCreate, когда карточка создана; откат при удалении карточки
      pending.set(actor.uuid, { marks, until: Date.now() + PENDING_MS });   // до записи второе использование уже видит отметку
    }
  } catch (e) { console.warn(`${MOD} | use-limits`, e); }
}

/** createChatMessage у автора: карточка создана — отметки записываются на актёра. Чужой preCreate отменил карточку — отметки нет (pending истечёт сам). */
export async function onCreate(message) {
  const marks = message?.flags?.[MOD]?.limitMarks, actor = message?.actor;
  if (!marks || !actor || !message.isAuthor) return;
  try { await actor.update(Object.fromEntries(Object.entries(marks).map(([k, v]) => [`flags.${MOD}.${k}`, v]))); }
  catch (e) { console.warn(`${MOD} | use-limits mark`, e); }
  finally { if (JSON.stringify(pending.get(actor.uuid)?.marks) === JSON.stringify(marks)) pending.delete(actor.uuid); }
}

/** deleteChatMessage (активный ГМ): карточка использования удалена — вернуть поставленные ею отметки, если флаг всё ещё тот же. */
export async function onDelete(message) {
  const marks = message?.flags?.[MOD]?.limitMarks, actor = message?.actor;
  if (!marks || !actor || !guardActiveGM()) return;
  const stale = staleMarks(marks, actor.flags?.[MOD]);
  if (stale.length) await actor.update(Object.fromEntries(stale.map((k) => [`flags.${MOD}.-=${k}`, null])));
}

// SpellcastingEntry#cast: слот/фокус списывает consume ДО карточки (pf2e.mjs:53700) — блокируем раньше, иначе заклинание потрачено зря.
async function wrapCast(orig, spell, ...rest) {
  if (blocked(this.actor, spell)) return;
  grantPass(this.actor, spell);   // решение принято (в т. ч. Alt): preCreate его не пересматривает
  try { return await orig(spell, ...rest); } finally { passes.delete(key(this.actor, spell)); }
}

const WRAPPED = Symbol.for(`${MOD}.limits`);
const wrapProto = (P) => {
  if (!P?.cast || P[WRAPPED]) return;
  const orig = P.cast;
  P.cast = function (...a) { return wrapCast.call(this, orig.bind(this), ...a); };
  P[WRAPPED] = true;
};
/** ItemSpellcasting (жезлы/посохи/свитки) и RitualSpellcasting не выставлены в CONFIG: прототип берём с экземпляра в actor.spellcasting (флаг isEphemeral).
 * ponytail: актёр без таких предметов до первой карточки не охвачен — там держит preCreate; повторный вызов из preCreate подхватывает прототип. */
export function wrapEphemeral(actors) {
  for (const a of actors) for (const e of a?.spellcasting ?? []) if (e?.isEphemeral && e.cast) wrapProto(Object.getPrototypeOf(e));
}

let installed = false;
/** Идемпотентно; после ready. */
export function install() {
  const P = globalThis.CONFIG?.PF2E?.Item?.documentClasses?.spellcastingEntry?.prototype;
  if (installed || !P?.cast) return;
  installed = true;
  Hooks.on("createChatMessage", onCreate);
  const fail = (e) => { console.warn(`${MOD} | use-limits wrap`, e); if (game.user?.isGM) ui.notifications.warn(L("builtin.wrapFailed", { what: "use-limits", error: e?.message ?? e })); };
  try {
    wrapEphemeral(game.actors);
    if (game.modules.get("lib-wrapper")?.active && globalThis.libWrapper) return void libWrapper.register(MOD, "CONFIG.PF2E.Item.documentClasses.spellcastingEntry.prototype.cast", wrapCast, "MIXED");
    wrapProto(P);
  } catch (e) { fail(e); }
}
