// Аура владельца (triggered-save T3, onEvent side:"near"): схема, форма, геометрия входа, ключ per, выдача карточки. Без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created, cid = 0;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  combats: [],
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o), escapeHTML: (s) => s } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: ({ actor }) => ({ actor: actor.id }), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const aura = await import("../scripts/aura.mjs");
const { ruleToForm, formToRule, blankEvent } = await import("../scripts/sheet.mjs");

const validate = rules.validateRule;
const AURA = { statistic: "will", dc: { value: 25 }, immunity: { slug: "frightful-aura", duration: { value: 1, unit: "minutes" } }, byDegree: { failure: [{ to: "target", who: "enemy", condition: { slug: "frightened" } }] } };   // who — на шагах «к цели»: challengeWho
const one = (e) => validate({ v: 1, onEvent: [{ side: "near", challenge: AURA, ...e }] });
const STEP = [{ to: "target", condition: { slug: "frightened" } }];

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = []; cid++;   // fired в events.mjs общий на модуль: бой у каждого теста свой
  game.user.isActiveGM = true; game.combats = [];
});

/* ---------- схема ---------- */

test("near: валидные записи нормализуются (aura | range, per), enter — только near", () => {
  const r = one({ on: "turn-end", aura: "frightful-aura", per: "round" });
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.rule.onEvent[0].side, r.rule.onEvent[0].aura, r.rule.onEvent[0].per, r.rule.onEvent[0].range], ["near", "frightful-aura", "round", undefined]);
  for (const on of rules.NEAR_ON) assert.equal(one({ on, range: 20 }).ok, true, on);
  assert.equal(one({ on: "enter", range: 20 }).rule.onEvent[0].range, 20);
  assert.equal(validate({ v: 1, onEvent: [{ on: "enter", challenge: AURA }] }).ok, false);   // side:self + enter
  assert.equal(validate({ v: 1, onEvent: [{ on: "enter", side: "target", challenge: AURA }] }).ok, false);
});

test("near: отказы — событие не из turn/enter, зона не задана или задана дважды, afterUse, per/aura вне near", () => {
  for (const bad of [{ on: "attack-roll", range: 10 }, { on: "damage-taken", aura: "x" }, { on: "turn-end" }, { on: "turn-end", aura: "x", range: 10 }, { on: "turn-end", range: 0 },
    { on: "turn-end", range: "20" }, { on: "turn-end", aura: "" }, { on: "turn-end", aura: 5 }, { on: "turn-end", range: 10, per: "day" }, { on: "turn-end", range: 10, afterUse: true }])
    assert.equal(one(bad).ok, false, JSON.stringify(bad));
  for (const bad of [{ on: "turn-end", side: "self", range: 10 }, { on: "turn-end", side: "self", aura: "x" }, { on: "turn-end", side: "self", per: "round" }])
    assert.equal(validate({ v: 1, onEvent: [{ ...bad, apply: [{ condition: { slug: "frightened" } }] }] }).ok, false, JSON.stringify(bad));
});

test("near: форма мастерской туда-обратно; aura/range/per не просачиваются в запись не-near", () => {
  const src = { v: 1, onEvent: [
    { on: "turn-end", side: "near", aura: "frightful-aura", per: "round", challenge: AURA },
    { on: "enter", side: "near", range: 20, per: "turn", when: ["target:trait:undead"], challenge: AURA },
    { on: "turn-start", side: "near", range: 10, apply: STEP }
  ] };
  const rule = validate(src).rule, back = validate(formToRule(ruleToForm(rule)));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.rule.onEvent, rule.onEvent);
  const f = ruleToForm(rule); f.ev[0].side = "self";
  assert.equal("aura" in formToRule(f).onEvent[0], false);
  assert.equal(blankEvent().per, "");
});

test("matchEntries: near отбирается по событию, стороне и when", () => {
  const rule = validate({ v: 1, onEvent: [
    { on: "turn-end", side: "near", range: 10, when: ["target:trait:undead"], challenge: AURA },
    { on: "turn-end", side: "near", aura: "a", challenge: AURA },
    { on: "enter", side: "near", range: 10, challenge: AURA },
    { on: "turn-end", side: "self", apply: [{ condition: { slug: "frightened" } }] }
  ] }).rule;
  const idx = (on, opts) => ev.matchEntries(rule, on, "near", new Set(opts)).map((m) => m.i);
  assert.deepEqual(idx("turn-end", ["target"]), [1]);
  assert.deepEqual(idx("turn-end", ["target:trait:undead"]), [0, 1]);
  assert.deepEqual(idx("enter", []), [2]);
  assert.deepEqual(idx("turn-start", []), []);
});

