// Пак W1: таблица внешних точек (compat.EXTERNAL) и шёпот о непривязанном втором броске урона.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.game = { user: { isActiveGM: true }, users: [], modules: { get: () => null }, settings: { get: () => true }, i18n: { localize: (k) => k, format: (k) => k } };
const { EXTERNAL, externalProblems } = await import("../scripts/compat.mjs");
const bd = await import("../scripts/builtin/basic-damage.mjs");

const good = { "pf2e-toolbelt": "3.61.3", "xdy-pf2e-workbench": "7.7.5", pf2e: "8.7.0" };
const tpl = { [EXTERNAL.templates[0].path]: EXTERNAL.templates[0].needles.join(" ") };

test("externalProblems: совпало — пусто; не установлено — не расхождение", () => {
  assert.deepEqual(externalProblems(EXTERNAL, good, tpl), []);
  assert.deepEqual(externalProblems(EXTERNAL, { ...good, "pf2e-toolbelt": null }, tpl), []);
});

test("externalProblems: версия, пропавшая строка шаблона, шаблон не загрузился", () => {
  const v = externalProblems(EXTERNAL, { ...good, pf2e: "8.8.0" }, tpl);
  assert.equal(v.length, 1);
  assert.match(v[0], /pf2e 8\.8\.0/);
  assert.match(v[0], /spell-damage/);
  assert.equal(externalProblems(EXTERNAL, good, { [EXTERNAL.templates[0].path]: "<button>" }).length, EXTERNAL.templates[0].needles.length);
  assert.match(externalProblems(EXTERNAL, good, {})[0], /не загрузился/);
});

test("таблица: пути флагов и селекторы те, что ждут чужие модули", () => {
  assert.equal(EXTERNAL.flags.tbApplied("T1"), "flags.pf2e-toolbelt.targetHelper.applied.T1.0");
  assert.equal(EXTERNAL.selectors.spellDamage, "button[data-action='spell-damage']");
});

test("шаблон pf2e на диске (если установлен) содержит ожидаемые строки", { skip: !process.env.PF2E_DIR }, () => {
  const text = readFileSync(`${process.env.PF2E_DIR}/${EXTERNAL.templates[0].path.replace("systems/pf2e/", "")}`, "utf8");
  assert.deepEqual(externalProblems({ ...EXTERNAL, verified: {} }, {}, { [EXTERNAL.templates[0].path]: text }), []);
});

test("findCard: уже связанная карточка — onLinked один раз, результат null", () => {
  const m = { id: "C", timestamp: 1000, flags: { "pf2e-automato": { use: { actor: "A", slug: "fb", item: { uuid: "I", name: "Fireball" }, state: { basicDamage: { msg: "D1" } } } } } };
  const calls = [];
  const r = bd.findCard([m], { actor: "A", uuid: "I", slug: "fb", at: 2000, onLinked: (c, id) => calls.push([c.id, id]) });
  assert.equal(r, null);
  assert.deepEqual(calls, [["C", "D1"]]);
  // связь с удалённым уроном — карточка свободна, шёпота нет
  calls.length = 0;
  assert.equal(bd.findCard([m], { actor: "A", uuid: "I", at: 2000, exists: () => false, onLinked: () => calls.push(1) }), m);
  assert.equal(calls.length, 0);
});
