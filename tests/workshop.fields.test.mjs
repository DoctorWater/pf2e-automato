// Мастерская: поля броска rollFieldsOf — общие для основного окна, событий, триггеров зоны и шагов активации. Без Foundry.
import test from "node:test";
import assert from "node:assert/strict";
import { fieldKit } from "../scripts/workshop/fields.mjs";
import { ruleToForm, carryUneditable, formToRule, blankUse } from "../scripts/sheet.mjs";
import { validateRule } from "../scripts/rules.mjs";

const { rollFieldsOf } = fieldKit((k) => k);
const f = ruleToForm(null), paths = (l) => l.map((x) => x.path);
const ROOTS = ["f", "f.ev.0", "f.zone.trig.0", "f.cast.0.use", "f.cast.1.choices.2.use"];

test("rollFieldsOf: все пути от корня P, сегмента roll нет ни в одном режиме", () => {
  for (const P of ROOTS) {
    const save = paths(rollFieldsOf(P, { ch: f.ch }, { mode: "save" })), check = paths(rollFieldsOf(P, { ck: f.ck }, { mode: "check" }));
    assert.ok(save.length && check.length);
    assert.ok(save.every((p) => p.startsWith(`${P}.ch.`)), P);
    assert.ok(check.every((p) => p.startsWith(`${P}.ck.`)), P);
    assert.ok(![...save, ...check].includes(`${P}.roll`) && ![...save, ...check].includes("roll"));
  }
  assert.deepEqual(rollFieldsOf("f", f, { mode: "none" }), []);
});

test("rollFieldsOf: в активации СЛ только число и подсказка, «источника» нет", () => {
  const dc = (act, type = "value") => rollFieldsOf("f.cast.0.use", { ch: { ...f.ch, dcType: type } }, { mode: "save", activation: act });
  const sel = dc(true).find((x) => x.path.endsWith(".dcType")), txt = dc(true).find((x) => x.path.endsWith(".dcText"));
  assert.deepEqual(sel.options.map((o) => o.value), ["value"]);
  assert.equal(txt.placeholder, "workshop.au.cast.dcPh");
  assert.deepEqual(dc(false).find((x) => x.path.endsWith(".dcType")).options.map((o) => o.value), ["value", "expr", "markup", "source", "against"]);
  assert.equal(dc(false).find((x) => x.path.endsWith(".dcText")).placeholder, undefined);
  assert.deepEqual(dc(true, "source").find((x) => x.path.endsWith(".dcType")).options.map((o) => o.value), ["value", "source"]);   // текущее значение не теряется
});

test("carryUneditable несёт шаги активации (use) как есть", () => {
  const src = validateRule({ v: 1, activate: [{ id: "s", label: "S", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 27 }, byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } } }] }).rule;
  const g = ruleToForm(src);
  assert.deepEqual(validateRule(formToRule(carryUneditable({ ...g, cast: [] }, g))).rule.activate, src.activate);
  assert.equal(blankUse().targets, "selected");
});

