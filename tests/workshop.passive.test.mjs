import test from "node:test";
import assert from "node:assert/strict";
import { blockOf, readBlocks, emit, emitAll, validatePassive, readonlyRule, rulesOf as pRules } from "../scripts/workshop/passive.mjs";
import { rulesOf, hasRules, blankItem, validate } from "../scripts/workshop/item.mjs";
import { blankBlock } from "../scripts/workshop/effect.mjs";

const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
const SLOW = "Compendium.pf2e.conditionitems.Item.xYTAzLEKXQKUXlkN";
const ctx = { t, slugOf: (u) => (u === SLOW ? "slowed" : null), uuidOf: (s) => (s === "slowed" ? SLOW : null), ruleKnown: (k) => k !== "Mystery" };
const B = (kind, patch = {}) => ({ ...blankBlock(kind), ...patch });

const TYPED = [
  [{ key: "FlatModifier", selector: "ac", type: "status", value: 1 }, "bonus"],
  [{ key: "FlatModifier", selector: "saving-throw", type: "circumstance", value: -2 }, "bonus"],
  [{ key: "FlatModifier", selector: "all-speeds", type: "item", value: 10 }, "speed"],
  [{ key: "Resistance", type: "fire", value: 5 }, "resist"],
  [{ key: "Resistance", type: "physical", value: 5, exceptions: ["silver", "magic"] }, "resist"],
  [{ key: "TempHP", value: 5 }, "temphp"],
  [{ key: "FastHealing", value: 2 }, "fastheal"],
  [{ key: "DamageDice", selector: "strike-damage", diceNumber: 1, dieSize: "d6", damageType: "fire" }, "dmg"],
  [{ key: "Sense", selector: "darkvision" }, "sense"],
  [{ key: "Sense", selector: "scent", acuity: "imprecise", range: 30 }, "sense"],
  [{ key: "Sense", selector: "tremorsense", acuity: "vague", range: 10 }, "sense"],
  [{ key: "Note", selector: "saving-throw", title: "T", text: "x" }, "note"],
  [{ key: "Note", selector: "perception", text: "x" }, "note"],
  [{ key: "Aura", slug: "a", radius: 10, traits: [], effects: [] }, "aura"],
  [{ key: "Aura", radius: 15, traits: [], effects: [] }, "aura"],
  [{ key: "TokenLight", value: { bright: 20, dim: 40 } }, "light"],
  [{ key: "GrantItem", uuid: SLOW, inMemoryOnly: true }, "cond"],
  [{ key: "GrantItem", uuid: SLOW, inMemoryOnly: true, alterations: [{ mode: "override", property: "badge-value", value: 2 }] }, "cond"]
];

test("круговое преобразование: каждый вид свойства типизируется и собирается обратно", () => {
  for (const [rule, kind] of TYPED) {
    const b = blockOf(rule, ctx);
    assert.equal(b.kind, kind, JSON.stringify(rule));
    assert.deepEqual(pRules(b, ctx), [rule]);
  }
  assert.deepEqual(new Set(TYPED.map((x) => x[1])), new Set(["bonus", "speed", "resist", "temphp", "fastheal", "dmg", "sense", "note", "aura", "light", "cond"]));
});

const RAW = {
  "Сплочённость (ActiveEffectLike)": { key: "ActiveEffectLike", path: "system.x", mode: "override", value: 1 },
  predicate: { key: "FlatModifier", selector: "ac", type: "status", value: 1, predicate: [] },
  label: { key: "FlatModifier", selector: "ac", type: "status", value: 1, label: "L" },
  slug: { key: "Resistance", type: "fire", value: 5, slug: "s" },
  "подстановка": { key: "FlatModifier", selector: "{item|id}-damage", type: "status", value: 1 },
  "подстановка в тексте": { key: "Note", selector: "ac", text: "{actor|level}" },
  "массив селектора": { key: "FlatModifier", selector: ["ac", "will"], type: "status", value: 1 },
  "формула": { key: "FlatModifier", selector: "ac", type: "status", value: "@actor.level" },
  "нуль": { key: "FlatModifier", selector: "ac", type: "status", value: 0 },
  "не из списка": { key: "FlatModifier", selector: "will", type: "proficiency", value: 1 },
  "тип не из списка": { key: "Resistance", type: "weird", value: 5 },
  "строка вместо числа": { key: "TempHP", value: "5" },
  ChoiceSet: { key: "ChoiceSet", choices: [], prompt: "x" },
  "GrantItem без inMemoryOnly": { key: "GrantItem", uuid: SLOW },
  "GrantItem неизвестное состояние": { key: "GrantItem", uuid: "Compendium.pf2e.conditionitems.Item.zzz", inMemoryOnly: true },
  "Aura с эффектами": { key: "Aura", radius: 10, traits: [], effects: [{ uuid: "x" }] },
  Weakness: { key: "Weakness", type: "fire", value: 5 }
};

