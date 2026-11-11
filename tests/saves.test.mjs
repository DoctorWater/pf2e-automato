// saves / macros на заглушках глобалов Foundry.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MOD, degreeFromTotal } from "../scripts/util.mjs";
import { damageMultiplier, parseMarker, dcFromEnriched, resolveDC, recordResult, acceptSavingThrow, rollSave } from "../scripts/saves.mjs";
import { runMacros } from "../scripts/macros.mjs";

const settings = {};
const macroCalls = [];
let msgs, uuids, gmNotes, origError;

const setDeep = (o, path, v) => {
  const ks = path.split("."), last = ks.pop();
  const t = ks.reduce((a, k) => (a[k] ??= {}), o);
  if (v === null && last.startsWith("-=")) delete t[last.slice(2)]; else t[last] = v;
};
function mkMessage(id, use) {
  const m = { id, flags: { [MOD]: { use } }, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(id, m);
  return m;
}
const tok = (id) => ({ id, name: `T${id}`, actor: { id: `a${id}`, name: `T${id}` } });
const baseUse = (extra = {}) => ({
  dc: 20, item: { uuid: "Item.x", name: "Дыхание" }, actor: "Actor.o", createdAt: Date.now(),
  targets: [{ key: "t1", uuid: "tok.t1" }, { key: "t2", uuid: "tok.t2" }],
  rule: { onUse: { targets: "selected", challenge: { statistic: "reflex", basic: true, dc: { value: 20 }, byDegree: {} } },
    macros: [{ uuid: "Macro.a", phase: "afterChallenge" }, { uuid: "Macro.err", phase: "onDegree", degree: "criticalFailure" }, { uuid: "Macro.a", phase: "onDegree" }] },
  state: {}, ...extra
});

beforeEach(() => {
  Object.assign(settings, { "mode.macro": "auto", "mode.apply": "button", "mode.challenge": "auto", useToolbeltTargetHelper: false, resumeMinutes: 30 });
  msgs = new Map(); gmNotes = []; macroCalls.length = 0;
  uuids = new Map([
    ["tok.t1", tok("t1")], ["tok.t2", tok("t2")],
    ["Macro.a", { name: "A", type: "script", execute: async (s) => { macroCalls.push(["a", s.phase, s.target?.id ?? null]); } }],
    ["Macro.err", { name: "E", type: "script", execute: async () => { throw new Error("boom"); } }]
  ]);
  globalThis.game = {
    user: { isActiveGM: true, id: "gm", can: () => true },
    settings: { get: (_m, k) => settings[k] },
    i18n: { localize: (k) => k, format: (k) => k },
    messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } }
  };
  globalThis.ui = { notifications: { warn: () => { gmNotes.push("warn"); } } };
  globalThis.ChatMessage = { create: async (d) => { gmNotes.push(d); }, getWhisperRecipients: () => [{ id: "gm" }] };
  globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
  globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
  origError = console.error;
  console.error = () => {};
});
afterEach(() => {
  console.error = origError;
  for (const k of ["game", "ui", "ChatMessage", "fromUuid", "fromUuidSync", "foundry"]) delete globalThis[k];
});

test("damageMultiplier: basic 0/½/1/2, не-basic null", () => {
  assert.deepEqual([3, 2, 1, 0].map((d) => damageMultiplier(d, true)), [0, 0.5, 1, 2]);
  assert.equal(damageMultiplier(2, false), null);
});

test("degreeFromTotal (util): нат.20/1 и ±10", () => {
  assert.equal(degreeFromTotal(25, 15), 3);
  assert.equal(degreeFromTotal(14, 15, 20), 2);
  assert.equal(degreeFromTotal(15, 15, 1), 1);
  assert.equal(degreeFromTotal(5, 15, 1), 0);
});

test("parseMarker", () => {
  assert.deepEqual(parseMarker(["a", `${MOD}:M1:T1`]), { messageId: "M1", tokenKey: "T1" });
  assert.equal(parseMarker(["a", "pf2e-automato:M1"]), null);
  assert.equal(parseMarker(undefined), null);
});

