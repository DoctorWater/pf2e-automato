// Правило Dominate (plan-activate-ext §6 п.4): принятое в каталог модельное правило заклинания.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRule } from "../scripts/rules.mjs";
import { extraKeys, roundTrip } from "../tools/validate.mjs";

const UUID = "Compendium.pf2e.spells-srd.Item.OsOhx3TGIZ7AhD0P";
const rule = JSON.parse(readFileSync(new URL("../rules/catalog.model.json", import.meta.url), "utf8")).bySource[UUID];
const by = rule?.onUse.challenge.byDegree;
const ctl = (steps) => steps.filter((s) => s.condition?.slug === "controlled");

test("Dominate: правило в каталоге валидно, без потерянных ключей", () => {
  const v = validateRule(rule);
  assert.deepEqual(v.errors.map(String), []);
  assert.deepEqual(extraKeys(rule, v.rule), []);
  assert.ok(roundTrip(v.rule));
});

test("Dominate: Will против СЛ заклинания, ступени по тексту", () => {
  const c = rule.onUse.challenge;
  assert.equal(c.statistic, "will");
  assert.deepEqual(c.dc, { source: "spell" });
  assert.deepEqual(c.traits, ["incapacitation", "mental"]);
  assert.equal(by.criticalSuccess, undefined);
  assert.deepEqual(by.success.map((s) => s.condition), [{ slug: "stunned", value: 1, policy: "max" }]);
  for (const d of ["failure", "criticalFailure"]) assert.equal(ctl(by[d]).length, 2);
});

test("Dominate: на провале controlled с повтором в конце хода, на крит. провале — без повтора и с note", () => {
  const rep = { on: "turn-end", end: ["success", "criticalSuccess"] };
  for (const s of ctl(by.failure)) assert.deepEqual(s.repeat, rep);
  assert.ok(ctl(by.criticalFailure).every((s) => s.repeat === undefined));
  for (const d of ["failure", "criticalFailure"]) assert.ok(by[d].some((s) => s.note), d);
});

test("Dominate: срок — 1 день до 9 круга, без срока на 10 (неограниченный)", () => {
  for (const d of ["failure", "criticalFailure"]) {
    const [lo, hi] = ctl(by[d]);
    assert.deepEqual([lo.rank, lo.duration.value, lo.duration.unit], [{ max: 9 }, 1, "days"], d);
    assert.deepEqual([hi.rank, hi.duration], [{ min: 10 }, undefined], d);
  }
});
