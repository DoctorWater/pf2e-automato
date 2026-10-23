// Бросок действия из листа/макроса (без карточки предмета): разбор check-сообщения pf2e и поток onRollMessage.
// Фикстуры — реальный формат flags.pf2e.context (Check.roll, pf2e 8.6.1): options отсортированы, outcome — строка, origin/target — {actor, token} uuid.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settings = {};
let msgs, uuids, whispers;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.ChatMessage = { create: async (d) => { whispers.push(d); }, getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const { parseActionRoll, ruleFor, aliasSlugs, onRollMessage, onDeleteMessage } = await import("../scripts/actions.mjs");
const { applyByDegree } = await import("../scripts/saves.mjs");
const { buildViewModel } = await import("../scripts/chat.mjs");

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
rules.initCatalog([read("../rules/catalog.json"), read("../rules/catalog.campaign.json")], read("../rules/labels.json"));

/** Реальный вид: Trip из листа (skill-check, athletics) по выбранной цели. */
const tripCtx = (over = {}) => ({
  type: "skill-check", identifier: null, action: null, domains: ["all", "skill-check", "athletics", "str-based", "str-skill-check"],
  actor: "A1", token: "T1", origin: { actor: "Actor.hero", token: "Scene.s.Token.hero" }, target: { actor: "Actor.orc", token: "Scene.s.Token.orc" },
  options: ["action:trip", "action:cost:1", "check:statistic:athletics", "check:type:skill", "item:trait:attack", "self:action:slug:trip"].sort(),
  dc: { value: 17, slug: "reflex", label: "Reflex", scope: "check", visible: true }, outcome: "success", unadjustedOutcome: "success",
  isReroll: false, traits: ["attack"], title: "PF2E.Actions.Trip.Title", ...over
});
const rollMsg = (ctx, extra = {}) => ({
  id: "R1", author: { id: "pl" }, rolls: [{ total: 19, dice: [{ results: [{ active: true, result: 12 }] }], degreeOfSuccess: 2 }],
  flags: { pf2e: { context: ctx, modifierName: "athletics" } }, ...extra
});
const mkMessage = (src) => {
  const m = { ...src, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(m.id, m);
  return m;
};
const dcOf = (v) => ({ dc: { value: v } });
const mkToken = (items = []) => ({ id: "orc", uuid: "Scene.s.Token.orc", name: "Orc", actor: { uuid: "Actor.orc", name: "Orc", items, hasPlayerOwner: false, saves: { reflex: dcOf(17), will: dcOf(19) }, perception: dcOf(20) } });
const env = (over = {}) => ({ t: (k) => k, mode: (k) => settings[`mode.${k}`], now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false,
  tokenName: () => "?", isOwner: () => false, isActorOwner: () => false, statLabel: (s) => s, conditionLabel: (s) => s, uuidName: () => null,
  checkDc: () => 17, immune: () => false, ...over });
const GM = { id: "gm", isGM: true };

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.apply": "button", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: true, resumeMinutes: 30 });
  msgs = new Map(); whispers = [];
  uuids = new Map([["Scene.s.Token.orc", mkToken()], ["Actor.orc", mkToken().actor]]);
});

test("parseActionRoll: Trip из листа -> slug, автор, цель, степень, СЛ", () => {
  const p = parseActionRoll(rollMsg(tripCtx()));
  assert.deepEqual(p.slugs, ["trip"]);   // action:cost:1 и self:action:slug:trip не считаются
  assert.equal(p.actor, "Actor.hero");
  assert.deepEqual(p.target, { actor: "Actor.orc", token: "Scene.s.Token.orc" });
  assert.equal(p.degree, 2); assert.equal(p.total, 19); assert.equal(p.dc, 17); assert.equal(p.die, 12);
  assert.equal(p.by, "pl"); assert.equal(p.isReroll, false);
});

test("parseActionRoll: исход из context.outcome, если у броска степени нет; нет цели -> target null; context.action тоже slug", () => {
  const m = rollMsg(tripCtx({ outcome: "criticalFailure", target: null, action: "trip" }));
  m.rolls[0].degreeOfSuccess = null;
  const p = parseActionRoll(m);
  assert.equal(p.degree, 0); assert.equal(p.target, null); assert.deepEqual(p.slugs, ["trip"]);
  const noDc = rollMsg(tripCtx({ dc: null, outcome: null })); noDc.rolls[0].degreeOfSuccess = null;
  assert.equal(parseActionRoll(noDc).degree, null);
});

