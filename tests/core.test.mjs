// util / compat / apply на заглушках глобалов Foundry (game, fromUuid, foundry.utils, CONFIG).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { degreeFromTotal, queue, MOD, sluggify, callGM, setSocket } from "../scripts/util.mjs";
import { CALL_MS } from "../scripts/leader.mjs";
import { buildAutomationsIndex, groupsCovering } from "../scripts/compat.mjs";
import { applyCondition, applyEffect, hasEffect, applyOps, undoOps, removeByKey, findByKey } from "../scripts/apply.mjs";

/* ---------- util ---------- */

test("degreeFromTotal: пороги ±10, нат.20/нат.1, клэмп", () => {
  const t = [
    [20, 15, null, 2], [15, 15, null, 2], [14, 15, null, 1], [25, 15, null, 3], [5, 15, null, 0], [6, 15, null, 1],
    [14, 15, 20, 2],   // провал -> успех
    [15, 15, 1, 1],    // успех -> провал
    [25, 15, 20, 3],   // клэмп сверху
    [5, 15, 1, 0],     // клэмп снизу
    [6, 15, 20, 2], [24, 15, 1, 1], [26, 15, 1, 2]
  ];
  for (const [total, dc, die, want] of t) assert.equal(degreeFromTotal(total, dc, die), want, `${total} vs ${dc} die ${die}`);
});

test("sluggify (локальная копия)", () => {
  assert.equal(sluggify("Nimble Dodge"), "nimble-dodge");
  assert.equal(sluggify("Bravo's Brew"), "bravos-brew");
  assert.equal(sluggify("Зелье Ржавого Корня"), "зелье-ржавого-корня");   // как pf2e: юникодные буквы сохраняются
  assert.equal(sluggify("NimbleDodge"), "nimble-dodge");
});

test("queue: сериализует по ключу, переживает ошибку, разные ключи параллельны", async () => {
  const log = [];
  const slow = (n, ms, fail) => queue("k", async () => { log.push(`s${n}`); await new Promise((r) => setTimeout(r, ms)); log.push(`e${n}`); if (fail) throw new Error("x"); return n; });
  const p1 = slow(1, 20, true), p2 = slow(2, 1), p3 = queue("other", async () => log.push("other"));
  await assert.rejects(p1, /x/);
  assert.equal(await p2, 2);
  await p3;
  assert.deepEqual(log, ["s1", "other", "e1", "s2", "e2"]);
});

test("callGM: нет ГМа / без автоповтора / таймаут", async (t) => {
  globalThis.ui = { notifications: { warn: () => { globalThis.warned = (globalThis.warned ?? 0) + 1; } } };
  globalThis.game = { i18n: { localize: (k) => k }, users: { activeGM: null } };
  try {
    assert.deepEqual(await callGM("x"), { ok: false, reason: "no-gm" });
    assert.equal(globalThis.warned, 1);
    const calls = [];
    game.users.activeGM = { id: "gm1" };
    setSocket({ executeAsUser: async (name, id, ...a) => { calls.push([name, id, ...a]); return calls.length === 1 ? { ok: false, reason: "not-active-gm" } : { ok: true }; } });
    assert.equal((await callGM("y", 1)).reason, "not-active-gm");
    assert.equal(calls.length, 1);   // повтора нет
    t.mock.timers.enable({ apis: ["setTimeout"] });
    setSocket({ executeAsUser: () => new Promise(() => {}) });
    const p = callGM("z");
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(CALL_MS + 1);
    assert.deepEqual(await p, { ok: false, reason: "timeout" });
  } finally { delete globalThis.game; delete globalThis.ui; delete globalThis.warned; setSocket(null); }
});

/* ---------- compat ---------- */

const FP = { uuid: "aMJ", group: "action", name: "Frightful Presence", source: ["frightful-presence"], isActive: true,
  baseRules: [{ predicate: ["outcome:failure", "item:slug:frightful-presence"] }], complexRules: [] };
