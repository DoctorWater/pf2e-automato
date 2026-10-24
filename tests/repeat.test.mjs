// Повторный спасбросок (шаг repeat, triggered-save T1): схема, форма, запись носителя, срабатывание на ходу, карточка-хозяин без автора, снятие и откат. Без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created;
const warned = [];
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map(), getCondition: (slug) => ({ uuid: null, _stats: { compendiumSource: `Compendium.pf2e.conditionitems.Item.${slug}` }, name: slug, img: "i.svg", system: { value: { isValued: slug === "frightened" } }, toObject() { return { name: slug, type: "condition", system: { slug, value: { isValued: false, value: null } } }; } }) } }
};
globalThis.ui = { notifications: { warn(k) { warned.push(k); }, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o), escapeHTML: (s) => s } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: ({ actor }) => ({ actor: actor.id }), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const { repeatMeta, repeatChallenge, sameCarrier } = await import("../scripts/repeat.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");

const validate = rules.validateRule;
const REP = { on: "turn-end", end: ["success", "criticalSuccess"] };
const chRule = (step, extra = {}) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { source: "spell" }, traits: ["mental"], options: ["x"], byDegree: { failure: [step] }, ...extra } } });
const step = (o = {}) => ({ to: "target", condition: { slug: "frightened", value: 1 }, repeat: REP, ...o });

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = []; warned.length = 0;
});

/* ---------- схема и форма ---------- */

test("repeat: внутри challenge поля испытания не нужны; нормализация и порядок степеней", () => {
  const r = validate(chRule(step({ repeat: { on: "turn-start", end: ["criticalSuccess", "success", "success"] } })));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rule.onUse.challenge.byDegree.failure[0].repeat, { on: "turn-start", end: ["success", "criticalSuccess"] });
  assert.deepEqual(validate(chRule(step({ repeat: { on: "turn-end" } }))).rule.onUse.challenge.byDegree.failure[0].repeat.end, ["success", "criticalSuccess"]);   // end по умолчанию
});

test("repeat: вне challenge нужны statistic и dc; чужие шаги, escape, плохие поля — ошибки", () => {
  const apply = (s) => validate({ v: 1, onUse: { targets: "selected", apply: [s] } });
  assert.equal(apply(step()).ok, false);   // нет statistic/dc
  assert.equal(apply(step({ repeat: { ...REP, statistic: "will" } })).ok, false);
  const ok = apply(step({ repeat: { ...REP, statistic: "will", dc: 25, traits: ["mental"] } }));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rule.onUse.apply[0].repeat, { on: "turn-end", statistic: "will", dc: 25, traits: ["mental"], end: ["success", "criticalSuccess"] });
  const full = { ...REP, statistic: "will", dc: 25 };
  for (const bad of [step({ to: "self", repeat: full }), step({ condition: undefined, note: "x", repeat: full }), step({ escape: {}, repeat: full }),
    step({ repeat: { ...full, on: "turn" } }), step({ repeat: { ...full, end: [] } }), step({ repeat: { ...full, end: ["win"] } }), step({ repeat: { ...full, dc: 0 } }), step({ repeat: "x" })])
    assert.equal(apply(bad).ok, false, JSON.stringify(bad));
});

test("repeat: переживает форму мастерской (ruleToForm -> formToRule)", () => {
  const r = validate(chRule(step({ repeat: { on: "turn-end", end: ["criticalSuccess"] } }))).rule;
  const back = validate(formToRule(ruleToForm(r)));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.rule.onUse.challenge.byDegree.failure[0].repeat, { on: "turn-end", end: ["criticalSuccess"] });
});

/* ---------- запись носителя ---------- */

function mkActor(uuid, name = uuid) {
  let n = 0;
  const items = Object.assign([], { has(id) { return items.some((i) => i.id === id); } });
  const actor = {
    uuid, name, id: uuid.split(".").pop(), level: 5, attributes: {}, items, rollOptions: {}, isDead: false, hasPlayerOwner: false,
    get itemTypes() { return { condition: items.filter((i) => i.type === "condition"), effect: items.filter((i) => i.type === "effect") }; },
    tokens: [], getActiveTokens() { return this.tokens; },
    getRollOptions: () => [], getSelfRollOptions: (p) => [`${p}:test`],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: `i${++n}`, uuid: `${uuid}.Item.i${n}`, actor, parent: actor, isLocked: false, slug: d.system?.slug ?? d.name, _stats: d._stats ?? {} };
        it.toObject = () => ({ ...structuredClone({ name: it.name, type: it.type, system: it.system, flags: it.flags }), _id: it.id });
        it.delete = async () => { items.splice(items.indexOf(it), 1); };
        uuids.set(it.uuid, it); items.push(it);
        return it;
      });
    },
    async deleteEmbeddedDocuments(_, ids) { for (const id of ids) items.splice(items.findIndex((i) => i.id === id), 1); }
  };
  uuids.set(uuid, actor);
  return actor;
}
const mkToken = (id, actor) => { const t = { id, uuid: `Scene.s.Token.${id}`, name: id, actor, disposition: -1 }; actor.tokens = [t]; uuids.set(t.uuid, t); return t; };
const mkMsg = (use) => {
  const m = { id: "M", flags: { [MOD]: { use } }, async update(d) { for (const [p, v] of Object.entries(d)) setDeep(m, p, v); } };
  msgs.set(m.id, m);
  return m;
};
const useOf = (rule, o = {}) => ({ actor: "Actor.author", token: null, item: { uuid: "Item.spell", name: "Spell" }, rule, dc: 27, targets: [{ key: "t1", uuid: "Scene.s.Token.t1" }], state: {}, ...o });

