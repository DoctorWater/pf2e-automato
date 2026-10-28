// 0.5g3: примитив onEvent — схема, форма туда-обратно, выбор правил по событию, исполнение через applyOps, идемпотентность, переброс. Без Foundry.
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
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const { ruleToForm, formToRule, blankEvent, ruleUuids } = await import("../scripts/sheet.mjs");
const { roundTrip } = await import("../tools/validate.mjs");

const validate = rules.validateRule;
const EFF = "Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ";
const one = (e) => validate({ v: 1, onEvent: [e] });

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = [];
});

/* ---------- схема ---------- */

test("onEvent: валидная запись нормализуется (side по умолчанию self, порядок ключей, нет поля без событий)", () => {
  const r = one({ on: "damage-roll", when: ["self:effect:panache"], once: true, apply: [{ removeEffect: { slug: "panache" } }] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rule.onEvent, [{ on: "damage-roll", side: "self", when: ["self:effect:panache"], once: true, apply: [{ to: "self", removeEffect: { slug: "panache" } }] }]);
  assert.equal("onEvent" in validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF } }] } }).rule, false);   // правила без событий не меняются
  assert.equal(validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF } }] }, onEvent: [] }).ok, true);
});

test("onEvent: все события и стороны; side:target — только у бросков и сотворения", () => {
  for (const on of rules.EVENT_ON) assert.equal(one({ on, ...(on === "enter" && { side: "near", range: 20 }), apply: [{ effect: { uuid: EFF } }] }).ok, true, on);   // enter — только near
  for (const side of rules.EVENT_SIDES.filter((s) => s !== "near")) assert.equal(one({ on: "attack-roll", side, apply: [{ effect: { uuid: EFF } }] }).ok, true, side);
  for (const on of ["saving-throw", "damage-taken", "turn-start", "turn-end", "effect-created", "effect-deleted"]) assert.equal(one({ on, side: "target", apply: [{ effect: { uuid: EFF } }] }).ok, false, on);
  for (const on of ["attack-roll", "skill-check", "damage-roll", "spell-cast"]) assert.equal(one({ on, side: "target", apply: [{ effect: { uuid: EFF } }] }).ok, true, on);
});

test("onEvent: отказы валидатора", () => {
  const step = [{ effect: { uuid: EFF } }];
  for (const bad of [{ apply: step }, { on: "start", apply: step }, { on: "attack-roll", side: "me", apply: step }, { on: "attack-roll" }, { on: "attack-roll", apply: [] },
    { on: "attack-roll", apply: step, when: "feat:x" }, { on: "attack-roll", apply: step, when: [] }, { on: "attack-roll", apply: step, once: "yes" },
    { on: "attack-roll", apply: [{}] }, { on: "attack-roll", challenge: { statistic: "will" } }, "x", null]) assert.equal(one(bad).ok, false, JSON.stringify(bad));
  assert.equal(validate({ v: 1, onEvent: "x" }).ok, false);
  assert.equal(validate({ v: 1, onEvent: [] }).ok, false);   // пустое правило
});

test("onEvent: рядом с onUse и макросами, но onUse + onAttacked по-прежнему нельзя", () => {
  const e = { on: "turn-end", apply: [{ removeEffect: { slug: "x" } }] };
  assert.equal(validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF } }] }, onEvent: [e] }).ok, true);
  assert.equal(validate({ v: 1, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: 2 } }, onEvent: [e] }).ok, true);
  assert.equal(validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF } }] }, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: 2 } }, onEvent: [e] }).ok, false);
});

test("onEvent: испытание другого участника — те же правила, что у onUse.challenge", () => {
  const ch = { statistic: "will", dc: { against: "class" }, byDegree: { failure: [{ condition: { slug: "frightened", value: 1 } }], criticalFailure: [{ to: "self", effect: { uuid: EFF } }] } };
  const r = one({ on: "attack-roll", side: "target", challenge: ch });
  assert.deepEqual(r.errors, []);
  assert.equal(r.rule.onEvent[0].challenge.byDegree.failure[0].to, "target");
  assert.equal(r.rule.onEvent[0].challenge.byDegree.criticalFailure[0].to, "self");
  assert.equal(one({ on: "attack-roll", challenge: { statistic: "will", dc: { value: 1, expr: "x" } } }).ok, false);
});

/* ---------- форма туда-обратно ---------- */

const samples = [
  { v: 1, onEvent: [{ on: "damage-roll", side: "self", when: ["self:effect:panache", { not: "x" }], apply: [{ to: "self", removeEffect: { slug: "panache" } }, { to: "target", condition: { slug: "frightened", value: 1, policy: "max" } }] }] },
  { v: 1, label: "Н", onEvent: [{ on: "attack-roll", side: "target", challenge: { statistic: "will", dc: { against: "class" }, basic: false, rollerRole: "target", traits: ["fear"], byDegree: { failure: [{ to: "target", condition: { slug: "frightened", value: 1, policy: "max" } }] } } }] },
  { v: 1, onEvent: [{ on: "turn-end", side: "origin", once: true, apply: [{ to: "self", extendEffect: { slug: "inspire-courage", rounds: 1 } }] }, { on: "effect-created", side: "self", when: ["effect:spike-skin"], apply: [{ to: "self", rollOption: { domain: "all", option: "o" } }] }] },
  { v: 1, yield: null, onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, check: null, apply: [{ to: "self", effect: { uuid: EFF } }] }, onAttacked: null, macros: [], onTurn: null, onEvent: [{ on: "spell-cast", side: "self", when: [{ gte: ["item:rank", 2] }], apply: [{ to: "self", effect: { uuid: EFF, badge: "increment" } }] }] }
];
test("onEvent: правило -> форма -> правило без потерь; вид формы onEvent", () => {
  for (const raw of samples) {
    const rule = validate(raw);
    assert.equal(rule.ok, true, JSON.stringify(rule.errors));
    assert.equal(roundTrip(rule.rule), true, JSON.stringify(raw));
  }
  assert.equal(ruleToForm(validate(samples[0]).rule).kind, "onEvent");
  assert.equal(ruleToForm(validate(samples[3]).rule).kind, "onUse");   // события не прячутся и не теряются у правила с onUse
  assert.equal(ruleToForm(validate(samples[3]).rule).ev.length, 1);
});

test("форма: пустая запись из blankEvent невалидна (нет шагов), с шагом — валидна; без записей поле не пишется", () => {
  const f = ruleToForm(validate(samples[0]).rule);
  assert.equal("onEvent" in formToRule({ ...f, ev: [] }), false);
  const blank = blankEvent();
  assert.equal(validate(formToRule({ ...f, ev: [blank] })).ok, false);
  const row = { ...f.ev[0].apply[0] };
  assert.equal(validate(formToRule({ ...f, ev: [{ ...blank, apply: [row] }] })).ok, true);
});

test("ruleUuids: эффекты и removeEffect по uuid в записях и их испытаниях", () => {
  const r = validate({ v: 1, onEvent: [{ on: "attack-roll", apply: [{ effect: { uuid: EFF } }, { removeEffect: { uuid: "Compendium.x.Item.A" } }], challenge: { statistic: "will", dc: { value: 20 }, byDegree: { failure: [{ effect: { uuid: "Compendium.x.Item.B" } }] } } }] }).rule;
  assert.deepEqual(ruleUuids(r).sort(), [EFF, "Compendium.x.Item.A", "Compendium.x.Item.B"].sort());
});

/* ---------- каталог: индекс правил ---------- */

test("onEventIndex: только правила с onEvent, мировой каталог перекрывает встроенный", () => {
  const e = { on: "turn-end", apply: [{ removeEffect: { slug: "x" } }] };
  rules.initCatalog([{ v: 1, bySlug: { a: { v: 1, onEvent: [e] }, b: { v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF } }] } } }, bySource: { "Compendium.x.Item.S": { v: 1, onEvent: [e] } } }], {});
  const idx = rules.onEventIndex();
  assert.deepEqual([...idx.keys()].sort(), ["Compendium.x.Item.S", "a"]);
  assert.equal(rules.onEventIndex(), idx);   // без смены каталога — тот же индекс
  rules.initCatalog([{ v: 1, bySlug: {} }], {});
  assert.equal(rules.onEventIndex().size, 0);
});

/* ---------- чистые части событий ---------- */

