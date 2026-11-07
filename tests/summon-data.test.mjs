// S1: данные призыва (rules/summons.json, генератор), таблица уровней, индекс кандидатов, оверлей и валидатор onUse.summon.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = {};
globalThis.game = { user: { isActiveGM: true, id: "gm" }, settings: { get: (m, k) => settings[k] }, i18n: { localize: (k) => k, format: (k) => k }, packs: [] };
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };

const rules = await import("../scripts/rules.mjs");
const idx = await import("../scripts/summon-index.mjs");
const gen = await import("../tools/summons.mjs");
const data = JSON.parse(readFileSync(new URL("../rules/summons.json", import.meta.url), "utf8"));

test("levelFor: таблица черты и своя таблица с потолком", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((r) => idx.levelFor(r)), [-1, 1, 2, 3, 5, 7, 9, 11, 13, 15]);
  const servitor = data.bySource["Compendium.pf2e.spells-srd.Item.B0FZLkoHsiRgw7gv"];
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((r) => idx.levelFor(r, servitor.levels)), [-1, 1, 2, 3, 3, 3]);
  assert.equal(idx.levelFor(0, servitor.levels), null);
});

test("генератор: 14 заклинаний spells-srd, признаки по тексту", () => {
  assert.equal(Object.keys(data.bySource).length, 14);
  const traits = Object.values(data.bySource).map((e) => e.traits?.join("+"));
  assert.ok(traits.includes("plant+fungus") && traits.includes("undead") && traits.includes("aberration") && traits.includes("celestial+fiend+monitor+animal"));
  assert.ok(Object.values(data.bySource).some((e) => e.uuid === "Compendium.pf2e.pathfinder-bestiary.Actor.j7NNPfZwD19BwSEZ"));
  for (const s of ["summon-anarch", "summon-axiom", "oliphaunt", "call-ursine-ally"]) assert.ok(data.exceptions[s], s);
  assert.equal(data.exceptions["summon-animal"], undefined);   // тёзка-действие в бестиарии не затирает размеченное заклинание
});

test("генератор: summonOf сверяет текст с таблицей и не угадывает", () => {
  const sp = (descEn, rank, slug = "x") => ({ slug, rank, descEn });
  assert.deepEqual(gen.summonOf(sp("You summon a creature that has the plant or fungus trait and whose level is -1 to fight", 1)), { traits: ["plant", "fungus"] });
  assert.deepEqual(gen.summonOf(sp("You summon a creature that has the fiend trait and whose level is 5 or lower", 5)), { traits: ["fiend"] });
  assert.match(gen.summonOf(sp("You summon a creature that has the fiend trait and whose level is 4 or lower", 5)).skip, /таблиц/);
  assert.match(gen.summonOf(sp("You conjure something", 1)).skip, /не распознано/);
  const { exceptions, bySource } = gen.buildSummons([{ slug: "some-action", type: "action", pack: "x", traits: ["summon"] }, { slug: "oliphaunt", type: "feat", pack: "x", traits: ["summon"] }]);
  assert.equal(exceptions["some-action"].startsWith("способность"), true);
  assert.deepEqual(bySource, {});
});

const entry = (uuid, name, level, traits, o = {}) => ({ uuid, name, level, traits, type: "npc", rarity: "common", img: `${name}.png`, ...o });
const INDEX = [
  entry("u1", "Zombie Shambler", -1, ["undead", "mindless"]), entry("u2", "Skeleton Guard", -1, ["undead"]), entry("u3", "Ghoul", 1, ["undead", "ghoul"]),
  entry("u4", "Wolf", 1, ["animal"]), entry("u5", "Rare Lich", -1, ["undead"], { rarity: "rare" }), entry("u6", "Haunt", -1, ["undead"], { type: "hazard" }),
  entry("u7", "Treant Sapling", -1, ["plant"]), entry("u8", "Mold", -1, ["fungus"])
];

test("filterIndex: npc, common, ИЛИ по признакам, уровень, сортировка", () => {
  assert.deepEqual(idx.filterIndex(INDEX, { traits: ["undead"], maxLevel: -1 }).map((e) => e.name), ["Skeleton Guard", "Zombie Shambler"]);
  assert.deepEqual(idx.filterIndex(INDEX, { traits: ["undead"], maxLevel: 1 }).map((e) => e.name), ["Ghoul", "Skeleton Guard", "Zombie Shambler"]);
  assert.deepEqual(idx.filterIndex(INDEX, { traits: ["plant", "fungus"], maxLevel: -1 }).map((e) => e.name), ["Mold", "Treant Sapling"]);
  assert.deepEqual(Object.keys(idx.filterIndex(INDEX, { traits: ["animal"], maxLevel: 5 })[0]).sort(), ["img", "level", "name", "original", "token", "traits", "uuid"]);   // original — английское имя (babele) для подбора картинки Nexus
  assert.deepEqual(idx.filterIndex(INDEX, { uuid: "u5" }).map((e) => e.uuid), ["u5"]);
});

const fakePack = (collection, rows, perm = true) => ({
  collection, documentName: "Actor", metadata: { packageName: "pf2e", name: collection.split(".")[1] }, testUserPermission: () => perm,
  getIndex: async () => rows.map((r) => ({ _id: r.id, name: r.name, img: "i.png", type: r.type ?? "npc", system: { traits: { value: r.traits, rarity: r.rarity ?? "common" }, details: { level: { value: r.level } } } }))
});

