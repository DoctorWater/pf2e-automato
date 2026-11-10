import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { MOD } = await import("../scripts/util.mjs");
const mech = await import("../scripts/mech.mjs");
const { reasonOf, preCreate } = await import("../scripts/builtin/impulse-gate.mjs");
const { initOverlays, validateRule } = await import("../scripts/rules.mjs");
const { strikeLinkEntry, strikeLinkState, strikeLinked } = await import("../scripts/strike-link.mjs");
const { resetIndex } = await import("../scripts/compat.mjs");
const { pickManeuvers, maneuversOf } = await import("../scripts/builtin/maneuver.mjs");
const { permanentOf, PERMANENT } = await import("../scripts/builtin/neutralize-rules.mjs");

const flagged = (item, m) => ({ ...item, flags: { [MOD]: { mech: m } } });

/* ---------- флаг и форма ---------- */

test("normalizeMech: допустимое остаётся, мусор и неизвестные ключи отбрасываются", () => {
  assert.deepEqual(mech.normalizeMech({ recharge: false, req: false, strike: false, permanent: false, maneuvers: ["trip", "disarm"] }),
    { recharge: false, req: false, strike: false, permanent: false, maneuvers: ["disarm", "trip"] }, "манёвры в порядке таблицы");
  assert.deepEqual(mech.normalizeMech({ recharge: " 1D6 " }), { recharge: "1d6" });
  assert.deepEqual(mech.normalizeMech({ recharge: "1d4 + 1" }), { recharge: "1d4+1" });
  for (const bad of [{ recharge: "abc" }, { recharge: "1к6" }, { recharge: true }, { recharge: 5 }, { req: true }, { strike: "no" }, { permanent: 0 }, { maneuvers: [] }, { maneuvers: ["fly"] }, { maneuvers: "trip" }, { other: 1 }, [], "x", null, undefined]) {
    assert.deepEqual(mech.normalizeMech(bad), {}, JSON.stringify(bad));
  }
  assert.deepEqual(mech.normalizeMech({ maneuvers: ["fly", "trip"] }), { maneuvers: ["trip"] });
  assert.deepEqual(mech.mechOf({ flags: { [MOD]: { mech: { req: false } } } }), { req: false });
  assert.deepEqual(mech.mechOf({}), {});
});

test("форма: флаг -> форма -> флаг без потерь; значения из data-v приходят строками", () => {
  for (const m of [{}, { recharge: false }, { recharge: "1d4+1" }, { req: false, strike: false, permanent: false }, { maneuvers: ["shove", "trip"] }]) {
    const f = mech.mechToForm(m);
    assert.deepEqual(mech.formToMech(f), m, JSON.stringify(m));
    assert.deepEqual(mech.mechErrors(f), []);
  }
  const f = mech.mechToForm({});
  f.maneuvers.auto = "false"; f.maneuvers.list.trip = "true"; f.strike.off = "true";
  assert.deepEqual(mech.formToMech(f), { strike: false, maneuvers: ["trip"] });
});

test("mechErrors: «1к6» и пустой выбор манёвров — ошибки; «не ограничивать» глушит ошибку срока", () => {
  const f = mech.mechToForm({});
  f.recharge.dice = "1к6";
  assert.deepEqual(mech.mechErrors(f), ["workshop.mech.err.dice"]);
  f.recharge.off = true;
  assert.deepEqual(mech.mechErrors(f), []);
  f.recharge.off = false; f.recharge.dice = "1d6";
  assert.deepEqual(mech.mechErrors(f), []);
  f.maneuvers.auto = false;
  assert.deepEqual(mech.mechErrors(f), ["workshop.mech.err.maneuvers"]);
  f.maneuvers.list.disarm = true;
  assert.deepEqual(mech.mechErrors(f), []);
});

/* ---------- сохранение: каждая часть только если менялась ---------- */

