import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveFromMarkup, validateRule, buildCatalog, resolveFormula, persistentOf, isZeroFormula } from "../scripts/rules.mjs";
import { ruleToForm, formToRule, applyOf, blankRow } from "../scripts/sheet.mjs";
import { stepText } from "../scripts/chat.mjs";
import * as au from "../scripts/workshop/automation.mjs";

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8"));
const labels = read("rules/labels.json");
const derive = (html) => deriveFromMarkup({ type: "spell", name: "T", system: { description: { value: html }, defense: { save: { statistic: "will", basic: false } } } }, labels, () => null, []);
const pers = (d) => Object.fromEntries(Object.entries(d.rule.onUse.challenge.byDegree).map(([k, v]) => [k, v.filter((a) => a.persistent).map((a) => `${a.persistent.formula}:${a.persistent.damageType}`)]));
const rule = (a) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { source: "spell" }, byDegree: { failure: [a] } } } });

test("валидатор: формула, тип, СЛ, взаимоисключение с другими видами", () => {
  const ok = validateRule(rule({ persistent: { formula: " 2d6 + 3 ", damageType: "fire", dc: 17 } }));
  assert.deepEqual(ok.rule.onUse.challenge.byDegree.failure, [{ to: "target", persistent: { formula: "2d6+3", damageType: "fire", dc: 17 } }]);
  const keys = (a) => validateRule(rule(a)).errors.map((e) => e.key);
  assert.deepEqual(keys({ persistent: { formula: "@item.rank", damageType: "fire" } }), []);
  assert.deepEqual(keys({ persistent: { formula: "(@foo)d4", damageType: "fire" } }), ["pers.formula"]);
  assert.deepEqual(keys({ persistent: { formula: "(@item.rank)d4", damageType: "fire" } }), []);
  assert.deepEqual(validateRule(rule({ persistent: { formula: " (floor( @item.rank / 2 ))d8 ", damageType: "fire" } })).rule.onUse.challenge.byDegree.failure[0].persistent.formula, "(floor(@item.rank/2))d8");
  assert.deepEqual(keys({ persistent: { formula: "1d6", damageType: "plasma" } }), ["pers.type"]);
  assert.deepEqual(keys({ persistent: { formula: "1d6", damageType: "fire", dc: 0 } }), ["pers.dc"]);
  assert.deepEqual(keys({ persistent: { formula: "1d6", damageType: "fire" }, note: "x" }), ["apply.kind"]);
  assert.deepEqual(keys({ persistent: { formula: "1d6", damageType: "fire" }, duration: { value: 1, unit: "rounds" } }), ["dur.needCond"]);
});

test("форма: rowOf/applyOf без потерь, СЛ по умолчанию не пишется", () => {
  for (const persistent of [{ formula: "1d4", damageType: "mental" }, { formula: "2d6+3", damageType: "bleed", dc: 20 }]) {
    const f = ruleToForm(validateRule(rule({ to: "self", persistent })).rule);
    const row = f.ch.deg.failure[0];
    assert.deepEqual([row.kind, row.text, row.pType], ["persistent", persistent.formula, persistent.damageType]);
    assert.deepEqual(applyOf(row), { to: "self", persistent });
    assert.deepEqual(validateRule(formToRule(f)).rule.onUse.challenge.byDegree.failure[0].persistent, persistent);
  }
  assert.equal(blankRow().pType, "fire");
});

test("текст шага и плашка", () => {
  const env = { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), damageLabel: (x) => `~${x}` };
  assert.equal(stepText({ persistent: { formula: "1d6", damageType: "fire" } }, env, "target"), 'chat.stepTarget{"what":"chat.stepPersistent{\\"formula\\":\\"1d6\\",\\"type\\":\\"~fire\\"}"}');
  assert.match(stepText({ persistent: { formula: "1d6", damageType: "fire", dc: 17 } }, env, "target"), /chat\.dc/);
  assert.ok(stepText({ persistent: { formula: "(@item.rank)d4", damageType: "mental" } }, env, "target").includes("chat.perRank"));
  assert.ok(stepText({ persistent: { formula: "(floor(@item.rank/2))d8", damageType: "fire" } }, env, "target").includes("(floor(chat.varRank/2))d8"));
  assert.equal(au.plate({ ...blankRow(), kind: "persistent", text: "1d6", pType: "fire" }, env).name, "1d6 · ~fire");
});

