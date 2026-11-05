import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRule } from "../scripts/rules.mjs";
import { ruleToForm, formToRule, keepGet } from "../scripts/sheet.mjs";

const duration = { value: 1, unit: "rounds", expiry: "turn-start" };
const steps = [
  { condition: { slug: "frightened" }, duration },
  { effect: { uuid: "Item.effect" } },
  { effect: { mods: [{ bonus: { target: "will", type: "status", value: -2 } }] }, duration }
];
const ruleWith = (step) => ({ v: 1, onUse: { targets: "selected", apply: [{ to: "target", ...step }] } });

test("sustain: явные true и false допустимы только для condition/effect, включая inline effect", () => {
  for (const step of steps) for (const sustain of [true, false]) {
    const result = validateRule(ruleWith({ ...step, sustain }));
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.rule.onUse.apply[0].sustain, sustain);
  }
  const absent = validateRule(ruleWith(steps[0]));
  assert.equal(absent.ok, true);
  assert.equal(Object.hasOwn(absent.rule.onUse.apply[0], "sustain"), false);
});

test("sustain: condition с sustain:true требует duration; false и effect — нет", () => {
  const bad = validateRule(ruleWith({ condition: { slug: "stupefied" }, sustain: true }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.key === "apply.sustainDur" && e.data.path === "onUse.apply[0].sustain"));
  assert.equal(validateRule(ruleWith({ condition: { slug: "stupefied" }, sustain: false })).ok, true);
  assert.equal(validateRule(ruleWith({ effect: { uuid: "Item.effect" }, sustain: true })).ok, true);
  for (const locale of ["ru", "en"]) assert.ok(JSON.parse(readFileSync(new URL(`../lang/${locale}/rules.json`, import.meta.url), "utf8")).PF2E_AUTOMATO.rules.err.apply.sustainDur.includes("{path}"));
});

test("sustain: неподходящий тип или вид шага даёт локализуемую ошибку", () => {
  for (const sustain of [1, 0, "true", "false", null]) {
    const result = validateRule(ruleWith({ ...steps[0], sustain }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.key === "apply.sustain" && e.data.path === "onUse.apply[0].sustain"));
  }
  const unsupported = [
    { damage: { formula: "1d6", damageType: "fire" } },
    { persistent: { formula: "1d6", damageType: "fire" } },
    { choose: { from: "allies" } },
    { removeCondition: { slug: "frightened" } },
    { removeEffect: { uuid: "Item.effect" } },
    { note: "note" }
  ];
  for (const step of unsupported) for (const sustain of [true, false]) {
    const result = validateRule(ruleWith({ ...step, sustain }));
    assert.equal(result.ok, false, JSON.stringify(step));
    assert.ok(result.errors.some((e) => e.key === "apply.sustain"), JSON.stringify(result.errors));
  }
  for (const locale of ["ru", "en"]) {
    const labels = JSON.parse(readFileSync(new URL(`../lang/${locale}/rules.json`, import.meta.url), "utf8"));
    assert.ok(labels.PF2E_AUTOMATO.rules.err.apply.sustain.includes("{path}"));
  }
});

test("sustain: правило ↔ форма сохраняет true, false и отсутствие маркера", () => {
  for (const step of steps) for (const sustain of [true, false, undefined]) {
    const raw = ruleWith({ ...step, ...(sustain !== undefined && { sustain }) });
    const canonical = validateRule(raw);
    assert.equal(canonical.ok, true, canonical.errors.join("; "));
    const form = ruleToForm(canonical.rule);
    const row = form.apply[0];
    if (sustain === undefined) assert.equal(Object.hasOwn(keepGet(row), "sustain"), false);
    else assert.equal(keepGet(row).sustain, sustain);
    const back = validateRule(formToRule(form));
    assert.equal(back.ok, true, back.errors.join("; "));
    assert.deepEqual(back.rule, canonical.rule);
  }
});
