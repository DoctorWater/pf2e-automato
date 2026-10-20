// Устрашающий удар: «Совершите Удар в ближнем бою; при попадании и уроне цель испугана 1 (крит. — 2)». Удар входит в действие —
// модуль бросает его сам (диалог: оружие и MAP), при попадании — урон; испуг ставит ГМ (finish), т.к. бросать может игрок.
// ponytail: «нанёс урон» = бросок урона > 0 (сопротивление цели не учитывается); невосприимчивость к чертам черты — проверяется.
import { L } from "../util.mjs";
import { addCondition } from "./lib.mjs";
import { immuneToTraits } from "../apply.mjs";
import { isHit, meleeCandidates, askStrikes, rollStrike, rollDamage } from "./strikes.mjs";

/** Чистая: степень атаки и сумма урона -> значение испуга или 0. */
export const frightenFor = (degree, damage) => (degree != null && isHit(degree) && damage > 0 ? (degree === 3 ? 2 : 1) : 0);

export async function run(scope) {
  const actor = scope.actor, target = scope.targets?.length === 1 ? scope.targets[0] : null, name = scope.item?.name ?? "";
  if (!target?.actor) return void ui.notifications.warn(L("builtin.needOneTarget", { name }));
  const cands = meleeCandidates(actor?.system?.actions ?? []);
  if (!cands.length) return void ui.notifications.warn(L("builtin.strike.noMelee", { name }));
  const setup = await askStrikes(cands, 1, { title: name, picks: [L("builtin.strike.weapon")], map: L("builtin.strike.map") });
  if (!setup) return;
  const s = cands[setup.picks[0]];
  const { degree } = await rollStrike(actor, s, setup.map, target);
  if (degree == null || !isHit(degree)) return;
  const dmg = await rollDamage(actor, s, setup.map, target, degree === 3);
  const value = frightenFor(degree, typeof dmg?.total === "number" ? dmg.total : 0);   // окно урона закрыто — урона нет
  return value ? { frighten: value, target: target.uuid } : undefined;
}

/** У активного ГМа после run (возможно, у игрока): испуг цели. */
export async function finish(result, scope) {
  // результат мог прийти с клиента игрока — сверяем с целями снимка ГМа
  if (![1, 2].includes(result?.frighten) || !(scope.targets ?? []).some((t) => t.uuid === result.target)) return;
  const t = await fromUuid(result.target);
  if (!t?.actor || immuneToTraits(t.actor.attributes?.immunities, scope.item?.system?.traits?.value ?? [])) return;
  await addCondition(t.actor, { slug: "frightened", value: result.frighten }, `${scope.message?.id ?? "live"}:intimidating-strike`);
}
