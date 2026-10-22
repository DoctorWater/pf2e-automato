import test from "node:test";
import assert from "node:assert/strict";
import { frightenedPlan, retchDelta, retchValue, retchPlan, sourceDC } from "../scripts/turn-conditions.mjs";

test("испуг: каждый экземпляр -1, ноль снимается, нулевые пропускаются", () => {
  assert.deepEqual(frightenedPlan([{ id: "a", value: 2 }, { id: "b", value: 1 }]), [{ id: "a", to: 1 }, { id: "b", to: 0 }]);
  assert.deepEqual(frightenedPlan([{ id: "a", value: 0 }]), []);
  assert.deepEqual(frightenedPlan([]), []);
});

test("испуг: Workbench уже уменьшает — уступаем", () => {
  assert.deepEqual(frightenedPlan([{ id: "a", value: 2 }], true), []);
});

test("тошнота: изменение по степени", () => {
  assert.deepEqual([0, 1, 2, 3].map(retchDelta), [0, 0, 1, 2]);
  assert.equal(retchValue(3, 3), 1);
  assert.equal(retchValue(1, 3), 0);
  assert.equal(retchValue(2, 2), 1);
  assert.equal(retchValue(2, 1), 2);
});

test("тошнота: СЛ из meta.message -> use.dc, в т.ч. через обёртку", () => {
  const msgs = { m1: { flags: { "pf2e-automato": { use: { dc: 22 } } } }, m2: { flags: { "pf2e-automato": { use: {} } } } };
  const get = (id) => msgs[id] ?? null;
  const meta = (message) => ({ flags: { "pf2e-automato": { meta: { message } } } });
  assert.equal(sourceDC([{ flags: {} }, meta("m1")], get), 22);
  assert.equal(sourceDC([undefined, meta("m2")], get), null);
  assert.equal(sourceDC([meta("zz")], get), null);
  assert.equal(sourceDC([], get), null);
});

test("испуг: запертые экземпляры пропускаются", () => {
  assert.deepEqual(frightenedPlan([{ id: "a", value: 2, locked: true }, { id: "b", value: 1 }]), [{ id: "b", to: 0 }]);
});

test("тошнота: понижаются все экземпляры выше нового значения, запертые не трогаем", () => {
  assert.deepEqual(retchPlan([{ id: "a", value: 2 }, { id: "b", value: 2 }], 2), [{ id: "a", to: 1 }, { id: "b", to: 1 }]);
  assert.deepEqual(retchPlan([{ id: "a", value: 3 }, { id: "b", value: 1 }], 2), [{ id: "a", to: 2 }]);
  assert.deepEqual(retchPlan([{ id: "a", value: 2 }, { id: "b", value: 2 }], 1), []);
  assert.deepEqual(retchPlan([{ id: "a", value: 2, locked: true }, { id: "b", value: 1 }], 2), [{ id: "b", to: 0 }]);
});
