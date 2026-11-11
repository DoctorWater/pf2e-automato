// Мгновенные области карточек модуля: какой регион убирать и когда (area-cleanup.mjs, чистые части).
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true }, users: [], modules: { get: () => null }, settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k } };
const { hasDuration, managesArea, instantArea, areaSettled } = await import("../scripts/area-cleanup.mjs");

const on = () => "auto", off = () => "off";
const byDegree = { criticalFailure: [{ condition: { slug: "frightened" } }], failure: [{ condition: { slug: "frightened" } }], success: [], criticalSuccess: [] };
const mk = (onUse = {}, state = {}, extra = {}) => ({ kind: "use", rule: { onUse: { targets: "area", challenge: { byDegree }, ...onUse } }, state, ...extra });
const spell = (value, sustained) => ({ system: { duration: { value, sustained } } });

test("hasDuration: пусто/0/instantaneous — мгновенная; срок и sustained — нет", () => {
  for (const d of [undefined, {}, { value: "" }, { value: "0" }, { value: "Instantaneous" }, { value: "", sustained: false }]) assert.equal(hasDuration(d), false);
  for (const d of [{ value: "1 minute" }, { value: "until the end of your next turn" }, { value: "", sustained: true }]) assert.equal(hasDuration(d), true);
});

test("instantArea: мгновенная / зона / Поддержание / срок предмета / чужая", () => {
  assert.equal(instantArea(mk(), spell(""), on), true, "мгновенная область модуля");
  assert.equal(instantArea(mk(), null, on), true, "предмета нет (способность без срока)");
  assert.equal(instantArea(mk({ zone: { duration: { rounds: 1 } } }), spell(""), on), false, "зона с длительностью — ведёт zone.mjs");
  assert.equal(instantArea(mk({ pulse: "same" }), spell(""), on), false, "импульс Поддержания");
  assert.equal(instantArea(mk(), spell("1 minute"), on), false, "у предмета срок");
  assert.equal(instantArea(mk(), spell("", true), on), false, "Поддержание");
  assert.equal(instantArea(mk({}, { yielded: true }), spell(""), on), false, "уступка pf2e-automations");
  assert.equal(instantArea(mk(), spell(""), off), false, "режимы выключены — область не наша");
  assert.equal(instantArea(mk({ targets: "selected" }), spell(""), on), false, "не область");
  assert.equal(instantArea({ kind: "use", rule: { onUse: { targets: "area" } }, state: {} }, spell(""), on), false, "нечего вести — цели не берёт модуль");
});

test("managesArea: шаги на цель без испытания тоже ведёт модуль", () => {
  const u = { kind: "use", rule: { onUse: { targets: "area", apply: [{ to: "target", condition: { slug: "slowed" } }] } }, state: {} };
  assert.equal(managesArea(u, on), true);
  assert.equal(managesArea(u, (k) => (k === "effect" ? "off" : "auto")), false);
});

const area = { keys: ["a", "b"] };
const res = (d) => ({ degree: d });

test("areaSettled: ждёт результаты всех целей", () => {
  const use = mk({}, { area, challenge: { results: { a: res(1) } } });
  assert.equal(areaSettled(use, { targets: ["a", "b"], resolved: false }), false);
  use.state.challenge.results.b = res(2);
  assert.equal(areaSettled(use, { targets: ["a", "b"], resolved: true }), false, "у провала a шаг ещё не применён");
  assert.equal(areaSettled(use, { targets: ["a", "b"], resolved: true, afterApply: true }), true, "авто-применение отработало");
  use.state.challenge.applied = { a: { ops: [{}] } };
  assert.equal(areaSettled(use, { targets: ["a", "b"], resolved: true }), true, "кнопкой применили (у b шагов нет)");
});

test("areaSettled: пока нет области/низкая уверенность/урон не отследить — нет", () => {
  assert.equal(areaSettled(mk({}, {}), { resolved: true }), false);
  assert.equal(areaSettled(mk({}, { area, challenge: { results: {} } }, { confidence: "low" }), { targets: [], afterApply: true }), false);
  const use = mk({}, { area, challenge: { results: { a: res(2), b: res(2) } } });
  assert.equal(areaSettled(use, { targets: ["a", "b"], damage: "untracked" }), false);
});

test("areaSettled: урон — после нанесения всем целям, не после спасбросков", () => {
  const use = mk({}, { area, challenge: { results: { a: res(2), b: res(3) } } });
  const o = { targets: ["a", "b"], resolved: true, damage: "tracked" };
  assert.equal(areaSettled(use, o), false, "урон не брошен");
  assert.equal(areaSettled(use, { ...o, link: { done: { a: { taken: "x" } } } }), false, "нанесено не всем");
  assert.equal(areaSettled(use, { ...o, link: { done: { a: { taken: "x" }, b: { reverted: true } } } }), false, "откат — не нанесено");
  assert.equal(areaSettled(use, { ...o, link: { done: { a: { taken: "x" }, b: { skipped: true } } } }), true);
});

test("areaSettled: шаги на цель без испытания — после применения", () => {
  const use = { kind: "use", rule: { onUse: { targets: "area", apply: [{ to: "target" }] } }, state: { area } };
  assert.equal(areaSettled(use, { targets: ["a", "b"] }), false);
  use.state.apply = { a: { ops: [{}] }, b: { ops: [{}] } };
  assert.equal(areaSettled(use, { targets: ["a", "b"] }), true);
  assert.equal(areaSettled({ ...use, state: { area } }, { targets: ["a", "b"], afterTarget: true }), true);
  assert.equal(areaSettled({ ...use, state: { area } }, { targets: ["a", "b"], afterApply: true }), false, "apply=auto шаги на цель не исполняет (их ведёт effect)");
});

test("areaSettled: проверка автора (check) ждётся, как испытание; ожидающие derived — нет", () => {
  const use = { kind: "use", rule: { onUse: { targets: "area", check: { statistic: "athletics", byDegree } } }, state: { area, challenge: { results: { a: res(2) } } } };
  assert.equal(areaSettled(use, { targets: ["a"], resolved: false }), false, "броска проверки ещё нет");
  assert.equal(areaSettled(use, { targets: ["a"], resolved: true }), true);
  use.state.derived = { pending: ["u0"] };
  assert.equal(areaSettled(use, { targets: ["a"], resolved: true }), false, "ждут кнопки «Применить»");
});
