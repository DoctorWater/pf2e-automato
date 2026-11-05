// Twin Feint run(): отмена первого/второго броска, оба Удара по порядку, MAP, эффект «второй Удар» на время и снят в конце, урон/крит.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

let warns, dlg, calls, effects;
globalThis.game = { i18n: { localize: (k) => k, format: (k) => k }, settings: { get: () => null }, modules: { get: () => null }, user: { id: "u" } };
globalThis.ui = { notifications: { warn: (m) => warns.push(m), info() {} } };
globalThis.foundry = { applications: { api: { DialogV2: { wait: async () => dlg } } }, utils: { escapeHTML: (s) => String(s) } };
const twin = await import("../scripts/builtin/twin-feint.mjs");

// Удар: variants[i].roll пишет вызов и отдаёт степень из очереди degs (пусто — бросок отменён); damage/critical пишут вызов
const weapon = (id, degs, onRoll) => {
  const s = { item: { id, name: id, isMelee: true, isOfType: () => true, system: { equipped: { carryType: "held", handsHeld: 1 }, quantity: 1 } }, degs };
  s.variants = [0, 1, 2].map((i) => ({ label: `m${i}`, roll: async () => { calls.push(`roll:${id}:${i}`); await onRoll?.(id, i); const d = s.degs.shift(); return { options: { degreeOfSuccess: d ?? null } }; } }));
  s.damage = async () => void calls.push(`damage:${id}`);
  s.critical = async () => void calls.push(`crit:${id}`);
  return s;
};
const mk = (...strikes) => ({
  system: { actions: strikes },
  async createEmbeddedDocuments(_t, [d]) { const e = { d, deleted: false, async delete() { this.deleted = true; calls.push("eff:deleted"); } }; effects.push(e); calls.push("eff:created"); return [e]; }
});
const target = { actor: {} };
const scope = (actor, targets = [target]) => ({ actor, targets, item: { name: "TF" } });

beforeEach(() => { warns = []; calls = []; effects = []; dlg = { action: "ok", form: { w0: "0", w1: "1", map: "0" } }; });

test("нет цели / две цели — предупреждение, ничего не брошено", async () => {
  const a = mk(weapon("a", [2]), weapon("b", [2]));
  await twin.run(scope(a, [])); await twin.run(scope(a, [target, target]));
  assert.equal(warns.length, 2); assert.deepEqual(calls, []);
});
test("меньше двух оружий — предупреждение", async () => {
  await twin.run(scope(mk(weapon("a", [2]))));
  assert.equal(warns.length, 1); assert.deepEqual(calls, []);
});
test("окно закрыто — ничего", async () => {
  dlg = null;
  await twin.run(scope(mk(weapon("a", [2]), weapon("b", [2]))));
  assert.deepEqual(calls, []);
});
test("одно оружие дважды — предупреждение", async () => {
  dlg = { action: "ok", form: { w0: "0", w1: "0", map: "0" } };
  await twin.run(scope(mk(weapon("a", [2]), weapon("b", [2]))));
  assert.equal(warns.length, 1); assert.deepEqual(calls, []);
});
test("оба попадания: порядок, MAP на втором, эффект только на втором Ударе", async () => {
  await twin.run(scope(mk(weapon("a", [2]), weapon("b", [2]))));
  assert.deepEqual(calls, ["roll:a:0", "damage:a", "eff:created", "roll:b:1", "damage:b", "eff:deleted"]);
});
test("MAP: map=1 — m1 и m2; map=2 — второй не выше m2", async () => {
  dlg = { action: "ok", form: { w0: "0", w1: "1", map: "1" } };
  await twin.run(scope(mk(weapon("a", [2]), weapon("b", [2]))));
  assert.deepEqual(calls.filter((c) => c.startsWith("roll")), ["roll:a:1", "roll:b:2"]);
  calls = []; dlg = { action: "ok", form: { w0: "0", w1: "1", map: "2" } };
  await twin.run(scope(mk(weapon("a", [2]), weapon("b", [2]))));
  assert.deepEqual(calls.filter((c) => c.startsWith("roll")), ["roll:a:2", "roll:b:2"]);
});
test("первый бросок отменён — второго и эффекта нет", async () => {
  await twin.run(scope(mk(weapon("a", []), weapon("b", [2]))));
  assert.deepEqual(calls, ["roll:a:0"]); assert.equal(effects.length, 0);
});
test("первый мимо — урона нет, второй всё равно бросается с эффектом", async () => {
  await twin.run(scope(mk(weapon("a", [1]), weapon("b", [2]))));
  assert.deepEqual(calls, ["roll:a:0", "eff:created", "roll:b:1", "damage:b", "eff:deleted"]);
});
test("крит на втором — critical; промах второго — без урона; эффект снят всегда", async () => {
  await twin.run(scope(mk(weapon("a", [2]), weapon("b", [3]))));
  assert.ok(calls.includes("crit:b") && !calls.includes("damage:b"));
  calls = []; await twin.run(scope(mk(weapon("a", [2]), weapon("b", [0]))));
  assert.ok(!calls.some((c) => /damage:b|crit:b/.test(c))); assert.equal(calls.at(-1), "eff:deleted");
});
test("второй бросок отменён — эффект всё равно снят", async () => {
  await twin.run(scope(mk(weapon("a", [2]), weapon("b", []))));
  assert.equal(calls.at(-1), "eff:deleted"); assert.ok(effects[0].deleted);
});
test("бросок второго упал — эффект снят, ошибка проброшена", async () => {
  const b = weapon("b", [2], (id) => { if (id === "b") throw new Error("boom"); });
  await assert.rejects(twin.run(scope(mk(weapon("a", [2]), b))), /boom/);
  assert.ok(effects[0].deleted);
});