test("dcFromEnriched: по statistic, нечисловой dc пропускается", () => {
  const html = `<a class="inline-check" data-pf2-check="will" data-pf2-dc="18"></a>
    <a class="inline-check" data-pf2-check="reflex" data-pf2-dc="resolve(x)"></a>
    <a class="inline-check" data-pf2-check="reflex" data-pf2-dc="22"></a><a href="x" data-pf2-dc="99"></a>`;
  assert.equal(dcFromEnriched(html, "reflex"), 22);
  assert.equal(dcFromEnriched(html, "will"), 18);
  assert.equal(dcFromEnriched(html), 18);
  assert.equal(dcFromEnriched("<p>нет</p>", "will"), null);
});

test("resolveDC: use.dc > value > spell > against > markup/expr", async () => {
  const ch = (dc) => ({ rule: { onUse: { challenge: { statistic: "will", dc } } } });
  assert.equal(await resolveDC({ dc: 30, ...ch({ value: 10 }) }), 30);
  assert.equal(await resolveDC(ch({ value: 17 })), 17);
  const stat = (v) => ({ dc: { value: v } });
  const actor = { getStatistic: (s) => ({ class: stat(25), reflex: stat(21) })[s], spellcasting: { contents: [{ statistic: stat(28) }] } };
  const item = { spellcasting: { statistic: stat(33) }, system: { description: { value: "<p>@Check</p>" } } };
  assert.equal(await resolveDC(ch({ source: "spell" }), { item, actor }), 33);
  assert.equal(await resolveDC(ch({ source: "spell" }), { item: {}, actor }), 28);
  assert.equal(await resolveDC(ch({ against: "class" }), { item, actor }), 25);
  assert.equal(await resolveDC(ch({ against: "spell" }), { item: {}, actor }), 28);
  assert.equal(await resolveDC(ch({}), { item, actor }), null);
  const seen = [];
  globalThis.foundry = { applications: { ux: { TextEditor: { implementation: { enrichHTML: async (c) => {
    seen.push(c);
    return `<a class="inline-check" data-pf2-check="will" data-pf2-dc="19"></a>`;
  } } } } } };
  assert.equal(await resolveDC(ch({ expr: "markup" }), { item, actor }), 19);
  assert.equal(await resolveDC(ch({ expr: "resolve(@actor.level+10)" }), { item, actor }), 19);
  assert.equal(seen[0], "<p>@Check</p>");
  assert.equal(seen[1], "@Check[will|dc:resolve(@actor.level+10)]");
});

test("runMacros: фаза/степень, ошибка не ломает, повтор не вызывает, mode off, без права", async () => {
  const m = mkMessage("M1", baseUse());
  const rule = m.flags[MOD].use.rule;
  const T = tok("t1");
  await runMacros("afterChallenge", { message: m, rule });
  await runMacros("afterChallenge", { message: m, rule });
  assert.deepEqual(macroCalls, [["a", "afterChallenge", null]]);

  // крит. провал: сработают макрос без degree и макрос с ошибкой; ошибка записана, повтор — ничего
  const r1 = await runMacros("onDegree", { message: m, rule, target: T, degree: 0 });
  assert.equal(r1.length, 2);
  assert.equal(r1.filter((r) => !r.ok).length, 1);
  assert.equal(m.flags[MOD].use.state.macros.errors.length, 1);
  assert.deepEqual(await runMacros("onDegree", { message: m, rule, target: T, degree: 0 }), []);
  // другая степень и другая цель: только общий макрос, отдельный ключ
  const r2 = await runMacros("onDegree", { message: m, rule, target: tok("t2"), degree: 2 });
  assert.equal(r2.length, 1);
  assert.equal(m.flags[MOD].use.state.macros.done.length, 4);
  // параллельные вызовы одной фазы — один запуск
  const m2 = mkMessage("M2", baseUse());
  await Promise.all([runMacros("afterChallenge", { message: m2 }), runMacros("afterChallenge", { message: m2 })]);
  assert.equal(macroCalls.filter((c) => c[1] === "afterChallenge").length, 2);   // M1 + M2

  settings["mode.macro"] = "off";
  assert.deepEqual(await runMacros("afterChallenge", { message: mkMessage("M3", baseUse()) }), []);
  settings["mode.macro"] = "auto";
  game.user.can = () => false;
  const r3 = await runMacros("afterChallenge", { message: mkMessage("M4", baseUse()) });
  assert.equal(r3[0].ok, false);
  assert.ok(gmNotes.includes("warn"));
  // зона: без дедупа
  const zr = { macros: [{ uuid: "Macro.a", phase: "zoneEnter" }] };
  game.user.can = () => true;
  await runMacros("zoneEnter", { rule: zr, target: T });
  await runMacros("zoneEnter", { rule: zr, target: T });
  assert.equal(macroCalls.filter((c) => c[1] === "zoneEnter").length, 2);
});