test("всё остальное уходит в raw с исходным объектом", () => {
  for (const [name, rule] of Object.entries(RAW)) {
    const [b] = readBlocks([rule], ctx);
    assert.equal(b.kind, "raw", name);
    assert.equal(b.json, JSON.stringify(rule, null, 2));
    assert.equal(emit(b, ctx)[0], b.orig, name);
  }
});

test("read-only: ChoiceSet и GrantItem без inMemoryOnly", () => {
  assert.ok(blockOf(RAW.ChoiceSet, ctx).ro);
  assert.ok(blockOf(RAW["GrantItem без inMemoryOnly"], ctx).ro);
  assert.ok(!blockOf(RAW["GrantItem неизвестное состояние"], ctx).ro);
  assert.ok(!blockOf(RAW.predicate, ctx).ro);
  assert.ok(readonlyRule({ key: "ChoiceSet" }) && !readonlyRule({ key: "TempHP" }));
});

test("emit: набор без правок совпадает байт в байт, порядок ключей и форма чисел сохранены", () => {
  const rules = [
    JSON.parse('{"value":1,"type":"status","selector":"ac","key":"FlatModifier"}'),
    JSON.parse('{"key":"Resistance","value":5.0,"type":"fire"}'),
    RAW.ChoiceSet, RAW["Сплочённость (ActiveEffectLike)"], { key: "NoSuchThingKeyless" }, { foo: 1 }
  ];
  const blocks = readBlocks(rules, ctx);
  assert.equal(JSON.stringify(emitAll(blocks, ctx)), JSON.stringify(rules));
  blocks.forEach((b, i) => assert.equal(emit(b, ctx)[0], rules[i]));
});

test("emit: правка меняет только свой блок; новый блок без orig; массив в изменённом raw", () => {
  const rules = [{ key: "TempHP", value: 5 }, RAW.predicate];
  const blocks = readBlocks(rules, ctx);
  blocks[0].value = 8;
  assert.deepEqual(emitAll(blocks, ctx), [{ key: "TempHP", value: 8 }, RAW.predicate]);
  assert.equal(emit(blocks[1], ctx)[0], rules[1]);
  blocks[1].json = '[{"key":"A"},{"key":"B"}]';
  assert.deepEqual(emit(blocks[1], ctx), [{ key: "A" }, { key: "B" }]);
  assert.deepEqual(emit(B("fastheal"), ctx), [{ key: "FastHealing", value: 2 }]);
});

test("cond: всегда GrantItem с inMemoryOnly, без onDeleteActions", () => {
  const r = pRules(B("cond", { slug: "slowed", valued: true, value: 2 }), ctx);
  assert.equal(r[0].inMemoryOnly, true);
  assert.ok(!("onDeleteActions" in r[0]));
  assert.equal(r[0].alterations[0].value, 2);
  assert.equal(r[0].uuid, SLOW);
});

test("validatePassive: пустой список допустим; неизменённые блоки пропускаются; изменённые и новые проверяются", () => {
  assert.deepEqual(validatePassive([], ctx), []);
  const mystery = { key: "Mystery" };
  const blocks = readBlocks([mystery, { key: "TempHP", value: 5 }], ctx);
  assert.deepEqual(validatePassive(blocks, ctx), []);
  blocks[0].json = '{"key":"Mystery","x":1}';
  assert.match(validatePassive(blocks, ctx)[0], /"n":1/);
  blocks[0].json = JSON.stringify(mystery, null, 2);
  blocks[1].value = 0;
  assert.match(validatePassive(blocks, ctx)[0], /"n":2/);
  assert.equal(validatePassive(readBlocks([RAW.ChoiceSet], ctx), ctx).length, 0);
  assert.ok(validatePassive([B("raw", { json: JSON.stringify({ key: "GrantItem", uuid: SLOW }) })], ctx).length);   // новый GrantItem без inMemoryOnly
  assert.ok(validatePassive([B("cond", { uuid: "Item.x", name: "Эффект" })], ctx).length);   // эффект вместо состояния
});

