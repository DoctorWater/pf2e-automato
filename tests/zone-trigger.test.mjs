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

test("fireZoneTrigger: перезагрузка — ключ уже на карточке в ленте при пустом fired, второй карточки нет", async () => {
  const victim = mkActor("Actor.victim"), tok = mkToken("t1", victim);
  const sys = mkSysFull([{ on: "turn-end", challenge: CH }]), e = { evId: "reload:1", combat: "C", round: 40, turn: 1 };
  const key = ev.triggerKey({ ...e, region: sys.region.uuid, token: "t1", i: 0 });
  msgs.set("old", { id: "old", flags: { [MOD]: { use: { state: { event: key } } } } });
  await ev.fireZoneTrigger(sys, tok, "turn-end", e);
  assert.equal(created.length, 0);
});

test("fireZoneTrigger: круг сотворения — на карточке-хозяине; СЛ по каждому триггеру (dcs[i])", async () => {
  const victim = mkActor("Actor.victim"), tok = mkToken("t1", victim);
  const sys = mkSysFull([{ on: "turn-end", challenge: CH }, { on: "turn-end", challenge: { ...CH, dc: { source: "spell" } } }], { castRank: 5, dcs: [null, 31], dc: 31 });
  await ev.fireZoneTrigger(sys, tok, "turn-end", { ...TURN_END, evId: "rank:1", round: 50 });
  assert.deepEqual(created.map((c) => [c.flags.pf2e?.origin.castRank, c.flags[MOD].use.dc]), [[5, 25], [5, 31]]);
  await ev.fireZoneTrigger(mkSysFull([{ on: "turn-end", challenge: CH }]), tok, "turn-end", { ...TURN_END, evId: "rank:2", round: 51 });
  assert.equal(created[2].flags.pf2e, undefined);   // круга нет — флага нет
});

test("attachZone: круг из сообщения-источника, СЛ по триггерам (снимок use.dc при пропавшем предмете), откат движения — не вход", async () => {
  const { attachZone } = await import("../scripts/zone.mjs");
  msgs.set("m1", { id: "m1", flags: { pf2e: { origin: { castRank: 4 } } } });
  game.time = { worldTime: 0 };
  const behaviors = [], region = { uuid: "Scene.s.Region.r", flags: {}, behaviors, parent: { tokens: [] }, async createEmbeddedDocuments(_, [d]) { const b = { ...d, region, system: d.system }; behaviors.push(b); return [b]; } };
  const rule = zoneRule([{ on: "turn-end", challenge: { ...CH, dc: { expr: "markup" } } }, { on: "enter", challenge: CH }]);
  await attachZone(region, rule, { originUuid: "Item.gone", originActor: "Actor.gone", messageId: "m1", dc: 22 });
  const sys = behaviors[0].system;
  assert.equal(sys.castRank, 4);
  assert.deepEqual(sys.dcs, [22, 25]);
  const calls = [], s = { ...mkSys(calls), hold: async () => {} };
  await ZoneBehaviorType.events.tokenEnter.call(s, ent({ movement: { id: "mv", method: "undo" } }));
  assert.equal(calls.length, 0);
});

test("fireZoneTrigger: токен не существо (isOfType) — карточки нет", async () => {
  const victim = mkActor("Actor.victim"), tok = mkToken("t1", victim);
  victim.isOfType = (t) => t === "vehicle";
  await ev.fireZoneTrigger(mkSysFull([{ on: "turn-end", challenge: CH }]), tok, "turn-end", TURN_END);
  assert.equal(created.length, 0);
  victim.isOfType = (t) => t === "creature";
  await ev.fireZoneTrigger(mkSysFull([{ on: "turn-end", challenge: CH }]), tok, "turn-end", { ...TURN_END, evId: "creature:turn-end", round: 41 });
  assert.equal(created.length, 1);
});

/* ---------- T4: эманация следует за токеном ---------- */

