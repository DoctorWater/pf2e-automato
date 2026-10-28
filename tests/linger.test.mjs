// Lingering Composition: onEvent.check (проверка владельца после сотворения), extendEffect {cast:true}, refundFocus, afterUse для spell-cast.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const { ruleToForm, formToRule, blankEvent, ruleUuids } = await import("../scripts/sheet.mjs");
const { roundTrip } = await import("../tools/validate.mjs");

const validate = rules.validateRule;
const EFF = "Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ";
const one = (e) => validate({ v: 1, onEvent: [e] });

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = [];
});

const mkEffect = (o = {}) => {
  const e = {
    type: "effect", id: o.id ?? "e1", uuid: `Actor.${o.actor ?? "hero"}.Item.${o.id ?? "e1"}`, slug: o.slug ?? "panache", name: o.slug ?? "panache", _stats: { compendiumSource: o.src ?? EFF }, flags: {},
    system: { duration: o.duration ?? { value: 1, unit: "minutes", expiry: null }, badge: null, context: { origin: { actor: o.origin ?? "Actor.hero" } } }, deleted: false,
    toObject() { return { name: this.name, type: "effect", system: structuredClone(this.system), _id: this.id, flags: structuredClone(this.flags) }; },
    async delete() { this.deleted = true; this.actor.items = this.actor.items.filter((x) => x !== this); this.actor.itemTypes.effect = this.actor.itemTypes.effect.filter((x) => x !== this); },
    async update(d) { for (const [k, v] of Object.entries(d)) setDeep(this, k, v); }
  };
  return e;
};
// feat-носитель: правило лежит во флаге предмета (itemFlagRule)
const mkFeat = (slug, rule, id = slug) => ({ type: "feat", id, uuid: `Actor.owner.Item.${id}`, name: slug, slug, system: {}, flags: { [MOD]: { rule } } });
const mkActor = (uuid, items = []) => {
  const a = { uuid, name: uuid, id: uuid.split(".").pop(), level: 5, attributes: {}, items, itemTypes: { condition: [], effect: items.filter((i) => i.type === "effect") }, rollOptions: {}, getActiveTokens: () => [], getRollOptions: () => [], getSelfRollOptions: (p) => [`${p}:test`] };
  a.restored = 0;
  a.createEmbeddedDocuments = async (_t, docs) => docs.map((d) => { a.restored++; const e = mkEffect({ id: `n${a.restored}`, slug: d.system?.slug ?? d.name, actor: a.id }); e.system = d.system; e.actor = a; e.parent = a; a.items.push(e); a.itemTypes.effect.push(e); uuids.set(e.uuid, e); return e; });
  for (const i of items) { i.actor = a; i.parent = a; uuids.set(i.uuid, i); }
  uuids.set(uuid, a);
  return a;
};
const mkMsg = (id, pf2e, extra = {}) => {
  const m = { id, flags: { pf2e }, rolls: [], async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); }, ...extra };
  msgs.set(id, m);
  return m;
};

const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const { queue } = await import("../scripts/util.mjs");
const { checkDcOf } = await import("../scripts/checks.mjs");
const { levelDc } = await import("../scripts/cast.mjs");
const { stepText } = await import("../scripts/chat.mjs");
const { blankRow } = await import("../scripts/sheet.mjs");
const fs = await import("node:fs");

const LING = "Compendium.pf2e.spells-srd.Item.irTdhxTixU9u9YUm";
const catalog = JSON.parse(fs.readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8"));
const lingRule = () => validate(structuredClone(catalog.bySource[LING])).rule;
const NOW = 1_700_000_000_000;

/* ---------- схема ---------- */

test("каталог: правило Lingering валидно, ключ — uuid заклинания, round-trip Мастерской сохраняет check", () => {
  const v = validate(structuredClone(catalog.bySource[LING]));
  assert.deepEqual(v.errors, []);
  assert.equal(v.rule.onEvent[0].afterUse, true);
  assert.deepEqual(v.rule.onEvent[0].check.dc, { ofTargets: "level" });
  const back = validate(formToRule(ruleToForm(v.rule)));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.rule.onEvent[0].check, v.rule.onEvent[0].check);
});