test("мастер предмета: пассивные действия и черты пишут правила, активные — нет", () => {
  const M = (type, act, blocks) => ({ ...blankItem(type), name: "X", act: { type: act, actions: 1 }, blocks });
  const blocks = [B("temphp"), B("cond", { slug: "slowed" })];
  for (const type of ["action", "feat"]) {
    const m = M(type, "passive", blocks);
    assert.ok(hasRules(m));
    const r = rulesOf(m, ctx);
    assert.equal(r.length, 2);
    assert.equal(r[1].inMemoryOnly, true);
    assert.equal(rulesOf(M(type, "action", blocks), ctx).length, 0);
  }
  const eq = rulesOf(M("equipment", "passive", blocks), ctx);
  assert.equal(eq[1].inMemoryOnly, true);
  assert.deepEqual(rulesOf(M("consumable", "passive", blocks), ctx), []);
  const bad = M("feat", "passive", [B("cond", { uuid: "Item.x", name: "Э" })]);
  assert.ok(validate(bad, ctx).some((e) => e.includes("condEffect")));
});

// ---- условие, «чем бьёт», селектор скорости: круг чтения ----
const DEAF = "Compendium.pf2e.conditionitems.Item.deaf";
const cctx = { ...ctx, slugOf: (u) => (u === SLOW ? "slowed" : u === DEAF ? "deafened" : null), uuidOf: (s) => (s === "slowed" ? SLOW : s === "deafened" ? DEAF : null) };
const P = (r, predicate) => ({ ...r, predicate });
const FIX = [
  // [правило, вид, ожидаемое when]
  [P({ key: "Resistance", type: "physical", value: 5 }, [{ lt: ["hp-percent", 50] }]), "resist", '[{"lt":["hp-percent",50]}]'],   // Abandon Armor
  [P({ key: "GrantItem", uuid: DEAF, inMemoryOnly: true }, ["self:condition:deafened"]), "cond", "self:condition:deafened"],
  [P({ key: "DamageDice", selector: "strike-damage", diceNumber: 1, dieSize: "d6", damageType: "spirit" }, ["target:mode:undead"]), "dmg", "target:mode:undead"],
  [P({ key: "FlatModifier", selector: "saving-throw", type: "circumstance", value: 1 }, ["item:trait:mental"]), "bonus", "item:trait:mental"],
  [P({ key: "FlatModifier", selector: "attack-roll", type: "circumstance", value: 1 }, ["rage", { not: "self:effect:calm" }]), "bonus", '["rage",{"not":"self:effect:calm"}]'],
  [P({ key: "FlatModifier", selector: "damage", type: "status", value: 2 }, [{ or: ["a", { lt: ["hp-percent", 25] }] }]), "bonus", '[{"or":["a",{"lt":["hp-percent",25]}]}]'],
  [P({ key: "TempHP", value: 5 }, ["self:condition:prone", "x,y"]), "temphp", '["self:condition:prone","x,y"]'],   // строка с запятой — только через JSON
  [P({ key: "Note", selector: "saving-throw", text: "x" }, ["item:trait:fear"]), "note", "item:trait:fear"],
  [P({ key: "Sense", selector: "scent", acuity: "imprecise", range: 30 }, ["self:condition:x"]), "sense", "self:condition:x"],
  [P({ key: "FastHealing", value: 5 }, [{ gte: ["hp-percent", 10] }]), "fastheal", '[{"gte":["hp-percent",10]}]'],
  [P({ key: "FlatModifier", selector: "all-speeds", type: "status", value: -10 }, ["self:condition:slowed"]), "speed", "self:condition:slowed"]
];

