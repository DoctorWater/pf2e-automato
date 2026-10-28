// oneRoll + check.when (кусок 2, No Cause for Alarm): валидатор, степени от одного броска, запоминание when, findCheckByOrigin, форма Мастерской.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MOD } from "../scripts/util.mjs";
import { validateRule } from "../scripts/rules.mjs";
import { runCheck } from "../scripts/checks.mjs";
import { acceptSavingThrow, challengeTargets, challengeApplies } from "../scripts/saves.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { readFileSync } from "node:fs";

const FEAT = "Compendium.pf2e.feats-srd.Item.6ON8DjFXSMITZleX";
const catalog = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8")).bySource[FEAT];
const ok = (raw) => { const r = validateRule(raw); assert.ok(r.ok, r.errors?.join("; ")); return r.rule; };
const withCheck = (c) => ({ v: 1, onUse: { targets: "area", check: { statistic: "diplomacy", vs: { defense: "will" }, ...c } } });

test("validateRule: oneRoll и check.when принимаются и не теряются; ошибки", () => {
  const ck = ok(withCheck({ oneRoll: true, when: ["target:condition:frightened"] })).onUse.check;
  assert.equal(ck.oneRoll, true);
  assert.deepEqual(ck.when, ["target:condition:frightened"]);
  const bad = (c, key) => { const r = validateRule(withCheck(c)); assert.ok(r.errors?.some((e) => e.key === key), `${key}: ${r.errors}`); };
  bad({ oneRoll: false }, "chk.oneRoll");
  bad({ oneRoll: true, vs: undefined, roll: "system" }, "chk.oneRoll");
  bad({ when: 5 }, "apply.when");
  assert.ok(ok(catalog).onUse.check.oneRoll);   // правило No Cause for Alarm из каталога валидно
  assert.equal(ok(catalog).onUse.check.immunity.scope, "slug");
});

test("форма Мастерской <-> правило: oneRoll, when и общий иммунитет без потерь", () => {
  const rule = ok(catalog), f = ruleToForm(rule);
  assert.equal(f.ck.one, true);
  assert.equal(f.ck.when, "target:condition:frightened");
  assert.equal(f.ck.imm.any, true);
  assert.deepEqual(validateRule(formToRule(f)).rule, rule);
  f.ck.one = false; f.ck.when = "";
  const plain = validateRule(formToRule(f)).rule.onUse.check;
  assert.equal(plain.oneRoll, undefined); assert.equal(plain.when, undefined);
});

/* ---------- рантайм ---------- */

const settings = {};
let msgs, uuids, rolls, frightened;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
const mkMsg = (id, over = {}) => {
  const m = { id, flags: { [MOD]: { use: { v: 1, kind: "use", confidence: "high", rule: ok(catalog), createdAt: Date.now(), actor: "Actor.o", item: { uuid: "Item.nca", name: "NCA" },
    targets: [], state: { area: { regionUuid: "Region.r", keys: ["t1", "t2", "t3"] } }, ...over } } }, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(id, m); return m;
};
const mkTok = (k, will) => {
  const actor = { name: k, uuid: `Actor.${k}`, items: [], saves: { will: { dc: { value: will } } }, getSelfRollOptions: (p) => (frightened.has(k) ? [`${p}:condition:frightened`] : []) };
  return { id: k, uuid: `tok.${k}`, name: k, actor };
};
const results = (m) => Object.fromEntries(Object.entries(m.flags[MOD].use.state.challenge?.results ?? {}).map(([k, v]) => [k, v.degree]));

beforeEach(() => {
  Object.assign(settings, { "mode.macro": "auto", "mode.apply": "button", "mode.challenge": "auto", useToolbeltTargetHelper: false, resumeMinutes: 30, "challenge.messageMode": "gmroll" });
  msgs = new Map(); rolls = []; frightened = new Set(["t1", "t2"]);
  const author = { uuid: "Actor.o", name: "Cleric", hasPlayerOwner: false, getActiveTokens: () => [],
    getStatistic: (s) => s === "diplomacy" ? { check: { roll: async (p) => { rolls.push(p); p.callback?.(null, null, { id: "rm1" }); return { degreeOfSuccess: 2, total: 22, dice: [{ results: [{ active: true, result: 10 }] }] }; } } } : null };
  uuids = new Map([["Actor.o", author], ["tok.t1", mkTok("t1", 15)], ["tok.t2", mkTok("t2", 12)], ["tok.t3", mkTok("t3", 40)], ["Item.nca", { name: "NCA" }]]);
  uuids.set("Region.r", { parent: { tokens: { get: (k) => uuids.get(`tok.${k}`) } } });
  globalThis.game = { user: { isActiveGM: true, id: "gm" }, settings: { get: (_m, k) => settings[k] }, i18n: { localize: (k) => k, format: (k) => k },
    messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } } };
  globalThis.ui = { notifications: { warn() {}, info() {} } };
  globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
  globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
});
afterEach(() => { for (const k of ["game", "ui", "fromUuid", "fromUuidSync"]) delete globalThis[k]; });

test("runCheck oneRoll: один бросок, степень по СЛ каждой испуганной цели; не испуганная не участвует", async () => {
  const m = mkMsg("M1");
  assert.deepEqual((await runCheck(m)).sort(), ["t1", "t2"]);
  assert.equal(rolls.length, 1);
  assert.deepEqual(rolls[0].dc, { value: 15, slug: "will" });   // pf2e бросает против первой цели
  assert.deepEqual(results(m), { t1: 2, t2: 3 });              // 22 vs 15 — успех, 22 vs 12 — крит. успех (разница 10)
  assert.equal(m.flags[MOD].use.state.challenge.results.t2.dc, 12);
  assert.deepEqual(await runCheck(m), []);                      // повтор — без второго броска
  assert.equal(rolls.length, 1);
});