const BASE = { x: 100, y: 200, width: 1, height: 1, shape: 4 };
const tokenAt = (id, o = {}) => ({ id, _source: { ...BASE, ...o } });
const emRegion = (o = {}) => ({ id: "R1", shapes: [{ type: "emanation", base: { type: "token", ...BASE }, radius: 15 }], parent: { tokens: [tokenAt("other", { x: 0 }), tokenAt("caster")] }, ...o });

test("emanationToken: токен выводится из фигуры (x/y/размер/форма), не эманация и чужая база — null", async () => {
  const { emanationToken } = await import("../scripts/zone.mjs");
  assert.equal(emanationToken(emRegion()).id, "caster");
  assert.equal(emanationToken({ ...emRegion(), shapes: [{ type: "circle", x: 100, y: 200, radius: 5 }] }), null);
  assert.equal(emanationToken({ ...emRegion(), shapes: [{ type: "emanation", base: { type: "template", ...BASE } }] }), null);
  assert.equal(emanationToken(emRegion({ parent: { tokens: [tokenAt("other", { y: 1 })] } })), null);
  // отложенный запуск: заклинатель ушёл, точного совпадения нет — единственный токен актёра-автора
  const moved = emRegion({ parent: { tokens: [{ ...tokenAt("a1", { x: 900 }), actor: { uuid: "Actor.A" } }, { ...tokenAt("b1", { x: 800 }), actor: { uuid: "Actor.B" } }] } });
  assert.equal(emanationToken(moved), null);
  assert.equal(emanationToken(moved, undefined, "Actor.A").id, "a1");
  assert.equal(emanationToken(moved, undefined, "Actor.Z"), null);
  const twins = emRegion({ parent: { tokens: [{ ...tokenAt("a1", { x: 900 }), actor: { uuid: "Actor.A" } }, { ...tokenAt("a2", { x: 800 }), baseActor: { uuid: "Actor.A" } }] } });
  assert.equal(emanationToken(twins, undefined, "Actor.A"), null);   // двое — не гадаем
  assert.equal(emanationToken({ ...moved, shapes: [{ type: "circle", x: 1, y: 2, radius: 5 }] }, undefined, "Actor.A"), null);
});

test("follow: валидатор пропускает только false", () => {
  assert.equal(validate(zoneRule([{ on: "enter", challenge: CH }], { follow: false })).rule.onUse.zone.follow, false);
  assert.equal(validate(zoneRule([{ on: "enter", challenge: CH }], { follow: true })).ok, false);
  assert.equal(validate(zoneRule([{ on: "enter", challenge: CH }])).rule.onUse.zone.follow, undefined);
});

test("attachZone: эманация привязывается к токену ядром; follow:false и чужая фигура — нет", async () => {
  const { attachZone } = await import("../scripts/zone.mjs");
  game.time = { worldTime: 0 };
  const run = async (z, o) => {
    const updates = [], behaviors = [];
    const region = { uuid: "Scene.s.Region.r", flags: {}, behaviors, ...emRegion(o), _source: {}, async update(d) { updates.push(d); }, async createEmbeddedDocuments(_, [d]) { const b = { ...d, system: d.system }; behaviors.push(b); return [b]; } };
    await attachZone(region, zoneRule([{ on: "enter", challenge: CH }], z), {});
    return updates;
  };
  assert.deepEqual(await run({}), [{ "attachment.token": "caster" }]);
  assert.deepEqual(await run({ follow: false }), []);
  assert.deepEqual(await run({}, { shapes: [{ type: "circle", x: 1, y: 1, radius: 5 }] }), []);
});

