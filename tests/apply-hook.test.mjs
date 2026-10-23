import { test } from "node:test";
import assert from "node:assert/strict";

test("applyDamage оборачивается libWrapper один раз: shield-block и gear делят обёртку", async () => {
  const targets = new Set(), wrappers = [];
  globalThis.game = { modules: { get: () => ({ active: true }) }, settings: { get: () => "off" } };
  globalThis.fromUuidSync = () => null;
  globalThis.libWrapper = { register(mod, target, fn) {
    if (targets.has(target)) throw new Error(`A wrapper for '${target}' has already been registered by module ${mod}.`);
    targets.add(target); wrappers.push(fn);
  } };
  const shield = await import("../scripts/builtin/shield-block.mjs");
  const gear = await import("../scripts/builtin/gear.mjs");
  shield.wrapApplyDamage();
  gear.wrapShatter();
  shield.wrapApplyDamage();
  assert.equal(wrappers.length, 1);
  const calls = [];
  const res = await wrappers[0].call({ uuid: "Actor.x", attributes: {}, items: [] }, async (o) => { calls.push(o.damage); return "ok"; }, { damage: 3 });
  assert.equal(res, "ok");
  assert.deepEqual(calls, [3]);
});
