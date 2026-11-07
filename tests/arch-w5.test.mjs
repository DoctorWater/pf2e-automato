import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { effectiveMode } from "../scripts/settings.mjs";

test("effectiveMode: low при auto -> button, off и high не меняются", () => {
  const get = (m) => () => m;
  assert.equal(effectiveMode("apply", { confidence: "low" }, get("auto")), "button");
  assert.equal(effectiveMode("apply", { confidence: "high" }, get("auto")), "auto");
  assert.equal(effectiveMode("apply", { confidence: "low" }, get("off")), "off");
  assert.equal(effectiveMode("apply", { confidence: "low" }, get("button")), "button");
  assert.equal(effectiveMode("apply", undefined, get("auto")), "auto");
});

test("mode.limits: настройка заведена, ограничения читают её, а не mode.macro", () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  assert.match(src("../scripts/settings.mjs"), /"mode\.limits": "auto"/);
  assert.match(src("../scripts/builtin/melee-reach.mjs"), /modeOf\("limits"\)/);
  assert.match(src("../scripts/builtin/impulse-gate.mjs"), /modeOf\("limits"\)/);
  for (const f of ["melee-reach", "impulse-gate"]) assert.doesNotMatch(src(`../scripts/builtin/${f}.mjs`), /modeOf\("macro"\)/);
  for (const l of ["ru", "en"]) assert.ok(JSON.parse(src(`../lang/${l}/settings.json`)).PF2E_AUTOMATO.settings.mode.limits.hint);
});
