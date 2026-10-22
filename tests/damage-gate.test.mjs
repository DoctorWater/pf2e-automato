import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedDamage, degreeOf } from "../scripts/damage-gate.mjs";

test("кнопки по исходу", () => {
  assert.deepEqual(allowedDamage(3), { success: false, "critical-success": true });
  assert.deepEqual(allowedDamage(2), { success: true, "critical-success": false });
  for (const d of [0, 1]) assert.deepEqual(allowedDamage(d), { success: false, "critical-success": false });
  for (const d of [null, undefined, NaN, 7]) assert.deepEqual(allowedDamage(d), { success: true, "critical-success": true });
});

test("degreeOf: бросок приоритетнее контекста, не-атака и нет исхода -> null", () => {
  const m = (type, outcome, d) => ({ flags: { pf2e: { context: { type, outcome } } }, rolls: [{ options: { degreeOfSuccess: d } }] });
  assert.equal(degreeOf(m("attack-roll", "failure", 3)), 3);
  assert.equal(degreeOf(m("attack-roll", "failure", undefined)), 1);
  assert.equal(degreeOf(m("attack-roll", undefined, undefined)), null);
  assert.equal(degreeOf(m("saving-throw", "success", 2)), null);
});

test("исход после реакции: флаг gate.degree на сообщении атаки перекрывает бросок", async () => {
  const { gateDegree } = await import("../scripts/damage-gate.mjs");
  const atk = (gate) => ({ id: "a1", flags: { pf2e: { context: { type: "attack-roll", outcome: "criticalSuccess" } }, "pf2e-automato": { gate } }, rolls: [{ options: { degreeOfSuccess: 3 } }] });
  assert.equal(gateDegree(atk(undefined)), 3);
  assert.equal(gateDegree(atk({ degree: 2 })), 2);
  assert.equal(gateDegree(atk({ degree: 0 })), 0);
  assert.equal(gateDegree(atk({})), 3);
  assert.equal(gateDegree({ flags: { "pf2e-automato": { gate: { degree: 2 } } } }), null);   // не атака
});

test("продолжительный урон: что прятать зависит от workbench", async () => {
  const { isPersistentCard, persistentHide } = await import("../scripts/damage-gate.mjs");
  assert.equal(isPersistentCard({ rolls: [{ options: { evaluatePersistent: true } }] }), true);
  assert.equal(isPersistentCard({ rolls: [{ options: {} }] }), false);
  assert.deepEqual(persistentHide(null), { damage: false, recovery: false });
  assert.deepEqual(persistentHide({ applyPersistentDamage: true }), { damage: true, recovery: false });
  assert.deepEqual(persistentHide({ applyPersistentDamage: true, applyPersistentDamageRecoveryRoll: true }), { damage: true, recovery: true });
  assert.deepEqual(persistentHide({ applyPersistentDamageRecoveryRoll: true }), { damage: false, recovery: false });
});