test("вход при наезде: boundary снимает состав, moveToken докладывает ход, tokenEnter(null) — новичку один раз; undo/config, снятие hidden, чужой регион — нет", async () => {
  const calls = [], sys = { ...mkSys(calls), hold: async () => {} };
  game.combats = [{ id: "C", started: true, round: 2, turn: 1, combatants: [{ tokenId: "t1" }] }];
  let n = 0;
  // порядок ядра: regionBoundary (наехавших в region.tokens ещё нет) -> moveToken заклинателя -> tokenEnter(null)
  const mk = (tid, inside = []) => {
    const carrier = { id: "caster" }, tokens = new Map([["caster", carrier]]);
    const region = { id: `R${++n}`, _source: { attachment: { token: tid } }, tokens: new Set(inside.map((id) => ({ id }))), behaviors: [], parent: { tokens, regions: [] } };
    region.parent.regions.push(region); carrier.parent = region.parent;
    return { region, carrier };
  };
  const boundary = (r) => ZoneBehaviorType.events.regionBoundary.call({}, { region: r, data: {} });
  const enter = (r, token = "t1") => ZoneBehaviorType.events.tokenEnter.call({ ...sys, region: r }, { data: { token: { id: token }, movement: null } });
  const moved = (c, mv) => ZoneBehaviorType.onCarrierMoved(c, mv);

  let { region, carrier } = mk("caster");
  await boundary(region); await moved(carrier, { id: "mv1", method: "walk" });
  await enter(region); await enter(region);   // второй раз тот же токен — не вход
  assert.deepEqual(calls.map((c) => [c[1], c[2].evId]), [["enter", "enter:mv1"]]);

  calls.length = 0;
  await enter(region, "t2");   // другой новичок того же хода — вход
  assert.equal(calls.length, 1);

  calls.length = 0;
  ({ region, carrier } = mk("caster", ["t1"]));   // уже внутри до хода (продолжение хода с тем же id) — не вход
  await boundary(region); await moved(carrier, { id: "mv1", method: "walk" }); await enter(region);
  assert.equal(calls.length, 0);
  ({ region, carrier } = mk("caster"));   // продолжение хода: вторая граница с тем же movement.id снова даёт вход новичку
  await boundary(region); await moved(carrier, { id: "mv1", method: "walk" });
  await enter(region, "t3");
  assert.equal(calls.length, 1);

  calls.length = 0;
  for (const mv of [{ id: "mv2", method: "undo" }, { id: "mv3", method: "config" }]) {
    ({ region, carrier } = mk("caster")); await boundary(region); await moved(carrier, mv); await enter(region);
  }
  ({ region, carrier } = mk("caster")); await enter(region);   // снятие hidden / включение поведения: boundary не было — записи нет
  ({ region, carrier } = mk(null)); await boundary(region); await moved(carrier, { id: "mv4", method: "walk" }); await enter(region);   // не привязан
  assert.equal(calls.length, 0);

  // сама жертва: config и undo — не вход, обычный ход — вход
  const direct = (movement) => ZoneBehaviorType.events.tokenEnter.call({ ...sys, region }, ent({ movement }));
  await direct({ id: "m1", method: "config" }); await direct({ id: "m2", method: "undo" });
  assert.equal(calls.length, 0);
  await direct({ id: "m3", method: "walk" });
  assert.deepEqual(calls.map((c) => c[2].evId), ["enter:m3"]);
});

test("onCarrierMoved: enterBy:path пропускает отключённое поведение", async () => {
  const parent = { grid: { size: 100, distance: 5 }, tokens: [], regions: [] };
  const tk = (id, x, y) => ({ id, x, y, width: 1, height: 1, elevation: 0, depth: 1, actor: {}, parent });
  const carrier = tk("c", 900, 300), near = tk("near", 500, 500);
  parent.tokens.push(carrier, near);
  game.combats = [];
  const calls = [];
  const mkR = (disabled) => ({ id: "R", _source: { attachment: { token: "c" } }, shapes: [{ type: "emanation", radius: 200, base: { type: "token" } }], behaviors: [{ type: `${MOD}.zone`, disabled, system: { enterBy: "path", trigger: async (t, on, e) => calls.push([t.id, e.evId]) } }] });
  const mv = { id: "m", method: "walk", origin: { x: 100, y: 300, width: 1, height: 1 }, destination: { x: 900, y: 300, width: 1, height: 1 }, passed: { waypoints: [] } };
  parent.regions = [mkR(true)]; await ZoneBehaviorType.onCarrierMoved(carrier, mv);
  assert.equal(calls.length, 0);
  parent.regions = [mkR(false)]; await ZoneBehaviorType.onCarrierMoved(carrier, mv);
  assert.deepEqual(calls, [["near", "enter:m"]]);
});