test("круг с условием: правило с predicate становится типизированным с when и собирается один в один", () => {
  for (const [rule, kind, when] of FIX) {
    const b = blockOf(rule, cctx);
    assert.equal(b.kind, kind, JSON.stringify(rule));
    assert.equal(b.when, when);
    assert.deepEqual(pRules(b, cctx), [rule]);
    assert.equal(emit(readBlocks([rule], cctx)[0], cctx)[0], rule);   // не тронутый — тот же объект
  }
});

test("круг с условием: чужое условие не теряется — raw", () => {
  const base = { key: "FlatModifier", selector: "ac", type: "status", value: 1 };
  for (const p of [[], [" x "], ["a", ""], [{ gt: ["", 1] }], "rage", [{ foo: 1 }], ["{actor|x}"], ["{item|id}-x"]]) {
    const rule = { ...base, predicate: p }, [b] = readBlocks([rule], cctx);
    assert.equal(b.kind, "raw", JSON.stringify(p));
    assert.equal(emit(b, cctx)[0], rule);
  }
  // виды без условия: aura, light
  assert.equal(blockOf({ key: "TokenLight", value: { bright: 20, dim: 40 }, predicate: ["x"] }, cctx).kind, "raw");
  assert.equal(blockOf({ key: "Aura", radius: 10, traits: [], effects: [], predicate: ["x"] }, cctx).kind, "raw");
});

test("правка условия: смена when — новое правило, очистка — без predicate, неизменённое — байт в байт", () => {
  const rule = P({ key: "Resistance", type: "fire", value: 5 }, ["self:condition:prone"]);
  const [b] = readBlocks([rule], cctx);
  b.when = "target:mode:undead";
  assert.deepEqual(emit(b, cctx), [P({ key: "Resistance", type: "fire", value: 5 }, ["target:mode:undead"])]);
  b.when = "";
  assert.deepEqual(emit(b, cctx), [{ key: "Resistance", type: "fire", value: 5 }]);
  const [u] = readBlocks([rule], cctx);
  assert.equal(emit(u, cctx)[0], rule);
  // validatePassive: свежее неподходящее условие — ошибка, нетронутое — нет
  assert.deepEqual(validatePassive([u], cctx), []);
  const bad = readBlocks([{ key: "TempHP", value: 5 }], cctx);
  bad[0].when = "target:mode:undead";
  assert.match(validatePassive(bad, cctx)[0], /whenRoll/);
});

test("круг: «чем бьёт» и селектор скорости (jaws, land-speed, speed — типизированы; родовые — raw)", () => {
  const D = (selector) => ({ key: "DamageDice", selector, diceNumber: 1, dieSize: "d6", damageType: "fire" });
  const F = (selector) => ({ key: "FlatModifier", selector, type: "status", value: 1 });
  const typed = [[D("jaws-damage"), "dmg", "jaws"], [F("jaws-attack"), "bonus", "jaws"], [F("jaws-damage"), "bonus", "jaws"], [D("strike-damage"), "dmg", ""], [F("land-speed"), "speed", undefined], [F("fly-speed"), "speed", undefined], [F("speed"), "speed", undefined], [F("all-speeds"), "speed", undefined]];
  for (const [rule, kind, strike] of typed) {
    const b = blockOf(rule, cctx);
    assert.equal(b.kind, kind, rule.selector);
    if (strike !== undefined) assert.equal(b.strike, strike);
    assert.deepEqual(pRules(b, cctx), [rule], rule.selector);
  }
  assert.equal(blockOf(F("speed"), cctx).sel, "speed");
  for (const rule of [D("melee-strike-damage"), D("damage"), F("str-attack"), F("dex-attack"), F("melee-attack"), F("strike-damage"), F("jaws-damage-base"), F("{item|id}-damage"), D("melee-damage")]) assert.equal(blockOf(rule, cctx).kind, "raw", rule.selector);
  // правка «чем бьёт» меняет селектор
  const [b] = readBlocks([D("jaws-damage")], cctx);
  b.strike = "kick";
  assert.equal(emit(b, cctx)[0].selector, "kick-damage");
  b.strike = "";
  assert.equal(emit(b, cctx)[0].selector, "strike-damage");
});