const RULE = `flags.${MOD}.rule`, MECH = `flags.${MOD}.mech`;
const norm = (p) => Object.keys(p).map((k) => k.replace(/\.-=|\.==/, "."));   // ForcedReplacement/Deletion вне Foundry — устаревшие `==`/`-=`

test("savePatch: без правки правила флаг rule не пишется (пустое onUse не перекрывает мир, каталог и разметку)", () => {
  const rule = { v: 1, kind: "onUse" };
  assert.deepEqual(norm(mech.savePatch({ ruleDirty: false, rule, mechDirty: true, mech: { req: false } })), [MECH], "только mech");
  assert.deepEqual(mech.savePatch({ ruleDirty: false, rule, mechDirty: false, mech: {} }), {}, "ничего не менялось — ничего не пишем");
  assert.deepEqual(norm(mech.savePatch({ ruleDirty: true, rule, areaPatch: { "system.area": { type: "burst", value: 20 } }, mechDirty: false, mech: {} })), [RULE, "system.area"], "правка правила не пишет mech");
  assert.deepEqual(norm(mech.savePatch({ ruleDirty: true, rule, mechDirty: true, mech: { strike: false } })), [RULE, MECH]);
});

test("savePatch: пустой mech удаляет флаг, непустой заменяет целиком", () => {
  assert.deepEqual(norm(mech.savePatch({ ruleDirty: false, mechDirty: true, mech: {} })), [MECH]);
  const del = mech.savePatch({ ruleDirty: false, mechDirty: true, mech: {} }), set = mech.savePatch({ ruleDirty: false, mechDirty: true, mech: { permanent: false } });
  assert.equal(Object.values(del)[0], null, "удаление");
  assert.deepEqual(Object.values(set)[0], { permanent: false });
});

/* ---------- читатели рантайма ---------- */

const BREATH_TEXT = "You can't use Breath Weapon again for [[/gmr 1d4 #Recharge Breath Weapon]]{1d4 rounds}.";
const breath = { id: "b1", type: "action", slug: "breath-weapon", uuid: "I.b", name: "Breath Weapon", system: { traits: { value: [] }, actionType: { value: "action" }, description: { value: BREATH_TEXT } } };

test("M1: rechargeEntry — текст, свой срок, «не ограничивать»; тип предмета как в preCreate", () => {
  assert.deepEqual(mech.rechargeEntry(breath), { dice: "1d4" });
  assert.deepEqual(mech.rechargeEntry(flagged(breath, { recharge: "1d6" })), { dice: "1d6" });
  assert.equal(mech.rechargeEntry(flagged(breath, { recharge: false })), null);
  assert.equal(mech.rechargeEntry({ ...breath, type: "equipment" }), null, "лимиты — spell/action/feat");
  const none = { ...breath, system: { description: { value: "no roll" } } };
  assert.equal(mech.rechargeEntry(none), null);
  assert.equal(mech.rechargeEntry(flagged(none, { recharge: "1d6" })), null, "«добавить перезарядку» не делаем");
  const c = (item) => ({ traits: [], rc: mech.rechargeEntry(item), inCombat: true, limitsOn: true, combatId: "c", roundNum: 2, rcLock: { c: "c", until: 5 } });
  assert.equal(reasonOf(c(breath)), "recharge");
  assert.equal(reasonOf(c(flagged(breath, { recharge: false }))), null, "строка LIMITS не срабатывает");
});

let seq = 0;   // pending (5 с) общий на файл по uuid актёра: у каждого мира свой
function world() {
  const uuid = `A.${++seq}`, actor = { uuid, type: "npc", flags: {}, itemTypes: { action: [], effect: [] }, abilities: { con: { mod: 0 } }, system: {}, update: async () => {} };
  globalThis.game = {
    user: { id: "u", isActiveGM: true }, messages: { contents: [] }, settings: { get: () => "auto" }, keyboard: { isModifierActive: () => false },
    i18n: { localize: (k) => k, format: (k) => k }, combats: [{ id: "c", started: true, active: true, scene: {}, round: 1, turn: 0, combatants: [{ actor: { uuid } }] }]
  };
  globalThis.ui = { notifications: { warn() {} } };
  globalThis.CONFIG = { Dice: { randomUniform: () => 0.99 } };
  return actor;
}
const useMsg = (actor, item) => { const m = { actor, item, flags: { pf2e: { context: { type: "self-effect" } } }, updateSource(ch) { m.upd = { ...m.upd, ...ch }; } }; return m; };

