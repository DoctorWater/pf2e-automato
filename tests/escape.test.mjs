// Освобождение жертвы: признак escape у шага apply (валидатор, форма мастерской, каталог) и чистая логика scripts/escape.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { escapeLabel, escapeDC, escapeDegree, frees, escapeIds } from "../scripts/escape.mjs";
import { validateRule } from "../scripts/rules.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";

const rule = (escape, step = { condition: { slug: "grabbed" } }) => ({ v: 1, onUse: { targets: "selected", apply: [{ to: "target", ...step, escape }] } });

test("escape: по умолчанию Атлетика и Акробатика; чужие навыки, СЛ 0 и шаг-заметка — ошибки", () => {
  const ok = validateRule(rule({ dcStat: "spell" }));
  assert.deepEqual(ok.rule.onUse.apply[0].escape, { stats: ["athletics", "acrobatics"], dcStat: "spell" });
  assert.equal(validateRule(rule({ stats: ["unarmed"], dc: 20 })).errors.length, 0);
  for (const bad of [{ stats: ["lore"] }, { dc: 0 }, { stats: [] }, "yes"]) assert.ok(validateRule(rule(bad)).errors.length, JSON.stringify(bad));
  assert.ok(validateRule(rule({}, { note: "x" })).errors.length);
  assert.ok(validateRule({ v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "grabbed" }, escape: {} }] } }).errors.length);
});

test("escape: переживает форму мастерской (ruleToForm -> formToRule)", () => {
  const r = validateRule(rule({ stats: ["athletics"], dcStat: "spell" })).rule;
  assert.deepEqual(validateRule(formToRule(ruleToForm(r))).rule.onUse.apply[0].escape, { stats: ["athletics"], dcStat: "spell" });
});

test("escape: СЛ — готовая, затем автора, затем снимок", () => {
  assert.equal(escapeDC({ dc: 25, dcStat: "spell" }, { spellDc: 30 }), 25);
  assert.equal(escapeDC({ dcStat: "spell" }, { spellDc: 30, statDc: 18, useDc: 12 }), 30);
  assert.equal(escapeDC({ dcStat: "athletics" }, { spellDc: 30, statDc: 18 }), 18);
  assert.equal(escapeDC({}, { useDc: 12 }), 12);   // без dcStat — СЛ источника (испытание)
  assert.equal(escapeDC({ dcStat: "spell" }, {}), null);
  assert.equal(escapeDC({ dcStat: "spell" }, { useDc: 12 }), null);   // у проверки use.dc — защита жертвы, не берём
  assert.equal(escapeDC({ dcStat: "athletics" }, { useDc: 12 }), null);
  assert.equal(escapeDC({}, {}), null);
});

test("escape: степень из результата pf2e, освобождают успех и крит. успех", () => {
  assert.deepEqual(["criticalFailure", "failure", "success", "criticalSuccess"].map((outcome) => escapeDegree({ outcome })), [0, 1, 2, 3]);
  assert.equal(escapeDegree({ roll: { degreeOfSuccess: 2 } }), 2);
  assert.equal(escapeDegree(undefined), null);
  assert.deepEqual([0, 1, 2, 3].map(frees), [false, false, true, true]);
});

test("escape: удаляются документ шага и выданное им", () => {
  const items = [{ id: "w" }, { id: "c", grantedById: "w" }, { id: "x" }, { id: "y", grantedById: "x" }];
  assert.deepEqual(escapeIds(["w"], items), ["w", "c"]);
  assert.deepEqual(escapeIds([], items), []);
});

test("каталог: лиана (крит. успех и успех) и захват несут escape", () => {
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8"));
  const steps = (r) => Object.values(r.onUse.check.byDegree).flat().filter((s) => s.escape);
  assert.deepEqual(steps(cat.bySlug["tangle-vine"]).map((s) => s.escape), [{ dcStat: "spell" }, { dcStat: "spell" }]);
  assert.deepEqual(steps(cat.bySlug.grapple).map((s) => s.condition.slug), ["restrained", "grabbed"]);
  for (const r of [cat.bySlug["tangle-vine"], cat.bySlug.grapple]) assert.equal(validateRule(r).errors.length, 0);
});

test("escape: название — состояние локализуется, эффект называется по исходному предмету", () => {
  const eff = { type: "effect", name: "Spell Effect: Tangle Vine" };
  assert.equal(escapeLabel(eff, { name: "Опутывающая лиана" }), "Опутывающая лиана");
  assert.equal(escapeLabel(eff, null), "Spell Effect: Tangle Vine");
  assert.equal(escapeLabel({ type: "condition", slug: "grabbed", name: "Grabbed" }, { name: "Захват" }), "Grabbed");
  globalThis.CONFIG = { PF2E: { conditionTypes: { grabbed: "PF2E.grabbed" } } };
  globalThis.game = { i18n: { localize: (k) => (k === "PF2E.grabbed" ? "Схвачен" : k) } };
  assert.equal(escapeLabel({ type: "condition", slug: "grabbed", name: "Grabbed" }, { name: "Захват" }), "Схвачен");
});
