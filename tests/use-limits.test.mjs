import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { reasonOf, turnKey, LIMITS } = await import("../scripts/builtin/impulse-gate.mjs");

const base = { traits: [], aura: true, auraEffect: true, kinetic: true, actorType: "character" };

test("hex: второй наговор за тот же ход — блок; другой ход и вне боя — нет; первый отмечается", () => {
  const c = { ...base, traits: ["hex", "witch"], turn: "c:1:0" };
  assert.equal(reasonOf({ ...c, hexTurn: "c:1:0" }), "hex");
  assert.equal(reasonOf({ ...c, hexTurn: "c:1:3" }), null);
  assert.equal(reasonOf({ ...c, hexTurn: undefined }), null);
  assert.equal(reasonOf({ ...c, turn: null, hexTurn: "c:1:0" }), null);
  assert.deepEqual(LIMITS.find((l) => l.reason === "hex").mark(c), ["hexTurn", "c:1:0"]);
  assert.ok(!LIMITS.find((l) => l.reason === "hex").mark({ ...c, turn: null }));
});

test("turnKey: ход любого участника, только начатый бой", () => {
  assert.equal(turnKey({ started: true, id: "c", round: 2, turn: 3 }), "c:2:3");
  assert.equal(turnKey({ started: false, id: "c", round: 0, turn: 0 }), null);
  assert.equal(turnKey(null), null);
});

test("Проведение стихийной энергии: блок при активной ауре, без ауры — можно; карточка-ожидание ауры (aura) не мешает", () => {
  const c = { ...base, slug: "channel-elements" };
  assert.equal(reasonOf({ ...c, auraEffect: true }), "auraActive");
  assert.equal(reasonOf({ ...c, auraEffect: false, aura: true }), null);
});

test("реакция с листа: вторая за раунд — блок; персонаж — да, NPC — нет; флаг ставится только в бою", () => {
  const c = { ...base, reaction: true, round: "c:1", inCombat: true, reactionFlag: { combat: "c", round: 1 } };
  assert.equal(reasonOf({ ...c, reactionSpent: true }), "reaction");
  assert.equal(reasonOf({ ...c, reactionSpent: false }), null);
  assert.equal(reasonOf({ ...c, reactionSpent: true, actorType: "npc" }), null);
  assert.equal(reasonOf({ ...c, reactionSpent: true, reaction: false }), null);
  const mark = LIMITS.find((l) => l.reason === "reaction").mark;
  assert.deepEqual(mark(c), ["reactionSpent", { combat: "c", round: 1 }]);
  assert.ok(!mark({ ...c, round: null, inCombat: false }));
});

test("импульс: нет свободной руки — блок; kinetic:false (нет Channel Elements) — строки импульса молчат", () => {
  const imp = { ...base, traits: ["impulse", "fire"], handsFree: 0 };
  assert.equal(reasonOf(imp), "noHand");
  assert.equal(reasonOf({ ...imp, handsFree: 1 }), null);
  assert.equal(reasonOf({ ...imp, handsFree: undefined }), null);   // данных нет — не блокируем
  assert.equal(reasonOf({ ...imp, kinetic: false }), null);
  assert.equal(reasonOf({ ...imp, aura: false }), "noAura");   // аура раньше руки
});

test("наговор-реакция: и hex, и reaction — первым срабатывает hex, потом reaction", () => {
  const c = { ...base, traits: ["hex"], reaction: true, turn: "c:1:0", round: "c:1", hexTurn: "c:1:0", reactionSpent: true };
  assert.equal(reasonOf(c), "hex");
  assert.equal(reasonOf({ ...c, hexTurn: null }), "reaction");
});

// --- preCreate / пропуски / откат отметок ---
const { preCreate, onCreate, unchecked, staleMarks, onDelete, grantPass } = await import("../scripts/builtin/impulse-gate.mjs");
const { MOD } = await import("../scripts/util.mjs");