test("M1 в preCreate: срок из mech идёт в бросок; recharge:false — ни броска, ни блока второго использования", () => {
  let a = world(), m = useMsg(a, breath);
  assert.equal(preCreate(m, {}, {}, "u"), undefined);
  assert.equal(m.upd[`flags.${MOD}.limitMarks`].rc_b1.dice, "1d4");
  a = world(); m = useMsg(a, flagged(breath, { recharge: "1d6" }));
  preCreate(m, {}, {}, "u");
  assert.equal(m.upd[`flags.${MOD}.limitMarks`].rc_b1.dice, "1d6");
  a = world(); m = useMsg(a, flagged(breath, { recharge: false }));
  assert.equal(preCreate(m, {}, {}, "u"), undefined);
  assert.equal(m.upd?.[`flags.${MOD}.limitMarks`], undefined, "ни rc_*");
  a.flags[MOD] = { rc_b1: { c: "c", until: 5 } };
  assert.equal(preCreate(useMsg(a, flagged(breath, { recharge: false })), {}, {}, "u"), undefined, "замок не блокирует");
  assert.equal(preCreate(useMsg(a, breath), {}, {}, "u"), false, "без флага замок блокирует");
  delete globalThis.CONFIG;
});

test("M2: req:false — требование не блокирует; без флага блок", () => {
  const GRAB = "Compendium.pf2e.test.Item.GRAB";
  initOverlays(null, null, null, { v: 1, bySource: { [GRAB]: { any: [{ k: "holds" }] } } });
  try {
    const grab = { id: "g1", type: "action", slug: "grab", uuid: "I.g", name: "Grab", _stats: { compendiumSource: GRAB }, system: { traits: { value: [] }, actionType: { value: "action" } } };
    assert.equal(preCreate(useMsg(world(), grab), {}, {}, "u"), false, "существо никого не держит: блок");
    assert.equal(preCreate(useMsg(world(), flagged(grab, { req: false })), {}, {}, "u"), undefined);
  } finally { initOverlays(null, null, null, null); }
});

const POISON = { v: 1, label: "Venom", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } } };
const passive = (slug, o = {}) => ({ type: "action", slug, name: slug, uuid: `Actor.x.Item.${slug}`, system: { actionType: { value: "passive" }, frequency: null, description: { value: "" } }, flags: {}, ...o });
const strikeOf = (...fx) => ({ type: "melee", name: "Fangs", system: { attackEffects: { value: fx } } });
const res = (rule, source = "catalog") => ({ rule: validateRule(rule).rule, source });
const PA = { g: { name: "Venom", isActive: true, source: ["venom"] } };
const settings = (o = {}) => {
  game.settings = { get: (_m, k) => (k === "rulesV3" ? PA : { "mode.effect": "auto", "mode.challenge": "auto", yieldToAutomations: false, ...o }[k]) };
  game.modules = { get: () => (o.pa ? { active: true } : null) };
  resetIndex();
};
const withActor = (item, strikes) => { item.actor = { items: [item, ...strikes], itemTypes: { melee: strikes } }; return item; };
const OFF = { flags: { [MOD]: { mech: { strike: false } } } };

test("M3: strike:false — strikeLinkEntry null (ручная карточка возвращается); без флага связь есть", () => {
  const item = passive("venom"), s = [strikeOf("venom")];
  assert.ok(strikeLinkEntry(res(POISON), item, s));
  assert.equal(strikeLinkEntry(res(POISON), flagged(item, { strike: false }), s), null);
});