const BREW = { uuid: "bb", group: "equipment", name: "Bravo's Brew", isActive: true,
  source: ["Compendium.pf2e.equipment-srd.Item.oCuwJ9IUDAuzsUwa"], baseRules: [{ predicate: ["consumable:bravos-brew-lesser"] }], complexRules: [] };
const OFF = { uuid: "off", name: "Off", source: ["off-slug"], isActive: false };

test("compat: индекс по slug, UUID источника и предикатам; неактивные пропускаются", () => {
  const idx = buildAutomationsIndex({ aMJ: FP, bb: BREW, off: OFF });
  assert.deepEqual(groupsCovering(idx, { slug: "frightful-presence" }), ["Frightful Presence"]);
  assert.deepEqual(groupsCovering(idx, { sourceUuid: "Compendium.pf2e.equipment-srd.Item.oCuwJ9IUDAuzsUwa" }), ["Bravo's Brew"]);
  assert.deepEqual(groupsCovering(idx, { slug: "bravos-brew-lesser" }), ["Bravo's Brew"]);   // из предиката consumable:
  assert.deepEqual(groupsCovering(idx, { slug: "off-slug" }), []);
  assert.deepEqual(groupsCovering(idx, {}), []);
  assert.deepEqual(groupsCovering(idx, { slug: null, sourceUuid: null }), []);
  assert.deepEqual(buildAutomationsIndex(null), []);
});

const REAL = "C:/Users/USER/AppData/Local/Temp/claude/E--Foundry-VTT-v14-366/46b70f73-cd76-4b9a-a57a-6e1e8d6f2758/scratchpad/pf2e-automations-rulesV3.json";
test("compat: реальный каталог pf2e-automations (если доступен)", { skip: !existsSync(REAL) }, () => {
  const idx = buildAutomationsIndex(JSON.parse(readFileSync(REAL, "utf8")).rules);
  assert.ok(idx.length > 100);
  assert.ok(groupsCovering(idx, { slug: "frightful-presence" }).length >= 1);
  for (const u of ["oCuwJ9IUDAuzsUwa", "sWPkbSlWAEAStBqD", "zM9VX3QwM81DzDUA"])
    assert.ok(groupsCovering(idx, { sourceUuid: `Compendium.pf2e.equipment-srd.Item.${u}` }).includes("Bravo's Brew"), u);
});

/* ---------- apply: заглушки документов ---------- */

function setDeep(o, path, v) {
  const ks = path.split(".");
  const last = ks.pop();
  for (const k of ks) o = (o[k] ??= {});
  if (last.startsWith("-=")) delete o[last.slice(2)]; else o[last] = v;
}
const getDeep = (o, path) => path.split(".").reduce((a, k) => a?.[k], o);
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a[k] ?? {}, v) : v; return a; };

function mkActor(uuid) {
  let n = 0;
  const items = [];
  const actor = {
    uuid, items,
    get itemTypes() { return { condition: items.filter((i) => i.type === "condition") }; },
    getActiveTokens: () => [],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const id = `i${++n}`;
        const it = { ...structuredClone(d), id, uuid: `${uuid}.Item.${id}`, actor, isLocked: false, slug: d.system?.slug ?? d.name };
        it._source = it; Object.defineProperty(it, "_stats", { value: d._stats });
        it.delete = async () => { items.splice(items.indexOf(it), 1); };
        registry.set(it.uuid, it);
        items.push(it);
        return it;
      });
    },
    async deleteEmbeddedDocuments(_, ids) { for (const i of items.filter((x) => ids.includes(x.id))) await i.delete(); }
  };
  return actor;
}
const registry = new Map();
const COND_DATA = { frightened: true, concealed: false };

function setup() {
  registry.clear();
  globalThis.game = { modules: { get: () => null }, pf2e: { ConditionManager: {
    getCondition: (slug) => ({ toObject: () => ({ name: slug, type: "condition", system: { slug, value: { isValued: COND_DATA[slug], value: COND_DATA[slug] ? 1 : null } } }) }),
    updateConditionValue: async (id, actor, v) => { actor.items.find((i) => i.id === id).system.value.value = v; }
  } } };
  globalThis.foundry = { utils: { mergeObject: (a, b) => merge(a, b), getProperty: getDeep } };
  globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: { fire: 1 } } } } } };
  globalThis.fromUuid = async (u) => registry.get(u) ?? null;
}
const teardown = () => { for (const k of ["game", "foundry", "CONFIG", "fromUuid"]) delete globalThis[k]; };
const cval = (it) => it.system.value.value;

