// zone.mjs на заглушках foundry: срок, схема без редактируемых events, статические обработчики.
import { test } from "node:test";
import assert from "node:assert/strict";

class Field { constructor(o) { this.o = o; } }
globalThis.foundry = {
  data: { fields: { StringField: Field, NumberField: Field, BooleanField: Field, ArrayField: Field, ObjectField: Field }, regionBehaviors: { RegionBehaviorType: class {} } }
};
const { isExpired, ZoneBehaviorType } = await import("../scripts/zone.mjs");

test("isExpired: срок по миру (в т.ч. отрицательный), раунды, closed", () => {
  assert.equal(isExpired({ expiresAt: null, roundsLeft: null, closed: false }, 100), false);
  assert.equal(isExpired({ expiresAt: -50, roundsLeft: null }, -60), false);
  assert.equal(isExpired({ expiresAt: -50, roundsLeft: null }, -50), true);
  assert.equal(isExpired({ expiresAt: null, roundsLeft: 0 }, 0), true);
  assert.equal(isExpired({ expiresAt: null, roundsLeft: 2 }, 0), false);
  assert.equal(isExpired({ closed: true }, 0), true);
});

test("схема: нет events и min у expiresAt; static events — enter/exit", () => {
  const s = ZoneBehaviorType.defineSchema();
  assert.equal("events" in s, false);
  assert.equal(s.expiresAt.o.min, undefined);
  assert.equal(s.expiresAt.o.nullable, true);
  assert.deepEqual(Object.keys(ZoneBehaviorType.events).sort(), ["tokenEnter", "tokenExit", "tokenTurnEnd", "tokenTurnStart"]);
});

test("static tokenEnter/Exit: не-ГМ ничего не делает, активный ГМ вызывает hold/release", async () => {
  const calls = [];
  const sys = { hold: async (t) => calls.push(["hold", t]), release: async (t) => calls.push(["release", t]) };
  const ev = { data: { token: "T" } };
  globalThis.game = { user: { isActiveGM: false } };
  await ZoneBehaviorType.events.tokenEnter.call(sys, ev);
  assert.equal(calls.length, 0);
  game.user.isActiveGM = true;
  await ZoneBehaviorType.events.tokenEnter.call(sys, ev);
  await ZoneBehaviorType.events.tokenExit.call(sys, ev);
  assert.deepEqual(calls, [["hold", "T"], ["release", "T"]]);
  delete globalThis.game;
});
