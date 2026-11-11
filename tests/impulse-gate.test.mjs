import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { reasonOf, channelPending, roundKey, isUseCard } = await import("../scripts/builtin/impulse-gate.mjs");

test("reasonOf: импульс без ауры; второе переполнение в том же раунде; не импульс — не трогаем", () => {
  const imp = ["impulse", "fire"], ovf = ["impulse", "overflow"];
  assert.equal(reasonOf({ traits: imp, aura: false }), "noAura");
  assert.equal(reasonOf({ traits: ["attack"], aura: false }), null);
  assert.equal(reasonOf({ traits: imp, aura: true, overflowRound: "c:1", round: "c:1" }), null);
  assert.equal(reasonOf({ traits: ovf, aura: true, overflowRound: "c:1", round: "c:1" }), "overflow");
  assert.equal(reasonOf({ traits: ovf, aura: true, overflowRound: "c:1", round: "c:2" }), null);
  assert.equal(reasonOf({ traits: ovf, aura: true, overflowRound: "c:1", round: null }), null);   // вне боя «за раунд» нет
});

test("channelPending: свежая карточка Channel Elements даёт ауру, переполнение после неё — гасит, чужие сообщения не в счёт", () => {
  const msg = (actor, slug, traits = [], type) => ({ speaker: { actor }, item: { slug, system: { traits: { value: traits } } }, flags: { pf2e: { context: type ? { type } : undefined } } });
  const ch = msg("a", "channel-elements"), col = msg("a", "scorching-column", ["impulse", "overflow"]), other = msg("b", "x", ["impulse", "overflow"]);
  assert.equal(channelPending([ch], "a"), true);
  assert.equal(channelPending([ch, other], "a"), true);
  assert.equal(channelPending([ch, col], "a"), false);
  assert.equal(channelPending([col, ch], "a"), true);
  assert.equal(channelPending([ch, msg("a", "scorching-column", ["impulse", "overflow"], "damage-roll")], "a"), true);   // бросок урона — не использование
  assert.equal(channelPending([], "a"), false);
});

test("roundKey: только начатый бой", () => {
  assert.equal(roundKey({ started: true, id: "c", round: 2, turn: 3 }), "c:2");
  assert.equal(roundKey({ started: false, id: "c", round: 0 }), null);
  assert.equal(roundKey(null), null);
});

test("isUseCard: карточка использования — с CAST у заклинаний; «в чат» без сотворения и броски — нет", () => {
  const card = (item, type, rollOptions) => ({ actor: {}, item, flags: { pf2e: { context: type ? { type } : undefined, origin: { rollOptions } } } });
  const act = { type: "action" }, spell = { type: "spell" };
  assert.equal(isUseCard(card(act)), true);
  assert.equal(isUseCard(card({ type: "feat" }, "self-effect")), true);
  assert.equal(isUseCard(card(spell, "spell-cast", ["origin:action:slug:cast-a-spell"])), true);
  assert.equal(isUseCard(card(spell, "spell-cast", ["origin:item:type:spell"])), false, "карточка заклинания в чат без сотворения");
  assert.equal(isUseCard(card(act, "damage-roll")), false);
  assert.equal(isUseCard(card({ type: "equipment" })), false);
  assert.equal(isUseCard({ ...card(act), item: null }), false);
  assert.equal(isUseCard({ ...card(act), actor: null }), false);
});