beforeEach(() => { delete settings["summon.packs"]; });

test("summonPacks и candidates: настройка, бестиарии по умолчанию, права, кэш", async () => {
  let calls = 0;
  const a = fakePack("pf2e.pathfinder-bestiary", [{ id: "A", name: "Zed", level: -1, traits: ["undead"] }, { id: "B", name: "Lich", level: -1, traits: ["undead"], rarity: "unique" }]);
  const origGet = a.getIndex; a.getIndex = async (...x) => { calls++; return origGet(...x); };
  const b = fakePack("world.mine", [{ id: "C", name: "Mine", level: 0, traits: ["undead"] }]);
  const hidden = fakePack("pf2e.monster-core", [{ id: "D", name: "Hidden", level: -1, traits: ["undead"] }], false);
  const other = { collection: "pf2e.spells-srd", documentName: "Item", metadata: { packageName: "pf2e", name: "spells-srd" } };
  const packs = [a, b, hidden, other]; packs.get = (id) => packs.find((p) => p.collection === id);
  game.packs = packs;
  game.pf2e = { compendiumBrowser: { loadedPacks: () => ["pf2e.pathfinder-bestiary", "pf2e.monster-core"] } };
  assert.deepEqual(idx.summonPacks(), ["pf2e.pathfinder-bestiary", "pf2e.monster-core"]);
  assert.deepEqual((await idx.candidates({ traits: ["undead"], maxLevel: 0 })).map((e) => e.uuid), ["Compendium.pf2e.pathfinder-bestiary.Actor.A"]);   // нет доступа к monster-core, rarity unique отсеян
  await idx.candidates({ traits: ["undead"], maxLevel: 0 });
  assert.equal(calls, 1);
  settings["summon.packs"] = ["world.mine", "pf2e.spells-srd", "gone"];
  assert.deepEqual(idx.summonPacks(), ["world.mine"]);   // только Actor-компендиумы, существующие
  assert.deepEqual((await idx.candidates({ traits: ["undead"], maxLevel: 0 })).map((e) => e.name), ["Mine"]);
  game.pf2e = undefined;
  delete settings["summon.packs"];
  assert.deepEqual(idx.summonPacks(), ["pf2e.pathfinder-bestiary", "pf2e.monster-core"]);   // браузера pf2e нет — бестиарии системы по имени
  game.packs = [];
  assert.deepEqual(await idx.candidates({ traits: ["undead"], maxLevel: 0 }), []);
});

const SRC = "Compendium.pf2e.spells-srd.Item.SUMMONSUMMONSUMM";
const doc = (flags = {}) => ({ type: "spell", slug: "summon-x", name: "S", system: {}, _stats: { compendiumSource: SRC }, flags, actor: { level: 1 } });
const SUMMON = { traits: ["undead"] };
const base = { v: 1, onUse: { targets: "self" } };

test("оверлей summons.json: нижний слой, правило и флаг перекрывают; summonEntry без правила", () => {
  rules.initCatalog([{ v: 1, bySource: { [SRC]: base } }], null);
  rules.initOverlays(null, null, { v: 1, bySource: { [SRC]: SUMMON } });
  assert.deepEqual(rules.resolveRule(doc()).rule.onUse.summon, SUMMON);
  assert.equal(base.onUse.summon, undefined);
  rules.initCatalog([{ v: 1, bySource: { [SRC]: { ...base, onUse: { ...base.onUse, summon: { traits: ["fey"] } } } } }], null);
  assert.deepEqual(rules.resolveRule(doc()).rule.onUse.summon, { traits: ["fey"] });
  const flag = { v: 1, onUse: { targets: "self", summon: { uuid: "Compendium.pf2e.x.Actor.A", count: 2 } } };
  assert.deepEqual(rules.summonEntry(doc({ "pf2e-automato": { rule: flag } })), { uuid: "Compendium.pf2e.x.Actor.A", count: 2 });
  rules.initCatalog([], null);
  assert.deepEqual(rules.summonEntry(doc()), SUMMON);
});

test("валидатор onUse.summon", () => {
  const v = (summon) => rules.validateRule({ v: 1, onUse: { targets: "self", summon } });
  const ok = v({ traits: ["plant", "fungus"], levels: { 1: -1, 4: 3 }, count: 2 });
  assert.deepEqual(ok.rule.onUse.summon, { traits: ["plant", "fungus"], levels: { 1: -1, 4: 3 }, count: 2 });
  assert.equal(v({ uuid: "Compendium.pf2e.x.Actor.A" }).rule.onUse.summon.uuid, "Compendium.pf2e.x.Actor.A");
  for (const bad of [{}, { traits: [] }, { traits: ["a"], uuid: "Compendium.x" }, { uuid: "Actor.x" }, { traits: ["a"], levels: { x: 1 } }, { traits: ["a"], levels: {} }, { traits: ["a"], count: 0 }, { traits: ["a"], count: 9 }, "undead"]) {
    assert.ok(v(bad).errors?.length, JSON.stringify(bad));
  }
});
