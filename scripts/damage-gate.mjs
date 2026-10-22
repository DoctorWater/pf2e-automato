import { modeOf } from "./settings.mjs";
import { MOD } from "./util.mjs";

const OUTCOMES = ["criticalFailure", "failure", "success", "criticalSuccess"];

/** Чистая: какие кнопки урона оставить по исходу (0..3). Исход неизвестен -> обе. */
export function allowedDamage(degree) {
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

export function init() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!isPersistentCard(message)) return;
    const hide = persistentHide(workbench());
    // классом, а не remove(): pf2e дорисовывает эти кнопки асинхронно, уже после хука
    html.classList.toggle("paf-hide-pdamage", hide.damage);
    html.classList.toggle("paf-hide-precovery", hide.recovery);
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (modeOf("damageGate") === "off") return;
    const degree = gateDegree(message);
    if (degree === null) return;
    const allow = allowedDamage(degree);
    const box = html.querySelector(".message-buttons");
    for (const b of html.querySelectorAll(".message-buttons button[data-action$='-damage']")) {
      if (!allow[b.dataset.outcome]) b.remove();
    }
    if (box && !box.querySelector("button")) box.remove();
  });
}
