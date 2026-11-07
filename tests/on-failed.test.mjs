// Переброс после провала (rule.onFailed, docs/plan-reroll.md): схема, чистые части, кандидаты, удержание/выпуск (hold.mjs), подсказка, нажатие. Без Foundry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MOD = "pf2e-automato";
globalThis.game ??= {};
globalThis.foundry ??= { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty() {}, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o), mergeObject: (a, b) => Object.assign(a, b) } };
globalThis.CONFIG ??= { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
const { validateRule, isSelfEffectOnly, initCatalog, slugOf } = await import("../scripts/rules.mjs");
const F = await import("../scripts/builtin/failed.mjs");
const hold = await import("../scripts/hold.mjs");
const { setSocket } = await import("../scripts/util.mjs");
const { ruleOfItem } = await import("../scripts/reactions.mjs");
const { ruleToForm, formToRule, carryUneditable } = await import("../scripts/sheet.mjs");

const catalog = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8"));
const HALF = "Compendium.pf2e.feats-srd.Item.ZbRVqf14RTJJIZXG";
const rule = (onFailed, extra = {}) => ({ v: 1, onFailed, ...extra });
const keys = (d) => { const r = validateRule(rule(d)); return r.ok ? [] : r.errors.map((e) => e.key); };

/* ---------- схема ---------- */

test("валидатор: defaults, несовместимость с onAttacked/onDamaged, совместимость с onUse, правило не пустое", () => {
  const ok = validateRule(rule({ who: "self" }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.rule.onFailed, { who: "self", range: null, withSelf: false, check: ["save", "skill", "perception", "attack"], degree: "fail", when: null, requires: null, keep: "new", notify: ["owner", "gm"] });
  assert.equal(validateRule(rule({ who: "ally" })).rule.onFailed.range, 30);
  assert.equal(validateRule(rule({ who: "any", range: 60, withSelf: true })).rule.onFailed.range, 60);
  assert.equal(validateRule(rule({ who: "self" }, { onUse: { targets: "self", apply: [{ to: "self", note: "x" }] } })).ok, true);
  const both = validateRule(rule({ who: "self" }, { onDamaged: { who: "self" } }));
  assert.ok(both.errors.some((e) => e.key === "rule.bothFailed"));
  assert.ok(validateRule(rule({ who: "self" }, { onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: 1 } } })).errors.some((e) => e.key === "rule.bothFailed"));
});

test("валидатор: who/range/withSelf/check/degree/when/requires/keep/notify", () => {
  assert.deepEqual(keys({ who: "any", range: 30, check: ["save", "skill"], degree: "critFail", when: ["check:statistic:will"], keep: "higher", notify: ["gm"], requires: "held" }), []);
  assert.deepEqual(keys({ who: "enemy" }), ["failed.who"]);
  assert.deepEqual(keys({ who: "self", range: 30 }), ["failed.range"]);
  assert.deepEqual(keys({ who: "ally", range: 0 }), ["failed.range"]);
  assert.deepEqual(keys({ who: "self", withSelf: true }), ["failed.withSelf"]);
  assert.deepEqual(keys({ who: "self", check: [] }), ["failed.check"]);
  assert.deepEqual(keys({ who: "self", check: ["flat"] }), ["failed.check"]);
  assert.deepEqual(keys({ who: "self", degree: "success" }), ["failed.degree"]);
  assert.deepEqual(keys({ who: "self", when: "x" }), ["apply.when"]);
  assert.deepEqual(keys({ who: "self", keep: "lower" }), ["failed.keep"]);
  assert.deepEqual(keys({ who: "self", notify: ["all"] }), ["react.notify"]);
  assert.deepEqual(keys({ who: "self", requires: "bad value" }), ["damaged.requires"]);
});

test("isSelfEffectOnly и форма Мастерской: onFailed не теряется и не считается просто selfEffect", () => {
  const fx = "Compendium.pf2e.spell-effects.Item.x";
  const r = { onUse: { challenge: null, check: null, zone: null, apply: [{ to: "self", effect: { uuid: fx } }] }, macros: [] };
  assert.equal(isSelfEffectOnly(r, fx), true);
  assert.equal(isSelfEffectOnly({ ...r, onFailed: { who: "self" } }, fx), false);
  const v = validateRule(rule({ who: "self", degree: "critFail" })).rule;
  assert.deepEqual(validateRule(formToRule(ruleToForm(v))).rule.onFailed, v.onFailed);
});