test("markZoneGone: удаление региона не нами закрывает карточку; уже истёкшая не перезаписывается", async () => {
  const { markZoneGone } = await import("../scripts/zone.mjs");
  const mk = (status) => {
    const m = { id: "m1", flags: { [MOD]: { use: { state: { zone: { regionUuid: "Scene.s.Region.r", status } } } } }, updates: [], async update(u) { this.updates.push(u); } };
    msgs.set("m1", m);
    return { m, region: { uuid: "Scene.s.Region.r", behaviors: [{ type: `${MOD}.zone`, system: { messageId: "m1" } }] } };
  };
  let t = mk("active"); await markZoneGone(t.region);
  assert.deepEqual(t.m.updates, [{ [`flags.${MOD}.use.state.zone.status`]: "closed" }]);
  t = mk("expired"); await markZoneGone(t.region);
  assert.equal(t.m.updates.length, 0);
});

test("enterBy/onCarrierGone: валидатор и форма мастерской туда-обратно", () => {
  const tr = [{ on: "enter", challenge: CH }];
  const z = validate(zoneRule(tr, { enterBy: "path", onCarrierGone: "stay", follow: false })).rule.onUse.zone;
  assert.deepEqual([z.enterBy, z.onCarrierGone, z.follow], ["path", "stay", false]);
  assert.equal(validate(zoneRule(tr, { enterBy: "never" })).ok, false);
  assert.equal(validate(zoneRule(tr, { onCarrierGone: "x" })).ok, false);
  const plain = validate(zoneRule(tr)).rule.onUse.zone;
  assert.deepEqual([plain.enterBy, plain.onCarrierGone], [undefined, undefined]);   // по умолчанию — без ключей
  const rule = validate(zoneRule(tr, { enterBy: "path", onCarrierGone: "stay", follow: false })).rule;
  assert.deepEqual(formToRule(ruleToForm(rule)).onUse.zone, validate(formToRule(ruleToForm(rule))).rule.onUse.zone);
  const back = formToRule(ruleToForm(rule)).onUse.zone;
  assert.deepEqual([back.enterBy, back.onCarrierGone, back.follow], ["path", "stay", false]);
});

test("pathEntrants: задетый по пути, но не накрытый в конце; уже внутри и сам заклинатель — нет", async () => {
  const { pathEntrants } = await import("../scripts/zone.mjs");
  const parent = { grid: { size: 100, distance: 5 }, tokens: [] };
  const tk = (id, x, y) => ({ id, x, y, width: 1, height: 1, elevation: 0, depth: 1, actor: {}, parent });
  const carrier = tk("c", 900, 300), near = tk("near", 500, 500), far = tk("far", 500, 1500), inside = tk("in", 200, 300);
  parent.tokens.push(carrier, near, far, inside);
  const region = { shapes: [{ type: "emanation", gridBased: true, radius: 200, base: { type: "token" } }] };
  const mv = { origin: { x: 100, y: 300, width: 1, height: 1 }, destination: { x: 900, y: 300, width: 1, height: 1 }, passed: { waypoints: [] } };
  // carrier в документе уже в конце пути; inside стоит вплотную к началу
  assert.deepEqual(pathEntrants(region, carrier, mv).map((t) => t.id), ["near"]);
  assert.deepEqual(pathEntrants({ shapes: [] }, carrier, mv), []);
});
