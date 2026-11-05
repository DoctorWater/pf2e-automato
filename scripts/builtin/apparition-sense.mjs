// «Чутьё сущности» (Apparition Sense): чувство без точности — присутствие скрытых или невидимых духов, фантомов и нежити в 30 фт. Черта пассивная, правил у неё нет,
// поэтому «применение» — это карточка черты в чат (как у pf2e-automations, postInfo): ведущий и владелец актёра получают шёпотом, кто рядом (без токенов и места).
import { L } from "../util.mjs";
import { whisper, paHas, itemSlug, esc } from "./lib.mjs";

export const SLUG = "apparition-sense", RANGE = 30;
export const TRAITS = ["spirit", "haunt", "undead"];   // порядок названия в шёпоте; у существа берётся первая из его черт

/** Чистая: что почуяли. near: [{traits: [slug], hidden: bool, feet}] -> уникальные черты в порядке TRAITS. */
export function sensed(near, range = RANGE) {
  const found = new Set(near.filter((n) => n.hidden && n.feet <= range).map((n) => TRAITS.find((t) => n.traits.includes(t))).filter(Boolean));
  return TRAITS.filter((t) => found.has(t));
}

const name = (t) => game.i18n.localize(CONFIG.PF2E?.creatureTraits?.[t] ?? t);

export async function onMessage(message) {
  const item = message.flags?.pf2e?.origin?.type ? message.item : null, actor = item?.actor;
  if (!actor || itemSlug(item) !== SLUG || paHas(SLUG)) return;
  const sp = message.speaker ?? {}, own = sp.scene && sp.token ? game.scenes.get(sp.scene)?.tokens.get(sp.token) : null;
  if (!own?.object) return;
  const near = own.parent.tokens.filter((t) => t.id !== own.id && t.actor && t.object).map((t) => ({
    traits: [...t.actor.traits], feet: own.object.distanceTo(t.object),
    hidden: !!t.hidden || !!t.actor.hasCondition?.("hidden", "invisible", "undetected", "unnoticed")   // t.hidden — токен скрыт ведущим
  }));
  const list = sensed(near).map(name);
  await whisper(actor, list.length ? L("builtin.apparition.found", { name: esc(actor.name), list: list.join(", ") }) : L("builtin.apparition.none", { name: esc(actor.name) }), "apparition-sense");
}
