// X1. Кровная магия аберрантного наследия (Eerie Veil): сотворил заклинание крови — «+2 статус Воле себе» или «−1 Воле одной цели».
// Эффект один (feat-effects UQ7vZgmfK0VSFS8A): знак зависит от того, совпадает ли автор эффекта с владельцем (предикат self:signature).
import { L, MOD, socket } from "../util.mjs";
import { inRange } from "../range.mjs";
import { ask, askHere, castOrigin, docOf, esc } from "./lib.mjs";

export const EFFECT = "Compendium.pf2e.feat-effects.Item.UQ7vZgmfK0VSFS8A";
export const BLOODLINE_SLUG = "bloodline-aberrant";
// ItemAlteration наследия метит заклинания крови тегом; origin-опции предмета имеют префикс origin:item: (pf2e.mjs:45537)
export const TAG_OPTION = "origin:item:tag:blood-magic-spell";

export const isBloodSpell = (origin) => origin?.type === "spell" && (origin.rollOptions ?? []).includes(TAG_OPTION);

/** Варианты выбора: себе, по одной кнопке на цель, пропуск. */
export const bloodOptions = (targets) => [
  { id: "self" },
  ...targets.map((t) => ({ id: `t:${t.id}`, name: t.name })),
  { id: "skip" }
];

/** id -> {to:"self"} | {to:"target", token} | null. */
export function bloodChoice(id, targets) {
  if (id === "self") return { to: "self" };
  const token = id?.startsWith("t:") ? targets.find((t) => t.id === id.slice(2)) : null;
  return token ? { to: "target", token } : null;
}

const done = new Set();
const text = (o) => (o.id === "self" ? L("builtin.blood.self") : o.id === "skip" ? L("builtin.blood.skip") : L("builtin.blood.target", { name: o.name }));
const buttons = (opts) => opts.map((o) => ({ id: o.id, label: text(o) }));

/** Игрок-автор онлайн и владелец актёра -> пользователь, иначе null (тогда окно у ГМа). */
const playerOf = (message, actor) => {
  const u = message.author;
  return u && !u.isGM && u.active && u.id !== game.user.id && actor.testUserPermission?.(u, "OWNER") ? u : null;
};

/** У игрока (runPlayerBuiltin): окно выбора по снимку целей от ГМа (scope.targets — uuid; нет — текущие) -> id варианта | null. */
export async function pick(scope) {
  const targets = (scope.targets ? scope.targets.map((u) => fromUuidSync(u)) : [...(game.user.targets ?? [])]).map(docOf).filter((t) => t?.actor);
  const res = await askHere(L("builtin.blood.title"), `<p>${L("builtin.blood.prompt", { name: esc(scope.actor?.name) })}</p>`, buttons(bloodOptions(targets)));
  return res?.action ?? null;
}

// Ровно один раз за сотворение: claim по id сообщения ставится синхронно, до первого await (хук и правило-ссылка приходят одновременно).
export async function onMessage(message) {
  const origin = castOrigin(message);
  if (!isBloodSpell(origin) || done.has(message.id)) return;
  done.add(message.id);
  const actor = await fromUuid(origin.actor);
  if (!actor?.items.some((i) => i.slug === BLOODLINE_SLUG)) return;
  // снимок целей сообщения; иначе User#targets автора (ядро синхронизирует их между клиентами, user.mjs userActivity.targets)
  const snap = message.flags?.[MOD]?.use?.targets;
  const targets = (snap ? inRange(snap).map((t) => fromUuidSync(t.uuid)) : [...(message.author?.targets ?? [])]).map(docOf).filter((t) => t?.actor);
  const opts = bloodOptions(targets);
  const player = playerOf(message, actor);
  let id;
  if (player) {
    const token = message.speaker?.scene && message.speaker?.token ? game.scenes.get(message.speaker.scene)?.tokens.get(message.speaker.token) : null;
    try { id = await Promise.race([socket.executeAsUser("runPlayerBuiltin", player.id, "blood-magic-pick", { actor: actor.uuid, token: token?.uuid ?? null, item: origin.uuid, message: message.id, targets: targets.map((t) => t.uuid) }), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 180000))]); }
    catch (e) { console.warn(`${MOD} | blood-magic: окно у игрока не вышло, спрашиваем ведущего`, e); id = undefined; }
  }
  if (id === undefined) id = await ask(L("builtin.blood.title"), `<p>${L("builtin.blood.prompt", { name: esc(actor.name) })}</p>`, buttons(opts));
  const choice = bloodChoice(id, targets);
  if (!choice) return;
  const spell = await fromUuid(origin.uuid);
  const { applyEffect } = await import("../apply.mjs");
  const sp = message.speaker ?? {};
  const originToken = sp.scene && sp.token ? game.scenes.get(sp.scene)?.tokens.get(sp.token) : null;
  const meta = { key: `${message.id}:blood:${choice.to === "self" ? "self" : choice.token.id}`, source: "builtin" };
  const ctx = { originActor: actor, originToken, originItem: spell };
  if (choice.to === "self") await applyEffect(actor, { uuid: EFFECT }, meta, ctx);
  else await applyEffect(choice.token.actor, { uuid: EFFECT }, meta, { ...ctx, target: choice.token });
}
