import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { damageButtons, ruleFormulas, normFormula, coreFormula, rolledCore, spellDamageDone } = await import("../scripts/damage-button.mjs");
const link = (formula, text, damageRoll = formula) => ({ dataset: { formula, damageRoll }, textContent: text });

test("damageButtons: одинаковая формула в разных абзацах — одна кнопка со всеми ссылками", () => {
  const [b] = damageButtons([link("{3d6[persistent,fire]}", "3d6"), link("{3d6[persistent,fire]}", "3d6")], "Урон");
  assert.equal(b.links.length, 2);
});

test("damageButtons: одна формула — «Урон»; несколько — с подписью; повтор формулы — одна кнопка", () => {
  assert.deepEqual(damageButtons([link("1d6[fire]", "1d6 огонь")], "Урон").map((b) => b.label), ["Урон"]);
  assert.deepEqual(damageButtons([link("1d6[fire]", "1d6 огонь"), link("1[fire]", " 1 огонь "), link("1d6[fire]", "1d6 огонь")], "Урон").map((b) => b.label), ["Урон: 1d6 огонь", "Урон: 1 огонь"]);
  assert.deepEqual(damageButtons([], "Урон"), []);
});

test("Пылающая колонна: урон опасной местности наносит зона правила — кнопка только основного урона, без подписи", () => {
  const rule = { onUse: { zone: { triggers: [{ on: "enter", apply: [{ to: "target", damage: { formula: "(2*floor((@actor.level-1)/3)+1)", damageType: "fire" } }] }] } } };
  const links = [link("{1d8[fire]}", "1d8 огонь", "(floor((@actor.level -1)/3)+1)d6[fire]"), link("{1[fire]}", "1 огонь", "(2*floor((@actor.level -1)/3)+1)[fire]")];
  assert.deepEqual(damageButtons(links, "Урон", ruleFormulas(rule)).map((b) => b.label), ["Урон"]);
  assert.equal(ruleFormulas(undefined).size, 0);
  assert.equal(normFormula(" 2d6 + 1 [fire]"), "2d6+1");
});

const { persistentOf, degreeOfLabel, planPersistent } = await import("../scripts/damage-button.mjs");
const TYPES = new Set(["bleed", "fire", "mental"]);

test("persistentOf: только чистый продолжительный урон; смешанный и обычный — null", () => {
  assert.deepEqual(persistentOf("{1d4[persistent,bleed]}", TYPES), { formula: "1d4", damageType: "bleed" });
  assert.deepEqual(persistentOf("{(2d6)[persistent,mental]}", TYPES), { formula: "2d6", damageType: "mental" });
  assert.deepEqual(persistentOf("{1d6[bleed,persistent]}", TYPES), { formula: "1d6", damageType: "bleed" });
  assert.equal(persistentOf("{1d8[fire]}", TYPES), null);
  assert.equal(persistentOf("{2d6[fire],1d4[persistent,fire]}", TYPES), null);
  assert.equal(persistentOf("{1d4[persistent,banana]}", TYPES), null);
});

test("degreeOfLabel: метка абзаца ru/en; не метка — null", () => {
  const names = [["Критический провал", "critical Failure"], ["Провал", "failure"], ["Успех", "success"], ["Критический успех", "critical Success"]];
  assert.equal(degreeOfLabel("Критический провал", names), 0);
  assert.equal(degreeOfLabel(" Провал: ", names), 1);
  assert.equal(degreeOfLabel("Critical Failure", names), 0);
  assert.equal(degreeOfLabel("Эффект", names), null);
});

test("planPersistent: по степени абзаца — только цели с этим итогом, без итога — ждут; без степени или испытания — всем", () => {
  const list = [{ key: "a", r: { degree: 1 } }, { key: "b", r: { degree: 2 } }, { key: "c" }];
  const keys = (p) => [p.apply.map((t) => t.key), p.waiting.map((t) => t.key)];
  assert.deepEqual(keys(planPersistent(list, [1], true)), [["a"], ["c"]]);
  assert.deepEqual(keys(planPersistent(list, [1, 2], true)), [["a", "b"], ["c"]]);   // одна формула в двух абзацах
  assert.deepEqual(keys(planPersistent(list, null, true)), [["a", "b", "c"], []]);
  assert.deepEqual(keys(planPersistent(list, [1], false)), [["a", "b", "c"], []]);
});

test("attackStage: до попадания урона нет; после урона или атаки по единственной цели — атак нет; multiTarget", async () => {
  const { attackStage, multiTarget } = await import("../scripts/damage-button.mjs");
  assert.deepEqual(attackStage({ attacks: 0, hits: 0, damages: 0, multi: false }), { hideDamage: true, hideAttack: false });
  assert.deepEqual(attackStage({ attacks: 1, hits: 0, damages: 0, multi: false }), { hideDamage: true, hideAttack: true });
  assert.deepEqual(attackStage({ attacks: 1, hits: 1, damages: 0, multi: true }), { hideDamage: false, hideAttack: false });
  assert.deepEqual(attackStage({ attacks: 2, hits: 1, damages: 1, multi: true }), { hideDamage: false, hideAttack: true });
  assert.equal(multiTarget("1 or 2 creatures"), true);
  assert.equal(multiTarget("1 или 2 существа"), true);
  assert.equal(multiTarget("1 creature"), false);
  assert.equal(multiTarget(""), false);
});

test("шаг урона: перезарядка не кнопка урона; формулы сравниваются без типов; повторный урон у поддерживаемых и атак по нескольким целям", () => {
  const rech = { dataset: { damageRoll: "", formula: "1d4", flavor: "Recharge Spirit Breath" }, textContent: "1d4" };
  assert.deepEqual(damageButtons([link("{9d8[spirit]}", "9d8"), rech], "Урон").map((b) => b.label), ["Урон"]);
  assert.equal(coreFormula("{6d8[fire]}"), "6d8");
  assert.equal(coreFormula("{(2d6 + 4)[slashing]}"), "2d6+4");
  // бросок pf2e: formula переведена («6d8 огонь + 2d6 холод»), части — в instances; сравниваем множества частей
  const roll = (...heads) => ({ formula: "6d8 огонь + 2d6 холод", instances: heads.map((h) => ({ head: { expression: h } })) });
  assert.equal(rolledCore(roll("6d8", "2d6")), coreFormula("{6d8[fire],2d6[cold]}"));
  assert.equal(rolledCore(roll("(2d6 + 4)")), coreFormula("{(2d6+4)[slashing]}"));
  assert.notEqual(rolledCore(roll("6d8")), coreFormula("{3d8[fire]}"));
  assert.equal(rolledCore(roll("9d8")), coreFormula("{9d8[spirit]}"));
  assert.equal(rolledCore(roll("2d6")), coreFormula("{2d6[precision,fire]}"));   // запятая внутри типов — не граница частей
  assert.notEqual(coreFormula("{6d8[fire]}"), coreFormula("3d8[fire]"));
  assert.equal(spellDamageDone({ damages: 1, sustained: false, multiAttack: false }), true);
  assert.equal(spellDamageDone({ damages: 0, sustained: false, multiAttack: false }), false);
  assert.equal(spellDamageDone({ damages: 2, sustained: true, multiAttack: false }), false);
  assert.equal(spellDamageDone({ damages: 1, sustained: false, multiAttack: true }), false);
});
