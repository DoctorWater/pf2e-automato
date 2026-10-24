// Шаг move: геометрия толчка/притяжения, порядок целей, валидатор, форма, журнал и откат в applyOps.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, walls;
globalThis.game = {
  user: { isActiveGM: true, id: "gm" }, users: [],
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
const warns = [];
globalThis.ui = { notifications: { warn: (m) => warns.push(m), info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), mergeObject: Object.assign, randomID: () => `id${++globalThis.__n}`, getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o) } };
globalThis.__n = 0;
globalThis.CONST = { GRID_SNAPPING_MODES: { TOP_LEFT_VERTEX: 1 } };
globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: {} } } } }, Dice: { rolls: [] },
  Canvas: { polygonBackends: { move: { testCollision: (_a, b, cfg) => {
    // как PointSourcePolygon#initialize в v14: level — документ Level, читается level.elevation.base (строка-id даёт TypeError «reading 'base'»)
    if (cfg?.level !== undefined && cfg.level.elevation.base === undefined) throw new TypeError("bad level");
    return walls.some((w) => b.x > w);
  } } } } };
globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };

const { MOD, setSocket } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const { forcedPath, moveOrder, areaPoint } = await import("../scripts/move.mjs");
const { stepText } = await import("../scripts/chat.mjs");

const validate = rules.validateRule;
const G = 100;
// квадратная сетка: диагональ 5/10/5; точки — левые верхние углы в px
const snap = (p) => ({ x: Math.floor(p.x / G + 1e-9) * G, y: Math.floor(p.y / G + 1e-9) * G });
const measure = (a, b) => { const dx = Math.abs(a.x - b.x) / G, dy = Math.abs(a.y - b.y) / G, m = Math.max(dx, dy); return (m + Math.floor(Math.min(dx, dy) / 2)) * 5; };
const path = (o) => forcedPath({ start: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, distance: 10, size: G, snap, measure, blocked: () => null, ...o });

test("forcedPath: прямо ровно 10 фт, диагональ 5/10/5, предел по дистанции", () => {
  assert.deepEqual(path().end, { x: 200, y: 0 });
  assert.equal(path({ distance: 5 }).end.x, 100);
  const d = path({ dir: { x: Math.SQRT1_2, y: Math.SQRT1_2 }, distance: 15 });   // 3 клетки по диагонали = 5+10+5 = 20 > 15 → две клетки
  assert.deepEqual(d.end, { x: 200, y: 200 });
  assert.deepEqual(path({ dir: { x: -1, y: 0 }, start: { x: 500, y: 0 } }).end, { x: 300, y: 0 });
});

test("forcedPath: стена и существо останавливают перед собой, нулевой путь", () => {
  const w = path({ blocked: (_p, n) => (n.x >= 200 ? "wall" : null) });
  assert.deepEqual([w.end.x, w.stoppedBy], [100, "wall"]);
  const c = path({ blocked: (_p, n) => (n.x >= 100 ? "creature" : null) });
  assert.deepEqual([c.path.length, c.stoppedBy], [0, "creature"]);
});

test("moveOrder: толчок — дальние первыми, притяжение — ближние; без move порядок прежний", () => {
  const items = [{ k: "near", x: 100, y: 0 }, { k: "far", x: 500, y: 0 }, { k: "mid", x: 300, y: 0 }];
  const o = { x: 0, y: 0 };
  assert.deepEqual(moveOrder([{ move: { mode: "push", distance: 5 } }], items, o).map((i) => i.k), ["far", "mid", "near"]);
  assert.deepEqual(moveOrder([{ move: { mode: "pull", distance: 5 } }], items, o).map((i) => i.k), ["near", "mid", "far"]);
  assert.deepEqual(moveOrder([{ note: "x" }], items, o).map((i) => i.k), ["near", "far", "mid"]);
});

const ok = (apply) => validate({ v: 1, onUse: { targets: "selected", apply } });
test("валидатор move: режим, кратность 5, только цель, один вид на шаг", () => {
  assert.equal(ok([{ to: "target", move: { mode: "push", distance: 10 } }]).ok, true);
  assert.equal(ok([{ move: { mode: "pull", distance: 5 } }]).ok, false);   // в onUse.apply получатель по умолчанию self
  for (const m of [{ mode: "push", distance: 7 }, { mode: "push", distance: 0 }, { mode: "teleport", distance: 10 }, { distance: 10 }, { mode: "push", distance: 10, from: "point" }])
    assert.equal(ok([{ to: "target", move: m }]).ok, false, JSON.stringify(m));
  assert.equal(ok([{ to: "self", move: { mode: "push", distance: 10 } }]).ok, false);
  assert.equal(ok([{ to: "target", move: { mode: "push", distance: 10 }, condition: { slug: "prone" } }]).ok, false);
  assert.equal(validate({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, byDegree: {
    failure: [{ to: "target", condition: { slug: "prone" } }, { to: "target", move: { mode: "push", distance: 5 } }], criticalFailure: [{ to: "target", move: { mode: "push", distance: 10 } }] } } } }).ok, true);
});

