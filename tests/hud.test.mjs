import test from "node:test";
import assert from "node:assert/strict";
import { coverToggle, needsReload, reloadList, reloadGlyph } from "../scripts/hud.mjs";

test("укрытие: поставить, снять, взаимоисключение", () => {
  assert.deepEqual(coverToggle([], "standard"), { remove: [], add: "standard" });
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
  const l = reloadList([{ reload: "1", capacity: 2, loaded: 2 }, { reload: "0", capacity: 1 }, { reload: "2", capacity: 2, loaded: 1 }]);
  assert.deepEqual(l.map((w) => w.full), [true, false]);
});

test("глиф действий", () => {
  assert.equal(reloadGlyph({ reload: "2" }), "2");
  assert.equal(reloadGlyph({ reload: "0", repeating: true }), "3");
  assert.equal(reloadGlyph({ reload: "1min" }), "");
});
