// X1. Кровная магия аберрантного наследия (Eerie Veil): сотворил заклинание крови — «+2 статус Воле себе» или «−1 Воле одной цели».
// Эффект один (feat-effects UQ7vZgmfK0VSFS8A): знак зависит от того, совпадает ли автор эффекта с владельцем (предикат self:signature).
import { L } from "../util.mjs";
import { ask, castOrigin, docOf } from "./lib.mjs";

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

export async function onMessage(message) {
  const origin = castOrigin(message);
  if (!isBloodSpell(origin) || done.has(message.id)) return;
  const actor = await fromUuid(origin.actor);
  if (!actor?.items.some((i) => i.slug === BLOODLINE_SLUG)) return;
  done.add(message.id);
  // User#targets чужого пользователя синхронизируется ядром (user.mjs, userActivity.targets)
  const targets = [...(message.author?.targets ?? [])].map(docOf).filter((t) => t?.actor);
  const opts = bloodOptions(targets);
  const id = await ask(L("builtin.blood.title"), `<p>${L("builtin.blood.prompt", { name: actor.name })}</p>`, opts.map((o) => ({
    id: o.id, label: o.id === "self" ? L("builtin.blood.self") : o.id === "skip" ? L("builtin.blood.skip") : L("builtin.blood.target", { name: o.name })
  })));
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
