// Контрзаклинание (M4), шаги 1–2: таблица противодействия, поле counter записи onEvent, удержание карточки сотворения без диспетчера. Без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created, users;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
const getDeep = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  get users() { return users; },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } },
  combats: []
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: getDeep, mergeObject: (a, b) => Object.assign(a, b), escapeHTML: (s) => String(s) } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
const updates = [];
const mkDoc = (m) => Object.assign(m, { async update(d) { updates.push(d); for (const [k, v] of Object.entries(d)) { if (k.startsWith("flags.") && v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) setDeep(m, `${k}.${k2}`, v2); else setDeep(m, k, v); } }, async delete() { msgs.delete(this.id); } });
globalThis.ChatMessage = { create: async (d) => { const m = mkDoc({ id: `H${created.length + 1}`, ...d }); created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const hold = await import("../scripts/hold.mjs");
const use = await import("../scripts/use.mjs");
const saves = await import("../scripts/saves.mjs");
const { counteractOutcome } = await import("../scripts/counterspell.mjs");
const { holdPlaque } = await import("../scripts/damage-gate.mjs");
const { dispatchBuiltin } = await import("../scripts/builtin/index.mjs");
const { findCard } = await import("../scripts/builtin/basic-damage.mjs");
const maneuver = await import("../scripts/builtin/maneuver.mjs");
const variableCast = await import("../scripts/builtin/variable-cast.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const validate = rules.validateRule;

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", "mode.damageGate": "auto", "mode.zone": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = []; updates.length = 0; users = { activeGM: { id: "gm" } };
  hold.replayers.clear();
});

/** Сообщение сотворения с флагом удержания; gate — произвольное состояние флага. */
const mkCast = (id, gate, extra = {}) => { const m = mkDoc({ id, flags: { pf2e: { context: { type: "spell-cast" }, origin: { type: "spell" } }, [MOD]: { gate: structuredClone(gate) } }, rolls: [], timestamp: Date.now(), ...extra }); msgs.set(id, m); return m; };
const COUNTER = { hold: "counter" };
const CANCELLED = { hold: false, cancelled: true, counter: true };

/* ---------- шаг 1: чистое ---------- */

test("counteractOutcome: крит. провал не срывает; провал — ранг ниже контр-ранга; успех — до +1; крит. успех — до +3", () => {
  const o = (degree, counterRank, targetRank) => counteractOutcome({ degree, counterRank, targetRank });
  assert.deepEqual(o(0, 5, 1), { counteracted: false, maxRank: null });
  assert.deepEqual([o(1, 3, 2).counteracted, o(1, 3, 3).counteracted], [true, false]);
  assert.deepEqual([o(2, 3, 4).counteracted, o(2, 3, 5).counteracted], [true, false]);
  assert.deepEqual([o(3, 3, 6).counteracted, o(3, 3, 7).counteracted], [true, false]);
  assert.deepEqual([o(1, 3, 2).maxRank, o(2, 3, 1).maxRank, o(3, 3, 1).maxRank], [2, 4, 6]);
  assert.equal(o(7, 3, 1).counteracted, false, "степень вне 0..3 — не срывает");
});

const entry = (counter, extra = {}) => ({ v: 1, onEvent: [{ on: "spell-cast", side: "near", range: 30, cost: "reaction", counter, ...extra }] });
const errs = (rule) => validate(rule).errors?.map(String) ?? [];

test("валидатор counter: допустимые формы; запись без apply с cost проходит", () => {
  for (const c of [{ mod: 7, rank: 3 }, { statistic: "counteract", rank: { half: "actor" } }, { statistic: "spell-attack", rank: 2, expend: "same-spell" }, { statistic: "arcana", rank: 4, expend: "same-rank" }]) {
    const v = validate(entry(c));
    assert.equal(v.ok, true, JSON.stringify(c) + " " + errs(entry(c)).join(";"));
    assert.deepEqual(v.rule.onEvent[0].counter, c);
    assert.equal(v.rule.onEvent[0].cost, "reaction");
    assert.equal(v.rule.onEvent[0].apply, undefined);
  }
  assert.equal(validate(entry({ mod: 7, rank: 3 }, { apply: [{ to: "self", note: "x" }] })).ok, true, "шаги apply необязательны, но допустимы");
  assert.equal(validate(entry({ mod: 7, rank: 3 }, { aura: "frightful-aura", range: undefined })).ok, true, "зона — аура вместо range");
});

test("валидатор counter: только spell-cast + near + reaction, mod xor statistic, ранг обязателен, лишние ключи нет", () => {
  const bad = (rule, label) => assert.equal(validate(rule).ok, false, label);
  bad({ v: 1, onEvent: [{ on: "spell-cast", side: "self", cost: "reaction", counter: { mod: 7, rank: 3 } }] }, "side self");
  bad({ v: 1, onEvent: [{ on: "turn-start", side: "near", range: 30, cost: "reaction", counter: { mod: 7, rank: 3 } }] }, "on не spell-cast");
  bad({ v: 1, onEvent: [{ on: "spell-cast", side: "near", range: 30, counter: { mod: 7, rank: 3 } }] }, "без cost");
  bad(entry({ mod: 7 }), "без ранга");
  bad(entry({ rank: 3 }), "без mod и statistic");
  bad(entry({ mod: 7, statistic: "arcana", rank: 3 }), "и mod, и statistic");
  bad(entry({ mod: 1.5, rank: 3 }), "mod не целое");
  bad(entry({ mod: 7, rank: 0 }), "ранг 0");
  bad(entry({ mod: 7, rank: 11 }), "ранг 11");
  bad(entry({ mod: 7, rank: { half: "item" } }), "half item");
  bad(entry({ mod: 7, rank: 3, expend: "any" }), "expend вне списка");
  bad(entry({ mod: 7, rank: 3, x: 1 }), "лишний ключ");
  bad({ v: 1, onEvent: [{ on: "spell-cast", side: "near", range: 30, cost: "reaction" }] }, "near+spell-cast без counter");
  assert.ok(errs(entry({ mod: 7 })).some((e) => e.length > 0));
});

test("round-trip листа: counter едет через форму как есть, без counter — не появляется", () => {
  const rule = validate(entry({ statistic: "counteract", rank: { half: "actor" }, expend: "same-spell" })).rule;
  const back = formToRule(ruleToForm(rule));
  assert.deepEqual(back.onEvent[0].counter, rule.onEvent[0].counter);
  assert.equal(back.onEvent[0].cost, "reaction");
  assert.equal("counter" in formToRule(ruleToForm(validate({ v: 1, onEvent: [{ on: "damage-roll", apply: [{ to: "self", note: "x" }] }] }).rule)).onEvent[0], false);
  assert.equal(validate(back).ok, true);
});

/* ---------- шаг 2: удержание ---------- */

test("предикаты: counter-удержание и сорванное — одно сообщение; Святилище и переброс — не counter", () => {
  assert.deepEqual([hold.isHeld(mkCast("a", COUNTER)), hold.isCounterHold(mkCast("a", COUNTER)), hold.isCounterGate(mkCast("a", COUNTER)), hold.isSanctuaryHold(mkCast("a", COUNTER))], [true, true, true, false]);
  assert.equal(hold.isCounterGate(mkCast("b", CANCELLED)), true);
  assert.equal(hold.isCounterGate(mkCast("c", { hold: false, cancelled: true })), false, "отменённая атака — не сорванное сотворение");
  assert.equal(hold.isCounterGate(mkCast("d", { hold: true })), false);
  assert.equal(hold.isCounterGate(mkCast("e", { hold: "reroll" })), false);
  assert.equal(hold.isCounterGate(mkCast("f", { hold: false, replayed: true, cancelled: false })), false);
});

test("resolve: release -> флаги, replay один раз, повторный выпуск — ничего", async () => {
  const m = mkCast("R1", COUNTER);
  let calls = 0;
  hold.replayers.add(async (x) => { calls++; assert.equal(x, m); });
  const r = await hold.resolve(m, "release");
  assert.deepEqual(r.prev, { hold: "counter", cancelled: false });
  assert.deepEqual([hold.isHeld(m), hold.isCounterGate(m), m.flags[MOD].gate.replayed, calls], [false, false, true, 1]);
  assert.equal(await hold.resolve(m, "release"), null);
  assert.equal(calls, 1);
});

test("resolve: cancel — ничего не исполняется (replay не зовётся), сорвано; «Вернуть» (release) выпускает ровно один раз", async () => {
  const m = mkCast("R2", COUNTER);
  let calls = 0;
  hold.replayers.add(async () => { calls++; });
  await hold.resolve(m, "cancel");
  assert.deepEqual([hold.isHeld(m), hold.isCancelled(m), hold.isCounterGate(m), calls], [false, true, true, 0]);
  assert.equal(await hold.resolve(m, "cancel"), null, "повторная отмена — ничего");
  await hold.resolve(m, "release");   // «Вернуть»
  assert.deepEqual([hold.isCounterGate(m), hold.isCancelled(m), calls], [false, false, 1]);
  assert.equal(await hold.resolve(m, "release"), null);
  assert.equal(calls, 1, "после «Вернуть» — один раз");
});

test("resolve: отменённая атака (не counter) release не выпускает; counter-удержания разных сообщений не слипаются", async () => {
  const atk = mkCast("A", { hold: false, cancelled: true });
  assert.equal(await hold.resolve(atk, "release"), null);
  const a = mkCast("X1", COUNTER, { actor: { uuid: "Actor.w" } }), b = mkCast("X2", COUNTER, { actor: { uuid: "Actor.w" } });
  hold.replayers.add(async () => {});
  await hold.resolve(a, "release");
  assert.equal(hold.isCounterHold(b), true, "второе заклинание того же мага осталось удержанным");
});

test("resolveManual: кнопки ГМа — выпустить / отменить / вернуть для counter; чужие сообщения игнорируются", async () => {
  const m = mkCast("M1", COUNTER);
  let calls = 0;
  hold.replayers.add(async () => { calls++; });
  await hold.resolveManual("M1", "cancel");
  assert.equal(hold.isCounterGate(m), true);
  assert.equal(calls, 0);
  await hold.resolveManual("M1", "release");
  assert.deepEqual([hold.isCounterGate(m), calls], [false, 1]);
  assert.equal(await hold.resolveManual("M1", "release"), null);
  assert.equal(await hold.resolveManual("нет", "release"), null);
});

test("onDeleteHost: удалена карточка проверки без решения — counter-удержание выпускается", async () => {
  const m = mkCast("D1", COUNTER);
  let calls = 0;
  hold.replayers.add(async () => { calls++; });
  await hold.onDeleteHost({ flags: { [MOD]: { use: { state: { event: "D1:Actor.x.Item.y:0" } } } } });
  assert.deepEqual([hold.isHeld(m), calls], [false, 1]);
});

test("sweepCounter: зависшее удержание старше порога выпускается, свежее — остаётся; сорванное не трогается", async () => {
  const old = mkCast("S1", COUNTER, { timestamp: Date.now() - hold.COUNTER_STUCK_MS - 1000 });
  const fresh = mkCast("S2", COUNTER, { timestamp: Date.now() });
  const cancelled = mkCast("S3", CANCELLED, { timestamp: Date.now() - 999999 });
  let calls = 0;
  hold.replayers.add(async () => { calls++; });
  await hold.sweepCounter();
  assert.deepEqual([hold.isHeld(old), hold.isHeld(fresh), hold.isCounterGate(cancelled), calls], [false, true, true, 1]);
});

test("плашка: удержано — «Выпустить»/«Отменить»; сорвано — «Вернуть»; Святилище и отмена атаки — как прежде", () => {
  assert.deepEqual(holdPlaque(mkCast("P1", COUNTER)), { text: "hold.counterWaiting", buttons: ["release", "cancel"] });
  assert.deepEqual(holdPlaque(mkCast("P2", CANCELLED)), { text: "hold.counterCancelled", buttons: ["release"] });
  assert.deepEqual(holdPlaque(mkCast("P3", { hold: true })), { text: "hold.waiting", buttons: ["release", "cancel"] });
  assert.deepEqual(holdPlaque(mkCast("P4", { hold: false, cancelled: true })), { text: "hold.cancelled", buttons: [] });
});

/* ---------- потребители карточки сотворения: при удержании и срыве молчат ---------- */

test("events.onMessage: counter-удержание не обрабатывается и не «выпускается как зависшее»", async () => {
  const m = mkCast("E1", COUNTER, { actor: { uuid: "Actor.w", name: "w", items: [] }, speaker: { actor: "w" } });
  hold.replayers.add(async () => { throw new Error("replay не должен звониться"); });
  await ev.onMessage(m);
  assert.deepEqual([hold.isCounterHold(m), created.length, updates.length], [true, 0, 0]);
});

const useSnap = (rule, state = {}) => ({ kind: "use", rule, state, targets: [], item: { uuid: "Item.x", name: "Огненный шар", type: "spell" }, actor: "Actor.w", confidence: "high" });

test("use: runUse/onCreateMessage молчат при counter-удержании и срыве; после выпуска исполняется ровно один раз", async () => {
  for (const gate of [COUNTER, CANCELLED]) {
    const m = mkCast("U1", gate);
    m.flags[MOD].use = useSnap({ v: 1, onUse: { targets: "selected" } });
    await use.runUse("U1");
    await use.onCreateMessage(m);
    assert.equal(m.flags[MOD].use.state.done, undefined, `${JSON.stringify(gate)}: исполнение не стартовало`);
    assert.equal(updates.length, 0);
  }
  const m = msgs.get("U1");
  await hold.resolve(m, "release", { wait: false });
  await use.runUse("U1");
  assert.equal(m.flags[MOD].use.state.done, true, "после выпуска — исполнено");
});

test("use: runRegion и кнопки applyUse/createZone/applyDerived — отказ при counter-удержании", async () => {
  const m = mkCast("U2", COUNTER);
  m.flags[MOD].use = useSnap({ v: 1, onUse: { targets: "area", apply: [{ to: "target", condition: { slug: "frightened", value: 1 } }], zone: { duration: { seconds: 6 }, condition: { slug: "concealed" } } } });
  const region = { uuid: "Scene.s.Region.r", flags: { pf2e: { messageId: "U2" } }, parent: { tokens: { contents: [] } } };
  await use.runRegion(region, m);
  assert.equal(m.flags[MOD].use.state.area, undefined, "цели области не взяты");
  assert.equal(m.flags[MOD].use.state.zone, undefined, "зона не создана");
  assert.equal(updates.length, 0);
  for (const f of [use.applyUse, use.createZone, use.applyDerived]) await assert.rejects(Promise.resolve().then(() => f("U2", region.uuid)), /контрзаклинанием/);
});

test("saves: rollSave/runChallenge/recordResult/applyByDegree молчат при counter-удержании и срыве", async () => {
  for (const gate of [COUNTER, CANCELLED]) {
    const m = mkCast("V1", gate);
    m.flags[MOD].use = useSnap({ v: 1, onUse: { targets: "selected", challenge: { statistic: "reflex", dc: { value: 20 }, basic: true, byDegree: { failure: [{ to: "target", condition: { slug: "frightened", value: 1 } }] } } } });
    assert.equal(await saves.rollSave({ name: "a" }, m.flags[MOD].use.rule.onUse.challenge, { message: m, tokenKey: "t" }), null);
    assert.deepEqual(await saves.runChallenge(m), []);
    assert.deepEqual(await saves.recordResult("V1", "t", { degree: 1, total: 10 }), { ok: false, reason: "countered" });
    assert.deepEqual(await saves.applyByDegree("V1", "all"), []);
    assert.equal(m.flags[MOD].use.state.challenge, undefined, "результатов нет");
    assert.equal(updates.length, 0);
  }
});

test("builtin-диспетчер: при counter-удержании идёт только цена (метамагия), остальное молчит; сорванное и выпущенное — по обычным правилам", async () => {
  const seen = [];
  const hooks = [["spellshape", () => seen.push("spellshape")], ["damage-link", () => seen.push("damage-link")], ["hunt-prey", () => seen.push("hunt-prey")]];
  const wait = () => new Promise((r) => setTimeout(r, 5));
  assert.equal(dispatchBuiltin(mkCast("B1", COUNTER), hooks), true);
  await wait();
  assert.deepEqual(seen, ["spellshape"]);
  seen.length = 0;
  assert.equal(dispatchBuiltin(mkCast("B2", { hold: true }), hooks), false, "Святилище — по-прежнему всё молчит");
  await wait();
  assert.deepEqual(seen, []);
  assert.equal(dispatchBuiltin(mkCast("B3", { hold: false, replayed: true }), hooks), true);
  await wait();
  assert.deepEqual(seen, ["spellshape", "damage-link", "hunt-prey"]);
});

test("basic-damage.findCard: бросок урона не привязывается к удержанной/сорванной карточке (молча, без ближайшей старой)", () => {
  const card = (id, gate, ts) => ({ id, timestamp: ts, flags: { [MOD]: { use: { actor: "Actor.w", item: { uuid: "Item.fb" }, state: {} }, ...(gate && { gate }) } } });
  const q = { actor: "Actor.w", uuid: "Item.fb", at: 100 };
  assert.equal(findCard([card("c1", null, 10), card("c2", COUNTER, 50)], q), null);
  assert.equal(findCard([card("c1", null, 10), card("c2", CANCELLED, 50)], q), null);
  assert.equal(findCard([card("c1", null, 10), card("c2", { hold: false, replayed: true }, 50)], q).id, "c2");
});

test("maneuver.bind: при counter-удержании кнопки манёвров не строятся", () => {
  const mk = (gate) => ({ id: "MN", flags: { pf2e: { context: { type: "spell-cast" }, origin: { rollOptions: ["origin:action:slug:cast-a-spell"] } }, [MOD]: { gate } }, actor: { isOwner: true }, item: null });
  const html = { querySelector() { throw new Error("дошли до построения кнопок"); } };
  assert.throws(() => maneuver.bind(mk(null), html), /дошли/, "без удержания путь до построения открыт");
  maneuver.bind(mk(COUNTER), html);
  maneuver.bind(mk(CANCELLED), html);
});

test("variable-cast.released: не бросает снаряды при удержании, без отметки, без флага выпуска и не автору", async () => {
  const base = (gate, cast, isAuthor = true) => ({ isAuthor, flags: { [MOD]: { gate, cast }, pf2e: { origin: { uuid: "Item.mm", type: "spell" } } }, async update() { throw new Error("update не должен звониться"); } });
  const rel = { flags: { [MOD]: { gate: { replayed: true } } } };
  await variableCast.released(base(COUNTER, { actions: 2, missilesHeld: true }), rel.flags ? { flags: rel.flags } : null);   // удержано снова
  await variableCast.released(base({ hold: false, replayed: true }, { actions: 2 }), { flags: rel.flags });                  // нет отметки missilesHeld
  await variableCast.released(base({ hold: false }, { actions: 2, missilesHeld: true }), { flags: { [MOD]: { gate: { hold: false } } } });   // не выпуск
  await variableCast.released(base({ hold: false, replayed: true }, { actions: 2, missilesHeld: true }, false), { flags: rel.flags });       // не автор
});

test("events.onPreCreate: сообщение, родившееся с удержанием counter, получает noAutoDamageRoll Workbench; markCounterHold ставит оба флага", () => {
  const mk = (gate) => { const m = { flags: { [MOD]: { gate } }, updateSource(d) { setDeep(m, "x", 1); this.src = d; } }; return m; };
  const a = mk(COUNTER);
  ev.onPreCreate(a);
  assert.deepEqual(a.src.flags["xdy-pf2e-workbench"], { noAutoDamageRoll: true });
  assert.equal(a.src.flags[MOD].gate.hold, "counter");
  const b = { flags: {}, updateSource(d) { this.src = d; } };
  ev.markCounterHold(b);
  assert.equal(b.src.flags["xdy-pf2e-workbench"].noAutoDamageRoll, true);
  const c = mk({ hold: true });
  ev.onPreCreate(c);
  assert.equal(c.src, undefined, "Святилище этим путём не идёт");
});

test("lang: ключи плашки и ошибка counter есть в ru и en", async () => {
  const { readFileSync } = await import("node:fs");
  for (const l of ["ru", "en"]) {
    const j = JSON.parse(readFileSync(new URL(`../lang/${l}/events.json`, import.meta.url), "utf8")).PF2E_AUTOMATO;
    for (const k of ["restore", "counterWaiting", "counterCancelled"]) assert.ok(j.hold[k], `${l} hold.${k}`);
    assert.ok(j.rules.err.ev.counter, `${l} err.ev.counter`);
  }
});

/* ---------- доработка по замечаниям Критика ---------- */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const withHost = (castId, applied = {}) => { const h = mkDoc({ id: `host-${castId}`, flags: { [MOD]: { use: { state: { event: `${castId}:Actor.x.Item.y:0`, challenge: { applied } } } } } }); msgs.set(h.id, h); return h; };

test("sweepCounter: удержание старше resumeMinutes снимается без replay и без replayed (старое заклинание не исполняется)", async () => {
  const stale = mkCast("T1", COUNTER, { timestamp: Date.now() - 31 * 60_000 });
  let calls = 0;
  hold.replayers.add(async () => { calls++; });
  await hold.sweepCounter();
  assert.deepEqual([hold.isHeld(stale), hold.isCounterGate(stale), stale.flags[MOD].gate.replayed, calls], [false, false, undefined, 0]);
  await variableCast.released(stale, { flags: { [MOD]: { gate: { hold: false, stale: true } } } });   // доброса снарядов нет: replayed не стоит
});

test("sweepCounter: карточка проверки ждёт броска — удержание не выпускается; применена — выпускается", async () => {
  const m = mkCast("T2", COUNTER, { timestamp: Date.now() - hold.COUNTER_STUCK_MS - 1000 });
  const host = withHost("T2");
  let calls = 0;
  hold.replayers.add(async () => { calls++; });
  await hold.sweepCounter();
  assert.deepEqual([hold.isCounterHold(m), calls], [true, 0]);
  host.flags[MOD].use.state.challenge.applied = { tok: true };
  await hold.sweepCounter();
  assert.deepEqual([hold.isHeld(m), calls], [false, 1]);
});

test("armCounter: таймер при создании/откате выпускает удержание; хост ждёт — не выпускает; решение до срока гасит таймер", async () => {
  const a = mkCast("T3", COUNTER), b = mkCast("T4", COUNTER), c = mkCast("T5", COUNTER);
  withHost("T4");
  let calls = 0;
  hold.replayers.add(async () => { calls++; });
  hold.armCounter(a, 15); hold.armCounter(b, 15); hold.armCounter(c, 15);
  await hold.resolve(c, "cancel");   // решили до срока
  await wait(80);
  assert.deepEqual([hold.isHeld(a), hold.isCounterHold(b), hold.isCancelled(c), calls], [false, true, true, 1]);
  const d = mkCast("T6", { hold: true });
  hold.armCounter(d, 5);   // не counter — таймер не ставится
  await wait(30);
  assert.equal(hold.isSanctuaryHold(d), true);
});

test("recordOneRoll: по удержанной/сорванной карточке не пишет eligible и результаты", async () => {
  const { recordOneRoll } = await import("../scripts/checks.mjs");
  for (const gate of [COUNTER, CANCELLED]) {
    const m = mkCast("R1", gate);
    m.flags[MOD].use = useSnap({ v: 1, onUse: { targets: "selected", challenge: { statistic: "reflex", dc: { value: 20 } } } });
    assert.deepEqual(await recordOneRoll(m, { total: 10, key: "t" }), { ok: false, keys: [] });
    assert.equal(m.flags[MOD].use.state.challenge, undefined);
    assert.equal(updates.length, 0);
  }
});

test("variable-cast.released: две вкладки автора — доброс один (флаг снимается под очередью)", async () => {
  const m = mkCast("W1", { hold: false, replayed: true }, { isAuthor: true });
  m.flags[MOD].cast = { actions: 2, missilesHeld: true };
  m.flags.pf2e.origin = { uuid: "Item.mm", type: "spell" };
  const ch = { flags: { [MOD]: { gate: { replayed: true } } } };
  await Promise.all([variableCast.released(m, ch), variableCast.released(m, ch)]);
  assert.equal(updates.filter((u) => u[`flags.${MOD}.cast.missilesHeld`] === false).length, 1);
});

test("«Отменить»: мгновенный шаблон этого сотворения удаляется, чужой и с длительностью — остаются", async () => {
  const mkRegion = (id, messageId) => ({ id, flags: { pf2e: { messageId } }, uuid: `R.${id}`, parent: { regions: { has: () => true } }, async delete() { regs.splice(regs.findIndex((r) => r.id === id), 1); }, async update() {}, behaviors: [] });
  const regs = [mkRegion("r1", "X1"), mkRegion("r2", "other")];
  globalThis.game.scenes = { get: () => null, contents: [{ regions: { get contents() { return regs; } } }] };
  globalThis.game.actors = [];
  try {
    const m = mkCast("X1", COUNTER, { item: { system: { duration: { value: "" } } } });
    await hold.resolve(m, "cancel");
    assert.deepEqual(regs.map((r) => r.id), ["r2"]);
    regs.push(mkRegion("r3", "X2"));
    const m2 = mkCast("X2", COUNTER, { item: { system: { duration: { value: "1 minute" } } } });
    await hold.resolve(m2, "cancel");
    assert.deepEqual(regs.map((r) => r.id), ["r2", "r3"], "область с длительностью остаётся");
  } finally { delete globalThis.game.scenes; delete globalThis.game.actors; }
});

test("Мастерская: у spell-cast с counter сторона near доступна, запись переживает смену события и round-trip; без counter — нет", async () => {
  const au = await import("../scripts/workshop/automation.mjs");
  const rule = validate(entry({ statistic: "counteract", rank: { half: "actor" } })).rule;
  const f = ruleToForm(rule), e = f.ev[0];
  assert.ok(au.evSides(e).includes("near"));
  au.evOnChanged(e, "spell-cast");
  assert.equal(e.side, "near", "near не сброшена");
  const back = validate(formToRule(f));
  assert.equal(back.ok, true, (back.errors ?? []).join(";"));
  assert.deepEqual(back.rule.onEvent[0].counter, rule.onEvent[0].counter);
  assert.equal(back.rule.onEvent[0].side, "near");
  const bare = { on: "spell-cast", side: "near" };
  assert.equal(au.evSides(bare).includes("near"), false);
  au.evOnChanged(bare, "spell-cast");
  assert.equal(bare.side, "self");
  const turn = { on: "turn-start", side: "near", counter: undefined };
  au.evOnChanged(turn, "damage-roll");
  assert.equal(turn.side, "self");
});

test("валидатор: near + spell-cast без counter — одна ошибка", () => {
  const rule = { v: 1, onEvent: [{ on: "spell-cast", side: "near", range: 30, cost: "reaction", apply: [{ to: "self", note: "x" }] }] };
  const e = validate(rule).errors ?? [];
  assert.equal(e.length, 1, e.map(String).join(";"));
});
