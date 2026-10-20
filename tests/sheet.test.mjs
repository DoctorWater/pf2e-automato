import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { validateRule } from "../scripts/rules.mjs";

const cat = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url)));

test("правила каталога: rule -> форма -> rule без потерь", () => {
  const all = [...Object.values(cat.bySource ?? {}), ...Object.values(cat.bySlug ?? {})];
  assert.ok(all.length > 0);
  for (const raw of all) {
    const rule = validateRule(raw).rule;
    const back = validateRule(formToRule(ruleToForm(rule)));
    assert.ok(back.ok, back.errors.join("; "));
    assert.deepEqual(back.rule, rule);
  }
});

test("макросы и пустая форма", () => {
  const f = ruleToForm(null);
  assert.equal(validateRule(formToRule(f)).ok, false);   // пусто
  f.kind = "none";
  f.macros = [{ uuid: "Macro.abc", phase: "onDegree", degree: "success" }];
  assert.deepEqual(validateRule(formToRule(f)).rule.macros, [{ uuid: "Macro.abc", phase: "onDegree", degree: "success" }]);
});

test("onUse.check и Apply.duration: rule -> форма -> rule без потерь", () => {
  const dur = { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" };
  const rules = [
    { v: 1, label: "Demoralize", onUse: { targets: "selected", check: {
      statistic: "intimidation", vs: { defense: "will" }, traits: ["auditory", "mental"], options: ["action:demoralize"], mapIncreases: 0,
      immunity: { slug: "demoralize", label: "Demoralize immunity", duration: { value: 10, unit: "minutes" } },
      byDegree: { criticalSuccess: [{ to: "target", condition: { slug: "frightened", value: 2, policy: "max" } }], success: [{ to: "target", condition: { slug: "frightened", value: 1, policy: "max" } }] } } } },
    { v: 1, onUse: { targets: "area", check: {
      statistic: ["athletics", "acrobatics"], vs: { against: "athletics" }, mapIncreases: 2,
      immunity: { slug: "x", uuid: "Compendium.pf2e.feat-effects.Item.abc" },
      byDegree: {
        success: [{ to: "target", condition: { slug: "clumsy", value: 1, policy: "max" }, duration: dur }],
        criticalFailure: [{ to: "self", condition: { slug: "prone", policy: "max" }, duration: { value: 3, unit: "minutes", expiry: null, of: "target" } }, { to: "target", note: "n" }] } } } },
    { v: 1, onUse: { targets: "selected", check: { statistic: "medicine", vs: { dc: 20 }, byDegree: { success: [{ to: "target", effect: { uuid: "Compendium.x" } }] } } } }
  ];
  for (const raw of rules) {
    const rule = validateRule(raw);
    assert.ok(rule.ok, rule.errors.join("; "));
    const back = validateRule(formToRule(ruleToForm(rule.rule)));
    assert.ok(back.ok, back.errors.join("; "));
    assert.deepEqual(back.rule, rule.rule);
  }
});
