import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ruleToForm, formToRule, dropSpec, buildReport, ruleUuids } from "../scripts/sheet.mjs";
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

test("dropSpec: состояние, эффект, макрос, прочее", () => {
  assert.deepEqual(dropSpec({ type: "Item", uuid: "Compendium.pf2e.conditionitems.Item.x" }, { type: "condition", name: "Off-Guard", system: { slug: "off-guard" } }), { kind: "condition", text: "off-guard" });
  assert.deepEqual(dropSpec({ type: "Item", uuid: "u" }, { type: "condition", name: "Flat Footed" }), { kind: "condition", text: "flat-footed" });
  assert.deepEqual(dropSpec({ type: "Item", uuid: "Item.e" }, { type: "effect", name: "E" }), { kind: "effect", text: "Item.e" });
  assert.deepEqual(dropSpec({ type: "Macro", uuid: "Macro.m" }, null), { macro: "Macro.m" });
  const nested = { type: "effect", name: "E", parent: {} };
  assert.deepEqual(dropSpec({ type: "Item", uuid: "Actor.A.Item.t" }, { ...nested, _stats: { compendiumSource: "Compendium.x.Item.e" } }), { kind: "effect", text: "Compendium.x.Item.e" });
  assert.deepEqual(dropSpec({ type: "Item", uuid: "Actor.A.Item.t" }, { ...nested, sourceId: "Compendium.y.Item.e" }), { kind: "effect", text: "Compendium.y.Item.e" });
  assert.deepEqual(dropSpec({ type: "Item", uuid: "Actor.A.Item.t" }, nested), { temp: true });
  assert.equal(dropSpec({ type: "Item", uuid: "Item.w" }, { type: "weapon" }), null);
  assert.equal(dropSpec({ type: "Actor", uuid: "Actor.a" }, null), null);
  assert.equal(dropSpec(null, null), null);
});

test("buildReport: испытание, проверка, иммунитет, проблемы", () => {
  const stat = (mod, slug) => ({ slug, check: { mod } });
  const actor = (name, { will = 0, ac = 20, imm = false } = {}) => ({
    name, uuid: `Actor.${name}`, saves: { will: { dc: { value: 10 + will } } }, armorClass: { value: ac },
    getStatistic: (s) => (s === "will" ? stat(will, "will") : null), items: imm ? [{ type: "effect", system: { context: { origin: { actor: "Actor.author" } } }, flags: { "pf2e-automato": { immunity: { slug: "dem" } } } }] : []
  });
  const author = { uuid: "Actor.author", getStatistic: (s) => (s === "intimidation" ? stat(7, "intimidation") : null) };
  const env = {
    t: (k, d) => (d ? `${k} ${JSON.stringify(d)}` : k), dc: 25, author, statLabel: (s) => s, conditionLabel: (s) => s,
    conditionKnown: (s) => s !== "bogus", uuidName: (u) => (u === "Item.ok" ? "Ok" : null)
  };
  const toks = [{ name: "A", actor: actor("A", { will: 5 }) }, { name: "B", actor: actor("B", { imm: true }) }, { name: "C", actor: { name: "C", items: [], getStatistic: () => null } }];
  const ch = validateRule({ v: 1, onUse: { targets: "selected",
    challenge: { statistic: "will", dc: { value: 25 }, rollerRole: "target", byDegree: { failure: [{ to: "target", condition: { slug: "bogus", policy: "max" } }], success: [{ to: "target", effect: { uuid: "Item.ok" } }] } } },
    macros: [{ uuid: "Macro.gone", phase: "onUse" }] });
  assert.ok(ch.ok, ch.errors.join("; "));
  const r1 = buildReport(ch.rule, toks, env);
  assert.equal(r1.problems.length, 2);   // bogus-slug и Macro.gone
  assert.ok(r1.problems[0].includes("bogus") && r1.problems[1].includes("Macro.gone"));
  assert.ok(r1.tokens[0].lines[0].includes('"mod":"+5"') && r1.tokens[0].lines[0].includes('"dc":25'));
  assert.equal(r1.tokens[0].lines.length, 3);   // испытание + 2 степени
  assert.equal(r1.tokens[2].problems.length, 1);   // нет статистики

  const ck = validateRule({ v: 1, onUse: { targets: "selected",
    check: { statistic: "intimidation", vs: { defense: "will" }, immunity: { slug: "dem", duration: { value: 1, unit: "minutes" } }, byDegree: { success: [{ to: "target", note: "n" }] } } } });
  assert.ok(ck.ok, ck.errors.join("; "));
  const r2 = buildReport(ck.rule, toks, env), [a, b, c] = r2.tokens;
  assert.deepEqual(r2.problems, []);
  assert.ok(a.lines[0].includes('"mod":"+7"') && a.lines[0].includes('"dc":15'));
  assert.ok(!a.lines.includes("sheet.test.immune") && b.lines.includes("sheet.test.immune"));
  assert.equal(c.problems.length, 1);   // СЛ защиты неизвестна
  const r3 = buildReport(ck.rule, toks, { ...env, author: null });
  assert.deepEqual(r3.problems, ["sheet.test.noOwner"]);
  assert.deepEqual(ruleUuids(ch.rule).sort(), ["Item.ok", "Macro.gone"]);
});