test("when запоминается: испуг снят после броска — цели остаются в списке и в карточке; без результата — отсеиваются", async () => {
  const m = mkMsg("M2");
  await runCheck(m);
  frightened.clear();
  assert.deepEqual((await challengeTargets(m)).map((t) => t.key).sort(), ["t1", "t2"]);
  const fresh = mkMsg("M3");
  assert.deepEqual(await challengeTargets(fresh), []);
  const ch = ok(catalog).onUse.check, a = uuids.get("tok.t1").actor;
  assert.equal(challengeApplies(ch, a, "Actor.o"), false);
  assert.equal(challengeApplies(ch, a, "Actor.o", true), true);
});

test("findCheckByOrigin: игрок кликнул @Check без цели — результат у всех целей от одного итога", async () => {
  const m = mkMsg("M4");
  const roll = { id: "r1", author: { id: "ua" }, rolls: [{ total: 22, degreeOfSuccess: 2, dice: [{ results: [{ active: true, result: 10 }] }] }],
    flags: { pf2e: { origin: { uuid: "Item.nca" }, context: { type: "skill-check", actor: "o", options: ["check:statistic:diplomacy"], target: null, dc: { value: 15 } } } } };
  assert.equal((await acceptSavingThrow(roll)).ok, true);
  assert.deepEqual(results(m), { t1: 2, t2: 3 });
  // выбранная цель вне списка (не испугана) — всё равно распределяется
  const m2 = mkMsg("M5");
  roll.id = "r2"; roll.flags.pf2e.context.target = { actor: "Actor.t3", token: "tok.t3" };
  await acceptSavingThrow(roll);
  assert.deepEqual(results(m2), { t1: 2, t2: 3 });
});

/* ---------- дефекты Критика ---------- */

const immune = (k) => uuids.get(`tok.${k}`).actor.items.push({ type: "effect", system: {}, flags: { [MOD]: { immunity: { slug: "no-cause-for-alarm" } } } });
const click = (id, total, over = {}, die = 10) => ({ id, author: { id: "ua" }, rolls: [{ total, dice: [{ results: [{ active: true, result: die }] }] }],
  flags: { pf2e: { origin: { uuid: "Item.nca" }, context: { type: "skill-check", options: ["check:statistic:diplomacy"], target: null, ...over } } } });

test("переброс после иммунитета: степени пересчитываются у всех, у кого есть результат", async () => {
  const m = mkMsg("MR");
  await runCheck(m);
  immune("t1"); immune("t2");   // иммунитет выдан после первого применения (apply=auto)
  await acceptSavingThrow({ ...click("rr", 5, { isReroll: true, options: [`${MOD}:MR:t1`] }) });
  assert.deepEqual(results(m), { t1: 0, t2: 1 });   // 5 vs 15 — крит. провал; 5 vs 12 — провал
});

test("иммунная цель без результата: повторный клик её не записывает", async () => {
  const m = mkMsg("MI", { state: { area: { regionUuid: "Region.r", keys: ["t1", "t2"] } } });
  immune("t2");
  assert.equal((await acceptSavingThrow(click("c1", 22, { target: { actor: "Actor.t2", token: "tok.t2" } }))).ok, true);
  assert.deepEqual(results(m), { t1: 2 });
  assert.notEqual((await acceptSavingThrow(click("c2", 30, { target: { actor: "Actor.t2", token: "tok.t2" } })))?.ok, true);
  assert.deepEqual(results(m), { t1: 2 });
});

test("поздно испугавшаяся цель не получает кнопку и бросок", async () => {
  const m = mkMsg("ML");
  await runCheck(m);
  frightened.add("t3");
  assert.deepEqual((await challengeTargets(m)).map((t) => t.key).sort(), ["t1", "t2"]);
  assert.deepEqual(await runCheck(m, { only: "t3" }), []);
  assert.equal(rolls.length, 1);
});

test("натуральные 1/20 у неглавной цели сдвигают степень", async () => {
  const m = mkMsg("MN");
  await acceptSavingThrow(click("n1", 22, {}, 1));    // 22 vs 15 — успех, нат. 1 -> провал; 22 vs 12 — крит. успех, нат. 1 -> успех
  assert.deepEqual(results(m), { t1: 1, t2: 2 });
  const m2 = mkMsg("MN2");
  await acceptSavingThrow(click("n2", 2, {}, 20));    // 2 vs 15 — крит. провал, нат. 20 -> провал; 2 vs 12 — тоже
  assert.deepEqual(results(m2), { t1: 1, t2: 1 });
});

test("Toolbelt + challenge.when: результат цели, не подходящей под when, не пишется", async () => {
  const { acceptToolbeltSave } = await import("../scripts/saves.mjs");
  const rule = ok({ v: 1, onUse: { targets: "area", challenge: { statistic: "will", dc: { value: 20 }, when: ["target:condition:frightened"], byDegree: {} } } });
  const m = mkMsg("MT", { rule, state: { area: { regionUuid: "Region.r", keys: ["t1", "t3"] } } });
  settings.useToolbeltTargetHelper = true;
  globalThis.game.modules = { get: () => ({ active: true }) };
  globalThis.game.toolbelt = { getToolSetting: () => true, api: { targetHelper: { getMessageTargets: () => [uuids.get("tok.t1"), uuids.get("tok.t3")] } } };
  const res = { data: { success: "failure", value: 10 }, message: m, roll: {} };
  await acceptToolbeltSave({ ...res, target: uuids.get("tok.t3") });   // не испуган
  await acceptToolbeltSave({ ...res, target: uuids.get("tok.t1") });
  assert.deepEqual(Object.keys(m.flags[MOD].use.state.challenge?.results ?? {}), ["t1"]);
});
