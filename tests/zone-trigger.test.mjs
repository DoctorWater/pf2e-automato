// Триггеры зоны (triggered-save T2, onUse.zone.triggers): схема, форма, ключ идемпотентности, обработчики региона, выдача карточки-хозяина. Без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  combats: [],
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map(), getCondition: (slug) => ({ uuid: null, _stats: { compendiumSource: `Compendium.pf2e.conditionitems.Item.${slug}` }, name: slug, img: "i.svg", system: { value: { isValued: slug === "sickened" } }, toObject() { return { name: slug, type: "condition", system: { slug, value: { isValued: false, value: null } } }; } }) } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
class Field { constructor(o) { this.o = o; } }
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => Field }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o), escapeHTML: (s) => s } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: ({ actor }) => ({ actor: actor.id }), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const { ZoneBehaviorType } = await import("../scripts/zone.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");

const validate = rules.validateRule;
const CH = { statistic: "fortitude", dc: { value: 25 }, byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } };
const zoneRule = (triggers, z = {}) => ({ v: 1, onUse: { targets: "area", zone: { duration: { seconds: 60 }, triggers, ...z }, apply: [] } });

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = [];
  game.user.isActiveGM = true; game.combats = [];
});

/* ---------- схема и форма ---------- */

test("zone.triggers: зона может состоять только из триггеров; нормализация", () => {
  const r = validate(zoneRule([{ on: "turn-end", per: "round", challenge: CH }]));
  assert.deepEqual(r.errors, []);
  const z = r.rule.onUse.zone;
  assert.equal(z.condition, null);
  assert.deepEqual(z.triggers.map((t) => [t.on, t.per, t.challenge.statistic]), [["turn-end", "round", "fortitude"]]);
  assert.equal(validate(zoneRule([{ on: "enter", apply: [{ condition: { slug: "sickened" } }] }])).rule.onUse.zone.triggers[0].apply[0].to, "target");
  assert.equal(validate(zoneRule([], { condition: { slug: "concealed" } })).ok, true);   // пустой список — как без него
  assert.equal(validate(zoneRule([])).ok, false);   // zone.empty
});

test("zone.triggers: ошибки — событие, per, пустой, шаг не на цель, не массив", () => {
  for (const bad of [{ on: "exit", challenge: CH }, { challenge: CH }, { on: "enter", per: "day", challenge: CH }, { on: "enter" }, { on: "enter", apply: [{ to: "self", condition: { slug: "sickened" } }] }, "x"])
    assert.equal(validate(zoneRule([bad], { condition: { slug: "concealed" } })).ok, false, JSON.stringify(bad));
  assert.equal(validate(zoneRule("x", { condition: { slug: "concealed" } })).ok, false);
});

test("zone.triggers: форма мастерской туда-обратно (испытание, per, шаги, иммунитет)", () => {
  const src = zoneRule([
    { on: "enter", per: "turn", challenge: { ...CH, immunity: { slug: "cloud", duration: { value: 1, unit: "minutes" } }, traits: ["poison"] } },
    { on: "turn-start", apply: [{ to: "target", condition: { slug: "sickened", value: 1 } }] }
  ], { condition: { slug: "concealed" } });
  const rule = validate(src).rule, back = validate(formToRule(ruleToForm(rule)));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.rule.onUse.zone.triggers, rule.onUse.zone.triggers);
});

/* ---------- ключ идемпотентности ---------- */

test("triggerKey: per общий для записей и событий; раунд/ход; вне боя — само событие и номер записи", () => {
  const k = (o) => ev.triggerKey({ combat: "C", round: 2, turn: 3, evId: "E", region: "R", token: "T", i: 0, ...o });
  assert.equal(k({ per: "round", i: 0 }), k({ per: "round", i: 1, evId: "other" }));
  assert.notEqual(k({ per: "round" }), k({ per: "round", round: 3 }));
  assert.equal(k({ per: "round" }), k({ per: "round", turn: 9 }));
  assert.notEqual(k({ per: "turn" }), k({ per: "turn", turn: 4 }));
  assert.notEqual(k({}), k({ i: 1 }));
  assert.notEqual(k({}), k({ evId: "F" }));
  assert.equal(k({ per: "round", combat: undefined }), k({ combat: undefined }));   // вне боя per не поддерживается
});

/* ---------- обработчики региона ---------- */

