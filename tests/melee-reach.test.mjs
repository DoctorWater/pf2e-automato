import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { isMeleeStrike, outOfReach, pickSource, unchecked } = await import("../scripts/builtin/melee-reach.mjs");

test("pickSource: токен контекста; иначе выделенный токен актёра, только если он один", () => {
  const ctx = { id: "ctx" }, g1 = { actor: { id: "gob" } }, g2 = { actor: { id: "gob" } }, o = { actor: { id: "orc" } };
  assert.equal(pickSource(ctx, [g1, g2], "gob"), ctx);
  assert.equal(pickSource(null, [g1, o], "gob"), g1);
  assert.equal(pickSource(null, [g1, g2], "gob"), null);   // группа гоблинов — от какого мерить, неизвестно: не блокируем
  assert.equal(pickSource(null, [], "gob"), null);
});

test("unchecked: возвращает результат и снимает обход даже после исключения", async () => {
  assert.equal(await unchecked(async () => 7), 7);
  await assert.rejects(unchecked(async () => { throw new Error("x"); }));
  assert.equal(await unchecked(() => 1), 1);
});

test("isMeleeStrike: Удар вблизи — оружие, атака NPC, Стихийный взрыв; не дальний, не заклинание, не другой бросок", () => {
  const ctx = (type, isMelee, kind = "attack-roll") => ({ type: kind, item: { type, isMelee } });
  assert.equal(isMeleeStrike(ctx("weapon", true)), true);
  assert.equal(isMeleeStrike(ctx("melee", true)), true);
  assert.equal(isMeleeStrike(ctx("action", true)), true);
  assert.equal(isMeleeStrike(ctx("weapon", false)), false);
  assert.equal(isMeleeStrike(ctx("spell", true)), false);
  assert.equal(isMeleeStrike(ctx("weapon", true, "saving-throw")), false);
  assert.equal(isMeleeStrike({ type: "attack-roll" }), false);
});

test("outOfReach: строго дальше досягаемости; NaN/нет данных — не блокируем", () => {
  assert.deepEqual(outOfReach(10, 5), { d: 10, r: 5 });
  assert.equal(outOfReach(5, 5), null);
  assert.equal(outOfReach(10, 10), null);
  assert.equal(outOfReach(NaN, 5), null);
  assert.equal(outOfReach(10, undefined), null);
});
