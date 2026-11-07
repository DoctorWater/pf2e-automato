// Удержание атаки (Sanctuary): атака по цели с носителем `hold` ждёт исхода испытания нападающего, а не проходит сразу.
// Состояние — флаг сообщения `flags[MOD].gate.hold` (ставит preCreateChatMessage на клиенте атакующего, events.onPreCreate), снимает шаг `hold` записи носителя
// (apply.applyOps) или ручные кнопки ГМа (damage-gate). Пока флаг стоит, ГМ-диспетчеры (events.onMessage, use.onCreateMessage, builtin) атаку не обрабатывают;
// после выпуска replay() прогоняет те же диспетчеры один раз. Принцип: сомнение — выпускаем: зависшая атака хуже ручного шага.
import { MOD, DEGREES, isActiveGM, queue, flagPath } from "./util.mjs";

const gateOf = (m) => m?.flags?.[MOD]?.gate;
// Причина удержания: true — Святилище (ждёт испытания нападающего), "reroll" — ждёт решения о переброске после провала (builtin/failed.mjs).
export const REROLL = "reroll";
export const isHeld = (m) => !!gateOf(m)?.hold;
export const isRerollHold = (m) => gateOf(m)?.hold === REROLL;
/** Удержание Святилища: плашка «ждёт испытания», ручные кнопки ГМа, пары атак. */
export const isSanctuaryHold = (m) => gateOf(m)?.hold === true;
export const isCancelled = (m) => gateOf(m)?.cancelled === true;

/** Нападение — бросок атаки (в том числе заклинанием) или проверка с чертой attack (Подсечка, Захват, Толчок, Разоружение). */
export function isAttackContext(ctx) {
  if (ctx?.type === "attack-roll" || ctx?.type === "spell-attack-roll") return true;
  return ctx?.type === "skill-check" && (ctx.traits ?? []).some((t) => (typeof t === "string" ? t : t?.name) === "attack");
}

/** Актёр-цель и актёр-атакующий одной «пары»: параллельные атаки пары (Двойной удар) разрешаются одним спасброском. */
export const pairOf = (m) => `${m?.actor?.uuid ?? m?.speaker?.actor ?? ""}>${m?.flags?.pf2e?.context?.target?.actor ?? ""}`;

const feed = () => game.messages.contents;
/** Карточка испытания удержанной атаки (events.hostChallenge: use.state.event = `<id атаки>:<носитель>:<i>`). */
export const hostOf = (m) => feed().find((h) => String(h.flags?.[MOD]?.use?.state?.event ?? "").startsWith(`${m.id}:`)) ?? null;
/** Карточка не разрешена: её шаги ещё не применены (бросок Воли мог уже пройти — apply=button ждёт «Применить»). */
const pending = (h) => !Object.keys(h.flags?.[MOD]?.use?.state?.challenge?.applied ?? {}).length;
/** У другой удержанной атаки этой пары уже есть неразрешённая карточка — вторая карточка не нужна, разрешение первой касается обеих. */
export const siblingPending = (m) => feed().some((o) => o.id !== m.id && isSanctuaryHold(o) && pairOf(o) === pairOf(m) && (hostOf(o) && pending(hostOf(o))));

export const replayers = new Set();   // диспетчеры атаки: events.onMessage, use.onCreateMessage, builtin — регистрируют себя сами
/** Один повторный прогон всех диспетчеров по выпущенной атаке; сбой одного остальных не гасит. */
export const replay = (m) => Promise.allSettled([...replayers].map((fn) => fn(m)));

/**
 * Разрешить удержание: release (выпустить, затем replay) | cancel (атака отменена, кнопки урона скрыты). Касается всех удержанных атак пары;
 * висящие карточки остальных удаляются. -> { prev } состояния данной атаки для отката | null (не удержана)
 */
export async function resolve(message, how, { wait = true } = {}) {
  if (!isHeld(message)) return null;
  const pair = pairOf(message), reroll = isRerollHold(message);
  // удержание переброса — одно сообщение; Святилище — вся пара. Группы разных причин друг друга не выпускают
  const group = reroll ? [message] : feed().filter((m) => isSanctuaryHold(m) && pairOf(m) === pair);
  const prev = { hold: gateOf(message).hold, cancelled: isCancelled(message) };
  // сбой update одной атаки (удалена переброском) остальных не обрывает; replayed — выпуск необратим (restore не возвращает удержание)
  for (const m of group) await m.update({ [flagPath("gate")]: how === "cancel" ? { hold: false, cancelled: true } : { hold: false, replayed: true } }).catch((e) => console.warn(`${MOD} | hold.resolve`, e));
  for (const m of group) {
    const h = m.id === message.id ? null : hostOf(m);
    if (h && pending(h)) await h.delete().catch(() => {});
  }
  // wait:false — вызов из очереди events:<id> (шаг hold записи): replay входит в ту же очередь, ждать его там — взаимная блокировка
  if (how !== "cancel") for (const m of group) { const p = replay(m); if (wait) await p; }
  return { prev };
}

/** Ручная кнопка ГМа (damage-gate, сокет holdResolve): выпустить или отменить, не дожидаясь карточки. Карточка испытания, если есть, удаляется. */
export async function resolveManual(id, how) {
  const m = game.messages.get(id);
  if (!m || !isHeld(m)) return null;
  return queue(`hold:${pairOf(m)}`, async () => {
    const h = hostOf(m), r = await resolve(m, how === "cancel" ? "cancel" : "release");
    if (h && pending(h)) await h.delete().catch(() => {});
    return r;
  });
}