globalThis.foundry ??= { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) } };   // use.mjs тянет zone.mjs
const { ruleParts, badgeTip } = await import("../scripts/badge.mjs");
const { itemUseKind, wantsSnapshot } = await import("../scripts/use.mjs");

test("подсказка значка: части правила и источник", () => {
  const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
  const rule = validateRule({ v: 1, onUse: { targets: "area", zone: { condition: { slug: "frightened" } }, challenge: { statistic: "will", dc: { value: 20 }, byDegree: { failure: [{ condition: { slug: "frightened", value: 1 } }] } } } }).rule;
  assert.deepEqual(ruleParts(rule, t), ['sheet.badge.challenge{"stat":"will"}', "sheet.badge.states", "sheet.badge.zone"]);
  const tip = badgeTip({ rule, source: "markup", confidence: "low" }, { t });
  assert.ok(tip.includes("sheet.src.markup") && tip.endsWith("sheet.confLow"));
  assert.ok(badgeTip({ rule, source: "flag", confidence: "high" }, { t }).indexOf("confLow") < 0);
  assert.equal(badgeTip({ rule, source: "flag" }, { t, groups: ["A", "B"], yielded: true }), 'sheet.badge.yielded{"groups":"A, B"}');
  assert.deepEqual(ruleParts({ macros: [{ uuid: "Macro.x", phase: "onUse" }] }, t), ["sheet.badge.macros"]);
});

test("значок: фильтры использования и подпись навыка", () => {
  assert.equal(itemUseKind({ type: "feat", system: { selfEffect: { uuid: "x" } } }), null);
  assert.equal(itemUseKind({ type: "feat", system: {} }), "use");
  assert.equal(itemUseKind({ type: "weapon", system: {} }), "card");
  assert.equal(itemUseKind({ type: "lore", system: {} }), null);
  const eq = validateRule({ v: 1, onUse: { targets: "self", apply: [{ to: "self", note: "n" }] } }).rule;
  assert.ok(wantsSnapshot("use", eq) && !wantsSnapshot("card", eq));   // у снаряжения без области значка нет
  const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
  const ck = validateRule({ v: 1, onUse: { targets: "selected", challenge: { statistic: "athletics", dc: { value: 15 } } } }).rule;
  assert.deepEqual(ruleParts(ck, t, (s) => `L:${s}`), ['sheet.badge.challenge{"stat":"L:athletics"}']);
});

test("вкладка листа: строки как их читает DOM (всё строками) не теряют поля «Дополнительно», свойства эффекта, выбор, replace, ch.when", () => {
  const dur = { value: 1, unit: "rounds", expiry: "turn-end", of: "target" };
  const rule = validateRule({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 20 }, basic: false, rollerRole: "target", when: ["target:trait:undead"], byDegree: {
    failure: [
      { to: "target", condition: { slug: "slowed", value: 1, policy: "max" }, who: "enemy", escape: { stats: ["athletics", "unarmed"], dc: 18, dcStat: "spell" } },
      { to: "target", effect: { uuid: "Compendium.x.Item.e" }, repeat: { on: "turn-start", end: ["failure", "criticalSuccess"] }, unlessEffect: "Compendium.x.Item.i" },
      { to: "target", effect: { mods: [{ bonus: { target: "will", type: "status", value: -2 } }, { forbid: "reactions" }] }, duration: dur, escape: { stats: ["athletics"] } }
    ],
    success: [{ to: "target", effect: { uuid: "Compendium.x.Item.e", replace: true }, mark: "enemy", choice: 2, who: "ally" }] } },
  apply: [{ to: "self", choose: { from: "options", prompt: "?", options: [{ value: "fire", label: "Огонь", when: ["feat:x"] }, { value: "cold" }] } }] } });
  assert.ok(rule.ok, rule.errors.join());
  const dom = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v ?? "")])));
  const f = ruleToForm(rule.rule);
  f.apply = dom(f.apply);
  for (const d of Object.keys(f.ch.deg)) f.ch.deg[d] = dom(f.ch.deg[d]);
  const back = validateRule(formToRule(f));
  assert.ok(back.ok, back.errors.join());
  assert.deepEqual(back.rule, rule.rule);
});