test("вкладка листа: read (carryUneditable) -> formToRule не теряет onFailed/onDamaged", () => {
  const src = validateRule({ v: 1, onDamaged: { who: "self" } }).rule, f = ruleToForm(src);
  const sheetForm = { ...f, failed: undefined, damaged: undefined, ev: [], cast: [] };   // то, что вернёт readForm(sec): этих полей в DOM нет
  assert.equal(formToRule(sheetForm).onDamaged, undefined, "без переноса флаг потерялся бы");
  assert.deepEqual(validateRule(formToRule(carryUneditable(sheetForm, f))).rule.onDamaged, src.onDamaged);
  const fail = validateRule(rule({ who: "self", degree: "critFail" })).rule, ff = ruleToForm(fail);
  assert.deepEqual(validateRule(formToRule(carryUneditable({ ...ff, failed: undefined }, ff))).rule.onFailed, fail.onFailed);
});

test("каталог: Удача полурослика — onFailed {self, save+skill, fail, new}, валидна без потерь", () => {
  const raw = catalog.bySource[HALF], v = validateRule(raw);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.rule.onFailed, { who: "self", range: null, withSelf: false, check: ["save", "skill"], degree: "fail", when: null, requires: null, keep: "new", notify: ["owner", "gm"] });
  assert.deepEqual(validateRule(v.rule).rule, v.rule);
});

/* ---------- чистые функции ---------- */

test("typeOk / degreeOk / noLuck", () => {
  assert.equal(F.typeOk(["save", "skill"], "saving-throw"), true);
  assert.equal(F.typeOk(["save", "skill"], "skill-check"), true);
  assert.equal(F.typeOk(["save", "skill"], "perception-check"), false);
  assert.equal(F.typeOk(["attack"], "spell-attack-roll"), true);
  assert.equal(F.typeOk(["attack"], "flat-check"), false);
  assert.equal(F.degreeOk("fail", "failure"), true);
  assert.equal(F.degreeOk("fail", "criticalFailure"), true);
  assert.equal(F.degreeOk("fail", "success"), false);
  assert.equal(F.degreeOk("critFail", "failure"), false);
  assert.equal(F.degreeOk("failNotCrit", "criticalFailure"), false);
  assert.equal(F.degreeOk("fail", undefined), false, "проверка без СЛ не видна");
  assert.equal(F.noLuck({ isReroll: true }), true);
  assert.equal(F.noLuck({ options: ["check:reroll"] }), true);
  assert.equal(F.noLuck({ rollTwice: "keep-higher" }), true);
  assert.equal(F.noLuck({ rollTwice: "keep-lower", options: [] }), false);
  // Уверенность: подстановка выбрана (fortune), бросок без кубов — переброс не предлагается
  assert.equal(F.noLuck({ options: [], substitutions: [{ slug: "assurance", selected: true }] }), true);
  assert.equal(F.noLuck({ options: [], substitutions: [{ slug: "assurance", selected: false }] }, { dice: [{}] }), false);
  assert.equal(F.noLuck({ options: [] }, { dice: [], isRerollable: true }), true);
  assert.equal(F.noLuck({ options: [] }), false);
});

test("knownOption: реальные опции pf2e проходят, мёртвые нет", () => {
  for (const t of ["check:statistic:will", "check:statistic:acrobatics", "check:type:saving-throw", "check:type:skill", "item:trait:mental", "origin:trait:poison", "action:grapple", "damaging-effect"]) assert.equal(F.knownOption(t), true, t);
  for (const t of ["check:outcome:failure", "trait:mental", "item:type:spell", "save:will", "self:effect:x"]) assert.equal(F.knownOption(t), false, t);
});

