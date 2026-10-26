// Шаг note: `when` у заметки (шёпот ГМу только при истинном условии) и заметка в onEvent (раньше терялась с «пустым журналом»).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created;
globalThis.game = {
  user: { isActiveGM: true, id: "gm" }, settings: { get: (_m, k) => settings[k] }, i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } }, combats: [], actors: [], scenes: { contents: [] },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), randomID: () => "id", setProperty: (o, p, v) => { const ks = p.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; },getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o) } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { created.push(d); return d; }, getSpeaker: () => ({}), getWhisperRecipients: () => [{ id: "gm" }] };

const { MOD, setSocket } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const { buildViewModel } = await import("../scripts/chat.mjs");

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false });
  msgs = new Map(); uuids = new Map(); created = []; setSocket(null);
});

const actor = (uuid, opts = []) => ({ uuid, name: uuid, level: 3, attributes: {}, items: [], itemTypes: { condition: [], effect: [] }, getActiveTokens: () => [], getRollOptions: () => [], getSelfRollOptions: () => opts });
const tok = (uuid, opts) => { const t = { uuid, id: uuid, name: uuid, disposition: -1, actor: actor(`A.${uuid}`, opts) }; uuids.set(uuid, t); return t; };
const msg = (id = "M1") => { const m = { id, flags: { [MOD]: { use: { kind: "use", actor: "Actor.hero", token: null, targets: [], state: {}, rule: { onUse: {} }, item: { uuid: null, name: "Drag" } } } },
  async update(d) { for (const [k, v] of Object.entries(d)) { const ks = k.split("."), last = ks.pop(); ks.reduce((a, q) => (a[q] ??= {}), m)[last] = v; } } }; return m; };
const hero = actor("Actor.hero");
const NOTE = { to: "target", note: "только против лежащей", when: ["target:condition:prone"] };
const bodies = () => created.map((c) => c.content);

test("when у заметки: цель лежит — шёпот ГМу; не лежит — нет", async () => {
  uuids.set("Actor.hero", hero);
  const prone = tok("T.prone", ["target:condition:prone"]), up = tok("T.up", []);
  const ops = await applyOps(msg(), "k1", [NOTE], { scope: "apply", originActor: hero, target: prone });
  assert.equal(created.length, 1);
  assert.match(created[0].content, /только против лежащей/);
  assert.deepEqual(created[0].whisper, ["gm"]);
  assert.equal(ops[0].op, "noted");
  created.length = 0;
  assert.deepEqual(await applyOps(msg("M2"), "k2", [NOTE], { scope: "apply", originActor: hero, target: up }), []);
  assert.equal(created.length, 0);
});

test("when у заметки: повтор идемпотентен, откат не падает, заметка без when не дублируется в onUse", async () => {
  uuids.set("Actor.hero", hero);
  const prone = tok("T.prone", ["target:condition:prone"]), m = msg();
  await applyOps(m, "k1", [NOTE, { to: "target", note: "всегда" }], { scope: "apply", originActor: hero, target: prone });
  await applyOps(m, "k1", [NOTE], { scope: "apply", originActor: hero, target: prone });
  assert.equal(created.length, 1);
  assert.equal((await undoOps(m, "k1")).undone, 0);
});

test("план чата не показывает заметку с when", () => {
  const rule = { v: 1, onUse: { apply: [NOTE, { to: "target", note: "всегда" }] } };
  const use = { v: 1, kind: "use", confidence: "high", rule, slug: "d", createdAt: 1, item: { uuid: null, name: "Drag" }, targets: [], state: {} };
  const env = { t: (k) => k, mode: () => "button", now: 1, groups: () => [], tokenName: (k) => k, isOwner: () => true, isActorOwner: () => true, statLabel: (s) => s, conditionLabel: (s) => s, uuidName: () => null };
  const vm = buildViewModel({ id: "M", author: { id: "gm" }, flags: { [MOD]: { use } } }, { id: "gm", isGM: true }, env);
  const plan = vm?.useApply?.plan ?? [];
  assert.ok(!plan.includes(NOTE.note) && plan.includes("всегда"), JSON.stringify(plan));
});

test("onEvent с заметкой: событие срабатывает, текст выводится, журнал не пуст", async () => {
  const owner = hero, other = tok("T.foe", []);
  const item = { uuid: "Item.drag", name: "Drag", type: "feat", system: {}, flags: {}, actor: owner };
  const rule = rules.validateRule({ v: 1, label: "Drag", onEvent: [{ on: "damage-roll", side: "self", apply: [{ to: "self", note: "тащи цель" }] }] });
  assert.ok(rule.ok, JSON.stringify(rule.errors));
  const entry = rule.rule.onEvent[0];
  const res = await ev.runEntry({ id: "E1", options: new Set(), other, otherToken: other, message: null }, owner, { item, rule: rule.rule }, { i: 0, entry });
  assert.ok(res?.recs.length, "журнал пуст — заметка потеряна");
  assert.equal(created.length, 1);
  assert.match(created[0].content, /тащи цель/);
});

test("план чата: в режиме effect=off заметка с when остаётся в плане текстом", () => {
  const rule = { v: 1, onUse: { apply: [NOTE] } };
  const use = { v: 1, kind: "use", confidence: "high", rule, slug: "d", createdAt: 1, item: { uuid: null, name: "Drag" }, targets: [], state: {} };
  const env = (mode) => ({ t: (k) => k, mode: () => mode, now: 1, groups: () => [], tokenName: (k) => k, isOwner: () => true, isActorOwner: () => true, statLabel: (s) => s, conditionLabel: (s) => s, uuidName: () => null });
  const plan = (mode) => buildViewModel({ id: "M", author: { id: "gm" }, flags: { [MOD]: { use } } }, { id: "gm", isGM: true }, env(mode))?.useApply?.plan ?? [];
  assert.ok(plan("off").includes(NOTE.note), "off: заметка пропала");
  assert.ok(!plan("button").includes(NOTE.note));
});

test("onEvent: заметка у записи с испытанием не шепчется, без испытания — шепчется", async () => {
  settings["mode.challenge"] = "off";
  const owner = hero, other = tok("T.foe", []);
  const item = { uuid: "Item.drag", name: "Drag", type: "feat", system: {}, flags: {}, actor: owner };
  const run = (entry, id) => ev.runEntry({ id, options: new Set(), other, otherToken: other, message: null }, owner, { item, rule: { label: "Drag" } }, { i: 0, entry });
  const apply = [{ to: "self", note: "испытание — только если Удар попал" }];
  await run({ on: "attack-roll", side: "self", challenge: { statistic: "fortitude", dc: { against: "class" }, basic: false, rollerRole: "target", byDegree: {} }, apply }, "E1");
  assert.equal(created.length, 0);
  await run({ on: "attack-roll", side: "self", apply }, "E2");
  assert.equal(created.length, 1);
});
