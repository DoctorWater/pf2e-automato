// Урон по итогам спасброска: не-basic множители по степеням (challenge.damageByDegree), режимы ruleFormulas, ссылки, которые наносит само правило.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true }, users: [], modules: { get: () => null }, settings: { get: () => true }, i18n: { localize: (k) => k, format: (k) => k } };
const { parseDegrees, lineMult, patchLine } = await import("../tools/damage-degrees.mjs");
const bd = await import("../scripts/builtin/basic-damage.mjs");
const { ruleFormulas, ruleDamageSteps, inheritDegrees, coveredByRule, damageButtons } = await import("../scripts/damage-button.mjs");
const { validateRule, resolveFormula } = await import("../scripts/rules.mjs");

const GRIM = `Tendrils of darkness curl out. You deal 2d4 void damage and @Damage[(@item.level)[bleed]] damage to living creatures in the line.
---
Critical Success The creature is unaffected.
Success The creature takes half the void damage and no persistent bleed damage.
Failure The creature takes full damage.
Critical Failure The creature takes double void damage and double persistent bleed damage.
---
Heightened (+1) The void damage increases by 2d4.`;

test("parseDegrees: Тёмные нити — ×0 / ×½ / ×1 / ×2 (множитель продолжительного урона не путается с начальным)", () => {
  assert.deepEqual(parseDegrees(GRIM), { criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 2 });
});

test("parseDegrees: «As failure, but double damage», «takes no damage» на успехе, пропущенный крит. успех — 0", () => {
  const t = "Success The target takes no damage but is slowed.\nFailure The target takes full damage.\nCritical Failure As failure, but double damage.";
  assert.deepEqual(parseDegrees(t), { criticalSuccess: 0, success: 0, failure: 1, criticalFailure: 2 });
  assert.deepEqual(parseDegrees("Success half damage.\nFailure takes full damage.\nCritical Failure As failure, but the effect is permanent.").criticalFailure, 1);
});

test("parseDegrees: неоднозначное не размечается (кости в строке, нет явного провала, повтор блока, только продолжительный)", () => {
  assert.equal(parseDegrees("Success The target takes half damage.\nFailure The target takes @Damage[2d6[fire]] damage."), null);
  assert.equal(parseDegrees("Success The target takes half damage.\nFailure The target is frightened 1."), null);
  assert.equal(parseDegrees("Success The target takes half damage.\nSuccess The target takes half damage.\nFailure takes full damage."), null);
  assert.equal(parseDegrees("Success The target takes half the persistent fire damage.\nFailure The target takes the full persistent fire damage."), null);
  assert.equal(parseDegrees("Success The duplicate deals half damage with its Strikes.\nFailure The duplicate works as described."), null);
  assert.equal(parseDegrees(""), null);
  assert.equal(lineMult("The target takes full initial and persistent damage."), 1);
});

test("patchLine: поле встаёт после basic:false головы испытания, повтор — без изменений, basic:true и записи без испытания — нет", () => {
  const line = '"U":{"v":1,"onUse":{"challenge":{"statistic":"fortitude","dc":{"source":"spell"},"basic":false,"byDegree":{}}}},';
  const out = patchLine(line, { failure: 1 });
  assert.ok(out.includes('"basic":false,"damageByDegree":{"failure":1},"byDegree"'));
  assert.equal(patchLine(out, { failure: 2 }), out);
  assert.equal(patchLine(line.replace("false", "true"), { failure: 1 }), line.replace("false", "true"));
  assert.equal(patchLine('"U":{"v":1,"onUse":{"apply":[]}},', { failure: 1 }), '"U":{"v":1,"onUse":{"apply":[]}},');
});

test("валидатор: damageByDegree — только множители 0/½/1/2 по известным степеням и только у не-basic", () => {
  const rule = (c) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { source: "spell" }, byDegree: {}, ...c } } });
  const ok = validateRule(rule({ basic: false, damageByDegree: { failure: 1, success: 0.5 } }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rule.onUse.challenge.damageByDegree, { failure: 1, success: 0.5 });
  for (const bad of [{ basic: false, damageByDegree: { failure: 3 } }, { basic: false, damageByDegree: { great: 1 } }, { basic: true, damageByDegree: { failure: 1 } }, { basic: false, damageByDegree: [1] }])
    assert.equal(validateRule(rule(bad)).ok, false, JSON.stringify(bad));
});

