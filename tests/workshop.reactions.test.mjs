// Мастерская и вкладка листа правят onDamaged/onFailed: круг правило -> форма -> правило без потерь по всему каталогу, «как читается».
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { ruleToForm, formToRule, carryUneditable } from "../scripts/sheet.mjs";
import { validateRule } from "../scripts/rules.mjs";
import * as au from "../scripts/workshop/automation.mjs";

const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
const env = { t, dc: null, area: { shape: "burst", size: 20 }, author: null, conditionLabel: (s) => s, uuidName: () => null, statLabel: (s) => `st:${s}`, damageLabel: (s) => `dmg:${s}` };
const read = (f) => JSON.parse(readFileSync(new URL(`../rules/${f}`, import.meta.url), "utf8"));
const rx = (raw) => { const v = validateRule(raw); assert.equal(v.ok, true, JSON.stringify(v.errors)); return v.rule; };

for (const file of ["catalog.json", "catalog.model.json"]) {
  test(`${file}: onDamaged/onFailed — круг ruleToForm -> formToRule без потерь`, () => {
    let n = 0;
    for (const [src, raw] of Object.entries(read(file).bySource)) {
      if (!raw.onDamaged && !raw.onFailed) continue;
      const v = validateRule(raw);
      assert.equal(v.ok, true, `${src}: ${JSON.stringify(v.errors)}`);
      const form = ruleToForm(v.rule), back = validateRule(formToRule(JSON.parse(JSON.stringify(form))));
      assert.equal(back.ok, true, `${src}: ${JSON.stringify(back.errors)}`);
      assert.deepEqual(back.rule, v.rule, src);
      assert.equal(form.kind, raw.onDamaged ? "onDamaged" : "onFailed");
      n++;
    }
    assert.ok(n > 0);
  });
}

test("круг с правкой формы: смена вида и значений даёт валидное правило, другой вид не остаётся", () => {
  const f = ruleToForm(rx({ v: 1, onDamaged: { who: "ally", range: 30, damage: { reduce: "5" } } }));
  f.dm.mode = "resist"; f.dm.resist = { 0: { type: "fire", value: "10" } };   // как после setProperty на вкладке листа
  assert.deepEqual(rx(formToRule(f)).onDamaged.damage, { resist: [{ type: "fire", value: "10" }] });
  f.kind = "onFailed"; f.fl.check = { save: "true", skill: "false", perception: false, attack: false }; f.fl.degree = "critFail";
  const r = rx(formToRule(f));
  assert.equal(r.onDamaged, undefined);
  assert.deepEqual([r.onFailed.check, r.onFailed.degree], [["save"], "critFail"]);
  f.dm.who = "self"; f.kind = "onDamaged"; f.dm.mode = "redirect"; f.dm.hp = "4";
  assert.deepEqual([rx(formToRule(f)).onDamaged.damage, rx(formToRule(f)).onDamaged.cost], [{ redirect: "self", part: "all" }, { hp: "4" }]);
});

test("реакция с шагами ответа: apply уходит в onUse; без шагов onUse не появляется", () => {
  const f = ruleToForm(rx({ v: 1, onDamaged: { who: "self", damage: { halve: true } }, onUse: { targets: "self", apply: [{ to: "self", note: "x" }] } }));
  assert.equal(f.apply.length, 1);
  assert.equal(rx(formToRule(f)).onUse.apply.length, 1);
  assert.equal(formToRule(ruleToForm(rx({ v: 1, onFailed: { who: "self" } }))).onUse, null);
});

test("вкладка листа: notify в DOM не лежит — carryUneditable возвращает его, остальное правится формой", () => {
  const src = rx({ v: 1, onDamaged: { who: "self", notify: ["gm"] } }), f = ruleToForm(src);
  const sheet = { ...f, dm: { ...f.dm, notify: undefined }, fl: { ...f.fl, notify: undefined }, ev: [], cast: [] };   // что вернёт readForm
  assert.deepEqual(rx(formToRule(carryUneditable(sheet, f))), src);
  assert.deepEqual(rx(formToRule(sheet)).onDamaged.notify, ["owner", "gm"], "без переноса notify сбросился бы к умолчанию");
});

