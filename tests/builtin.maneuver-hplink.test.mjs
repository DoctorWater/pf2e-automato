// M5 (манёвр атакой заклинания) и M7 (Spirit Link): чистая логика, без Foundry.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = {
  combats: [], user: { isActiveGM: true }, users: [], modules: { get: () => null }, settings: { get: () => true },
  i18n: { localize: (k) => k, format: (k) => k }
};
globalThis.fromUuidSync = () => ({ uuid: "Actor.caster", getActiveTokens: () => [] });

const man = await import("../scripts/builtin/maneuver.mjs");
const link = await import("../scripts/builtin/damage-link.mjs");
const spirit = await import("../scripts/builtin/spirit-link.mjs");

const NEW = "You can attempt to @UUID[Compendium.pf2e.actionspf2e.Item.Dt6B1slsBy8ipJu9]{Disarm}, @UUID[Compendium.pf2e.actionspf2e.Item.7blmbDrQFNfdT731]{Shove}, @UUID[Compendium.pf2e.actionspf2e.Item.lOE4yjUnETTdaf2T]{Reposition}, or @UUID[Compendium.pf2e.actionspf2e.Item.ge56Lu1xXVFYUnLP]{Trip} the target";
const OLD = "You can attempt to Disarm, Shove, or Trip the target using a spell attack roll instead of an Athletics check.";

test("манёвры по тексту копии: свежий текст — четыре, старая копия — три без Перестановки, без текста — таблица", () => {
  assert.deepEqual(man.maneuverList("telekinetic-maneuver", NEW), ["disarm", "shove", "reposition", "trip"]);
  assert.deepEqual(man.maneuverList("telekinetic-maneuver", OLD), ["disarm", "shove", "trip"]);
  assert.deepEqual(man.maneuverList("telekinetic-maneuver", "Перевод без ссылок"), ["disarm", "shove", "reposition", "trip"]);
  assert.deepEqual(man.maneuverList("magnetic-attraction", "you must attempt to Disarm the creature"), ["disarm"]);
  // pf2ru: ссылки на три действия, Толчок — словом в падеже (живой мир)
  const RU = "попытку @UUID[Compendium.pf2e.actionspf2e.Item.lOE4yjUnETTdaf2T]{Перестановки}, @UUID[Compendium.pf2e.actionspf2e.Item.Dt6B1slsBy8ipJu9]{Разоружения}, @UUID[Compendium.pf2e.actionspf2e.Item.ge56Lu1xXVFYUnLP]{Сбивания с ног} или Толчка";
  const titles = { disarm: "Разоружение", shove: "Толчок", reposition: "Перестановка", trip: "Сбивание с ног" };
  assert.deepEqual(man.maneuverList("telekinetic-maneuver", RU, titles), ["disarm", "shove", "reposition", "trip"]);
  assert.deepEqual(man.maneuverList("telekinetic-maneuver", "Разоружения, Сбивания с ног или Толчка", titles), ["disarm", "shove", "trip"]);
  assert.deepEqual(man.maneuverList("fireball", NEW), []);
});

test("use(): цель — Actor или токен-объект (не TokenDocument), statistic spell-attack, MAP только когда он есть", () => {
  const actor = { id: "a" }, tokenDoc = { object: { id: "tok" }, actor: { id: "ta" } };
  assert.deepEqual(man.useParams(actor, tokenDoc, 0), { actors: [actor], target: { id: "tok" }, statistic: "spell-attack" });
  assert.equal(man.useParams(actor, { actor: { id: "ta" } }, 2).target.id, "ta");
  assert.equal(man.useParams(actor, tokenDoc, 2).multipleAttackPenalty, 2);
});

test("Spirit Link: 2 ПЗ на 2-м ранге, +2 за ранг выше, до максимума цели; заклинатель на 0 — связь кончилась ДО переноса; мёртвая цель и полные ПЗ — пропуск", () => {
  const base = { rank: 2, casterHp: 20, targetHp: 5, targetMax: 30, targetDead: false };
  assert.deepEqual(spirit.plan(base), { n: 2, zero: false });
  assert.equal(spirit.plan({ ...base, rank: 3 }).n, 4);
  assert.equal(spirit.plan({ ...base, rank: 5 }).n, 8);
  assert.equal(spirit.plan({ ...base, targetHp: 29 }).n, 1);   // не выше максимума
  assert.deepEqual(spirit.plan({ ...base, targetHp: 30 }), { skip: true });
  assert.deepEqual(spirit.plan({ ...base, casterHp: 0 }), { end: true });
  assert.deepEqual(spirit.plan({ ...base, targetDead: true }), { skip: true });
  assert.deepEqual(spirit.plan({ ...base, casterHp: 2 }), { n: 2, zero: true });
});

test("Spirit Link не попадает в перенос урона: intercept и linksOf его не видят (иначе урон цели делился бы пополам)", () => {
  const eff = (slug) => ({ id: slug, slug, system: { context: { origin: { actor: "Actor.caster" } }, level: { value: 1 } } });
  const actor = (slug) => ({ uuid: "Actor.target", itemTypes: { effect: [eff(slug)] } });
  assert.deepEqual(link.linksOf([eff(spirit.EFFECT)], "Actor.target"), []);
  assert.equal(link.intercept(actor(spirit.EFFECT), { damage: 10 }), null);
  assert.ok(link.intercept(actor("effect-share-life"), { damage: 10 }), "контроль: Share Life переносит");
  assert.equal(spirit.isDead({ type: "npc", statuses: new Set(["dead"]) }, 5), true);
  assert.equal(spirit.isDead({ type: "npc", statuses: new Set() }, 0), true);
  assert.equal(spirit.isDead({ type: "character", statuses: new Set(), hasCondition: () => false }, 0), false);   // умирающий герой
  assert.equal(spirit.isDead({ type: "npc", statuses: new Set(), hasCondition: () => false }, 3), false);
});

test("карточка заклинания «в чат» (нет cast-a-spell) — не сотворение: Spirit Link, перенос урона и кнопки манёвров молчат", async () => {
  globalThis.fromUuid = async () => { throw new Error("не должно дойти до заклинания"); };
  const chat = { flags: { pf2e: { origin: { type: "spell", uuid: "Item.s", actor: "Actor.caster", rollOptions: [] } } } };
  await spirit.onMessage(chat);
  await link.onMessage(chat);
  const html = { querySelector: () => { throw new Error("не должно дойти до карточки"); } };
  man.bind({ ...chat, flags: { pf2e: { ...chat.flags.pf2e, context: { type: "spell-cast" } } }, actor: { isOwner: true } }, html);
});
