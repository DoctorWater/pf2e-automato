// Урон по итогам basic-спасброска: связь бросок урона <-> карточка, план по степеням, переброс, откат (builtin/basic-damage.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true }, users: [], modules: { get: () => null }, settings: { get: () => true }, i18n: { localize: (k) => k, format: (k) => k } };
const bd = await import("../scripts/builtin/basic-damage.mjs");

const card = (id, { actor = "A", item = "I", slug = "fireball", basic = true, ...state } = {}) => ({
  id, timestamp: 1000, flags: { "pf2e-automato": { use: { actor, slug, item: { uuid: item }, rule: { onUse: { challenge: { basic, byDegree: {} } } }, state } } }
});
const strike = (id) => ({ id, timestamp: 1100, flags: { pf2e: { context: { type: "attack-roll" } } } });
const q = { actor: "A", uuid: "I", slug: "fireball", at: 2000, maxMs: 600000 };

test("связь: Удар между карточкой и уроном не рвёт связь", () => {
  assert.equal(bd.findCard([card("c1"), strike("s1"), strike("s2")], q)?.id, "c1");
});

test("связь: урон другого предмета или другого актёра — без карточки", () => {
  assert.equal(bd.findCard([card("c1")], { ...q, uuid: "J", slug: "other" }), null);
  assert.equal(bd.findCard([card("c1")], { ...q, actor: "B" }), null);
});

test("связь: второй бросок урона не связывается (карточка уже связана), ближайшая карточка важнее старой", () => {
  assert.equal(bd.findCard([card("c1", { basicDamage: { msg: "d1" } })], q), null);
  assert.equal(bd.findCard([card("c1"), card("c2", { basicDamage: { msg: "d1" } })], q), null);
});

test("связь: карточка импульса Поддержания (use.item — предмет из снимка) находится по uuid и slug", () => {
  assert.equal(bd.findCard([card("c1", { item: "Item.sust", slug: "x" })], { ...q, uuid: "Item.sust", slug: null })?.id, "c1");
  assert.equal(bd.findCard([card("c1", { item: "Item.a", slug: "impulse" })], { ...q, uuid: "Item.b", slug: "impulse" })?.id, "c1");
});

test("связь: граница хода и возраст обрывают поиск", () => {
  assert.equal(bd.findCard([card("c1"), { id: "turn", timestamp: 1500, flags: {} }], { ...q, stopId: "turn" }), null);
  assert.equal(bd.findCard([card("c1")], { ...q, at: 1000 + 600001 }), null);
});

test("признак basic: правило, иначе заклинание; шаги damage заглушают механизм", () => {
  const rule = (basic) => ({ onUse: { challenge: { basic } } });
  const spell = { system: { defense: { save: { basic: true } } } };
  assert.equal(bd.isBasicChallenge(rule(true), null), true);
  assert.equal(bd.isBasicChallenge(rule(false), spell), false);
  assert.equal(bd.isBasicChallenge(rule(undefined), spell), true);
  assert.equal(bd.isBasicChallenge(rule(undefined), null), false);
  assert.equal(bd.isBasicChallenge({ onUse: {} }, spell), false);
  assert.equal(bd.ruleDealsDamage({ onUse: { challenge: { byDegree: { failure: [{ damage: { formula: "1d6" } }] } } } }), true);
  assert.equal(bd.ruleDealsDamage({ onUse: { apply: [{ damage: {} }], challenge: {} } }), true);
  assert.equal(bd.ruleDealsDamage({ onUse: { challenge: { byDegree: { failure: [{ condition: {} }] } } } }), false);
});

test("урон-бросок: не атака и не лечение", () => {
  const m = (type, sourceType, kinds) => ({ flags: { pf2e: { context: { type, sourceType } } }, rolls: [{ kinds: new Set(kinds) }] });
  assert.equal(bd.isBasicDamage(m("damage-roll", "save", ["damage"])), true);
  assert.equal(bd.isBasicDamage(m("damage-roll", "attack", ["damage"])), false);
  assert.equal(bd.isBasicDamage(m("damage-roll", undefined, ["healing"])), false);
  assert.equal(bd.isBasicDamage(m("attack-roll", undefined, ["damage"])), false);
});

test("доли по степени: крит. провал ×2, провал ×1, успех ×½, крит. успех ×0", () => {
  const r = (degree) => ({ degree });
  const { fresh } = bd.planBasicDamage({ a: r(0), b: r(1), c: r(2), d: r(3) }, ["a", "b", "c", "d"]);
  assert.deepEqual(fresh.map((x) => x.mult), [2, 1, 0.5, 0]);
});

