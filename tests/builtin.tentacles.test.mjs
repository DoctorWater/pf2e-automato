import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.game = { user: { isActiveGM: true }, i18n: { localize: (k) => k, format: (k) => k }, users: [] };
const t = await import("../scripts/builtin/tentacular-limbs.mjs");

test("правило: признак reach (10 фт у среднего) безоружным Ударам", () => {
  const r = t.reachRule();
  assert.deepEqual([r.key, r.property, r.value, r.definition], ["AdjustStrike", "weapon-traits", "reach", ["item:category:unarmed"]]);
});

test("правила: досягаемость и RollOption для касания", () => {
  assert.deepEqual(t.rules().map((r) => r.key), ["AdjustStrike", "RollOption"]);
  assert.equal(t.rules()[1].option, "tentacular-limbs");
});
