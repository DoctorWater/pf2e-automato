// Нехватка воздуха. pf2e ведёт эффект «Оставшийся воздух» (other-effects.2u26b…, счётчик раундов; уменьшает его игрок/ведущий правым кликом) и ничего
// не делает, когда воздух кончился. Здесь: воздух кончился -> «Удушье» (счётчик проверок) и «Без сознания»; в конце хода — испытание Стойкости
// со СЛ 20+5·(n−1): крит. провал — смерть, провал — n d10 урона, счётчик растёт. Признак — slug эффекта, а не источник: Поглощение, Проглатывание
// и всё, что выдаст «Оставшийся воздух». Смерть не применяем (необратима, решает ведущий): карточка, проверки прекращаются, «Без сознания» остаётся.
// Освободился из проглотившего (эффект-хозяин удалён) — дышит сразу: «Удушье» и «Без сознания» от него снимаются.
// Воздух кончился: pf2e (_preUpdate эффекта) на счётчике ниже минимума (min ?? 1) удаляет эффект и отменяет обновление, поэтому updateItem со значением 0
// не приходит. Признак — удаление эффекта со счётчиком 1, пока хозяин ещё на актёре; при Освобождении хозяин уходит вместе с ним (один пакет удаления).
import { L, MOD, queue, degreeFromTotal } from "../util.mjs";
import { settledDegree } from "../hold.mjs";
import { addEffect, addCondition, effectSource, whisper, whisperDC, esc, paHas } from "./lib.mjs";

export const AIR_SLUG = "effect-remaining-air", SUFFOCATING_SLUG = "effect-suffocating", KEY = "suffocating";
const PA_GROUP = "swallow-whole";   // группа pf2e-automations с обработчиками deleteHoldingBreath / suffocatingEndTurn

/**
 * Чистая: воздух кончился. air — удалённый предмет { slug, system.badge.value, flags.pf2e.grantedBy.id }, hasItem(id) — предмет ещё на актёре.
 * Удаление со счётчиком 1 — последний раунд воздуха вычеркнут; хозяина нет на актёре — его удалили вместе с эффектом (Освобождение).
 */
export function airRanOut(air, hasItem) {
  if (air?.slug !== AIR_SLUG || air.system?.badge?.value !== 1) return false;
  const host = air.flags?.pf2e?.grantedBy?.id;
  return !host || hasItem(host);
}

/** Чистая: СЛ n-й проверки (n — значение счётчика «Удушья», с 1). */
export const suffocationDC = (n) => 20 + 5 * (Math.max(1, n) - 1);

/** Чистая: степень Стойкости (0..3) -> { dead } | { dice } | {} (успех — ничего). */
export function suffocationOutcome(degree, n) {
  if (degree === 0) return { dead: true };
  return degree === 1 ? { dice: Math.max(1, n) } : {};
}

/** deleteItem у активного ведущего: воздух кончился -> удушье; удалён хозяин «Оставшегося воздуха» -> удушье от него снимается. */
export async function onDelete(item) {
  const actor = item.actor;
  if (!actor || paHas(PA_GROUP)) return;
  const mine = actor.itemTypes.effect.filter((e) => e.slug === SUFFOCATING_SLUG && e.flags?.[MOD]?.suffocation?.host === item.id);
  if (mine.length) {
    const { removeByKey } = await import("../apply.mjs");
    return void await removeByKey(actor, KEY);
  }
  if (!airRanOut(item, (id) => actor.items.has(id))) return;
  const eff = effectSource({
    name: L("builtin.suffocation.effect"), description: `<p>${L("builtin.suffocation.hint")}</p>`,
    duration: { value: -1, unit: "unlimited", expiry: null }, origin: { actor: actor.uuid }, target: { actor: actor.uuid }
  });
  eff.system.slug = SUFFOCATING_SLUG;
  eff.system.badge = { type: "counter", value: 1 };
  eff.flags = { [MOD]: { suffocation: { host: item.flags?.pf2e?.grantedBy?.id ?? null } } };
  if (!await addEffect(actor, eff, KEY)) return;
  await addCondition(actor, { slug: "unconscious" }, `${KEY}:unconscious`);
  await whisperDC(actor, "builtin.suffocation.start", { name: esc(actor.name) }, suffocationDC(1), "suffocation");
}

/** Конец хода (pf2e.endTurn, только у активного ведущего): проверка «Удушья». */
export async function onEndTurn(combatant) {
  const actor = combatant?.actor;
  if (!actor || paHas(PA_GROUP)) return;
  await queue(`actor:${actor.uuid}`, async () => {
    const eff = actor.itemTypes.effect.find((e) => e.slug === SUFFOCATING_SLUG);
    if (!eff) return;
    const n = eff.system.badge?.value ?? 1, dc = suffocationDC(n), token = combatant.token ?? actor.getActiveTokens(true, true)[0];
    let msg = null;
    const roll = await actor.saves.fortitude.check.roll({ dc: { value: dc }, token, extraRollOptions: ["suffocating"], skipDialog: true, callback: (_r, _o, m) => { msg = m; } });
    if (!roll) return;   // бросок отменён — проверка не засчитана
    const first = roll.degreeOfSuccess ?? degreeFromTotal(roll.total, dc, roll.dice?.[0]?.results?.find((r) => r.active && !r.discarded)?.result ?? null);
    // удержан ради переброса (hold.mjs) — ждём итог; очередь актёра на это время занята (до HOLD_WAIT_MS), другого пути применения нет
    const out = suffocationOutcome(await settledDegree(msg, first), n);
    if (out.dead) {
      await eff.delete();   // проверок больше нет; «Без сознания» — отдельное состояние и остаётся
      return void await whisper(actor, L("builtin.suffocation.dead", { name: esc(actor.name) }), "suffocation");
    }
    if (out.dice) {
      // обычный бросок без карточки урона pf2e: урон применяется здесь же, кнопки «применить» не нужно
      const dmg = await new Roll(`${out.dice}d10`).evaluate();
      await dmg.toMessage({ speaker: ChatMessage.getSpeaker({ actor, token }), flavor: L("builtin.suffocation.damage") });
      if (token) await actor.applyDamage({ damage: dmg.total, token });
    }
    await eff.increase();
  });
}
