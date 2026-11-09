import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { combatOf } = await import("../scripts/builtin/lib.mjs");
const { withPending, marksFor, LIMITS, reasonOf } = await import("../scripts/builtin/impulse-gate.mjs");
const { posOfActor } = await import("../scripts/sustain.mjs");

const actor = { uuid: "Actor.a" };
const combat = (id, o = {}) => ({ id, round: 0, active: false, started: false, scene: "s", combatants: [{ actor }], ...o });

test("combatOf: активный бой со сценой важнее забытых", () => {
  const old = combat("old", { started: true, round: 4 }), cur = combat("cur", { active: true, started: true, round: 1 });
  assert.equal(combatOf([old, cur], actor).id, "cur");
  assert.equal(combatOf([combat("x", { combatants: [] })], actor), null);
});

test("posOfActor: тот же выбор боя, только идущие (round > 0)", () => {
  const cur = combat("cur", { active: true, started: true, round: 2 }), idle = combat("idle");
  globalThis.game.combats = [idle, cur];
  assert.deepEqual(posOfActor(actor), { combat: "cur", round: 2 });
  globalThis.game.combats = [idle];
  assert.deepEqual(posOfActor(actor), { combat: null, round: null });
});

test("отметки: переполнение и реакция ставятся таблицей, pending перекрывает флаги", () => {
  const c = { traits: ["impulse", "overflow"], kinetic: true, actorType: "character", round: "c:1", inCombat: true, reaction: true, reactionFlag: { combat: "c", round: 1 } };
  assert.deepEqual(marksFor(c), { overflowRound: "c:1", reactionSpent: { combat: "c", round: 1 } });
  const flags = withPending({}, { marks: { overflowRound: "c:1" }, until: 100 }, 50);
  assert.equal(reasonOf({ traits: ["impulse", "overflow"], aura: true, round: "c:1", overflowRound: flags.overflowRound }), "overflow");
  assert.deepEqual(withPending({ a: 1 }, { marks: { a: 2 }, until: 100 }, 150), { a: 1 });   // истёкшая отметка не действует
  assert.deepEqual(withPending(undefined, undefined), {});
  assert.ok(LIMITS.find((l) => l.reason === "overflow").mark);
});

test("частота: на нуле — блок, кроме только что списанной pf2e (законное использование)", () => {
  const base = { traits: [], frequency: { max: 1, per: "PT1H", value: 0 } };
  assert.equal(reasonOf(base), "frequency");
  assert.equal(reasonOf({ ...base, justSpent: true }), null);
  assert.equal(reasonOf({ ...base, frequency: { ...base.frequency, value: 1 } }), null);
  assert.equal(reasonOf({ traits: [], frequency: null }), null);
});

test("частота вне боя: turn/round не блокирует (pf2e восстанавливает их только в бою), day блокирует", () => {
  const f = (per, o = {}) => ({ traits: [], inCombat: false, frequency: { max: 1, per, value: 0 }, ...o });
  assert.equal(reasonOf(f("round")), null);
  assert.equal(reasonOf(f("turn")), null);
  assert.equal(reasonOf(f("day")), "frequency");
  assert.equal(reasonOf(f("round", { inCombat: true })), "frequency");
});

test("частота: onPreUpdateItem открывает окно на одну карточку; чужой блок возвращает списанное", async () => {
  const { onPreUpdateItem, preCreate, refundSpent, MOD_OPT } = await import("../scripts/builtin/impulse-gate.mjs");
  globalThis.foundry ??= { utils: { getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o) } };
  globalThis.ui = { notifications: { warn() {} } };
  globalThis.game.user = { id: "u" };
  globalThis.game.settings = { get: () => "auto" };
  globalThis.game.i18n = { format: (k) => k, localize: (k) => k };
  globalThis.game.messages = { contents: [] };
  globalThis.game.keyboard = { isModifierActive: () => false };
  const updates = [];
  const mkItem = (value, traits = []) => ({
    uuid: "Item.i" + Math.random(), slug: "x", name: "X", type: "action", system: { frequency: { max: 2, per: "day", value }, traits: { value: traits } },
    update: async (d, o) => { updates.push([d, o]); },
  });
  const msg = (item) => ({ flags: { pf2e: { context: { type: "self-effect" } } }, actor: { uuid: "Actor.a", type: "npc", itemTypes: { action: [], effect: [] } }, item, updateSource() {} });
  const spend = (item) => { const v = item.system.frequency.value; onPreUpdateItem(item, { system: { frequency: { value: v - 1 } } }, {}); item.system.frequency.value = v - 1; };

  // законное: списано pf2e -> одна карточка проходит, вторая на нуле блокируется
  const a = mkItem(1); spend(a);
  assert.notEqual(preCreate(msg(a), {}, {}, "u"), false);
  assert.equal(preCreate(msg(a), {}, {}, "u"), false);
  assert.equal(updates.length, 0);

  // собственное списание модуля окно не открывает
  const b = mkItem(1); b.system.frequency.value = 0;
  onPreUpdateItem(b, { system: { frequency: { value: 0 } } }, { [MOD_OPT]: true });
  b.system.frequency.value = 1; onPreUpdateItem(b, { system: { frequency: { value: 0 } } }, { [MOD_OPT]: true });
  b.system.frequency.value = 0;
  assert.equal(preCreate(msg(b), {}, {}, "u"), false);

  // блок по другой строке (hex в этот ход): частота возвращается, один раз, не выше max
  game.combats = [{ id: "c", round: 1, turn: 0, active: true, started: true, scene: "s", combatants: [{ actor: { uuid: "Actor.a" } }] }];
  const h = mkItem(2, ["hex"]); spend(h);
  const m = msg(h); m.actor.flags = { "pf2e-automato": { hexTurn: "c:1:0" } };
  assert.equal(preCreate(m, {}, {}, "u"), false);
  await Promise.resolve();
  assert.deepEqual(updates.at(-1), [{ "system.frequency.value": 2 }, { [MOD_OPT]: true }]);
  const n = updates.length; refundSpent(h);
  assert.equal(updates.length, n);   // отметка погашена — второго возврата нет
});