test("форма ↔ правило и текст шага", () => {
  for (const mode of ["push", "pull"]) {
    const rule = { v: 1, onUse: { targets: "selected", apply: [{ to: "target", move: { mode, distance: 15 } }] } };
    const back = validate(formToRule(ruleToForm(validate(rule).rule)));
    assert.equal(back.ok, true);
    assert.deepEqual(back.rule.onUse.apply[0].move, { mode, distance: 15 });
  }
  assert.match(stepText({ to: "target", move: { mode: "push", distance: 10 } }, { t: (k, d) => d?.what ?? `${k}:${d?.distance ?? ""}`, uuidName: () => null, conditionLabel: (s) => s }, "target"), /stepMove\.push:10/);
});

// ---- applyOps: сцена-заглушка, токены на квадратной сетке ----
const mkScene = () => ({ grid: { size: G, distance: 5, isGridless: false, snapToken: snap, getSnappedPoint: () => { throw new Error("не для токенов"); }, measurePath: ([a, b]) => ({ distance: measure(a, b) }) }, tokens: [], levels: new Map([["L1", { id: "L1", elevation: { base: 0 } }]]) });
const mkTok = (scene, uuid, x, y, actor = { uuid: `A.${uuid}` }) => {
  const t = { uuid, id: uuid, name: uuid, x, y, width: 1, height: 1, elevation: 0, level: "L1", parent: scene, actor, _source: { _movementHistory: [] }, moves: [], updates: [],
    async move(wps, o) { this.moves.push({ wps, o }); this.prev = { x: this.x, y: this.y }; this.x = wps.at(-1).x; this.y = wps.at(-1).y; this._source._movementHistory.push({ movementId: o.id }); },
    async revertRecordedMovement(id) { this.reverted = id; const h = this._source._movementHistory; const i = h.findIndex((w) => w.movementId === id); this.x = this.prev?.x ?? this.x; h.length = i; return true; },
    async update(d, o) { this.updates.push({ d, o }); this.x = d.x; this.y = d.y; } };
  t.getSnappedPosition = (p) => scene.grid.snapToken(p); scene.tokens.push(t); uuids.set(uuid, t); return t;
};
const mkMsg = (use, id = "M1") => { const m = { id, flags: { [MOD]: { use } }, async update(d) { for (const [k, v] of Object.entries(d)) { if (v && v.constructor?.name === "ForcedDeletion") { const ks = k.split("."), last = ks.pop(); delete ks.reduce((a, q) => a?.[q], m)?.[last]; } else { const ks = k.split("."), last = ks.pop(); ks.reduce((a, q) => (a[q] ??= {}), m)[last] = v; } } } }; msgs.set(id, m); return m; };
const push = (n) => [{ to: "target", move: { mode: "push", distance: n } }];
let scene, author, foe;
beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: true, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); walls = []; warns.length = 0; game.users = []; setSocket(null);
  scene = mkScene(); globalThis.canvas = { scene };
  author = mkTok(scene, "Scene.s.Token.author", 0, 0, { uuid: "Actor.hero", level: 5, attributes: {}, items: [], itemTypes: { condition: [], effect: [] }, getActiveTokens: () => [] });
  uuids.set("Actor.hero", author.actor);
  foe = mkTok(scene, "Scene.s.Token.foe", 100, 0);
});
const use = () => ({ kind: "use", actor: "Actor.hero", token: author.uuid, targets: [], state: {}, rule: { onUse: {} }, item: { uuid: null, name: "T" } });

test("толчок на 10 фт: токен сдвинут, журнал moved, откат возвращает позицию", async () => {
  const m = mkMsg(use());
  const ops = await applyOps(m, "t", push(10), { scope: "challenge", degree: 1, target: foe });
  assert.deepEqual([foe.x, foe.y], [300, 0]);
  assert.equal(foe.moves[0].wps[0].action, "displace");
  assert.equal(ops[0].op, "moved");
  assert.deepEqual(ops[0].from, { x: 100, y: 0, elevation: 0 });
  assert.equal((await undoOps(m, "t")).undone, 1);
  assert.deepEqual([foe.x, foe.y], [100, 0]);
  assert.equal(foe.reverted, ops[0].id);
});