test("разметка RU: @Damage и текст, по степеням", () => {
  const d = derive(`<b>Успех:</b> цель невредима.\n<br>\n<b>Провал:</b> цель получает 1к4 продолжительного ментального урона и испытывает боль.\n<br>\n<b>Критический провал:</b> цель получает @Damage[(2d4)[persistent,mental]] и 1d6 продолжительного урона огнём.`);
  assert.deepEqual(pers(d), { failure: ["1d4:mental"], criticalFailure: ["2d4:mental", "1d6:fire"] });
  assert.equal(d.hints.possible.length, 0);
});

test("разметка EN: persistent <type> damage, bleed, @Damage с несколькими слагаемыми", () => {
  const d = derive(`<p><strong>Failure</strong> The target takes 1d4 persistent mental damage.</p><p><strong>Critical Failure</strong> The target takes @Damage[2d6[fire],1d6[persistent,fire]] and 1 persistent bleed damage.</p>`);
  assert.deepEqual(pers(d), { failure: ["1d4:mental"], criticalFailure: ["1d6:fire", "1:bleed"] });
});

test("разметка: «вы», «вместо», «или», стоп-слова и неразборчивое — не шаг; или/нечисловое — подсказка", () => {
  const d = derive(`<p><strong>Failure</strong> You take 1d6 persistent fire damage. The target takes 2d6 persistent cold damage instead of 1d6. The target is immune to 1d6 persistent acid damage.</p>
<p><strong>Critical Failure</strong> The target takes 1d6 persistent fire damage or 1d6 persistent cold damage.</p>`);
  assert.deepEqual(pers(d), {});
  assert.deepEqual(d.hints.possible, ["criticalFailure:persistent-damage"]);
});

test("разметка: @Damage — формулы с переменными; те же фильтры, что у текста", () => {
  const d = derive(`<p><strong>Failure</strong> The target takes @Damage[(@item.rank)d4[persistent,mental]].</p>`);
  assert.deepEqual(pers(d), { failure: ["(@item.rank)d4:mental"] });
  assert.deepEqual(persistentOf("<p>@Damage[(2d4)[persistent,fire]]</p>").steps, [{ formula: "2d4", damageType: "fire" }]);
  const none = (t) => assert.deepEqual(persistentOf(t), { steps: [], possible: false }, t);
  none("You take @Damage[1d6[persistent,fire]].");
  none("The target takes @Damage[1d6[persistent,fire]] instead of @Damage[1d4[persistent,fire]].");
  none("The target is immune to @Damage[1d6[persistent,fire]].");
  none("Whenever the target becomes affected by a spell, the target takes @Damage[2d12[persistent,force]] damage.");
  none("Всякий раз, когда на цель начинает действовать заклинание, она получает @Damage[2d12[persistent,force]]{2d12} продолжительного урона силой.");
  none("The creature takes @Damage[5d10[persistent,sonic]] damage at the end of their turn as long as they remain in the aura.");
  none("Пока цель остаётся в ауре, она получает @Damage[1d6[persistent,fire]].");
  none("The object takes full damage as well as @Damage[1d6[persistent]].");
  none("Предмет получает @Damage[1d6[persistent,acid]].");
  const or = persistentOf("The creature takes @Damage[4d6[persistent,fire]] or @Damage[4d6[persistent,poison]] damage.");
  assert.deepEqual(or, { steps: [], possible: true });
});

test("СЛ очистки из текста", () => {
  assert.deepEqual(persistentOf("The target takes an additional 1 persistent bleed damage, and the DC for recovering from persistent bleed damage is 17, or 12 with assistance.").steps, [{ formula: "1", damageType: "bleed", dc: 17 }]);
  assert.deepEqual(persistentOf("Цель получает 1к6 продолжительного урона огнём; СЛ снятия продолжительного урона равна 20.").steps, [{ formula: "1d6", damageType: "fire", dc: 20 }]);
  assert.deepEqual(persistentOf("Takes @Damage[1d6[persistent,fire]]. Reflex DC 25.").steps, [{ formula: "1d6", damageType: "fire" }]);
  assert.deepEqual(persistentOf("Takes @Damage[1d6[persistent,fire]] (@Check[reflex|dc:25]).").steps, [{ formula: "1d6", damageType: "fire" }]);
});

