// Мастерская: редактор активаций — round-trip формы на всех активациях каталога и на новых формах (choices, onUse, rank.half, dc.against). Без Foundry.
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { ruleToForm, formToRule, blankCast, blankChoice, buildReport } from "../scripts/sheet.mjs";
import { validateRule } from "../scripts/rules.mjs";
import { roundTrip } from "../tools/validate.mjs";
import { castLine } from "../scripts/workshop/automation.mjs";

const ARC = "Compendium.pf2e.spells-srd.Item.arc", FEAR = "Compendium.pf2e.spells-srd.Item.fear";
const U = (extra = {}) => ({ targets: "selected", challenge: { statistic: "fortitude", dc: { value: 27 }, byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } }, ...extra });
const ok = (activate) => { const v = validateRule({ v: 1, activate }); assert.deepEqual(v.errors, []); return v.rule; };
const act = (rule) => validateRule(formToRule(ruleToForm(rule)));

test("round-trip: все формы записи", () => {
  const cases = [
    [{ id: "a", spell: ARC }],
    [{ id: "a", spell: ARC, rank: 3, dc: 21, attack: 9, counteract: 11, per: { value: 1, unit: "days", uses: 2 }, requires: "held", label: "L", note: "n" }],
    [{ id: "a", spell: ARC, rank: { half: "actor", min: 2 }, dc: { against: "class-spell" } }],
    [{ id: "a", spell: ARC, rank: { half: "item", min: 1 }, dc: { level: "high" } }],
    [{ id: "s", label: "Steps", onUse: U() }],
    [{ id: "s", label: "Steps", dc: 25, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } }],
    [{ id: "b", spell: ARC, rank: 2, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } }],
    [{ id: "c", label: "Pick", per: { value: 1, unit: "hours" }, choices: [{ id: "x", spell: ARC, rank: { half: "actor", min: 3 }, dc: { against: "class-spell" } }, { id: "y", label: "Own", onUse: U(), dc: { level: "high" } }] }],
    [{ id: "c", label: "Pick", choices: [{ id: "x", spell: ARC }, { id: "y", spell: FEAR, rank: 1, dc: 19 }, { id: "z", label: "Z", onUse: U() }] }]
  ];
  for (const a of cases) { const r = ok(a); assert.equal(roundTrip(r), true, JSON.stringify(a)); }
});

test("round-trip: все активации каталогов", () => {
  let n = 0, bad = [];
  for (const file of readdirSync(new URL("../rules/", import.meta.url)).filter((f) => /^catalog.*\.json$/.test(f))) {
    const cat = JSON.parse(readFileSync(new URL(`../rules/${file}`, import.meta.url), "utf8"));
    const rules = [...Object.values(cat.bySource ?? {}), ...Object.values(cat.bySlug ?? {}), ...Object.values(cat.byName ?? {})].map((e) => e.rule ?? e);
    for (const raw of rules) {
      if (!(raw.activate ?? raw.cast)?.length) continue;
      const v = validateRule(raw);
      if (!v.ok) continue;
      n += v.rule.activate.length;
      if (!roundTrip(v.rule)) bad.push(`${file}:${raw.label}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(n >= 151, `активаций в каталогах: ${n}`);
});

test("форма: dcType не auto при against, rankMode по виду ранга", () => {
  const f = ruleToForm(ok([{ id: "a", spell: ARC, rank: { half: "item", min: 2 }, dc: { against: "class-spell" } }]));
  assert.deepEqual([f.cast[0].dcType, f.cast[0].rankMode, f.cast[0].rankMin, f.cast[0].kind], ["class", "half-item", 2, "spell"]);
  assert.equal(ruleToForm(ok([{ id: "a", label: "x", onUse: U() }])).cast[0].kind, "steps");
  assert.equal(ruleToForm(ok([{ id: "a", spell: ARC, onUse: U() }])).cast[0].kind, "both");
});

test("правка формы: вид, ранг, СЛ, варианты доходят до правила", () => {
  const f = ruleToForm({ v: 1 });
  f.kind = "cast";
  f.cast.push({ ...blankCast(), kind: "choice", id: "pick", label: "Pick", choices: [{ ...blankChoice(), id: "a", spell: ARC, rankMode: "half-actor", rankMin: "2", dcType: "class" }, { ...blankChoice(), id: "b", label: "B", kind: "steps", onUse: JSON.stringify(U()) }] });
  const r = validateRule(formToRule(f));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rule.activate[0].choices[0], { id: "a", spell: ARC, rank: { half: "actor", min: 2 }, dc: { against: "class-spell" } });
  assert.deepEqual(r.rule.activate[0].choices[1].onUse, ok([{ id: "n", label: "n", onUse: U() }]).activate[0].onUse);
  f.cast[0].kind = "spell";   // вариантов в правиле больше нет, поля формы остались
  assert.equal(formToRule(f).activate[0].choices, undefined);
});

test("ошибки: битый JSON и пустые шаги говорят валидатор, а не молчание", () => {
  const f = ruleToForm({ v: 1 });
  f.cast.push({ ...blankCast(), kind: "steps", id: "s", label: "S", onUse: "{oops" });
  assert.notDeepEqual(validateRule(formToRule(f)).errors, []);
  f.cast[0].onUse = "";
  assert.match(String(validateRule(formToRule(f)).errors[0]), /activate\.kind/);
  const g = ruleToForm({ v: 1 });
  g.cast.push({ ...blankCast(), kind: "choice", id: "c", label: "C", choices: [blankChoice()] });
  assert.notDeepEqual(validateRule(formToRule(g)).errors, []);
});

test("строка активации и пробный запуск живут на новых формах", () => {
  const rule = ok([{ id: "c", label: "Pick", choices: [{ id: "x", spell: ARC, rank: { half: "actor", min: 3 }, dc: { against: "class-spell" } }, { id: "y", label: "Own", onUse: U() }] }, { id: "a", spell: ARC, rank: { half: "item", min: 1 }, dc: { against: "class-spell" } }]);
  const f = ruleToForm(rule);
  const env = { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), uuidName: () => "Arc" };
  assert.match(castLine(f.cast[0], env).body, /au\.cast\.choiceCount/);
  assert.match(castLine(f.cast[1], env).body, /rankMode\.half-item.*dc\.class/);
  const rep = buildReport(validateRule(formToRule(f)).rule, [], { ...env, conditionKnown: () => true, statLabel: (s) => s, cast: [{}, {}] });
  assert.equal(rep.cast.length, 2);
});

test("смена вида «заклинание» -> «выбор»: ранг уходит, СЛ остаётся как значение по умолчанию для вариантов", () => {
  const f = ruleToForm(ok([{ id: "a", spell: ARC, rank: 3, dc: 21, label: "A" }]));
  f.cast[0].kind = "choice";
  f.cast[0].choices = [{ ...blankChoice(), id: "x", spell: ARC }, { ...blankChoice(), id: "y", spell: FEAR, dc: 30, dcType: "value" }];
  const r = validateRule(formToRule(f));
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.rule.activate[0].rank, r.rule.activate[0].dc], [undefined, 21]);
});

test("onUse в форме без null-ключей валидатора", () => {
  const f = ruleToForm(ok([{ id: "s", label: "S", onUse: U() }]));
  assert.doesNotMatch(f.cast[0].onUse, /null/);
});
