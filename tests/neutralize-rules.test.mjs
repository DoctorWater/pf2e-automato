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

import { existsSync, readFileSync } from "node:fs";
const { permanentOf, permanentSources, PERMANENT } = await import("../scripts/builtin/neutralize-rules.mjs");
const SLOWED = "Compendium.pf2e.conditionitems.Item.xYTAsEpcJE1Ccni3";
const slow = (o = {}) => ({ type: "action", slug: "slow", ...o });

test("permanentOf: Slow у NPC (action/feat) — запись; другой slug, не NPC, не способность — null", () => {
  assert.equal(permanentOf(slow(), "npc"), PERMANENT.slow);
  assert.equal(permanentOf(slow({ type: "feat" }), "npc"), PERMANENT.slow);
  assert.equal(permanentOf(slow(), "character"), null);
  assert.equal(permanentOf(slow({ slug: "slowing-pulse" }), "npc"), null);
  assert.equal(permanentOf(slow({ type: "weapon" }), "npc"), null);
});

test("permanentSources: GrantItem inMemoryOnly + NO_REACTIONS; у Slow с готовым GrantItem — только NO_REACTIONS", () => {
  const p = PERMANENT.slow;
  assert.deepEqual(permanentSources(p, []), [{ key: "RollOption", domain: "all", option: "af:no-reactions" }, { key: "GrantItem", uuid: SLOWED, inMemoryOnly: true }]);
  assert.deepEqual(permanentSources(p, [{ key: "GrantItem", uuid: SLOWED, inMemoryOnly: true }]).map((r) => r.key), ["RollOption"]);
  assert.deepEqual(permanentSources(p, [{ key: "GrantItem", uuid: "Compendium.pf2e.conditionitems.Item.other", inMemoryOnly: true }]).map((r) => r.key), ["RollOption", "GrantItem"]);   // чужой GrantItem выдаче Slowed не мешает
  assert.deepEqual(permanentSources(p, [], true).map((r) => r.key), ["RollOption"]);   // у существа уже есть документ Slowed (Ofalth Zombie)
});

test("wrapRules: Slow NPC получает синтетические правила через конструкторы pf2e; mode effect off и не-NPC — без них", () => {
  const built = [];
  game.pf2e = { RuleElements: { all: { RollOption: class { constructor(s, o) { built.push(["RollOption", s, o]); } }, GrantItem: class { constructor(s, o) { built.push(["GrantItem", s, o]); } } } } };
  game.settings = { get: () => "auto" };
  game.modules = { get: () => null };
  const parent = { ...slow(), name: "Slow", actor: { type: "npc" }, system: { rules: [] } };
  const out = wrapRules(() => [], { parent });
  assert.deepEqual(built.map((b) => b[0]), ["RollOption", "GrantItem"]);
  assert.equal(out.length, 2);
  assert.equal(built[1][2].parent, parent);
  assert.equal(built[1][2].sourceIndex, null);
  built.length = 0;
  assert.equal(wrapRules(() => [], { parent: { ...parent, actor: { type: "character" } } }).length, 0);
  game.settings = { get: (_m, k) => (k === "mode.effect" ? "off" : "auto") };
  assert.equal(wrapRules(() => [], { parent }).length, 0);
  assert.equal(built.length, 0);
  delete game.pf2e;
});

const ITEMS = new URL("../tools/out/items.json", import.meta.url);
test("корпус: Slow NPC — 77 док.: NO_REACTIONS всем, Slowed GrantItem только 63 без готового", { skip: !existsSync(ITEMS) }, () => {
  const all = JSON.parse(readFileSync(ITEMS, "utf8")).items.filter((i) => i.embedded && (i.type === "action" || i.type === "feat"));
  let docs = 0, grant = 0;
  for (const i of all) {
    const p = permanentOf(i, "npc");
    if (!p) continue;
    const n = i.dupCount || 1, own = i.ruleKeys.includes("GrantItem") ? [{ key: "GrantItem", uuid: p.grant }] : [];   // в корпусе только ключи: GrantItem у Slow считаем выдачей Slowed
    const s = permanentSources(p, own);
    docs += n;
    assert.ok(s.some((r) => r.option === "af:no-reactions"));
    if (s.some((r) => r.key === "GrantItem")) grant += n;
  }
  assert.equal(docs, 77);
  assert.equal(grant, 63);
});
