import test from "node:test";
import assert from "node:assert/strict";
import { COVER, coverToggle, needsReload, isUnloaded, strikeItemId, strikeUsage, reloadGlyph } from "../scripts/hud.mjs";

test("укрытие: поставить, снять, взаимоисключение", () => {
  assert.deepEqual(coverToggle([], "standard"), { remove: [], add: "standard" });
  assert.deepEqual(coverToggle([{ id: "a", level: "standard" }], "lesser"), { remove: ["a"], add: "lesser" });
  assert.deepEqual(Object.keys(COVER), ["lesser", "standard", "greater"]);   // порядок кнопок в HUD
  assert.deepEqual(COVER.lesser, { bonus: 1, level: "lesser" });             // = choices ChoiceSet эффекта pf2e «Укрытие»
  assert.deepEqual(coverToggle([{ id: "a", level: "standard" }], "standard"), { remove: ["a"], add: null });
  assert.deepEqual(coverToggle([{ id: "a", level: "standard" }], "greater"), { remove: ["a"], add: "greater" });
  assert.deepEqual(coverToggle([{ id: "a", level: "greater" }, { id: "b", level: null }], "standard"), { remove: ["a", "b"], add: "standard" });
});

test("перезарядка: какое оружие показывать", () => {
  assert.ok(!needsReload({ reload: "0", capacity: 1 }));
  assert.ok(!needsReload({ reload: "-", capacity: 1 }));
  assert.ok(!needsReload({ reload: "", capacity: 1 }));
  assert.ok(!needsReload({ reload: null, capacity: 1 }));
  assert.ok(!needsReload({ reload: "1", capacity: 0 }));
  assert.ok(needsReload({ reload: "1", capacity: 1 }));
  assert.ok(needsReload({ reload: "2", capacity: 4 }));
  assert.ok(needsReload({ reload: "0", capacity: 5, repeating: true }));
  assert.ok(isUnloaded({ reload: "1", capacity: 1, loaded: 0 }));
  assert.ok(!isUnloaded({ reload: "1", capacity: 2, loaded: 1 }));
  assert.ok(!isUnloaded({ reload: "0", capacity: 1, loaded: 0 }));
  assert.ok(isUnloaded({ reload: "0", capacity: 5, repeating: true, loaded: 0 }));
});

test("глиф действий", () => {
  assert.equal(reloadGlyph({ reload: "2" }), "2");
  assert.equal(reloadGlyph({ reload: "0", repeating: true }), "3");
  assert.equal(reloadGlyph({ reload: "1min" }), "");
});

test("кнопки ударов TAH: id оружия из encodedValue", () => {
  const v = (t) => "strike|" + encodeURIComponent(t);
  assert.equal(strikeItemId(v("abc123>crossbow>0>ranged")), "abc123");
  assert.equal(strikeItemId(v("abc123>crossbow>damage>ranged")), "abc123");
  assert.equal(strikeItemId("strikeAuxiliaryAction|" + encodeURIComponent("abc>x>0>")), null);
  assert.equal(strikeItemId("toggle|abc"), null);
  assert.equal(strikeItemId(null), null);
  assert.equal(strikeUsage(v("abc123>gun-sword>0>melee")), "melee");
  assert.equal(strikeUsage(v("abc123>crossbow>damage>ranged")), "ranged");
  assert.equal(strikeUsage("toggle|abc"), "");
});
