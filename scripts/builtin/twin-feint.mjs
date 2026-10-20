// X2. Двойной финт: по одному Удару каждым из двух оружий по одной цели, MAP — как обычно (второй на ступень выше);
// цель застигнута врасплох только для второй атаки и её урона (Атака исподтишка). Off-guard — временный эффект на атакующем
// с EphemeralEffect (как у системы для «застигнут врасплох для этой атаки»): цель не трогаем, работает и у игрока.
import { L } from "../util.mjs";
import { COND } from "./lib.mjs";
import { isHit, twoWeaponCandidates, askStrikes, rollStrike, rollDamage } from "./strikes.mjs";

/** Единственная цель или null (по тексту: оба Удара по одной и той же цели). */
export const soleTarget = (targets) => (targets?.length === 1 ? targets[0] : null);

/** Временный эффект на атакующем: бросок атаки и урона Удара видит цель застигнутой врасплох. */
export const secondStrikeEffect = (name) => ({
  type: "effect", name, img: "icons/svg/aura.svg",
  system: { slug: "af-twin-feint-second", rules: [{ key: "EphemeralEffect", selectors: ["strike-attack-roll", "strike-damage"], uuid: COND.offGuard }] }
});

async function strikeWithDamage(actor, s, i, target) {
  const r = await rollStrike(actor, s, i, target);
  if (r.degree != null && isHit(r.degree)) await rollDamage(actor, s, i, target, r.degree === 3);
  return r;
}

export async function run(scope) {
  const actor = scope.actor, target = soleTarget(scope.targets), name = scope.item?.name ?? "";
  if (!target?.actor) return void ui.notifications.warn(L("builtin.needOneTarget", { name }));
  const cands = twoWeaponCandidates(actor?.system?.actions ?? []);
  if (cands.length < 2) return void ui.notifications.warn(L("builtin.double.noWeapons", { name }));
  const setup = await askStrikes(cands, 2, { title: name, picks: [L("builtin.double.first"), L("builtin.double.second")], map: L("builtin.strike.map") });
  if (!setup) return;
  const [w1, w2] = setup.picks;
  if (w1 === w2) return void ui.notifications.warn(L("builtin.double.sameWeapon", { name }));

  if ((await strikeWithDamage(actor, cands[w1], setup.map, target)).degree == null) return;   // бросок отменён
  const [eff] = await actor.createEmbeddedDocuments("Item", [secondStrikeEffect(L("builtin.twin.effect"))]);
  try { await strikeWithDamage(actor, cands[w2], Math.min(2, setup.map + 1), target); }
  finally { await eff?.delete(); }
}