test("validateRule: check — только spell-cast с afterUse, без challenge; dc только ofTargets:level; шаги только на владельца; move from:point нельзя", () => {
  const e = (x = {}) => ({ on: "spell-cast", afterUse: true, check: { statistic: "performance", dc: { ofTargets: "level" }, byDegree: { success: [{ extendEffect: { cast: true, rounds: 2 } }] } }, ...x });
  assert.equal(one(e()).ok, true);
  assert.equal(one(e({ afterUse: false })).ok, false);
  assert.equal(one(e({ on: "attack-roll" })).ok, false);
  assert.equal(one(e({ challenge: { statistic: "will", dc: { value: 20 }, byDegree: {} } })).ok, false);
  assert.equal(one(e({ check: { statistic: "performance", dc: { ofTargets: "will" }, byDegree: {} } })).ok, false);   // Fortissimo не делаем
  assert.equal(one(e({ check: { statistic: "performance", dc: { value: 20 }, byDegree: {} } })).ok, false);
  assert.equal(one(e({ check: { statistic: "", dc: { ofTargets: "level" } } })).ok, false);
  assert.equal(one(e({ check: { statistic: "performance", dc: { ofTargets: "level" }, byDegree: { success: [{ to: "target", note: "x" }] } } })).ok, false);
  assert.equal(one(e({ check: { statistic: "performance", dc: { ofTargets: "level" }, byDegree: { success: [{ move: { mode: "push", distance: 5, from: "point" } }] } } })).ok, false);
  assert.equal(one({ on: "spell-cast", afterUse: true, check: { statistic: "performance", dc: { ofTargets: "level" } } }).ok, true);   // check без шагов — не пустая запись
});

test("extendEffect: slug или cast:true (не оба), refundFocus — только владельцу; форма и текст шага", () => {
  const step = (a) => validate({ v: 1, onUse: { targets: "self", apply: [a] } });
  const inCheck = (a) => one({ on: "spell-cast", afterUse: true, check: { statistic: "performance", dc: { ofTargets: "level" }, byDegree: { success: [a] } } });
  assert.deepEqual(inCheck({ extendEffect: { cast: true, rounds: 2 } }).rule.onEvent[0].check.byDegree.success, [{ to: "self", extendEffect: { cast: true, rounds: 2 } }]);
  assert.equal(step({ extendEffect: { cast: true, rounds: 2 } }).ok, false);   // cast:true — только внутри onEvent.check.byDegree
  assert.equal(one({ on: "spell-cast", afterUse: true, apply: [{ extendEffect: { cast: true, rounds: 2 } }] }).ok, false);
  assert.deepEqual(step({ extendEffect: { slug: "a", rounds: 1 } }).rule.onUse.apply[0].extendEffect, { slug: "a", rounds: 1 });
  for (const bad of [{ extendEffect: { cast: true, slug: "a", rounds: 1 } }, { extendEffect: { cast: false, rounds: 1 } }, { extendEffect: { cast: true } }, { extendEffect: { rounds: 1 } }, { refundFocus: false }, { to: "target", refundFocus: true }, { refundFocus: true, note: "x" }]) assert.equal(inCheck(bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(step({ refundFocus: true }).rule.onUse.apply, [{ to: "self", refundFocus: true }]);
  const row = (r) => formToRule({ kind: "onUse", targets: "self", apply: [{ ...blankRow(), to: "self", ...r }], macros: [] });
  assert.deepEqual(row({ kind: "extendEffect", text: "*", value: "2" }).onUse.apply[0].extendEffect, { cast: true, rounds: 2 });   // «*» вместо slug = cast:true
  assert.deepEqual(row({ kind: "refundFocus" }).onUse.apply[0], { to: "self", refundFocus: true });
  const rt = validate(formToRule(ruleToForm(inCheck({ extendEffect: { cast: true, rounds: 2 } }).rule)));
  assert.deepEqual(rt.errors, []);
  const rule = step({ refundFocus: true }).rule;
  assert.deepEqual(validate(formToRule(ruleToForm(rule))).rule.onUse.apply, rule.onUse.apply);
  assert.match(stepText({ to: "self", extendEffect: { cast: true, rounds: 2 } }, { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k) }, "self"), /stepExtendCast/);
  assert.match(stepText({ to: "self", refundFocus: true }, { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k) }, "self"), /stepRefundFocus/);
});

/* ---------- связь «следующее действие» ---------- */

