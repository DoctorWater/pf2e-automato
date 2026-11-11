import { modeOf } from "./settings.mjs";
import { MOD, L, callGM } from "./util.mjs";
import { isSanctuaryHold, isCancelled, isCounterHold, isCounterGate } from "./hold.mjs";

const OUTCOMES = ["criticalFailure", "failure", "success", "criticalSuccess"];

/** Чистая: какие кнопки урона оставить по исходу (0..3). Исход неизвестен -> обе. blocked — атака удержана или отменена (hold.mjs): обе скрыты при любом исходе. */
export function allowedDamage(degree, blocked = false) {
  if (blocked) return { success: false, "critical-success": false };
  if (!Number.isInteger(degree) || degree < 0 || degree > 3) return { success: true, "critical-success": true };
  return { success: degree === 2, "critical-success": degree === 3 };
}

/** Чистая: исход сообщения-атаки. Бросок свежее контекста (переброс), контекст — запасной. */
export function degreeOf(message) {
  const ctx = message?.flags?.pf2e?.context;
  if (ctx?.type !== "attack-roll") return null;
  const d = message.rolls?.[0]?.options?.degreeOfSuccess;
  if (Number.isInteger(d)) return d;
  const i = OUTCOMES.indexOf(ctx.outcome);
  return i >= 0 ? i : null;
}

/** Чистая: исход для кнопок. Флаг gate.degree пишет лидер-ГМ при использовании реакции (виден всем клиентам); у переброса — новое сообщение, флага нет. */
export function gateDegree(message) {
  const base = degreeOf(message), g = message?.flags?.[MOD]?.gate?.degree;
  return base !== null && Number.isInteger(g) ? g : base;
}

/** Чистая: карточка продолжительного урона pf2e — бросок состояния в конце хода (pf2e.mjs: onEndTurn -> evaluatePersistent). */
export const isPersistentCard = (message) => !!message?.rolls?.[0]?.options?.evaluatePersistent;

/** Чистая: что прятать на такой карточке. workbench сам применяет урон и сам бросает восстановление (второе — только вместе с первым). */
export const persistentHide = (wb) => ({ damage: !!wb?.applyPersistentDamage, recovery: !!(wb?.applyPersistentDamage && wb?.applyPersistentDamageRecoveryRoll) });

const workbench = () => {
  if (!game.modules.get("xdy-pf2e-workbench")?.active) return null;
  const get = (k) => { try { return game.settings.get("xdy-pf2e-workbench", k); } catch { return false; } };
  return { applyPersistentDamage: get("applyPersistentDamage"), applyPersistentDamageRecoveryRoll: get("applyPersistentDamageRecoveryRoll") };
};

/**
 * Чистая: плашка удержанной/отменённой атаки (Sanctuary) или сотворения (контрзаклинание): текст и кнопки ГМа.
 * Удержано — «Выпустить» / «Отменить» (карточка испытания не пришла, закрыта, сломалась); сорвано контрзаклинанием — «Вернуть» (= выпуск).
 */
export function holdPlaque(message) {
  const counter = isCounterGate(message), held = counter ? isCounterHold(message) : isSanctuaryHold(message);
  const text = counter ? (held ? "hold.counterWaiting" : "hold.counterCancelled") : held ? "hold.waiting" : "hold.cancelled";
  return { text, buttons: held ? ["release", "cancel"] : counter ? ["release"] : [] };
}

function holdBlock(message, html) {
  const box = html.querySelector(".message-content");
  if (!box || box.querySelector(".paf-hold")) return;
  const { text, buttons } = holdPlaque(message);
  const el = document.createElement("div");
  el.className = "paf-hold";
  el.innerHTML = `<p>${L(text)}</p>${buttons.length && game.user?.isGM ? `<div class="paf-card-actions">${buttons.map((b) => `<button type="button" data-hold="${b}">${L(b === "release" && !isCounterHold(message) && isCounterGate(message) ? "hold.restore" : `hold.${b}`)}</button>`).join("")}</div>` : ""}`;
  for (const b of el.querySelectorAll("[data-hold]")) b.addEventListener("click", (ev) => { ev.preventDefault(); b.disabled = true; callGM("holdResolve", message.id, b.dataset.hold); });
  box.append(el);
}

export function init() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!isPersistentCard(message)) return;
    const hide = persistentHide(workbench());
    // классом, а не remove(): pf2e дорисовывает эти кнопки асинхронно, уже после хука
    html.classList.toggle("paf-hide-pdamage", hide.damage);
    html.classList.toggle("paf-hide-precovery", hide.recovery);
  });
  // сотворение удержано/сорвано контрзаклинанием: кнопки pf2e и модуля прячет класс на корне (styles/chat.css; обратимо, переживает дорисовку pf2e/Toolbelt); плашка — всегда, независимо от режима гейта урона
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const counter = isCounterGate(message);
    html.classList.toggle("paf-counter-block", counter);
    if (counter) holdBlock(message, html);
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (modeOf("damageGate") === "off" || isCounterGate(message)) return;
    const blocked = isSanctuaryHold(message) || isCancelled(message);   // удержание переброса плашки и скрытия кнопок не даёт: провал урона не открывает
    const degree = gateDegree(message);
    if (degree === null && !blocked) return;
    if (blocked) holdBlock(message, html);
    const allow = allowedDamage(degree, blocked);
    const box = html.querySelector(".message-buttons");
    for (const b of html.querySelectorAll(".message-buttons button[data-action$='-damage']")) {
      if (!allow[b.dataset.outcome]) b.remove();
    }
    if (box && !box.querySelector("button")) box.remove();
  });
}
