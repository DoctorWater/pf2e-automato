// «Щит прикрывает союзника». Блок щитом у pf2e считается по щиту самой цели (attributes.shield в applyDamage), прикрыть чужого он не умеет, поэтому:
// 1) COVER — черты, дающие Блок щитом за союзника в досягаемости (Щитоносец, Страж Ластволла, Стойка кенотафа и копии NPC): к шёпоту «Блок щитом» (shield-block.mjs)
//    добавляется подсказка держателю; по кнопке урон применяется к союзнику с подменой щита на щит держателя, а урон щиту записывается держателю.
// 2) GUARD — Преданный страж: союзнику +1/+2 круговой бонус к КЗ, пока щит держателя поднят (предикат pf2e parent:origin:shield:raised).
// У pf2e в данных этих черт правил нет, только текст: таблица COVER (slug -> дистанция, физический урон, стойка) выводится из текста паков
// инструментом tools/ward-cover.mjs в ward-cover.data.mjs — перечня руками нет; не берётся то, что по slug не различить (COVER_DEBT: скакун, общий slug).
import { L, MOD, queue } from "../util.mjs";
import { esc, whisper, cardButton, paHas, heldSlug, itemSlug, effectSource, addEffect, messageTargets, worldActors } from "./lib.mjs";
import { COVER } from "./ward-cover.data.mjs";
import * as channeling from "./channeling-block.mjs";

export { COVER };
export const GUARD = new Set(["devoted-guardian"]);
export const PHYSICAL = new Set(["bludgeoning", "piercing", "slashing"]);
export const GUARD_EFFECT_SLUG = "effect-devoted-guardian", GUARD_KEY = "devoted-guardian";

/** Чистая: типы урона броска карточки (DamageRoll#instances) -> [тип] | null, если не видно. */
export const damageTypes = (message) => {
  const inst = message?.rolls?.[0]?.instances;
  return inst?.length ? [...inst].map((i) => i.type).filter(Boolean) : null;
};

/** Чистая: держатель может прикрыть цель. c: {entry, raised, hp, reaction, distance, types, stance, attack}. Обычный Блок — только от атаки; черта «от физического урона» (стойка кенотафа) — от любого физического. */
export function canCover({ entry, raised, hp, reaction, distance, types, stance, attack = true }) {
  if (!entry || !raised || !(hp > 0) || !reaction || !(distance <= entry.feet)) return false;
  if (entry.stance && !stance) return false;
  if (!entry.physical) return attack;
  return !types || types.some((t) => PHYSICAL.has(t));
}

/** Чистая: щит держателя вместо щита цели — копия данных attributes.shield (имя, твёрдость, id предмета держателя: pf2e по нему не тронет щит цели). */
export const wardShield = (shield, nonce = Math.random().toString(36).slice(2, 8)) => ({ ...shield, itemId: `af-ward:${nonce}:${shield?.itemId}`, hp: { ...shield?.hp } });

/** Чистая: настоящий id щита держателя из подменённого itemId. По фиктивному id ловится именно наше сообщение (у несвязанных токенов одного NPC id предметов совпадают). */
export const realShieldId = (id) => String(id ?? "").replace(/^af-ward:[^:]+:/, "");
// Откат pf2e на сообщении цели щит держателя не восстанавливает — ограничение: ОЗ щита вернуть вручную.

/** Чистая: сколько урона получил щит с этим id по сообщению «damage-taken» pf2e (null — сообщение не о нём). */
export function shieldDamage(message, shieldId) {
  if (message?.flags?.pf2e?.context?.type !== "damage-taken") return null;
  const s = message.flags.pf2e.appliedDamage?.shield;
  return s?.id === shieldId ? s.damage : null;
}

