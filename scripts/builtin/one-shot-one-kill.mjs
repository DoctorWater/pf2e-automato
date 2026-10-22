// «Один выстрел, один труп»: DamageDice действия в pf2e срабатывает по опции `one-shot-one-kill`. Переключатель на листе нам не нужен:
// 1) миграция убирает у действия toggleable RollOption; 2) после инициативы Скрытностью вешаем на актёра эффект с тем же RollOption
// (не toggleable); 3) эффект снимается после первого броска урона огнестрелом/арбалетом и по концу боя.
// Штатного способа скрыть переключатель без правки предмета нет (RollOptionRuleElement показывает его при любом toggleable и пройденном предикате).
// Всё делает активный ГМ (по сообщениям чата, в т.ч. от игрока) — сокет не нужен.
import { L, MOD, queue } from "../util.mjs";
import { addEffect, effectSource, esc, whisper } from "./lib.mjs";

export const SLUG = "one-shot-one-kill";
const DOMAIN = "strike-damage";
const GUN_OPTIONS = ["item:group:firearm", "item:group:crossbow"];
const UNLIMITED = { value: -1, unit: "unlimited" };

/** Чистая: сообщение pf2e -> "on" (инициатива Скрытностью) | "off" (урон Удара огнестрелом/арбалетом при активном эффекте) | null. */
export function classify(ctx) {
  const opts = ctx?.options ?? [];
  if (ctx?.type === "initiative") return opts.includes("check:statistic:base:stealth") ? "on" : null;
  if (ctx?.type === "damage-roll" && opts.includes(SLUG) && GUN_OPTIONS.some((o) => opts.includes(o))) return "off";
  return null;
}

/** Чистая: правила без toggleable RollOption этой опции. -> { rules, changed }. */
export function stripToggle(rules = []) {
  const kept = rules.filter((r) => !(r?.key === "RollOption" && r.option === SLUG && r.toggleable));
  return { rules: kept, changed: kept.length !== rules.length };
}

const itemOf = (actor) => actor?.items.find((i) => i.slug === SLUG && i.type !== "effect");
const effectOf = (actor) => actor.items.find((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === SLUG);
// Снятие — в той же очереди актёра, что и создание (addEffect); эффект ищем уже внутри очереди — к тому времени его мог удалить предыдущий вызов.
const removeEffect = (actor) => queue(`actor:${actor.uuid}`, async () => { await effectOf(actor)?.delete(); });

export async function migrateItem(item) {
  if (item?.slug !== SLUG || item.type === "effect") return;
  const { rules, changed } = stripToggle(item._source?.system?.rules ?? item.system.rules);
  if (changed) await item.update({ "system.rules": rules });
}

export async function migrateAll() {
  const actors = [...game.actors, ...game.scenes.contents.flatMap((s) => s.tokens.filter((t) => !t.actorLink).map((t) => t.actor))];
  for (const a of actors) for (const i of a?.items ?? []) await migrateItem(i);
}

export async function onMessage(message) {
  const mode = classify(message.flags?.pf2e?.context);
  const actor = mode && message.actor;
  if (!itemOf(actor)) return;
  if (mode === "off") return void await removeEffect(actor);
  if (effectOf(actor)) return;   // повтор сообщения
  const created = await addEffect(actor, effectSource({
    name: L("builtin.oneShot.effect"), duration: UNLIMITED, img: itemOf(actor).img,
    rules: [{ key: "RollOption", domain: DOMAIN, option: SLUG }],
    origin: { actor: actor.uuid, item: itemOf(actor).uuid }
  }), SLUG);
  if (created) await whisper(actor, L("builtin.oneShot.hint", { name: esc(actor.name) }), SLUG);
}

/** Конец боя: снять эффект у всех участников. */
export async function onCombatEnd(combat) {
  for (const c of combat.combatants) if (c.actor) await removeEffect(c.actor);
}
