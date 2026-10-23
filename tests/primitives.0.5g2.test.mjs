// Подпачка 0.5g2: условие шага `when` (предикат pf2e) и шаги над эффектом: removeEffect, extendEffect, badge:"decrement", rollOption, получатели party/allies + range.
// Схема + форма туда-обратно + рантайм (apply.mjs) + текст шага (chat.mjs) + перенос PA (tools/pa-port.mjs) на фикстурах без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), mergeObject: function merge(a, b) { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v; return a; }, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: {} } } } }, Canvas: { polygonBackends: { move: { testCollision: (_a, _b) => false } } } };
globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const { isPredicate, testPredicate, parseWhen, whenText } = await import("../scripts/predicate.mjs");
const { ruleToForm, formToRule, applyOf, blankRow } = await import("../scripts/sheet.mjs");
const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const { stepText } = await import("../scripts/chat.mjs");

const validate = rules.validateRule;
const back = (rule) => validate(formToRule(ruleToForm(rule)));
const EFF = "Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ";
const ok = (apply, extra = {}) => validate({ v: 1, onUse: { targets: "self", apply, ...extra } });

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: true, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map();
});

/* ---------- предикат ---------- */

test("предикат: структура", () => {
  assert.ok(isPredicate(["feat:x", { or: ["a", { not: "b" }] }, { gte: ["item:rank", 3] }, { if: "a", then: "b" }]));
  for (const bad of [[], "feat:x", [""], [{}], [{ gte: ["a"] }], [{ gte: ["a", {}] }], [{ foo: ["a"] }], [{ or: [] }], [{ not: 3 }], [{ and: ["a"], or: ["b"] }], [1]]) assert.equal(isPredicate(bad), false, JSON.stringify(bad));
  let deep = "x";
  for (let i = 0; i < 8; i++) deep = { not: deep };
  assert.equal(isPredicate([deep]), false);   // глубже допустимого
});

test("предикат: вычислитель как у pf2e (И, or/not/nor/nand/xor/if, сравнения по опциям «имя:число»)", () => {
  const o = new Set(["feat:a", "self:level:5", "item:rank:3", "outcome:success"]);
  assert.equal(testPredicate(["feat:a", "outcome:success"], o), true);
  assert.equal(testPredicate(["feat:a", "feat:b"], o), false);
  assert.equal(testPredicate([{ or: ["feat:b", "feat:a"] }], o), true);
  assert.equal(testPredicate([{ not: "feat:b" }, { nor: ["x", "y"] }], o), true);
  assert.equal(testPredicate([{ nand: ["feat:a", "x"] }], o), true);
  assert.equal(testPredicate([{ xor: ["feat:a", "x"] }], o), true);
  assert.equal(testPredicate([{ if: "feat:a", then: "x" }], o), false);
  assert.equal(testPredicate([{ if: "feat:b", then: "x" }], o), true);
  assert.equal(testPredicate([{ gte: ["item:rank", 3] }, { lte: ["item:rank", 3] }, { gt: ["self:level", 4] }, { lt: ["self:level", 6] }], o), true);
  assert.equal(testPredicate([{ gt: ["item:rank", 3] }], o), false);
  assert.equal(testPredicate([{ gte: ["nothing", 1] }], o), false);        // опции нет — NaN, сравнение ложно
  assert.equal(testPredicate([{ eq: ["item:rank", 3] }], o), true);
  assert.equal(testPredicate([], o), true);
});

test("when: строка формы <-> предикат", () => {
  assert.deepEqual(parseWhen("feat:mentor-of-legends, spellcasting:innate"), ["feat:mentor-of-legends", "spellcasting:innate"]);
  assert.deepEqual(parseWhen('[{"gte":["item:rank",3]}]'), [{ gte: ["item:rank", 3] }]);
  assert.equal(parseWhen("  "), undefined);
  assert.equal(parseWhen("[oops"), "[oops");   // битый JSON уйдёт в валидатор и будет отвергнут
  assert.equal(whenText(["a", "b"]), "a, b");
  assert.equal(whenText([{ not: "a" }]), '[{"not":"a"}]');
  assert.equal(whenText(undefined), "");
});

/* ---------- схема ---------- */

test("when: валидатор принимает предикат и отвергает остальное", () => {
  const w = ["feat:mentor-of-legends", "spellcasting:innate"];
  const r = ok([{ to: "self", effect: { uuid: EFF }, when: w }]);
  assert.deepEqual(r.errors ?? [], []);
  assert.deepEqual(r.rule.onUse.apply[0].when, w);
  for (const bad of ["feat:x", [], [{}], [{ foo: 1 }]]) assert.equal(ok([{ to: "self", effect: { uuid: EFF }, when: bad }]).ok, false, JSON.stringify(bad));
});