test("откат без записи в истории — update с isUndo; токен уже двигали — не трогаем", async () => {
  const m = mkMsg(use());
  await applyOps(m, "t", push(5), { scope: "apply", target: foe });
  foe._source._movementHistory.length = 0;
  await undoOps(m, "t");
  assert.equal(foe.updates[0].o.isUndo, true);
  assert.equal(foe.updates[0].d.action, "displace");
  const m2 = mkMsg(use(), "M2");
  await applyOps(m2, "t", push(5), { scope: "apply", target: foe });
  foe.x = 900;   // кто-то сдвинул
  await undoOps(m2, "t");
  assert.equal(foe.x, 900);
  assert.equal(warns.length, 1);
});

test("упор в стену и в существо: стоп перед преградой; нулевой путь — skipped и уведомление", async () => {
  walls = [250];   // центр клетки x=300 → 350 > 250
  const m = mkMsg(use());
  await applyOps(m, "t", push(30), { scope: "apply", target: foe });
  assert.equal(foe.x, 200);
  mkTok(scene, "Scene.s.Token.wall", 300, 0);
  foe.x = 200; walls = [];
  const m2 = mkMsg(use(), "M2");
  const ops = await applyOps(m2, "t", push(20), { scope: "apply", target: foe });
  assert.equal(foe.x, 200);
  assert.deepEqual([ops[0].op, ops[0].skipped], ["moved", "blocked"]);
  assert.equal(warns.length, 1);
});

test("притяжение: останавливается вплотную к автору", async () => {
  foe.x = 500;
  const m = mkMsg(use());
  await applyOps(m, "t", [{ to: "target", move: { mode: "pull", distance: 30 } }], { scope: "apply", target: foe });
  assert.equal(foe.x, 100);   // клетка автора занята, 100 — соседняя
});

test("ключ без степени: переброс успех → крит не двигает второй раз", async () => {
  const m = mkMsg(use());
  await applyOps(m, "t", push(5), { scope: "challenge", degree: 2, target: foe });
  await applyOps(m, "t", push(10), { scope: "challenge", degree: 3, target: foe });
  assert.equal(foe.moves.length, 1);
  assert.equal(foe.x, 200);
});

test("пропуски: другая сцена, без токена автора, гексы/не 5 фт", async () => {
  const other = mkScene(); const far = mkTok(other, "Scene.o.Token.far", 100, 0);
  await applyOps(mkMsg(use()), "t", push(5), { scope: "apply", target: far });
  assert.equal(far.moves.length, 0);
  const noAuthor = { ...use(), token: null };
  await applyOps(mkMsg(noAuthor, "M2"), "t", push(5), { scope: "apply", target: foe });
  assert.equal(foe.moves.length, 0);
  scene.grid.distance = 10;
  await applyOps(mkMsg(use(), "M3"), "t", push(5), { scope: "apply", target: foe });
  assert.equal(foe.moves.length, 0);
  assert.equal(warns.length, 3);
});

test("гекс: привязка идёт через target.getSnappedPosition, а не grid.getSnappedPoint", async () => {
  scene.grid.isSquare = false;
  scene.grid.snapToken = (p) => ({ x: Math.floor((p.x - 50) / G + 1e-9) * G + 50, y: Math.floor(p.y / G + 1e-9) * G });   // сдвинутая решётка гекса
  foe.x = 150;
  await applyOps(mkMsg(use()), "t", push(10), { scope: "apply", target: foe });
  assert.deepEqual([foe.x, foe.y], [350, 0]);
});

test("цель без токена — noToken; отказ target.move — blocked", async () => {
  const ops = await applyOps(mkMsg(use()), "t", push(5), { scope: "apply", target: { uuid: "Actor.x", name: "A", actor: {} } });
  assert.deepEqual([ops[0].op, ops[0].skipped], ["moved", "noToken"]);
  foe.move = async () => false;
  const ops2 = await applyOps(mkMsg(use(), "M2"), "t", push(5), { scope: "apply", target: foe });
  assert.equal(ops2[0].skipped, "blocked");
  assert.equal(foe.x, 100);
});

test("валидатор: move запрещён в триггерах зоны и при targets area", () => {
  const mv = [{ to: "target", move: { mode: "push", distance: 10 } }];
  const zone = (apply) => ({ v: 1, onUse: { targets: "area", zone: { triggers: [{ on: "enter", apply }] } } });
  assert.equal(validate(zone(mv)).ok, false);
  assert.equal(validate(zone([{ to: "target", condition: { slug: "prone" } }])).ok, true);
  assert.equal(validate({ v: 1, onUse: { targets: "area", apply: mv } }).ok, false);
  assert.equal(validate({ v: 1, onUse: { targets: "area", challenge: { statistic: "reflex", dc: { value: 20 }, byDegree: { failure: mv } } } }).ok, false);
});