test("isReactionItem, isSecret, optionsOf", () => {
  assert.equal(F.isReactionItem({ system: { actionType: { value: "reaction" } } }), true);
  assert.equal(F.isReactionItem({ system: { time: { value: "reaction" } } }), true);
  assert.equal(F.isReactionItem({ system: { actionType: { value: "free" } } }), false);
  assert.equal(F.isSecret({ blind: true }), true);
  assert.equal(F.isSecret({ whisper: ["a"] }), true);
  assert.equal(F.isSecret({ flags: { pf2e: { context: { messageMode: "gm" } } } }), true);
  assert.equal(F.isSecret({ flags: { pf2e: { context: { messageMode: "roll" } } }, whisper: [] }), false);
  assert.deepEqual([...F.optionsOf({ flags: { pf2e: { context: { options: ["a"] }, origin: { rollOptions: ["origin:trait:fire"] } } } })], ["a", "origin:trait:fire"]);
});

/* ---------- стенд ---------- */

const setPath = (o, path, val) => {
  const ks = path.split("."); for (const k of ks.slice(0, -1)) o = o[k] ??= {};
  o[ks.at(-1)] = val;
};
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === "object" && !Array.isArray(v)) merge((a[k] ??= {}), v); else a[k] = v; } return a; };

function world({ author = "u1" } = {}) {
  const msgs = [], map = new Map(), calls = { reroll: [], cast: 0, spent: 0 }, deleted = [];
  const gm = { id: "gm", isGM: true, isActiveGM: true, active: true, isSelf: true }, pl = { id: "u1", isGM: false, active: true, isSelf: false };
  const users = Object.assign([gm, pl], { activeGM: gm, get: (id) => [gm, pl].find((u) => u.id === id) });
  const doc = (data) => {
    const d = { flags: {}, whisper: [], blind: false, ...data };
    d.update = async (ch) => { for (const [k, v] of Object.entries(ch)) { if (k === "flags") merge(d.flags, v); else setPath(d, k, v); } };
    d.updateSource = (ch) => merge(d, ch);
    d.delete = async () => { const i = msgs.indexOf(d); if (i >= 0) msgs.splice(i, 1); hold.noteHeldDeleted(d); deleted.push(d); };
    return d;
  };
  const message = (data) => { const m = doc({ id: `m${msgs.length + 1}`, timestamp: Date.now(), ...data }); msgs.push(m); return m; };
  globalThis.game = {
    messages: { contents: msgs, get: (id) => msgs.find((m) => m.id === id) },
    combats: [], user: gm, users, actors: { get: () => null }, scenes: { get: () => ({ tokens: { get: (id) => map.get(`Scene.S.Token.${id}`) } }) },
    settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null },
    pf2e: { Check: { rerollFromMessage: async (m, o) => { calls.reroll.push(["local", m.id, o.keep]); await m.delete(); } } }
  };
  globalThis.ui = { notifications: { info() {}, warn() {} } };
  globalThis.Hooks = { on() {}, off() {} };
  globalThis.ChatMessage = { create: async (d) => message(d), getSpeaker: () => ({}) };
  globalThis.fromUuid = async (u) => map.get(u) ?? null;
  setSocket({ executeAsUser: async (name, uid, id, keep) => { calls.reroll.push([name, uid, id, keep]); await msgs.find((m) => m.id === id)?.delete(); return true; } });
  const actor = (id, extra = {}) => {
    const a = { id, uuid: `Actor.${id}`, name: id, hitPoints: { value: 10 }, level: 3, items: [], type: "character", getFlag: () => null, setFlag: async () => { calls.spent++; }, getActiveTokens: () => [], getRollOptions: () => [], testUserPermission: (u) => !u.isGM, ...extra };
    map.set(a.uuid, a); return a;
  };
  const tokens = [];
  const token = (a, id) => { const t = { id, uuid: `Scene.S.Token.${id}`, name: a.name, actor: a, parent: { tokens } }; tokens.push(t); map.set(t.uuid, t); return t; };
  return { msgs, map, calls, deleted, message, actor, token, users, author, doc };
}