test("eventOfMessage: тип контекста pf2e -> событие; сотворение — карточка заклинания", () => {
  const m = (type, origin) => ({ flags: { pf2e: { context: { type }, ...(origin && { origin }) } } });
  assert.equal(ev.eventOfMessage(m("attack-roll")), "attack-roll");
  assert.equal(ev.eventOfMessage(m("spell-attack-roll")), "attack-roll");
  assert.equal(ev.eventOfMessage(m("perception-check")), "skill-check");
  assert.equal(ev.eventOfMessage(m("skill-check")), "skill-check");
  assert.equal(ev.eventOfMessage(m("saving-throw")), "saving-throw");
  assert.equal(ev.eventOfMessage(m("damage-roll")), "damage-roll");
  assert.equal(ev.eventOfMessage(m("damage-taken")), "damage-taken");
  assert.equal(ev.eventOfMessage(m("flat-check")), null);
  assert.equal(ev.eventOfMessage({ flags: { pf2e: { context: { type: "spell-cast" }, origin: { type: "spell", rollOptions: ["origin:action:slug:cast-a-spell"] } } } }), "spell-cast");
  assert.equal(ev.eventOfMessage({ flags: { pf2e: { origin: { type: "spell", rollOptions: [] } } } }), null);   // карточка без cast-a-spell — не сотворение
  assert.equal(ev.eventOfMessage({ flags: { pf2e: { origin: { type: "feat", rollOptions: [] } } } }), null);
  assert.equal(ev.eventOfMessage({ flags: {} }), null);
});

test("matchEntries: событие, сторона и условие when", () => {
  const rule = validate({ v: 1, onEvent: [
    { on: "attack-roll", apply: [{ removeEffect: { slug: "a" } }] },
    { on: "attack-roll", side: "target", apply: [{ removeEffect: { slug: "b" } }] },
    { on: "attack-roll", when: ["outcome:success"], apply: [{ removeEffect: { slug: "c" } }] },
    { on: "damage-roll", apply: [{ removeEffect: { slug: "d" } }] }] }).rule;
  const slugs = (m) => m.map(({ entry }) => entry.apply[0].removeEffect.slug);
  assert.deepEqual(slugs(ev.matchEntries(rule, "attack-roll", "self", new Set(["outcome:success"]))), ["a", "c"]);
  assert.deepEqual(slugs(ev.matchEntries(rule, "attack-roll", "self", new Set(["outcome:failure"]))), ["a"]);
  assert.deepEqual(ev.matchEntries(rule, "attack-roll", "target", new Set()).map((x) => x.i), [1]);
  assert.deepEqual(ev.matchEntries(rule, "turn-end", "self", new Set()), []);
});

test("splitSteps, damageOptions, effectOptions, isOwnEffect, hostRule, entryKey", () => {
  const e = validate({ v: 1, onEvent: [{ on: "attack-roll", apply: [{ to: "self", removeEffect: { slug: "a" } }, { to: "target", condition: { slug: "frightened" } }, { to: "party", effect: { uuid: EFF } }] }] }).rule.onEvent[0];
  const { mine, theirs } = ev.splitSteps(e);
  assert.deepEqual([mine.map((s) => s.to), theirs.map((s) => s.to)], [["self", "party"], ["target"]]);
  assert.deepEqual(ev.damageOptions({ updates: [{ path: "system.attributes.hp.value", value: 5 }], shield: { damage: 3 } }), ["damage-taken", "damage-taken:hp", "damage-taken:shield"]);
  assert.deepEqual(ev.damageOptions({ isHealing: true, updates: [{ path: "system.attributes.hp.value", value: 5 }] }), ["damage-taken", "damage-taken:healing"]);
  assert.deepEqual(ev.effectOptions({ slug: "spike-skin", system: { context: { origin: { actor: "A" } } } }), ["effect:spike-skin", "effect:slug:spike-skin", "item:slug:spike-skin", "effect:origin"]);
  assert.equal(ev.isOwnEffect({ flags: { [MOD]: { meta: { message: "ev:M1:Item.x:0" } } } }), true);
  assert.equal(ev.isOwnEffect({ flags: { [MOD]: { meta: { message: "M1" } } } }), false);
  const ch = { statistic: "will", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: {} };
  const h = ev.hostRule({ challenge: ch }, "Маска");
  assert.equal(validate(h).ok, true);
  assert.equal(h.onUse.targets, "selected");
  assert.equal(ev.entryKey("M1", "Item.x", 2), "M1:Item.x:2");
});

/* ---------- исполнение ---------- */

const mkEffect = (o = {}) => {
  const e = {
    type: "effect", id: o.id ?? "e1", uuid: `Actor.${o.actor ?? "hero"}.Item.${o.id ?? "e1"}`, slug: o.slug ?? "panache", name: o.slug ?? "panache", _stats: { compendiumSource: o.src ?? EFF }, flags: {},
    system: { duration: o.duration ?? { value: 1, unit: "minutes", expiry: null }, badge: null, context: { origin: { actor: o.origin ?? "Actor.hero" } } }, deleted: false,
    toObject() { return { name: this.name, type: "effect", system: structuredClone(this.system), _id: this.id, flags: structuredClone(this.flags) }; },
    async delete() { this.deleted = true; this.actor.items = this.actor.items.filter((x) => x !== this); this.actor.itemTypes.effect = this.actor.itemTypes.effect.filter((x) => x !== this); },
    async update(d) { for (const [k, v] of Object.entries(d)) setDeep(this, k, v); }
  };
  return e;
};
// feat-носитель: правило лежит во флаге предмета (itemFlagRule)
const mkFeat = (slug, rule, id = slug) => ({ type: "feat", id, uuid: `Actor.owner.Item.${id}`, name: slug, slug, system: {}, flags: { [MOD]: { rule } } });
const mkActor = (uuid, items = []) => {
  const a = { uuid, name: uuid, id: uuid.split(".").pop(), level: 5, attributes: {}, items, itemTypes: { condition: [], effect: items.filter((i) => i.type === "effect") }, rollOptions: {}, getActiveTokens: () => [], getRollOptions: () => [], getSelfRollOptions: (p) => [`${p}:test`] };
  a.restored = 0;
  a.createEmbeddedDocuments = async (_t, docs) => docs.map((d) => { a.restored++; const e = mkEffect({ id: `n${a.restored}`, slug: d.system?.slug ?? d.name, actor: a.id }); e.system = d.system; e.actor = a; e.parent = a; a.items.push(e); a.itemTypes.effect.push(e); uuids.set(e.uuid, e); return e; });
  for (const i of items) { i.actor = a; i.parent = a; uuids.set(i.uuid, i); }
  uuids.set(uuid, a);
  return a;
};
const mkMsg = (id, pf2e, extra = {}) => {
  const m = { id, flags: { pf2e }, rolls: [], async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); }, ...extra };
  msgs.set(id, m);
  return m;
};

