// Лимиты использования, о которых pf2e знает только из описаний: таблица LIMITS «признак -> требование/лимит», следующий лимит — одна строка.
//   импульс — только при активной кинетической ауре; переполнение — одно за раунд; Проведение стихийной энергии — только без активной ауры;
//   наговор (hex) — один за ход; реакция с листа — одна за раунд (флаг reactionSpent, его же ставят реакции и Блок щитом модуля);
//   частота (system.frequency) исчерпана — pf2e сам её списывает (createUseActionMessage), но на нуле действие не запрещает;
//   перезарядка — встроенный бросок «#Recharge» в описании: модуль бросает N раундов (rc_<id> на авторе) и до их конца не пускает; в бою;
//   требования к автору (rules/use-limits.json): прошлое действие — успешный Удар (штамп act на сообщениях), держит существо, свободная рука.
// Делаем как досягаемость (melee-reach.mjs): действия нет, предупреждение; Alt при клике — решение ГМа; unchecked() — свои сценарии модуля.
// Точки: (1) SpellcastingEntry#cast до списания слота/фокуса, (2) preCreateChatMessage — карточка использования любого пути (лист, cast.mjs).
// Атаку Стихийным взрывом без ауры pf2e не даёт сам («No kinetic gate», pf2e.mjs:24492).
// Файл по-прежнему зовётся impulse-gate: roundKey импортирует kinetic-aura.mjs (не наш файл).
import { L, MOD, guardActiveGM } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { combatOf, recipients, whisper } from "./lib.mjs";
import { slugOf, limitEntry } from "../rules.mjs";
import { AURA_SLUG } from "./kinetic-aura.mjs";
import { mechOf, rechargeEntry, isUseItem } from "../mech.mjs";
import { critRecharges, isBreath, rollDice, rollData, rechargeLeft, hitOf, lastAct, reqFails, holdsFrom } from "./limit-text.mjs";

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
  { reason: "noAura", applies: (c) => c.kinetic !== false && c.traits.includes("impulse"), fails: (c) => !c.aura, vars: (c) => ({ channel: c.channelName }) },
  { reason: "noHand", applies: (c) => c.kinetic !== false && c.traits.includes("impulse"), fails: (c) => c.handsFree === 0 },   // описание черты impulse: «only if you have a hand free»; pf2e считает hands.free по ancestry.hands и удерживаемым предметам (pf2e.mjs:35351)
  { reason: "overflow", applies: (c) => c.kinetic !== false && c.traits.includes("impulse") && c.traits.includes("overflow"), fails: (c) => !!c.round && c.overflowRound === c.round, mark: (c) => c.round && ["overflowRound", c.round] },
  { reason: "auraActive", applies: (c) => c.slug === "channel-elements", fails: (c) => c.auraEffect },   // «Your kinetic gate isn't active»
  { reason: "torches", applies: (c) => c.slug === "eternal-torch", fails: (c) => c.torches >= c.conMod, vars: (c) => ({ n: c.conMod }) },   // «maximum number of Eternal Torches equal to your Constitution modifier»; единственный предмет с таким лимитом (группы нет)
  { reason: "hex", applies: (c) => c.traits.includes("hex"), fails: (c) => !!c.turn && c.hexTurn === c.turn, mark: (c) => c.turn && ["hexTurn", c.turn] },
  // «за ход/раунд» pf2e восстанавливает только в бою (в начале хода): вне боя такого ограничения нет, как у roundKey
  // перезарядка: только в бою, у NPC и персонажей; срок бросает модуль (число на флаге), «ещё N» — раундов до нового использования. mode.limits=off — не бросаем и не ставим
  { reason: "recharge", applies: (c) => !!c.rc && c.inCombat && c.limitsOn, fails: (c) => rechargeLeft(c.rcLock, c.combatId, c.roundNum) > 0, vars: (c) => ({ n: rechargeLeft(c.rcLock, c.combatId, c.roundNum), until: c.rcLock.until }), mark: (c) => [`rc_${c.itemId}`, c.rcMark] },
  // требования к автору (оверлей use-limits.json): «любое из» клауз; ложный блок хуже пропуска — неизвестное состояние клаузы не блокирует
  { reason: "req", applies: (c) => !!c.req, fails: (c) => reqFails(c.req, c), vars: (c) => ({ need: c.req.any.map((cl) => needText(cl, c.actor)).join(L("builtin.limit.or")) }) },
  // pf2e списывает частоту ДО карточки: законное использование приходит в preCreate уже с 0 — его отличает свежее списание (justSpent)
  { reason: "frequency", applies: (c) => !!c.frequency && (c.inCombat || !["turn", "round"].includes(c.frequency.per)), fails: (c) => c.frequency.value <= 0 && !c.justSpent },
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

