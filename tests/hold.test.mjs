// Sanctuary (plan-sanctuary): удержание атаки (hold), шаги hold, носитель из каталога. Без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: getDeep, mergeObject: (a, b) => Object.assign(a, b) } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
const mkDoc = (m) => Object.assign(m, { async update(d) { for (const [k, v] of Object.entries(d)) { if (k.startsWith("flags.") && v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) setDeep(m, `${k}.${k2}`, v2); else setDeep(m, k, v); } }, async delete() { msgs.delete(this.id); for (const f of deleted) f(this); } });
const deleted = [];
globalThis.ChatMessage = { create: async (d) => { const m = mkDoc({ id: `H${created.length + 1}`, ...d }); created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const hold = await import("../scripts/hold.mjs");
const apply = await import("../scripts/apply.mjs");
const { allowedDamage } = await import("../scripts/damage-gate.mjs");
const { dispatchBuiltin } = await import("../scripts/builtin/index.mjs");

const validate = rules.validateRule;
const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/catalog.json", import.meta.url)), "utf8"));
const CARRIER_KEY = "Compendium.pf2e-automato.effects.Item.SnctuaryEffect01";
const CARRIER = validate(catalog.bySource[CARRIER_KEY]).rule;
const MARK = (id) => `Compendium.pf2e-automato.effects.Item.${id}`;

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", "mode.damageGate": "auto", "mode.reaction": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = []; users = { activeGM: { id: "gm" } }; deleted.length = 0;
  hold.replayers.clear();
});

const mkEffect = ({ id, slug, actor, origin = "Actor.caster", rule, by }) => {
  const e = {
    type: "effect", id, uuid: `Actor.${actor}.Item.${id}`, slug, name: slug, _stats: { compendiumSource: CARRIER_KEY }, flags: { [MOD]: { ...(rule && { rule }), ...(by && { meta: { by } }) } },
    system: { duration: { value: 1, unit: "minutes", expiry: null }, badge: null, context: { origin: { actor: origin } } }, deleted: false,
    toObject() { return { name: this.name, type: "effect", system: structuredClone(this.system), _id: this.id, flags: structuredClone(this.flags) }; },
    async delete() { this.deleted = true; this.actor.items = this.actor.items.filter((x) => x !== this); this.actor.itemTypes.effect = this.actor.itemTypes.effect.filter((x) => x !== this); uuids.delete(this.uuid); },
    async update(d) { for (const [k, v] of Object.entries(d)) setDeep(this, k, v); }
  };
  return e;
};
const mkActor = (uuid, items = [], opts = []) => {
  const a = { uuid, name: uuid, id: uuid.split(".").pop(), level: 5, attributes: {}, items, itemTypes: { condition: [], effect: items.filter((i) => i.type === "effect") }, rollOptions: {}, getActiveTokens: () => [], getRollOptions: () => [], getSelfRollOptions: (p) => (p === "self" ? [...opts, ...a.itemTypes.effect.map((e) => `self:effect:${e.slug}`)] : opts.map((o) => o.replace(/^self:/, `${p}:`))) };
  a.createEmbeddedDocuments = async () => [];
  for (const i of items) { i.actor = a; i.parent = a; uuids.set(i.uuid, i); }
  uuids.set(uuid, a);
  return a;
};
const tok = (id, actor) => { const t = { id, uuid: `Scene.s.Token.${id}`, name: id, actor }; uuids.set(t.uuid, t); actor.getActiveTokens = () => [t]; return t; };