test("onMessage: бросок владельца — шаги по when, откат журналом; повтор того же сообщения не исполняется", async () => {
  const panache = mkEffect({ id: "p", slug: "panache" });
  const rule = validate({ v: 1, onEvent: [{ on: "damage-roll", when: ["self:effect:panache"], apply: [{ removeEffect: { slug: "panache" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [panache, mkFeat("confident-finisher", rule)]);
  const m = mkMsg("M1", { context: { type: "damage-roll", options: ["self:effect:panache"] } }, { actor: hero });
  await ev.onMessage(m);
  assert.equal(panache.deleted, true);
  assert.equal(m.flags[MOD].events.length, 1);
  assert.equal(m.flags[MOD].events[0].key, `M1:${hero.items.find((i) => i.type === "feat").uuid}:0`);
  await ev.onMessage(m);   // тот же id: журнал есть — тишина
  assert.equal(m.flags[MOD].events.length, 1);
});

test("onMessage: условие не выполнено — ничего; режим effect != auto — ничего; не активный ГМ — ничего", async () => {
  const eff = mkEffect({ slug: "panache" });
  const rule = validate({ v: 1, onEvent: [{ on: "damage-roll", when: ["self:effect:panache"], apply: [{ removeEffect: { slug: "panache" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [eff, mkFeat("f", rule)]);
  await ev.onMessage(mkMsg("M2", { context: { type: "damage-roll", options: [] } }, { actor: hero }));
  assert.equal(eff.deleted, false);
  settings["mode.effect"] = "off";
  await ev.onMessage(mkMsg("M3", { context: { type: "damage-roll", options: ["self:effect:panache"] } }, { actor: hero }));
  assert.equal(eff.deleted, false);
  settings["mode.effect"] = "auto";
  globalThis.game.user.isActiveGM = false;
  await ev.onMessage(mkMsg("M4", { context: { type: "damage-roll", options: ["self:effect:panache"] } }, { actor: hero }));
  globalThis.game.user.isActiveGM = true;
  assert.equal(eff.deleted, false);
});

test("onMessage: сторона target — владелец правила цель броска; to:target — бросавший; сторона self — наоборот", async () => {
  const foeFx = mkEffect({ id: "f", slug: "mark", actor: "foe" });
  const rule = validate({ v: 1, onEvent: [{ on: "attack-roll", side: "target", apply: [{ to: "target", removeEffect: { slug: "mark" } }] }] }).rule;
  const attacker = mkActor("Actor.foe", [foeFx]);
  const guard = mkActor("Actor.guard", [mkFeat("ward", rule)]);
  const m = mkMsg("M5", { context: { type: "attack-roll", options: [], target: { actor: guard.uuid } } }, { actor: attacker });
  await ev.onMessage(m);
  assert.equal(foeFx.deleted, true);   // «другой участник» для side:target — атаковавший
  // сторона self: правило у атакующего, to:target — цель броска
  const hit = mkEffect({ id: "h", slug: "mark", actor: "guard" });
  const rule2 = validate({ v: 1, onEvent: [{ on: "attack-roll", side: "self", when: ["outcome:success"], apply: [{ to: "target", removeEffect: { slug: "mark" } }] }] }).rule;
  const a2 = mkActor("Actor.a2", [mkFeat("hunter", rule2)]);
  const g2 = mkActor("Actor.g2", [hit]);
  hit.uuid = "Actor.g2.Item.h";
  const m2 = mkMsg("M6", { context: { type: "attack-roll", options: [], outcome: "success", target: { actor: g2.uuid } } }, { actor: a2 });
  await ev.onMessage(m2);
  assert.equal(hit.deleted, true);
});

test("onMessage: once — ключ шага не зависит от сообщения: эффект продлевается один раз, второе сообщение не продлевает", async () => {
  const eff = mkEffect({ slug: "inspire-courage", duration: { value: 1, unit: "minutes", expiry: null } });
  const rule = validate({ v: 1, onEvent: [{ on: "damage-roll", once: true, apply: [{ extendEffect: { slug: "inspire-courage", rounds: 1 } }] }] }).rule;
  const hero = mkActor("Actor.hero", [eff, mkFeat("martial-performance", rule)]);
  await ev.onMessage(mkMsg("D1", { context: { type: "damage-roll", options: [] } }, { actor: hero }));
  assert.deepEqual(eff.system.duration, { value: 11, unit: "rounds", expiry: null });
  await ev.onMessage(mkMsg("D2", { context: { type: "damage-roll", options: [] } }, { actor: hero }));
  assert.equal(eff.system.duration.value, 11);
});

test("onMessage: без once каждое событие продлевает (ключ по сообщению)", async () => {
  const eff = mkEffect({ slug: "inspire-courage", duration: { value: 1, unit: "minutes", expiry: null } });
  const rule = validate({ v: 1, onEvent: [{ on: "damage-roll", apply: [{ extendEffect: { slug: "inspire-courage", rounds: 1 } }] }] }).rule;
  const hero = mkActor("Actor.hero", [eff, mkFeat("x", rule)]);
  await ev.onMessage(mkMsg("D1", { context: { type: "damage-roll", options: [] } }, { actor: hero }));
  await ev.onMessage(mkMsg("D2", { context: { type: "damage-roll", options: [] } }, { actor: hero }));
  assert.equal(eff.system.duration.value, 12);
});

test("переброс: удаление старого сообщения откладывает журнал, новое с isReroll откатывает прежнее и исполняет заново; простое удаление — ничего не откатывает", async () => {
  const eff = mkEffect({ id: "p", slug: "panache" });
  const rule = validate({ v: 1, onEvent: [{ on: "attack-roll", apply: [{ removeEffect: { slug: "panache" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [eff, mkFeat("f", rule)]);
  const m1 = mkMsg("R1", { context: { type: "attack-roll", options: [] } }, { actor: hero });
  await ev.onMessage(m1);
  assert.equal(eff.deleted, true);
  ev.onDeleteMessage(m1);   // pf2e: старое сообщение удалено...
  msgs.delete("R1");
  assert.equal(hero.items.some((i) => i.type === "effect"), false);
  await ev.onMessage(mkMsg("R2", { context: { type: "attack-roll", options: [], isReroll: true } }, { actor: hero }));   // ...новое с isReroll: прежнее откатилось (эффект вернулся) и шаг исполнен снова
  assert.equal(hero.restored, 1, "откат вернул снятый эффект");
  assert.equal(hero.items.some((i) => i.type === "effect"), false, "а новое исполнение снова его сняло");
  assert.equal(msgs.get("R2").flags[MOD].events.length, 1);
});

test("простое удаление сообщения без переброса ничего не откатывает", async () => {
  const eff = mkEffect({ id: "p2", slug: "panache" });
  const rule = validate({ v: 1, onEvent: [{ on: "attack-roll", apply: [{ removeEffect: { slug: "panache" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [eff, mkFeat("f2", rule)]);
  const m1 = mkMsg("X1", { context: { type: "attack-roll", options: [] } }, { actor: hero });
  await ev.onMessage(m1);
  ev.onDeleteMessage(m1);
  await ev.onMessage(mkMsg("X2", { context: { type: "attack-roll", options: [] } }, { actor: hero }));   // обычное новое сообщение
  assert.equal(hero.items.filter((i) => i.type === "effect").length, 0);   // удалённый эффект не вернулся
});

test("испытание записи: другой участник получает карточку со снимком use; шаги записи идут отдельно", async () => {
  const ch = { statistic: "will", dc: { value: 20 }, byDegree: { failure: [{ condition: { slug: "frightened", value: 1 } }] } };
  const rule = validate({ v: 1, label: "Маска", onEvent: [{ on: "attack-roll", side: "target", challenge: ch }] }).rule;
  const tok = (id, actor) => ({ id, uuid: `Scene.s.Token.${id}`, name: id, actor });
  const guard = mkActor("Actor.guard", [mkFeat("mask-of-terror", rule)]);
  const foe = mkActor("Actor.foe");
  const ft = tok("ft", foe);
  uuids.set(ft.uuid, ft);
  foe.getActiveTokens = () => [ft];
  await ev.onMessage(mkMsg("C1", { context: { type: "attack-roll", options: [], target: { actor: guard.uuid } } }, { actor: foe, token: ft }));
  assert.equal(created.length, 1);
  const use = created[0].flags[MOD].use;
  assert.equal(use.kind, "use");
  assert.equal(use.actor, guard.uuid);
  assert.deepEqual(use.targets.map((t) => t.key), ["ft"]);
  assert.equal(use.rule.onUse.challenge.statistic, "will");
  assert.equal(use.state.event.startsWith("C1:"), true);
  assert.equal(msgs.get("C1").flags[MOD].events[0].host, created[0].id);
  // повторно то же сообщение — второй карточки нет
  await ev.onMessage(msgs.get("C1"));
  assert.equal(created.length, 1);
});

test("уступка pf2e-automations: shouldYield по слагу носителя пропускает правило", async () => {
  const eff = mkEffect({ slug: "panache" });
  const rule = validate({ v: 1, onEvent: [{ on: "damage-roll", apply: [{ removeEffect: { slug: "panache" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [eff, mkFeat("covered-feat", rule)]);
  globalThis.game.modules = { get: (id) => (id === "pf2e-automations" ? { active: true } : null) };
  const prev = globalThis.game.settings.get;
  settings.yieldToAutomations = true;
  globalThis.game.settings.get = (m, k) => (m === "pf2e-automations" ? { g: { name: "Covered Feat", isActive: true, source: ["covered-feat"], baseRules: [], complexRules: [], handlerRules: [] } } : settings[k]);
  const compat = await import("../scripts/compat.mjs");
  compat.ready();
  await ev.onMessage(mkMsg("Y1", { context: { type: "damage-roll", options: [] } }, { actor: hero }));
  assert.equal(eff.deleted, false);
  globalThis.game.modules = { get: () => null };
  globalThis.game.settings.get = prev;
  compat.ready();
});

test("effect-created / turn-end: init подписывает хуки и пропускает эффекты, созданные самими шагами onEvent", async () => {
  const handlers = {};
  globalThis.Hooks = { on: (name, fn) => { (handlers[name] ??= []).push(fn); } };
  ev.init();
  assert.deepEqual(Object.keys(handlers).sort(), ["createChatMessage", "createItem", "deleteChatMessage", "deleteItem", "moveToken", "pf2e.endTurn", "pf2e.startTurn", "preCreateChatMessage", "updateChatMessage"]);
  const rule = validate({ v: 1, onEvent: [{ on: "turn-end", apply: [{ to: "self", removeEffect: { slug: "agitate" } }] }] }).rule;
  const agitate = mkEffect({ id: "a", slug: "agitate" });
  const hero = mkActor("Actor.hero", [agitate, mkFeat("agitate", rule)]);
  await handlers["pf2e.endTurn"][0]({ id: "c1", actor: hero }, { id: "E1", round: 2, turn: 0 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(agitate.deleted, true);
  // эффект, созданный нашим шагом, события effect-created не запускает
  const own = mkEffect({ id: "o", slug: "spike-skin" });
  own.flags[MOD] = { meta: { message: "ev:M:Item:0" } };
  const rule2 = validate({ v: 1, onEvent: [{ on: "effect-created", when: ["effect:spike-skin"], apply: [{ to: "self", removeEffect: { slug: "spike-skin" } }] }] }).rule;
  const h2 = mkActor("Actor.h2", [own, mkFeat("spike-skin", rule2, "ss")]);
  handlers.createItem[0](own);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(own.deleted, false);
  const plain = mkEffect({ id: "o2", slug: "spike-skin" });
  plain.actor = h2; plain.parent = h2; h2.items.push(plain); h2.itemTypes.effect.push(plain);
  handlers.createItem[0](plain);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(plain.deleted, true);
  delete globalThis.Hooks;
});

test("«при попадании Удара»: правило пассивной способности из каталога ловит только Удар с её attackEffects и цель нужного размера", async () => {
  const rule = validate({ v: 1, onEvent: [{ on: "attack-roll", when: ["item:attack-effect:tongue-grab", { or: ["outcome:success", "outcome:criticalSuccess"] }, { lte: ["target:size", 2] }], apply: [{ to: "target", removeEffect: { slug: "mark" } }] }] }).rule;
  rules.initCatalog([{ v: 1, bySlug: { "tongue-grab@action": rule } }], {});
  try {
    assert.deepEqual(ev.attackEffectOptions({ system: { attackEffects: { value: ["tongue-grab", "grab"] } } }), ["item:attack-effect:tongue-grab", "item:attack-effect:grab"]);
    assert.deepEqual(ev.attackEffectOptions(null), []);
    const ability = { type: "action", id: "ta", uuid: "Actor.toad.Item.ta", slug: "tongue-grab", name: "Tongue Grab", system: {}, flags: {} };
    const toad = mkActor("Actor.toad", [ability]);
    const mark = mkEffect({ id: "m", slug: "mark", actor: "mouse" });
    const mouse = mkActor("Actor.mouse", [mark]);
    mouse.getSelfRollOptions = (p) => [`${p}:size:2`];
    const strike = (value) => ({ system: { attackEffects: { value } } });
    const roll = (id, item, outcome = "success") => mkMsg(id, { context: { type: "attack-roll", options: [], outcome, target: { actor: mouse.uuid } } }, { actor: toad, item });
    await ev.onMessage(roll("T1", strike(["bite"])));                 // другой Удар — ничего
    assert.equal(mark.deleted, false);
    await ev.onMessage(roll("T2", strike(["tongue-grab"]), "failure"));   // промах — ничего
    assert.equal(mark.deleted, false);
    mouse.getSelfRollOptions = (p) => [`${p}:size:4`];                // слишком большая цель — ничего
    await ev.onMessage(roll("T3", strike(["tongue-grab"])));
    assert.equal(mark.deleted, false);
    mouse.getSelfRollOptions = (p) => [`${p}:size:2`];
    await ev.onMessage(roll("T4", strike(["tongue-grab"])));          // попал нужным Ударом — шаг на цель
    assert.equal(mark.deleted, true);
  } finally { rules.initCatalog([{ v: 1, bySlug: {} }], {}); }
});

test("damage-taken: урон запускает правило, лечение и откат урона — нет (как у PA: healing-taken отдельно)", async () => {
  const shield = mkEffect({ id: "s", slug: "selfish-shield" });
  const rule = validate({ v: 1, onEvent: [{ on: "damage-taken", when: ["self:effect:selfish-shield"], apply: [{ removeEffect: { slug: "selfish-shield" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [shield, mkFeat("selfish-shield", rule)]);
  const msg = (id, applied) => mkMsg(id, { context: { type: "damage-taken", options: ["self:effect:selfish-shield"] }, appliedDamage: applied }, { actor: hero });
  await ev.onMessage(msg("H1", { isHealing: true, updates: [] }));
  await ev.onMessage(msg("H2", { isReverted: true, updates: [] }));
  assert.equal(shield.deleted, false);
  await ev.onMessage(msg("H3", { updates: [{ path: "system.attributes.hp.value", value: 4 }] }));
  assert.equal(shield.deleted, true);
});

test("испытание от эффекта-носителя: СЛ и предмет — у автора эффекта (заклинателя), а не у носителя", async () => {
  const ch = { statistic: "will", dc: { source: "spell" }, byDegree: { failure: [{ condition: { slug: "frightened", value: 2 } }] } };
  const rule = validate({ v: 1, onEvent: [{ on: "attack-roll", side: "target", challenge: ch }] }).rule;
  const caster = mkActor("Actor.caster", []);
  const spell = { type: "spell", uuid: "Actor.caster.Item.mask", name: "Mask of Terror", slug: "mask-of-terror", system: {}, flags: {} };
  uuids.set(spell.uuid, spell);
  const fx = mkEffect({ id: "mk", slug: "mask-of-terror", actor: "guard", origin: caster.uuid });
  fx.system.context.origin.item = spell.uuid;
  fx.flags[MOD] = { rule };
  const guard = mkActor("Actor.guard", [fx]);
  const foe = mkActor("Actor.foe");
  const ft = { id: "ft", uuid: "Scene.s.Token.ft", name: "Foe", actor: foe };
  uuids.set(ft.uuid, ft);
  await ev.onMessage(mkMsg("E1", { context: { type: "attack-roll", options: [], target: { actor: guard.uuid } } }, { actor: foe, token: ft }));
  const use = created.at(-1).flags[MOD].use;
  assert.equal(use.actor, caster.uuid);
  assert.equal(use.item.uuid, spell.uuid);
  assert.deepEqual(use.targets.map((t) => t.key), ["ft"]);
});

test("Мастерская: сводка и рассказ для вида onEvent; смена вида не теряет события", async () => {
  const au = await import("../scripts/workshop/automation.mjs");
  const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
  const env = { t, dc: null, area: { shape: "burst", size: 20 }, author: null, conditionLabel: (s) => s.toUpperCase(), uuidName: () => null, statLabel: (s) => `st:${s}`, valued: () => false };
  const f = ruleToForm(validate(samples[1]).rule);
  const s = au.summaries(f, env);
  assert.match(s.when, /workshop\.au\.when\.onEvent/);
  assert.match(s.events, /workshop\.au\.ev\.on\.attack-roll · workshop\.au\.ev\.side\.target: workshop\.au\.ev\.chLine/);
  assert.equal(s.targets, "");   // строки onUse у события пусты
  const story = au.story(f, env);
  assert.equal(story.text, "workshop.au.story.onEvent");
  assert.equal(story.degrees[0].label, "workshop.au.ev.on.attack-roll · workshop.au.ev.side.target");
  assert.equal(au.summaries(ruleToForm(validate(samples[2]).rule), env).events.split(" · workshop.au.ev.on.").length, 2);
  // событий нет — строка «событий нет»; правка вида на onUse не стирает записи (они остаются в модели и в правиле)
  assert.equal(au.summaries(ruleToForm(validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF } }] } }).rule), env).events, "workshop.au.ev.none");
  f.kind = "onUse";
  assert.equal(validate(formToRule(f)).rule.onEvent.length, 1);
});

test("переброс: A удалено с журналом, B без журнала удалено — переброс C ничего не откатывает", async () => {
  const eff = mkEffect({ id: "p", slug: "panache" });
  const rule = validate({ v: 1, onEvent: [{ on: "attack-roll", when: ["self:effect:go"], apply: [{ removeEffect: { slug: "panache" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [eff, mkFeat("f", rule)]);
  const A = mkMsg("A", { context: { type: "attack-roll", options: ["self:effect:go"] } }, { actor: hero });
  await ev.onMessage(A);
  assert.equal(eff.deleted, true);
  ev.onDeleteMessage(A);
  ev.onDeleteMessage(mkMsg("B", { context: { type: "attack-roll", options: [] } }, { actor: hero }));   // B исполнения не имело
  await ev.onMessage(mkMsg("C", { context: { type: "attack-roll", options: [], isReroll: true } }, { actor: hero }));
  assert.equal(hero.restored, 0);
});

test("мировой каталог перекрывает встроенный целиком, в том числе по byName", async () => {
  const e = (slug) => ({ on: "damage-roll", apply: [{ removeEffect: { slug } }] });
  const fxA = mkEffect({ id: "a", slug: "a" }), fxB = mkEffect({ id: "b", slug: "b" });
  const item = { type: "action", id: "n", uuid: "Actor.hero.Item.n", name: "Wild Thing", system: {}, flags: {} };   // без slug и источника — только byName
  const hero = mkActor("Actor.hero", [fxA, fxB, item]);
  rules.initCatalog([{ v: 1, byName: { "Wild Thing": { v: 1, onEvent: [e("a")] } } }], {});
  assert.equal(ev.eventRuleOf(item).onEvent[0].apply[0].removeEffect.slug, "a");
  void hero; void fxB;
  rules.initCatalog([{ v: 1, byName: { "Wild Thing": { v: 1, onEvent: [e("a")] } } }], {});   // мировое правило подставляет настройка catalog
  const orig = globalThis.game.settings.get;
  globalThis.game.settings.get = (m, k) => (k === "catalog" ? { bySource: {}, bySlug: { "wild-thing": { v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF } }] } } }, byName: {} } : orig(m, k));
  item.slug = "wild-thing";
  item._stats = { modifiedTime: 5 };   // новая версия предмета — кэш не мешает
  try { assert.equal(ev.eventRuleOf(item), null); } finally { globalThis.game.settings.get = orig; rules.initCatalog([{ v: 1, bySlug: {} }], {}); }
});

test("damage-taken без appliedDamage не запускает; откат урона откатывает журнал события", async () => {
  const sh = mkEffect({ id: "s", slug: "selfish-shield" });
  const rule = validate({ v: 1, onEvent: [{ on: "damage-taken", apply: [{ removeEffect: { slug: "selfish-shield" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [sh, mkFeat("sf", rule)]);
  await ev.onMessage(mkMsg("N1", { context: { type: "damage-taken", options: [] }, appliedDamage: null }, { actor: hero }));
  assert.equal(sh.deleted, false);
  const m = mkMsg("N2", { context: { type: "damage-taken", options: [] }, appliedDamage: { updates: [{ path: "system.attributes.hp.value", value: 3 }] } }, { actor: hero });
  await ev.onMessage(m);
  assert.equal(sh.deleted, true);
  setDeep(m, "flags.pf2e.appliedDamage.isReverted", true);   // pf2e: «откатить урон»
  await ev.onUpdateMessage(m, { flags: { pf2e: { appliedDamage: { isReverted: true } } } });
  assert.equal(hero.restored, 1);
  assert.deepEqual(m.flags[MOD].events, []);
});

test("spell-cast: цели из целей автора, to:target и side:target работают; нет цели — ветка not:target", async () => {
  const cast = (pf) => ({ type: "spell", rollOptions: ["origin:action:slug:cast-a-spell", ...pf] });
  const rule = validate({ v: 1, onEvent: [
    { on: "spell-cast", when: ["origin:item:heroism", "target"], apply: [{ to: "target", removeEffect: { slug: "mark" } }] },
    { on: "spell-cast", when: ["origin:item:heroism", { not: "target" }], apply: [{ to: "self", removeEffect: { slug: "own" } }] },
    { on: "spell-cast", side: "target", apply: [{ to: "self", removeEffect: { slug: "warded" } }] }] }).rule;
  const own = mkEffect({ id: "o", slug: "own" });
  const mentor = mkActor("Actor.mentor", [own, mkFeat("mentor", rule)]);
  const mark = mkEffect({ id: "m", slug: "mark", actor: "ally" }), warded = mkEffect({ id: "w", slug: "warded", actor: "ally" });
  const ally = mkActor("Actor.ally", [mark, warded]);
  const tok = { id: "t1", uuid: "Scene.s.Token.t1", name: "Ally", actor: ally };
  uuids.set(tok.uuid, tok);
  const flags = { origin: cast(["origin:item:heroism"]), context: { type: "spell-cast", options: [] } };
  await ev.onMessage(mkMsg("S1", flags, { actor: mentor, author: { targets: new Set([{ document: tok }]) } }));
  assert.equal(mark.deleted, true);       // цель сотворения получила шаг
  assert.equal(own.deleted, false);       // ветка «нет цели» не сработала
  await ev.onMessage(mkMsg("S2", flags, { actor: mentor, author: { targets: new Set() } }));
  assert.equal(own.deleted, true);        // нет цели — шаг на себя
});

test("одна запись падает — остальные и журнал уже применённого сохраняются", async () => {
  const fx = mkEffect({ id: "p", slug: "panache" });
  const rule = validate({ v: 1, onEvent: [{ on: "damage-roll", apply: [{ removeEffect: { slug: "panache" } }] }, { on: "damage-roll", apply: [{ rollOption: { domain: "all", option: "x" } }] }] }).rule;
  const hero = mkActor("Actor.hero", [fx, mkFeat("f", rule)]);
  hero.toggleRollOption = async () => { throw new Error("boom"); };
  const m = mkMsg("Z1", { context: { type: "damage-roll", options: [] } }, { actor: hero });
  const err = console.error; console.error = () => {};
  try { await ev.onMessage(m); } finally { console.error = err; }
  assert.equal(fx.deleted, true);
  assert.equal(m.flags[MOD].events.length, 1);
});

test("испытание события не зависит от режима effect; имена в карточке экранируются", async () => {
  settings["mode.effect"] = "off";
  const ch = { statistic: "will", dc: { value: 20 }, byDegree: { failure: [{ condition: { slug: "frightened", value: 1 } }] } };
  const rule = validate({ v: 1, onEvent: [{ on: "attack-roll", side: "target", challenge: ch }] }).rule;
  const guard = mkActor("Actor.guard", [mkFeat("<b>mask</b>", rule)]);
  const foe = mkActor("Actor.foe");
  const ft = { id: "ft", uuid: "Scene.s.Token.ft", name: "<i>Foe</i>", actor: foe };
  uuids.set(ft.uuid, ft); foe.getActiveTokens = () => [ft];
  await ev.onMessage(mkMsg("E1", { context: { type: "attack-roll", options: [], target: { actor: guard.uuid } } }, { actor: foe, token: ft }));
  assert.equal(created.length, 1);
  assert.equal(created[0].content.includes("<i>Foe</i>"), false);
});

test("damage-taken: «другой» для владельца — источник урона (origin), а не цель", async () => {
  const rule = validate({ v: 1, onEvent: [{ on: "damage-taken", apply: [{ to: "target", removeEffect: { slug: "mark" } }] }] }).rule;
  const mark = mkEffect({ id: "m", slug: "mark", actor: "foe" });
  const foe = mkActor("Actor.foe", [mark]);
  const hero = mkActor("Actor.hero", [mkFeat("f", rule)]);
  const ft = { id: "ft", uuid: "Scene.s.Token.ft", name: "Foe", actor: foe };
  uuids.set(ft.uuid, ft); foe.getActiveTokens = () => [ft];
  await ev.onMessage(mkMsg("D1", { context: { type: "damage-taken", options: [], origin: { actor: foe.uuid } }, appliedDamage: { updates: [{ path: "system.attributes.hp.value", value: 3 }] } }, { actor: hero }));
  assert.equal(mark.deleted, true);
});

test("Мастерская: traits, options и иммунитет испытания события переживают форму", () => {
  const raw = { v: 1, onEvent: [{ on: "attack-roll", side: "target", challenge: { statistic: "fortitude", dc: { against: "class" }, traits: ["incapacitation"], options: ["origin:item:stunning-blows"], immunity: { slug: "bane", duration: { value: 1, unit: "minutes" }, degrees: ["success"] }, byDegree: { failure: [{ to: "target", condition: { slug: "stunned", value: 1, policy: "max" } }] } } }] };
  const r = validate(raw);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const form = ruleToForm(r.rule), c = form.ev[0].ch;
  assert.match(String(c.traits), /incapacitation/);
  assert.match(String(c.options), /stunning-blows/);
  assert.equal(c.imm.on, true);
  assert.deepEqual(formToRule(form).onEvent[0].challenge.immunity, r.rule.onEvent[0].challenge.immunity);
  assert.equal(roundTrip(r.rule), true);
});

test("damage-taken: токен «другого» у владельца — токен источника урона", async () => {
  let seen;
  const rule = validate({ v: 1, onEvent: [{ on: "damage-taken", challenge: { statistic: "will", dc: { value: 20 }, byDegree: { failure: [{ condition: { slug: "frightened", value: 1 } }] } } }] }).rule;
  const foe = mkActor("Actor.foe"), hero = mkActor("Actor.hero", [mkFeat("f", rule)]);
  const ft = { id: "ft", uuid: "Scene.s.Token.ft", name: "Foe", actor: foe }, other = { id: "xx", uuid: "Scene.s.Token.xx", name: "X", actor: hero };
  uuids.set(ft.uuid, ft); foe.getActiveTokens = () => [ft];
  await ev.onMessage(mkMsg("T1", { context: { type: "damage-taken", options: [], origin: { actor: foe.uuid } }, appliedDamage: { updates: [{ path: "system.attributes.hp.value", value: 3 }] } }, { actor: hero, token: other }));
  seen = created[0]?.flags[MOD].use.targets.map((t) => t.key);
  assert.deepEqual(seen, ["ft"]);
});

test("spell-cast: самоприменяемое заклинание без цели не берёт устаревшие цели автора", async () => {
  const rule = validate({ v: 1, onEvent: [{ on: "spell-cast", when: ["origin:item:heroism", { not: "target" }], apply: [{ to: "self", removeEffect: { slug: "own" } }] }] }).rule;
  const own = mkEffect({ id: "o", slug: "own" });
  const mentor = mkActor("Actor.mentor", [own, mkFeat("mentor", rule)]);
  const ally = mkActor("Actor.ally"), tok = { id: "t1", uuid: "Scene.s.Token.t1", name: "A", actor: ally };
  uuids.set(tok.uuid, tok);
  const flags = { origin: { type: "spell", rollOptions: ["origin:action:slug:cast-a-spell", "origin:item:heroism"] }, context: { type: "spell-cast", options: [] } };
  const item = { system: { target: { value: "" }, range: { value: "" } } };
  const before = [];
  await ev.onMessage(mkMsg("SS1", flags, { actor: mentor, item, author: { targets: new Set([{ document: tok }]) } }));
  assert.equal(own.deleted, true);
  assert.equal(msgs.get("SS1").flags[MOD].events[0].recs[0].tk, "self");
  assert.equal(created.length, 0);
});

test("side:origin на ходе цели: опции origin-effect:<slug> только по эффектам этого автора; откат кнопкой «Отменить» не даёт effect-deleted", async () => {
  const handlers = {};
  globalThis.Hooks = { on: (name, fn) => { (handlers[name] ??= []).push(fn); } };
  ev.init();
  const rule = validate({ v: 1, onEvent: [{ on: "turn-end", side: "origin", when: ["origin-effect:mark"], apply: [{ to: "target", removeEffect: { slug: "tag" } }] }] }).rule;
  const ally = mkActor("Actor.ally", [mkFeat("spellcaster", rule)]);
  const fx = (id, slug, origin) => mkEffect({ id, slug, actor: "victim", origin });
  // метку поставил другой автор, у союзника только его Героизм — правило союзника молчит
  const tag1 = fx("t1", "tag", "Actor.ally");
  const victim = mkActor("Actor.victim", [fx("m1", "mark", "Actor.wizard"), fx("h1", "heroism", "Actor.ally"), tag1]);
  const endTurn = (round) => handlers["pf2e.endTurn"][0]({ id: "c1", actor: victim }, { id: "E1", round, turn: 0 }).then(() => new Promise((r) => setTimeout(r, 5)));
  await endTurn(1);
  assert.equal(tag1.deleted, false);
  assert.deepEqual(await ev.originEffectOptions(victim, ally), ["origin-effect:heroism", "origin-effect:tag"]);
  // метка союзника — срабатывает
  victim.items.push(fx("m2", "mark", "Actor.ally")); victim.items.at(-1).actor = victim; victim.items.at(-1).parent = victim; victim.itemTypes.effect.push(victim.items.at(-1));
  await endTurn(2);
  assert.equal(tag1.deleted, true);

  // effect-deleted: обычное снятие запускает событие, откат (опция undo) — нет
  const rule2 = validate({ v: 1, onEvent: [{ on: "effect-deleted", side: "origin", when: ["effect:origin", "effect:slug:bites"], apply: [{ to: "target", removeEffect: { slug: "imm" } }] }] }).rule;
  mkActor("Actor.wizard", [mkFeat("bites-rule", rule2)]);
  const imm1 = fx("i1", "imm", "Actor.wizard"), imm2 = fx("i2", "imm", "Actor.wizard");
  const v2 = mkActor("Actor.victim2", [imm1, imm2]);
  const bites = (id) => { const b = mkEffect({ id, slug: "bites", actor: "victim2", origin: "Actor.wizard" }); b.actor = b.parent = v2; return b; };
  handlers.deleteItem[0](bites("b1"), { [MOD]: { undo: true } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(imm1.deleted, false);
  handlers.deleteItem[0](bites("b2"), {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(imm1.deleted, true);
});

test("Окаменение / Плоть в камень: на успехе метка снимается до снижения Замедления; есть метка и нет Замедления — метка снимается", async () => {
  const { readFileSync } = await import("node:fs");
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.pa.json", import.meta.url), "utf8"));
  const MARK = "Compendium.pf2e-automato.effects.Item.PtrfyFailEffect1";
  for (const rule of [cat.bySlug.petrify, cat.bySlug["flesh-to-stone"]]) {
    const [turn, orphan] = rule.onEvent;
    for (const d of ["criticalSuccess", "success"]) {
      const steps = turn.challenge.byDegree[d];
      const rm = steps.findIndex((s) => s.removeEffect?.uuid === MARK), red = steps.findIndex((s) => s.condition?.policy === "reduce");
      assert.ok(rm >= 0 && rm < red, `${d}: removeEffect (when по Замедлению) должен идти до reduce`);
    }
    assert.deepEqual(turn.when, ["origin-effect:petrify-failure", "self:condition:slowed"]);
    assert.equal(ev.matchEntries(rule, "turn-end", "origin", new Set(["origin-effect:petrify-failure"])).length, 1);   // только запись «метка без Замедления»
    assert.equal(ev.matchEntries(rule, "turn-end", "origin", new Set(["origin-effect:petrify-failure"]))[0].entry, orphan);
    assert.equal(ev.matchEntries(rule, "turn-end", "origin", new Set(["origin-effect:petrify-failure", "self:condition:slowed"])).length, 1);
    assert.equal(orphan.apply[0].removeEffect.uuid, MARK);
  }
});

/* ---------- afterUse (strike-gate) ---------- */

const { gateToEvent, strikeWhen } = await import("../tools/strike-gate.mjs");
const { checkAnswer, notesOnly } = await import("../tools/validate.mjs");

// реальные тексты компендия (tools/out/items.json)
const DAZING = "Requirements You have a creature @UUID[Compendium.pf2e.conditionitems.Item.kWc1fhmv9LBiTuei]{Grabbed}.\n---\nYou pummel a held foe, hoping to stagger them. Make a melee Strike against a creature you have grabbed. The weapon damage from this Strike is bludgeoning damage. If the Strike hits, the creature must attempt a @Check[fortitude|against:fighter|traits:incapacitation] save against your class DC; this is an incapacitation effect.\n---\nCritical Success The creature is unaffected.\nSuccess The creature is Stunned 1.\nFailure The creature is Stunned 2.\nCritical Failure The creature is Stunned 3.";
const HEADSHOT = "Requirements You're wielding a loaded firearm or crossbow.\n---\nYou attempt to finish your target with a final, well-placed shot. Make a crossbow or firearm Strike. If you've damaged the target within the last minute with the same weapon and you get a critical success on your attack roll, the target must succeed at a @Check[fortitude|against:gunslinger|traits:death,incapacitation] save against your class DC or die; this is a death and incapacitation effect. A creature that survives is temporarily immune for 1 day.";
const stun = (n) => [{ to: "target", condition: { slug: "stunned", value: n } }];
const dazingUse = () => validate({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { against: "fighter" }, basic: false, rollerRole: "target", byDegree: { success: stun(1), failure: stun(2), criticalFailure: stun(3) } }, apply: [{ to: "self", note: "заметка" }] } }).rule;

test("gateToEvent: Dazing Blow -> onEvent afterUse на попадание, степени stunned 1/2/3 в записи, заметка-шум снята", () => {
  const r = gateToEvent(dazingUse(), DAZING, "feat");
  assert.equal(r.changed, true);
  assert.equal(r.rule.onUse, null);
  const e = r.rule.onEvent[0];
  assert.deepEqual([e.on, e.side, e.afterUse], ["attack-roll", "self", true]);
  assert.deepEqual(e.when, ["self:action:slug:strike", { or: ["outcome:success", "outcome:criticalSuccess"] }]);
  assert.equal(e.challenge.byDegree.success[0].condition.value, 1);
  assert.equal(e.challenge.byDegree.failure[0].condition.value, 2);
  assert.equal(e.challenge.byDegree.criticalFailure[0].condition.value, 3);
  assert.equal(roundTrip(r.rule), true);
});

test("gateToEvent: Headshot — только критическое попадание; оружие/бомба и текст не про Удар — без изменений", () => {
  assert.deepEqual(strikeWhen(HEADSHOT), ["self:action:slug:strike", "outcome:criticalSuccess"]);
  const d = dazingUse();
  assert.equal(gateToEvent(d, DAZING, "weapon").changed, false);
  assert.equal(gateToEvent(d, "The target must attempt a @Check[fortitude|dc:20] save.", "feat").changed, false);
  assert.equal(gateToEvent({ ...d, onUse: { ...d.onUse, challenge: null } }, DAZING, "feat").changed, false);
});

test("checkAnswer: onUse.challenge на strike-gate (feat) переводится и принимается; боеприпас — долг; onEvent attack-roll без afterUse — отказ", () => {
  const refs = { conditions: { stunned: true }, effects: {} };
  assert.equal(checkAnswer({ uuid: "u", rule: dazingUse() }, refs, DAZING, "feat").kind, "accepted");
  assert.equal(checkAnswer({ uuid: "u", rule: dazingUse() }, refs, DAZING, "consumable").key, "strike-gate");   // боеприпас: unsure с ключом, не принят
  const bare = { v: 1, onEvent: [{ on: "attack-roll", side: "self", challenge: dazingUse().onUse.challenge }] };
  const c = checkAnswer({ uuid: "u", rule: bare }, refs, DAZING, "feat");
  assert.equal(c.kind, "error");
  assert.match(c.errors[0], /afterUse/);
  assert.equal(checkAnswer({ uuid: "u", rule: { ...bare, onEvent: [{ ...bare.onEvent[0], afterUse: true }] } }, refs, DAZING, "feat").kind, "accepted");
});

test("checkAnswer: Vicious Evisceration (Удар, при попадании состояние без save) — attack-roll без afterUse отказ, с afterUse принят; пассив не трогаем", () => {
  const VE = "You make a vicious strike that maims your enemy. Make a melee Strike. If the Strike hits and deals damage, the target is @UUID[Compendium.pf2e.conditionitems.Item.4D2KBtexWXa6oUMR]{Drained 1}, or @UUID[Compendium.pf2e.conditionitems.Item.4D2KBtexWXa6oUMR]{Drained 2} on a critical success.";
  const refs = { conditions: { drained: true }, effects: {} };
  const ev = (o) => ({ on: "attack-roll", side: "self", when: ["self:action:slug:strike", "outcome:success"], apply: [{ to: "target", condition: { slug: "drained", value: 1 } }], ...o });
  const kind = { type: "feat", actionType: "action" };
  const bad = checkAnswer({ uuid: "u", rule: { v: 1, onEvent: [ev({})] } }, refs, VE, kind);
  assert.equal(bad.kind, "error");
  assert.match(bad.errors[0], /afterUse/);
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, onEvent: [ev({ afterUse: true })] } }, refs, VE, kind).kind, "accepted");
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, onEvent: [ev({})] } }, refs, VE, { type: "feat", actionType: "passive" }).kind, "accepted");
});

test("afterUse: валидатор — только свои броски владельца; форма туда-обратно", () => {
  const ch = dazingUse().onUse.challenge;
  assert.equal(one({ on: "attack-roll", afterUse: true, challenge: ch }).ok, true);
  assert.equal(one({ on: "turn-start", afterUse: true, challenge: ch }).ok, false);
  assert.equal(one({ on: "attack-roll", side: "target", afterUse: true, challenge: ch }).ok, false);
  assert.equal(one({ on: "spell-cast", afterUse: true, challenge: ch }).ok, true);   // Lingering Composition: связь «следующее сотворение»
  assert.equal(one({ on: "attack-roll", afterUse: "yes", challenge: ch }).ok, false);
  assert.equal("afterUse" in one({ on: "attack-roll", afterUse: false, challenge: ch }).rule.onEvent[0], false);
  assert.equal(blankEvent().afterUse, false);
});

const card = (id, actor, item, ts) => mkMsg(id, { origin: { actor: actor.uuid, uuid: item.uuid, type: item.type, rollOptions: [] } }, { actor, timestamp: ts });
const strike = (id, actor, target, ts, outcome = "success") => mkMsg(id, { origin: { actor: actor.uuid, type: "weapon", rollOptions: [] }, context: { type: "attack-roll", outcome, options: ["self:action:slug:strike"], target: { actor: target.actor.uuid, token: target.uuid } } }, { actor, timestamp: ts });
const NOW = 1_700_000_000_000;

function scene() {
  game.combats = [];
  const gate = gateToEvent(dazingUse(), DAZING, "feat").rule;
  const feat = mkFeat("dazing-blow", gate), other = mkFeat("power-attack", validate({ v: 1, onEvent: [{ on: "turn-start", apply: [{ note: "x" }] }] }).rule);
  const hero = mkActor("Actor.hero", [feat, other]);
  const foe = mkActor("Actor.foe"), ft = { id: "ft", uuid: "Scene.s.Token.ft", name: "ft", actor: foe };
  uuids.set(ft.uuid, ft);
  foe.getActiveTokens = () => [ft];
  return { hero, foe, ft, feat, other };
}

test("afterUse: карточка -> Удар попал — одно испытание цели Удара; повтор сообщения и второй Удар — нет", async () => {
  const { hero, ft, feat } = scene();
  const cards = () => created.filter((m) => m.flags?.[MOD]?.use);
  card("K1", hero, feat, NOW);
  const s1 = strike("S1", hero, ft, NOW + 1000);
  await ev.onMessage(s1);
  assert.equal(cards().length, 1);   // карточка испытания; заметка-предпосылка шёпотом — отдельно, не карточка
  assert.deepEqual(cards()[0].flags[MOD].use.targets.map((t) => t.key), ["ft"]);
  await ev.onMessage(s1);
  assert.equal(cards().length, 1);   // карточка испытания; заметка-предпосылка шёпотом — отдельно, не карточка
  await ev.onMessage(strike("S2", hero, ft, NOW + 2000));   // следующий Удар уже не по этому использованию
  assert.equal(cards().length, 1);   // карточка испытания; заметка-предпосылка шёпотом — отдельно, не карточка
});

test("afterUse: промах — ничего, и следующий Удар карточку не «наследует»; Удар без карточки и после чужой карточки — ничего", async () => {
  const { hero, ft, feat, other } = scene();
  card("K1", hero, feat, NOW);
  await ev.onMessage(strike("S1", hero, ft, NOW + 1000, "failure"));
  await ev.onMessage(strike("S2", hero, ft, NOW + 2000));
  assert.equal(created.length, 0);
  card("K2", hero, feat, NOW + 4000);
  card("K3", hero, other, NOW + 5000);
  await ev.onMessage(strike("S4", hero, ft, NOW + 6000));
  assert.equal(created.length, 0);
});

test("afterUse: Headshot — крит нужен; обычное попадание после карточки не срабатывает", async () => {
  const { hero, ft } = scene();
  const hs = mkFeat("headshot", gateToEvent(validate({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { against: "gunslinger" }, basic: false, rollerRole: "target", byDegree: { failure: [{ to: "target", note: "умирает" }] } } } }).rule, HEADSHOT, "feat").rule, "hs");
  hero.items.push(hs); hs.actor = hs.parent = hero; uuids.set(hs.uuid, hs);
  card("K1", hero, hs, NOW);
  await ev.onMessage(strike("S1", hero, ft, NOW + 1000, "success"));
  assert.equal(created.length, 0);
  card("K2", hero, hs, NOW + 2000);
  await ev.onMessage(strike("S2", hero, ft, NOW + 3000, "criticalSuccess"));
  assert.equal(created.length, 1);
});

test("strikeCardFor: актёр по origin (две копии одного NPC с общим speaker.actor), давность, начало хода в бою", () => {
  const A = { uuid: "Scene.s.Token.a.Actor.npc" }, B = { uuid: "Scene.s.Token.b.Actor.npc" };
  const slugOf = () => "stunning-strike";
  const m = (id, a, extra = {}) => ({ id, flags: { pf2e: { origin: { actor: a.uuid, type: "action", uuid: `${a.uuid}.Item.x` }, ...extra } }, actor: { uuid: "wrong" }, timestamp: NOW });
  const cardA = m("kA", A);
  const atk = (id, a, ts = NOW + 1000) => ({ ...m(id, a, { context: { type: "attack-roll" } }), timestamp: ts });
  assert.equal(ev.strikeCardFor([cardA], atk("sB", B), { slug: "stunning-strike" }, { slugOf }), null);   // копия B бьёт после карточки копии A
  assert.equal(ev.strikeCardFor([cardA], atk("sA", A), { slug: "stunning-strike" }, { slugOf }), cardA);
  assert.equal(ev.strikeCardFor([cardA], atk("sA", A), { slug: "other-slug" }, { slugOf }), null);
  assert.equal(ev.strikeCardFor([cardA], atk("sA", A, NOW + ev.AFTER_USE_MS + 1), { slug: "stunning-strike" }, { slugOf }), null);   // вне боя: 10 минут
  const pre = m("pre", B);   // последнее сообщение ленты на начало хода (позиция, не часы)
  assert.equal(ev.strikeCardFor([pre, cardA], atk("sA", A), { slug: "stunning-strike" }, { slugOf, stopId: "pre" }), cardA);   // карточка после начала хода
  assert.equal(ev.strikeCardFor([cardA, pre], atk("sA", A), { slug: "stunning-strike" }, { slugOf, stopId: "pre" }), null);   // карточка с прошлого хода
  assert.equal(ev.strikeCardFor([cardA], atk("sA", A, NOW + ev.AFTER_USE_MS + 1), { slug: "stunning-strike" }, { slugOf, stopId: "gone" }), null);   // 10 минут — и в бою
  assert.equal(ev.strikeCardFor([cardA, atk("s0", A)], atk("sA", A, NOW + 2000), { slug: "stunning-strike" }, { slugOf }), null);   // между ними был другой Удар
});

test("withMarkupHead/markupChallenges: dc markup в записи onEvent подхватывается наравне с onUse", () => {
  const e = validate({ v: 1, onEvent: [{ on: "attack-roll", afterUse: true, challenge: { statistic: "will", dc: { expr: "markup" }, basic: false, rollerRole: "target", byDegree: { failure: stun(1) } } }] }).rule;
  assert.equal(rules.markupChallenges(e).length, 1);
  const d = validate({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { against: "fighter" }, basic: false, rollerRole: "target", byDegree: {} }, apply: [] } }).rule;
  const out = rules.withMarkupHead(e, d, "");
  assert.equal(out.onEvent[0].challenge.statistic, "fortitude");
  assert.deepEqual(out.onEvent[0].challenge.dc, { against: "fighter" });
  assert.equal(out.onEvent[0].afterUse, true);
});

const FIVE = "You cycle through the elements in a devastating combination attack. Strike the target using the unarmed attack associated with your current elemental stance, then Cycle Elemental Stance. Then, Strike the target with the unarmed attack associated with your new elemental stance. If you successfully hit the target with all five elemental Strikes using this ability, it must attempt a @Check[fortitude|against:class|traits:death] save against your class DC or die.";
const DEATHBLOW = "Attempt a Strike with a blowgun or sling. If the Strike is successful and you are Hidden from the target, the target must succeed at a @Check[fortitude|against:class|traits:death,incapacitation] save against your class DC or die. A creature that survives is temporarily immune for 1 day.";

test("gateToEvent: заметки-предпосылки onUse.apply переезжают в apply записи, а не пропадают (Deathblow: «спрятаны»)", () => {
  const raw = { v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { against: "class" }, basic: false, rollerRole: "target", byDegree: { failure: [{ to: "target", note: "умирает" }] } }, apply: [{ to: "self", note: "Вы должны быть спрятаны от цели" }] } };
  const r = gateToEvent(validate(raw).rule, DEATHBLOW, { type: "feat", actionType: "action" });
  assert.equal(r.changed, true);
  assert.equal(r.rule.onUse, null);
  assert.deepEqual(r.rule.onEvent[0].apply, [{ to: "self", note: "Вы должны быть спрятаны от цели" }]);
  assert.equal(roundTrip(r.rule), true);
  // настоящий шаг в onUse остаётся там, где был
  const raw2 = structuredClone(raw); raw2.onUse.apply.push({ to: "self", condition: { slug: "hidden" } });
  const r2 = gateToEvent(validate(raw2).rule, DEATHBLOW, "feat");
  assert.equal(r2.rule.onUse.apply.length, 1);
  assert.equal(r2.rule.onEvent[0].apply.length, 1);
});

test("gateToEvent: шаги к цели из onUse.apply (2d8 кровотечения) переезжают в apply записи — на промахе не ложатся", () => {
  const raw = { v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { against: "class" }, basic: false, rollerRole: "target", byDegree: { failure: [{ to: "target", note: "слеп" }] } }, apply: [{ to: "target", persistent: { formula: "2d8", damageType: "bleed" } }, { to: "self", condition: { slug: "hidden" } }] } };
  const r = gateToEvent(validate(raw).rule, DEATHBLOW, "feat");
  assert.equal(r.changed, true);
  assert.deepEqual(r.rule.onUse.apply.map((s) => s.to), ["self"]);
  assert.deepEqual(r.rule.onEvent[0].apply.map((s) => s.persistent?.formula), ["2d8"]);
  assert.equal(roundTrip(r.rule), true);
});

test("активация: per.unit вне единиц рантайма (years, day) — ошибка ответа; days — принимается", () => {
  const ans = (unit) => ({ uuid: "u", unsure: false, rule: { v: 1, activate: [{ id: "x", label: "X", per: { value: 20, unit }, onUse: { targets: "self", apply: [{ to: "self", note: "n" }] } }] } });
  for (const unit of ["years", "day", "turns"]) assert.equal(checkAnswer(ans(unit), { conditions: {} }).kind, "error", unit);
  assert.notEqual(checkAnswer(ans("days"), { conditions: {} }).kind, "error");
});

test("gateToEvent: пассив, оружие — не переводятся; несколько Ударов (Five Breaths) — долг multi-strike", () => {
  const d = dazingUse();
  assert.equal(gateToEvent(d, DAZING, { type: "feat", actionType: "passive" }).changed, false);
  assert.equal(gateToEvent(d, DAZING, { type: "weapon" }).changed, false);
  assert.equal(gateToEvent(d, FIVE, { type: "feat", actionType: "action" }).changed, false);
  assert.equal(gateToEvent(d, DAZING, { type: "feat", actionType: "action" }).changed, true);
});

test("checkAnswer: пассив с onEvent на attack-roll не отвергается за отсутствие afterUse; у способности с карточкой — отвергается", () => {
  const refs = { conditions: { stunned: true }, effects: {} };
  const bare = { v: 1, onEvent: [{ on: "attack-roll", side: "self", challenge: dazingUse().onUse.challenge }] };
  assert.equal(checkAnswer({ uuid: "u", rule: bare }, refs, DAZING, { type: "feat", actionType: "passive" }).kind, "accepted");
  assert.equal(checkAnswer({ uuid: "u", rule: bare }, refs, DAZING, { type: "feat", actionType: "action" }).kind, "error");
});

test("notesOnly: запись onEvent из одних заметок без иммунитета — заметки; с иммунитетом — нет", () => {
  const mk = (extra = {}) => validate({ v: 1, onEvent: [{ on: "attack-roll", afterUse: true, challenge: { statistic: "fortitude", dc: { against: "class" }, basic: false, rollerRole: "target", byDegree: { failure: [{ to: "target", note: "умирает" }] }, ...extra } }] }).rule;
  assert.equal(notesOnly(mk()), true);
  assert.equal(notesOnly(mk({ immunity: { slug: "x", label: "X", duration: { value: 1, unit: "days" } } })), false);
});

test("strikeCardFor: предмет находится по uuid (кириллическое имя без slug), slug — запасной путь", () => {
  const A = { uuid: "Actor.a" };
  const cardA = { id: "k", flags: { pf2e: { origin: { actor: A.uuid, type: "feat", uuid: "Actor.a.Item.dazing" } } }, timestamp: NOW };
  const atk = { id: "s", flags: { pf2e: { origin: { actor: A.uuid }, context: { type: "attack-roll" } } }, timestamp: NOW + 1 };
  assert.equal(ev.strikeCardFor([cardA], atk, { uuid: "Actor.a.Item.dazing", slug: "шокирующее-избиение" }, { slugOf: () => null }), cardA);
  assert.equal(ev.strikeCardFor([cardA], atk, { uuid: "Actor.a.Item.other", slug: null }, { slugOf: () => null }), null);
});

test("checkAnswer: сторож «Удар, при попадании» — damage-roll тоже, side target и Trigger не трогает", () => {
  const T = "Make a melee Strike. If your Strike hits, the target is @UUID[Compendium.pf2e.conditionitems.Item.4D2KBtexWXa6oUMR]{Drained 1}.";
  const refs = { conditions: { drained: true }, effects: {} };
  const ev = (o) => ({ on: "damage-roll", side: "self", when: ["self:action:slug:strike"], apply: [{ to: "target", condition: { slug: "drained", value: 1 } }], ...o });
  const kind = { type: "feat", actionType: "action" };
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, onEvent: [ev({})] } }, refs, T, kind).kind, "error");
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, onEvent: [ev({ side: "target" })] } }, refs, T, kind).kind, "accepted");
  const TR = "<p><strong>Trigger</strong> Your Strike hits a creature</p><hr /><p><strong>Effect</strong> The target is @UUID[Compendium.pf2e.conditionitems.Item.4D2KBtexWXa6oUMR]{Drained 1}.</p>";
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, onEvent: [ev({})] } }, refs, TR, kind).kind, "accepted");
});