test("repeat: носитель — своя обёртка unlimited с meta.repeat (СЛ из use.dc, навык и черты из испытания); повтор шага не удваивает", async () => {
  const author = mkActor("Actor.author"), victim = mkActor("Actor.victim");
  mkToken("t1", victim);
  const rule = validate(chRule(step())).rule, st = rule.onUse.challenge.byDegree.failure;
  const m = mkMsg(useOf(rule));
  const ops = await applyOps(m, "t1", st, { scope: "challenge", degree: 1, originActor: author });
  assert.equal(ops.length, 1);
  const w = victim.items[0];
  assert.deepEqual(w.system.duration, { sustained: false, value: -1, unit: "unlimited", expiry: null });
  assert.deepEqual(w.flags[MOD].meta.repeat, { on: "turn-end", statistic: "will", dc: 27, traits: ["mental"], options: ["x"], end: ["success", "criticalSuccess"] });
  assert.equal(w.flags[MOD].meta.by, "Actor.author");
  assert.equal((await applyOps(m, "t1", st, { scope: "challenge", degree: 1, originActor: author })).length, 0);
  assert.equal(victim.items.length, 1);
});

test("repeat: СЛ — снимок из результата цели, если use.dc пуст; нет СЛ вовсе — отказ", async () => {
  const victim = mkActor("Actor.victim"); mkToken("t1", victim);
  const rule = validate(chRule(step())).rule, st = rule.onUse.challenge.byDegree.failure;
  const m = mkMsg(useOf(rule, { dc: null, state: { challenge: { results: { t1: { degree: 1, dc: 31 } } } } }));
  await applyOps(m, "t1", st, { scope: "challenge", degree: 1, originActor: mkActor("Actor.author") });
  assert.equal(victim.items[0].flags[MOD].meta.repeat.dc, 31);
  const v2 = mkActor("Actor.v2"); mkToken("t1", v2);
  const m2 = mkMsg(useOf(validate(chRule(step())).rule, { dc: null }));   // dc.source:"spell" без предмета и автора не считается
  await applyOps(m2, "t1", st, { scope: "challenge", degree: 1 });
  assert.equal(v2.items.length, 0);
  assert.deepEqual(warned, ["PF2E_AUTOMATO.apply.repeatNoDC"]);
});

test("repeat: у цели уже есть такое состояние — явный отказ, чужой документ не тронут; то же для эффекта автора", async () => {
  const author = mkActor("Actor.author"), victim = mkActor("Actor.victim"); mkToken("t1", victim);
  const mine = { id: "own", type: "condition", slug: "frightened", isLocked: false, grantedBy: null, flags: {}, system: {} };
  victim.items.push(mine);
  const rule = validate(chRule(step())).rule, st = rule.onUse.challenge.byDegree.failure;
  const ops = await applyOps(mkMsg(useOf(rule)), "t1", st, { scope: "challenge", degree: 1, originActor: author });
  assert.equal(ops.length, 0);
  assert.equal(victim.items.length, 1);
  assert.equal(mine.flags[MOD], undefined);   // meta.repeat в чужой документ не пишем
  assert.deepEqual(warned, ["PF2E_AUTOMATO.apply.repeatTaken"]);
  // эффект: уже висит эффект этого источника
  const EFF = "Compendium.pf2e.spell-effects.Item.x";
  victim.items.push({ id: "e", type: "effect", _stats: { compendiumSource: EFF }, system: { context: { origin: { actor: "Actor.author" } } }, flags: {} });
  const r2 = validate(chRule({ to: "target", effect: { uuid: EFF }, repeat: REP })).rule;
  victim.items.splice(0, 1);
  assert.equal((await applyOps(mkMsg(useOf(r2)), "t1", r2.onUse.challenge.byDegree.failure, { scope: "challenge", degree: 1, originActor: author })).length, 0);
  assert.equal(warned.length, 2);
});