test("applyCondition: frightened 1 -> 2 raised, 2 при 1 skipped, add, не-valued, meta.key", async () => {
  setup();
  try {
    const a = mkActor("Actor.a");
    let r = await applyCondition(a, { slug: "frightened", value: 1 }, { key: "m:t:0" });
    assert.equal(r.op, "created"); assert.equal(cval(r.item), 1);
    assert.equal(findByKey(a, "m:t:0"), r.item);
    assert.equal((await applyCondition(a, { slug: "frightened", value: 2 }, { key: "m:t:1" })).op, "raised");
    assert.equal(cval(r.item), 2);
    r = await applyCondition(a, { slug: "frightened", value: 1 }, { key: "m:t:2" });
    assert.equal(r.op, "skipped"); assert.equal(cval(a.items[0]), 2);
    assert.equal((await applyCondition(a, { slug: "frightened", value: 2 }, { key: "m:t:1" })).op, "skipped");   // тот же ключ
    r = await applyCondition(a, { slug: "frightened", value: 1, policy: "add" }, { key: "m:t:3" });
    assert.equal(r.op, "raised"); assert.equal(r.prev, 2); assert.equal(cval(a.items[0]), 3);
    assert.equal((await applyCondition(a, { slug: "concealed" }, { key: "m:t:4" })).op, "created");
    assert.equal((await applyCondition(a, { slug: "concealed" }, { key: "m:t:5" })).op, "skipped");   // не valued, уже есть
    assert.equal(a.items.length, 2);
  } finally { teardown(); }
});

test("applyCondition: зона создаёт свою копию, дубль по тому же ключу не создаётся", async () => {
  setup();
  try {
    const a = mkActor("Actor.a");
    await applyCondition(a, { slug: "concealed" }, { key: "m:t:0" });
    assert.equal((await applyCondition(a, { slug: "concealed" }, { key: "zone:R1", source: "zone" })).op, "created");
    assert.equal((await applyCondition(a, { slug: "concealed" }, { key: "zone:R2", source: "zone" })).op, "created");
    assert.equal((await applyCondition(a, { slug: "concealed" }, { key: "zone:R2", source: "zone" })).op, "skipped");
    assert.equal(a.items.length, 3);
    assert.equal(await removeByKey(a, "zone:R1"), 1);
    assert.equal(a.items.length, 2);
  } finally { teardown(); }
});

test("applyEffect + hasEffect: дедуп по источнику+автору и по ключу", async () => {
  setup();
  try {
    const EFF = "Compendium.pf2e.equipment-effects.Item.e1";
    registry.set(EFF, { type: "effect", toObject: () => ({ _id: "src", name: "Eff", type: "effect", system: { traits: { value: [] }, slug: "eff" }, _stats: { compendiumSource: null } }) });
    const a = mkActor("Actor.a"), origin = { uuid: "Actor.o", system: {} };
    const ctx = { originActor: origin, originItem: { uuid: "Item.x", system: { traits: { value: ["fire", "magical"] } }, getOriginData: () => ({ rollOptions: ["r"] }) } };
    const r = await applyEffect(a, { uuid: EFF }, { key: "m:t:0", source: "apply" }, ctx);
    assert.equal(r.op, "created");
    assert.equal(r.item._stats.compendiumSource, EFF);
    assert.deepEqual(r.item.system.traits.value, ["fire"]);
    assert.equal(r.item.system.context.origin.actor, "Actor.o");
    assert.equal(r.item.system.context.target.actor, "Actor.a");
    assert.equal(r.item.system.context.roll, null);   // без степени — pf2e спросит ГМа
    assert.ok(hasEffect(a, EFF, "Actor.o"));
    assert.ok(!hasEffect(a, EFF, "Actor.other"));
    assert.ok(hasEffect(a, EFF, "Actor.other", "m:t:0"));
    assert.equal((await applyEffect(a, { uuid: EFF }, { key: "m:t:9" }, ctx)).op, "skipped");   // тот же источник и автор
    assert.equal((await applyEffect(a, { uuid: EFF }, { key: "m:t:9" }, { originActor: { uuid: "Actor.other" } })).op, "created");   // другой автор
    assert.equal((await applyEffect(a, { uuid: "nope" }, { key: "m:t:8" }, ctx)).op, "skipped");
  } finally { teardown(); }
});