const SRC = HALF;
function mellik(w, { onFailed = { who: "self", check: ["save", "skill"] }, freq = { value: 1, max: 1 }, actionType = "free", base = {} } = {}) {
  const v = validateRule({ v: 1, onFailed, ...base });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  initCatalog([{ bySource: { [SRC]: v.rule }, bySlug: {} }], {});
  const owner = w.actor("mel"), tok = w.token(owner, "T1");
  const item = { uuid: "Actor.mel.Item.luck", name: "Удача полурослика", type: "feat", slug: "halfling-luck", system: { frequency: freq, actionType: { value: actionType } }, _stats: { compendiumSource: SRC, modifiedTime: 1 }, actor: owner, isOfType: () => false,
    toMessage: async () => { w.calls.cast++; if (item.system.frequency) item.system.frequency.value--; w.message({ content: "card" }); } };
  owner.items = [item]; w.map.set(item.uuid, item);
  return { owner, tok, item };
}
const deps = (over = {}) => ({ ruleOfItem, slugOf, reactionAvailable: () => true, requirementOf: () => null, alliesIn: () => [], ...over });
const check = (w, over = {}, extra = {}) => w.message({ speaker: { scene: "S", token: "T1", actor: "mel" }, actor: w.map.get("Actor.mel"), author: { id: w.author, isSelf: false }, flags: { pf2e: { context: { type: "saving-throw", outcome: "failure", options: ["check:statistic:will", "check:type:saving-throw"], ...over } } }, ...extra });

/* ---------- кандидаты ---------- */

test("кандидаты: self + тип + исход; провал другого типа, успех, удача уже была, нет частоты — никого", () => {
  const w = world(), r = mellik(w);
  const c = (over, env = deps()) => F.candidates(check(w, over), env);
  assert.equal(c({}).length, 1);
  assert.equal(c({}).at(0).item, r.item);
  assert.equal(c({ type: "skill-check" }).length, 1);
  assert.equal(c({ type: "attack-roll" }).length, 0);
  assert.equal(c({ outcome: "success" }).length, 0);
  assert.equal(c({ outcome: undefined }).length, 0);
  assert.equal(c({ isReroll: true }).length, 0);
  assert.equal(c({ rollTwice: "keep-higher" }).length, 0);
  r.item.system.frequency.value = 0;
  assert.equal(c({}).length, 0, "частота исчерпана");
  r.item.system.frequency.value = 1;
  r.owner.hitPoints.value = 0;
  assert.equal(c({}).length, 0);
});

test("кандидаты: when по опциям, реакция тратит реакцию владельца, союзник — по alliesIn", () => {
  const w = world(), r = mellik(w, { onFailed: { who: "self", when: ["check:statistic:fortitude"] } });
  assert.equal(F.candidates(check(w), deps()).length, 0);
  assert.equal(F.candidates(check(w, { options: ["check:statistic:fortitude"] }), deps()).length, 1);
  const w2 = world(), r2 = mellik(w2, { actionType: "reaction" });
  assert.equal(F.candidates(check(w2), deps({ reactionAvailable: () => false })).length, 0);
  assert.equal(F.candidates(check(w2), deps()).length, 1);
  // союзник: владелец — другой токен рядом, бросает friend
  const w3 = world(), r3 = mellik(w3, { onFailed: { who: "ally", range: 30 } });
  const friend = w3.actor("friend"), ft = w3.token(friend, "T2");
  const m = w3.message({ speaker: { scene: "S", token: "T2", actor: "friend" }, actor: friend, flags: { pf2e: { context: { type: "saving-throw", outcome: "failure", options: [] } } } });
  assert.equal(F.candidates(m, deps({ alliesIn: () => [friend] })).length, 1);
  assert.equal(F.candidates(m, deps({ alliesIn: () => [] })).length, 0);
  assert.equal(F.candidates(check(w3), deps()).length, 0, "who ally без withSelf: сам себя не перебрасывает");
  assert.ok(ft && r3);
});

/* ---------- удержание ---------- */

test("preCreate: кандидат есть — gate.hold = reroll; нет кандидата, уже Святилище, нет активного ГМ — не трогаем", () => {
  const w = world(); mellik(w);
  F.setDeps(deps());
  const mk = (over, extra = {}) => { const m = check(w, over, extra); w.msgs.pop(); return m; };
  const a = mk({}); F.onPreCreate(a);
  assert.equal(a.flags[MOD].gate.hold, "reroll");
  assert.equal(hold.isHeld(a), true); assert.equal(hold.isRerollHold(a), true); assert.equal(hold.isSanctuaryHold(a), false);
  const b = mk({ outcome: "success" }); F.onPreCreate(b);
  assert.equal(b.flags[MOD]?.gate, undefined);
  const s = mk({}, { flags: { [MOD]: { gate: { hold: true } }, pf2e: { context: { type: "saving-throw", outcome: "failure", options: [] } } } }); F.onPreCreate(s);
  assert.equal(s.flags[MOD].gate.hold, true, "Святилище не перебиваем");
  game.users.activeGM = null;
  const n = mk({}); F.onPreCreate(n);
  assert.equal(n.flags[MOD]?.gate, undefined);
});