test("removeEffect / extendEffect / rollOption: схема", () => {
  const good = [
    [{ removeEffect: { slug: "rage" } }, { to: "self", removeEffect: { slug: "rage" } }],
    [{ removeEffect: { uuid: EFF, of: "origin" } }, { to: "self", removeEffect: { uuid: EFF, of: "origin" } }],
    [{ extendEffect: { slug: "inspire-courage", rounds: 1 } }, { to: "self", extendEffect: { slug: "inspire-courage", rounds: 1 } }],
    [{ rollOption: { domain: "all", option: "mighty-rage" } }, { to: "self", rollOption: { domain: "all", option: "mighty-rage" } }],
    [{ rollOption: { domain: "all", option: "mighty-rage", value: false } }, { to: "self", rollOption: { domain: "all", option: "mighty-rage", value: false } }],
    [{ rollOption: { domain: "all", option: "x", value: true } }, { to: "self", rollOption: { domain: "all", option: "x" } }]
  ];
  for (const [raw, want] of good) { const r = ok([raw]); assert.deepEqual(r.errors ?? [], [], JSON.stringify(raw)); assert.deepEqual(r.rule.onUse.apply[0], want); }
  const bad = [{ removeEffect: {} }, { removeEffect: { slug: "a", uuid: EFF } }, { removeEffect: { slug: "Bad Slug" } }, { removeEffect: { slug: "a", of: "target" } },
    { extendEffect: { slug: "a" } }, { extendEffect: { slug: "a", rounds: 0 } }, { extendEffect: { slug: "a", rounds: 1.5 } },
    { rollOption: { option: "x" } }, { rollOption: { domain: "all", option: "has space" } }, { rollOption: { domain: "all", option: "x", value: "yes" } },
    { removeEffect: { slug: "a" }, effect: { uuid: EFF } }, { removeEffect: { slug: "a" }, duration: { value: 1, unit: "rounds" } }];
  for (const b of bad) assert.equal(ok([b]).ok, false, JSON.stringify(b));
});

test("effect.badge: increment | decrement | -1 (= decrement)", () => {
  const e = (badge) => ok([{ to: "self", effect: { uuid: EFF, badge } }]);
  assert.deepEqual(e("decrement").rule.onUse.apply[0].effect, { uuid: EFF, badge: "decrement" });
  assert.deepEqual(e(-1).rule.onUse.apply[0].effect, { uuid: EFF, badge: "decrement" });
  assert.deepEqual(e("increment").rule.onUse.apply[0].effect, { uuid: EFF, badge: "increment" });
  for (const bad of ["set", 1, 0]) assert.equal(e(bad).ok, false, String(bad));
});

test("to: party / allies + range; range только у allies, видимость группе нельзя", () => {
  assert.deepEqual(ok([{ to: "party", effect: { uuid: EFF } }]).rule.onUse.apply[0], { to: "party", effect: { uuid: EFF } });
  assert.deepEqual(ok([{ to: "allies", range: 30, effect: { uuid: EFF } }]).rule.onUse.apply[0], { to: "allies", effect: { uuid: EFF }, range: 30 });
  for (const bad of [{ to: "allies", effect: { uuid: EFF } }, { to: "allies", range: 3, effect: { uuid: EFF } }, { to: "allies", range: 7.5, effect: { uuid: EFF } },
    { to: "party", range: 30, effect: { uuid: EFF } }, { to: "target", range: 30, effect: { uuid: EFF } }, { to: "everyone", effect: { uuid: EFF } },
    { to: "allies", range: 30, visibility: { level: "hidden", of: "self" } }]) assert.equal(ok([bad]).ok, false, JSON.stringify(bad));
  // проверка без цели: шаги на группу допустимы (они не на «цель»)
  const chk = (to) => validate({ v: 1, onUse: { targets: "self", check: { statistic: "athletics", roll: "system", byDegree: { success: [{ to, ...(to === "allies" && { range: 30 }), effect: { uuid: EFF } }] } } } });
  assert.deepEqual(chk("party").errors ?? [], []);
  assert.equal(chk("target").ok, false);
});

/* ---------- форма туда-обратно ---------- */

test("форма туда-обратно: when, removeEffect, extendEffect, rollOption, decrement, party/allies", () => {
  const rs = [
    { to: "self", effect: { uuid: EFF }, when: ["feat:mentor-of-legends", "spellcasting:innate"] },
    { to: "self", effect: { uuid: EFF }, when: [{ or: ["feat:a", { not: "feat:b" }] }, { gte: ["item:rank", 3] }], rank: { min: 2 } },
    { to: "target", removeEffect: { slug: "rage" } },
    { to: "target", removeEffect: { uuid: EFF, of: "origin" } },
    { to: "self", extendEffect: { slug: "inspire-courage", rounds: 2 } },
    { to: "self", rollOption: { domain: "all", option: "mighty-rage" } },
    { to: "self", rollOption: { domain: "attack-roll", option: "x:y", value: false } },
    { to: "self", effect: { uuid: EFF, badge: "decrement" } },
    { to: "party", effect: { uuid: EFF } },
    { to: "allies", range: 30, effect: { uuid: EFF }, when: ["feat:x"] },
    { to: "allies", range: 15, removeCondition: { slug: "frightened" } }
  ];
  for (const a of rs) {
    const rule = ok([a]).rule;
    assert.ok(rule, JSON.stringify(a));
    const b = back(rule);
    assert.deepEqual(b.errors ?? [], [], JSON.stringify(a));
    assert.deepEqual(b.rule, rule, JSON.stringify(a));
  }
  // шаги в степенях проверки тоже идут через форму
  const deg = validate({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { source: "spell" }, byDegree: { failure: [{ to: "target", effect: { uuid: EFF }, when: ["feat:x"] }] } } } }).rule;
  assert.deepEqual(back(deg).rule, deg);
});