/** Защищённый (guard) с носителем от заклинателя (caster, у которого свой посторонний эффект с тем же slug) и нападающий foe. */
function scene(foeOpts = [], foeItems = []) {
  const spell = { type: "spell", uuid: "Actor.caster.Item.sanc", name: "Sanctuary", slug: "sanctuary", system: {}, flags: {} };
  uuids.set(spell.uuid, spell);
  const casterOwn = mkEffect({ id: "cs", slug: "spell-effect-sanctuary", actor: "caster", origin: "Actor.caster" });
  const caster = mkActor("Actor.caster", [casterOwn]);
  const carrier = mkEffect({ id: "sx", slug: "spell-effect-sanctuary", actor: "guard", rule: CARRIER });
  carrier.system.context.origin.item = spell.uuid;
  const guard = mkActor("Actor.guard", [carrier]);
  const foe = mkActor("Actor.foe", foeItems, foeOpts);
  return { caster, casterOwn, carrier, guard, foe, ft: tok("ft", foe), gt: tok("gt", guard) };
}
const attackCtx = (guard, o = {}) => ({ context: { type: "attack-roll", options: [], target: { actor: guard.uuid }, ...o } });
const mkMsg = (id, pf2e, extra = {}) => { const m = mkDoc({ id, flags: { pf2e }, rolls: [], ...extra }); msgs.set(id, m); return m; };
const held = (m) => { m.flags[MOD] = { ...m.flags[MOD], gate: { hold: true } }; return m; };
const hostCard = () => created.find((c) => c.flags?.[MOD]?.use?.kind === "use");
const resolveCard = (card, degree) => {
  const byDegree = card.flags[MOD].use.rule.onUse.challenge.byDegree[["criticalFailure", "failure", "success", "criticalSuccess"][degree]];
  return apply.applyOps(card, "ft", byDegree, { scope: "challenge", degree, total: 20, msgQueued: true, target: uuids.get("Scene.s.Token.ft") });
};

/* ---------- схема, носитель, чистые функции ---------- */

test("схема: hold — только side:target на attack-roll/skill-check; шаг hold только в такой записи; end/release/cancel", () => {
  const ok = (e) => validate({ v: 1, onEvent: [e] });
  const step = { to: "self", hold: "release" };
  assert.equal(ok({ on: "attack-roll", side: "target", hold: true, apply: [step] }).ok, true);
  assert.equal(ok({ on: "skill-check", side: "target", hold: true, apply: [step] }).ok, true);
  assert.equal(ok({ on: "attack-roll", side: "self", hold: true, apply: [step] }).ok, false);
  assert.equal(ok({ on: "damage-roll", side: "target", hold: true, apply: [step] }).ok, false);
  assert.equal(ok({ on: "attack-roll", side: "target", hold: false, apply: [step] }).ok, false);
  assert.equal(ok({ on: "attack-roll", side: "target", apply: [step] }).ok, false, "шаг hold без hold у записи");
  assert.equal(ok({ on: "attack-roll", side: "target", hold: true, apply: [{ to: "self", hold: "later" }] }).ok, false);
  assert.equal(ok({ on: "attack-roll", side: "target", hold: true, apply: [{ to: "self", hold: "end" }] }).ok, true);
});

test("носитель каталога: валиден и без потерь туда-обратно; метки — effect по uuid с of:target", () => {
  const v = validate(catalog.bySource[CARRIER_KEY]);
  assert.equal(v.ok, true, String(v.errors));
  assert.deepEqual(validate(v.rule).rule, v.rule);
  const by = v.rule.onEvent[2].challenge.byDegree;
  assert.deepEqual(by.criticalSuccess.map((s) => s.hold), ["end"]);
  assert.deepEqual(by.success[0].duration, { value: 0, unit: "rounds", expiry: "turn-end", of: "target" });
  assert.deepEqual(by.criticalFailure[0].duration, { value: 1, unit: "minutes", expiry: null });
  const spell = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/catalog.json", import.meta.url)), "utf8")).bySource["Compendium.pf2e.spells-srd.Item.8xRzLhwGL7Dgy3EZ"];
  assert.equal(validate(spell).rule.onUse.apply[0].effect.uuid, MARK("SnctuaryEffect01"));
});