/* ---------- геометрия ---------- */

const sq = (x, y, w = 1, h = 1) => ({ x, y, w, h });

test("insideAura: радиус в футах", () => {
  const c = sq(0, 0);
  assert.equal(aura.insideAura(30, c, sq(6, 0)), true);    // зазор 5 клеток + 1 = 30 фт
  assert.equal(aura.insideAura(30, c, sq(7, 0)), false);
  assert.equal(aura.insideAura(null, c, sq(1, 0)), false);
});

test("nearRadius: range, либо radius ауры pf2e у токена владельца; нет ауры — null", () => {
  const tok = { object: { auras: new Map([["frightful-aura", { radius: 30 }]]) } };
  assert.equal(aura.nearRadius({ range: 15 }, tok), 15);
  assert.equal(aura.nearRadius({ aura: "frightful-aura" }, tok), 30);
  assert.equal(aura.nearRadius({ aura: "other" }, tok), null);
  assert.equal(aura.nearRadius({ aura: "frightful-aura" }, {}), null);
});

/* ---------- выдача ---------- */

function mkActor(uuid, rule = null) {
  const items = [];
  const actor = { uuid, name: uuid, id: uuid.split(".").pop(), items, isDead: false, hasPlayerOwner: false, tokens: [], getActiveTokens() { return this.tokens; }, getSelfRollOptions: (p) => [`${p}:test`], getRollOptions: () => [] };
  if (rule) { const f = { type: "feat", id: "f1", uuid: `${uuid}.Item.f1`, name: "Frightful Aura", slug: "frightful-aura", system: {}, flags: { [MOD]: { rule } }, actor, parent: actor }; items.push(f); uuids.set(f.uuid, f); }
  uuids.set(uuid, actor);
  return actor;
}
const scene = { id: "s", grid: { size: 100, distance: 5 }, tokens: [] };
function mkTok(id, actor, x, y, disposition = -1) {
  const t = { id, uuid: `Scene.s.Token.${id}`, name: id, actor, disposition, x, y, width: 1, height: 1, hidden: false, parent: scene, object: { auras: new Map([["frightful-aura", { radius: 30 }]]) } };
  actor.tokens = [t]; scene.tokens.push(t); uuids.set(t.uuid, t);
  return t;
}
const stage = (entries) => {
  scene.tokens.length = 0;
  const v = validate({ v: 1, onEvent: entries.map((e) => ({ side: "near", challenge: AURA, ...e })) });
  assert.deepEqual(v.errors, []);
  const boss = mkActor("Actor.boss", v.rule), pc = mkActor("Actor.pc");
  return { boss, pc, tBoss: mkTok("b1", boss, 0, 0, -1), tPc: mkTok("p1", pc, 300, 0, 1) };   // PC: зазор 2 клетки = 15 фт
};
const END = (round, turn = 1) => ({ evId: `turn:${cid}:${round}:${turn}:cb:turn-end`, combat: `C${cid}`, round, turn });
const ENTER = (name, round = 2, turn = 1) => ({ evId: `enter:${cid}${name}`, combat: `C${cid}`, round, turn });
const mv = (id, from, to) => ({ id, origin: { x: from, y: 0 }, destination: { x: to, y: 0 } });

test("fireNear turn-end: ходящий внутри ауры — карточка; снаружи, сам носитель, союзник носителя (who) — нет", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura" }]);
  await ev.fireNear("turn-end", tBoss, tPc, END(1));
  assert.equal(created.length, 1);
  const use = created[0].flags[MOD].use;
  assert.deepEqual(use.targets.map((t) => t.key), ["p1"]);
  assert.equal(use.actor, "Actor.boss");
  assert.ok(use.state.event.startsWith("trg:"));
  await ev.fireNear("turn-end", tBoss, tBoss, END(1, 2));   // сам носитель
  tPc.x = 1500;
  await ev.fireNear("turn-end", tBoss, tPc, END(2));        // снаружи
  tPc.x = 300; tPc.disposition = -1;
  await ev.fireNear("turn-end", tBoss, tPc, END(3));        // who:enemy — союзник носителя не бросает
  assert.equal(created.length, 1);
});

