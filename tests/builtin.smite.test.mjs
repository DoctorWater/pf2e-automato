// 0.5g4: «Сокрушение» — враждебное действие отмеченного врага продлевает эффект Сокрушения чемпиона до конца следующего хода этого врага.
import { test } from "node:test";
import assert from "node:assert/strict";

const settings = { yieldToAutomations: false };
const uuids = new Map();
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.game = { user: { isActiveGM: true }, users: [], modules: { get: () => null }, settings: { get: (_m, k) => settings[k] }, i18n: { localize: (k) => k, format: (k) => k }, time: { worldTime: 1000 }, combat: null };

const smite = await import("../scripts/builtin/smite.mjs");
const { SMITE_EFFECT } = smite;

const actor = (name, extra = {}) => ({ uuid: `Actor.${name}`, name, itemTypes: { effect: [] }, ...extra });
const effect = (owner, markUuid) => {
  const e = { actor: owner, _stats: { compendiumSource: SMITE_EFFECT }, system: { rules: markUuid ? [{ key: "TokenMark", uuid: markUuid }] : [] }, updates: [], async update(d) { this.updates.push(d); } };
  owner.itemTypes.effect.push(e);
  return e;
};

test("метка: TokenMark на uuid токена; пустой uuid и чужая метка — нет", () => {
  assert.equal(smite.marks({ system: { rules: [{ key: "TokenMark", uuid: "T1" }] } }, "T1"), true);
  assert.equal(smite.marks({ system: { rules: [{ key: "TokenMark", uuid: "T1" }] } }, "T2"), false);
  assert.equal(smite.marks({ system: { rules: [{ key: "FlatModifier" }] } }, "T1"), false);
  assert.equal(smite.marks({ system: { rules: [{ key: "TokenMark", uuid: "T1" }] } }, null), false);
  assert.equal(smite.marks({ _source: { system: { rules: [{ key: "TokenMark", uuid: "T1" }] } } }, "T1"), true);   // правила только в источнике
});

test("правка: старт от мирового времени и инициативы врага, конец хода", () => {
  assert.deepEqual(smite.extension(1000, 17), { "system.start": { value: 1000, initiative: 17 }, "system.duration.expiry": "turn-end" });
});

test("onMessage: атака отмеченного врага по чемпиону или союзнику продлевает его Кару; по постороннему, не отмеченным и не в бою — нет", async () => {
  const foe = actor("foe", { combatant: { initiative: 14 }, isEnemyOf: (a) => a.side === "good" });
  const hero = actor("hero", { side: "good" }), friend = actor("friend", { side: "good" }), stranger = actor("stranger", { side: "evil" });
  hero.isAllyOf = (a) => a.side === "good"; friend.isAllyOf = (a) => a.side === "good"; stranger.isAllyOf = (a) => a.side === "evil";
  const mine = effect(hero, "Token.foe"), other = effect(friend, "Token.somebody");
  game.combat = { active: true, turns: [hero, friend, stranger, foe].map((actor) => ({ actor })) };
  const msg = (target, extra = {}) => ({ actor: foe, token: { uuid: "Token.foe" }, flags: { pf2e: { context: { type: "attack-roll", target: { actor: target.uuid } } } }, ...extra });
  [hero, friend, stranger].forEach((a) => uuids.set(a.uuid, a));
  await smite.onMessage(msg(friend));   // цель — союзник чемпиона
  assert.deepEqual(mine.updates, [{ "system.start": { value: 1000, initiative: 14 }, "system.duration.expiry": "turn-end" }]);
  assert.deepEqual(other.updates, []);   // метка другого врага
  await smite.onMessage(msg(stranger));   // цель чужая — не «против вас или союзников»
  assert.equal(mine.updates.length, 1);
  await smite.onMessage({ ...msg(hero), flags: { pf2e: { context: { type: "skill-check", target: { actor: hero.uuid } } } } });   // не атака
  assert.equal(mine.updates.length, 1);
  game.combat = { active: false, turns: [] };
  await smite.onMessage(msg(hero));   // вне боя
  assert.equal(mine.updates.length, 1);
  game.combat = { active: true, turns: [hero, foe].map((actor) => ({ actor })) };
  await smite.onMessage({ ...msg(hero), actor: { ...foe, combatant: null } });   // атакующий не в бою
  assert.equal(mine.updates.length, 1);
  await smite.onMessage(msg(hero));
  assert.equal(mine.updates.length, 2);
});
