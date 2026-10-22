import { test } from "node:test";
import assert from "node:assert/strict";
import { hasReachSpell, maxRange, farFrom, itemRange, inRange, TENTACLES } from "../scripts/range.mjs";

test("дальность: касание = досягаемость, число, нет дальности", () => {
  assert.equal(maxRange({ max: 5 }, true, []), 5);
  assert.equal(maxRange({ max: 10 }, true, []), 10);
  assert.equal(maxRange({ max: 30 }, false, []), 30);
  assert.equal(maxRange(null, false, []), null);   // planetary / varies
});

test("Дальнее заклинание: +30 фт, касание -> 30 фт", () => {
  const o = ["self:effect:reach-spell"];
  assert.ok(hasReachSpell(o)); assert.ok(!hasReachSpell(["origin:item:spell"]));
  assert.equal(maxRange({ max: 30 }, false, o), 60);
  assert.equal(maxRange({ max: 5 }, true, o), 30);
  assert.equal(maxRange(null, false, o), null);
});

test("farFrom и itemRange", () => {
  assert.deepEqual(farFrom(40, 30), { d: 40, r: 30 });
  assert.equal(farFrom(30, 30), null);
  assert.equal(farFrom(NaN, 30), null);
  assert.equal(farFrom(99, null), null);
  assert.equal(itemRange({ type: "feat" }, []), null);
  assert.equal(itemRange({ type: "spell", isMelee: true, range: { max: 5 } }, []), 5);
});

test("Руки-щупальца: касание — 10 фт, но не меньше собственной досягаемости; Дальнее заклинание сильнее", () => {
  assert.equal(maxRange({ max: 5 }, true, [TENTACLES]), 10);
  assert.equal(maxRange({ max: 15 }, true, [TENTACLES]), 15);
  assert.equal(maxRange(null, true, [TENTACLES]), 10);
  assert.equal(maxRange({ max: 5 }, true, [TENTACLES, "spellshape:reach-spell"]), 30);
  assert.equal(maxRange({ max: 30 }, false, [TENTACLES]), 30);
});

test("inRange: цели без far", () => {
  assert.deepEqual(inRange([{ key: "a" }, { key: "b", far: { d: 40, r: 30 } }]), [{ key: "a" }]);
  assert.deepEqual(inRange(undefined), []);
});