const M = (id, a, ts) => ({ id, flags: { pf2e: { origin: { actor: a.uuid, type: "spell", uuid: `${a.uuid}.Item.sp`, rollOptions: ["origin:action:slug:cast-a-spell"] } } }, actor: { uuid: "wrong" }, timestamp: ts });
test("strikeCardFor для spell-cast: [L,cast] — карточка; [L,Удар,cast], [L,другая карточка,cast], [L,cast,cast] — обрыв; граница хода; чужой актёр не мешает", () => {
  const A = { uuid: "Actor.a" }, B = { uuid: "Actor.b" };
  const item = { uuid: "Actor.a.Item.ling", slug: "lingering-composition" };
  const L = { ...M("L", A, NOW), flags: { pf2e: { origin: { actor: A.uuid, type: "spell", uuid: item.uuid, rollOptions: ["origin:action:slug:cast-a-spell"] } } } };
  const cast = (id, ts = NOW + 1000) => M(id, A, ts);
  const atk = (id, a = A, ts = NOW + 500) => ({ ...M(id, a, ts), flags: { pf2e: { origin: { actor: a.uuid, type: "weapon", rollOptions: [] }, context: { type: "attack-roll" } } } });
  const slugOf = (m) => (m.id === "L" ? "lingering-composition" : "other");
  const f = (before, m, opts = {}) => ev.strikeCardFor(before, m, item, { slugOf, ...opts });
  assert.equal(f([L], cast("C")), L);                                     // сама карточка Lingering связь не рвёт
  assert.equal(f([L, atk("S")], cast("C")), null);                        // Удар между ними
  assert.equal(f([L, M("X", A, NOW + 400)], cast("C")), null);            // другая карточка
  assert.equal(f([L, cast("C1", NOW + 500)], cast("C2")), null);          // одна карточка = одна проверка
  assert.equal(f([L, atk("S", B)], cast("C")), L);                        // бросок другого актёра ленту не рвёт
  assert.equal(f([L, M("pre", B, NOW + 100)], cast("C"), { stopId: "pre" }), null);   // граница хода
  assert.equal(f([M("pre", B, NOW), L], cast("C"), { stopId: "pre" }), L);
  assert.equal(f([L], cast("C", NOW + ev.AFTER_USE_MS + 1)), null);       // давность
});

test("when записи Lingering: кантрип-композиция — да; focus-композиция (Hymn), не композиция, Song of Marching — нет", () => {
  const rule = lingRule();
  const hit = (...o) => ev.matchEntries(rule, "spell-cast", "self", new Set(o)).length;
  assert.equal(hit("origin:item:trait:composition", "origin:item:trait:cantrip", "origin:item:slug:courageous-anthem"), 1);
  assert.equal(hit("origin:item:trait:composition", "origin:item:trait:focus", "origin:item:slug:hymn-of-healing"), 0);
  assert.equal(hit("origin:item:trait:cantrip", "origin:item:slug:daze"), 0);
  assert.equal(hit("origin:item:trait:composition", "origin:item:trait:cantrip", "origin:item:slug:song-of-marching"), 0);
});

/* ---------- запуск записи: один раз на сообщение, СЛ по существам ---------- */