test("fireNear per:round: вход и конец хода в одном раунде — одна карточка, новый раунд — снова; без per — каждое событие", async () => {
  const { tBoss, tPc } = stage([{ on: "enter", aura: "frightful-aura", per: "round" }, { on: "turn-end", aura: "frightful-aura", per: "round" }]);
  await ev.fireNear("enter", tBoss, tPc, ENTER("a"), mv("p1", 1500, 300));
  await ev.fireNear("turn-end", tBoss, tPc, END(2));
  assert.equal(created.length, 1);
  await ev.fireNear("turn-end", tBoss, tPc, END(3));
  assert.equal(created.length, 2);
  const s = stage([{ on: "turn-end", aura: "frightful-aura" }]);
  await ev.fireNear("turn-end", s.tBoss, s.tPc, END(5, 1));
  await ev.fireNear("turn-end", s.tBoss, s.tPc, END(5, 3));
  assert.equal(created.length, 4);
});

test("fireNear per:turn: раунд и ход боя; разные ауры одного носителя окна не делят", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura", per: "turn" }, { on: "turn-end", range: 30, per: "turn" }]);
  await ev.fireNear("turn-end", tBoss, tPc, END(2, 1));
  assert.equal(created.length, 2);   // aura и range — два окна
  await ev.fireNear("turn-end", tBoss, tPc, END(2, 1));
  assert.equal(created.length, 2);
  await ev.fireNear("turn-end", tBoss, tPc, END(2, 2));
  assert.equal(created.length, 4);
});

test("fireNear enter: двигалась жертва или носитель; уже внутри и вышел — нет; аура не активна у токена — молчит", async () => {
  const { tBoss, tPc } = stage([{ on: "enter", aura: "frightful-aura" }]);
  await ev.fireNear("enter", tBoss, tPc, ENTER("a"), mv("p1", 1500, 300));
  assert.equal(created.length, 1);
  await ev.fireNear("enter", tBoss, tPc, ENTER("b"), mv("p1", 300, 200));    // внутри -> внутри
  await ev.fireNear("enter", tBoss, tPc, ENTER("c"), mv("p1", 300, 1500));   // вышел
  assert.equal(created.length, 1);
  tBoss.x = 0;
  await ev.fireNear("enter", tBoss, tPc, ENTER("d"), mv("b1", -1200, 0));   // носитель подошёл к жертве
  assert.equal(created.length, 2);
  tBoss.object.auras.clear();
  await ev.fireNear("enter", tBoss, tPc, ENTER("e"), mv("p1", 1500, 300));
  assert.equal(created.length, 2);
});

test("fireNear: range без Aura RE; иммунная цель карточки не получает; when цели; мёртвый и режим challenge=off молчат", async () => {
  const { boss, pc, tBoss, tPc } = stage([{ on: "turn-end", range: 20, challenge: { ...AURA, when: ["target:test"] } }]);
  tBoss.object.auras.clear();
  await ev.fireNear("turn-end", tBoss, tPc, END(1));   // 15 фт <= 20
  assert.equal(created.length, 1);
  pc.items.push({ type: "effect", system: { context: { origin: { actor: boss.uuid } } }, flags: { [MOD]: { immunity: { slug: "frightful-aura" } } } });
  await ev.fireNear("turn-end", tBoss, tPc, END(2));
  assert.equal(created.length, 1);   // иммунитет
  pc.items.length = 0;
  tPc.x = 600;   // зазор 5 клеток = 30 фт > 20
  await ev.fireNear("turn-end", tBoss, tPc, END(3));
  tPc.x = 300; pc.isDead = true;
  await ev.fireNear("turn-end", tBoss, tPc, END(4));
  pc.isDead = false; settings["mode.challenge"] = "off";
  await ev.fireNear("turn-end", tBoss, tPc, END(5));
  assert.equal(created.length, 1);
});

