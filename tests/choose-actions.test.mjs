// Починки шага 1 plan-activate: picks из сохранённых chose (applyOps, applyUse(only)) и гонка variable-cast (awaitingActions).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, isGM: false, id: "gm" }, users: [],
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
globalThis.Roll = class { constructor(f) { this.f = f; } async evaluate() { this.total = 3; return this; } };

const { MOD, setSocket } = await import("../scripts/util.mjs");
const use = await import("../scripts/use.mjs");
const vc = await import("../scripts/builtin/variable-cast.mjs");

beforeEach(() => {
  Object.assign(settings, { "mode.effect": "auto", "mode.challenge": "auto", "mode.macro": "auto", resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); setSocket(null);
  globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
});
const mkMsg = (useFlag, id = "M1", extra = {}) => {
  const m = { id, isAuthor: true, flags: { ...(useFlag && { [MOD]: { use: useFlag } }), ...extra }, async update(d) { m.updates.push(d); for (const [k, v] of Object.entries(d)) setDeep(m, k, v); }, updates: [] };
  if (!m.flags[MOD]) m.flags[MOD] = {};
  msgs.set(id, m); return m;
};
const mkActor = (uuid, extra = {}) => { const a = { uuid, name: uuid, level: 5, attributes: {}, items: [], itemTypes: { condition: [], effect: [] }, getActiveTokens: () => [], ...extra }; uuids.set(uuid, a); return a; };
const dmgRoll = () => { CONFIG.Dice.rolls = [class DamageRoll { constructor(f) { this.f = f; } async evaluate() { this.total = 7; return this; } alter(m) { const r = Object.create(this); r.total = this.total * m; return r; } }]; };

const RULE = { onUse: { targets: "selected", apply: [
  { choose: { from: "options", options: [{ value: "a" }, { value: "b", when: ["never"] }] } },
  { to: "target", when: ["choice:a"], damage: { formula: "1d6", damageType: "fire" } }
] } };
function scene(state = {}) {
  dmgRoll();
  const hits = [];
  mkActor("Actor.hero");
  const tok = { id: "t", uuid: "Scene.s.Token.t", actor: mkActor("Actor.foe", { applyDamage: async (d) => { hits.push(d.damage.total); } }), parent: {} };
  uuids.set(tok.uuid, tok);
  const m = mkMsg({ kind: "use", confidence: "high", actor: "Actor.hero", rule: RULE, item: { uuid: null, name: "T" }, targets: [{ key: "t", uuid: tok.uuid }], state });
  return { m, hits };
}

test("choose + шаг цели when:choice:a в одном onUse: выбор виден шагу цели", async () => {
  const { m, hits } = scene();
  await use.applyUse("M1");
  assert.deepEqual(hits, [7]);
  assert.ok(m.flags[MOD].use.state.apply.self.ops.some((o) => o.op === "chose" && o.value === "a"));
});

test("applyUse(only): выбор берётся из сохранённых chose; чужой выбор шаг не пускает", async () => {
  const chose = (value) => ({ apply: { self: { ops: [{ op: "chose", key: "M1:self:0", value }] } } });
  const a = scene(chose("a"));
  await use.applyUse("M1", "t");
  assert.deepEqual(a.hits, [7]);
  const b = scene(chose("b"));
  await use.applyUse("M1", "t");
  assert.deepEqual(b.hits, []);
});

const DMG_SELF = { onUse: { targets: "self", apply: [{ to: "self", damage: { formula: "1d6", damageType: "fire" } }] } };
test("awaitingActions: onCreateMessage не исполняет, onUpdateMessage исполняет ровно один раз", async () => {
  dmgRoll();
  const hits = [];
  mkActor("Actor.hero", { applyDamage: async (d) => { hits.push(d.damage.total); } });
  const m = mkMsg({ kind: "use", confidence: "high", actor: "Actor.hero", rule: DMG_SELF, item: { uuid: null, name: "T" }, targets: [], state: { awaitingActions: true } });
  await use.onCreateMessage(m);
  assert.deepEqual(hits, []);
  await use.onUpdateMessage(m, { flags: { [MOD]: { cast: { actions: 2 } } } });   // посторонний update
  assert.deepEqual(hits, []);
  m.flags[MOD].use.state.awaitingActions = false;
  const ch = { flags: { [MOD]: { use: { state: { awaitingActions: false } } } } };
  await use.onUpdateMessage(m, ch);
  await use.onUpdateMessage(m, ch);   // повтор идемпотентен (done)
  assert.equal(hits.length, 1);
  assert.equal(m.flags[MOD].use.state.done, true);
});

test("applyUse не исполняет, пока ждёт числа действий", async () => {
  scene({ awaitingActions: true });
  await assert.rejects(() => use.applyUse("M1"), /числа действий/);
});

test("runRegion пропускает сообщение, ждущее число действий", async () => {
  const m = mkMsg({ kind: "use", confidence: "high", rule: { onUse: { targets: "area", zone: { condition: { slug: "concealed" } } } }, targets: [], state: { awaitingActions: true } });
  await use.runRegion({ uuid: "Scene.s.Region.r", flags: { pf2e: {} } }, m);
  assert.deepEqual(m.updates, []);
});

/* ---------- variable-cast.onMessage: снятие флага ---------- */
const CAST = "origin:action:slug:cast-a-spell";
function castWorld({ answer, time = "1 to 3", failUuid = false, flag = true }) {
  uuids.set("Item.s", { name: "Heal", slug: "heal", system: { time: { value: time } } });
  if (failUuid) globalThis.fromUuid = async () => { throw new Error("boom"); };
  globalThis.foundry.applications = { api: { DialogV2: { wait: async () => answer } } };
  return mkMsg(flag ? { state: { awaitingActions: true } } : undefined, "C1", { pf2e: { origin: { type: "spell", uuid: "Item.s", rollOptions: [CAST] } } });
}
const standing = (m) => m.flags[MOD].use?.state?.awaitingActions;

test("variable-cast: число и снятие флага — одним update", async () => {
  const m = castWorld({ answer: { action: "2" } });
  await vc.onMessage(m);
  assert.equal(m.updates.length, 1);
  assert.equal(m.flags[MOD].cast.actions, 2);
  assert.ok(m.flags.pf2e.origin.rollOptions.includes("origin:item:cast:actions:2"));
  assert.equal(standing(m), false);
});

test("variable-cast: отмена окна и «не переменное» — флаг снят без опции", async () => {
  const m = castWorld({ answer: null });
  await vc.onMessage(m);
  assert.equal(standing(m), false);
  assert.equal(m.flags[MOD].cast, undefined);
  const n = castWorld({ answer: { action: "2" }, time: "2" });
  await vc.onMessage(n);
  assert.equal(standing(n), false);
});

test("variable-cast: исключение — флаг снят в finally", async () => {
  const m = castWorld({ answer: { action: "2" }, failUuid: true });
  await assert.rejects(() => vc.onMessage(m), /boom/);
  assert.equal(standing(m), false);
});

test("variable-cast: без флага лишних update нет", async () => {
  const m = castWorld({ answer: null, flag: false });
  await vc.onMessage(m);
  assert.deepEqual(m.updates, []);
});