const mkSys = (calls) => ({ trigger: async (token, on, e) => calls.push([token, on, e]) });
const ent = (o) => ({ data: { token: { id: "t1" }, ...o } });

test("tokenEnter: movement == null (создание/включение региона, снятие hidden) не триггер; ход региона — в событие", async () => {
  const calls = [], sys = { ...mkSys(calls), hold: async () => {} };
  game.combats = [{ id: "C", started: true, round: 2, turn: 1, combatants: [{ tokenId: "t1" }] }];
  await ZoneBehaviorType.events.tokenEnter.call(sys, ent({ movement: null }));
  assert.equal(calls.length, 0);
  await ZoneBehaviorType.events.tokenEnter.call(sys, ent({ movement: { id: "mv" } }));
  assert.deepEqual(calls.map((c) => [c[1], c[2]]), [["enter", { evId: "enter:mv", combat: "C", round: 2, turn: 1 }]]);
});

test("tokenTurnStart/End: skipped и не-ГМ молчат; стойкий evId бой:раунд:ход:событие", async () => {
  const calls = [], sys = mkSys(calls), combat = { id: "C" };
  const turn = (name, d) => ZoneBehaviorType.events[name].call(sys, ent({ combat, round: 2, turn: 1, skipped: false, ...d }));
  await turn("tokenTurnEnd", { skipped: true });
  game.user.isActiveGM = false; await turn("tokenTurnEnd", {}); game.user.isActiveGM = true;
  assert.equal(calls.length, 0);
  await turn("tokenTurnStart", {}); await turn("tokenTurnEnd", {});
  assert.deepEqual(calls.map((c) => [c[1], c[2].evId]), [["turn-start", "C:2:1:turn-start"], ["turn-end", "C:2:1:turn-end"]]);
});

/* ---------- выдача ---------- */

function mkActor(uuid) {
  let n = 0;
  const items = [];
  const actor = {
    uuid, name: uuid, id: uuid.split(".").pop(), items, isDead: false, hasPlayerOwner: false, tokens: [], getActiveTokens() { return this.tokens; },
    get itemTypes() { return { condition: items.filter((i) => i.type === "condition"), effect: items.filter((i) => i.type === "effect") }; },
    getSelfRollOptions: (p) => [`${p}:test`], getRollOptions: () => [],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => { const it = { ...structuredClone(d), id: `i${++n}`, uuid: `${uuid}.Item.i${n}`, actor, parent: actor, slug: d.system?.slug ?? d.name, _stats: {}, async delete() { items.splice(items.indexOf(it), 1); } }; items.push(it); return it; });
    }
  };
  uuids.set(uuid, actor);
  return actor;
}
const mkToken = (id, actor, disposition = -1) => { const t = { id, uuid: `Scene.s.Token.${id}`, name: id, actor, disposition }; actor.tokens = [t]; uuids.set(t.uuid, t); return t; };
const mkSysFull = (triggers, o = {}) => ({ region: { uuid: "Scene.s.Region.r", hidden: false }, expired: false, triggers, originActor: "Actor.author", originUuid: "Item.spell", dc: 27, skipOrigin: false, parent: { name: "Cloud" }, ...o });
const TURN_END = { evId: "C:2:1:turn-end", combat: "C", round: 2, turn: 1 };

test("fireZoneTrigger: карточка-хозяин на конце хода; повтор того же события и перезагрузка (поиск по ленте) — без второй карточки", async () => {
  const author = mkActor("Actor.author"), victim = mkActor("Actor.victim"), tok = mkToken("t1", victim);
  mkToken("a1", author, 1);
  const sys = mkSysFull([{ on: "turn-end", challenge: CH }]);
  await ev.fireZoneTrigger(sys, tok, "turn-end", TURN_END);
  assert.equal(created.length, 1);
  const use = created[0].flags[MOD].use;
  assert.equal(use.state.event, ev.triggerKey({ ...TURN_END, region: sys.region.uuid, token: "t1", i: 0 }));
  assert.equal(use.dc, 25);   // value испытания приоритетнее снимка зоны
  assert.deepEqual(use.targets.map((t) => t.key), ["t1"]);
  assert.equal(use.item.uuid, "Item.spell");
  await ev.fireZoneTrigger(sys, tok, "turn-end", TURN_END);
  assert.equal(created.length, 1);
  await ev.fireZoneTrigger(sys, tok, "turn-start", { ...TURN_END, evId: "C:2:1:turn-start" });   // у записи другое событие
  assert.equal(created.length, 1);
  await ev.fireZoneTrigger(sys, tok, "turn-end", { ...TURN_END, evId: "C:3:1:turn-end", round: 3 });   // новый раунд — новое испытание
  assert.equal(created.length, 2);
});