test("repeat: такой же носитель того же автора, предмета и шага из другого использования — отказ", () => {
  const meta = { key: "M2:t1:c1.0", origin: "Item.s", by: "Actor.a" };
  const other = { key: "M1:t1:c1.0", origin: "Item.s", by: "Actor.a", repeat: {} };
  assert.equal(sameCarrier(meta, other), true);
  assert.equal(sameCarrier(meta, { ...other, by: "Actor.b" }), false);
  assert.equal(sameCarrier(meta, { ...other, key: "M1:t2:c1.0" }), false);
  assert.equal(sameCarrier(meta, { ...other, repeat: undefined }), false);
});

/* ---------- срабатывание на ходу ---------- */

const carrier = (victim, o = {}) => {
  const item = { id: "w", type: "effect", uuid: `${victim.uuid}.Item.w`, name: "Frightened 1", slug: "frightened", system: { context: { origin: { actor: "Actor.author" } } }, _stats: {}, flags: { [MOD]: { meta: { key: "M:t1:c1.0", by: "Actor.author", origin: "Item.spell", repeat: { on: "turn-end", statistic: "will", dc: 27, end: ["success", "criticalSuccess"], ...o } } } }, actor: victim, parent: victim };
  victim.items.push(item); uuids.set(item.uuid, item);
  return item;
};
const hooks = () => { const h = {}; globalThis.Hooks = { on: (n, f) => { (h[n] ??= []).push(f); } }; ev.init(); return h; };
const tick = () => new Promise((r) => setTimeout(r, 10));
const cb = (actor, round) => [{ id: "c1", actor }, { id: "E", round, turn: 0 }];

test("actorEvent: карточка-хозяин на конце хода, нужный on; начало хода не стреляет конец; повтор хука и мёртвые — тишина", async () => {
  const h = hooks();
  const victim = mkActor("Actor.victim", "Гоблин"); mkToken("t1", victim); carrier(victim);
  uuids.set("Item.spell", { uuid: "Item.spell", name: "Подрыв реальности", type: "spell", system: {} });
  h["pf2e.startTurn"][0](...cb(victim, 1)); await tick();
  assert.equal(created.length, 0);
  await h["pf2e.endTurn"][0](...cb(victim, 1)); await tick();
  assert.equal(created.length, 1);
  const use = created[0].flags[MOD].use;
  assert.equal(use.item.name, "Подрыв реальности");
  assert.equal(use.actor, "Actor.author");
  assert.equal(use.dc, 27);
  assert.deepEqual(use.rule.onUse.challenge.dc, { value: 27 });
  assert.deepEqual(Object.keys(use.rule.onUse.challenge.byDegree).sort(), ["criticalSuccess", "success"]);
  assert.deepEqual(use.rule.onUse.challenge.byDegree.success, [{ to: "target", removeKey: "M:t1:c1.0" }]);
  assert.deepEqual(use.targets.map((t) => t.key), ["t1"]);
  await h["pf2e.endTurn"][0](...cb(victim, 1)); await tick();   // тот же ход: повтор хука
  assert.equal(created.length, 1);
  await h["pf2e.endTurn"][0](...cb(victim, 2)); await tick();   // следующий раунд: снова
  assert.equal(created.length, 2);
  victim.isDead = true;
  await h["pf2e.endTurn"][0](...cb(victim, 3)); await tick();
  assert.equal(created.length, 2);
  delete globalThis.Hooks;
});

test("hostChallenge: автор удалён (owner null) — говорящий по имени предмета, актёр снимка — строка, СЛ из снимка", async () => {
  const victim = mkActor("Actor.victim", "Гоблин"); const t = mkToken("t1", victim);
  const h = hooks();
  carrier(victim, { on: "turn-start" });   // автора и предмета в мире нет
  await h["pf2e.startTurn"][0](...cb(victim, 1)); await tick();
  assert.equal(created.length, 1);
  const m = created[0];
  assert.deepEqual(m.speaker, { alias: "Frightened 1" });
  assert.equal(m.flags[MOD].use.actor, "Actor.author");
  assert.equal(m.flags[MOD].use.dc, 27);
  assert.equal(m.flags[MOD].use.targets[0].uuid, t.uuid);
  assert.equal(m.flags[MOD].use.state.event.includes(":repeat"), true);
  // прямой вызов: без токена цели карточки нет
  const lone = mkActor("Actor.lone");
  assert.equal(await ev.hostChallenge({ owner: null, other: lone, challenge: repeatChallenge({ statistic: "will", dc: 20 }, "k"), key: "k", name: "X", build: () => ({ state: {} }) }), null);
  delete globalThis.Hooks;
});