test("fireNear: иммунная цель не гасит окно per — после снятия иммунитета в том же раунде карточка придёт", async () => {
  const { boss, pc, tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura", per: "round" }]);
  pc.items.push({ type: "effect", system: { context: { origin: { actor: boss.uuid } } }, flags: { [MOD]: { immunity: { slug: "frightful-aura" } } } });
  await ev.fireNear("turn-end", tBoss, tPc, END(1));
  assert.equal(created.length, 0);
  pc.items.length = 0;
  await ev.fireNear("turn-end", tBoss, tPc, END(1, 2));
  assert.equal(created.length, 1);
});

/* ---------- nearTurn / onMoveToken / геометрия ---------- */

const cbt = (tPc) => ({ id: "cb", token: tPc });
const enc = (round, turn, previous) => ({ id: `C${cid}`, round, turn, previous });

test("nearTurn turn-end: ключ окна — раунд/ход закончившегося хода (previous); последний по инициативе остаётся в раунде R", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura", per: "round" }]);
  await ev.nearTurn("turn-end", cbt(tPc), enc(3, 0, { combatantId: "cb", round: 2, turn: 1 }));   // бой уже в раунде 3
  assert.equal(created.length, 1);
  await ev.fireNear("turn-end", tBoss, tPc, END(2, 1));   // то же окно (раунд 2) — повтора нет
  assert.equal(created.length, 1);
  assert.ok(created[0].flags[MOD].use.state.event.startsWith(`trg:C${cid}:2:`));
  await ev.nearTurn("turn-end", cbt(tPc), enc(4, 0, { combatantId: "cb", round: 3, turn: 1 }));
  assert.equal(created.length, 2);
});

test("nearTurn + onMoveToken: вход в свой ход и конец того же хода (per:turn) — один ключ; бой ищется без scene, по участникам", async () => {
  const { tPc } = stage([{ on: "enter", aura: "frightful-aura", per: "turn" }, { on: "turn-end", aura: "frightful-aura", per: "turn" }]);
  game.combats = [{ id: `C${cid}`, started: true, round: 2, turn: 1, combatants: [{ tokenId: "p1", sceneId: "s" }] }];   // без scene
  await ev.onMoveToken(tPc, { id: `m${cid}`, method: "api", origin: { x: 1500, y: 0 }, destination: { x: 300, y: 0 } });
  assert.equal(created.length, 1);
  assert.ok(created[0].flags[MOD].use.state.event.startsWith(`trg:C${cid}:2:1:`));
  await ev.nearTurn("turn-end", cbt(tPc), enc(2, 2, { combatantId: "cb", round: 2, turn: 1 }));
  assert.equal(created.length, 1);   // ключи совпали
  await ev.nearTurn("turn-end", cbt(tPc), enc(2, 2, { combatantId: "other", round: 2, turn: 1 }));   // previous чужой — берём текущие (2:2)
  assert.equal(created.length, 2);
});

test("auraFeet: диагонали как measureDistanceOnGrid pf2e", () => {
  const f = (x, y) => aura.auraFeet(sq(0, 0), sq(x, y));
  assert.deepEqual([f(1, 0), f(1, 1), f(2, 2), f(4, 2), f(6, 2), f(4, 4)], [5, 5, 15, 25, 35, 30]);
});

test("onMoveToken: проход насквозь — вход; обход мимо, стена и скрытая жертва — нет", async () => {
  const { tPc } = stage([{ on: "enter", aura: "frightful-aura" }]);
  tPc.x = 1500;   // встал снаружи на другой стороне
  await ev.onMoveToken(tPc, { id: `a${cid}`, method: "api", origin: { x: -1500, y: 0 }, destination: { x: 1500, y: 0 } });
  assert.equal(created.length, 1);
  await ev.onMoveToken(tPc, { id: `b${cid}`, method: "api", origin: { x: -1500, y: 1500 }, destination: { x: 1500, y: 1500 } });   // далеко от ауры
  assert.equal(created.length, 1);
  await ev.onMoveToken(tPc, { id: `c${cid}`, method: "api", origin: { x: 1500, y: 0 }, destination: { x: -1500, y: 0 }, passed: { waypoints: [{ x: 0, y: 1500 }] } });   // путь через угол мимо ауры
  assert.equal(created.length, 1);
  tPc.hidden = true;
  await ev.onMoveToken(tPc, { id: `d${cid}`, method: "api", origin: { x: -1500, y: 0 }, destination: { x: 1500, y: 0 } });
  tPc.hidden = false;
  assert.equal(created.length, 1);
  globalThis.canvas = { scene };
  const tc = CONFIG.Canvas.polygonBackends.move.testCollision;
  CONFIG.Canvas.polygonBackends.move.testCollision = () => true;
  try {
    await ev.onMoveToken(tPc, { id: `e${cid}`, method: "api", origin: { x: -1500, y: 0 }, destination: { x: 1500, y: 0 } });
  } finally { CONFIG.Canvas.polygonBackends.move.testCollision = tc; delete globalThis.canvas; }
  assert.equal(created.length, 1);
});