const LVL = (n) => levelDc(n);
function bardScene({ allies = [3, 7], foes = [12], area = 60, castTargets = null } = {}) {
  game.combats = [];
  const grid = { size: 100, distance: 5, measurePath: ([a, b]) => ({ distance: (Math.hypot(a.x - b.x, a.y - b.y) / 100) * 5 }) };
  const sc = { tokens: [], grid };
  const bard = mkActor("Actor.bard", []);
  bard.level = 5; bard.isAllyOf = (o) => o.team === "pc"; bard.team = "pc"; bard.hasPlayerOwner = false;
  const mk = (id, actor, x, disposition) => { const t = { id, uuid: `Scene.s.Token.${id}`, name: id, actor, parent: sc, x, y: 0, width: 1, height: 1, disposition }; sc.tokens.push(t); uuids.set(t.uuid, t); return t; };
  const bt = mk("bt", bard, 0, 1);
  bard.getActiveTokens = () => [bt];
  const allyToks = allies.map((lv, i) => { const a = mkActor(`Actor.ally${i}`, []); a.level = lv; a.team = "pc"; a.isAllyOf = () => true; return mk(`al${i}`, a, 200 + i * 100, 1); });
  const foeToks = foes.map((lv, i) => { const a = mkActor(`Actor.foe${i}`, []); a.level = lv; a.team = "foe"; return mk(`fo${i}`, a, 300 + i * 100, -1); });
  allyToks.push(mk("far", Object.assign(mkActor("Actor.far", []), { level: 20, team: "pc" }), 5000, 1));   // вне эманации
  const ling = { type: "spell", id: "ling", uuid: "Actor.bard.Item.ling", name: "Lingering Composition", slug: "lingering-composition", system: { cast: { focusPoints: 1 } }, flags: { [MOD]: { rule: lingRule() } } };
  bard.items.push(ling); ling.actor = ling.parent = bard; uuids.set(ling.uuid, ling);
  const pick = castTargets ?? foeToks;
  const cast = (id, ts) => mkMsg(id, { origin: { actor: bard.uuid, uuid: "Actor.bard.Item.anthem", type: "spell", rollOptions: ["origin:action:slug:cast-a-spell", "origin:item:trait:composition", "origin:item:trait:cantrip", "origin:item:slug:courageous-anthem"] }, context: { type: "spell-cast", options: [] } },
    { actor: bard, token: bt, timestamp: ts, item: { system: { area: area ? { type: "emanation", value: area } : null, target: { value: "" }, range: { value: "" } } }, author: { targets: new Set(pick.map((t) => ({ document: t }))) } });
  const lcard = (id, ts) => mkMsg(id, { origin: { actor: bard.uuid, uuid: ling.uuid, type: "spell", rollOptions: ["origin:action:slug:cast-a-spell"] } }, { actor: bard, timestamp: ts });
  return { bard, bt, ling, allyToks, foeToks, cast, lcard };
}
const hosts = () => created.filter((m) => m.flags?.[MOD]?.use);
const reset = () => { created.length = 0; msgs.clear(); uuids.clear(); };

test("два выделенных врага, композиция с областью -> одна карточка проверки, СЛ по существам в эманации (союзники и бард), а не по выделенному врагу", async () => {
  const { cast, lcard } = bardScene({ allies: [3, 7], foes: [12, 12] });
  lcard("L1", NOW);
  const m = cast("C1", NOW + 1000);
  await ev.onMessage(m);
  assert.equal(hosts().length, 1);
  const use = hosts()[0].flags[MOD].use;
  assert.equal(use.dc, LVL(7));                              // враги 12 и далёкий союзник 20 не в счёт
  assert.deepEqual(use.rule.onUse.check, { statistic: "performance", vs: { dc: LVL(7) }, rollerRole: "author", basic: false, byDegree: lingRule().onEvent[0].check.byDegree });
  assert.equal(use.state.castMessage, "C1");
  assert.deepEqual(use.targets.map((t) => t.key), ["bt"]);   // бросает бард по себе
  assert.equal(m.flags[MOD].events.length, 1);
  await ev.onMessage(m);                                      // повтор сообщения — ничего
  assert.equal(hosts().length, 1);
});

test("композиция без области — СЛ по целям сотворения; нет целей — уровень барда; режим challenge=off — карточки нет", async () => {
  let s = bardScene({ area: 0, castTargets: [] });
  s.lcard("L16", NOW);
  await ev.onMessage(s.cast("C10", NOW + 1000));
  assert.equal(hosts()[0].flags[MOD].use.dc, LVL(5));        // никого — уровень барда
  reset();
  s = bardScene({ area: 0, foes: [9, 4] });
  s.lcard("L17", NOW);
  await ev.onMessage(s.cast("C11", NOW + 1000));
  assert.equal(hosts()[0].flags[MOD].use.dc, LVL(9));
  reset();
  settings["mode.challenge"] = "off";
  s = bardScene();
  s.lcard("L18", NOW);
  await ev.onMessage(s.cast("C12", NOW + 1000));
  assert.equal(hosts().length, 0);
});

