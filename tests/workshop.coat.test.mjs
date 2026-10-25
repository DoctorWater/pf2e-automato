// Мастерская: редактор шага `coat` (яд на оружие) — модель формы, недуг внутри испытания, round-trip. Без Foundry.
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { validateRule } from "../scripts/rules.mjs";
import { roundTrip, semanticErrors } from "../tools/validate.mjs";
import * as au from "../scripts/workshop/automation.mjs";
import * as af from "../scripts/workshop/affliction-edit.mjs";

const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
const env = { t, damageLabel: (s) => s, conditionLabel: (s) => s };

const DEF = { name: "Spider Venom", kind: "poison", save: { statistic: "fortitude" }, maxDuration: { value: 6, unit: "rounds" }, virulent: false,
  stages: [{ duration: { value: 1, unit: "rounds" }, conditions: [{ slug: "sickened", value: 1 }] }, { duration: { value: 1, unit: "rounds" }, conditions: [{ slug: "clumsy", value: 1 }] }, { conditions: [{ slug: "slowed", value: 1 }] }] };
const CH = (o = {}) => ({ statistic: "fortitude", dc: { value: 22 }, basic: false, rollerRole: "target", traits: ["poison", "injury"],
  byDegree: { failure: [{ to: "target", affliction: { stage: 1, def: DEF } }], criticalFailure: [{ to: "target", affliction: { stage: 2, def: DEF } }] }, ...o });
const ruleOf = (coat = {}, rest = []) => ({ v: 1, label: "Spider Venom", onUse: { targets: "self", apply: [{ to: "self", coat: { weapon: "choose", challenge: CH(), ...coat } }, ...rest] } });
const ok = (raw) => { const v = validateRule(raw); assert.deepEqual(v.errors, []); return v.rule; };
const coatRow = (f) => f.apply.find((r) => r.kind === "coat");
const afflRows = (f) => af.stepRows(f).filter(([, r]) => r.kind === "affliction");

test("round-trip: срок, формы СЛ, невосприимчивость, условие, остальные шаги правила", () => {
  const cases = [
    ruleOf(),
    ruleOf({ duration: { value: 1, unit: "rounds", expiry: "turn-end" } }),
    ruleOf({ duration: { value: 0, unit: "rounds", expiry: "turn-end" } }),
    ruleOf({ duration: { value: 10, unit: "minutes" } }),
    ruleOf({ challenge: CH({ dc: { against: "class-spell" } }) }),
    ruleOf({ challenge: CH({ dc: { expr: "markup" } }) }),
    ruleOf({ challenge: CH({ dc: { source: "spell" } }) }),
    ruleOf({ challenge: CH({ options: ["item:id:x"], when: ["target:trait:undead"], immunity: { slug: "spider-venom", duration: { value: 1, unit: "days" } } }) }),
    ruleOf({}, [{ to: "self", note: "n" }])
  ];
  for (const raw of cases) assert.equal(roundTrip(ok(raw)), true, JSON.stringify(raw));
});

test("round-trip: все шаги coat каталога", () => {
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.model.json", import.meta.url), "utf8"));
  const withCoat = Object.values(cat.bySource).filter((e) => JSON.stringify(e).includes('"coat"'));
  assert.ok(withCoat.length > 0);
  for (const e of withCoat) { const r = e.rule ?? e; if (validateRule(r).ok) assert.equal(roundTrip(validateRule(r).rule), true, r.label); }
});

test("вкладка листа: запись без row.coat читается из JSON в text", () => {
  const rule = ok(ruleOf({ duration: { value: 1, unit: "rounds", expiry: "turn-end" } })), f = ruleToForm(rule);
  delete coatRow(f).coat;
  assert.deepEqual(validateRule(formToRule(f)).rule, rule);
});

test("поля: срок и испытание правятся в модели и доходят до правила", () => {
  const f = ruleToForm(ok(ruleOf())), c = coatRow(f).coat;
  Object.assign(c, { durValue: "1", durUnit: "rounds", durExpiry: "turn-end" });
  c.ch.dcType = "against"; c.ch.dcText = "class-spell";
  const r = validateRule(formToRule(f));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rule.onUse.apply[0].coat.duration, { value: 1, unit: "rounds", expiry: "turn-end" });
  assert.deepEqual(r.rule.onUse.apply[0].coat.challenge.dc, { against: "class-spell" });
  c.durValue = "";
  assert.equal(validateRule(formToRule(f)).rule.onUse.apply[0].coat.duration, undefined);
});