// ---- from:"point" и порядок «дальние → ближние» в auto ----
const pt = (mode, distance) => [{ to: "target", move: { mode, distance, from: "point" } }];
const circle = (x, y) => ({ uuid: "Scene.s.Region.R", parent: null, shapes: [{ type: "circle", x, y, radius: 100 }] });

test("валидатор: from:\"point\" — только в области (onUse), не в триггерах и событиях; в области — только point", () => {
  const sel = (apply) => validate({ v: 1, onUse: { targets: "selected", apply } }).ok;
  const area = (apply) => validate({ v: 1, onUse: { targets: "area", apply } }).ok;
  assert.equal(area(pt("push", 10)), true);
  assert.equal(area(push(10)), false);
  assert.equal(sel(pt("push", 10)), false);
  assert.equal(area([{ to: "target", move: { mode: "push", distance: 10, from: "origin" } }]), false);   // origin в области — как раньше
  assert.equal(validate({ v: 1, onUse: { targets: "area", zone: { triggers: [{ on: "enter", apply: pt("push", 5) }] } } }).ok, false);
  assert.equal(validate({ v: 1, onEvent: [{ on: "saving-throw", apply: pt("push", 5) }] }).ok, false);
  assert.equal(validate({ v: 1, onUse: { targets: "area", apply: [{ to: "target", move: { mode: "push", distance: 10, from: "x" } }] } }).ok, false);
  assert.deepEqual(validate({ v: 1, onUse: { targets: "area", apply: pt("pull", 15) } }).rule.onUse.apply[0].move, { mode: "pull", distance: 15, from: "point" });
});

test("форма: from:\"point\" переживает ruleToForm -> formToRule", () => {
  const rule = { v: 1, onUse: { targets: "area", apply: pt("push", 10) } };
  const back = validate(formToRule(ruleToForm(validate(rule).rule)));
  assert.deepEqual(back.rule.onUse.apply[0].move, { mode: "push", distance: 10, from: "point" });
  assert.match(stepText(pt("push", 10)[0], { t: (k, d) => d?.what ?? `${k}:${d?.distance ?? ""}`, uuidName: () => null, conditionLabel: (s) => s }, "target"), /stepMove\.pushPoint:10/);
});

test("areaPoint: круг — центр, эманация — центр рамки, конус и пустота — null", () => {
  assert.deepEqual(areaPoint({}, circle(250, 50)), { x: 250, y: 50 });
  assert.deepEqual(areaPoint({}, { shapes: [{ type: "polygon" }], flags: { pf2e: { areaShape: "emanation" } }, bounds: { x: 0, y: 100, width: 300, height: 300 } }), { x: 150, y: 250 });
  assert.equal(areaPoint({}, { shapes: [{ type: "polygon" }], flags: { pf2e: { areaShape: "cone" } }, bounds: { x: 0, y: 0, width: 1, height: 1 } }), null);
  assert.equal(areaPoint({ state: {} }), null);
});

test("from:\"point\": толчок от центра области, а не от автора; нет области — от автора с заметкой", async () => {
  foe.x = 300;
  const region = { ...circle(450, 50), parent: scene }; uuids.set(region.uuid, region);
  const u = { ...use(), state: { area: { regionUuid: region.uuid, keys: [] } } };
  await applyOps(mkMsg(u), "t", pt("push", 10), { scope: "apply", target: foe });
  assert.equal(foe.x, 100);   // автор слева (0), центр справа (450): толчок влево — по точке; от автора было бы вправо
  foe.x = 300; foe.moves.length = 0; warns.length = 0;
  await applyOps(mkMsg(use(), "M2"), "t", pt("push", 10), { scope: "apply", target: foe });
  assert.equal(foe.x, 500);
  assert.equal(warns.length, 1);
});

test("from:\"point\", притяжение не проскакивает центр области", async () => {
  const region = { ...circle(450, 50), parent: scene }; uuids.set(region.uuid, region);
  const u = { ...use(), state: { area: { regionUuid: region.uuid, keys: [] } } };
  await applyOps(mkMsg(u), "t", pt("pull", 50), { scope: "apply", target: foe });
  assert.equal(foe.x, 400);   // клетка центра (400..500), не дальше
});