test("degreeTable: basic — стандарт; не-basic — поле правила, иначе overlay по источнику; нет испытания — null", () => {
  const mk = (ch) => ({ onUse: { challenge: ch } });
  assert.deepEqual(bd.degreeTable(mk({ basic: true }), null), [2, 1, 0.5, 0]);
  assert.deepEqual(bd.degreeTable(mk({ basic: false, damageByDegree: { criticalFailure: 2, failure: 1, success: 0.5 } }), null), [2, 1, 0.5, 0]);
  assert.deepEqual(bd.degreeTable(mk({ basic: false, damageByDegree: { failure: 1, criticalFailure: 1 } }), null), [1, 1, 0, 0]);
  assert.equal(bd.degreeTable(mk({ basic: false }), null), null);   // оверлей вливает resolveRule (arch-w3), здесь — только поле правила
  assert.equal(bd.degreeTable({ onUse: {} }, null), null);
  assert.equal(bd.multOf(2), 0.5);
  assert.equal(bd.multOf(2, [1, 1, 0, 0]), 0);
});

test("planBasicDamage с таблицей: множитель по степени; смена степени с тем же множителем не «пересчёт»", () => {
  const table = [2, 1, 1, 0], results = { a: { degree: 0 }, b: { degree: 3 }, c: { degree: 2 } };
  const { fresh } = bd.planBasicDamage(results, ["a", "b", "c"], {}, { table });
  assert.deepEqual(fresh.map((r) => [r.key, r.mult]), [["a", 2], ["b", 0], ["c", 1]]);
  const { changed } = bd.planBasicDamage({ a: { degree: 2 }, b: { degree: 1 } }, ["a", "b"], { a: { degree: 1, mult: 1 }, b: { degree: 2, mult: 1 } }, { table });
  assert.deepEqual(changed, []);   // 1 -> 2: оба ×1
  assert.equal(bd.planBasicDamage({ a: { degree: 3 } }, ["a"], { a: { degree: 2, mult: 1 } }, { table }).changed.length, 1);
});

test("ruleFormulas: режимы — триггер зоны только при effect=auto, шаги onUse.apply пока effect не off, по степеням — пока challenge и apply не off", () => {
  const dmg = (f) => ({ to: "target", damage: { formula: f, damageType: "fire" } });
  const rule = { onUse: { apply: [dmg("1")], zone: { triggers: [{ on: "enter", apply: [dmg("2")], challenge: { byDegree: { failure: [dmg("3")] } } }] }, challenge: { byDegree: { failure: [dmg("4")] } } } };
  const has = (m) => [...ruleFormulas(rule, m)].sort().join();
  assert.equal(has({}), "1,2,3,4");
  assert.equal(has({ effect: "button" }), "1,3,4");   // триггер зоны без auto урона не наносит — кнопка «Урон» остаётся
  assert.equal(has({ effect: "off" }), "3,4");
  assert.equal(has({ apply: "off" }), "1,2");
  assert.equal(has({ challenge: "off" }), "1,2");
  assert.equal(ruleFormulas(undefined).size, 0);
});

test("Пылающая колонна при effect=button: формула опасной местности не гасится, кнопка «Урон» остаётся", () => {
  const rule = { onUse: { zone: { triggers: [{ on: "enter", apply: [{ to: "target", damage: { formula: "(2*floor((@actor.level-1)/3)+1)", damageType: "fire" } }] }] } } };
  const link = { dataset: { formula: "{1[fire]}", damageRoll: "(2*floor((@actor.level -1)/3)+1)[fire]" }, textContent: "1 огонь" };
  assert.equal(damageButtons([link], "Урон", ruleFormulas(rule, { effect: "button" })).length, 1);
  assert.equal(damageButtons([link], "Урон", ruleFormulas(rule, { effect: "auto" })).length, 0);
});