test("fireNear turn-end: стена между центрами — не внутри", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura" }]);
  globalThis.canvas = { scene };
  const tc = CONFIG.Canvas.polygonBackends.move.testCollision;
  CONFIG.Canvas.polygonBackends.move.testCollision = () => true;
  try { await ev.fireNear("turn-end", tBoss, tPc, END(1)); } finally { CONFIG.Canvas.polygonBackends.move.testCollision = tc; }
  assert.equal(created.length, 0);
  await ev.fireNear("turn-end", tBoss, tPc, END(2));
  delete globalThis.canvas;
  assert.equal(created.length, 1);
});

test("fireNear turn-end: скрытая жертва не стреляет", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura" }]);
  tPc.hidden = true;
  await ev.fireNear("turn-end", tBoss, tPc, END(1));
  assert.equal(created.length, 0);
});

test("fireNear: не активный ГМ молчит", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura" }]);
  game.user.isActiveGM = false;
  await ev.fireNear("turn-end", tBoss, tPc, END(1));
  game.user.isActiveGM = true;
  assert.equal(created.length, 0);
});

/* ---------- привязка к клеткам, высота, существо, who, источник ауры ---------- */

const grid = { size: 100, distance: 5 };
const doc = (o) => ({ parent: { grid }, width: 1, height: 1, elevation: 0, ...o });

test("rectOf: x/y — floor, w/h — ceil (как snapBounds pf2e); токен меньше клетки занимает клетку центра", () => {
  assert.deepEqual(aura.rectOf(doc({ x: 130, y: 270, width: 1.2, height: 2 })), { x: 1, y: 2, w: 2, h: 2, z: 0, d: 2 });
  assert.deepEqual(aura.rectOf(doc({ x: 250, y: 0, width: 0.5, height: 0.5 })), { x: 2, y: 0, w: 1, h: 1, z: 0, d: 1 });   // центр 275 -> клетка 2
  assert.deepEqual(aura.rectOf(doc({ x: 80, y: 0, width: 0.5, height: 0.5 })), { x: 1, y: 0, w: 1, h: 1, z: 0, d: 1 });    // центр 105 -> клетка 1
  assert.equal(aura.rectOf(doc({ x: 0, y: 0, elevation: 30 })).z, 6);
});

test("pathRects: промежуточные точки пути привязаны к клеткам", () => {
  const rs = aura.pathRects(doc({ x: 0, y: 0 }), { origin: { x: 0, y: 0 }, destination: { x: 250, y: 0 } });
  assert.deepEqual(rs.map((r) => r.x), [0, 0, 1, 2]);   // 125 -> клетка 1, 250 -> 2
});

test("auraFeet: высота — как dz measureDistanceCuboid; вертикальное перекрытие не добавляет расстояния", () => {
  const at = (z, d = 1) => ({ ...sq(1, 0), z, d });
  assert.equal(aura.auraFeet(sq(0, 0), at(0)), 5);
  assert.equal(aura.auraFeet({ ...sq(0, 0), z: 0, d: 2 }, at(1)), 5);   // отрезки [0,2] и [1,2] пересекаются
  assert.equal(aura.auraFeet(sq(0, 0), at(6)), 30);                      // 6 клеток выше: floor(1.75 + 5) = 6 шагов
  assert.equal(aura.insideAura(20, sq(0, 0), at(6)), false);
  assert.equal(aura.insideAura(30, sq(0, 0), at(6)), true);
});