test("поздний результат: наносится только цель, которой ещё нет в done", () => {
  const done = { a: { degree: 1, mult: 1 } };
  const { fresh, changed } = bd.planBasicDamage({ a: { degree: 1 }, b: { degree: 2 } }, ["a", "b", "c"], done);
  assert.deepEqual(fresh.map((x) => x.key), ["b"]);   // c без результата — пропуск
  assert.deepEqual(changed, []);
});

test("переброс спасброска после нанесения: changed, а не fresh; пропущенные цели не трогаем", () => {
  const done = { a: { degree: 1, mult: 1 }, b: { degree: 1, skipped: true } };
  const { fresh, changed } = bd.planBasicDamage({ a: { degree: 2 }, b: { degree: 3 } }, ["a", "b"], done);
  assert.deepEqual(fresh, []);
  assert.deepEqual(changed.map((x) => [x.key, x.from, x.degree, x.mult]), [["a", 1, 2, 0.5]]);
});

test("откат pf2e: маркер разбирается, отметка снимается только у своего сообщения; auto откатанное не возвращает, кнопка — да", () => {
  const marker = bd.markerOf("d1", "tok");
  assert.deepEqual(bd.parseMarker(["x", marker]), { dmgId: "d1", key: "tok" });
  assert.equal(bd.parseMarker(["pf2e-automato:msg:key"]), null);   // маркер испытания saves.mjs — не наш
  const msg = (id, reverted) => ({ id, flags: { pf2e: { appliedDamage: { isReverted: reverted }, context: { options: [marker] } } } });
  const link = { done: { tok: { degree: 1, taken: "t1" } } };
  assert.equal(bd.revertedKey(msg("t1", true), link), "tok");
  assert.equal(bd.revertedKey(msg("t0", true), link), null);   // откатан старый урон пересчёта
  assert.equal(bd.revertedKey(msg("t1", false), link), null);
  const rev = { tok: { degree: 1, reverted: true } };
  assert.equal(bd.planBasicDamage({ tok: { degree: 1 } }, ["tok"], rev).fresh.length, 0);
  assert.equal(bd.planBasicDamage({ tok: { degree: 1 } }, ["tok"], rev, { manual: true }).fresh.length, 1);
});

test("опции как у pf2e: self/target отбрасываются, остальное (и origin:ally|enemy) остаётся", () => {
  assert.deepEqual(bd.baseOptions(["self:trait:fire", "target:dead", "origin:ally", "damage:type:fire", "origin:trait:fire"]), ["origin:ally", "damage:type:fire", "origin:trait:fire"]);
});


test("связь с удалённым уроном не считается: карточка снова доступна", () => {
  const c = card("c1", { basicDamage: { msg: "gone" } });
  assert.equal(bd.findCard([c], { ...q, exists: () => false })?.id, "c1");
  assert.equal(bd.findCard([c], { ...q, exists: () => true }), null);
});

test("отряд: нанесённая запись того же troop.id блокирует другие цели, откатанная и своя — нет", () => {
  const done = { a: { troop: "T", mult: 1 }, b: { troop: "T", reverted: true }, c: { troop: "T", skipped: true } };
  assert.equal(bd.troopTaken(done, "T", "x"), true);
  assert.equal(bd.troopTaken(done, "T", "a"), false);   // единственная живая запись — своя (пересчёт)
  assert.equal(bd.troopTaken(done, "U", "x"), false);
  assert.equal(bd.troopTaken(done, null, "x"), false);
});

test("пересчёт без доказанного отката не наносит: нет taken / нет сообщения; ×0, откатанное и живое — можно", () => {
  const taken = (reverted) => ({ flags: { pf2e: { appliedDamage: { isReverted: reverted } } } });
  assert.equal(bd.undoProof({ mult: 1, taken: null }, null), "no-taken");
  assert.equal(bd.undoProof({ mult: 1, taken: "t" }, null), "gone");
  assert.equal(bd.undoProof({ mult: 1, taken: "t" }, taken(false)), "alive");
  assert.equal(bd.undoProof({ mult: 1, taken: "t" }, taken(true)), null);
  assert.equal(bd.undoProof({ mult: 0, taken: null }, null), null);
});

test("кнопка по целям run: результат вне challengeTargets кнопки не даёт", () => {
  const results = { a: { degree: 1 }, ghost: { degree: 1 } };
  assert.deepEqual(bd.planBasicDamage(results, ["a"], {}, { manual: true }).fresh.map((x) => x.key), ["a"]);
});