test("hold: выпуск причины reroll касается только этого сообщения, Святилище той же пары остаётся; replay один раз", async () => {
  hold.replayers.clear();
  const w = world();
  const a = w.message({ actor: { uuid: "Actor.a" }, flags: { [MOD]: { gate: { hold: "reroll" } }, pf2e: { context: { target: { actor: "Actor.t" } } } } });
  const b = w.message({ actor: { uuid: "Actor.a" }, flags: { [MOD]: { gate: { hold: true } }, pf2e: { context: { target: { actor: "Actor.t" } } } } });
  let n = 0; hold.replayers.add(async (m) => { n++; assert.equal(m.id, a.id); });
  const r = await hold.resolve(a, "release");
  assert.deepEqual(r.prev, { hold: "reroll", cancelled: false });
  assert.equal(hold.isHeld(a), false); assert.equal(a.flags[MOD].gate.replayed, true);
  assert.equal(hold.isSanctuaryHold(b), true);
  assert.equal(n, 1);
  assert.equal(await hold.resolve(a, "release"), null);
  // обратное: выпуск Святилища не трогает удержание переброса
  const c = w.message({ actor: { uuid: "Actor.a" }, flags: { [MOD]: { gate: { hold: "reroll" } }, pf2e: { context: { target: { actor: "Actor.t" } } } } });
  await hold.resolve(b, "release");
  assert.equal(hold.isRerollHold(c), true);
});

test("диспетчеры: удержанная проверка (reroll) — builtin/use её не обрабатывают; events не выпускает как зависшую", async () => {
  const w = world();
  const m = w.message({ flags: { [MOD]: { gate: { hold: "reroll" } }, pf2e: { context: { type: "attack-roll" } } } });
  const { dispatchBuiltin } = await import("../scripts/builtin/index.mjs");
  assert.equal(dispatchBuiltin(m, [["x", () => assert.fail("не должен вызываться")]]), false);
  const ev = await import("../scripts/events.mjs");
  await ev.onMessage(m);
  assert.equal(hold.isRerollHold(m), true, "events.bail не выпустил удержание");
});

test("переброс удержанного: клиент автора ставит флаг rerollOf в preCreate по удалённому удержанному; обычный повтор и второй переброс — без флага", () => {
  const w = world(); hold._resetHeldGone();
  const old = check(w, {}, { flags: { [MOD]: { gate: { hold: "reroll" } }, pf2e: { context: { type: "saving-throw", outcome: "failure" } } } });
  const neu = check(w, { isReroll: true }), other = check(w, { isReroll: true });
  hold.stampHeldReroll(neu);
  assert.equal(hold.isHeldReroll(neu), false, "старое ещё не удалено");
  hold.noteHeldDeleted(old);
  hold.stampHeldReroll(neu);
  assert.equal(hold.isHeldReroll(neu), true); assert.equal(neu.flags[MOD].rerollOf, old.id);
  hold.stampHeldReroll(other);
  assert.equal(hold.isHeldReroll(other), false, "запись потреблена: второй переброс подряд — обычный повтор");
  hold.noteHeldDeleted(old);
  const plain = check(w, { type: "saving-throw" });
  hold.stampHeldReroll(plain);
  assert.equal(hold.isHeldReroll(plain), false, "не isReroll");
  hold._resetHeldGone();
  hold.noteHeldDeleted(old);
  hold.stampHeldReroll(check(w, { isReroll: true }), Date.now() + 11_000);
  const late = check(w, { isReroll: true }); hold.stampHeldReroll(late, Date.now() + 11_000);
  assert.equal(hold.isHeldReroll(late), false, "TTL");
  hold._resetHeldGone();
  const free = check(w, {}, { flags: { [MOD]: { gate: { hold: false } } } });
  hold.noteHeldDeleted(free);   // выпущенное (не удержанное) сообщение следа не оставляет
  const n2 = check(w, { isReroll: true }); hold.stampHeldReroll(n2);
  assert.equal(hold.isHeldReroll(n2), false);
});