test("форма: битая строка when не молчит, пустой rollOption и extendEffect без раундов — ошибка валидатора", () => {
  const row = (p) => ({ ...blankRow(), to: "self", kind: "effect", text: EFF, ...p });
  assert.equal(applyOf(row({ when: "[oops" })).when, "[oops");
  const rule = (r) => validate({ v: 1, onUse: { targets: "self", apply: [applyOf(r)].filter(Boolean) } });
  assert.equal(rule(row({ when: "[oops" })).ok, false);
  assert.equal(rule(row({ kind: "extendEffect", text: "inspire-courage", value: "" })).ok, false);
  assert.equal(rule({ ...blankRow(), to: "self", kind: "rollOption", text: "mighty-rage" }).rule.onUse.apply[0].rollOption.domain, "all");
  assert.equal(applyOf({ ...blankRow(), to: "self", kind: "rollOption", text: "" }), null);
  // range не у союзников отбрасывается формой, а у союзников без радиуса — ошибка
  assert.equal(applyOf(row({ to: "target", range: "30" })).range, undefined);
  assert.equal(rule(row({ to: "allies", range: "" })).ok, false);
});

/* ---------- текст шага ---------- */

test("stepText: новые шаги, получатели и условие", () => {
  const env = { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), conditionLabel: (s) => s, uuidName: () => "Бла" };
  assert.equal(stepText({ to: "self", removeEffect: { slug: "rage" } }, env, "self"), 'chat.stepRemoveSelf{"what":"chat.stepEffect{\\"name\\":\\"rage\\"}"}');
  assert.match(stepText({ to: "self", extendEffect: { slug: "x", rounds: 1 } }, env, "self"), /chat\.stepSelf.*chat\.stepExtend/);
  assert.match(stepText({ to: "self", rollOption: { domain: "all", option: "o" } }, env, "self"), /chat\.stepOption\{\\"option\\":\\"o\\"\}/);
  assert.match(stepText({ to: "self", rollOption: { domain: "all", option: "o", value: false } }, env, "self"), /stepOptionOff/);
  assert.match(stepText({ to: "target", effect: { uuid: EFF, badge: "decrement" } }, env, "target"), /stepBadgeDec/);
  assert.match(stepText({ to: "party", effect: { uuid: EFF } }, env, "self"), /^chat\.stepParty/);
  assert.match(stepText({ to: "allies", range: 30, effect: { uuid: EFF } }, env, "self"), /^chat\.stepAllies\{"what":"Бла","range":30\}/);
  assert.match(stepText({ to: "self", effect: { uuid: EFF }, when: ["feat:x", "feat:y"] }, env, "self"), /chat\.stepWhen\{"when":"feat:x, feat:y"\}/);
});

/* ---------- рантайм ---------- */