// Снимок: поля и пути основного окна до выноса rollFieldsOf (сверено со старым кодом app.mjs на 240 комбинациях); путь|подпись|варианты|placeholder
const SNAP = {
  saveValue: [
    "f.ch.statistic|sheet.statistic",
    "f.ch.dcType|sheet.dcLabel|value,expr,markup,source,against",
    "f.ch.dcText|workshop.au.dcValue",
    "f.ch.basic|sheet.basic",
    "f.ch.traits|sheet.traits",
    "f.ch.options|sheet.options",
    "f.ch.when|workshop.au.chWhen|ph:target:trait:undead",
    "f.ch.imm.on|workshop.au.immunity"
  ],
  saveSourceImm: [
    "f.ch.statistic|sheet.statistic",
    "f.ch.dcType|sheet.dcLabel|value,expr,markup,source,against",
    "f.ch.basic|sheet.basic",
    "f.ch.traits|sheet.traits",
    "f.ch.options|sheet.options",
    "f.ch.when|workshop.au.chWhen|ph:target:trait:undead",
    "f.ch.imm.on|workshop.au.immunity",
    "f.ch.imm.slug|workshop.au.immSlug",
    "f.ch.imm.label|sheet.label",
    "f.ch.imm.uuid|UUID",
    "f.ch.imm.value|sheet.duration",
    "f.ch.imm.unit|workshop.au.unit|minutes,hours,days",
    "f.ch.imm.deg.criticalFailure|workshop.au.immOn.criticalFailure",
    "f.ch.imm.deg.failure|workshop.au.immOn.failure",
    "f.ch.imm.deg.success|workshop.au.immOn.success",
    "f.ch.imm.deg.criticalSuccess|workshop.au.immOn.criticalSuccess",
    "f.ch.imm.any|workshop.au.immAny"
  ],
  saveMarkup: [
    "f.ch.statistic|sheet.statistic",
    "f.ch.dcType|sheet.dcLabel|value,expr,markup,source,against",
    "f.ch.basic|sheet.basic",
    "f.ch.traits|sheet.traits",
    "f.ch.options|sheet.options",
    "f.ch.when|workshop.au.chWhen|ph:target:trait:undead",
    "f.ch.imm.on|workshop.au.immunity"
  ],
  checkDefense: [
    "f.ck.statistic|workshop.au.checkStat|ph:athletics, acrobatics",
    "f.ck.vsType|sheet.vsLabel|defense,dc,against,none",
    "f.ck.vsText|workshop.au.vsWhat|ac,fortitude,reflex,will,perception",
    "f.ck.map|sheet.map|,0,1,2",
    "f.ck.traits|sheet.traits",
    "f.ck.options|sheet.options",
    "f.ck.when|workshop.au.chWhen|ph:target:trait:undead",
    "f.ck.one|sheet.oneRoll",
    "f.ck.imm.on|workshop.au.immunity"
  ],
  checkNone: [
    "f.ck.statistic|workshop.au.checkStat|ph:athletics, acrobatics",
    "f.ck.vsType|sheet.vsLabel|defense,dc,against,none",
    "f.ck.map|sheet.map|,0,1,2",
    "f.ck.traits|sheet.traits",
    "f.ck.options|sheet.options",
    "f.ck.when|workshop.au.chWhen|ph:target:trait:undead"
  ],
  checkDc: [
    "f.ck.statistic|workshop.au.checkStat|ph:athletics, acrobatics",
    "f.ck.vsType|sheet.vsLabel|defense,dc,against,none",
    "f.ck.vsText|workshop.au.vsWhat",
    "f.ck.map|sheet.map|,0,1,2",
    "f.ck.traits|sheet.traits",
    "f.ck.options|sheet.options",
    "f.ck.when|workshop.au.chWhen|ph:target:trait:undead",
    "f.ck.one|sheet.oneRoll",
    "f.ck.imm.on|workshop.au.immunity"
  ],
};
const KIT = { saveValue: [{ "ch.dcType": "value" }, "save"], saveSourceImm: [{ "ch.dcType": "source", "ch.imm.on": true }, "save"], saveMarkup: [{ "ch.dcType": "markup" }, "save"], checkDefense: [{ "ck.vsType": "defense" }, "check"], checkNone: [{ "ck.vsType": "none" }, "check"], checkDc: [{ "ck.vsType": "dc" }, "check"] };
const line = (x) => `${x.path}|${x.label}${x.options ? "|" + x.options.map((o) => o.value).join(",") : ""}${x.placeholder ? "|ph:" + x.placeholder : ""}`;

test("rollFieldsOf: снимок полей основного окна; события и триггеры — тот же набор под своим корнем", () => {
  for (const [name, [patch, mode]] of Object.entries(KIT)) {
    const m = structuredClone(f);
    for (const [k, v] of Object.entries(patch)) foundry_set(m, k, v);
    assert.deepEqual(rollFieldsOf("f", m, { mode }).map(line), SNAP[name], name);
    if (mode === "save") for (const P of ["f.ev.2", "f.zone.trig.1"]) assert.deepEqual(rollFieldsOf(P, m, { mode }).map(line), SNAP[name].map((x) => x.replace(/^f./, `${P}.`)), `${name} ${P}`);
  }
});
const foundry_set = (o, path, v) => path.split(".").reduce((a, k, i, l) => (i === l.length - 1 ? ((a[k] = v), a) : a[k]), o);