test("недуг внутри coat: определение общее для шагов обеих степеней, правка и «Отделить» работают", () => {
  const f = ruleToForm(ok(ruleOf())), rows = afflRows(f);
  assert.deepEqual(rows.map(([p]) => p), ["apply.0.coat.ch.deg.failure.0", "apply.0.coat.ch.deg.criticalFailure.0"]);
  const [[, a], [, b]] = rows;
  af.afflSet(f, a, "name", "Spider Venom II");
  assert.equal(af.afflOf(b).def.name, "Spider Venom II");
  assert.equal(af.afflView(f, a, env).shared.length, 2);
  af.afflOp(f, b, "split");
  af.afflSet(f, b, "name", "Other");
  assert.equal(af.afflOf(a).def.name, "Spider Venom II");
  const v = validateRule(formToRule(f));
  assert.deepEqual(v.errors, []);
  assert.equal(v.rule.onUse.apply[0].coat.challenge.byDegree.criticalFailure[0].affliction.def.name, "Other");
});

test("новый шаг coat: пустая модель; после СЛ и недуга в степени правило валидно", () => {
  const f = ruleToForm(ok({ v: 1, onUse: { targets: "self", apply: [{ to: "self", note: "n" }] } }));
  const row = { kind: "note", text: "x", value: "", to: "self", keep: "" };
  f.apply.push(row);
  au.setStepKind(row, "coat");
  assert.equal(row.kind, "coat");
  assert.deepEqual(validateRule(formToRule(f)).errors.map((e) => e.key), ["dc.none"]);   // СЛ не задана
  row.coat.ch.dcText = "20";
  const bare = validateRule(formToRule(f));
  assert.ok(bare.ok);
  assert.ok(semanticErrors(bare.rule, { conditions: {}, effects: {} }, null).some((e) => /does nothing/.test(e)));   // недуга в степенях нет
  const aff = { kind: "affliction", to: "target", text: "", value: "", keep: "" };
  row.coat.ch.deg.failure.push(aff);
  af.afflInit(aff, f);
  af.afflSet(f, aff, "name", "Venom");
  af.afflSet(f, aff, "s.0.text", "x");
  const v = validateRule(formToRule(f));
  assert.deepEqual(v.errors, []);
  assert.equal(v.rule.onUse.apply[1].coat.challenge.traits.join(), "poison,injury");
  au.setStepKind(row, "note");
  assert.equal(row.coat, undefined);
});

test("плашка шага: название по первому недугу; пустое испытание — «?»", () => {
  const f = ruleToForm(ok(ruleOf()));
  assert.equal(au.plate(coatRow(f), env).name, 'workshop.au.coatPlate{"name":"Spider Venom"}');
  const row = { kind: "note", text: "", value: "", to: "self", keep: "" };
  au.setStepKind(row, "coat");
  assert.equal(au.plate(row, env).name, 'workshop.au.coatPlate{"name":"?"}');
});

test("недуг в coat и тот же недуг в событии — одна группа; подпись шага «яд на оружие»", () => {
  const raw = ruleOf();
  raw.onEvent = [{ on: "attack-roll", side: "self", apply: [], challenge: CH() }];
  const f = ruleToForm(ok(raw)), rows = afflRows(f);
  const inCoat = rows.find(([p]) => p === "apply.0.coat.ch.deg.failure.0"), inEv = rows.find(([p]) => p === "ev.0.ch.deg.failure.0");
  assert.ok(inCoat && inEv);
  af.afflSet(f, inCoat[1], "name", "Shared");
  assert.equal(af.afflOf(inEv[1]).def.name, "Shared");
  assert.ok(af.sharedPaths(f, inEv[1]).includes("apply.0.coat.ch.deg.failure.0"));
  assert.match(af.stepLabel("apply.0.coat.ch.deg.failure.0", t), /workshop.au.coat.inCoat/);
  assert.doesNotMatch(af.stepLabel("ev.0.ch.deg.failure.0", t), /inCoat/);
});