test("fireZoneTrigger: per:round — вход и конец хода в одном раунде бросают один раз; вне боя per не действует", async () => {
  const victim = mkActor("Actor.victim"), tok = mkToken("t1", victim);
  const sys = mkSysFull([{ on: "enter", per: "round", challenge: CH }, { on: "turn-end", per: "round", challenge: CH }]);
  await ev.fireZoneTrigger(sys, tok, "enter", { evId: "enter:m1", combat: "C", round: 2, turn: 1 });
  await ev.fireZoneTrigger(sys, tok, "turn-end", TURN_END);
  assert.equal(created.length, 1);
  await ev.fireZoneTrigger(sys, tok, "enter", { evId: "enter:m2", combat: "C", round: 3, turn: 0 });
  assert.equal(created.length, 2);
  await ev.fireZoneTrigger(sys, tok, "enter", { evId: "enter:m3" });
  await ev.fireZoneTrigger(sys, tok, "enter", { evId: "enter:m4" });
  assert.equal(created.length, 4);
});

test("fireZoneTrigger: скрытая/просроченная зона, мёртвый, автор эманации и режим challenge=off — без карточки", async () => {
  const victim = mkActor("Actor.victim"), tok = mkToken("t1", victim), trg = [{ on: "turn-end", challenge: CH }];
  await ev.fireZoneTrigger(mkSysFull(trg, { region: { uuid: "R", hidden: true } }), tok, "turn-end", TURN_END);
  await ev.fireZoneTrigger(mkSysFull(trg, { expired: true }), tok, "turn-end", TURN_END);
  await ev.fireZoneTrigger(mkSysFull(trg, { skipOrigin: true, originActor: "Actor.victim" }), tok, "turn-end", TURN_END);
  settings["mode.challenge"] = "off";
  await ev.fireZoneTrigger(mkSysFull(trg), tok, "turn-end", TURN_END);
  settings["mode.challenge"] = "auto";
  victim.isDead = true;
  await ev.fireZoneTrigger(mkSysFull(trg), tok, "turn-end", TURN_END);
  assert.equal(created.length, 0);
});

test("fireZoneTrigger: автор удалён — карточка по имени зоны, СЛ из снимка зоны; who:ally не касается врага", async () => {
  const victim = mkActor("Actor.victim"), tok = mkToken("t1", victim);   // Actor.author в uuids нет
  const noDc = { ...CH, dc: { source: "spell" } };
  await ev.fireZoneTrigger(mkSysFull([{ on: "turn-end", challenge: noDc }], { originUuid: "" }), tok, "turn-end", { ...TURN_END, evId: "d:turn-end", round: 7 });
  assert.equal(created.length, 1);
  const use = created[0].flags[MOD].use;
  assert.equal(use.dc, 27);
  assert.equal(use.actor, "Actor.author");
  assert.equal(use.item.name, "Cloud");
  assert.equal(created[0].speaker.alias, "Cloud");
  const allyOnly = { ...CH, byDegree: { failure: [{ to: "target", who: "ally", condition: { slug: "sickened" } }] } };
  await ev.fireZoneTrigger(mkSysFull([{ on: "turn-end", challenge: allyOnly }]), tok, "turn-end", { ...TURN_END, round: 9, evId: "x" });
  assert.equal(created.length, 1);   // t1 — враг (disposition -1), автор без токена = дружелюбный
});

test("fireZoneTrigger: триггер без испытания — шаги на существо в области, повтор события не дублирует", async () => {
  const victim = mkActor("Actor.victim"), tok = mkToken("t1", victim);
  const sys = mkSysFull([{ on: "enter", apply: [{ to: "target", condition: { slug: "sickened", value: 1 } }] }]);
  await ev.fireZoneTrigger(sys, tok, "enter", { evId: "enter:m5" });
  assert.equal(created.length, 0);
  assert.equal(victim.items.filter((i) => i.type === "condition").length, 1);
  await ev.fireZoneTrigger(sys, tok, "enter", { evId: "enter:m5" });
  assert.equal(victim.items.length, 1);
});