test("recordResult: дубль игнор, переброс перезаписывает, после применения — changedAfterApply; afterChallenge при полном наборе", async () => {
  const m = mkMessage("M1", baseUse());
  const get = (k) => m.flags[MOD].use.state.challenge.results[k];
  assert.equal((await recordResult("M1", "t1", { degree: 1, total: 10, rollMessageId: "r1" })).ok, true);
  assert.equal((await recordResult("M1", "t1", { degree: 3, total: 30, rollMessageId: "r2" })).reason, "duplicate");
  assert.equal(get("t1").degree, 1);
  assert.equal(macroCalls.length, 0);   // t2 ещё без результата
  assert.equal((await recordResult("M1", "t1", { degree: 2, total: 16, rollMessageId: "r3", isReroll: true })).ok, true);
  assert.equal(get("t1").degree, 2);
  assert.equal(get("t1").changedAfterApply, false);
  await recordResult("M1", "t2", { degree: 0, total: 1, rollMessageId: "r4" });
  assert.deepEqual(macroCalls.map((c) => c[1]), ["afterChallenge"]);

  // применено -> переброс помечает
  m.flags[MOD].use.state.challenge.applied = { t1: { ops: [], degree: 2 } };
  const res = await recordResult("M1", "t1", { degree: 3, total: 29, rollMessageId: "r5", isReroll: true });
  assert.equal(res.changed, true);
  assert.equal(get("t1").degree, 3);
  assert.equal(get("t1").changedAfterApply, true);
  assert.equal(gmNotes.filter((n) => n.whisper).length, 1);
  assert.equal(macroCalls.length, 1);   // afterChallenge не повторился
});

test("recordResult: yielded -> игнор", async () => {
  mkMessage("M1", baseUse({ state: { yielded: "pf2e-automations" } }));
  assert.equal((await recordResult("M1", "t1", { degree: 1, total: 10 })).ok, false);
});

const stMsg = (over = {}, ctxOver = {}) => ({
  id: "S1", author: { id: "p1" }, rolls: [{ total: 22, degreeOfSuccess: 3, dice: [{ results: [{ active: true, result: 12 }] }] }],
  flags: { pf2e: { origin: { uuid: "Item.x" }, context: { type: "saving-throw", token: "t1", actor: "at1", options: ["check:statistic:reflex"], ...ctxOver } } }, ...over
});

test("acceptSavingThrow: по маркеру", async () => {
  const m = mkMessage("M1", baseUse());
  await acceptSavingThrow(stMsg({}, { options: [`${MOD}:M1:t2`] }));
  const r = m.flags[MOD].use.state.challenge.results.t2;
  assert.equal(r.degree, 3);
  assert.equal(r.src, "saving-throw");
  assert.equal(r.rollMessageId, "S1");
});

test("acceptSavingThrow: по origin-предмету + токену; чужая статистика/не-цель — мимо; свежайшее; переброс", async () => {
  const m = mkMessage("M1", baseUse());
  await acceptSavingThrow(stMsg({}, { options: ["check:statistic:will"] }));
  assert.equal(m.flags[MOD].use.state.challenge, undefined);   // другая статистика
  await acceptSavingThrow(stMsg({}, { token: "zz", actor: "zz" }));
  assert.equal(m.flags[MOD].use.state.challenge, undefined);   // не цель
  await acceptSavingThrow(stMsg());
  assert.equal(m.flags[MOD].use.state.challenge.results.t1.degree, 3);
  const newer = mkMessage("M2", baseUse());
  await acceptSavingThrow(stMsg({ id: "S2" }));
  assert.equal(newer.flags[MOD].use.state.challenge.results.t1.rollMessageId, "S2");
  assert.equal(m.flags[MOD].use.state.challenge.results.t1.rollMessageId, "S1");
  await acceptSavingThrow(stMsg({ id: "S3", rolls: [{ total: 5, degreeOfSuccess: 1, dice: [] }] }, { isReroll: true }));
  assert.equal(newer.flags[MOD].use.state.challenge.results.t1.degree, 1);
  const before = JSON.stringify(m.flags);
  await acceptSavingThrow(stMsg({}, { type: "skill-check" }));
  assert.equal(JSON.stringify(m.flags), before);
});

