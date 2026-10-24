// Шаг damage: повтор после отката не бьёт второй раз, урон без токена на сцене, basic только в challenge.byDegree.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  users: [],
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), mergeObject: function merge(a, b) { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v; return a; }, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: {} } } } }, Canvas: { polygonBackends: { move: { testCollision: () => false } } }, Dice: { rolls: [] } };
globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };
globalThis.Roll = class { constructor(f) { this.f = f; } async evaluate() { this.total = Roll.next; return this; } };
Roll.next = 3;

const { MOD, setSocket } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const { stepText } = await import("../scripts/chat.mjs");

const validate = rules.validateRule;
const back = (rule) => validate(formToRule(ruleToForm(rule)));
const EFF = "Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ", EFF2 = "Compendium.pf2e.spell-effects.Item.BBBBBBBBBBBBBBBB";
const ok = (apply) => validate({ v: 1, onUse: { targets: "self", apply } });
const bad = (apply) => assert.equal(ok(apply).ok, false, JSON.stringify(apply));

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: true, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map();
  game.users = [];
  setSocket(null);
});
const mkActor = (uuid, extra = {}) => { const a = { uuid, name: uuid, level: 5, attributes: {}, items: [], itemTypes: { condition: [], effect: [] }, getActiveTokens: () => [], ...extra }; uuids.set(uuid, a); return a; };
const mkMsg = (use, id = "M1") => { const m = { id, flags: { [MOD]: { use } }, async update(d) { for (const [k, v] of Object.entries(d)) { if (v && v.constructor?.name === "ForcedDeletion") { const ks = k.split("."), last = ks.pop(); delete ks.reduce((a, x) => a?.[x], m)?.[last]; } else setDeep(m, k, v); } } }; msgs.set(id, m); return m; };
const use = () => ({ kind: "use", actor: "Actor.hero", targets: [], state: {}, rule: { onUse: {} }, item: { uuid: null, name: "T" } });
const dmgRoll = () => { CONFIG.Dice.rolls = [class DamageRoll { constructor(f) { this.f = f; } async evaluate() { this.total = 7; return this; } alter(m) { const r = Object.create(this); r.total = this.total * m; return r; } }]; };
const dmg = [{ to: "target", damage: { formula: "1d6", damageType: "fire", basic: true } }];

test("откат и повтор (в т.ч. другая степень): урон один раз", async () => {
  dmgRoll();
  const hits = []; const tok = { id: "t", actor: null, parent: {} };
  mkActor("Actor.hero"); tok.actor = mkActor("Actor.foe", { applyDamage: async (d) => { hits.push(d.damage.total); } });
  const m = mkMsg(use());
  await applyOps(m, "t", dmg, { scope: "challenge", degree: 1, target: tok });
  await undoOps(m, "t");
  await applyOps(m, "t", dmg, { scope: "challenge", degree: 0, target: tok });
  await applyOps(m, "t", dmg, { scope: "challenge", degree: 1, target: tok });
  assert.deepEqual(hits, [7]);
});

test("урон без токена на сцене: прототип-токен, ops записаны", async () => {
  dmgRoll();
  const seen = []; const proto = { name: "Foe" };
  mkActor("Actor.hero", { prototypeToken: proto, applyDamage: async (d) => { seen.push(d.token); } });
  const m = mkMsg(use());
  const ops = await applyOps(m, "t", [{ to: "self", damage: { formula: "1d6", damageType: "fire" } }], { scope: "apply" });
  assert.deepEqual(seen, [proto]);
  assert.equal(ops[0].op, "damaged");
  assert.deepEqual(m.flags[MOD].use.state.damaged.length, 1);
});

test("damage.basic: только в challenge.byDegree", () => {
  const step = { to: "target", damage: { formula: "1d6", damageType: "fire", basic: true } };
  bad([step]);
  assert.equal(validate({ v: 1, onUse: { targets: "selected", check: { statistic: "athletics", vs: { defense: "ac" }, byDegree: { success: [step] } } } }).ok, false);
  assert.equal(validate({ v: 1, onUse: { targets: "selected", challenge: { statistic: "reflex", dc: { value: 20 }, byDegree: { success: [step] } } } }).ok, true);
  assert.equal(ok([{ ...step, damage: { ...step.damage, basic: undefined } }]).ok, true);
});

test("applyByDegree + шаг damage в степени: не виснет на queue(msg:), урон один раз", async () => {
  dmgRoll();
  const { applyByDegree } = await import("../scripts/saves.mjs");
  const hits = []; const tok = { id: "t", actor: null, parent: {} };
  mkActor("Actor.hero"); tok.actor = mkActor("Actor.foe", { applyDamage: async (d) => { hits.push(d.damage.total); } });
  uuids.set("Scene.s.Token.t", tok);
  const u = use();
  u.targets = [{ key: "t", uuid: "Scene.s.Token.t" }];
  u.rule = { onUse: { challenge: { statistic: "reflex", byDegree: { failure: dmg } } } };
  u.state = { challenge: { results: { t: { degree: 1, total: 5 } } } };
  const m = mkMsg(u);
  const ops = await Promise.race([applyByDegree("M1", "t"), new Promise((_, rej) => setTimeout(() => rej(new Error("queue завис")), 2000).unref())]);
  assert.deepEqual(hits, [7]);
  assert.equal(ops[0].op, "damaged");
  assert.equal(m.flags[MOD].use.state.damaged.length, 1);
});