test("цепочки: [L, Удар, cast] и [L, другая карточка, cast] — карточки нет; фокус-композиция (не кантрип) — нет", async () => {
  let s = bardScene();
  s.lcard("L19", NOW);
  mkMsg("S1", { origin: { actor: s.bard.uuid, type: "weapon", rollOptions: [] }, context: { type: "attack-roll", options: [] } }, { actor: s.bard, timestamp: NOW + 500 });
  await ev.onMessage(s.cast("C13", NOW + 1000));
  assert.equal(hosts().length, 0);
  reset();
  s = bardScene();
  s.lcard("L20", NOW);
  mkMsg("O1", { origin: { actor: s.bard.uuid, uuid: "Actor.bard.Item.other", type: "spell", rollOptions: ["origin:action:slug:cast-a-spell"] } }, { actor: s.bard, timestamp: NOW + 500 });
  await ev.onMessage(s.cast("C14", NOW + 1000));
  assert.equal(hosts().length, 0);
  reset();
  s = bardScene();
  s.lcard("L21", NOW);
  const dirge = s.cast("C15", NOW + 1000);
  dirge.flags.pf2e.origin.rollOptions = ["origin:action:slug:cast-a-spell", "origin:item:trait:composition", "origin:item:trait:focus"];
  await ev.onMessage(dirge);
  assert.equal(hosts().length, 0);
});

/* ---------- СЛ ---------- */

test("checkDcOf: use.dc правит только фиксированную vs.dc; защита цели — от цели", () => {
  const tgt = { saves: { will: { dc: { value: 18 } } } };
  assert.equal(checkDcOf({ dc: null }, tgt, { vs: { dc: 23 } }), 23);
  assert.equal(checkDcOf({ dc: 26, state: { dcSet: true } }, tgt, { vs: { dc: 23 } }), 26);
  assert.equal(checkDcOf({ dc: 26 }, tgt, { vs: { defense: "will" } }), 18);
});

/* ---------- шаги по степеням ---------- */

const hostMsg = (castId = "C1", id = "H1") => {
  const m = mkMsg(id, {}, { actor: null });
  m.flags[MOD] = { use: { kind: "use", actor: "Actor.bard", token: null, targets: [{ key: "bt", uuid: "Scene.s.Token.bt" }], state: { castMessage: castId }, item: { uuid: "Actor.bard.Item.ling", name: "Lingering Composition" }, rule: lingRule() } };
  return m;
};
const auraOf = (bard, castId, duration, id = "aura") => { const e = mkEffect({ id, slug: "aura-courageous-anthem", actor: "bard", duration }); e.flags[MOD] = { meta: { message: castId, key: `${castId}:self:0` } }; e.actor = e.parent = bard; bard.items.push(e); bard.itemTypes.effect.push(e); uuids.set(e.uuid, e); return e; };
const DEG = ["criticalFailure", "failure", "success", "criticalSuccess"];
const run = (m, degree) => applyOps(m, "bt", lingRule().onEvent[0].check.byDegree[DEG[degree]], { scope: "challenge", degree, total: 20 });
const withFocus = (bard, value, max) => { bard.system = { resources: { focus: { value, max } } }; bard.update = async (d) => { for (const [k, v] of Object.entries(d)) setDeep(bard, k, v); }; };

test("шаги: успех 3 раунда — продлевается аура на барде именно этого сотворения; чужие эффекты и повтор не трогаются", async () => {
  const { bard } = bardScene();
  const aura = auraOf(bard, "C1", { value: 1, unit: "rounds", expiry: "turn-start" });
  const other = auraOf(bard, "C0", { value: 1, unit: "rounds", expiry: "turn-start" }, "other");
  const m = hostMsg();
  const ops = await run(m, 2);
  assert.deepEqual(ops.map((o) => o.op), ["extended"]);
  assert.deepEqual(aura.system.duration, { value: 3, unit: "rounds", expiry: "turn-start" });
  assert.equal(other.system.duration.value, 1);
  assert.deepEqual(await run(m, 2), []);                     // повтор по ключу не удваивает
  assert.equal(aura.system.duration.value, 3);
});

test("переброс: откат возвращает срок и фокус (дельтой с порогом 0), затем новая степень применяется заново", async () => {
  const { bard } = bardScene();
  const aura = auraOf(bard, "C1", { value: 1, unit: "rounds", expiry: "turn-start" });
  withFocus(bard, 0, 1);
  const m = hostMsg();
  assert.deepEqual((await run(m, 1)).map((o) => [o.op, o.delta]), [["focus", 1]]);   // провал: ФП вернулся, срок 1 раунд
  assert.equal(bard.system.resources.focus.value, 1);
  assert.equal(aura.system.duration.value, 1);
  bard.system.resources.focus.value = 0;                      // за это время бард потратил фокус на другое
  await undoOps(m, "bt");
  assert.equal(bard.system.resources.focus.value, 0);         // дельта с порогом 0, а не «вернуть prev»
  assert.equal((await run(m, 3)).length, 1);                   // переброс — крит. успех
  assert.equal(aura.system.duration.value, 4);
  await undoOps(m, "bt");
  assert.deepEqual(aura.system.duration, { value: 1, unit: "rounds", expiry: "turn-start" });
  assert.deepEqual(aura.flags[MOD].bumped ?? [], []);
});