test("parseActionRoll: не бросок действия — null (спасбросок, нет action:, наш маркер, не-сообщение)", () => {
  assert.equal(parseActionRoll(rollMsg(tripCtx({ type: "saving-throw" }))), null);
  assert.equal(parseActionRoll(rollMsg(tripCtx({ options: ["check:type:skill", "action:cost:1"] }))), null);
  assert.equal(parseActionRoll(rollMsg(tripCtx({ options: ["action:trip", `${MOD}:M1:orc`] }))), null);
  assert.equal(parseActionRoll({ flags: {} }), null);
  assert.equal(parseActionRoll(null), null);
});

test("ruleFor: каталог по slug; без onUse.check / неизвестный slug — null; перебирает кандидатов", () => {
  assert.equal(ruleFor(["trip"]).rule.onUse.check.statistic, "athletics");
  assert.equal(ruleFor(["strike", "demoralize"]).slug, "demoralize");
  assert.equal(ruleFor(["aid"]), null);   // у Aid нет onUse.check
  assert.equal(ruleFor(["no-such-action"]), null);
});

test("onRollMessage: Trip -> снимок roll на том же сообщении, результат без броска, цель и СЛ", async () => {
  const m = mkMessage(rollMsg(tripCtx()));
  await onRollMessage(m);
  const use = m.flags[MOD].use;
  assert.equal(use.kind, "roll"); assert.equal(use.slug, "trip"); assert.equal(use.actor, "Actor.hero"); assert.equal(use.state.done, true);
  assert.deepEqual(use.targets, [{ key: "orc", uuid: "Scene.s.Token.orc", name: "Orc", pc: false }]);
  const r = use.state.challenge.results.orc;
  assert.deepEqual([r.degree, r.total, r.dc, r.src, r.rollMessageId, r.by], [2, 19, 17, "action", "R1", "pl"]);
  assert.equal(use.state.challenge.applied, undefined);   // mode.apply=button: ГМ применяет кнопкой
  const row = buildViewModel(m, GM, env()).challenge.rows[0];
  assert.equal(row.canApply, true);
  assert.equal(row.canRoll, false);
});

test("onRollMessage: без цели — блок «нет цели», результатов нет; повторный вызов ничего не пишет", async () => {
  const m = mkMessage(rollMsg(tripCtx({ target: null, dc: null, outcome: null })));
  const res = await onRollMessage(m);
  assert.equal(res.noTarget, true);
  assert.deepEqual(m.flags[MOD].use.targets, []);
  assert.equal(m.flags[MOD].use.state.challenge, undefined);
  assert.equal(await onRollMessage(m), null);
  assert.equal(buildViewModel(m, GM, env()).challenge.toolbelt, "checks.noTargetRoll");
});

test("onRollMessage: не наш случай — маркер, нет правила, режим challenge=off, не активный ГМ", async () => {
  assert.equal(await onRollMessage(mkMessage(rollMsg(tripCtx({ options: ["action:trip", `${MOD}:M1:orc`] })))), null);
  assert.equal(await onRollMessage(mkMessage({ ...rollMsg(tripCtx({ options: ["action:strike"] })), id: "R2" })), null);
  settings["mode.challenge"] = "off";
  assert.equal(await onRollMessage(mkMessage({ ...rollMsg(tripCtx()), id: "R3" })), null);
  settings["mode.challenge"] = "auto";
  game.user.isActiveGM = false;
  try { assert.equal(await onRollMessage(mkMessage({ ...rollMsg(tripCtx()), id: "R4" })), null); } finally { game.user.isActiveGM = true; }
});

test("onRollMessage: иммунная цель (Demoralize) — результат виден, но ничего не применяется даже при apply=auto", async () => {
  settings["mode.apply"] = "auto";
  const imm = { type: "effect", system: { context: { origin: { actor: "Actor.hero" } } }, _stats: {}, flags: { [MOD]: { immunity: { slug: "demoralize" } } } };
  uuids.set("Scene.s.Token.orc", mkToken([imm]));
  uuids.set("Actor.hero", { uuid: "Actor.hero", name: "Hero" });
  const m = mkMessage(rollMsg(tripCtx({ options: ["action:demoralize"], outcome: "criticalSuccess", dc: { value: 19, slug: "will" } })));
  m.rolls[0].degreeOfSuccess = 3;
  await onRollMessage(m);
  assert.equal(m.flags[MOD].use.state.challenge.results.orc.degree, 3);
  assert.equal(m.flags[MOD].use.state.challenge.applied, undefined);
  const row = buildViewModel(m, GM, env({ immune: () => true })).challenge.rows[0];
  assert.match(row.note, /immuneSkipped/);
  assert.equal(row.canApply, false);
  assert.deepEqual(await applyByDegree("R1", "orc"), []);
});