function world(altHeld = false) {
  const updates = [];
  const actor = {
    uuid: "A.1", type: "character", flags: {}, itemTypes: { action: [], effect: [] }, abilities: { con: { mod: 0 } }, system: {},
    update: async (u) => { updates.push(u); }
  };
  globalThis.game = {
    user: { id: "u", isActiveGM: true }, messages: { contents: [] }, settings: { get: () => "on" },
    keyboard: { isModifierActive: () => altHeld }, i18n: { localize: (k) => k, format: (k) => k },
    combats: [{ id: "c", started: true, active: true, scene: {}, round: 1, turn: 0, combatants: [{ actor: { uuid: "A.1" } }, { actor: { uuid: "A.2" } }] }]
  };
  globalThis.ui = { notifications: { warn() {} } };
  return { actor, updates };
}
const msg = (actor, item, rollOptions = ["origin:action:slug:cast-a-spell"]) => {
  const m = { actor, item, flags: { pf2e: { context: { type: "spell-cast" }, origin: { rollOptions } } }, updateSource(ch) { m.upd = ch; } };
  return m;
};
const hexSpell = { type: "spell", slug: "evil-eye", uuid: "I.1", name: "Evil Eye", system: { traits: { value: ["hex"] } } };

test("preCreate: карточка заклинания без сотворения (нет cast-a-spell) — не блок и не отметка", () => {
  const { actor, updates } = world();
  actor.flags[MOD] = { hexTurn: "c:1:0" };
  assert.equal(preCreate(msg(actor, hexSpell, []), {}, {}, "u"), undefined);
  assert.equal(updates.length, 0);
});

test("preCreate: второй наговор в ход — блок; первый — отметка на сообщении, на актёра пишет onCreate; пропуск wrapCast снимает повторный блок один раз", async () => {
  const { actor, updates } = world();
  const m = msg(actor, hexSpell);
  assert.equal(preCreate(m, {}, {}, "u"), undefined);
  assert.equal(updates.length, 0);   // отметка пишется не в preCreate, а когда карточка создана
  assert.deepEqual(m.upd[`flags.${MOD}.limitMarks`], { hexTurn: "c:1:0" });
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), false);   // быстрый повтор до записи: ожидающая отметка уже блокирует
  await onCreate({ ...m, isAuthor: true, flags: { [MOD]: { limitMarks: { hexTurn: "c:1:0" } } } });
  assert.deepEqual(updates, [{ [`flags.${MOD}.hexTurn`]: "c:1:0" }]);
  actor.flags[MOD] = { hexTurn: "c:1:0" };
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), false);
  grantPass(actor, hexSpell);   // отпущенный Alt в wrapCast
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), undefined);
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), false);   // разовый
});

test("unchecked: пропуск только для своего актёра и предмета", async () => {
  const { actor } = world();
  actor.flags[MOD] = { hexTurn: "c:1:0" };
  const other = { ...actor, uuid: "A.2", flags: { [MOD]: { hexTurn: "c:1:0" } } };
  await unchecked(actor, hexSpell, async () => {
    assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), undefined);
    assert.equal(preCreate(msg(other, hexSpell), {}, {}, "u"), false);
  });
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), false);
});

test("откат отметок: удаление карточки возвращает флаг, только если он тот же", async () => {
  assert.deepEqual(staleMarks({ hexTurn: "c:1:0", reactionSpent: { combat: "c", round: 1 } }, { hexTurn: "c:1:0", reactionSpent: { combat: "c", round: 2 } }), ["hexTurn"]);
  const { actor, updates } = world();
  actor.flags[MOD] = { hexTurn: "c:1:0" };
  await onDelete({ actor, flags: { [MOD]: { limitMarks: { hexTurn: "c:1:0" } } } });
  assert.deepEqual(updates, [{ [`flags.${MOD}.-=hexTurn`]: null }]);
  updates.length = 0;
  actor.flags[MOD] = { hexTurn: "c:2:0" };
  await onDelete({ actor, flags: { [MOD]: { limitMarks: { hexTurn: "c:1:0" } } } });
  assert.equal(updates.length, 0);
});
