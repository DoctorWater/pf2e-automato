// use.mjs: чистые функции и конвейер на заглушках глобалов Foundry.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) } };
const use = await import("../scripts/use.mjs");
const { hasSnapshot, useKindOf, isConsume, buildSnapshot, wantsSnapshot, areaUpdate, isResumable } = use;

const msg = (pf2e) => ({ flags: { pf2e } });
const CAST = "origin:action:slug:cast-a-spell";

test("useKindOf: consume / каст / действие / карточка / пропуски", () => {
  const consume = msg({ origin: { sourceId: "Compendium.x", uuid: "Actor.a.Item.i", type: "consumable" } });
  assert.equal(useKindOf(consume), "use"); assert.ok(isConsume(consume));
  assert.equal(useKindOf(msg({ origin: { type: "spell", rollOptions: [CAST] }, context: { type: "spell-cast" } })), "use");
  assert.equal(useKindOf(msg({ origin: { type: "spell", rollOptions: ["origin:item:spell"] } })), "card");
  assert.equal(useKindOf(msg({ origin: { type: "consumable", rollOptions: ["x"] } })), "card");
  assert.equal(useKindOf(msg({ origin: { type: "action", rollOptions: [] } })), "use");
  assert.equal(useKindOf(msg({ origin: { type: "feat", rollOptions: [] } })), "use");
  assert.equal(useKindOf(msg({ origin: { type: "spell", rollOptions: [CAST] }, context: { type: "saving-throw" } })), null);
  assert.equal(useKindOf(msg({ context: { type: "attack-roll" } })), null);
  assert.equal(useKindOf(msg({ origin: { type: "melee", rollOptions: [] } })), null);
  assert.equal(useKindOf({ flags: {} }), null);
});

const AREA = { v: 1, onUse: { targets: "area", zone: { condition: { slug: "concealed" } }, challenge: { statistic: "reflex", dc: { value: 17 }, basic: true }, apply: [] }, macros: [] };
const resolved = (rule, confidence = "high") => ({ rule, source: "catalog", slug: "smoke", sourceUuid: "Compendium.x", confidence });
const base = { item: { uuid: "i", name: "n", type: "consumable", sourceId: "Compendium.x" }, actor: "Actor.a", token: null, dc: 17, targets: [], now: 5 };

test("buildSnapshot: поля, копия правила, yielded, awaitingRegion", () => {
  const s = buildSnapshot({ ...base, kind: "use", consume: true, resolved: resolved(AREA), yielded: null });
  assert.deepEqual([s.v, s.kind, s.src, s.confidence, s.slug, s.dc, s.createdAt], [1, "use", "catalog", "high", "smoke", 17, 5]);
  assert.equal(s.state.awaitingRegion, true);
  assert.notEqual(s.rule, AREA); assert.deepEqual(s.rule, AREA);
  const c = buildSnapshot({ ...base, kind: "card", consume: false, resolved: resolved(AREA), yielded: "pf2e-automations" });
  assert.equal(c.state.awaitingRegion, undefined); assert.equal(c.state.yielded, "pf2e-automations");
  const cast = buildSnapshot({ ...base, kind: "use", consume: false, resolved: resolved(AREA) });
  assert.equal(cast.state.awaitingRegion, undefined);
  const self = buildSnapshot({ ...base, kind: "use", consume: true, resolved: resolved({ v: 1, onUse: { targets: "self", apply: [] } }) });
  assert.equal(self.state.awaitingRegion, undefined);
});

test("wantsSnapshot: карточка только с областью", () => {
  assert.equal(wantsSnapshot("card", AREA), true);
  assert.equal(wantsSnapshot("card", { onUse: { targets: "self" } }), false);
  assert.equal(wantsSnapshot("use", { onUse: { targets: "self" } }), true);
  assert.equal(wantsSnapshot("use", { onAttacked: {}, macros: [] }), false);
  assert.equal(wantsSnapshot("use", null), false);
});

test("areaUpdate: последний регион задаёт цели, применённые остаются", () => {
  const u = { targets: [{ key: "a" }, { key: "b" }, { key: "c" }],
    state: { challenge: { results: { a: {}, b: {}, c: {} }, applied: { c: { ops: [] } } } } };
  const r = areaUpdate(u, "Scene.s.Region.r2", [{ key: "a" }, { key: "d" }]);
  assert.deepEqual(r.area, { regionUuid: "Scene.s.Region.r2", keys: ["a", "d"] });
  assert.deepEqual(r.drop, ["b"]);                                  // c применён, a в наборе
  assert.deepEqual(r.targets.map((t) => t.key), ["a", "d", "c"]);
});

