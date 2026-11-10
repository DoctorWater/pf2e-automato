// «Духовная связь» (Spirit Link, заклинание + копии NPC): при сотворении и в начале каждого хода заклинателя цель, чьи ПЗ ниже максимума, получает 2 ПЗ
// (+2 за ранг выше первого), заклинатель теряет столько же. Это НЕ перенос урона: отдельный обработчик со своим slug эффекта. Эффект нельзя класть в LINKS
// damage-link.mjs — BY_EFFECT/linksOf подхватили бы его, и reduction разделил бы весь урон цели пополам (tests/builtin.spirit-link.test.mjs).
// Запись ПЗ прямая (текст: без сопротивлений, без модификаторов лечения, мимо временных ПЗ — applyDamage/applyHealing pf2e это нарушили бы).
// Заклинатель на 0 ПЗ: связь кончается ДО переноса. Дошёл до 0 переносом — связь снимается, состояния (без сознания, умирание) pf2e при прямой записи не ставит: шёпот ГМу.
// ДОЛГ: «без регенерации и быстрого лечения заклинателя на время действия» не автоматизируется (нет Rule Element у копий).
import { L, queue } from "../util.mjs";
import { castOrigin, effectSource, addEffect, esc, whisper, paHas, messageTargets, itemSlug } from "./lib.mjs";
import { spellDuration } from "./damage-link.mjs";
import { kindOf } from "./spellshape.mjs";

export const SLUG = "spirit-link", EFFECT = "effect-spirit-link";

/** Чистая: шаг связи. -> {end} (заклинатель на 0 ПЗ: связь кончилась, переноса нет) | {skip} (мёртвая цель, цель на максимуме) | {n, zero} (перенести n; zero — заклинатель дойдёт до 0). */
export function plan({ rank, casterHp, targetHp, targetMax, targetDead }) {
  if (!(casterHp > 0)) return { end: true };
  const n = Math.min(2 * Math.max(1, rank - 1), targetMax - targetHp);   // базовый 2-й ранг — 2 ПЗ, «Повышенное (+1): +2»
  if (targetDead || !(n > 0)) return { skip: true };
  return { n, zero: casterHp - n <= 0 };
}

const hpOf = (a) => a.system?.attributes?.hp ?? { value: 0, max: 0 };
/** Мёртв: статус dead (у NPC pf2e это статус, не состояние) или состояние dead; NPC на 0 ПЗ мёртв по правилам (умирающего героя на 0 связь лечит законно). */
export const isDead = (a, hp) => !!(a?.statuses?.has?.("dead") || a?.hasCondition?.("dead") || (a?.type !== "character" && !(hp > 0)));

/** Один перенос: эффект effect на цели target, заклинатель caster. */
async function step(caster, target, effect) {
  const c = hpOf(caster), t = hpOf(target), name = esc(effect.name);
  const p = plan({ rank: effect.system?.level?.value ?? 1, casterHp: c.value, targetHp: t.value, targetMax: t.max, targetDead: isDead(target, t.value) });
  const vars = { spell: name, caster: esc(caster.name), target: esc(target.name) };
  if (p.end) { await effect.delete(); return void (await whisper(caster, L("builtin.link.spiritEnd", vars), "damage-link", {}, "", "gm")); }
  if (p.skip) return;
  await target.update({ "system.attributes.hp.value": t.value + p.n });
  await caster.update({ "system.attributes.hp.value": Math.max(0, c.value - p.n) });
  await whisper(target, L("builtin.link.spiritCard", { ...vars, n: p.n }), "damage-link");
  if (p.zero) { await effect.delete(); await whisper(caster, L("builtin.link.spiritEnd", vars), "damage-link", {}, "", "gm"); }
}

/** Сотворение (активный ведущий): эффект на цели (повторное сотворение заменяет прежний) и первый перенос сразу. */
export async function onMessage(message) {
  const origin = castOrigin(message);
  if (kindOf(origin) !== "cast") return;   // настоящее сотворение, не карточка «в чат»
  const spell = await fromUuid(origin.uuid);
  if (itemSlug(spell) !== SLUG || paHas(SLUG)) return;
  const caster = await fromUuid(origin.actor);
  if (!caster) return;
  const rank = message.flags?.pf2e?.origin?.castRank ?? spell.rank ?? 1;
  const [t] = messageTargets(message).filter((x) => x.actor.uuid !== caster.uuid);
  if (!t) return void ui.notifications.warn(L("builtin.link.needTarget", { name: caster.name }));
  const sp = message.speaker ?? {}, { removeByKey } = await import("../apply.mjs"), key = `link:${caster.uuid}:${EFFECT}`;
  await queue(`actor:${caster.uuid}`, async () => {
    await removeByKey(t.actor, key);
    const src = effectSource({
      name: L("builtin.link.effect", { name: spell.name }), description: `<p>${L("builtin.link.spiritLink", { name: esc(caster.name), spell: esc(spell.name) })}</p>`, img: spell.img,
      duration: { sustained: false, ...(spellDuration(spell.system?.duration?.value) ?? { value: -1, unit: "unlimited" }), expiry: "turn-start" },
      origin: { actor: caster.uuid, token: sp.scene && sp.token ? `Scene.${sp.scene}.Token.${sp.token}` : null, item: spell.uuid }, target: { actor: t.actor.uuid, token: t.uuid }
    });
    src.system.slug = EFFECT;
    src.system.level = { value: rank };
    const effect = await addEffect(t.actor, src, key);
    if (effect) await step(caster, t.actor, effect);
  });
}

/** Начало хода (pf2e.startTurn, исполняет лидер ведущего): все связи этого заклинателя. */
export async function onStartTurn(combatant) {
  const caster = combatant?.actor;
  if (!caster) return;
  await queue(`actor:${caster.uuid}`, async () => {
    // не весь мир: актёры мира (связанные токены) и токены сцены заклинателя (несвязанные копии NPC)
    const scene = combatant.token?.parent ?? combatant.scene;
    for (const a of new Set([...game.actors, ...[...(scene?.tokens ?? [])].map((t) => t.actor).filter(Boolean)])) {
      for (const e of a.itemTypes?.effect ?? []) {
        if (e.slug !== EFFECT || e.system?.context?.origin?.actor !== caster.uuid || a.uuid === caster.uuid) continue;
        await step(caster, a, e).catch((err) => console.error("pf2e-automato | spirit-link", err));
      }
    }
  });
}
