// Ярость. Когда эффект «Ярость» (feat-effects, slug effect-rage) заканчивается, на минуту действует «Иммунитет к временным ОЗ от Ярости»: нового
// всплеска ОЗ от действия Ярость не получить. Признак — slug эффекта: им пользуются все ярости (барбарские инстинкты, «Ярость» NPC — через selfEffect).
import { MOD, queue } from "../util.mjs";
import { addEffect, paHas } from "./lib.mjs";

export const RAGE_SLUG = "effect-rage", KEY = "rage-immunity";
export const IMMUNITY = "Compendium.pf2e.feat-effects.Item.MaepXeSHiMoWDm7u";

/** Чистая: удалённый предмет — эффект «Ярость». */
export const isRage = (item) => item?.type === "effect" && item.slug === RAGE_SLUG;

/** deleteItem у активного ведущего. Повторная ярость заново запускает минуту: старый иммунитет заменяется. */
export async function onDelete(item) {
  const actor = item.actor;
  if (!isRage(item) || !actor || paHas("rage")) return;
  const src = (await fromUuid(IMMUNITY))?.toObject();
  if (!src) return;
  delete src._id;
  src.system.context = { ...src.system.context, origin: { actor: actor.uuid, token: null, item: null, spellcasting: null, rollOptions: [] } };
  await queue(`actor:${actor.uuid}`, async () => {
    for (const e of actor.items.filter((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === KEY)) await e.delete();
  });
  await addEffect(actor, src, KEY);
}