test("isResumable: давность, yielded, done, awaitingRegion, kind", () => {
  const now = 100 * 60000, ok = { kind: "use", createdAt: now - 10 * 60000, state: {} };
  assert.equal(isResumable(ok, now, 30), true);
  assert.equal(isResumable({ ...ok, createdAt: now - 31 * 60000 }, now, 30), false);
  assert.equal(isResumable({ ...ok, state: { yielded: "pf2e-automations" } }, now, 30), false);
  assert.equal(isResumable({ ...ok, state: { done: true } }, now, 30), false);
  assert.equal(isResumable({ ...ok, state: { awaitingRegion: true } }, now, 30), false);
  assert.equal(isResumable({ ...ok, kind: "card" }, now, 30), false);
  assert.equal(isResumable(undefined, now, 30), false);
});

/* ---------- конвейер на фейках ---------- */

function world(modes, messages) {
  globalThis.game = { settings: { get: (m, k) => ({ ...modes, resumeMinutes: 30 })[k] }, messages: { contents: messages, get: (id) => messages.find((x) => x.id === id) } };
  globalThis.fromUuid = async () => null;
  for (const m of messages) m.update = async (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.split("."), last = parts.pop();
      let o = m; for (const p of parts) o = (o[p] ??= {});
      if (last.startsWith("-=")) delete o[last.slice(2)]; else o[last] = v;
    }
  };
}
// ключ "pf2e-automato" содержит дефис, но не точку — dotted-путь в update безопасен
const mk = (id, rule, extra = {}) => ({ id, flags: { "pf2e-automato": { use: { v: 1, kind: "use", rule, confidence: "high", createdAt: Date.now(), targets: [], state: {}, ...extra } } } });
const CH = { v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 15 } }, apply: [] } };
const st = (m) => m.flags["pf2e-automato"].use;

test("runUse: challenge button — done без запуска; yielded — ничего", async () => {
  const m = mk("m1", CH);
  world({ "mode.challenge": "button", "mode.effect": "auto", "mode.macro": "auto" }, [m]);
  await use.runUse("m1");
  assert.equal(st(m).state.done, true);
  const m3 = mk("m3", CH, { state: { yielded: "pf2e-automations" } });
  world({ "mode.challenge": "auto" }, [m3]);
  await use.runUse("m3");
  assert.equal(st(m3).state.done, undefined);
});

test("resumePending: свежие берёт; старые, готовые, awaitingRegion пропускает", async () => {
  const fresh = mk("f", CH), old = mk("o", CH, { createdAt: Date.now() - 31 * 60000 }), done = mk("d", CH, { state: { done: true } });
  const aw = mk("a", CH, { state: { awaitingRegion: true } });
  world({ "mode.challenge": "off", "mode.effect": "off", "mode.macro": "off" }, [fresh, old, done, aw]);
  assert.equal(await use.resumePending({ maxAgeMinutes: 30 }), 1);
  assert.equal(st(fresh).state.done, true);
  assert.equal(st(old).state.done, undefined);
  assert.equal(st(aw).state.done, undefined);
});

test("runRegion: последний регион переписывает цели; зона button -> pending", async () => {
  const rule = { v: 1, onUse: { targets: "area", zone: { condition: { slug: "concealed" } }, challenge: { statistic: "reflex", dc: { value: 15 } }, apply: [] } };
  const m = mk("m", rule, { actor: "Actor.a", token: "Scene.s.Token.me", targets: [{ key: "x" }, { key: "y" }],
    state: { challenge: { results: { x: { degree: 1 }, y: { degree: 2 } }, applied: { y: { ops: [] } } } } });
  world({ "mode.zone": "button", "mode.challenge": "button", "mode.effect": "auto" }, [m]);
  const tok = (id) => ({ id, uuid: `Scene.s.Token.${id}`, name: id, actor: { uuid: `A.${id}`, hasPlayerOwner: id === "p" }, testInsideRegion: () => true });
  const region = { uuid: "Scene.s.Region.r", flags: { pf2e: { areaShape: "emanation", origin: {} } }, parent: { tokens: { contents: [tok("me"), tok("p"), tok("n")] } } };
  await use.runRegion(region, m);
  assert.deepEqual(st(m).state.area, { regionUuid: "Scene.s.Region.r", keys: ["p", "n"] });   // emanation: автор исключён
  assert.deepEqual(st(m).targets.map((t) => t.key), ["p", "n", "y"]);                          // y применён — остался
  assert.deepEqual(st(m).state.zone, { regionUuid: "Scene.s.Region.r", status: "pending" });
  assert.deepEqual(Object.keys(st(m).state.challenge.results), ["y"]);                          // x не применён и вне набора — отброшен
});