test("M3 strikeLinkState: причины off — flag, needRule, mode, yield; связи нет — null; strikeLinked (контракт use.mjs) отдаёт связь только без причины", () => {
  const s = [strikeOf("venom")], mk = (o = {}) => withActor(passive("venom", o), s), poison = () => res(POISON);
  settings();
  assert.equal(strikeLinkState(mk(), poison).off, null);
  assert.equal(strikeLinkState(mk(), poison).strikes.length, 1);
  assert.equal(strikeLinkState(mk(OFF), poison).off, "flag");
  assert.equal(strikeLinkState(mk(), () => res(POISON, "markup")).off, "needRule", "разметка сама не исполняется");
  assert.equal(strikeLinkState(mk(OFF), () => res(POISON, "markup")).off, "flag", "переопределение предмета — раньше правила");
  assert.equal(strikeLinkState(withActor(passive("venom"), [strikeOf("other")]), poison), null, "Удар не ссылается");
  assert.equal(strikeLinkState(passive("venom"), poison), null, "нет актёра");
  settings({ "mode.challenge": "off" });
  assert.equal(strikeLinkState(mk(), poison).off, "mode");
  settings({ yieldToAutomations: true, pa: true });
  assert.equal(strikeLinkState(mk(), poison).off, "yield");
  settings({ yieldToAutomations: true, pa: true, "mode.challenge": "off" });
  assert.equal(strikeLinkState(mk(), poison).off, "mode", "режим раньше уступки");
  settings();
});

test("M3 strikeLinked: контракт — объект {rule, strikes} или null; mech.strike:false даёт null", () => {
  // resolveRule без каталога вернёт null — проверяем только null-ветки реального вызова; связь с причиной — выше (strikeLinkState с подменой)
  settings();
  assert.equal(strikeLinked(passive("venom")), null, "нет актёра");
  assert.equal(strikeLinked(withActor(passive("venom", OFF), [strikeOf("venom")])), null, "flag: каталога нет, связи нет");
  settings({ "mode.effect": "off", "mode.challenge": "off" });
  assert.equal(strikeLinked(withActor(passive("venom"), [strikeOf("venom")])), null);
  settings();
});

test("M5: переопределение пересекается с таблицей SPELLS; пусто/вне таблицы — вычисленные; режим off — []", () => {
  assert.deepEqual(pickManeuvers("telekinetic-maneuver", ["disarm", "shove", "reposition", "trip"], ["trip", "disarm"]), ["disarm", "trip"]);
  assert.deepEqual(pickManeuvers("telekinetic-maneuver", ["disarm", "trip"], undefined), ["disarm", "trip"]);
  assert.deepEqual(pickManeuvers("magnetic-attraction", ["disarm"], ["trip"]), ["disarm"], "вне таблицы");
  assert.deepEqual(pickManeuvers("nothing", [], ["trip"]), []);
  game.settings = { get: () => "auto" }; game.i18n = { localize: () => "" };
  const tk = { type: "spell", slug: "telekinetic-maneuver", name: "TM", system: { description: { value: "" } } };
  assert.deepEqual(maneuversOf(tk), ["disarm", "shove", "reposition", "trip"]);
  assert.deepEqual(maneuversOf(flagged(tk, { maneuvers: ["trip"] })), ["trip"]);
  game.settings = { get: () => "off" };
  assert.deepEqual(maneuversOf(flagged(tk, { maneuvers: ["trip"] })), []);
});

test("M6: permanent:false — permanentOf null (и у _source), без флага — запись таблицы", () => {
  const zombie = { type: "action", slug: "slow", name: "Slow", flags: {} };
  assert.equal(permanentOf(zombie, "npc"), PERMANENT.slow);
  assert.equal(permanentOf(flagged(zombie, { permanent: false }), "npc"), null);
  assert.equal(permanentOf(zombie, "character"), null);
});
