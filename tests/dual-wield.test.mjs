import test from "node:test";
import assert from "node:assert/strict";
import { showDualItem, isDual, isPair, staleFlagPatch, withoutTwoHandGrip } from "../scripts/builtin/dual-wield.mjs";
import { twoWeaponCandidates } from "../scripts/builtin/strikes.mjs";

const wp = (o = {}) => ({
  id: o.id ?? "w", isOfType: (t) => t === (o.type ?? "weapon"), isMelee: true,
  flags: o.dual ? { "pf2e-automato": { dual: true } } : {},
  system: { quantity: o.qty ?? 2, usage: { hands: o.usage ?? 1 }, traits: { value: o.traits ?? [] }, equipped: { carryType: o.carry ?? "held", handsHeld: o.hands ?? 2 } },
});

test("showDualItem: стопка одноручного оружия", () => {
  assert.equal(showDualItem(wp()), true);
  assert.equal(showDualItem(wp({ qty: 1 })), false);
  assert.equal(showDualItem(wp({ usage: 2 })), false);
  assert.equal(showDualItem(wp({ type: "armor" })), false);
});

test("isDual: флаг + две руки; устаревший флаг не считается", () => {
  assert.equal(isDual(wp({ dual: true })), true);
  assert.equal(isDual(wp()), false);
  assert.equal(isDual(wp({ dual: true, hands: 1 })), false);
  assert.equal(isDual(wp({ dual: true, carry: "worn" })), false);
});

test("twoWeaponCandidates: флаг dual даёт пару даже с two-hand-*, без флага двуручный хват — одно оружие", () => {
  const th = ["two-hand-d8"];
  assert.equal(twoWeaponCandidates([{ item: wp({ dual: true, traits: th }) }]).length, 2);
  assert.equal(twoWeaponCandidates([{ item: wp({ traits: th }) }]).length, 0);
  assert.equal(twoWeaponCandidates([{ item: wp() }]).length, 2);
  assert.equal(twoWeaponCandidates([{ item: wp({ hands: 1, traits: th }) }]).length, 2);
  assert.equal(isPair(wp({ qty: 1, dual: true })), false);
});

test("fatal-aim и isDual при quantity 1", () => {
  assert.equal(showDualItem(wp({ traits: ["fatal-aim-d12"] })), false);
  assert.equal(isDual(wp({ dual: true, qty: 1 })), false);
});

test("staleFlagPatch: смена хвата без флага в изменениях снимает флаг", () => {
  const del = (p) => ({ del: p });
  const d = wp({ dual: true });
  assert.deepEqual(staleFlagPatch(d, { system: { equipped: { handsHeld: 1 } } }, del), { del: "flags.pf2e-automato.dual" });
  assert.deepEqual(staleFlagPatch(d, { "system.equipped.carryType": "worn" }, del), { del: "flags.pf2e-automato.dual" });
  assert.equal(staleFlagPatch(d, { system: { equipped: { handsHeld: 2 } }, flags: { "pf2e-automato": { dual: true } } }, del), null);
  assert.equal(staleFlagPatch(d, { system: { quantity: 3 } }, del), null);
  assert.equal(staleFlagPatch(wp(), { system: { equipped: { handsHeld: 1 } } }, del), null);
});

test("withoutTwoHandGrip: убирает «взяться двумя руками», «отпустить» остаётся", () => {
  const list = [{ action: "interact", annotation: "grip", hands: 2 }, { action: "release", annotation: "grip", hands: 1 }, { action: "release", annotation: "drop", hands: 0 }];
  assert.deepEqual(withoutTwoHandGrip(list).map((x) => x.action + x.hands), ["release1", "release0"]);
});
