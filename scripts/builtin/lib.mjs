// Общие помощники встроенных обработчиков. Чистые функции не трогают foundry (юнит-тесты, tests/builtin.test.mjs).
import { MOD, queue, sharedDialog } from "../util.mjs";
import { card } from "../card.mjs";
export { card, cardButton } from "../card.mjs";

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const COND = {
  clumsy: "Compendium.pf2e.conditionitems.Item.i3OJZU2nk64Df3xm",
  offGuard: "Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg"
};
export const grantCondition = (uuid) => ({ key: "GrantItem", uuid, onDeleteActions: { grantee: "restrict" } });

/** «до конца текущего хода» — идиома pf2e: 0 раундов, expiry turn-end (pf2e.mjs:45866). */
export const UNTIL_TURN_END = { value: 0, unit: "rounds", expiry: "turn-end" };

/** Данные эффекта-обёртки. origin/target: {actor, token, item} — UUID или null. */
export function effectSource({ name, description = "", rules = [], duration = UNTIL_TURN_END, origin = {}, target = {}, img = "icons/svg/aura.svg" }) {
  return {
    name, type: "effect", img,
    system: {
      description: { value: description }, rules, level: { value: 0 }, tokenIcon: { show: true },
      duration: { sustained: false, ...duration },
      context: {
        origin: { actor: origin.actor ?? null, token: origin.token ?? null, item: origin.item ?? null, spellcasting: null, rollOptions: [] },
        target: target.actor ? { actor: target.actor, token: target.token ?? null } : null,   // pf2e: actor цели не может быть null, только вся цель
        roll: null
      }
    }
  };
}

/** Создать эффект на актёре; повтор с тем же key — пропуск (идемпотентно). Очередь актёра общая с apply.mjs. */
export function addEffect(actor, source, key) {
  return queue(`actor:${actor.uuid}`, async () => {
    if (actor.items.some((i) => i.flags?.[MOD]?.meta?.key === key)) return null;
    const data = foundry.utils.mergeObject(source, { flags: { [MOD]: { meta: { key, source: "builtin" } } } }, { inplace: false });
    const [item] = await actor.createEmbeddedDocuments("Item", [data]);
    return item;
  });
}

/** Состояние через apply.mjs (политика max, идемпотентность по meta.key). Импорт ленивый — без цикла macros <-> apply. */
export async function addCondition(actor, spec, key) {
  const { applyCondition } = await import("../apply.mjs");
  return applyCondition(actor, spec, { key, source: "builtin" });
}

/** Диалог выбора у активного ГМа. buttons: [{id, label}]; возвращает id или null (закрыт). */
export const ask = async (title, content, buttons) =>
  (await sharedDialog({ title, content, buttons: buttons.map((b) => ({ action: b.id, label: b.label })) }))?.action ?? null;

/** Диалог автору: игроку — у него; ГМу — общее окно всех вкладок ГМа (первый ответ побеждает). -> { action, form } | null (закрыт). */
export async function askHere(title, content, buttons) {
  if (game.user.isGM) return (await sharedDialog({ title, content, buttons: buttons.map((b) => ({ action: b.id, label: b.label })) })) ?? null;
  const res = await foundry.applications.api.DialogV2.wait({
    window: { title }, classes: ["paf-dialog"], content, rejectClose: false,
    buttons: buttons.map((b, i) => ({ action: b.id, label: b.label, default: i === 0, callback: (_e, btn) => ({ action: b.id, form: btn.form ? Object.fromEntries(new FormData(btn.form)) : {} }) }))
  });
  return res ?? null;
}

/** Шёпот ГМам и владельцам актёра: text — текст, buttons — готовые cardButton(...). */
export function whisper(actor, text, tag, extra = {}, buttons = "") {
  const content = card(text, buttons);
  const ids = new Set(game.users.filter((u) => u.isGM).map((u) => u.id));
  for (const u of game.users) if (!u.isGM && actor?.testUserPermission?.(u, "OWNER")) ids.add(u.id);
  return ChatMessage.create({ content, whisper: [...ids], flags: { [MOD]: { builtin: tag, ...extra } } });
}

/** Токен-документ из токена канваса или документа. */
export const docOf = (t) => t?.document ?? t ?? null;

/** Источник сообщения pf2e: origin {actor, uuid, type, rollOptions}; кастомные не-кастовые контексты отбрасываем. */
export function castOrigin(message) {
  const pf = message?.flags?.pf2e, ctx = pf?.context?.type;
  if (!pf?.origin || (ctx && ctx !== "spell-cast")) return null;
  return pf.origin;
}