test("auto: цели с move ждут все спасброски, потом двигаются дальние первыми (передний не упирается в задний)", async () => {
  const region = { ...circle(50, 50), parent: scene }; uuids.set(region.uuid, region);
  scene.tokens.get = (id) => scene.tokens.find((t) => t.id === id);
  foe.id = "foe";   // id с точками ломает пути флагов в заглушке сообщения
  const mid = mkTok(scene, "mid", 200, 0), far = mkTok(scene, "far", 300, 0);
  const u = { kind: "use", actor: "Actor.hero", token: author.uuid, targets: [], item: { uuid: null, name: "T" },
    state: { area: { regionUuid: region.uuid, keys: [foe.id, mid.id, far.id] } },
    rule: { onUse: { targets: "area", challenge: { statistic: "reflex", dc: { value: 20 }, byDegree: { failure: pt("push", 5) } } } } };
  mkMsg(u);
  const { recordResult } = await import("../scripts/saves.mjs");
  for (const t of [foe, mid]) await recordResult("M1", t.id, { degree: 1, total: 5, rollMessageId: `r-${t.id}` });
  assert.deepEqual([foe.x, mid.x, far.x], [100, 200, 300]);   // последнего результата ещё нет — никто не двигался
  await recordResult("M1", far.id, { degree: 1, total: 5, rollMessageId: "r-far" });
  assert.deepEqual([foe.x, mid.x, far.x], [200, 300, 400]);
});

test("pull к точке у цели рядом с центром — atPoint, не blocked", async () => {
  const region = { ...circle(450, 50), parent: scene }; uuids.set(region.uuid, region);
  const u = { ...use(), state: { area: { regionUuid: region.uuid, keys: [] } } };
  foe.x = 400; foe.y = 50;   // центр цели (450, 100) ближе клетки к центру области
  const ops = await applyOps(mkMsg(u, "Mat"), "t", pt("pull", 30), { scope: "apply", target: foe });
  assert.deepEqual([ops[0].op, ops[0].skipped], ["moved", "atPoint"]);
  assert.match(warns[0], /atPoint/);
});

test("noPoint и noOrigin — один тост на сообщение, не на цель", async () => {
  const foe2 = mkTok(scene, "Scene.s.Token.foe2", 0, 400);
  const m = mkMsg(use(), "Monce");
  for (const t of [foe, foe2]) await applyOps(m, "t", pt("push", 5), { scope: "apply", target: t });
  assert.equal(warns.length, 1);   // noPoint один раз на оба токена
  warns.length = 0;
  const m2 = mkMsg({ ...use(), token: null }, "Monce2");
  for (const t of [foe, foe2]) await applyOps(m2, "t", push(5), { scope: "apply", target: t });
  assert.equal(warns.length, 1);   // noOrigin
});

test("auto + move: пока не все бросили autoTried не ставится; пакет ставит autoAll и autoTried всем; откатанные потом не применяются заново", async () => {
  const region = { ...circle(50, 50), parent: scene }; uuids.set(region.uuid, region);
  scene.tokens.get = (id) => scene.tokens.find((t) => t.id === id);
  foe.id = "foe";
  const mid = mkTok(scene, "mid", 200, 0), far = mkTok(scene, "far", 300, 0);
  const u = { kind: "use", actor: "Actor.hero", token: author.uuid, targets: [], item: { uuid: null, name: "T" },
    state: { area: { regionUuid: region.uuid, keys: [foe.id, mid.id, far.id] } },
    rule: { onUse: { targets: "area", challenge: { statistic: "reflex", dc: { value: 20 }, byDegree: { failure: pt("push", 5) } } } } };
  const m = mkMsg(u, "Mauto");
  const { recordResult } = await import("../scripts/saves.mjs");
  const ch = () => m.flags[MOD].use.state.challenge;
  for (const t of [foe, mid]) await recordResult("Mauto", t.id, { degree: 1, total: 5, rollMessageId: `r-${t.id}` });
  assert.equal(ch().autoTried, undefined);
  assert.equal(ch().autoAll, undefined);
  await recordResult("Mauto", far.id, { degree: 1, total: 5, rollMessageId: "r-far" });
  assert.equal(ch().autoAll, true);
  assert.deepEqual(Object.keys(ch().autoTried).sort(), ["far", "foe", "mid"]);
  await undoOps(m, "foe"); await undoOps(m, "mid");
  delete ch().applied.foe; delete ch().applied.mid;   // заглушка сообщения не понимает forcedDelete
  await recordResult("Mauto", "foe", { degree: 1, total: 4, rollMessageId: "r-foe2", isReroll: true });   // переброс откатанной цели
  assert.ok(ch().applied.foe);   // своя цель отработана
  assert.equal(ch().applied.mid, undefined);   // чужая откатанная — не применяется заново
});