test("low: runUse и resumePending не применяют шаги, только копят derived.pending", async () => {
  const rule = { v: 1, onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: "Compendium.x.Item.e" } }, { to: "self", condition: { slug: "frightened", value: 1 } }] } };
  const boom = async () => { throw new Error("low не должен ничего резолвить/применять"); };
  const m = mk("l1", rule, { confidence: "low" });
  world({ "mode.effect": "auto", "mode.zone": "auto", "mode.challenge": "auto", "mode.macro": "auto" }, [m]);
  globalThis.fromUuid = boom;
  await use.runUse("l1");
  assert.deepEqual(st(m).state.derived, { pending: ["u0", "u1"], applied: [] });
  assert.equal(st(m).state.done, true);
  const m2 = mk("l2", rule, { confidence: "low" });
  world({ "mode.effect": "auto" }, [m2]);
  globalThis.fromUuid = boom;
  assert.equal(await use.resumePending({ maxAgeMinutes: 30 }), 1);
  assert.deepEqual(st(m2).state.derived.pending, ["u0", "u1"]);
});

test("hasSnapshot: чужие флаги модуля (preyTargets, castTargets) не отменяют снимок use; сам снимок — отменяет", () => {
  assert.equal(hasSnapshot({ flags: { "pf2e-automato": { preyTargets: ["Scene.s.Token.t"] } } }), false);
  assert.equal(hasSnapshot({ flags: { "pf2e-automato": { castTargets: [] } } }), false);
  assert.equal(hasSnapshot({ flags: { "pf2e-automato": { use: { v: 1 } } } }), true);
  assert.equal(hasSnapshot({ flags: {} }), false);
});

// low + испытание: бросок как у high (rollTried ставится при сбое броска у NPC), применение — отдельно (saves/chat тесты)
test("low + challenge: runUse бросает цели; high — так же; area: runRegion собирает область и бросает", async () => {
  const rolled = (m) => st(m).state.challenge?.rollTried?.n === true;
  const npc = { id: "n", uuid: "Scene.s.Token.n", name: "n", actor: { hasPlayerOwner: false, uuid: "A.n" }, testInsideRegion: () => true };
  const setup = (modes, ms) => {
    world({ "mode.challenge": "auto", "mode.effect": "auto", "mode.macro": "auto", "mode.zone": "auto", ...modes }, ms);
    game.user = { isActiveGM: true, id: "gm" };
    globalThis.fromUuidSync = () => npc;
    globalThis.fromUuid = async () => null;
  };
  const tgt = { targets: [{ key: "n", uuid: "Scene.s.Token.n" }], dc: 15, actor: "A.me" };
  for (const confidence of ["low", "high"]) {
    const m = mk(`c-${confidence}`, CH, { confidence, ...tgt });
    setup({}, [m]);
    await use.runUse(m.id);
    assert.equal(rolled(m), true, `${confidence}: бросок запущен`);
    assert.equal(st(m).state.done, true);
  }
  const area = { v: 1, onUse: { targets: "area", challenge: { statistic: "reflex", dc: { value: 15 } }, apply: [] } };
  const region = { uuid: "Scene.s.Region.r", flags: { pf2e: { origin: {} } }, parent: { tokens: { contents: [npc], get: () => npc } } };
  for (const confidence of ["low", "high"]) {
    const m = mk(`a-${confidence}`, area, { confidence, actor: "A.me", dc: 15 });
    setup({}, [m]);
    globalThis.fromUuidSync = (u) => (u === region.uuid ? region : npc);
    await use.runRegion(region, m);
    assert.deepEqual(st(m).state.area?.keys, ["n"], `${confidence}: область собрана`);
    assert.equal(rolled(m), true, `${confidence}: бросок запущен`);
  }
});

test("awaitingActions: снимок ставит флаг, isResumable его уважает", () => {
  const r = resolved({ v: 1, onUse: { apply: [] } });
  assert.equal(buildSnapshot({ ...base, kind: "use", resolved: r, awaitingActions: true }).state.awaitingActions, true);
  assert.equal(buildSnapshot({ ...base, kind: "use", resolved: r, awaitingActions: false }).state.awaitingActions, undefined);
  assert.equal(buildSnapshot({ ...base, kind: "use", resolved: r, awaitingActions: true, yielded: "pf2e-automations" }).state.awaitingActions, undefined);
  const ok = { kind: "use", createdAt: 100, state: {} };
  assert.equal(isResumable({ ...ok, state: { awaitingActions: true } }, 100, 30), false);
  assert.equal(isResumable({ ...ok, state: { awaitingActions: false } }, 100, 30), true);
});