test("как читается: onDamaged — кто, типы урона, условие, что с уроном, цена, ответ", () => {
  const f = ruleToForm(rx({ v: 1, onDamaged: { who: "ally", range: 30, when: ["damage:type:fire", "target:trait:undead"], damage: { reduce: "5" }, cost: { hp: "2" }, triggerOnly: true }, onUse: { targets: "self", apply: [{ to: "self", note: "ответ" }] } }));
  const s = au.story(f, env).text;
  assert.match(s, /react\.damaged.*who.*react\.who\.ally.*range.*30/);
  assert.match(s, /react\.ofTypes.*dmg:fire/);
  assert.match(s, /react\.if.*target:trait:undead/);
  assert.match(s, /react\.reduce.*"n":"5"/);
  assert.match(s, /react\.costText.*"hp":"2"/);
  assert.match(s, /react\.triggerOnlyText/);
  assert.match(s, /react\.steps.*ответ/);
  assert.equal(au.summaries(f, env).when, "workshop.au.when.onDamaged");
});

test("как читается: resist (triggering отдельной фразой), перенос и половина", () => {
  const s = (d) => au.story(ruleToForm(rx({ v: 1, onDamaged: d })), env).text;
  assert.match(s({ who: "self", damage: { resist: [{ type: "triggering", value: "5" }, { type: "fire", value: "3" }] } }), /resistTrigText.*react\.resist.*dmg:fire/);
  assert.match(s({ who: "ally", damage: { redirect: "self", part: "half" } }), /react\.redirect\.half/);
  assert.match(s({ who: "familiar", damage: { halve: true } }), /react\.who\.familiar.*react\.halve/);
});

test("как читается: onFailed — степень, проверки, статистика, кто, оставить", () => {
  const s = (d) => au.story(ruleToForm(rx({ v: 1, onFailed: d })), env).text;
  const a = s({ who: "self", check: ["save"], when: ["check:statistic:will"], keep: "higher" });
  assert.match(a, /react\.failed.*react\.deg\.fail.*react\.chk\.save.*st:will.*react\.keep\.higher/);
  assert.doesNotMatch(a, /whoFail/);
  const b = s({ who: "any", range: 60, withSelf: true, degree: "critFail" });
  assert.match(b, /react\.chk\.any/);
  assert.match(b, /react\.whoFail\.any.*60/);
  assert.match(b, /react\.deg\.critFail/);
  assert.match(b, /react\.withSelf/);
});

test("как читается: типы урона и статистика не повторяются в «если …»; not и смешанное or остаются условием", () => {
  const dm = au.reactLine(ruleToForm(rx({ v: 1, onDamaged: { who: "self", when: [{ or: ["damage:type:fire", "damage:type:acid"] }], damage: { reduce: "5" } } })), env);
  assert.match(dm, /dmg:fire/);
  assert.doesNotMatch(dm, /react\.if/);
  const fl = au.reactLine(ruleToForm(rx({ v: 1, onFailed: { who: "self", check: ["skill"], when: [{ or: ["check:statistic:occultism", "check:statistic:lore"] }] } })), env);
  assert.match(fl, /st:occultism \/ st:lore/);
  assert.doesNotMatch(fl, /react\.if/);
  const mixed = au.reactLine(ruleToForm(rx({ v: 1, onDamaged: { who: "self", when: ["damage:type:fire", { not: "damage:type:acid" }, { or: ["damage:type:cold", "attack"] }], damage: { reduce: "5" } } })), env);
  assert.match(mixed, /react\.if/);
  assert.doesNotMatch(mixed, /dmg:acid/);
});

for (const kind of ["onDamaged", "onFailed"]) {
  test(`${kind}: notify — флажки owner/gm, круг по трём значениям, оба сняты — react.notify`, () => {
    for (const n of [["owner", "gm"], ["gm"], ["owner"]]) {
      const src = rx({ v: 1, [kind]: { who: "self", notify: n } }), f = ruleToForm(src), d = kind === "onDamaged" ? f.dm : f.fl;
      assert.deepEqual(d.notify, { owner: n.includes("owner"), gm: n.includes("gm") });
      assert.deepEqual(rx(formToRule(f)), src);
    }
    const f = ruleToForm(rx({ v: 1, [kind]: { who: "self" } })), d = kind === "onDamaged" ? f.dm : f.fl;
    assert.deepEqual(rx(formToRule(f))[kind].notify, ["owner", "gm"]);
    Object.assign(d.notify, { owner: "false", gm: false });   // из DOM могут прийти строки
    assert.equal(validateRule(formToRule(f)).errors.some((e) => JSON.stringify(e).includes("react.notify")), true);
    Object.assign(d.notify, { owner: "true", gm: "false" });
    assert.deepEqual(rx(formToRule(f))[kind].notify, ["owner"]);
    d.notify = ["gm"];   // старая форма с массивом
    assert.deepEqual(rx(formToRule(f))[kind].notify, ["gm"]);
  });
}