test("fireNear: носитель 2×2 и крошечная жертва; высота жертвы выводит её из ауры", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", range: 10 }]);
  tBoss.width = tBoss.height = 2;      // занимает клетки 0..1
  tPc.x = 300;                          // зазор 1 клетка = 10 фт
  await ev.fireNear("turn-end", tBoss, tPc, END(1));
  assert.equal(created.length, 1);
  tPc.x = 400;                          // зазор 2 клетки = 15 фт
  await ev.fireNear("turn-end", tBoss, tPc, END(2));
  assert.equal(created.length, 1);
  tPc.x = 250; tPc.width = tPc.height = 0.5;   // крошка: клетка центра (275) = 2, зазор 0 = 5 фт
  await ev.fireNear("turn-end", tBoss, tPc, END(3));
  assert.equal(created.length, 2);
  tPc.elevation = 30;                   // 30 фт выше: 30 фт > 10
  await ev.fireNear("turn-end", tBoss, tPc, END(4));
  assert.equal(created.length, 2);
});

test("fireNear: жертва не существо (isOfType) — карточки нет; существо — есть", async () => {
  const { pc, tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura" }]);
  pc.isOfType = (t) => t === "vehicle";
  await ev.fireNear("turn-end", tBoss, tPc, END(1));
  assert.equal(created.length, 0);
  pc.isOfType = (t) => t === "creature";
  await ev.fireNear("turn-end", tBoss, tPc, END(2));
  assert.equal(created.length, 1);
});

test("fireNear who:enemy: нейтральный против враждебного носителя — не враг; против дружественного — враг", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura" }]);
  tPc.disposition = 0;
  await ev.fireNear("turn-end", tBoss, tPc, END(1));
  assert.equal(created.length, 0);
  tBoss.disposition = 1;
  await ev.fireNear("turn-end", tBoss, tPc, END(2));
  assert.equal(created.length, 1);
});

test("nearRadius: аура берётся с документа токена раньше отрисовщика", () => {
  const doc30 = { auras: new Map([["a", { radius: 30 }]]), object: { auras: new Map([["a", { radius: 10 }]]) } };
  assert.equal(aura.nearRadius({ aura: "a" }, doc30), 30);
  assert.equal(aura.nearRadius({ aura: "a" }, { auras: new Map([["a", { radius: 20 }]]) }), 20);
  assert.equal(aura.nearRadius({ aura: "a" }, { object: { auras: new Map([["a", { radius: 10 }]]) } }), 10);
});

test("fireNear turn-end на просматриваемой сцене: решает containsToken ауры pf2e; вне холста — своя геометрия", async () => {
  const { tBoss, tPc } = stage([{ on: "turn-end", aura: "frightful-aura" }]);
  let inside = false;
  tBoss.auras = new Map([["frightful-aura", { radius: 30, containsToken: (t) => t.id === "p1" && inside }]]);
  globalThis.canvas = { scene };
  try {
    await ev.fireNear("turn-end", tBoss, tPc, END(1));   // геометрия говорит «внутри», аура pf2e — нет (стена/высота)
    assert.equal(created.length, 0);
    inside = true;
    await ev.fireNear("turn-end", tBoss, tPc, END(2));
    assert.equal(created.length, 1);
  } finally { delete globalThis.canvas; }
  await ev.fireNear("turn-end", tBoss, tPc, END(3));     // сцена не просматривается: своя геометрия
  assert.equal(created.length, 2);
});

test("nearTurn: конец хода берёт раунд из запомненного начала хода, даже если previous ложный или пуст", async () => {
  const { tPc } = stage([{ on: "turn-end", aura: "frightful-aura", per: "round" }, { on: "enter", aura: "frightful-aura", per: "round" }]);
  game.combats = [{ id: `C${cid}`, started: true, round: 2, turn: 1, combatants: [{ tokenId: "p1" }] }];
  await ev.onMoveToken(tPc, { id: `m${cid}`, method: "api", origin: { x: 1500, y: 0 }, destination: { x: 300, y: 0 } });
  assert.equal(created.length, 1);
  await ev.nearTurn("turn-start", cbt(tPc), enc(2, 1));
  await ev.nearTurn("turn-end", cbt(tPc), enc(3, 0, { combatantId: "other", round: 3, turn: 0 }));   // previous чужой
  assert.equal(created.length, 1);   // окно раунда 2 то же, что у входа
});