/**
 * Откат шага hold: отменённая атака снова ждёт (карточку можно применить заново). Выпущенная (replayed) остаётся выпущенной:
 * replay уже сработал (Захват, подсказка реакции), второго быть не должно; откатываются только cancelled и метки.
 */
export const restore = (message, prev) => message && !message.flags?.[MOD]?.gate?.replayed ? message.update({ [flagPath("gate")]: { hold: prev?.hold || false, cancelled: !!prev?.cancelled } }) : null;

// Переброс удержанного сообщения: pf2e удаляет старое и создаёт новое с isReroll, старое никто не обрабатывал — новое должно пройти как первое.
// deleteChatMessage (все клиенты) запоминает удалённое удержанное сообщение по (актёр, тип проверки); preCreate на клиенте автора (там pf2e awaits delete, затем создаёт)
// один раз «потребляет» запись и ставит на новое сообщение флаг `rerollOf` = id старого. Потребители (isHeldReroll) и ожидание исхода (settledDegree) читают флаг.
// ponytail: ключ — актёр+тип, TTL 10 с; чужое удаление удержанного, за которым в эти 10 с идёт обычный переброс того же актёра/типа, пометит и его. Точнее — нечем: pf2e не передаёт id старого сообщения.
const REROLL_TTL = 10_000;
const heldGone = new Map();
const goneKey = (m) => `${m?.speaker?.actor ?? m?.actor?.id ?? ""}|${m?.flags?.pf2e?.context?.type ?? ""}`;
/** deleteChatMessage: удалено сообщение, ещё ждавшее решения о переброске. */
export function noteHeldDeleted(m, at = Date.now()) { if (isRerollHold(m)) heldGone.set(goneKey(m), { at, id: m.id }); }
/** preCreateChatMessage (клиент автора): переброс удержанного — флаг `rerollOf` на новом сообщении. */
export function stampHeldReroll(m, at = Date.now()) {
  try {
    if (!m?.flags?.pf2e?.context?.isReroll) return;
    const k = goneKey(m), e = heldGone.get(k);
    heldGone.delete(k);
    if (e && at - e.at <= REROLL_TTL) m.updateSource({ flags: { [MOD]: { rerollOf: e.id } } });
  } catch (err) { console.warn(`${MOD} | hold.stampHeldReroll`, err); }
}
/** Это сообщение — переброс удержанного (старое не обрабатывалось), его надо обработать целиком. */
export const isHeldReroll = (m) => !!m?.flags?.[MOD]?.rerollOf;
export const _resetHeldGone = () => heldGone.clear();

// Прямые потребители броска (escape, Удары, Удушье, Грязный приём…) берут степень из результата броска, а не из сообщения: удержанный бросок (причина reroll)
// для них ещё не итог. Ждём выпуска (степень исходного) или переброса (степень нового сообщения с `rerollOf`); опрос — без хуков, нечему утекать.
export const HOLD_WAIT_MS = 35_000;   // чуть больше HOLD_MS failed.mjs: к этому времени удержание выпущено sweep'ом/таймером
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const degreeOfMessage = (m) => {
  const d = m?.rolls?.[0]?.options?.degreeOfSuccess ?? m?.rolls?.[0]?.degreeOfSuccess, i = DEGREES.indexOf(m?.flags?.pf2e?.context?.outcome);
  return Number.isInteger(d) ? d : i >= 0 ? i : null;
};
/**
 * Итоговая степень броска: msg — сообщение броска (callback pf2e), degree — степень самого броска. Не удержано — degree сразу.
 * grace — сколько ждать новое сообщение после исчезновения старого (удаление и создание идут подряд).
 */
export async function settledDegree(msg, degree, { ms = HOLD_WAIT_MS, step = 250, grace = 5000 } = {}) {
  if (!msg || !isRerollHold(msg)) return degree;
  let goneAt = null;
  for (let t = 0; t < ms; t += step) {
    const neu = game.messages.contents.find((m) => m.flags?.[MOD]?.rerollOf === msg.id);
    if (neu) return degreeOfMessage(neu) ?? degree;
    const cur = game.messages.get(msg.id);
    if (cur && !isRerollHold(cur)) return degree;   // выпущено: исходный бросок остаётся
    if (!cur) { goneAt ??= t; if (t - goneAt >= grace) return degree; }
    await pause(step);
  }
  return degree;
}

/** Страховка зависания: ГМ закрыл/удалил карточку испытания, не применив её, — атака выпускается. */
export async function onDeleteHost(card) {
  if (!isActiveGM()) return;
  const id = String(card.flags?.[MOD]?.use?.state?.event ?? "").split(":")[0], m = id ? game.messages.get(id) : null;
  if (m && isSanctuaryHold(m) && !hostOf(m)) await queue(`hold:${pairOf(m)}`, () => resolve(m, "release"));
}

export function init() {
  Hooks.on("preCreateChatMessage", (m) => stampHeldReroll(m));
  Hooks.on("deleteChatMessage", (m) => { noteHeldDeleted(m); onDeleteHost(m).catch((e) => console.error(`${MOD} | hold.onDeleteHost`, e)); });
}