test("refundFocus: возвращает system.cast.focusPoints самого заклинания, не выше максимума; полный запас — пусто; нет эффекта сотворения — предупреждение и пусто", async () => {
  const { bard, ling } = bardScene();
  withFocus(bard, 0, 3);
  ling.system.cast.focusPoints = 2;
  assert.deepEqual((await run(hostMsg(), 0)).map((o) => [o.op, o.delta]), [["focus", 2]]);
  assert.equal(bard.system.resources.focus.value, 2);
  ling.system.cast.focusPoints = 2;
  assert.equal((await run(hostMsg("C1", "H2"), 1))[0].delta, 1);   // кап по максимуму
  assert.deepEqual((await run(hostMsg("C1", "H3"), 1)).map((o) => [o.op, o.delta]), [["focus", 0]]);   // уже полный: карточка отмечена нулевой дельтой
  const warns = []; ui.notifications.warn = (t) => warns.push(t);
  assert.deepEqual(await run(hostMsg("C9", "H4"), 3), []);         // эффектов сотворения C9 нет
  assert.equal(warns.length, 1);
});

test("extendEffect cast:true: эффект сотворения на цели (Allegro, Uplifting Overture) тоже продлевается", async () => {
  const { bard, allyToks } = bardScene();
  const ally = allyToks[0].actor;
  const eff = mkEffect({ id: "ae", slug: "effect-allegro", actor: "ally0", duration: { value: 1, unit: "rounds", expiry: "turn-start" } });
  eff.flags[MOD] = { meta: { message: "C1", key: "C1:t:0" } }; eff.actor = eff.parent = ally; ally.items.push(eff); ally.itemTypes.effect.push(eff); uuids.set(eff.uuid, eff);
  mkMsg("C1", {}, { actor: bard, author: { targets: new Set([{ document: allyToks[0] }]) } });
  assert.deepEqual((await run(hostMsg(), 2)).map((o) => o.op), ["extended"]);
  assert.equal(eff.system.duration.value, 3);
});

test("СЛ: use.dc перекрывает фиксированную vs.dc только при state.dcSet или castMessage; СЛ активации — нет", () => {
  const tgt = {}, ck = { vs: { dc: 23 } };
  assert.equal(checkDcOf({ dc: 30, state: {} }, tgt, ck), 23);                    // СЛ активации/сотворения не трогает vs.dc
  assert.equal(checkDcOf({ dc: 30, state: { dcSet: true } }, tgt, ck), 30);       // правка ГМа (кнопка «СЛ»)
  assert.equal(checkDcOf({ dc: 30, state: { castMessage: "C1" } }, tgt, ck), 30); // карточка проверки Lingering
});

test("Dirge of Doom (область, враги выбраны): СЛ по союзникам в эманации, текст карточки без {dc}", async () => {
  const { cast, lcard } = bardScene({ allies: [3], foes: [15] });
  lcard("L30", NOW);
  await ev.onMessage(cast("C30", NOW + 1000));
  const m = hosts()[0];
  assert.equal(m.flags[MOD].use.dc, LVL(5));                 // бард 5 и союзник 3; враг 15 не в счёт
  assert.deepEqual(m.flags[MOD].use.state.linger.length, 2);
  assert.doesNotMatch(m.content, /\{dc\}/);
});

test("гонка: продление ждёт execUse того же сообщения (эффект ставится позже), а не пропускает", async () => {
  const { bard } = bardScene();
  const m = hostMsg();
  const exec = queue("use:C1", async () => { await new Promise((r) => setTimeout(r, 40)); auraOf(bard, "C1", { value: 1, unit: "rounds", expiry: "turn-start" }); });
  const ops = await run(m, 3);
  await exec;
  assert.deepEqual(ops.map((o) => o.op), ["extended"]);
  assert.equal(bard.itemTypes.effect[0].system.duration.value, 4);
});
