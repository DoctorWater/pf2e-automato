// Кинетическая аура. pf2e пишет правило только в описании: использование импульса с чертой «overflow» («переполнение») и потеря сознания гасят
// эффект «Кинетическая аура» (feat-effects, slug effect-kinetic-aura). Исполняет активный ведущий; работает и для NPC-кинетиков.
// Дубль сообщения (инлайн-проверку отправили в чат) безвреден: снимать уже снятое нечего. Тип контекста у карточки использования — нет (действие/черта) или self-effect.
import { queue } from "../util.mjs";
import { paHas } from "./lib.mjs";

export const AURA_SLUG = "effect-kinetic-aura";
const USE_TYPES = new Set([undefined, "self-effect"]);

/** Чистая: сообщение — использование импульса с чертой overflow (не бросок атаки/проверки/урона). */
export const isOverflowUse = ({ type, traits = [] }) => USE_TYPES.has(type) && traits.includes("overflow");
export const isAura = (item) => item?.type === "effect" && item.slug === AURA_SLUG;

const endAura = (actor) => queue(`actor:${actor.uuid}`, async () => {
  for (const e of actor.itemTypes.effect.filter(isAura)) await e.delete();
});

/** createChatMessage у активного ГМа. */
export async function onMessage(message) {
  const actor = message.actor, item = message.item;
  if (!actor || !item || !isOverflowUse({ type: message.flags?.pf2e?.context?.type, traits: item.system?.traits?.value ?? [] })) return;
  if (!paHas("kinetic-aura")) await endAura(actor);
}

/** createItem у активного ГМа: «Без сознания» гасит ауру. */
export async function onCreate(item) {
  const actor = item.actor;
  if (item.type === "condition" && item.slug === "unconscious" && actor?.itemTypes?.effect.some(isAura) && !paHas("kinetic-aura")) await endAura(actor);
}
