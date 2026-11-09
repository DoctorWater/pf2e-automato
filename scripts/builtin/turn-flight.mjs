// Полёт «на это перемещение» (Встать на крыло и ещё 7 фитов, neutralize-rules.mjs FLIGHT): pf2e даёт переключатель RollOption и BaseSpeed fly под ним.
// Переключатель погашен (CLAUDE.md §1.5); при использовании фита на актёра ложится эффект с непереключаемой той же опцией — скорость и усиления
// (Zip! Zoom! -> 25) считает pf2e сам. Эффект кончается в конце хода (0 rounds / turn-end) либо после первого завершённого перемещения; вне боя — после него.
// Падение pf2e не автоматизирует: в карточку использования добавляется одна строка-напоминание (без урона и кнопки).
// Потолок: откат перемещения (undo) эффект не вернёт; без активного ГМа онлайн эффект не накладывается и не снимается.
import { L, MOD, queue } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { FLIGHT } from "./neutralize-rules.mjs";
import { card, effectSource, addEffect, paHas } from "./lib.mjs";

export const KEY = "turn-flight";
const USE_TYPES = new Set([undefined, "self-effect"]);
const MOVE_METHODS = new Set(["dragging", "keyboard", "api"]);   // как NEAR_METHODS (events.mjs): config/paste/undo — правка ГМа или откат
const NOT_MOVES = new Set(["displace", "blink"]);                // принудительное перемещение модуля (move.mjs) и телепорт — не «движение существа»

/** Чистая: опция полёта предмета (= slug фита) или null. */
export const optionOf = (item) => (["feat", "action"].includes(item?.type) && FLIGHT.includes(item.slug) ? item.slug : null);

/** Чистая: это перемещение завершает полёт — завершённое, ручное, любого вида pf2e (walk/fly/swim/climb/burrow/crawl/step), кроме displace и blink. */
export function endsOn(movement) {
  if (!movement || !MOVE_METHODS.has(movement.method) || movement.pending?.waypoints?.length) return false;
  const passed = movement.passed?.waypoints ?? [];
  const actions = passed.length ? passed.map((w) => w.action ?? "walk") : movement.destination?.action ? [movement.destination.action] : [];
  return actions.some((a) => !NOT_MOVES.has(a));
}

const isUse = (message) => USE_TYPES.has(message.flags?.pf2e?.context?.type) && message.actor && optionOf(message.item) && modeOf("macro") !== "off" && !paHas(message.item.slug);

/** preCreateChatMessage автора: строка про падение в карточке использования. */
export function preCreate(message, data, options, userId) {
  if (userId !== game.user.id || !isUse(message)) return;
  message.updateSource({ content: `${message.content ?? ""}${card(L("builtin.flight.fall"))}` });
}

/** createChatMessage активного ГМа: эффект с опцией фита; повтор, пока первый висит, не создаёт второго (addEffect по key). */
export async function onMessage(message) {
  if (!isUse(message)) return;
  const item = message.item, actor = message.actor, option = optionOf(item);
  const origin = { actor: actor.uuid, token: message.token?.uuid ?? null, item: item.uuid };
  await addEffect(actor, effectSource({
    name: item.name, img: item.img, origin,
    description: `<p>${L("builtin.flight.hint")}</p>`,
    rules: [{ key: "RollOption", domain: "all", option }]
  }), `${KEY}:${option}`);
}

/** moveToken активного ГМа: перемещение закончено — полёт снимается. */
export function onMove(doc, movement) {
  const actor = doc.actor;
  if (!actor || modeOf("macro") === "off" || !endsOn(movement)) return Promise.resolve();
  return queue(`actor:${actor.uuid}`, async () => {
    const ids = actor.itemTypes.effect.filter((e) => e.flags?.[MOD]?.meta?.key?.startsWith(`${KEY}:`)).map((e) => e.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  });
}
