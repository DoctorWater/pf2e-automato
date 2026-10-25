// activate (шаг 4, доработка): белый список СЛ шага, стабильный id, семантика onUse активации, attack без spell, обязательный id в ответах моделей.
import test from "node:test";
import assert from "node:assert/strict";
import { validateRule } from "../scripts/rules.mjs";
import { ruleUuids } from "../scripts/sheet.mjs";
import { checkAnswer } from "../tools/validate.mjs";

const ARC = "Compendium.pf2e.spells-srd.Item.arc";
const errs = (activate) => validateRule({ v: 1, activate }).errors.map(String);
const CH = (dc) => ({ targets: "selected", challenge: { statistic: "fortitude", ...(dc !== undefined && { dc }), byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } });
const any = new Proxy({}, { get: () => true });

test("activate: СЛ шага — белый список, одна ошибка dcForm без dc.none", () => {
  for (const dc of [{ expr: "@actor.level" }, 27, { value: 30, x: 1 }, { value: "30" }, { against: "will" }]) {
    const e = errs([{ label: "x", onUse: CH(dc) }]);
    assert.equal(e.length, 1, JSON.stringify(dc) + e);
    assert.match(e[0], /^activate\.dcForm/);
  }
  assert.ok(validateRule({ v: 1, activate: [{ label: "x", onUse: CH({ value: 30 }) }] }).ok);
});

test("activate: запасной id без латиницы — от метки, а не от позиции", () => {
  const id = (list) => validateRule({ v: 1, activate: list }).rule.activate.map((c) => c.id);
  const a = { label: "Куб", onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } }, b = { ...a, label: "Шар" };
  const [x, y] = id([a, b]), [y2, x2] = id([b, a]);
  assert.equal(x, x2); assert.equal(y, y2); assert.notEqual(x, y);
});

test("activate: attack/counteract без spell — ошибка", () => {
  const u = { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] };
  assert.match(errs([{ label: "x", onUse: u, attack: 5 }])[0], /\.attack/);
  assert.match(errs([{ label: "x", onUse: u, counteract: 5 }])[0], /\.counteract/);
});

test("activate: семантика шагов onUse активации и её вариантов проверяется как у корневого", () => {
  const refs = { conditions: { sickened: true }, effects: {} };
  const bad = { v: 1, activate: [{ id: "a", label: "A", onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "nonexistent" } }] } }] };
  assert.match(checkAnswer({ uuid: "u", rule: bad }, refs).errors.join(), /nonexistent/);
  const badStat = { v: 1, activate: [{ id: "a", label: "A", onUse: { ...CH(), challenge: { ...CH().challenge, statistic: "athletics" } } }] };
  assert.match(checkAnswer({ uuid: "u", rule: badStat }, refs).errors.join(), /statistic/);
  const viaChoice = { v: 1, activate: [{ id: "c", label: "C", choices: [{ id: "a", label: "A", onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: "Compendium.x.Item.e" } }] } }, { id: "b", spell: ARC }] }] };
  assert.match(checkAnswer({ uuid: "u", rule: viaChoice }, refs).errors.join(), /Compendium\.x\.Item\.e/);
  assert.ok(ruleUuids(validateRule(viaChoice).rule).includes("Compendium.x.Item.e"));
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, activate: [{ id: "a", label: "A", onUse: CH() }] } }, refs).kind, "accepted");
});

test("activate: в ответе модели id обязателен у записи и варианта без spell", () => {
  const u = { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] };
  const r = (rule) => checkAnswer({ uuid: "u", rule }, { conditions: any, effects: any });
  assert.match(r({ v: 1, activate: [{ label: "A", onUse: u }] }).errors[0], /activate\[0\]/);
  assert.match(r({ v: 1, activate: [{ id: "c", label: "C", choices: [{ label: "A", onUse: u }, { spell: ARC }] }] }).errors[0], /choices\[0\]/);
  assert.equal(r({ v: 1, activate: [{ id: "c", label: "C", choices: [{ id: "a", label: "A", onUse: u }, { spell: ARC }] }] }).kind, "accepted");
});