test("settledDegree: не удержано — сразу; выпущено — степень исходного; переброшено — степень нового сообщения; старое пропало без замены — исходная после grace", async () => {
  const w = world(), o = { step: 5, grace: 30, ms: 500 };
  assert.equal(await hold.settledDegree(null, 1), 1);
  const free = check(w); assert.equal(await hold.settledDegree(free, 1, o), 1);
  const a = check(w, {}, { flags: { [MOD]: { gate: { hold: "reroll" } } } });
  setTimeout(() => { a.flags[MOD].gate.hold = false; }, 20);
  assert.equal(await hold.settledDegree(a, 1, o), 1, "выпущено");
  const b = check(w, {}, { flags: { [MOD]: { gate: { hold: "reroll" } } } });
  setTimeout(async () => { await b.delete(); w.message({ rolls: [{ options: { degreeOfSuccess: 3 } }], flags: { [MOD]: { rerollOf: b.id } } }); }, 20);
  assert.equal(await hold.settledDegree(b, 1, o), 3, "переброшено");
  const c = check(w, {}, { flags: { [MOD]: { gate: { hold: "reroll" } } } });
  setTimeout(() => c.delete(), 10);
  assert.equal(await hold.settledDegree(c, 1, o), 1, "заменой не пахнет");
  const d = check(w, {}, { flags: { [MOD]: { gate: { hold: "reroll" } } } });
  assert.equal(await hold.settledDegree(d, 0, { ...o, ms: 40 }), 0, "таймаут");
  assert.equal(hold.degreeOfMessage({ flags: { pf2e: { context: { outcome: "success" } } } }), 2);
});

test("hold.restore сохраняет причину удержания", async () => {
  const w = world(), m = w.message({ flags: { [MOD]: { gate: { hold: false, cancelled: true } } } });
  await hold.restore(m, { hold: "reroll", cancelled: false });
  assert.equal(m.flags[MOD].gate.hold, "reroll");
});

/* ---------- подсказка ---------- */

async function held(w, over = {}, mel = mellik(w)) {
  F.setDeps(deps());
  const m = check(w, over, { blind: false });
  m.flags[MOD] = { gate: { hold: "reroll" } };
  await F.onMessage(m);
  const hints = w.msgs.filter((x) => F.hintOf(x));
  return { m, hints, mel };
}

test("подсказка: шёпот владельцу и ГМу, флаг failed, кнопка с названием с листа; таймер взведён и сбрасывается", async () => {
  const w = world(), { m, hints, mel } = await held(w);
  assert.equal(hints.length, 1);
  const h = F.hintOf(hints[0]);
  assert.deepEqual([h.message, h.actor, h.item, h.state, h.keep, h.reaction], [m.id, "Actor.mel", mel.item.uuid, "pending", "new", false]);
  assert.deepEqual(hints[0].whisper.sort(), ["gm", "u1"]);
  assert.ok(hints[0].content.includes("Удача полурослика"));
  assert.ok(hints[0].content.includes('data-af-failed="use"') && hints[0].content.includes('data-af-failed="skip"'));
  assert.equal(hold.isRerollHold(m), true);
  await F.onMessage(m);   // повтор хука — без второй подсказки
  assert.equal(w.msgs.filter((x) => F.hintOf(x)).length, 1);
  await F.timeout(m.id);
});

test("тайная/слепая проверка — подсказка только ГМу; нет кандидатов (нет получателей) — выпуск сразу", async () => {
  const w = world();
  const mel = mellik(w);
  F.setDeps(deps());
  const m = check(w, { messageMode: "blind" }); m.flags[MOD] = { gate: { hold: "reroll" } };
  await F.onMessage(m);
  const hints = w.msgs.filter((x) => F.hintOf(x));
  assert.deepEqual(hints.map((x) => x.whisper), [["gm"]]);
  await F.timeout(m.id);
  assert.equal(hold.isHeld(m), false);
  // кандидат исчез между preCreate и созданием: подсказок нет -> выпуск
  mel.item.system.frequency.value = 0;
  const m2 = check(w); m2.flags[MOD] = { gate: { hold: "reroll" } };
  await F.onMessage(m2);
  assert.equal(hold.isHeld(m2), false);
});

