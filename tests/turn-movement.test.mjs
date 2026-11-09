import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { endsOn, optionOf } = await import("../scripts/builtin/turn-flight.mjs");
const { FLIGHT, REGISTRY, shouldNeutralize, ownedOptions } = await import("../scripts/builtin/neutralize-rules.mjs");

const mv = (actions, o = {}) => ({ method: "dragging", passed: { waypoints: actions.map((action) => ({ action })) }, pending: { waypoints: [] }, destination: { action: actions.at(-1) }, ...o });

test("endsOn: любой завершённый вид движения pf2e заканчивает полёт", () => {
  for (const a of ["walk", "fly", "swim", "climb", "burrow", "crawl", "step"]) assert.equal(endsOn(mv([a])), true, a);
  for (const m of ["dragging", "keyboard", "api"]) assert.equal(endsOn(mv(["fly"], { method: m })), true, m);
});

test("endsOn: displace, blink, правка ГМа и откат не считаются", () => {
  assert.equal(endsOn(mv(["displace"])), false);
  assert.equal(endsOn(mv(["blink"])), false);
  assert.equal(endsOn(mv(["blink", "displace"])), false);
  assert.equal(endsOn(mv(["walk", "blink"])), true);   // был и настоящий отрезок
  for (const m of ["config", "paste", "undo"]) assert.equal(endsOn(mv(["fly"], { method: m })), false, m);
});

test("endsOn: незавершённое движение, пустой путь и мусор", () => {
  assert.equal(endsOn(mv(["fly"], { pending: { waypoints: [{ action: "fly" }] } })), false);
  assert.equal(endsOn({ method: "dragging", passed: { waypoints: [] }, destination: { action: "fly" } }), true);   // тип — по месту назначения
  assert.equal(endsOn({ method: "dragging", passed: { waypoints: [] } }), false);
  assert.equal(endsOn(null), false);
  assert.equal(endsOn(undefined), false);
});

test("группа A: 8 фитов, опция = slug, все в реестре под mode.macro", () => {
  assert.equal(FLIGHT.length, 8);
  for (const s of FLIGHT) { assert.equal(REGISTRY[s], "macro", s); assert.equal(optionOf({ type: "feat", slug: s }), s); }
  assert.equal(optionOf({ type: "feat", slug: "zip-zoom" }), null);
  assert.equal(optionOf({ type: "effect", slug: "take-wing" }), null);
  assert.equal(optionOf(null), null);
});

test("нейтрализация полёта: переключатель take-wing гасится, BaseSpeed и опция эффекта — нет; режим macro off возвращает переключатель", () => {
  const owned = ownedOptions((k) => (k === "macro" ? "auto" : "off"));
  assert.ok(owned.has("take-wing") && !owned.has("pack-attack"));
  const toggle = { key: "RollOption", toggleable: true, option: "take-wing" };
  assert.equal(shouldNeutralize(toggle, owned), true);
  assert.equal(shouldNeutralize({ key: "RollOption", option: "take-wing", domain: "all" }, owned), false);   // эффект модуля
  assert.equal(shouldNeutralize({ key: "BaseSpeed", selector: "fly", value: 15 }, owned), false);
  assert.equal(ownedOptions((k) => (k === "macro" ? "off" : "auto")).has("take-wing"), false);
});