/** Подпись клаузы требования для предупреждения. */
export function needText(cl, actor) {
  if (cl.k === "holds") return L("builtin.limit.needHolds");
  if (cl.k === "hand") return L("builtin.limit.needHand");
  if (!cl.fx) return L("builtin.limit.needStrike");
  // имя эффекта Удара: предмет актёра с этим slug (перевод уже применён), иначе подпись pf2e (PF2E.AttackEffect*), иначе без имени — сырой slug игроку не показываем
  const label = globalThis.CONFIG?.PF2E?.attackEffects?.[cl.fx];
  const fx = actor?.items?.find((i) => slugOf(null, i) === cl.fx)?.name ?? (label && game.i18n.localize(label));
  return fx ? L("builtin.limit.needStrikeFx", { fx }) : L("builtin.limit.needStrikeSpecial");
}

/** Имя Удара: slug или оригинальное имя (у 11362 из 13060 Ударов NPC slug пуст); кириллица (перевод) — неизвестно. «melee»/«ranged» — тип, не имя. */
const strikeSlug = (item) => { const s = slugOf(null, item); return s && !/[Ѐ-ӿ]/.test(s) ? s : null; };

/** Сцена автора: сцена его токена, не canvas.scene (на неё мог переключиться другой экран). */
const sceneOf = (actor) => actor.token?.parent ?? actor.getActiveTokens?.()[0]?.document?.parent ?? null;

/** Состояния grabbed/restrained у других актёров сцены автора: [{uuid, origin}] (кто выдал — origin.actor эффекта-источника, null — не знаем). */
function heldStates(actor) {
  const out = [];
  for (const t of sceneOf(actor)?.tokens ?? []) {
    const a = t.actor;
    if (!a || a === actor) continue;
    for (const cond of a.itemTypes?.condition ?? []) {
      if (!["grabbed", "restrained"].includes(cond.slug) || cond.active === false || cond.isActive === false) continue;
      out.push({ uuid: a.uuid, origin: (cond.grantedBy ?? cond).system?.context?.origin?.actor ?? cond.system?.context?.origin?.actor ?? null });
    }
  }
  return out;
}

const rnd = () => globalThis.CONFIG?.Dice?.randomUniform?.() ?? Math.random();

