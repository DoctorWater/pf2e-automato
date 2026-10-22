// «Руки-щупальца» (Tentacular Limbs): у pf2e для заклинания нет ни selfEffect, ни эффекта в spell-effects (rules: []), поэтому после сотворения
// вешаем эффект на заклинателя сами: безоружные Удары получают досягаемость 10 футов (признак reach: +5 фт к досягаемости; у PC-оружия pf2e нет reach-10). Продление до 20 футов за доп. действие — вручную.
import { L, MOD, queue } from "../util.mjs";
import { addEffect, castOrigin, effectSource } from "./lib.mjs";
import { kindOf } from "./spellshape.mjs";
import { TENTACLES } from "../range.mjs";

export const SLUG = "tentacular-limbs";
const IMG = "systems/pf2e/icons/spells/tentacular-limbs.webp";

/** Чистая: правила эффекта — безоружные Удары с досягаемостью 10 и опция для проверки дальности касания (range.mjs). */
export const rules = () => [reachRule(), { key: "RollOption", option: TENTACLES }];
export const reachRule = () => ({ key: "AdjustStrike", mode: "add", property: "weapon-traits", value: "reach", definition: ["item:category:unarmed"] });

export async function onMessage(message) {
  const origin = castOrigin(message), actor = message.actor;
  if (kindOf(origin) !== "cast" || !actor || !origin.uuid) return;
  const spell = await fromUuid(origin.uuid);
  if (spell?.slug !== SLUG) return;
  const src = effectSource({
    name: L("builtin.tentacles.effect"), img: IMG, rules: rules(),
    description: `<p>${L("builtin.tentacles.hint")}</p>`, duration: { value: 1, unit: "minutes", expiry: "turn-start" },
    origin: { actor: actor.uuid, item: spell.uuid }, target: { actor: actor.uuid }
  });
  await queue(`actor:${actor.uuid}`, async () => {   // повторное сотворение заменяет прежний эффект
    for (const e of actor.items.filter((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === SLUG)) await e.delete();
  });
  await addEffect(actor, src, SLUG);
}
