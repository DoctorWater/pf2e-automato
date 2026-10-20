// Танец клинков (агенты Львиных Клинков): два Удара разными клинками по одной цели, текущий MAP на оба (после — как две атаки);
// если оба попали — цель застигнута врасплох до начала следующего хода агента. Урон — отдельными бросками.
import { L } from "../util.mjs";
import { COND, addEffect, effectSource, grantCondition, whisper } from "./lib.mjs";
import { isHit, meleeCandidates, askStrikes, rollStrike, rollDamage, mapLabel } from "./strikes.mjs";

/** Чистая: оба ли Удара попали. */
export const bothHit = (d1, d2) => d1 != null && d2 != null && isHit(d1) && isHit(d2);

export async function run(scope) {
  const actor = scope.actor, target = scope.targets?.length === 1 ? scope.targets[0] : null, name = scope.item?.name ?? "";
  if (!target?.actor) return void ui.notifications.warn(L("builtin.needOneTarget", { name }));
  // в статблоке NPC «клинки» часто одной строкой Удара — тогда оба Удара этой строкой
  const melee = meleeCandidates(actor?.system?.actions ?? []);
  if (!melee.length) return void ui.notifications.warn(L("builtin.blade.noWeapons", { name }));
  const cands = melee.length === 1 ? [melee[0], melee[0]] : melee;
  const setup = await askStrikes(cands, 2, { title: name, picks: [L("builtin.double.first"), L("builtin.double.second")], map: L("builtin.double.map") });
  if (!setup) return;
  const [w1, w2] = setup.picks;
  if (w1 === w2) return void ui.notifications.warn(L("builtin.double.sameWeapon", { name }));
  const degrees = [];
  for (const s of [cands[w1], cands[w2]]) {
    const { degree } = await rollStrike(actor, s, setup.map, target);
    if (degree == null) return;   // бросок отменён
    degrees.push(degree);
    if (degree != null && isHit(degree)) await rollDamage(actor, s, setup.map, target, degree === 3);
  }
  if (bothHit(...degrees)) {
    const token = scope.token ?? actor.getActiveTokens(false, true)[0];
    const src = effectSource({ name: L("builtin.blade.effect", { name }), duration: { value: 1, unit: "rounds", expiry: "turn-start" },
      origin: { actor: actor.uuid, token: token?.uuid, item: scope.item?.uuid }, target: { actor: target.actor.uuid, token: target.uuid },
      rules: [grantCondition(COND.offGuard)] });
    await addEffect(target.actor, src, `${scope.message?.id ?? "live"}:${target.id}:blade-dance`);
  }
  await whisper(actor, L("builtin.double.next", { name, map: mapLabel(cands[w1], Math.min(2, setup.map + 2)) }), "blade-dance");
}
