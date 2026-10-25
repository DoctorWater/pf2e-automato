// cast -> activate (plan-activate.md §6): нормализация обоих ключей, старый снимок, dup, миграция мира
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) } };   // use.mjs тянет zone.mjs
const { validateRule, activateOf, dupActivate } = await import("../scripts/rules.mjs");
const { buildViewModel } = await import("../scripts/chat.mjs");
const { wantsSnapshot } = await import("../scripts/use.mjs");
const { checkAnswer } = await import("../tools/validate.mjs");
const { renameRule, renameCatalog, migrateWorld } = await import("../scripts/migrate-activate.mjs");

const ARC = "Compendium.pf2e.spells-srd.Item.kBhaPuzLUSwS6vVf", MOD = "pf2e-automato";
const list = [{ spell: ARC, dc: 17, per: { value: 1, unit: "days" } }];

test("validateRule: старый ключ cast, новый activate и оба — всегда activate, при обоих побеждает activate", () => {
  const old = validateRule({ v: 1, cast: list }).rule, neu = validateRule({ v: 1, activate: list }).rule;
  assert.deepEqual(old, neu);
  assert.equal(old.cast, undefined);
  assert.equal(old.activate.length, 1);
  const both = validateRule({ v: 1, activate: [{ spell: ARC, dc: 20 }], cast: list });
  assert.ok(both.ok);
  assert.equal(both.rule.activate[0].dc, 20);
  assert.equal(both.rule.cast, undefined);
});

test("dupActivate и tools/validate: оба ключа — ошибка activate.dup; рантайм её не поднимает", () => {
  assert.equal(dupActivate({ v: 1, activate: list, cast: list }).key, "activate.dup");
  assert.equal(dupActivate({ v: 1, cast: list }), null);
  assert.equal(dupActivate({ v: 1, activate: list, cast: null }), null);
  const any = new Proxy({}, { get: () => true });
  const a = checkAnswer({ uuid: "u", rule: { v: 1, activate: list, cast: list } }, { conditions: any, effects: any });
  assert.equal(a.kind, "error");
  assert.match(a.errors[0], /activate/);
});

test("старый снимок в сообщении (rule.cast) читается так же, как новый (rule.activate)", () => {
  assert.deepEqual(activateOf({ cast: list }), list);
  assert.deepEqual(activateOf({ activate: list, cast: [] }), list);
  assert.equal(activateOf({}), undefined);
  assert.equal(wantsSnapshot("card", { cast: list, macros: [] }), true);
  assert.equal(wantsSnapshot("card", { activate: list, macros: [] }), true);
  const env = {
    t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), mode: () => "auto", now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false,
    tokenName: (k) => k, isOwner: () => false, isActorOwner: () => true, statLabel: (s) => s, conditionLabel: (s) => s,
    uuidName: () => "Electric Arc", castInfo: () => ({ why: null, left: null, dc: 17 })
  };
  const msg = (rule) => ({ id: "m", author: { id: "a" }, flags: { [MOD]: { use: { v: 1, kind: "card", confidence: "high", rule, createdAt: 1, item: { uuid: "Actor.a.Item.i", name: "x" }, actor: "Actor.a", state: {} } } } });
  const user = { id: "a", isGM: false };
  const oldVm = buildViewModel(msg({ v: 1, cast: [{ id: "arc", ...list[0] }] }), user, env), newVm = buildViewModel(msg({ v: 1, activate: [{ id: "arc", ...list[0] }] }), user, env);
  assert.equal(oldVm.cast.length, 1);
  assert.deepEqual(oldVm.cast, newVm.cast);
});

test("renameRule: сырой флаг — целиком, неизвестные поля остаются, id не дописываются, идемпотентно", () => {
  const raw = { v: 1, label: "Coil", future: { x: 1 }, onUse: null, cast: list };
  const next = renameRule(raw);
  assert.deepEqual(next, { v: 1, label: "Coil", future: { x: 1 }, onUse: null, activate: list });
  assert.equal("id" in next.activate[0], false);   // счётчики uses.<id> остаются: id по умолчанию тот же, что у cast
  assert.equal(validateRule(next).rule.activate[0].id, validateRule(raw).rule.activate[0].id);
  assert.equal(renameRule(next), null);
  assert.equal(renameRule({ v: 1, cast: null, activate: list }), null);
  assert.deepEqual(renameRule({ v: 1, activate: [{ spell: ARC, dc: 9 }], cast: list }), { v: 1, activate: [{ spell: ARC, dc: 9 }] });
  assert.equal(renameRule(null), null);
});

test("renameCatalog: bySource/bySlug/byName, нетронутое возвращается как есть, повтор — null", () => {
  const cat = { bySource: { a: { v: 1, cast: list }, b: { v: 1, macros: [] } }, bySlug: { c: { v: 1, cast: list } } };
  const out = renameCatalog(cat);
  assert.deepEqual(Object.keys(out.bySource.a), ["v", "activate"]);
  assert.equal(out.bySource.b, cat.bySource.b);
  assert.equal(out.bySlug.c.activate, list);
  assert.equal(renameCatalog(out), null);
  assert.equal(cat.bySource.a.cast, list);   // исходник не меняется
});

test("migrateWorld: мировой каталог, предмет мира, предмет актёра и вложенный через родителя; повтор ничего не пишет", async () => {
  const writes = [];
  const mkItem = (name, rule, extra = {}) => ({ name, flags: { [MOD]: { rule } }, update: async (u) => { writes.push([name, u]); }, ...extra });
  const flagKey = `flags.${MOD}.rule`;
  const sub = mkItem("heart", { v: 1, cast: list }, { parentItem: {} });
  const weapon = mkItem("staff", { v: 1, cast: list }, { subitems: [sub] });
  const plain = mkItem("plain", { v: 1, onUse: null });
  let catalog = { bySource: { a: { v: 1, cast: list } } };
  globalThis.game = {
    settings: { get: () => catalog, set: async (_m, _k, v) => { catalog = v; writes.push(["catalog"]); } },
    items: [mkItem("world", { v: 1, cast: list })],
    actors: { *[Symbol.iterator]() { yield { items: [weapon, plain] }; } }   // как Collection Foundry: итерируется, flatMap нет
  };
  assert.equal(await migrateWorld(), 4);
  assert.deepEqual(writes.map((w) => w[0]).sort(), ["catalog", "heart", "staff", "world"]);
  assert.deepEqual(Object.keys(catalog.bySource.a), ["v", "activate"]);
  const by = Object.fromEntries(writes.map((w) => [w[0], w[1]]));
  assert.deepEqual(Object.keys(by.world), [`flags.${MOD}.==rule`]);   // верхний уровень — замена целиком
  assert.deepEqual(by.world[`flags.${MOD}.==rule`], { v: 1, activate: list });
  assert.deepEqual(by.heart[flagKey], { v: 1, activate: list, cast: null });   // вложенный: pf2e сливает правку без удалений, cast гасится null
  // после записи флаги выглядят как переписанные: второй проход пуст
  weapon.flags[MOD].rule = { v: 1, activate: list };
  sub.flags[MOD].rule = { v: 1, activate: list, cast: null };
  game.items[0].flags[MOD].rule = { v: 1, activate: list };
  writes.length = 0;
  assert.equal(await migrateWorld(), 0);
  assert.deepEqual(writes, []);
  delete globalThis.game;
});
