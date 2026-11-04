// Ярость. Когда эффект «Ярость» (feat-effects, slug effect-rage) заканчивается, на минуту действует «Иммунитет к временным ОЗ от Ярости»: нового
// всплеска ОЗ от действия Ярость не получить. Признак — slug эффекта: им пользуются все ярости (барбарские инстинкты, «Ярость» NPC — через selfEffect).
// Остальное, чего нет в pf2e (урон, ВОЗ, скорость, удары инстинкта pf2e считает сам по self:effect:rage):
// - карточка «Ярость»/«Вспыльчивость» (self-effect) — эффект вешается сам, если выполнены требования (не в ярости, не утомлён); иначе шёпот;
// - второй эффект ярости не создаётся (кнопка pf2e «Применить» на карточке после автоприменения);
// - инициатива с «Вспыльчивостью» — шёпот с кнопкой (свободное действие по желанию игрока);
// - конец ярости: потеря сознания и конец боя (минуту отсчитывает pf2e);
// - действие с «концентрацией» без «ярости» в ярости (кроме Поиска) — шёпот-предупреждение.
import { L, MOD, queue } from "../util.mjs";
import { addEffect, cardButton, esc, paHas, whisper } from "./lib.mjs";

export const RAGE_SLUG = "effect-rage", KEY = "rage-immunity";
export const IMMUNITY = "Compendium.pf2e.feat-effects.Item.MaepXeSHiMoWDm7u";
export const RAGE = "Compendium.pf2e.feat-effects.Item.z3uyCMBddrPK5umr";
const STARTERS = new Set(["rage", "quick-tempered"]);
const USE_TYPES = new Set([undefined, "self-effect", "spell-cast", "skill-check", "perception-check"]);   // использование, не бросок атаки/урона

/** Чистая: удалённый предмет — эффект «Ярость». */
export const isRage = (item) => item?.type === "effect" && item.slug === RAGE_SLUG;
const raging = (actor) => !!actor?.itemTypes?.effect.some(isRage);

/** Чистая: почему нельзя впасть в ярость -> "raging" | "fatigued" | null. */
export const blockedBy = ({ raging, fatigued }) => (raging ? "raging" : fatigued ? "fatigued" : null);

/** Чистая: «Вспыльчивость» доступна при инициативе — не нагружен и без тяжёлой брони (или «Неуязвимый яростный»), как Note pf2e. */
export const quickTempered = ({ encumbered, heavy, invulnerable }) => !encumbered && (!heavy || invulnerable);

/** Чистая: использование нарушает ярость — «концентрация» без «ярости»; Поиск разрешён, сама Ярость проверяется требованиями. */
export const breaksRage = ({ type, traits, slug }) => USE_TYPES.has(type) && traits.includes("concentrate") && !traits.includes("rage") && slug !== "seek" && !STARTERS.has(slug);

const blocked = (actor) => blockedBy({ raging: raging(actor), fatigued: !!actor.hasCondition?.("fatigued") });

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

/** preCreateItem у любого клиента: false — второй эффект ярости не создаётся. */
export const preCreate = (item) => !(isRage(item) && raging(item.parent));

/** Снять ярость (deleteItem -> иммунитет к ВОЗ). */
const endRage = (actor) => queue(`actor:${actor.uuid}`, async () => {
  for (const e of actor.itemTypes.effect.filter(isRage)) await e.delete();
});

/** createItem у ведущего: «Без сознания» прекращает ярость. */
export async function onCreate(item) {
  if (item.type === "condition" && item.slug === "unconscious" && raging(item.actor) && !paHas("rage")) await endRage(item.actor);
}

/** Конец боя (сцены) прекращает ярость участников. */
export async function onCombatEnd(combat) {
  if (paHas("rage")) return;
  for (const c of combat.combatants) if (raging(c.actor)) await endRage(c.actor);
}

async function enter(actor, item, token) {
  const why = blocked(actor);
  if (why) return void await whisper(actor, L(`builtin.rage.${why}`, { name: esc(actor.name) }), "rage");
  const src = (await fromUuid(RAGE))?.toObject();
  if (!src) return;
  delete src._id;
  const at = { actor: actor.uuid, token: token?.uuid ?? null };
  src.system.context = { origin: { ...at, item: item.uuid, spellcasting: null, rollOptions: item.getOriginData?.().rollOptions ?? [] }, target: at, roll: null };
  const effect = await addEffect(actor, src, "rage");
  if (!effect) return;
  // ВОЗ вручную: pf2e TempHPRuleElement.onCreate резолвит @actor.flags.system.rageTempHP до того,
  // как ActiveEffectLike (phase: beforeDerived) его выставляет — порядок вычисления правил.
  // tempSource = id эффекта, чтобы TempHPRuleElement.onDelete сбросил ВОЗ при удалении.
  const tempHP = (actor.level ?? 0) + (actor.system.abilities.con.mod ?? 0);
  if (tempHP > 0 && tempHP > (actor.system.attributes.hp.temp ?? 0)) {
    await actor.update({ "system.attributes.hp.temp": tempHP, "system.attributes.hp.tempSource": effect.id });
  }
}

/** Сообщения чата у ведущего: карточка Ярости, инициатива, использование с концентрацией. */
export async function onMessage(message) {
  const actor = message.actor, ctx = message.flags?.pf2e?.context;
  if (!actor || paHas("rage")) return;
  if (ctx?.type === "self-effect") {
    const item = actor.items.get(ctx.item);
    if (STARTERS.has(item?.slug)) return enter(actor, item, message.token);
  }
  if (ctx?.type === "initiative") {
    const qt = actor.itemTypes?.action.find((i) => i.slug === "quick-tempered");
    if (!qt || blocked(actor)) return;
    if (!quickTempered({ encumbered: !!actor.hasCondition?.("encumbered"), heavy: actor.wornArmor?.category === "heavy", invulnerable: actor.items.some((i) => i.slug === "invulnerable-rager") })) return;
    return void await whisper(actor, L("builtin.rage.quick", { name: esc(actor.name) }), "rage", {}, cardButton(`data-af-rage="${qt.uuid}"`, L("builtin.rage.button")));
  }
  if (!raging(actor)) return;
  const item = message.item, opts = ctx?.options ?? [];
  const traits = [...(item?.system?.traits?.value ?? []), ...(ctx?.traits ?? []).map((t) => t?.name ?? t)];
  const slug = item?.slug ?? opts.find((o) => o.startsWith("action:"))?.slice(7);
  if (breaksRage({ type: ctx?.type, traits, slug })) await whisper(actor, L("builtin.rage.concentrate", { name: esc(actor.name), what: esc(item?.name ?? game.i18n.localize(game.pf2e?.actions?.get(slug)?.name ?? slug ?? "")) }), "rage");
}

/** Кнопка «Впасть в ярость» в шёпоте: у нажавшего — действие «Вспыльчивость» pf2e (карточка self-effect, эффект вешает ведущий). */
export function bind(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  root?.querySelectorAll?.("[data-af-rage]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    await game.pf2e.rollItemMacro(b.dataset.afRage);
  }));
}