test("applyEffect: степень шага попадает в system.context.roll (выбор по исходу проходит сам)", async () => {
  setup();
  try {
    const EFF = "Compendium.pf2e.feat-effects.Item.bonmot";
    registry.set(EFF, { type: "effect", toObject: () => ({ _id: "src", name: "Bon Mot", type: "effect", system: { traits: { value: [] } }, _stats: {} }) });
    const t = mkActor("Actor.t"), o = mkActor("Actor.o");
    const message = { id: "M", flags: { [MOD]: { use: { actor: "Actor.o", targets: [], rule: { onUse: { check: {} } }, state: {} } } }, async update() {} };
    await applyOps(message, "tk", [{ to: "target", effect: { uuid: EFF } }], { scope: "challenge", degree: 3, total: 27, target: { actor: t, uuid: "tok.t" } });
    assert.deepEqual(t.items[0].system.context.roll, { total: 27, degreeOfSuccess: 3 });
    t.items.length = 0;
    await applyOps(message, "tk2", [{ to: "target", effect: { uuid: EFF } }], { scope: "challenge", degree: 1, target: { actor: t, uuid: "tok.t" } });   // нет итога -> roll null
    assert.equal(t.items[0].system.context.roll, null);
  } finally { teardown(); }
});

test("applyOps + undoOps: frightened по степеням, идемпотентность, откат raised/created", async () => {
  setup();
  try {
    const tok = mkActor("Actor.t");
    const author = mkActor("Actor.author");
    registry.set("Scene.s.Token.t1", { uuid: "Scene.s.Token.t1", actor: tok });
    registry.set("Actor.author", author);
    const msg = {
      id: "M1", flags: { [MOD]: { use: { actor: "Actor.author", token: null, item: null, targets: [{ key: "t1", uuid: "Scene.s.Token.t1" }], rule: {}, state: {} } } },
      async update(d) { for (const [p, v] of Object.entries(d)) setDeep(this, p, v); }
    };
    const steps = [{ to: "target", condition: { slug: "frightened", value: 2, policy: "max" } }, { note: "урон x1/2" }];
    // цель уже напугана 1 -> raised
    await applyCondition(tok, { slug: "frightened", value: 1 }, { key: "pre" });
    let ops = await applyOps(msg, "t1", steps, { scope: "challenge", degree: 1 });
    assert.deepEqual(ops.map((o) => [o.op, o.prev]), [["raised", 1]]);
    assert.equal(msg.flags[MOD].use.state.challenge.applied.t1.degree, 1);
    assert.deepEqual(await applyOps(msg, "t1", steps, { scope: "challenge", degree: 1 }), []);   // повтор: пусто
    assert.equal(msg.flags[MOD].use.state.challenge.applied.t1.ops.length, 1);
    // onUse.apply на себя: создаётся
    ops = await applyOps(msg, "self", [{ to: "self", condition: { slug: "concealed" } }], { scope: "apply" });
    assert.equal(ops[0].op, "created");
    assert.equal(author.items.length, 1);

    assert.deepEqual(await undoOps(msg, "t1"), { undone: 1 });
    assert.equal(cval(tok.items[0]), 1);   // вернули prev
    assert.equal(msg.flags[MOD].use.state.challenge.applied.t1, undefined);
    assert.deepEqual(await undoOps(msg, "self"), { undone: 1 });
    assert.equal(author.items.length, 0);
    assert.deepEqual(await undoOps(msg, "self"), { undone: 0 });
  } finally { teardown(); }
});
