// Двойной взмах: чистая логика (выбор оружия, план урона, срез урона за точность, сумма голов).
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true }, i18n: { localize: (k) => k, format: (k) => k } };
const ds = await import("../scripts/builtin/double-slice.mjs");

test("damagePlan: ни одного / один / оба попадания, крит по каждому отдельно", () => {
  assert.equal(ds.damagePlan(1, 0).mode, "none");
  assert.deepEqual(ds.damagePlan(1, 3), { mode: "single", hits: [{ idx: 1, crit: true }] });
  assert.deepEqual(ds.damagePlan(3, 2), { mode: "both", hits: [{ idx: 0, crit: true }, { idx: 1, crit: false }] });
});

test("nextMap: после двух атак — третья", () => {
  assert.equal(ds.nextMap(0), 2);
  assert.equal(ds.nextMap(1), 2);
});

const weapon = (id, o = {}) => ({ item: { id, isOfType: (t) => t === "weapon", isMelee: o.melee ?? true, system: { quantity: o.qty ?? 1, equipped: { carryType: o.carry ?? "held", handsHeld: o.hands ?? 1 } } } });

test("candidates: только удерживаемое одной рукой оружие ближнего боя, без дублей", () => {
  const list = [weapon("a"), weapon("a"), weapon("b", { hands: 2 }), weapon("c", { carry: "worn" }), weapon("d", { melee: false }), weapon("e")];
  assert.deepEqual(ds.candidates(list).map((s) => s.item.id), ["a", "e"]);
  assert.equal(ds.candidates([{ item: { isOfType: () => false } }]).length, 0);
  assert.deepEqual(ds.candidates([weapon("pair", { qty: 2 }), weapon("pair", { qty: 2 })]).map((s) => s.item.id), ["pair", "pair"]);   // пара одной строкой
});

test("stripFlavor: узлы precision заменяются нулём, остальное нетронуто", () => {
  const t = { class: "ArithmeticExpression", operator: "+", operands: [
    { class: "Die", number: 1, faces: 8, options: {} },
    { class: "Die", number: 2, faces: 6, options: { flavor: "precision" } }] };
  const r = ds.stripFlavor(t, "precision");
  assert.equal(r.operands[0].faces, 8);
  assert.deepEqual(r.operands[1], { class: "NumericTerm", number: 0, evaluated: true, options: {} });
  assert.equal(t.operands[1].class, "Die", "исходник не изменён");
});

test("sumHeads: n голов -> вложенные «+» из Grouping", () => {
  const h = (n) => ({ class: "NumericTerm", number: n });
  assert.deepEqual(ds.sumHeads([h(1)]), h(1));
  const s = ds.sumHeads([h(1), h(2), h(3)]);
  assert.equal(s.operator, "+");
  assert.equal(s.operands[1].term.number, 3);
  assert.equal(s.operands[0].term.operands[0].term.number, 1);
});