/** Подсказки держателям: токены сцены с чертой из COVER, достающие до прикрываемой цели. deps — функции shield-block.mjs (цикл импорта не нужен). */
export async function guardHints(message, token, { raisedShield, reactionAvailable, attack }) {
  const ally = token.actor, types = damageTypes(message);
  for (const t of canvas?.tokens?.placeables ?? []) {
    const guard = t.actor;
    if (!guard || guard.uuid === ally.uuid || !guard.isAllyOf?.(ally) || !token.object) continue;
    const slug = heldSlug(guard, Object.keys(COVER));
    if (!slug || paHas(slug)) continue;
    const shield = raisedShield(guard.attributes?.shield), entry = COVER[slug];
    if (!shield || !canCover({ entry, raised: true, hp: guard.hitPoints?.value, reaction: reactionAvailable(guard), distance: t.distanceTo(token.object), types, attack, stance: !entry.stance || guard.itemTypes.effect.some((e) => e.slug === entry.stance) })) continue;
    await whisper(guard, L("builtin.ward.hint", { guard: esc(guard.name), ally: esc(ally.name), hardness: shield.hardness }),
      "shield-block", { shieldBlock: { message: message.id, token: token.uuid, actor: ally.uuid, guard: guard.uuid, used: false } },
      cardButton("data-af-shield-block", L("builtin.ward.button")) + channeling.buttons(guard));
  }
}

/** Слушатель урона щита держателя: вызвать ДО applyDamage, затем await result(). Сообщение pf2e создаётся внутри applyDamage; на всякий случай — таймаут. */
export function watchShieldDamage(shieldId, ms = 3000) {
  let hook, timer;
  const p = new Promise((res) => {
    hook = (m) => { const n = shieldDamage(m, shieldId); if (n !== null) res(n); };
    Hooks.on("createChatMessage", hook);
    timer = setTimeout(() => res(0), ms);
  });
  return { result: () => p.finally(() => { Hooks.off("createChatMessage", hook); clearTimeout(timer); }) };
}

/** Урон щиту держателя (его щит, не щит прикрытого). */
export const damageHolderShield = (guard, shieldId, n) => queue(`actor:${guard.uuid}`, async () => {
  const shield = guard.items.get(realShieldId(shieldId));
  if (n > 0 && shield) await shield.update({ "system.hp.value": Math.max(0, shield._source.system.hp.value - n) });
});

/** Чистая: бонус Преданного стража — +2 с башенным щитом, иначе +1. */
export const guardBonus = (baseItem) => (baseItem === "tower-shield" ? 2 : 1);   // system.baseItem, а не slug: у именного щита slug свой

/** Чистая: эффект-подопечный (правила). */
export const guardRules = (bonus, label) => [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: bonus, label, predicate: ["parent:origin:shield:raised"] }];

/** Сообщение-использование Преданного стража (ведущий): подопечный — цель автора; прежний подопечный теряет бонус (подопечный один). */
export async function onMessage(message) {
  const item = message.flags?.pf2e?.origin?.type ? message.item : null, actor = item?.actor, slug = itemSlug(item);
  if (!actor || !GUARD.has(slug) || paHas(slug)) return;
  const ward = messageTargets(message)[0];
  if (!ward?.actor || ward.actor.uuid === actor.uuid) return void ui.notifications.warn(L("builtin.ward.needTarget", { name: actor.name }));
  const shield = actor.attributes?.shield;
  if (!shield?.raised) return void ui.notifications.warn(L("builtin.ward.needShield", { name: actor.name }));
  const mine = actor.getActiveTokens?.()?.[0], theirs = ward.object ?? ward.actor.getActiveTokens?.()?.[0];
  if (mine && theirs && mine.distanceTo(theirs) > 5) return void ui.notifications.warn(L("builtin.ward.needAdjacent", { name: actor.name }));   // «выберите смежное существо»
  for (const a of worldActors()) {
    const old = a.items.find((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key?.startsWith(`${GUARD_KEY}:${actor.uuid}:`));
    if (old) await queue(`actor:${a.uuid}`, async () => { await old.delete(); });
  }
  const sp = message.speaker ?? {};
  const src = effectSource({
    name: L("builtin.ward.guardianEffect", { name: actor.name }), description: `<p>${L("builtin.ward.guardianText", { name: esc(actor.name) })}</p>`,
    duration: { value: 1, unit: "rounds", expiry: "turn-start" }, img: item.img,   // создан на ходу стража: кончается в начале его следующего хода (pf2e считает от инициативы создателя)
    origin: { actor: actor.uuid, token: sp.scene && sp.token ? `Scene.${sp.scene}.Token.${sp.token}` : null, item: item.uuid }, target: { actor: ward.actor.uuid }
  });
  src.system.slug = GUARD_EFFECT_SLUG;
  src.system.rules = guardRules(guardBonus(actor.items.get(shield.itemId)?.system?.baseItem), L("builtin.ward.guardianLabel"));
  await addEffect(ward.actor, src, `${GUARD_KEY}:${actor.uuid}:${ward.actor.uuid}`);
}
