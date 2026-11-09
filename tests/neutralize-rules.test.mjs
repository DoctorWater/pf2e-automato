import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { shouldNeutralize, ownedOptions, REGISTRY, wrapRules, neutralizedOf, setReady } = await import("../scripts/builtin/neutralize-rules.mjs");

const owned = new Set(["pack-attack"]);
const roll = (o = {}) => ({ key: "RollOption", toggleable: true, option: "pack-attack", ...o });

test("shouldNeutralize: переключаемый RollOption с опцией из реестра", () => {
  assert.equal(shouldNeutralize(roll(), owned), true);
  assert.equal(shouldNeutralize(roll({ toggleable: "totm" }), owned), false);   // totm pf2e гасит сам
});

test("shouldNeutralize: не переключаемый, чужая опция и другие правила не гасятся", () => {
  assert.equal(shouldNeutralize(roll({ toggleable: false }), owned), false);
  assert.equal(shouldNeutralize(roll({ option: "rage" }), owned), false);
  assert.equal(shouldNeutralize({ key: "DamageDice", option: "pack-attack", toggleable: true }, owned), false);
  assert.equal(shouldNeutralize({ key: "BaseSpeed", selector: "fly" }, owned), false);
  assert.equal(shouldNeutralize(null, owned), false);
  assert.equal(shouldNeutralize(roll(), null), false);
});

test("shouldNeutralize: режим off и уступка — переключатель остаётся", () => {
  assert.equal(shouldNeutralize(roll(), owned, "off"), false);
  assert.equal(shouldNeutralize(roll(), new Set()), false);
});

test("ownedOptions: режим macro off гасит только опции macro и наоборот; не готовый вид пропускается", () => {
  const kinds = (get, ready) => new Set([...ownedOptions(get, ready)].map((o) => REGISTRY[o]));
  assert.deepEqual([...kinds(() => "auto", () => true)].sort(), ["computed", "macro"]);
  assert.deepEqual([...kinds((k) => (k === "macro" ? "off" : "auto"), () => true)], ["computed"]);
  assert.deepEqual([...kinds((k) => (k === "computed" ? "off" : "auto"), () => true)], ["macro"]);
  assert.equal(ownedOptions(() => "off", () => true).size, 0);
  assert.deepEqual([...kinds(() => "auto", (k) => k !== "computed")], ["macro"]);
});

test("wrapRules: гасит переключатель, ведёт метки, не трогает чужое; уступка и неготовый вид — без гашения", () => {
  const item = { slug: "pack-attack", actor: {}, _stats: {} };
  const mkRules = () => [{ key: "RollOption", toggleable: true, option: "pack-attack", item }, { key: "RollOption", toggleable: true, option: "rage", item }, { key: "DamageDice", item }];
  setReady("computed", true);
  game.settings = { get: () => "auto" };   // mode.* и yieldToAutomations
  game.modules = { get: () => null };
  const r1 = wrapRules(() => mkRules());
  assert.deepEqual(r1.map((r) => !!r.ignored), [true, false, false]);
  assert.deepEqual([...neutralizedOf(item.actor).get("pack-attack")], [item]);
  setReady("computed", false);
  assert.deepEqual(wrapRules(() => mkRules()).map((r) => !!r.ignored), [false, false, false]);
  setReady("computed", true);
});
