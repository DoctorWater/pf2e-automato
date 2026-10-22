import { test } from "node:test";
import assert from "node:assert/strict";

const whispers = [];
globalThis.game = { user: { isActiveGM: true }, i18n: { localize: (k) => k, format: (k) => k }, users: [] };
globalThis.ChatMessage = { create: (d) => whispers.push(d) };
globalThis.foundry = { utils: { mergeObject: (a, b) => ({ ...a, flags: b.flags }) } };
const os = await import("../scripts/builtin/one-shot-one-kill.mjs");

test("classify: инициатива Скрытностью / урон огнестрелом", () => {
  assert.equal(os.classify({ type: "initiative", options: ["check:statistic:base:stealth"] }), "on");
  assert.equal(os.classify({ type: "initiative", options: ["check:statistic:base:perception"] }), null);
  assert.equal(os.classify({ type: "damage-roll", options: [os.SLUG, "item:group:firearm"] }), "off");
  assert.equal(os.classify({ type: "damage-roll", options: [os.SLUG, "item:group:crossbow"] }), "off");
  assert.equal(os.classify({ type: "damage-roll", options: [os.SLUG, "item:group:sword"] }), null);
  assert.equal(os.classify({ type: "damage-roll", options: ["item:group:firearm"] }), null);
  assert.equal(os.classify({ type: "attack-roll", options: [os.SLUG, "item:group:firearm"] }), null);
});

test("stripToggle: только toggleable RollOption этой опции; идемпотентно", () => {
  const rules = [
    { key: "RollOption", domain: "strike-damage", option: os.SLUG, toggleable: true },
    { key: "RollOption", option: os.SLUG },
    { key: "RollOption", option: "other", toggleable: true },
    { key: "DamageDice", selector: "strike-damage" }
  ];
  const r = os.stripToggle(rules);
  assert.equal(r.changed, true);
  assert.deepEqual(r.rules, rules.slice(1));
  assert.equal(os.stripToggle(r.rules).changed, false);
});

test("migrateItem: обновляет один раз, чужие предметы не трогает", async () => {
  const upd = [];
  const mk = (slug, rules) => ({ slug, type: "action", _source: { system: { rules } }, update: async (d) => { upd.push(d); } });
  await os.migrateItem(mk("other", [{ key: "RollOption", option: os.SLUG, toggleable: true }]));
  await os.migrateItem(mk(os.SLUG, [{ key: "DamageDice" }]));
  assert.equal(upd.length, 0);
  await os.migrateItem(mk(os.SLUG, [{ key: "RollOption", option: os.SLUG, toggleable: true }, { key: "DamageDice" }]));
  assert.deepEqual(upd, [{ "system.rules": [{ key: "DamageDice" }] }]);
});

const mkActor = (withAction = true) => {
  const items = withAction ? [{ slug: os.SLUG, type: "action", uuid: "u", img: "i" }] : [];
  return { name: "A", uuid: "Actor.a", items, createEmbeddedDocuments: async (_t, [d]) => {
    const it = { ...d, type: "effect", delete: async () => { items.splice(items.indexOf(it), 1); } };
    items.push(it); return [it];
  } };
};
const msg = (actor, context) => ({ actor, flags: { pf2e: { context } } });
const effects = (a) => a.items.filter((i) => i.type === "effect");

test("эффект: Скрытность создаёт один раз, Восприятие — нет, урон огнестрелом снимает", async () => {
  const a = mkActor();
  await os.onMessage(msg(a, { type: "initiative", options: ["check:statistic:base:perception"] }));
  assert.equal(effects(a).length, 0);
  const init = msg(a, { type: "initiative", options: ["check:statistic:base:stealth"] });
  await os.onMessage(init); await os.onMessage(init);
  assert.equal(effects(a).length, 1);
  assert.deepEqual(effects(a)[0].system.rules, [{ key: "RollOption", domain: "strike-damage", option: os.SLUG }]);
  assert.equal(whispers.length, 1);
  const dmg = msg(a, { type: "damage-roll", options: [os.SLUG, "item:group:firearm"] });
  await os.onMessage(dmg); await os.onMessage(dmg);
  assert.equal(effects(a).length, 0);
});

test("без действия эффекта нет; конец боя снимает", async () => {
  const bare = mkActor(false);
  await os.onMessage(msg(bare, { type: "initiative", options: ["check:statistic:base:stealth"] }));
  assert.equal(effects(bare).length, 0);
  const a = mkActor();
  await os.onMessage(msg(a, { type: "initiative", options: ["check:statistic:base:stealth"] }));
  await os.onCombatEnd({ combatants: [{ actor: a }, { actor: bare }, {}] });
  assert.equal(effects(a).length, 0);
});

// Коллекции Foundry: Map с contents, без flatMap/Array-методов (кроме filter/find у документов-коллекций)
class Coll extends Map { [Symbol.iterator]() { return this.values(); } get contents() { return [...this.values()]; } filter(f) { return this.contents.filter(f); } }
test("migrateAll: Map-подобные коллекции, линкованные и нелинкованные актёры", async () => {
  const upd = [];
  const item = () => ({ slug: os.SLUG, type: "action", _source: { system: { rules: [{ key: "RollOption", option: os.SLUG, toggleable: true }] } }, update: async (d) => upd.push(d) });
  const actor = () => ({ items: [item()] });
  game.actors = new Coll([["a", actor()]]);
  game.scenes = new Coll([["s", { tokens: new Coll([["t1", { actorLink: false, actor: actor() }], ["t2", { actorLink: true, actor: actor() }]]) }]]);
  await os.migrateAll();
  assert.equal(upd.length, 2);
});

test("два урона подряд: эффект снимается один раз без ошибки; имя в шёпоте экранировано", async () => {
  const a = mkActor(); a.name = "<b>A</b>";
  game.i18n.format = (_k, d) => d.name;
  await os.onMessage(msg(a, { type: "initiative", options: ["check:statistic:base:stealth"] }));
  assert.ok(whispers.at(-1).content.includes("&lt;b&gt;"));
  const dmg = msg(a, { type: "damage-roll", options: [os.SLUG, "item:group:firearm"] });
  await Promise.all([os.onMessage(dmg), os.onMessage(dmg)]);
  assert.equal(effects(a).length, 0);
});