test("coveredByRule: продолжительный урон шага покрывает ссылку того же типа с другой переменной (@item.level), но не мгновенный огонь", () => {
  const rule = { onUse: { challenge: { byDegree: { failure: [{ to: "target", persistent: { formula: "(@item.rank)", damageType: "bleed" } }] } } } };
  const skip = ruleFormulas(rule);
  assert.equal(coveredByRule("(@item.level)[bleed]", skip), true);
  assert.equal(coveredByRule("{(@item.level)[persistent,bleed]}", skip), true);
  assert.equal(coveredByRule("2d4[void]", skip), false);
  assert.equal(coveredByRule("2d8[fire]", ruleFormulas({ onUse: { apply: [{ to: "target", persistent: { formula: "1d6", damageType: "fire" } }] } })), false);   // «fire» без persistent — обычный урон
  assert.equal(coveredByRule("1d6[persistent,fire]", ruleFormulas({ onUse: { apply: [{ to: "target", persistent: { formula: "1d6", damageType: "fire" } }] } })), true);
});

test("rollIsRuleDamage: живой формат pf2e (formula локализована и упрощена, сырая — _formula); ссылка правила не связывается, настоящий урон — связывается", () => {
  const rule = { onUse: { zone: { triggers: [{ on: "enter", apply: [{ to: "target", damage: { formula: "(floor((@actor.level-1)/3)+1)d6", damageType: "fire" } }] }] } } };
  const steps = ruleDamageSteps(rule);
  // заглушка DamageRoll живой системы: «{1d6[fire]}» -> «1d6 огонь»; «{(1)[fire]}» -> «1 огонь»
  const normalize = (str) => { const m = /^\{\(([^)]+)\)\[(?:persistent,)?([a-z]+)\]\}$/.exec(str); return m && `${m[1]} ${{ fire: "огонь" }[m[2]]}`; };
  const ctx = { resolve: (f) => resolveFormula(f, { actorLevel: 1 }), normalize };
  assert.equal(resolveFormula(steps[0].formula, { actorLevel: 1 }), "1d6");
  assert.equal(bd.rollIsRuleDamage({ formula: "1d6 огонь", _formula: "{(floor((1 -1)/3)+1)d6[fire]}" }, steps, ctx), true);
  assert.equal(bd.rollIsRuleDamage({ formula: "2d6 огонь", _formula: "{2d6[fire]}" }, steps, ctx), false);
  assert.equal(bd.rollIsRuleDamage({ formula: "1d6 огонь" }, steps, { resolve: ctx.resolve }), false);   // нет нормализатора — по сырой формуле только при наличии _formula
  assert.equal(bd.rollIsRuleDamage({ formula: "x", _formula: "{1d6[fire]}" }, steps, { resolve: ctx.resolve }), true);
  assert.equal(bd.rollIsRuleDamage(null, steps, ctx), false);
});

test("rollIsRuleDamage: бросок из одних продолжительных экземпляров к карточке не относится, смешанный — относится", () => {
  const roll = (...p) => ({ formula: "2d6 огонь", instances: p.map((persistent) => ({ persistent })) });
  assert.equal(bd.rollIsRuleDamage(roll(true), []), true);
  assert.equal(bd.rollIsRuleDamage(roll(true, false), []), false);
});

test("ruleDamageSteps / ruleFormulas: mode.zone off — триггеры зоны не наносятся модулем", () => {
  const rule = { onUse: { zone: { triggers: [{ on: "enter", apply: [{ to: "target", damage: { formula: "2d6", damageType: "fire" } }] }] } } };
  assert.equal(ruleFormulas(rule, { zone: "auto" }).has("2d6"), true);
  assert.equal(ruleFormulas(rule, { zone: "off" }).size, 0);
});

test("inheritDegrees: «Крит. провал: как провал, и …» без своей ссылки наследует продолжительный урон; со своей ссылкой — нет", () => {
  const paras = [{ degree: 1, ref: 2, link: true }, { degree: 0, ref: 1, link: false }];   // Silk Bracelet: провал «As success» + урон, крит. провал «As failure»
  assert.deepEqual(inheritDegrees([1], paras).sort(), [0, 1]);
  assert.deepEqual(inheritDegrees([1], [{ degree: 0, ref: 1, link: true }]), [1]);   // Burning Badger: крит. провал свой урон
  assert.deepEqual(inheritDegrees([2], paras), [2]);
  assert.deepEqual(inheritDegrees([1], [{ degree: 0, ref: null, link: false }]), [1]);
});