test("выбор записи носителя по меткам нападающего: barred/stopped -> cancel, passed -> release, ничего -> испытание; skill-check — только с attack", () => {
  const pick = (on, opts) => ev.matchEntries(CARRIER, on, "target", new Set(opts)).map(({ entry }) => entry.apply?.[0]?.hold ?? (entry.challenge ? "challenge" : "?"));
  assert.deepEqual(pick("attack-roll", []), ["challenge"]);
  assert.deepEqual(pick("attack-roll", ["origin-effect:sanctuary-passed"]), ["release"]);
  assert.deepEqual(pick("attack-roll", ["origin-effect:sanctuary-stopped"]), ["cancel"]);
  assert.deepEqual(pick("attack-roll", ["origin-effect:sanctuary-barred"]), ["cancel"]);
  assert.deepEqual(pick("attack-roll", ["origin-effect:sanctuary-passed", "origin-effect:sanctuary-stopped"]), ["cancel"]);
  assert.deepEqual(pick("skill-check", []), []);
  assert.deepEqual(pick("skill-check", ["attack"]), ["challenge"]);
  assert.deepEqual(pick("skill-check", ["attack", "origin-effect:sanctuary-barred"]), ["cancel"]);
  // конец заклинания: attack-roll и attack-проверка самого защищённого
  assert.equal(ev.matchEntries(CARRIER, "attack-roll", "self", new Set()).length, 1);
  assert.equal(ev.matchEntries(CARRIER, "skill-check", "self", new Set(["attack"])).length, 1);
  assert.equal(ev.matchEntries(CARRIER, "skill-check", "self", new Set()).length, 0);
});

test("isAttackContext: бросок атаки, заклинание, skill-check с чертой attack (строка или {name}); не save/урон/обычный навык", () => {
  assert.equal(hold.isAttackContext({ type: "attack-roll" }), true);
  assert.equal(hold.isAttackContext({ type: "spell-attack-roll" }), true);
  assert.equal(hold.isAttackContext({ type: "skill-check", traits: ["attack", "manipulate"] }), true);
  assert.equal(hold.isAttackContext({ type: "skill-check", traits: [{ name: "attack" }] }), true);
  assert.equal(hold.isAttackContext({ type: "skill-check", traits: ["concentrate"] }), false);
  assert.equal(hold.isAttackContext({ type: "skill-check" }), false);
  for (const type of ["saving-throw", "damage-roll", "perception-check"]) assert.equal(hold.isAttackContext({ type, traits: ["attack"] }), false);
});

test("allowedDamage: удержанная/отменённая атака — обе кнопки скрыты при любом исходе", () => {
  for (const d of [0, 1, 2, 3, null]) assert.deepEqual(allowedDamage(d, true), { success: false, "critical-success": false });
  assert.deepEqual(allowedDamage(3, false), { success: false, "critical-success": true });
});

/* ---------- preCreateChatMessage ---------- */

const pre = (flags) => { const src = { flags }; return { flags, updateSource: (d) => { src.d = d; }, src }; };

test("preCreate: удержание и noAutoDamageRoll — только при активном ГМе, рабочих режимах и атаке по цели с носителем", () => {
  const { guard } = scene();
  const run = (flags) => { const m = pre(flags); ev.onPreCreate(m); return m.src.d?.flags ?? null; };
  const atk = { pf2e: { context: { type: "attack-roll", target: { actor: guard.uuid } } } };
  assert.deepEqual(run(atk), { [MOD]: { gate: { hold: true } }, "xdy-pf2e-workbench": { noAutoDamageRoll: true } });
  assert.notEqual(run({ pf2e: { context: { type: "skill-check", traits: ["attack"], target: { actor: guard.uuid } } } }), null, "Подсечка");
  assert.equal(run({ pf2e: { context: { type: "skill-check", traits: [], target: { actor: guard.uuid } } } }), null, "обычный навык");
  assert.equal(run({ pf2e: { context: { type: "damage-roll", target: { actor: guard.uuid } } } }), null);
  assert.equal(run({ pf2e: { context: { type: "attack-roll", target: { actor: "Actor.nobody" } } } }), null, "цель без носителя");
  assert.equal(run({ pf2e: { context: { type: "attack-roll" } } }), null, "нет цели");
  users = { activeGM: null };
  assert.equal(run(atk), null, "нет активного ГМа");
  users = { activeGM: { id: "gm" } };
  for (const [k, v] of [["mode.effect", "off"], ["mode.effect", "button"], ["mode.challenge", "off"], ["mode.apply", "off"], ["mode.damageGate", "off"]]) {
    const prev = settings[k]; settings[k] = v;
    assert.equal(run(atk), null, `${k}=${v}`);
    settings[k] = prev;
  }
  assert.notEqual(run(atk), null);
});