/** Контекст для таблицы; тяжёлое (аура, лента) — лениво. */
function ctxOf(actor, item) {
  const combat = combatOf(game.combats, actor), f = withPending(actor.flags?.[MOD], pendingOf(actor)), rs = f.reactionSpent, round = roundKey(combat);
  const inCombat = !!round;
  let rcRolled = null;
  return {
    traits: traitsOf(item), slug: item.slug, actorType: actor.type, reaction: isReaction(item), round, turn: turnKey(combat), inCombat,
    kinetic: actor.type === "character" && actor.itemTypes.action.some((a) => a.slug === "channel-elements"),
    handsFree: actor.system?.hands?.free?.value, overflowRound: f.overflowRound, hexTurn: f.hexTurn,
    reactionSpent: !!rs && inCombat && rs.combat === combat.id && rs.round === combat.round,
    reactionFlag: inCombat ? { combat: combat.id, round: combat.round } : null,
    conMod: actor.abilities?.con?.mod ?? 0,
    frequency: item.system?.frequency ?? null, justSpent: spent.get(item.uuid) > Date.now(),
    actor, itemId: item.id, combatId: combat?.id, roundNum: combat?.round, limitsOn: modeOf("limits") !== "off", rcLock: f[`rc_${item.id}`],
    channelName: actor.itemTypes.action.find((a) => a.slug === "channel-elements")?.name,
    get rc() { return rechargeEntry(item); },
    // бросок один на контекст: число на флаге — то, что видит ГМ в шёпоте
    get rcMark() {
      if (!rcRolled) { const dice = this.rc.dice, r = rollDice(dice, rnd); rcRolled = { c: combat.id, until: combat.round + r.n, n: r.n, dice, r: r.r, mod: r.mod }; }
      return rcRolled;
    },
    get req() { return mechOf(item).req === false ? null : limitEntry(item)?.req ?? null; },
    get act() { return inCombat ? lastAct(game.messages.contents.slice(-60), actor.uuid, MOD) : null; },
    get holds() { return holdsFrom(heldStates(actor), actor.uuid); },
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

/** {reason, vars} первой сработавшей строки или null; vars — переменные строки для текста предупреждения. */
function check(actor, item) {
  const c = ctxOf(actor, item), l = LIMITS.find((x) => x.applies(c) && x.fails(c));
  if (!l) return null;
  let vars = {};
  try { vars = l.vars?.(c) ?? {}; } catch (e) { console.warn(`${MOD} | use-limits vars`, e); }   // текст не вышел — блок остаётся
  return { reason: l.reason, vars };
}

export function whyNot(actor, item) {
  return actor && item ? check(actor, item)?.reason ?? null : null;
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
const spent = new Map();   // uuid предмета -> срок: pf2e только что списал частоту, карточка этого использования законна
export const MOD_OPT = "pf2eAutomato";
/** Блок по другой строке LIMITS: pf2e уже списал частоту (до preCreate) — вернуть и погасить отметку. Синхронно: обновление уходит без ожидания, возврат отметку не открывает. */
export function refundSpent(item) {
  if (!(spent.get(item.uuid) > Date.now())) return;
  spent.delete(item.uuid);
  const f = item.system?.frequency;
  if (f && f.value < f.max) item.update({ "system.frequency.value": f.value + 1 }, { [MOD_OPT]: true }).catch((e) => console.warn(`${MOD} | use-limits refund`, e));
}
/** preUpdateItem: частота уменьшается — отметка «только что списано». */
export function onPreUpdateItem(item, changes, options) {
  if (options?.[MOD_OPT]) return;   // свои списания/возвраты модуля — не использование
  const v = foundry.utils.getProperty(changes, "system.frequency.value"), cur = item.system?.frequency?.value;
  if (typeof v === "number" && typeof cur === "number" && v < cur) spent.set(item.uuid, Date.now() + PASS_MS);
}
/** Разовый пропуск: wrapCast уже решил (проверка или Alt), preCreate после списания фокуса не проверяет второй раз. Короткий срок — на случай, если карточки не будет. */
export const grantPass = (actor, item) => passes.set(key(actor, item), Date.now() + PASS_MS);
const takePass = (actor, item) => { const k = key(actor, item), t = passes.get(k); passes.delete(k); return t > Date.now(); };

/** true — действие блокировано (предупреждение показано). */
export function blocked(actor, item) {
  if (skips.get(key(actor, item)) || altHeld() || modeOf("limits") === "off") return false;
  let why = null;
  try { why = check(actor, item); } catch (e) { console.warn(`${MOD} | use-limits`, e); }
  if (why) ui.notifications.warn(L(`builtin.limit.${why.reason}`, { name: item.name, ...why.vars }));   // названия — как на листе (перевод)
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

const STRIKE_TYPES = new Set(["attack-roll", "spell-attack-roll"]);
/** Тратит ли предмет действие: свободные действия, реакции и пассивки «последнее действие» не сбивают (решение ГМа). */
const spendsAction = (item) => (item.type === "spell" ? !/^(free|reaction)$/.test(item.system?.time?.value) : item.system?.actionType?.value === "action");

/** Штамп действия на сообщении (журнал для требований «последнее действие»): едет с самим сообщением, удаление карточки откатывает его. Только в бою. */
function stamp(message, actor, act) {
  const turn = turnKey(combatOf(game.combats, actor));
  if (turn) message.updateSource({ [`flags.${MOD}.act`]: { who: actor.uuid, turn, ...act } });
}

/** Бросок атаки: Удар (attack-roll) штампуется с итогом, именем и эффектами; атака заклинанием — как использование заклинания, не Удар. */
function stampAttack(message) {
  const actor = message.actor, item = message.item;
  if (!actor || !item) return;
  if (message.flags.pf2e.context.type === "spell-attack-roll") return void stamp(message, actor, { kind: "use" });
  stamp(message, actor, { kind: "strike", hit: hitOf(message.flags.pf2e.context.outcome), fx: (item.system?.attackEffects?.value ?? []).filter((e) => typeof e === "string"), slug: strikeSlug(item) });
  if (message.flags.pf2e.context.outcome === "criticalSuccess") critClear(message, actor);
}

/** Критический Удар у актёра с «Драконьим импульсом» и подобным: перезарядка Дыхания снимается (замок rc_* едет с сообщением в limitClear; onCreate снимает, onDelete возвращает). */
function critClear(message, actor) {
  const f = actor.flags?.[MOD] ?? {};
  if (!actor.items.some((i) => ["action", "feat", "effect"].includes(i.type) && critRecharges(slugOf(null, i), i.system?.description?.value))) return;
  const clear = Object.fromEntries(actor.items.filter((i) => f[`rc_${i.id}`] && isBreath(traitsOf(i), slugOf(null, i))).map((i) => [`rc_${i.id}`, f[`rc_${i.id}`]]));
  if (Object.keys(clear).length) message.updateSource({ [`flags.${MOD}.limitClear`]: clear });
}

/** preCreateChatMessage: карточка использования. false — сообщения нет. */
export function preCreate(message, data, options, userId) {
  if (userId !== game.user.id) return;
  const type = message.flags?.pf2e?.context?.type;
  if (STRIKE_TYPES.has(type)) { try { stampAttack(message); } catch (e) { console.warn(`${MOD} | use-limits stamp`, e); } return; }
  if (!USE_TYPES.has(type)) return;
  const actor = message.actor, item = message.item;
  if (!actor || !item || !isUseItem(item)) return;
  if (item.type === "spell" && !message.flags?.pf2e?.origin?.rollOptions?.includes(CAST)) return;
  if (skips.get(key(actor, item))) return;
  try { wrapEphemeral([actor]); } catch { /* лимит всё равно проверит preCreate */ }
  if (!takePass(actor, item) && blocked(actor, item)) { refundSpent(item); return false; }
  spent.delete(item.uuid);   // одно списание pf2e — одна законная карточка: следующее использование на нуле уже блокируется
  try {
    if (spendsAction(item)) stamp(message, actor, { kind: "use" });
    const marks = marksFor(ctxOf(actor, item));
    if (Object.keys(marks).length) {
      message.updateSource({ [`flags.${MOD}.limitMarks`]: marks });   // на актёра пишет onCreate, когда карточка создана; откат при удалении карточки
      pending.set(actor.uuid, { marks, until: Date.now() + PENDING_MS });   // до записи второе использование уже видит отметку
    }
  } catch (e) { console.warn(`${MOD} | use-limits`, e); }
}

/** createChatMessage у автора: карточка создана — отметки записываются на актёра. Чужой preCreate отменил карточку — отметки нет (pending истечёт сам). */
export async function onCreate(message) {
  const marks = message?.flags?.[MOD]?.limitMarks, clear = message?.flags?.[MOD]?.limitClear, actor = message?.actor;
  if (clear && actor && message.isAuthor) await actor.update(Object.fromEntries(Object.keys(clear).map((k) => [`flags.${MOD}.-=${k}`, null]))).catch((e) => console.warn(`${MOD} | use-limits crit recharge`, e));
  if (!marks || !actor || !message.isAuthor) return;
  try { await actor.update(Object.fromEntries(Object.entries(marks).map(([k, v]) => [`flags.${MOD}.${k}`, v]))); }
  catch (e) { console.warn(`${MOD} | use-limits mark`, e); }
  finally { if (JSON.stringify(pending.get(actor.uuid)?.marks) === JSON.stringify(marks)) pending.delete(actor.uuid); }
  if (modeOf("limits") === "off") return;
  for (const [k, v] of Object.entries(marks)) if (k.startsWith("rc_")) await showRecharge(actor, message.item, v, message.id);
}

/** Шёпот перезарядки с готовым броском (грани уже выпали в preCreate — второго броска нет): ГМ и владельцы персонажа; у NPC — только ГМ. */
async function showRecharge(actor, item, m, cardId) {
  const flavor = L("builtin.limit.rechargeRoll", { name: item?.name ?? "", dice: m.dice, n: m.n, until: m.until });
  try {
    const roll = Roll.fromData(rollData(m.dice, m.r, m.mod));
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), flavor, rolls: [roll], content: String(roll.total), whisper: recipients(actor, actor.type === "character" ? ["gm", "owner"] : ["gm"]), sound: CONFIG.sounds?.dice, flags: { [MOD]: { builtin: "recharge", rechargeFor: cardId } } });   // rechargeFor: удаление карточки убирает и этот шёпот
  } catch (e) {
    console.warn(`${MOD} | use-limits recharge roll`, e);
    await whisper(actor, flavor, "recharge", { rechargeFor: cardId }, "", actor.type === "character" ? null : "gm");
  }
}

/** deleteChatMessage (активный ГМ): карточка использования удалена — вернуть поставленные ею отметки, если флаг всё ещё тот же. */
export async function onDelete(message) {
  const marks = message?.flags?.[MOD]?.limitMarks, clear = message?.flags?.[MOD]?.limitClear, actor = message?.actor;
  if (!(marks || clear) || !actor || !guardActiveGM()) return;
  const stale = staleMarks(marks, actor.flags?.[MOD]);
  // крит-перезарядка откатывается вместе с карточкой: замок возвращается, если его не поставили заново
  const back = Object.entries(clear ?? {}).filter(([k]) => actor.flags?.[MOD]?.[k] === undefined);
  const upd = { ...Object.fromEntries(stale.map((k) => [`flags.${MOD}.-=${k}`, null])), ...Object.fromEntries(back.map(([k, v]) => [`flags.${MOD}.${k}`, v])) };
  if (Object.keys(upd).length) await actor.update(upd);
  const notes = (game.messages?.contents ?? []).filter((m) => m.flags?.[MOD]?.rechargeFor === message.id).map((m) => m.id);   // шёпот «снова доступно с раунда N»
  if (notes.length) await ChatMessage.deleteDocuments(notes);
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
  Hooks.on("preUpdateItem", onPreUpdateItem);
  const fail = (e) => { console.warn(`${MOD} | use-limits wrap`, e); if (game.user?.isGM) ui.notifications.warn(L("builtin.wrapFailed", { what: "use-limits", error: e?.message ?? e })); };
  try {
    wrapEphemeral(game.actors);
    if (game.modules.get("lib-wrapper")?.active && globalThis.libWrapper) return void libWrapper.register(MOD, "CONFIG.PF2E.Item.documentClasses.spellcastingEntry.prototype.cast", wrapCast, "MIXED");
    wrapProto(P);
  } catch (e) { fail(e); }
}