test("переброс: удалённое сообщение откладывает снимок; новое получает его состояние, меняется степень, после применения — шёпот ГМу", async () => {
  const m = mkMessage(rollMsg(tripCtx()));
  await onRollMessage(m);
  m.flags[MOD].use.state.challenge.applied = { orc: { ops: [{ op: "created", item: "Actor.orc.Item.x" }], degree: 2 } };   // уже применено
  msgs.delete("R1"); onDeleteMessage(m);
  const again = rollMsg(tripCtx({ isReroll: true, outcome: "criticalSuccess" }), { id: "R9" });
  again.rolls[0].degreeOfSuccess = 3; again.rolls[0].total = 31;
  const m2 = mkMessage(again);
  await onRollMessage(m2);
  const st = m2.flags[MOD].use.state.challenge;
  assert.equal(st.results.orc.degree, 3);
  assert.equal(st.results.orc.rollMessageId, "R9");
  assert.equal(st.results.orc.changedAfterApply, true);
  assert.equal(st.applied.orc.ops.length, 1);   // откат по uuid эффектов сохранён
  assert.equal(whispers.length, 1);
});

test("переброс с тем же исходом (оставлен прежний бросок) — без шёпота", async () => {
  const m = mkMessage(rollMsg(tripCtx()));
  await onRollMessage(m);
  msgs.delete("R1"); onDeleteMessage(m);
  const m2 = mkMessage(rollMsg(tripCtx({ isReroll: true }), { id: "R9" }));
  await onRollMessage(m2);
  assert.equal(m2.flags[MOD].use.state.challenge.results.orc.degree, 2);
  assert.equal(whispers.length, 0);
});

test("переброс без отложенного снимка — как новый бросок", async () => {
  const m2 = mkMessage(rollMsg(tripCtx({ isReroll: true }), { id: "R7" }));
  await onRollMessage(m2);
  assert.equal(m2.flags[MOD].use.state.challenge.results.orc.degree, 2);
});

test("aliasSlugs: Workbench treat-wounds в бою у владельца Боевой медицины -> battle-medicine", () => {
  assert.deepEqual(aliasSlugs(["treat-wounds"], { inCombat: true, hasBattleMedicine: true }), ["battle-medicine"]);
  assert.deepEqual(aliasSlugs(["treat-wounds"], { inCombat: false, hasBattleMedicine: true }), ["treat-wounds"]);
  assert.deepEqual(aliasSlugs(["treat-wounds"], { inCombat: true, hasBattleMedicine: false }), ["treat-wounds"]);
  assert.equal(ruleFor(aliasSlugs(["treat-wounds"], { inCombat: true, hasBattleMedicine: true })).slug, "battle-medicine");
});

test("onRollMessage: цели нет в контексте (макрос Workbench) — берём единственную цель автора", async () => {
  const m = mkMessage(rollMsg(tripCtx({ target: null }), { author: { id: "pl", targets: new Set([{ document: mkToken() }]) } }));
  await onRollMessage(m);
  assert.deepEqual(m.flags[MOD].use.targets.map((t) => t.key), ["orc"]);
  assert.equal(m.flags[MOD].use.state.challenge.results.orc.degree, 2);
  const two = mkMessage(rollMsg(tripCtx({ target: null }), { id: "R2", author: { id: "pl", targets: new Set([{ document: mkToken() }, { document: mkToken() }]) } }));
  assert.equal((await onRollMessage(two)).noTarget, true);
});

test("parseActionRoll: атака заклинанием с карточки — slug заклинания (Оплетающая лоза, check.roll:system)", () => {
  const m = rollMsg({ type: "attack-roll", options: ["item:trait:attack"], outcome: "criticalSuccess", origin: { actor: "Actor.gob" }, target: { actor: "Actor.orc", token: "Scene.s.Token.orc" } });
  m.flags.pf2e.origin = { type: "spell", rollOptions: ["origin:item:slug:tangle-vine"] };
  assert.deepEqual(parseActionRoll(m).slugs, ["tangle-vine"]);
  const ru = rollMsg({ type: "attack-roll", options: ["item:trait:attack"], outcome: "success", origin: { actor: "Actor.gob" } });
  ru.flags.pf2e.origin = { type: "spell", rollOptions: ["origin:item:slug:оплетающая-лоза"] };
  assert.equal(parseActionRoll(ru), null);   // кириллический slug не берём
  const r = ruleFor(["tangle-vine"]);
  assert.equal(r.rule.onUse.check.roll, "system");
  assert.equal(r.rule.onUse.check.byDegree.criticalSuccess[0].choice, "critical-success");
});