test("«Без переброса» и таймаут: выпуск, когда решены все подсказки; поздний ответ — skipped", async () => {
  const w = world(), { m, hints } = await held(w);
  const res = await F.skipFailed(hints[0].id);
  assert.equal(res.state, "skipped");
  assert.equal(F.hintOf(hints[0]).state, "skipped");
  assert.equal(hold.isHeld(m), false);
  assert.equal(hold.isHeld(m), false);
  assert.equal((await F.skipFailed(hints[0].id)).skipped, true);
  const w2 = world(), x = await held(w2);
  await F.timeout(x.m.id);
  assert.equal(F.hintOf(x.hints[0]).state, "expired");
  assert.equal(hold.isHeld(x.m), false);
});

/* ---------- нажатие ---------- */

test("использование: переброс у автора (executeAsUser), цена после успеха, подсказка used, удержания нет; частота списана, реакция не тратится у свободного действия", async () => {
  const w = world(), { m, hints, mel } = await held(w);
  const res = await F.useFailed(hints[0].id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(w.calls.reroll, [["rerollCheck", "u1", m.id, "new"]]);
  assert.equal(w.calls.cast, 1);
  assert.equal(mel.item.system.frequency.value, 0);
  assert.equal(w.calls.spent, 0);
  assert.equal(F.hintOf(hints[0]).state, "used");
  assert.equal(game.messages.get(m.id), undefined, "старое сообщение удалено переброском");
  assert.equal((await F.useFailed(hints[0].id)).skipped, true);
});

test("использование: автор-ГМ — переброс локально; реакция тратится; остальные подсказки проверки и реакции владельца закрываются", async () => {
  const w = world({ author: "gm" }), mel = mellik(w, { actionType: "reaction", freq: null });
  const ally = w.actor("ally"), at = w.token(ally, "T3");
  ally.items = [{ ...mel.item, uuid: "Actor.ally.Item.luck", actor: ally }]; w.map.set("Actor.ally.Item.luck", ally.items[0]);
  F.setDeps(deps({ alliesIn: () => [] }));
  game.combats = [{ id: "c1", started: true, active: true, scene: true, round: 1, turn: 0, combatants: [{ actor: mel.owner, actorId: "mel" }] }];
  const m = check(w); m.flags[MOD] = { gate: { hold: "reroll" } };
  await F.onMessage(m);
  const [h1] = w.msgs.filter((x) => F.hintOf(x));
  // вторая подсказка по той же проверке от другого владельца (рукописно) и подсказка владельца по другой проверке
  const sib = w.message({ flags: { [MOD]: { failed: { ...F.hintOf(h1), actor: "Actor.ally", item: "Actor.ally.Item.luck" } } } });
  const other = w.message({ flags: { [MOD]: { failed: { ...F.hintOf(h1), message: "other", reaction: true } } } });
  const res = await F.useFailed(h1.id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(w.calls.reroll, [["local", m.id, "new"]]);
  assert.equal(w.calls.spent, 1, "реакция потрачена");
  assert.equal(F.hintOf(sib).state, "closed");
  assert.equal(F.hintOf(other).state, "skipped");
  assert.ok(at);
});

test("использование: переброс не состоялся — ничего не потрачено, подсказка снова pending, удержание держится", async () => {
  const w = world(), { m, hints, mel } = await held(w);
  setSocket({ executeAsUser: async () => true });   // автор вызвал pf2e, но тот вышел раньше (нет ресурса и т. п.), сообщение осталось
  game.pf2e.Check.rerollFromMessage = async () => {};
  const t0 = Date.now();
  const res = await F.useFailed(hints[0].id);
  assert.ok(Date.now() - t0 >= 2900, "ждали удаления");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not-rerolled");
  assert.equal(w.calls.cast, 0);
  assert.equal(mel.item.system.frequency.value, 1);
  assert.equal(F.hintOf(hints[0]).state, "pending");
  assert.equal(hold.isRerollHold(m), true);
  await F.timeout(m.id);
});

test("использование: чужой переброс (doReroll=false — сообщение уже переброшено/не удержано) — цена не списывается, даже если сообщения нет", async () => {
  const w = world(), { m, hints, mel } = await held(w);
  setSocket({ executeAsUser: async () => { await m.delete(); return false; } });   // героическое очко опередило: pf2e не вызывался
  const t0 = Date.now();
  const res = await F.useFailed(hints[0].id);
  assert.ok(Date.now() - t0 < 1000, "при false не ждём");
  assert.equal(res.reason, "not-rerolled");
  assert.equal(w.calls.cast, 0);
  assert.equal(mel.item.system.frequency.value, 1);
  // doReroll сам: сообщения нет / не удержано — false, pf2e не вызывается
  game.pf2e.Check.rerollFromMessage = async () => { assert.fail("не должен вызываться"); };
  assert.equal(await F.doReroll("nope", "new"), false);
  const free = check(w); assert.equal(await F.doReroll(free.id, "new"), false);
  await F.timeout(m.id);
});

test("использование: частота кончилась / реакция потрачена / удержание уже снято — отказ без траты", async () => {
  const w = world(), { m, hints, mel } = await held(w);
  mel.item.system.frequency.value = 0;
  let res = await F.useFailed(hints[0].id);
  assert.equal(res.ok, false); assert.equal(res.reason, "spent");
  assert.equal(F.hintOf(hints[0]).state, "pending");
  mel.item.system.frequency.value = 1;
  await hold.resolve(m, "release");   // выпущено по таймеру
  res = await F.useFailed(hints[0].id);
  assert.equal(res.ok, false); assert.equal(res.reason, "expired");
  assert.equal(F.hintOf(hints[0]).state, "expired");
  assert.equal(w.calls.cast, 0);
});

/* ---------- срок ---------- */

test("смена хода гасит подсказки прошлого хода и выпускает их проверки; ready-sweep выпускает зависшие и заводит таймер свежим", async () => {
  const w = world(), { m, hints, mel } = await held(w);
  await hints[0].update({ "flags.pf2e-automato.failed.turn": "c1:1:0" });
  await F.onCombat({ id: "c1", started: true, round: 2, turn: 0 }, { round: 2 });
  assert.equal(F.hintOf(hints[0]).state, "expired");
  assert.equal(hold.isHeld(m), false);
  // sweep: старое удержание (без подсказок) выпускается, свежее с подсказкой остаётся
  const stale = check(w); stale.flags[MOD] = { gate: { hold: "reroll" } }; stale.timestamp = Date.now() - 120_000;
  const fresh = (await held(w, {}, mel)).m;
  await F.sweep();
  assert.equal(hold.isHeld(stale), false);
  assert.equal(hold.isHeld(fresh), true);
  await F.timeout(fresh.id);
});

test("noLuck: бросок с kh/kl (isRerollable=false) не кандидат", () => {
  assert.equal(F.noLuck({}, { isRerollable: false }), true);
  assert.equal(F.noLuck({}, { isRerollable: true }), false);
  const w = world(); mellik(w);
  assert.equal(F.candidates(check(w, {}, { rolls: [{ isRerollable: false }] }), deps()).length, 0);
  assert.equal(F.candidates(check(w, {}, { rolls: [{ isRerollable: true }] }), deps()).length, 1);
});

test("onMessage: сбой при создании подсказок не оставляет проверку удержанной", async () => {
  const w = world(); mellik(w); F.setDeps(deps());
  const m = check(w); m.flags[MOD] = { gate: { hold: "reroll" } };
  const create = ChatMessage.create;
  ChatMessage.create = async () => { throw new Error("boom"); };
  const err = console.error; console.error = () => {};
  try { await F.onMessage(m); } finally { ChatMessage.create = create; console.error = err; }
  assert.equal(hold.isHeld(m), false);
});

test("sweep: зависшее «перебрасывается» гасится всегда, даже у свежей проверки", async () => {
  const w = world(), { m, hints } = await held(w);
  await hints[0].update({ "flags.pf2e-automato.failed.state": "rerolling" });
  await F.sweep();
  assert.equal(F.hintOf(hints[0]).state, "expired");
  assert.equal(hold.isHeld(m), false, "подсказок не осталось — выпуск");
});

test("удаление удержанного сообщения гасит его подсказки", async () => {
  const w = world(), { m, hints } = await held(w);
  await F.onDelete(m);
  assert.equal(F.hintOf(hints[0]).state, "expired");
});