/* ---------- удержание на стороне ГМа ---------- */

test("held: onMessage создаёт ровно одну карточку Воли у нападающего; без hold-записей другие записи ждут выпуска", async () => {
  const side = validate({ v: 1, onEvent: [{ on: "attack-roll", side: "self", apply: [{ to: "self", condition: { slug: "frightened", value: 1 } }] }] }).rule;
  const { guard, foe, ft, carrier } = scene([], [{ type: "feat", id: "fx", uuid: "Actor.foe.Item.fx", name: "x", slug: "x", system: {}, flags: { [MOD]: { rule: side } } }]);
  const m = held(mkMsg("A1", attackCtx(guard), { actor: foe, token: ft }));
  hold.replayers.add(ev.onMessage);
  await ev.onMessage(m);
  assert.equal(created.length, 1, "одна карточка");
  const use = created[0].flags[MOD].use;
  assert.equal(use.kind, "use");
  assert.equal(use.rule.onUse.challenge.statistic, "will");
  assert.equal(use.actor, "Actor.caster", "СЛ — у заклинателя");
  assert.equal(use.state.event, `A1:${carrier.uuid}:2`);
  assert.equal(m.flags[MOD].gate.hold, true, "атака всё ещё удержана");
  assert.equal(m.flags[MOD].events.length, 1, "журнал: только запись носителя (запись нападающего ждёт)");
  assert.equal(m.flags[MOD].events[0].hold, true);
  assert.equal(m.flags[MOD].events.some((r) => r.key.endsWith(".fx:0")), false);
});

test("release: флаг снят, replay зовёт диспетчеры один раз, запись нападающего выполняется после выпуска, hold-записи не повторяются", async () => {
  const side = validate({ v: 1, onEvent: [{ on: "attack-roll", side: "self", apply: [{ to: "self", note: "ход нападающего" }] }] }).rule;
  const { guard, foe, ft } = scene([], [{ type: "feat", id: "fx", uuid: "Actor.foe.Item.fx", name: "x", slug: "x", system: {}, flags: { [MOD]: { rule: side } } }]);
  const m = held(mkMsg("A2", attackCtx(guard), { actor: foe, token: ft }));
  let calls = 0;
  hold.replayers.add(ev.onMessage);
  hold.replayers.add(async () => { calls++; });
  await ev.onMessage(m);
  const r = await hold.resolve(m, "release");
  assert.deepEqual(r.prev, { hold: true, cancelled: false });
  assert.equal(hold.isHeld(m), false);
  assert.equal(calls, 1);
  assert.equal(created.filter((c) => c.flags?.[MOD]?.use?.kind === "use").length, 1, "карточка Воли не размножилась");
  assert.equal(m.flags[MOD].events.some((r2) => r2.key.endsWith(".fx:0")), true, "запись нападающего отработала на replay");
  assert.equal(await hold.resolve(m, "release"), null, "повторный выпуск — ничего");
  assert.equal(calls, 1);
});

