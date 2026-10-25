import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.game = { user: { isActiveGM: true }, settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k } };
const v = await import("../scripts/builtin/variable-cast.mjs");

test("переменное время -> допустимые числа действий", () => {
  assert.deepEqual(v.actionChoices("1 to 3"), [1, 2, 3]);
  assert.deepEqual(v.actionChoices("1 or 2"), [1, 2]);
  assert.deepEqual(v.actionChoices(" 2 or 3 "), [2, 3]);
  for (const t of ["2", "reaction", "", null, "10 minutes"]) assert.equal(v.actionChoices(t), null);
});

test("снарядов: действия × (1 + по одному за каждые 2 ранга)", () => {
  assert.equal(v.missileCount(3, 1), 3);
  assert.equal(v.missileCount(2, 3), 4);
  assert.equal(v.missileCount(3, 5), 9);
  assert.equal(v.missileCount(1, 2), 1);
});

test("распределение: поровну и проверка суммы", () => {
  assert.deepEqual(v.evenSplit(5, 2), [3, 2]);
  assert.deepEqual(v.evenSplit(3, 3), [1, 1, 1]);
  assert.ok(v.validSplit([2, 1], 3));
  assert.ok(!v.validSplit([2, 2], 3));
  assert.ok(!v.validSplit([-1, 4], 3));
  assert.ok(!v.validSplit([1.5, 1.5], 3));
});

test("формула n снарядов в одну цель: кубики и модификатор умножаются", () => {
  assert.equal(v.scaleFormula("1d4+1", 3), "3d4+3");
  assert.equal(v.scaleFormula("1d4 + 1", 2), "2d4+2");
  assert.equal(v.scaleFormula("1d4", 2), "2d4");
  assert.equal(v.scaleFormula("2d6+1d4", 2), "2d6+1d4 + 2d6+1d4");
});

test("подпись цели: context.target = uuid актёра и токена, во flavor — цель", () => {
  const msg = { flavor: "F", flags: { pf2e: { context: {} } } };
  const p = v.targetPatch(msg, { name: "Орк", uuid: "Scene.s.Token.t", actor: { uuid: "Actor.a" } }, 2);
  assert.deepEqual(p["flags.pf2e.context.target"], { actor: "Actor.a", token: "Scene.s.Token.t" });
  assert.deepEqual(p["flags.pf2e.target"], p["flags.pf2e.context.target"]);
  assert.ok(p.flavor.startsWith("F"));
  assert.equal(v.targetPatch(msg, null, 1), null);
  const tb = v.targetPatch({ flags: { pf2e: { context: {} }, "pf2e-toolbelt": { targetHelper: { targets: ["A", "B"] } } } }, { name: "x", uuid: "B", actor: { uuid: "a" } }, 1);
  assert.deepEqual(tb["flags.pf2e-toolbelt.targetHelper.targets"], ["B"]);
  assert.ok(!("flags.pf2e.context.target" in v.targetPatch({ flags: {} }, { name: "x", uuid: "u", actor: { uuid: "a" } }, 1)));
});

test("asksActions: только сотворение переменного заклинания", () => {
  const CAST = "origin:action:slug:cast-a-spell";
  assert.equal(v.asksActions({ type: "spell", rollOptions: [CAST] }, "1 to 3"), true);
  assert.equal(v.asksActions({ type: "spell", rollOptions: [CAST] }, "2"), false);
  assert.equal(v.asksActions({ type: "spell", rollOptions: [] }, "1 to 3"), false);
  assert.equal(v.asksActions({ type: "feat", rollOptions: [CAST] }, "1 to 3"), false);
  assert.equal(v.asksActions(undefined, "1 to 3"), false);
});
