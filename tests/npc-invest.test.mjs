import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { canInvest } = await import("../scripts/builtin/npc-invest.mjs");

test("canInvest: как isInvestable персонажа — признак есть (isInvested не null), не убран, опознан", () => {
  const it = (o = {}) => ({ isInvested: false, isStowed: false, isIdentified: true, ...o });
  assert.equal(canInvest(it()), true);
  assert.equal(canInvest(it({ isInvested: true })), true);
  assert.equal(canInvest(it({ isInvested: null })), false);   // без признака «Вложение»
  assert.equal(canInvest(it({ isStowed: true })), false);
  assert.equal(canInvest(it({ isIdentified: false })), false);
  assert.equal(canInvest(null), false);
});