test("acceptSavingThrow: degreeOfSuccess нет -> по СЛ и кубу", async () => {
  const m = mkMessage("M1", baseUse());
  await acceptSavingThrow(stMsg({ rolls: [{ total: 19, dice: [{ results: [{ active: true, result: 20 }] }] }] }, { options: [`${MOD}:M1:t1`] }));
  assert.equal(m.flags[MOD].use.state.challenge.results.t1.degree, 2);   // 19 vs 20 -> провал, нат.20 -> успех
});

test("resolveDC: against = слаг класса без такой статистики у актёра -> getStatistic('class')", async () => {
  const ch = (dc) => ({ rule: { onUse: { challenge: { statistic: "reflex", dc } } } });
  const stat = (v) => ({ dc: { value: v } });
  const actor = { getStatistic: (s) => ({ class: stat(25), kineticist: stat(31) })[s] };
  assert.equal(await resolveDC(ch({ against: "kineticist" }), { item: {}, actor }), 31);
  assert.equal(await resolveDC(ch({ against: "commander" }), { item: {}, actor }), 25);
  assert.equal(await resolveDC(ch({ against: "commander" }), { item: {}, actor: { getStatistic: () => null } }), null);
});

test("low: результат при mode.apply=auto не уходит в автоприменение (autoTried не ставится), high — уходит", async () => {
  settings["mode.apply"] = "auto";
  const run = async (id, confidence) => {
    mkMessage(id, baseUse({ confidence }));
    await recordResult(id, "t1", { degree: 2, total: 25, rollMessageId: `r-${id}` });
    return !!msgs.get(id).flags[MOD].use.state.challenge.autoTried?.t1;
  };
  assert.equal(await run("L", "low"), false);
  assert.equal(await run("H", "high"), true);
});

test("rollSave: черты испытания — и в опциях броска (pf2e ищет incapacitation в опциях, не в params.traits)", async () => {
  const saved = { game: globalThis.game, ui: globalThis.ui, fromUuid: globalThis.fromUuid };
  const rolls = [];
  globalThis.game = { messages: { get: () => null }, i18n: { localize: (k) => k, format: (k) => k } };
  globalThis.ui = { notifications: { warn() {}, info() {} } };
  globalThis.fromUuid = async () => null;
  const actor = { name: "T", getActiveTokens: () => [], getStatistic: () => ({ check: { roll: async (p) => { rolls.push(p); return { degreeOfSuccess: 1, total: 10, dice: [] }; } } }) };
  try {
    await rollSave(actor, { statistic: "fortitude", traits: ["incapacitation"] }, { dc: 20 });
    assert.ok(rolls[0].extraRollOptions.includes("incapacitation"));
    assert.ok(rolls[0].extraRollOptions.includes("item:trait:incapacitation"));
    assert.deepEqual(rolls[0].traits, ["incapacitation"]);
  } finally { Object.assign(globalThis, saved); }
});

test("rollSave: options:inflicts:* правила Удара-спасбросока доходят до опций броска (бонусы героев против эффекта)", async () => {
  const { readFileSync } = await import("node:fs");
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.strike-save.json", import.meta.url), "utf8")).bySource;
  const ch = Object.values(cat).find((r) => r.label === "Paralysis").onUse.challenge;
  const saved = { game: globalThis.game, ui: globalThis.ui, fromUuid: globalThis.fromUuid };
  const rolls = [];
  globalThis.game = { messages: { get: () => null }, i18n: { localize: (k) => k, format: (k) => k } };
  globalThis.ui = { notifications: { warn() {}, info() {} } };
  globalThis.fromUuid = async () => null;
  const actor = { name: "T", getActiveTokens: () => [], getStatistic: () => ({ check: { roll: async (p) => { rolls.push(p); return { degreeOfSuccess: 1, total: 10, dice: [] }; } } }) };
  try {
    await rollSave(actor, ch, { dc: 20 });
    assert.ok(rolls[0].extraRollOptions.includes("inflicts:paralyzed"));
  } finally { Object.assign(globalThis, saved); }
});