test("cancel: атака отменена, кнопки скрыты флагом cancelled, replay не зовётся", async () => {
  const { guard, foe, ft } = scene();
  const m = held(mkMsg("A3", attackCtx(guard), { actor: foe, token: ft }));
  let calls = 0;
  hold.replayers.add(async () => { calls++; });
  await hold.resolve(m, "cancel");
  assert.deepEqual([hold.isHeld(m), hold.isCancelled(m), calls], [false, true, 0]);
});

test("страховка: носитель исчез, режим challenge=off, карточка не создалась (нет токена) — атака выпускается, а не висит", async () => {
  // 1) носитель снят до обработки: hold-записей нет
  let s = scene();
  await s.carrier.delete();
  let m = held(mkMsg("B1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await ev.onMessage(m);
  assert.equal(hold.isHeld(m), false, "нет носителя");
  // 2) challenge=off: карточки нет -> выпуск
  s = scene(); settings["mode.challenge"] = "off";
  m = held(mkMsg("B2", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await ev.onMessage(m);
  assert.equal(hold.isHeld(m), false, "challenge=off");
  assert.equal(created.length, 0);
  // 3) оба режима off: ранний выход onMessage тоже выпускает
  settings["mode.effect"] = "off";
  s = scene();
  m = held(mkMsg("B3", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await ev.onMessage(m);
  assert.equal(hold.isHeld(m), false, "effect и challenge off");
  // 4) у нападающего нет токена (hostChallenge вернул null)
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto" });
  s = scene(); s.foe.getActiveTokens = () => [];
  m = held(mkMsg("B4", attackCtx(s.guard), { actor: s.foe }));
  await ev.onMessage(m);
  assert.equal(hold.isHeld(m), false, "нет токена нападающего");
});

test("карточка закрыта ГМом без применения — удержанная атака выпускается; ручная кнопка выпускает/отменяет и убирает карточку", async () => {
  deleted.push((c) => hold.onDeleteHost(c));
  let s = scene();
  let m = held(mkMsg("C1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await ev.onMessage(m);
  assert.equal(hold.isHeld(m), true);
  await hostCard().delete();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(hold.isHeld(m), false, "карточку удалили");
  // ручная кнопка
  msgs.clear(); created.length = 0;
  s = scene();
  m = held(mkMsg("C2", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await ev.onMessage(m);
  await hold.resolveManual("C2", "cancel");
  assert.equal(hold.isCancelled(m), true);
  assert.equal(created.some((c) => msgs.has(c.id)), false, "висящая карточка удалена");
});

/* ---------- исходы испытания ---------- */

test("крит. успех: носитель снимается с ЗАЩИЩЁННОГО (не с заклинателя), атака выпущена, повтор шага идемпотентен", async () => {
  const s = scene();
  const m = held(mkMsg("D1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  let replayed = 0;
  hold.replayers.add(async () => { replayed++; });
  await ev.onMessage(m);
  const card = hostCard();
  const ops = await resolveCard(card, 3);
  assert.equal(s.carrier.deleted, true, "носитель защищённого снят");
  assert.equal(s.casterOwn.deleted, false, "эффект заклинателя цел");
  assert.equal(hold.isHeld(m), false);
  assert.equal(replayed, 1);
  assert.deepEqual(ops.map((o) => o.op).sort(), ["effRemoved", "hold"]);
  assert.equal((await resolveCard(card, 3)).length, 0, "второе применение карточки ничего не делает");
  assert.equal(replayed, 1);
});

test("успех: атака выпущена; провал/крит. провал: отменена; откат шага возвращает удержание", async () => {
  for (const [degree, cancelled] of [[2, false], [1, true], [0, true]]) {
    msgs.clear(); created.length = 0;
    const s = scene();
    const m = held(mkMsg(`E${degree}`, attackCtx(s.guard), { actor: s.foe, token: s.ft }));
    await ev.onMessage(m);
    const card = hostCard();
    // метки — effect по uuid (в harness pack недоступен): проверяем только шаги hold
    const steps = card.flags[MOD].use.rule.onUse.challenge.byDegree[["criticalFailure", "failure", "success"][degree]].filter((x) => x.hold);
    const ops = await apply.applyOps(card, "ft", steps, { scope: "challenge", degree, total: 10, msgQueued: true, target: s.ft });
    assert.deepEqual([hold.isHeld(m), hold.isCancelled(m)], [false, cancelled], `степень ${degree}`);
    await apply.undoOps(card, "ft");
    // отменённая снова ждёт; выпущенная необратима (replay уже был) — откатываются только cancelled и метки
    assert.deepEqual([hold.isHeld(m), hold.isCancelled(m)], [cancelled, false], "откат: cancel возвращает удержание, release — нет");
    assert.equal(ops[0].op, "hold");
  }
});

test("Подсечка: skill-check с attack при удержании — та же карточка Воли; без attack — не удерживается", async () => {
  const s = scene();
  const trip = held(mkMsg("F1", { context: { type: "skill-check", options: ["attack"], traits: ["attack"], target: { actor: s.guard.uuid } } }, { actor: s.foe, token: s.ft }));
  await ev.onMessage(trip);
  assert.equal(created.length, 1);
  assert.equal(created[0].flags[MOD].use.state.event.startsWith("F1:"), true);
  const m = mkMsg("F2", { context: { type: "skill-check", options: [], target: { actor: s.guard.uuid } } }, { actor: s.foe, token: s.ft });
  await ev.onMessage(m);
  assert.equal(created.length, 1, "обычный навык — без карточки");
});

test("метка passed: вторая атака в этот ход выпускается без карточки; stopped/barred — отменяется без карточки", async () => {
  for (const [slug, cancelled] of [["sanctuary-passed", false], ["sanctuary-stopped", true], ["sanctuary-barred", true]]) {
    msgs.clear(); created.length = 0;
    const mark = mkEffect({ id: "mk", slug, actor: "foe", by: "Actor.guard" });
    const s = scene([], [mark]);
    const m = held(mkMsg(`G-${slug}`, attackCtx(s.guard), { actor: s.foe, token: s.ft }));
    await ev.onMessage(m);
    assert.equal(created.length, 0, `${slug}: карточки нет`);
    assert.deepEqual([hold.isHeld(m), hold.isCancelled(m)], [false, cancelled], slug);
  }
});

test("две быстрые атаки пары: одна карточка; разрешение касается обеих, висящая карточка второй не остаётся", async () => {
  const s = scene();
  const a = held(mkMsg("MH1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  const b = held(mkMsg("MH2", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await Promise.all([ev.onMessage(a), ev.onMessage(b)]);
  assert.equal(created.filter((c) => c.flags?.[MOD]?.use?.kind === "use").length, 1, "одна карточка на пару");
  assert.equal(hold.isHeld(b), true, "вторая ждёт");
  const card = hostCard();
  card.flags[MOD].use.state.challenge = { results: { ft: { degree: 1 } } };
  const steps = card.flags[MOD].use.rule.onUse.challenge.byDegree.failure.filter((x) => x.hold);
  await apply.applyOps(card, "ft", steps, { scope: "challenge", degree: 1, total: 8, msgQueued: true, target: s.ft });
  assert.deepEqual([hold.isCancelled(a), hold.isCancelled(b)], [true, true], "отменены обе");
});

test("две удержанные атаки с уже созданными карточками: разрешение первой удаляет неразрешённую карточку второй", async () => {
  const s = scene();
  const a = held(mkMsg("I1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  const b = held(mkMsg("I2", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  const mk = (id, msg) => mkDoc({ id, flags: { [MOD]: { use: { kind: "use", state: { event: `${msg}:Actor.guard.Item.sx:2` } } } } });
  const c1 = mk("K1", "I1"), c2 = mk("K2", "I2");
  msgs.set("K1", c1); msgs.set("K2", c2);
  await hold.resolve(a, "release");
  assert.equal(msgs.has("K2"), false, "карточка второй удалена");
  assert.equal(msgs.has("K1"), true, "своя карточка остаётся как запись");
  assert.equal(hold.isHeld(b), false);
});

test("переброс после разрешённой Воли: журнал hold-записи не откатывается (метки живы, карточка цела); неразрешённая — откатывается", async () => {
  const s = scene();
  const a = held(mkMsg("J1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await ev.onMessage(a);
  const card = hostCard();
  assert.equal(a.flags[MOD].events[0].host, card.id);
  // 1) карточка не применена: старый журнал уходит в откат (карточка удаляется)
  ev.onDeleteMessage(a);
  msgs.delete("J1");
  const b = held(mkMsg("J2", attackCtx(s.guard, { isReroll: true }), { actor: s.foe, token: s.ft }));
  await ev.onMessage(b);
  assert.equal(msgs.has(card.id), false, "неразрешённая карточка убрана переброской");
  // 2) карточка разрешена (применена): переброс её не трогает, итог переносится
  const card2 = created.filter((c) => c.flags?.[MOD]?.use?.kind === "use").at(-1);
  card2.flags[MOD].use.state.challenge = { results: { ft: { degree: 2 } }, applied: { ft: { ops: [{ op: "hold", key: "x" }] } } };
  ev.onDeleteMessage(b);
  msgs.delete("J2");
  const mark = mkEffect({ id: "mk", slug: "sanctuary-passed", actor: "foe", by: "Actor.guard" });
  mark.actor = s.foe; s.foe.items.push(mark); s.foe.itemTypes.effect.push(mark);
  const c = held(mkMsg("J3", attackCtx(s.guard, { isReroll: true }), { actor: s.foe, token: s.ft }));
  const n = created.length;
  await ev.onMessage(c);
  assert.equal(msgs.has(card2.id), true, "разрешённая карточка цела");
  assert.equal(created.length, n, "второй карточки нет");
  assert.equal(hold.isHeld(c), false, "метка passed выпустила переброшенную атаку");
});

/* ---------- диспетчеры ---------- */

test("builtin-диспетчер: удержанная атака (improved-grab и др.) не обрабатывается, выпущенная — один раз", () => {
  let n = 0;
  const hooks = [["spy", () => { n++; }]];
  const m = { flags: { [MOD]: { gate: { hold: true } } } };
  assert.equal(dispatchBuiltin(m, hooks), false);
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(n, 0);
    m.flags[MOD].gate.hold = false;
    assert.equal(dispatchBuiltin(m, hooks), true);
    setTimeout(() => { assert.equal(n, 1); resolve(); }, 5);
  }, 5));
});

test("use.onCreateMessage: удержанная атака не доходит до подсказки реакции; после выпуска (replay) подсказка создаётся", async () => {
  const use = await import("../scripts/use.mjs");
  const react = validate({ v: 1, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: 2 }, cost: "reaction", notify: ["owner", "gm"] } }).rule;
  const s = scene();
  const sk = { type: "feat", id: "sh", uuid: "Actor.guard.Item.sh", name: "Shield", slug: "shield", system: {}, flags: { [MOD]: { rule: react } } };
  s.guard.items.push(sk); sk.actor = s.guard; uuids.set(sk.uuid, sk);
  s.guard.testUserPermission = () => true; s.guard.getFlag = () => null;
  users = { activeGM: { id: "gm" }, filter: (f) => [{ id: "gm", isGM: true }].filter(f) };
  const m = held(mkMsg("L1", { context: { type: "attack-roll", options: [], target: { actor: s.guard.uuid }, dc: { value: 15 } } }, { actor: s.foe, token: s.ft, speaker: { actor: "foe", alias: "Foe" } }));
  m.rolls = [{ total: 15, options: { degreeOfSuccess: 2 }, dice: [{ faces: 20, total: 10 }] }];
  const hints = () => created.filter((c) => c.flags?.[MOD]?.reaction);
  await use.onCreateMessage(m);
  assert.equal(hints().length, 0, "пока удержана — подсказки нет");
  hold.replayers.add(use.onCreateMessage);
  await hold.resolve(m, "release");
  assert.equal(hints().length, 1, "после выпуска — подсказка реакции");
});

/* ---------- регрессии живого прогона ---------- */

test("откат release + повторное применение: replay и dispatchBuiltin ровно один раз", async () => {
  const s = scene();
  const m = held(mkMsg("R1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await ev.onMessage(m);
  const card = hostCard();
  let replays = 0;
  hold.replayers.add(async () => { replays++; });
  const steps = card.flags[MOD].use.rule.onUse.challenge.byDegree.success.filter((x) => x.hold);
  const run = () => apply.applyOps(card, "ft", steps, { scope: "challenge", degree: 2, total: 10, msgQueued: true, target: s.ft });
  await run();
  await apply.undoOps(card, "ft");
  assert.equal(hold.isHeld(m), false, "выпущенная атака не возвращается в удержание");
  await run();
  assert.equal(replays, 1);
});

test("две защищённые цели: метка Воли против A не действует на атаки по B (привязка по meta.by)", () => {
  const pick = (opts) => ev.matchEntries(CARRIER, "attack-roll", "target", new Set(opts)).map(({ entry }) => entry.apply?.[0]?.hold ?? "challenge");
  return Promise.all(["passed", "stopped", "barred"].map(async (k) => {
    const markA = mkEffect({ id: "mA", slug: `sanctuary-${k}`, actor: "foe", by: "Actor.guardA", origin: "Actor.foe" });
    const foe = mkActor("Actor.foe", [markA]);
    const [a, b] = [{ uuid: "Actor.guardA" }, { uuid: "Actor.guardB" }];
    assert.deepEqual(await ev.originEffectOptions(foe, a), [`origin-effect:sanctuary-${k}`]);
    assert.deepEqual(await ev.originEffectOptions(foe, b), [], "защищённый B метку A не видит");
    assert.deepEqual(pick([]), ["challenge"]);   // у B: меток нет — своя Воля
  }));
});

test("метка другого защищённого не пропускает и не отменяет атаку по этому: у нападающего своя Воля", async () => {
  for (const slug of ["sanctuary-passed", "sanctuary-stopped", "sanctuary-barred"]) {
    msgs.clear(); created.length = 0;
    const s = scene([], [mkEffect({ id: "mk", slug, actor: "foe", by: "Actor.otherGuard" })]);
    const m = held(mkMsg(`X-${slug}`, attackCtx(s.guard), { actor: s.foe, token: s.ft }));
    await ev.onMessage(m);
    assert.equal(!!hostCard(), true, `${slug} от другого защищённого: карточка Воли есть`);
    assert.equal(hold.isHeld(m), true);
  }
});

test("метка passed у нападающего: шаг release внутри очереди выпускает атаку без взаимной блокировки replay", async () => {
  const mark = mkEffect({ id: "pm", slug: "sanctuary-passed", actor: "foe", origin: "Actor.foe", by: "Actor.guard" });
  const s = scene([], [mark]);
  const m = held(mkMsg("F1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  hold.replayers.add(ev.onMessage);
  const done = await Promise.race([ev.onMessage(m).then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
  assert.equal(done, true, "onMessage завершился");
  assert.equal(hold.isHeld(m), false);
  assert.equal(created.length, 0, "карточки нет");
});

test("ручная кнопка убирает карточку Воли, по которой уже бросили, но «Применить» не нажимали", async () => {
  const s = scene();
  const m = held(mkMsg("G1", attackCtx(s.guard), { actor: s.foe, token: s.ft }));
  await ev.onMessage(m);
  hostCard().flags[MOD].use.state.challenge = { results: { ft: { degree: 2 } } };
  await hold.resolveManual("G1", "release");
  assert.equal(created.some((c) => msgs.has(c.id)), false, "карточка удалена");
  assert.equal(hold.isHeld(m), false);
});
