// Удержание атаки (Sanctuary): атака по цели с носителем `hold` ждёт исхода испытания нападающего, а не проходит сразу.
// Состояние — флаг сообщения `flags[MOD].gate.hold` (ставит preCreateChatMessage на клиенте атакующего, events.onPreCreate), снимает шаг `hold` записи носителя
// (apply.applyOps) или ручные кнопки ГМа (damage-gate). Пока флаг стоит, ГМ-диспетчеры (events.onMessage, use.onCreateMessage, builtin) атаку не обрабатывают;
// после выпуска replay() прогоняет те же диспетчеры один раз. Принцип: сомнение — выпускаем: зависшая атака хуже ручного шага.
import { MOD, isActiveGM, queue, flagPath } from "./util.mjs";

const gateOf = (m) => m?.flags?.[MOD]?.gate;
export const isHeld = (m) => gateOf(m)?.hold === true;
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
export const siblingPending = (m) => feed().some((o) => o.id !== m.id && isHeld(o) && pairOf(o) === pairOf(m) && (hostOf(o) && pending(hostOf(o))));

export const replayers = new Set();   // диспетчеры атаки: events.onMessage, use.onCreateMessage, builtin — регистрируют себя сами
/** Один повторный прогон всех диспетчеров по выпущенной атаке; сбой одного остальных не гасит. */
export const replay = (m) => Promise.allSettled([...replayers].map((fn) => fn(m)));

/**
 * Разрешить удержание: release (выпустить, затем replay) | cancel (атака отменена, кнопки урона скрыты). Касается всех удержанных атак пары;
 * висящие карточки остальных удаляются. -> { prev } состояния данной атаки для отката | null (не удержана)
 */
export async function resolve(message, how, { wait = true } = {}) {
  if (!isHeld(message)) return null;
  const pair = pairOf(message);
  const group = feed().filter((m) => isHeld(m) && pairOf(m) === pair);
  const prev = { hold: true, cancelled: isCancelled(message) };
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
export const restore = (message, prev) => message && !message.flags?.[MOD]?.gate?.replayed ? message.update({ [flagPath("gate")]: { hold: !!prev?.hold, cancelled: !!prev?.cancelled } }) : null;

/** Страховка зависания: ГМ закрыл/удалил карточку испытания, не применив её, — атака выпускается. */
export async function onDeleteHost(card) {
  if (!isActiveGM()) return;
  const id = String(card.flags?.[MOD]?.use?.state?.event ?? "").split(":")[0], m = id ? game.messages.get(id) : null;
  if (m && isHeld(m) && !hostOf(m)) await queue(`hold:${pairOf(m)}`, () => resolve(m, "release"));
}

export function init() {
  Hooks.on("deleteChatMessage", (m) => { onDeleteHost(m).catch((e) => console.error(`${MOD} | hold.onDeleteHost`, e)); });
}