const mkEffect = (o = {}) => {
  const e = {
    type: "effect", id: o.id ?? "e1", uuid: `Actor.hero.Item.${o.id ?? "e1"}`, slug: o.slug ?? "rage", name: o.slug ?? "rage", _stats: { compendiumSource: o.src ?? EFF }, flags: {},
    system: { duration: o.duration ?? { value: 1, unit: "minutes", expiry: null }, badge: o.badge ?? null, context: { origin: { actor: o.origin ?? "Actor.hero" } } },
    deleted: false,
    toObject() { return { name: this.name, type: "effect", system: structuredClone(this.system), _id: this.id, flags: structuredClone(this.flags) }; },
    async delete() { this.deleted = true; this.actor.itemTypes.effect = this.actor.itemTypes.effect.filter((x) => x !== this); },
    async update(d) { for (const [k, v] of Object.entries(d)) setDeep(this, k.startsWith("flags.") ? k : k, v); }
  };
  return e;
};
const mkActor = (uuid, effects = [], extra = {}) => {
  const a = { uuid, name: uuid, level: 5, attributes: {}, items: [], itemTypes: { condition: [], effect: effects }, rollOptions: {}, getActiveTokens: () => [], ...extra };
  for (const e of effects) { e.actor = a; uuids.set(e.uuid, e); }
  a.items = effects;
  a.createEmbeddedDocuments = async (_t, docs) => docs.map((d) => { const e = mkEffect({ id: `n${a.itemTypes.effect.length}`, slug: d.slug ?? d.name }); e.system = d.system; e.name = d.name; e.actor = a; a.itemTypes.effect.push(e); a.items = a.itemTypes.effect; uuids.set(e.uuid, e); return e; });
  uuids.set(uuid, a);
  return a;
};
const mkMsg = (use, flags = {}) => {
  const m = { id: "M1", flags: { [MOD]: { use }, ...flags }, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(m.id, m);
  return m;
};
const use = (extra = {}) => ({ kind: "use", actor: "Actor.hero", targets: [], state: {}, rule: { onUse: {} }, item: { uuid: null, name: "Тест" }, ...extra });

test("applyOps when: опции автора (feat:), outcome и цель; не выполнено — шаг пропущен", async () => {
  const hero = mkActor("Actor.hero", [mkEffect({ slug: "rage" })], { getRollOptions: () => ["feat:mentor-of-legends", "self:level:5"] });
  const m = mkMsg(use());
  const step = (when) => ({ to: "self", removeEffect: { slug: "rage" }, when });
  assert.deepEqual(await applyOps(m, "self", [step(["feat:other"])], { scope: "apply" }), []);
  assert.equal(hero.itemTypes.effect.length, 1);
  assert.deepEqual(await applyOps(m, "self", [step(["feat:mentor-of-legends", { gte: ["self:level", 5] }])], { scope: "apply" }), [{ op: "effRemoved", actor: "Actor.hero", data: hero.itemTypes.effect.length ? [] : (m.flags[MOD].use.state.apply.self.ops[0].data) }]);
  assert.equal(hero.itemTypes.effect.length, 0);
});

test("applyOps when: outcome:* из ctx.degree и target:* из цели", async () => {
  const hero = mkActor("Actor.hero", [], { getRollOptions: () => [] });
  const foe = mkActor("Actor.foe", [], { getSelfRollOptions: (p) => [`${p}:trait:undead`] });
  const tok = { id: "t1", uuid: "Scene.s.Token.t1", actor: foe, disposition: -1 };
  uuids.set(tok.uuid, tok);
  const m = mkMsg(use({ targets: [{ key: "t1", uuid: tok.uuid }] }));
  const stepOpt = (when) => ({ to: "target", rollOption: { domain: "all", option: "o" }, when });
  foe.toggleRollOption = async (_d, _o, _id, v) => v;   // pf2e RollOptionRuleElement#toggle возвращает новое значение
  const run = (when, degree) => applyOps(m, "t1", [stepOpt(when)], { scope: "challenge", degree, total: 10 });
  assert.equal((await run(["outcome:failure"], 2)).length, 0);
  assert.equal((await run(["outcome:success", "target:trait:undead", "target"], 2)).length, 1);
});

test("removeEffect: по slug и uuid, of:origin, откат возвращает эффект; нет эффекта — пропуск", async () => {
  const mine = mkEffect({ id: "a", slug: "inspire", origin: "Actor.hero" }), theirs = mkEffect({ id: "b", slug: "inspire", origin: "Actor.other" });
  const hero = mkActor("Actor.hero", []);
  const ally = mkActor("Actor.ally", [mine, theirs]);
  const m = mkMsg(use());
  uuids.set("Actor.hero", hero);
  const tok = { id: "t1", uuid: "Scene.s.Token.t1", actor: ally, disposition: 1 };
  uuids.set(tok.uuid, tok);
  m.flags[MOD].use.targets = [{ key: "t1", uuid: tok.uuid }];
  const ops = await applyOps(m, "t1", [{ to: "target", removeEffect: { slug: "inspire", of: "origin" } }], { scope: "apply" });
  assert.deepEqual(ops.map((o) => [o.op, o.actor, o.data.length]), [["effRemoved", "Actor.ally", 1]]);
  assert.deepEqual(ally.itemTypes.effect, [theirs]);
  assert.equal(mine.deleted, true);
  assert.deepEqual(await applyOps(m, "t1", [{ to: "target", removeEffect: { slug: "inspire", of: "origin" } }], { scope: "apply" }), []);   // повтор — пусто
  await undoOps(m, "t1");
  assert.equal(ally.itemTypes.effect.length, 2);
  // по uuid эффекта
  const byUuid = await applyOps(m, "t1", [{ to: "target", removeEffect: { uuid: EFF } }], { scope: "apply" });
  assert.equal(byUuid[0].data.length, 2);
  assert.equal(ally.itemTypes.effect.length, 0);
});

test("extendEffect: минуты -> раунды + N, повтор того же шага не продлевает, откат возвращает срок; бессрочный — пропуск", async () => {
  const eff = mkEffect({ slug: "inspire-courage", duration: { value: 1, unit: "minutes", expiry: null } });
  const hero = mkActor("Actor.hero", [eff]);
  const m = mkMsg(use());
  const step = { to: "self", extendEffect: { slug: "inspire-courage", rounds: 1 } };
  const ops = await applyOps(m, "self", [step], { scope: "apply" });
  assert.deepEqual(ops, [{ op: "extended", item: eff.uuid, prev: { value: 1, unit: "minutes", expiry: null }, key: "M1:self:0" }]);
  assert.deepEqual(eff.system.duration, { value: 11, unit: "rounds", expiry: null });
  assert.deepEqual(await applyOps(m, "self", [step], { scope: "apply" }), []);
  assert.equal(eff.system.duration.value, 11);
  await undoOps(m, "self");
  assert.deepEqual(eff.system.duration, { value: 1, unit: "minutes", expiry: null });
  assert.deepEqual(eff.flags?.[MOD]?.bumped ?? [], []);
  eff.system.duration = { value: -1, unit: "unlimited" };
  assert.deepEqual(await applyOps(mkMsg(use()), "self", [step], { scope: "apply" }), []);
  void hero;
});

test("badge decrement: -1 до минимума, на минимуме эффект снимается и откат его возвращает; нет эффекта — пусто, копия не создаётся", async () => {
  const eff = mkEffect({ slug: "x", badge: { type: "counter", value: 3, min: 1 } });
  const hero = mkActor("Actor.hero", [eff]);
  const dec = { to: "self", effect: { uuid: EFF, badge: "decrement" } };
  const m = mkMsg(use());
  const [o1] = await applyOps(m, "self", [dec], { scope: "apply" });
  assert.deepEqual([o1.op, o1.prev, eff.system.badge.value], ["badged", 3, 2]);
  await undoOps(m, "self");
  assert.equal(eff.system.badge.value, 3);
  eff.system.badge.value = 1;
  const m2 = mkMsg(use());
  const [o2] = await applyOps(m2, "self", [dec], { scope: "apply" });
  assert.equal(o2.op, "effRemoved");
  assert.equal(hero.itemTypes.effect.length, 0);
  await undoOps(m2, "self");
  assert.equal(hero.itemTypes.effect.length, 1);
  assert.deepEqual(await applyOps(mkMsg(use()), "self", [{ to: "self", effect: { uuid: "Compendium.pf2e.spell-effects.Item.none", badge: "decrement" } }], { scope: "apply" }), []);
});

test("rollOption: включает (и выключает) опцию, уже в нужном состоянии — пропуск, откат возвращает, нет правила RollOption — пропуск", async () => {
  const calls = [];
  const hero = mkActor("Actor.hero", [], {
    rollOptions: { all: { "mighty-rage": false } },
    async toggleRollOption(d, o, id, v) { calls.push([d, o, id, v]); if (o === "nope") return null; if (o === "bad") throw new Error("non-toggleable"); this.rollOptions[d][o] = v; return v; }
  });
  const m = mkMsg(use());
  const [op] = await applyOps(m, "self", [{ to: "self", rollOption: { domain: "all", option: "mighty-rage" } }], { scope: "apply" });
  assert.deepEqual(op, { op: "option", actor: "Actor.hero", domain: "all", option: "mighty-rage", prev: false });
  assert.deepEqual(calls, [["all", "mighty-rage", null, true]]);
  assert.deepEqual(await applyOps(mkMsg(use()), "self", [{ to: "self", rollOption: { domain: "all", option: "mighty-rage" } }], { scope: "apply" }), []);   // уже включена
  await undoOps(m, "self");
  assert.equal(hero.rollOptions.all["mighty-rage"], false);
  assert.deepEqual(await applyOps(mkMsg(use()), "self", [{ to: "self", rollOption: { domain: "all", option: "nope" } }], { scope: "apply" }), []);
  const off = await applyOps(mkMsg(use()), "self", [{ to: "self", rollOption: { domain: "all", option: "mighty-rage", value: false } }], { scope: "apply" });
  assert.deepEqual(off, []);   // выключена уже
  // не-toggleable бросает исключение — шаг пропущен, остальные идут дальше
  assert.deepEqual(await applyOps(mkMsg(use()), "self", [{ to: "self", rollOption: { domain: "all", option: "bad" } }], { scope: "apply" }), []);
  // выключение: toggle вернул false — это успех, а не отказ
  hero.rollOptions.all["mighty-rage"] = true;
  const m2 = mkMsg(use());
  const [o2] = await applyOps(m2, "self", [{ to: "self", rollOption: { domain: "all", option: "mighty-rage", value: false } }], { scope: "apply" });
  assert.equal(o2.prev, true);
  assert.equal(hero.rollOptions.all["mighty-rage"], false);
  await undoOps(m2, "self");
  assert.equal(hero.rollOptions.all["mighty-rage"], true);
});

test("to:party и to:allies: каждому получателю свой ключ; allies — только в радиусе, союзники, не сам автор; повтор идемпотентен", async () => {
  const mkTok = (id, actor, dist) => ({ id, actor, object: { id, center: { x: 0, y: 0 }, dist, distanceTo: (o) => o.dist } });
  const hero = mkActor("Actor.hero", [], { isAllyOf: (a) => a.ally, parties: [{ members: [] }] });
  const near = mkActor("Actor.near", [], { ally: true }), far = mkActor("Actor.far", [], { ally: true }), foe = mkActor("Actor.foe", [], { ally: false });
  const toks = [mkTok("h", hero, 0), mkTok("n", near, 25), mkTok("f", far, 60), mkTok("e", foe, 5)];
  const scene = { tokens: { filter: (fn) => toks.filter(fn) }, grid: { size: 100, measurePath: ([a, b]) => ({ distance: Math.hypot(a.x - b.x, a.y - b.y) / 20 }) } };
  const originToken = { ...mkTok("h", hero, 0), parent: scene };
  globalThis.canvas = { scene };   // сцена открыта: расстояние по объектам токенов
  hero.parties[0].members = [hero, near, far];
  const made = [];
  for (const a of [hero, near, far, foe]) a.createEmbeddedDocuments = async (_t, [d]) => { const it = { uuid: `${a.uuid}.Item.x`, id: "x", name: d.name, _source: d }; made.push(a.uuid); return [it]; };
  const src = { type: "effect", name: "E", toObject: () => ({ name: "E", type: "effect", system: { rules: [], context: {}, level: { value: 1 } }, flags: {} }) };
  uuids.set(EFF, src);
  const m = mkMsg(use());
  uuids.set("Scene.s.Token.h", originToken);
  m.flags[MOD].use.token = "Scene.s.Token.h";
  await applyOps(m, "self", [{ to: "allies", range: 30, effect: { uuid: EFF } }], { scope: "apply" });
  assert.deepEqual(made, ["Actor.near"]);
  const ops = await applyOps(m, "self", [{ to: "party", effect: { uuid: EFF } }], { scope: "apply" });
  assert.deepEqual(made.slice(1).sort(), ["Actor.far", "Actor.hero", "Actor.near"]);
  assert.equal(ops.length, 3);
  assert.equal(m.flags[MOD].use.state.apply.self.ops.length, 4);   // allies: 1, party: 3 — у каждого получателя своя запись
  // сцена не на холсте: расстояние по документам токенов (центры, 1 клетка = 100 px = 5 фт здесь 20 px/фт), стены не проверяются
  globalThis.canvas = { scene: null };
  const doc = (id, actor, x) => ({ id, actor, x, y: 0, width: 1, height: 1 });
  const dtoks = [doc("h", hero, 0), doc("n", near, 400), doc("f", far, 1500)];   // 20 и 75 футов
  scene.tokens = { filter: (fn) => dtoks.filter(fn) };
  const m3 = mkMsg(use());
  m3.id = "M3";
  m3.flags[MOD].use.token = "Scene.s.Token.h";
  uuids.set("Scene.s.Token.h", Object.assign(doc("h", hero, 0), { parent: scene, name: "H" }));
  made.length = 0;
  await applyOps(m3, "self", [{ to: "allies", range: 30, effect: { uuid: EFF } }], { scope: "apply" });
  assert.deepEqual(made, ["Actor.near"]);
  globalThis.canvas = undefined;
});

test("note без вида шага и шаг без получателя ничего не делает", async () => {
  mkActor("Actor.hero", []);
  const m = mkMsg(use());
  assert.deepEqual(await applyOps(m, "self", [{ to: "self", note: "x" }, { to: "target", removeEffect: { slug: "x" } }], { scope: "apply" }), []);
});

/* ---------- перенос PA (tools/pa-port.mjs) ---------- */

const pa = await import("../tools/pa-port.mjs");
const PEFF = "Compendium.pf2e.spell-effects.Item.AAAAAAAAAAAAAAAA";
const pctx = { effects: { [PEFF]: "Spell Effect: X" }, condSlugs: new Set(["prone"]), condIds: {}, grants: {}, labels: {}, condSlugByUuid: () => null, condNames: [] };
const grp = (rs) => ({ rules: rs.map((r) => ({ type: "base", extend: null, range: null, triggerType: "spell-cast", value: PEFF, ...r })) });
const spell = (extra = {}) => ({ type: "spell", slug: "x", name: "X", traits: [], range: "30 feet", ...extra });
const L = `@UUID[${PEFF}]`;

test("PA: предикат feat:/spellcasting:/target:* -> when; тождества предмета и исход в условие не идут", () => {
  const r = pa.translateItem(spell(), L, grp([{ target: "SelfEffect", predicate: ["origin:item:x", "feat:other", "feat:mentor-of-legends", { not: "target:trait:undead" }] }]), pctx);
  assert.equal(r.confidence, "high");
  assert.deepEqual(r.rule.onUse.apply, [{ to: "self", effect: { uuid: PEFF }, when: ["feat:other", "feat:mentor-of-legends", { not: "target:trait:undead" }] }]);
  // spellcasting:*, spell:*, action:* pf2e в наборы не кладёт — долг, а не молчаливо мёртвое условие
  for (const t of ["spellcasting:innate", "spell:other"]) assert.match(pa.translateItem(spell(), L, grp([{ target: "SelfEffect", predicate: ["origin:item:x", t] }]), pctx).reason, new RegExp(`predicate:${t}`));
  // только тождества — условия нет
  assert.equal(pa.translateItem(spell(), L, grp([{ target: "SelfEffect", predicate: ["origin:item:x", { or: ["item:slug:x", "item:slug:y"] }] }]), pctx).rule.onUse.apply[0].when, undefined);
  // сравнения (не круг) -> when, вместе с rank
  const c = pa.translateItem(spell(), L, grp([{ target: "SelfEffect", predicate: ["origin:item:x", { gte: ["origin:item:level", 3] }, { gte: ["self:level", 5] }] }]), pctx);
  assert.deepEqual(c.rule.onUse.apply[0].when, [{ gte: ["self:level", 5] }]);
  assert.deepEqual(c.rule.onUse.apply[0].rank, { min: 3 });
});

test("PA: синтетические опции PA, чужой sourceId, опечатка lge и условие спасброска остаются долгом", () => {
  const low = (pred, extra = {}) => pa.translateItem(spell(), L, grp([{ target: "SelfEffect", predicate: ["origin:item:x", ...pred], ...extra }]), pctx).reason;
  assert.match(low(["channeling-block"]), /predicate:channeling-block/);
  assert.match(low(["mType:use"]), /predicate:mType:use/);
  assert.match(low(["origin:item:sourceId:Compendium.pf2e.spells-srd.Item.BBBBBBBBBBBBBBBB"]), /predicate:origin:item:sourceId/);
  assert.match(low([{ lge: ["self:level", 3] }]), /predicate-op:lge/);
  assert.match(low(["feat:other"], { triggerType: "saving-throw" }), /roll-trigger:saving-throw/);   // у спасброска «self» PA — спасающийся: условие не переносим
});

test("PA: условие и его отрицание с одним результатом сливаются в шаг без условия; значок: условие «эффект есть» лишнее", () => {
  const same = pa.translateItem(spell(), L, grp([{ target: "TargetEffect", predicate: ["origin:item:x", { not: "feat:other" }] }, { target: "TargetEffect", predicate: ["origin:item:x", "feat:other"] }]), pctx);
  assert.deepEqual(same.rule.onUse.apply, [{ to: "target", effect: { uuid: PEFF } }]);
  const bd = pa.translateItem(spell(), L, grp([
    { target: "TargetEffect", predicate: ["origin:item:x", "feat:f", { not: "target:effect:x" }] },
    { target: "TargetIncreaseBadgeEffect", predicate: ["origin:item:x", "feat:f", "target:effect:x"] }]), pctx);
  assert.deepEqual(bd.rule.onUse.apply, [{ to: "target", effect: { uuid: PEFF, badge: "increment" }, when: ["feat:f"] }]);
});

test("PA: TurnOnOption/TurnOffOption -> rollOption, PartyEffect -> to:party, OnlyAllyWithinRange -> allies+range, TargetAllyWithinRange -> allies+range и self", () => {
  const act = { type: "action", slug: "x", name: "X", traits: [], actionType: "action" };
  const opt = pa.translateItem(act, "", grp([{ triggerType: "postInfo", target: "TurnOnOption", value: "mighty-rage-attack", predicate: ["origin:item:x", "feature:mighty-rage"] }]), pctx);
  assert.equal(opt.confidence, "high");
  assert.deepEqual(opt.rule.onUse.apply, [{ to: "self", rollOption: { domain: "all", option: "mighty-rage-attack" }, when: ["feature:mighty-rage"] }]);
  assert.deepEqual(pa.translateItem(act, "", grp([{ triggerType: "postInfo", target: "TurnOffOption", value: "o", predicate: ["origin:item:x"] }]), pctx).rule.onUse.apply, [{ to: "self", rollOption: { domain: "all", option: "o", value: false } }]);
  assert.equal(pa.translateItem(act, "", grp([{ triggerType: "postInfo", target: "TurnOnOption", value: "has space", predicate: ["origin:item:x"] }]), pctx).reason, "turn-on-option");
  assert.deepEqual(pa.translateItem(act, L, grp([{ triggerType: "postInfo", target: "PartyEffect", predicate: ["origin:item:x"] }]), pctx).rule.onUse.apply, [{ to: "party", effect: { uuid: PEFF } }]);
  const al = (t, extra = {}) => pa.translateItem(act, L, grp([{ triggerType: "postInfo", target: t, range: 5, predicate: ["origin:item:x"], ...extra }]), pctx);
  assert.deepEqual(al("OnlyAllyWithinRange").rule.onUse.apply, [{ to: "allies", range: 5, effect: { uuid: PEFF } }]);
  assert.deepEqual(al("TargetAllyWithinRange").rule.onUse.apply, [{ to: "allies", range: 5, effect: { uuid: PEFF } }, { to: "self", effect: { uuid: PEFF } }]);
  assert.equal(al("OnlyAllyWithinRange", { range: null }).reason, "target-OnlyAllyWithinRange");
});

test("sample --subpack 0.5g2: только правила с примитивами 0.5g2", async () => {
  const { usesPrimitive05g2 } = await import("../tools/sample.mjs");
  const mk = (apply) => ({ onUse: { targets: "self", apply } });
  for (const a of [{ to: "self", effect: { uuid: PEFF }, when: ["feat:x"] }, { to: "self", removeEffect: { slug: "x" } }, { to: "self", extendEffect: { slug: "x", rounds: 1 } },
    { to: "self", rollOption: { domain: "all", option: "o" } }, { to: "self", effect: { uuid: PEFF, badge: "decrement" } }, { to: "party", effect: { uuid: PEFF } }, { to: "allies", range: 5, effect: { uuid: PEFF } }]) assert.equal(usesPrimitive05g2(mk([a])), true, JSON.stringify(a));
  assert.equal(usesPrimitive05g2(mk([{ to: "self", effect: { uuid: PEFF }, rank: { min: 2 } }])), false);
  assert.equal(usesPrimitive05g2(null), false);
});

test("PA: target:effect:<slug эффекта PA из состояний> -> target:condition:<slug>; эффект без эквивалента — долг; чужой эффект у шага значка не снимается", () => {
  const pe = { Z1: { name: "Effect: Restrained until end of attacker next turn", kind: "conditions", steps: [{ slug: "restrained" }] }, Z2: { name: "Effect: Two", kind: "conditions", steps: [{ slug: "a" }, { slug: "b" }] }, Z3: { name: "Effect: Own", kind: "own" } };
  assert.deepEqual(pa.mapEffectOpts([{ not: "target:effect:restrained-until-end-of-attacker-next-turn" }, "self:effect:own", "target:effect:native-thing"], pe), [{ not: "target:condition:restrained" }, "self:effect:own", "target:effect:native-thing"]);
  assert.equal(pa.mapEffectOpts(["target:effect:two"], pe), null);
  const c = { ...pctx, paEffects: pe };
  const r = pa.translateItem(spell(), L, grp([{ target: "TargetEffect", predicate: ["origin:item:x", "target:effect:restrained-until-end-of-attacker-next-turn"] }]), c);
  assert.deepEqual(r.rule.onUse.apply[0].when, ["target:condition:restrained"]);
  assert.match(pa.translateItem(spell(), L, grp([{ target: "TargetEffect", predicate: ["origin:item:x", "target:effect:two"] }]), c).reason, /predicate:target:effect:two/);
  // значок: снимается только условие на эффект самого шага (x), чужое остаётся
  const bd = pa.translateItem(spell(), L, grp([
    { target: "TargetEffect", predicate: ["origin:item:x", { not: "target:effect:x" }, "target:effect:y"] },
    { target: "TargetIncreaseBadgeEffect", predicate: ["origin:item:x", "target:effect:x", "target:effect:y"] }]), pctx);
  assert.deepEqual(bd.rule.onUse.apply, [{ to: "target", effect: { uuid: PEFF, badge: "increment" }, when: ["target:effect:y"] }]);
});

test("PA: шаги только на группу — targets self (Living Shields не просит цели)", () => {
  const act = { type: "action", slug: "x", name: "X", traits: [], actionType: "action" };
  const r = pa.translateItem(act, L, grp([{ triggerType: "postInfo", target: "OnlyAllyWithinRange", range: 5, predicate: ["origin:item:x"] }]), pctx);
  assert.equal(r.rule.onUse.targets, "self");
});

test("extendEffect сохраняет expiry (pf2e иначе подставит turn-start) и возвращает при откате; removeEffect не трогает grantedBy и неснятое", async () => {
  const eff = mkEffect({ slug: "effect-inspire", duration: { value: 2, unit: "rounds", expiry: "turn-end" } });
  mkActor("Actor.hero", [eff]);
  const m = mkMsg(use());
  await applyOps(m, "self", [{ to: "self", extendEffect: { slug: "inspire", rounds: 1 } }], { scope: "apply" });   // slug без префикса effect-
  assert.deepEqual(eff.system.duration, { value: 3, unit: "rounds", expiry: "turn-end" });
  await undoOps(m, "self");
  assert.deepEqual(eff.system.duration, { value: 2, unit: "rounds", expiry: "turn-end" });
  const granted = mkEffect({ id: "g", slug: "g" }), stuck = mkEffect({ id: "s", slug: "g" });
  granted.grantedBy = {};
  const hero = mkActor("Actor.hero2", [granted, stuck]);
  stuck.delete = async () => {};   // pf2e отменил удаление (restrict): документ остался
  hero.items = Object.assign([granted, stuck], { has: (id) => id === "g" || id === "s" });
  assert.deepEqual(await applyOps(mkMsg(use({ actor: "Actor.hero2" })), "self", [{ to: "self", removeEffect: { slug: "g" } }], { scope: "apply" }), []);
  assert.equal(granted.deleted, false);
});

test("whenHuman: читаемый вывод условия", async () => {
  const { whenHuman } = await import("../scripts/predicate.mjs");
  assert.equal(whenHuman(["feat:x", { not: "target:trait:undead" }, { or: ["a", "b"] }, { gte: ["self:level", 5] }]), "feat:x, !target:trait:undead, (a | b), self:level ≥ 5");
});

test("предикат: первый операнд сравнения — строка (pf2e isBinaryOp)", () => {
  assert.equal(isPredicate([{ gte: [5, 3] }]), false);
  assert.equal(isPredicate([{ gte: ["self:level", 3] }]), true);
});

test("PA: эффект PA заменён эффектом pf2e — опция по slug замены (Bless); IncreaseBadgeEffect без префикса — на себя; item:* не переносится", () => {
  const pe = { B1: { name: "Effect: Aura Bless", kind: "pf2e", uuid: PEFF }, B2: { name: "Effect: Aura Nope", kind: "pf2e", uuid: "Compendium.pf2e.spell-effects.Item.ZZZZZZZZZZZZZZZZ" } };
  assert.deepEqual(pa.mapEffectOpts(["self:effect:aura-bless"], pe, { [PEFF]: "Spell Effect: Bless" }), ["self:effect:bless"]);
  const pe2 = { B1: { name: "Aura: Bless", kind: "pf2e", uuid: PEFF } };
  assert.deepEqual(pa.mapEffectOpts(["self:effect:aura-bless"], pe2, { [PEFF]: "Spell Effect: Bless" }), ["self:effect:bless"]);
  assert.equal(pa.mapEffectOpts(["self:effect:aura-nope"], { B2: { name: "Aura: Nope", kind: "pf2e", uuid: "Compendium.pf2e.spell-effects.Item.ZZZZZZZZZZZZZZZZ" } }, {}), null);
  const act = { type: "action", slug: "x", name: "X", traits: [], actionType: "action" };
  const b = pa.translateItem(act, L, grp([{ triggerType: "postInfo", target: "IncreaseBadgeEffect", predicate: ["origin:item:x"] }]), pctx);
  assert.equal(b.rule.onUse.apply[0].to, "self");
  assert.equal(pa.translateItem(spell(), L, grp([{ target: "SelfEffect", predicate: ["origin:item:x", { or: ["feat:a", "item:melee"] }] }]), pctx).confidence, "low");
});

test("PA: пара «нет эффекта / есть эффект» с значком (Bless, aura-bless при нашем эффекте bless) — ворота присутствия не остаются в when", () => {
  const r = pa.translateItem(spell(), L, grp([
    { target: "SelfEffect", predicate: ["origin:item:x", { not: "self:effect:aura-x" }] },
    { target: "IncreaseBadgeEffect", predicate: ["origin:item:x", "self:effect:aura-x"] },
  ]), pctx);
  assert.deepEqual(r.rule.onUse.apply.map((a) => [a.when, a.effect.badge ?? null]), [[undefined, "increment"]]);
});