test("mode.challenge=off: повтор не стреляет", async () => {
  const h = hooks();
  const victim = mkActor("Actor.victim"); mkToken("t1", victim); carrier(victim);
  settings["mode.challenge"] = "off"; settings["mode.effect"] = "auto";
  await h["pf2e.endTurn"][0](...cb(victim, 1)); await tick();
  assert.equal(created.length, 0);
  delete globalThis.Hooks;
});

/* ---------- снятие и откат ---------- */

test("снятие: шаг removeKey на степень из end убирает носитель, откат возвращает его; чужой документ не трогается", async () => {
  const victim = mkActor("Actor.victim"); mkToken("t1", victim);
  const w = carrier(victim);
  w.toObject = () => ({ name: w.name, type: "effect", system: w.system, flags: structuredClone(w.flags) });
  w.delete = async () => { victim.items.splice(victim.items.indexOf(w), 1); };
  const foreign = { id: "f", type: "effect", uuid: "x", flags: { [MOD]: { meta: { key: "M:t1:c1.0" } } }, system: {}, actor: victim };   // тот же ключ, но без meta.repeat
  victim.items.push(foreign);
  const rc = repeatChallenge(w.flags[MOD].meta.repeat, "M:t1:c1.0");
  const rule = { v: 1, onUse: { targets: "selected", challenge: rc } };
  const m = mkMsg({ ...useOf(rule), dc: 27 });
  const ops = await applyOps(m, "t1", rc.byDegree.success, { scope: "challenge", degree: 2, originActor: null });
  assert.deepEqual(ops.map((o) => o.op), ["effRemoved"]);
  assert.equal(victim.items.includes(w), false);
  assert.equal(victim.items.includes(foreign), true);
  assert.equal(rules.isActiveStep(rc.byDegree.success[0]), true);
  await undoOps(m, "t1");
  assert.equal(victim.items.some((i) => i.flags?.[MOD]?.meta?.repeat), true);   // носитель создан заново
});

test("repeatMeta / repeatChallenge: шаг перекрывает испытание; степени вне end ничего не делают", () => {
  const meta = repeatMeta({ on: "turn-end", statistic: "reflex", end: ["criticalSuccess"] }, { statistic: "will", traits: ["fire"], options: ["o"] }, 20);
  assert.deepEqual(meta, { on: "turn-end", statistic: "reflex", dc: 20, traits: ["fire"], options: ["o"], end: ["criticalSuccess"] });
  const c = repeatChallenge(meta, "k");
  assert.deepEqual(Object.keys(c.byDegree), ["criticalSuccess"]);
  assert.deepEqual(c.traits, ["fire"]);
  assert.equal(c.rollerRole, "target");
});

/* ---------- доработки Критика ---------- */

test("repeat: нельзя с policy reduce, effect.badge и effect.replace (не создают свой документ)", () => {
  const E = "Compendium.pf2e.spell-effects.Item.x", full = { ...REP, statistic: "will", dc: 20 };
  const bad = (s) => validate({ v: 1, onUse: { targets: "selected", apply: [{ to: "target", repeat: full, ...s }] } }).ok;
  assert.equal(bad({ condition: { slug: "frightened", value: 1, policy: "reduce" } }), false);
  assert.equal(bad({ effect: { uuid: E, badge: "increment" } }), false);
  assert.equal(bad({ effect: { uuid: E, replace: true } }), false);
  assert.equal(bad({ effect: { uuid: E } }), true);
});

test("sameCarrier: ключ двойника ev:… с двоеточиями сравнивается по хвосту tokenKey:stepKey", () => {
  const a = { key: "ev:E1:Item.x.y:0:t1:0.0", origin: "o", by: "b", repeat: {} };
  assert.equal(sameCarrier({ key: "ev:E2:Item.x.y:0:t1:0.0", origin: "o", by: "b" }, a), true);
  assert.equal(sameCarrier({ key: "ev:E2:Item.x.y:0:t2:0.0", origin: "o", by: "b" }, a), false);
});

test("носитель-состояние: обёртка cascade; выданное кончилось само — обёртка без выданного удаляется, карточки нет", async () => {
  const author = mkActor("Actor.author"), victim = mkActor("Actor.victim"); mkToken("t1", victim);
  const rule = validate(chRule(step())).rule;
  await applyOps(mkMsg(useOf(rule)), "t1", rule.onUse.challenge.byDegree.failure, { scope: "challenge", degree: 1, originActor: author });
  const w = victim.items[0];
  assert.equal(w.system.rules[0].onDeleteActions.grantee, "cascade");
  const h = hooks();
  await h["pf2e.endTurn"][0](...cb(victim, 1)); await tick();   // выданного состояния нет (itemGrants пуст)
  assert.equal(created.length, 0);
  assert.equal(victim.items.includes(w), false);
  delete globalThis.Hooks;
});