test("основы типов: сила, негатив, позитив", () => {
  const t = (s) => persistentOf(s).steps[0]?.damageType;
  assert.equal(t("Цель получает 1к6 продолжительного урона силой."), "force");
  assert.equal(t("Цель получает 1к6 продолжительного негативного урона."), "void");
  assert.equal(t("Цель получает 1к6 продолжительного позитивного урона."), "vitality");
});

test("формулы: подстановка круга/уровня и вычисление групп", () => {
  assert.equal(resolveFormula("(@item.rank)d4", { rank: 3 }), "3d4");
  assert.equal(resolveFormula("(floor(@item.rank/2))d8", { rank: 5 }), "2d8");
  assert.equal(resolveFormula("(@item.level+1)d6+@actor.level", { rank: 2, level: 2, actorLevel: 7 }), "3d6+7");
  assert.equal(resolveFormula("(@item.rank)d4"), "1d4");
  assert.equal(resolveFormula("(@bad)d4"), null);
  assert.equal(resolveFormula("(1d4)d4"), null);
  assert.equal(resolveFormula("(2/0)d4"), null);
});

test("каталог: Фантомная боль — продолжительный урон на провале и крит. провале", () => {
  const cat = buildCatalog([read("rules/catalog.json")]);
  assert.deepEqual(cat.errors, []);
  const bd = cat.bySlug.get("phantom-pain").onUse.challenge.byDegree;
  for (const deg of ["failure", "criticalFailure"]) assert.deepEqual(bd[deg].find((a) => a.persistent).persistent, { formula: "(@item.rank)d4", damageType: "mental" });
  assert.deepEqual(cat.bySource.get("Compendium.pf2e.spells-srd.Item.R8bqnYiThB6MYTxD"), cat.bySlug.get("phantom-pain"));
});

test("разметка: условие по черте вне блоков и выбор типа игроком — подсказка, не шаг; нулевая формула — не шаг, rank-формула остаётся", () => {
  const fx = (head, body) => derive(`<p>${head}</p><hr /><p><strong>Failure</strong> ${body}</p>`);
  const noxious = fx("Any creature that has the plant trait takes the following effects.", "The creature takes @Damage[1d4[persistent,poison]] damage.");
  assert.deepEqual(pers(noxious), {});
  assert.deepEqual(noxious.hints.possible, ["failure:persistent-damage"]);
  const censer = fx("You choose fire or poison.", "The creature takes @Damage[2d6[persistent,fire]] or @Damage[2d6[persistent,poison]] damage; 2d6 persistent poison damage.");
  assert.deepEqual(pers(censer), {});
  assert.deepEqual(pers(fx("Hit.", "The target takes @Damage[(floor(@item.rank/2))d8[persistent,void]].")), { failure: ["(floor(@item.rank/2))d8:void"] });
  assert.deepEqual(pers(fx("Hit.", "The target takes @Damage[0[persistent,fire]].")), {});
});

test("isZeroFormula: «0», «0d8» — ноль; формула rank/2 на 1 ранге — ноль", () => {
  assert.equal(isZeroFormula("0"), true);
  assert.equal(isZeroFormula(resolveFormula("(floor(@item.rank/2))d8")), true);
  assert.equal(isZeroFormula(resolveFormula("(floor(@item.rank/2))d8", { rank: 2 })), false);
});

test("типы урона в написании pf2ru: режущий, кровотечение, жизнь, дух, пустота, звук, яд", () => {
  const t = (s) => persistentOf(s).steps[0]?.damageType;
  const cases = { "продолжительного режущего урона": "slashing", "продолжительного рубящего урона": "slashing", "продолжительного урона от кровотечения": "bleed", "продолжительного урона кровотечением": "bleed",
    "продолжительного урона жизнью": "vitality", "продолжительного урона духом": "spirit", "продолжительного урона пустотой": "void", "продолжительного урона звуком": "sonic",
    "продолжительного урона ядом": "poison", "продолжительного урона кислотой": "acid", "продолжительного урона электричеством": "electricity", "продолжительного урона холодом": "cold", "продолжительного колющего урона": "piercing" };
  for (const [phrase, type] of Object.entries(cases)) assert.equal(t(`Цель получает 1d6 ${phrase}.`), type, phrase);
});
