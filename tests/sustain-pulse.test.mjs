// Импульс Поддержания (docs/plan-sustain-pulse.md): валидатор, урезанная копия правила, карточка импульса, дедуп, привязка к якорю, порядок якоря.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MOD } from "../scripts/util.mjs";
import { validateRule } from "../scripts/rules.mjs";
import * as sustain from "../scripts/sustain.mjs";
import { applyOps } from "../scripts/apply.mjs";

globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: {} };   // zone.mjs берёт базовые классы при импорте
const { onPulse, pulseRule, runRegion, runUse, useKindOf } = await import("../scripts/use.mjs");

const KEY = sustain.anchorKey("M1");
const settings = {};
const registry = new Map();
let msgs, sent, world, n;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
const tick = () => new Promise((r) => setTimeout(r, 20));

function mkActor(uuid) {
  const items = [];
  const actor = {
    uuid, name: uuid, items, getActiveTokens: () => [{ uuid: `Tok.${uuid}` }],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: `${uuid}.i${++n}`, uuid: `${uuid}.Item.i${n}`, actor, isExpired: false };
        it.update = async (ch) => { for (const [p, v] of Object.entries(ch)) setDeep(it, p, v); };
        it.delete = async (opts) => { items.splice(items.indexOf(it), 1); await sustain.onDeleteItem(it, opts); };
        registry.set(it.uuid, it); items.push(it);
        return it;
      });
    },
    get itemTypes() { return { condition: items.filter((i) => i.type === "condition") }; }
  };
  registry.set(uuid, actor);
  return actor;
}

const spell = { type: "spell", name: "Earth's Bile", slug: "earths-bile", uuid: "Item.s", img: "s.svg", rank: 2, system: { duration: { value: "1 minute", sustained: true }, area: { type: "burst", value: 10 }, traits: { value: [] } }, spellcasting: { statistic: { dc: { value: 21 } } } };
const RULE = { v: 1, onUse: { targets: "area", pulse: "same", zone: { condition: { slug: "x" } }, challenge: { statistic: "reflex", dc: { source: "spell" }, byDegree: {} }, apply: [
  { to: "self", effect: { uuid: "Compendium.x.Item.self" } },
  { to: "target", effect: { uuid: "Compendium.x.Item.mark" }, sustain: true },
  { to: "target", effect: { mods: [{ type: "item", value: 1 }] } },
  { to: "target", condition: { slug: "frightened", value: 1 } }] }, macros: [{ phase: "onUse" }] };

function mkMsg(id, extra = {}) {
  const m = { id, flags: {}, ...extra, async update(d) { for (const [p, v] of Object.entries(d)) setDeep(this, p, v); } };
  msgs.set(id, m); return m;
}
const castMsg = (use = {}, origin = { castRank: 3, rollOptions: ["origin:item:trait:x"] }) =>
  mkMsg("M1", { flags: { pf2e: { origin }, [MOD]: { use: { v: 1, kind: "use", rule: RULE, dc: 30, token: "Tok.a", actor: "Actor.a", item: { uuid: "Item.s", name: "Earth's Bile", type: "spell" }, targets: [{ key: "x", uuid: "Tok.x" }], state: {}, ...use } } } });

function setup() {
  registry.clear(); sent = []; n = 0; msgs = new Map(); world = { combat: { id: "c1", round: 1 } };
  Object.assign(settings, { "mode.effect": "button", "mode.challenge": "button", "mode.zone": "auto", "mode.macro": "off" });
  globalThis.game = {
    modules: { get: () => null }, user: { isActiveGM: true, isGM: true, id: "gm" }, users: [{ id: "gm", isGM: true }],
    i18n: { localize: (k) => k, format: (k) => k }, settings: { get: (_m, k) => settings[k] },
    get combat() { return world.combat; },
    get combats() { return world.combat ? [{ combatants: [{ actor: registry.get("Actor.a") }], ...world.combat }] : []; },
    messages: { get: (id) => msgs.get(id), find: (fn) => [...msgs.values()].find(fn), get contents() { return [...msgs.values()]; } },
    scenes: { contents: [] },
    pf2e: { actions: { get: () => ({ use: async () => {} }) }, ConditionManager: { getCondition: (slug) => ({ uuid: null, _stats: { compendiumSource: `Compendium.pf2e.conditionitems.Item.${slug}` }, name: slug, img: "i.svg", system: { value: { isValued: true } }, toObject() { return { name: slug, type: "condition", system: { slug, value: { isValued: true, value: null } } }; } }) } }
  };
  globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o), setProperty: setDeep, deepClone: (o) => structuredClone(o) } };
  globalThis.fromUuid = async (u) => registry.get(u) ?? null;
  globalThis.fromUuidSync = (u) => registry.get(u) ?? null;
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async (d) => { const m = mkMsg(`P${msgs.size}`, structuredClone(d)); sent.push(m); return m; } };
  globalThis.ui = { notifications: { warn() {} } };
  registry.set("Item.s", spell);
}
const teardown = () => { for (const k of ["game", "foundry", "fromUuid", "fromUuidSync", "ChatMessage", "ui"]) delete globalThis[k]; };

/** Якорь заклинания на авторе (сотворено в R1) + сообщение сотворения. */
async function scene({ pulse = true, region = true } = {}) {
  setup();
  const author = mkActor("Actor.a"), ally = mkActor("Actor.ally");
  const tokA = { id: "tA", uuid: "Tok.a", name: "A", actor: author, testInsideRegion: () => true }, tokB = { id: "tB", uuid: "Tok.b", name: "B", actor: ally, testInsideRegion: () => true };
  registry.set("Tok.a", tokA); registry.set("Tok.b", tokB);
  const R = { uuid: "R1", flags: { pf2e: { messageId: "M1", areaShape: "emanation" } }, parent: { tokens: { contents: [tokA, tokB] } } };
  if (region) registry.set("R1", R);
  castMsg({ state: { area: { regionUuid: "R1", keys: ["tB"] } } });
  const { item } = await sustain.attach(author, null, { key: KEY, msg: "M1", item: spell, at: { combat: "c1", round: 1 }, pulse });
  return { author, ally, anchor: item, R, tokA, tokB };
}
const cards = () => sent.filter((m) => m.flags?.[MOD]?.use?.state?.pulse);

test("валидатор: pulse при area+challenge и selected+шаг to:target; прочее — use.pulse", () => {
  const ok = (onUse) => validateRule({ v: 1, onUse });
  const ch = { statistic: "reflex", dc: { source: "spell" }, byDegree: {} };
  assert.equal(ok({ targets: "area", pulse: "new", challenge: ch }).rule.onUse.pulse, "new");
  assert.equal(ok({ targets: "selected", pulse: "same", apply: [{ to: "target", condition: { slug: "frightened", value: 1 } }] }).rule.onUse.pulse, "same");
  const bad = [
    { targets: "self", pulse: "same", challenge: ch },
    { targets: "area", pulse: "same", apply: [{ to: "self", condition: { slug: "frightened", value: 1 } }] },
    { targets: "selected", pulse: "new", challenge: ch },
    { targets: "area", pulse: "often", challenge: ch }
  ];
  for (const b of bad) assert.ok(JSON.stringify(ok(b).errors).includes("use.pulse"), JSON.stringify(b));
  assert.equal(ok({ targets: "area", challenge: ch }).rule.onUse.pulse, undefined);
});

test("каталог: A23 same, A25 new, оба проходят валидатор", () => {
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8"));
  const find = (label) => Object.values(cat.bySource).find((r) => r?.label === label);
  for (const [label, p] of [["Garden of Healing", "same"], ["Earth's Bile", "new"]]) {
    const r = find(label), v = validateRule(r);
    assert.equal(r.onUse.pulse, p);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(v.rule.onUse.pulse, p);
  }
});

test("урезанная копия: challenge и to:target без inline-эффекта; нет pulse/zone/macros/self-шагов", () => {
  const c = pulseRule(RULE);
  assert.ok(c.onUse.challenge);
  assert.deepEqual(c.onUse.apply.map((s) => s.effect?.uuid ?? s.condition?.slug), ["Compendium.x.Item.mark", "frightened"]);
  assert.equal(c.onUse.pulse, undefined); assert.equal(c.onUse.zone, undefined); assert.equal(c.macros, undefined);
  assert.equal(c.onUse.targets, "area");
});

test("импульс: cast R1 + Sustain R1 — нет; R2 — один; повтор — нет; круг, СЛ, опции, origin только castRank", async () => {
  const { author } = await scene();
  sustain.sustained.add(onPulse);
  try {
    assert.equal((await sustain.run(author.uuid, KEY)).result, "again");
    await tick(); assert.equal(cards().length, 0);
    world.combat = { id: "c1", round: 2 };
    assert.equal((await sustain.run(author.uuid, KEY)).result, "fresh");
    await tick(); assert.equal(cards().length, 1);
    assert.equal((await sustain.run(author.uuid, KEY)).result, "again");
    await tick(); assert.equal(cards().length, 1);
    const card = cards()[0], u = card.flags[MOD].use;
    assert.deepEqual(card.flags.pf2e, { origin: { castRank: 3 } });   // только castRank: иначе карточка сошла бы за сотворение
    assert.equal(useKindOf(card), null);
    assert.deepEqual(u.rollOptions, ["origin:item:trait:x", "sustain:pulse"]);
    assert.equal(u.dc, 30);
    assert.equal(u.state.sustainKey, KEY);
    assert.equal(u.state.pulse.key, `${KEY}:c1:2`);
    assert.equal(u.rule.onUse.pulse, undefined);
    // same + живой регион: runRegion сразу — область заполнена, автор (эманация) исключён
    assert.equal(u.state.awaitingRegion, undefined);
    assert.deepEqual(msgs.get(card.id).flags[MOD].use.state.area.keys, ["tB"]);
  } finally { sustain.sustained.delete(onPulse); teardown(); }
});

test("new: карточка ждёт шаблон (awaitingRegion + @Template); регион с messageId карточки -> runRegion задаёт цели", async () => {
  const { anchor, tokA, tokB } = await scene();
  sustain.sustained.add(onPulse);
  try {
    const c = castMsg(); c.flags[MOD].use.rule = { ...RULE, onUse: { ...RULE.onUse, pulse: "new" } };
    await onPulse({ anchor, actor: registry.get("Actor.a"), pos: { combat: "c1", round: 2 } });
    const card = cards()[0], u = card.flags[MOD].use;
    assert.equal(u.state.awaitingRegion, true);   // выставляет onPulse; resumeRegion/onCreateRegion подхватят регион по flags.pf2e.messageId
    assert.match(card.content, /@Template\[type:burst\|distance:10\]/);
    assert.equal(u.state.area, undefined);
    const region = { uuid: "R2", flags: { pf2e: { messageId: card.id, areaShape: "burst" } }, parent: { tokens: { contents: [tokA, tokB] } } };
    await runRegion(region, msgs.get(card.id));
    assert.deepEqual(msgs.get(card.id).flags[MOD].use.state.area, { regionUuid: "R2", keys: ["tA", "tB"] });
  } finally { sustain.sustained.delete(onPulse); teardown(); }
});

test("same без живого региона ведёт себя как new; yielded — импульса нет; вне боя — окно 6 с", async () => {
  const { anchor, author } = await scene({ region: false });
  try {
    await onPulse({ anchor, actor: author, pos: { combat: "c1", round: 2 } });
    assert.equal(cards()[0].flags[MOD].use.state.awaitingRegion, true);
    castMsg({ state: { yielded: "pf2e-automations" } });
    await onPulse({ anchor, actor: author, pos: { combat: "c1", round: 3 } });
    assert.equal(cards().length, 1);
    castMsg();
    await onPulse({ anchor, actor: author, pos: { combat: null, round: null } });
    await onPulse({ anchor, actor: author, pos: { combat: null, round: null } });
    assert.equal(cards().length, 2);
  } finally { teardown(); }
});

test("карточка импульса не ставит якорь; сотворение с onUse.pulse — ставит с pulse:true", async () => {
  setup();
  try {
    const author = mkActor("Actor.a");
    castMsg();
    await runUse("M1");
    const [a] = sustain.anchorsOf(author);
    assert.ok(a); assert.equal(a.flags[MOD].sustain.pulse, true);
    assert.match(sent.at(-1)?.content ?? "", /sustain\.offer(?!Quiet)/);   // полный шёпот, привязок нет
    const before = author.items.length;
    mkMsg("P9", { flags: { [MOD]: { use: { v: 1, kind: "use", rule: pulseRule(RULE), actor: "Actor.a", item: { uuid: "Item.s" }, targets: [], state: { pulse: { key: "k" }, sustainKey: KEY } } } } });
    await runUse("P9");
    assert.equal(author.items.length, before);
  } finally { teardown(); }
});

test("порядок якоря: якорь от шага sustain:true без флага получает pulse; prune его не снимает", async () => {
  setup();
  try {
    const author = mkActor("Actor.a");
    await sustain.attach(author, { uuid: "Actor.t" }, { key: KEY, msg: "M1", item: spell });
    const a = sustain.findAnchor(author, KEY);
    assert.equal(a.flags[MOD].sustain.pulse, undefined);
    const whispers = sent.length;
    await sustain.attach(author, null, { key: KEY, msg: "M1", item: spell, pulse: true });
    assert.equal(a.flags[MOD].sustain.pulse, true);
    assert.equal(sent.length, whispers);   // второй шёпот не уходит
    registry.set("Actor.t", mkActor("Actor.t"));
    assert.equal(await sustain.prune(author, KEY), false);
    assert.ok(sustain.findAnchor(author, KEY));
  } finally { teardown(); }
});

test("привязка с карточки импульса: живой якорь — sustainOf по state.sustainKey; якоря нет — без привязки", async () => {
  setup();
  try {
    const author = mkActor("Actor.a"), t = mkActor("Actor.t"), t2 = mkActor("Actor.t2");
    registry.set("Tok.t", { uuid: "Tok.t", actor: t }); registry.set("Tok.t2", { uuid: "Tok.t2", actor: t2 });
    const step = { to: "target", condition: { slug: "stupefied", value: 1 }, duration: { value: 1, unit: "minutes", expiry: null, of: "origin" }, sustain: true };
    const card = mkMsg("P5", { flags: { [MOD]: { use: { v: 1, kind: "use", actor: "Actor.a", token: null, item: null, rule: pulseRule({ onUse: { targets: "selected", challenge: {} } }), targets: [{ key: "t", uuid: "Tok.t" }, { key: "t2", uuid: "Tok.t2" }], state: { pulse: { key: "k" }, sustainKey: KEY } } } } });
    await applyOps(card, "t2", [step], { scope: "challenge", degree: 1, originItem: spell });
    assert.equal(t2.items[0].flags[MOD].meta.sustainOf, undefined);   // якоря нет (после «Прекратить») — не воскрешаем
    assert.equal(sustain.anchorsOf(author).length, 0);
    await sustain.attach(author, null, { key: KEY, msg: "M1", item: spell, pulse: true });
    await applyOps(card, "t", [step], { scope: "challenge", degree: 1, originItem: spell });
    assert.equal(t.items[0].flags[MOD].meta.sustainOf, KEY);
    assert.equal(sustain.anchorsOf(author).length, 1);
    assert.deepEqual(sustain.findAnchor(author, KEY).flags[MOD].sustain.actors, ["Actor.t"]);
  } finally { teardown(); }
});

test("валидатор: pulse вместе с onUse.check — ошибка", () => {
  const r = validateRule({ v: 1, onUse: { targets: "area", pulse: "same", check: { statistic: "athletics", vs: { defense: "reflex" }, byDegree: {} }, apply: [{ to: "target", condition: { slug: "frightened", value: 1 } }] } });
  assert.ok(JSON.stringify(r.errors).includes("use.pulse"));
});

test("урезанная копия чистит и шаги по степеням испытания", () => {
  const rule = { v: 1, onUse: { targets: "area", pulse: "same", challenge: { statistic: "reflex", byDegree: { failure: [{ to: "self", condition: { slug: "x" } }, { to: "target", effect: { mods: [] } }, { to: "target", condition: { slug: "frightened", value: 1 } }] } } } };
  assert.deepEqual(pulseRule(rule).onUse.challenge.byDegree.failure.map((s) => s.condition?.slug), ["frightened"]);
});

test("лист: pulse сохраняется через форму, при targets self сбрасывается", async () => {
  const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
  const f = ruleToForm(validateRule({ v: 1, onUse: { targets: "area", pulse: "same", apply: [{ to: "target", condition: { slug: "frightened", value: 1 } }] } }).rule);
  assert.equal(f.pulse, "same");
  assert.equal(formToRule(f).onUse.pulse, "same");
  assert.equal(formToRule({ ...f, targets: "self" }).onUse.pulse, undefined);
});

test("«Дозапустить» готовой карточки сотворения не воскрешает снятый якорь", async () => {
  setup();
  try {
    const author = mkActor("Actor.a");
    castMsg({ state: { done: true } });
    await runUse("M1");
    assert.equal(sustain.anchorsOf(author).length, 0);
  } finally { teardown(); }
});

test("attach с create:false не создаёт якорь", async () => {
  setup();
  try {
    const author = mkActor("Actor.a");
    const r = await sustain.attach(author, { uuid: "Actor.t" }, { key: KEY, msg: "M1", item: spell, create: false });
    assert.equal(r.item, null); assert.equal(sustain.anchorsOf(author).length, 0);
  } finally { teardown(); }
});

test("пропуск якоря с pulse без привязок сообщается", async () => {
  const { author } = await scene();
  try {
    sent.length = 0;
    world.combat = { id: "c1", round: 2 };
    assert.equal(await sustain.check([author], { combat: "c1", round: 2 }, "turn"), 1);
    assert.ok(sent.some((m) => /sustain\.ended\.missed/.test(m.content)));
  } finally { teardown(); }
});

test("вне боя: Поддержание сразу после сотворения — не импульс", async () => {
  setup();
  try {
    world.combat = null;
    const author = mkActor("Actor.a");
    castMsg();
    await runUse("M1");
    const anchor = sustain.anchorsOf(author)[0];
    await onPulse({ anchor, actor: author, pos: { combat: null, round: null } });
    assert.equal(cards().length, 0);
  } finally { teardown(); }
});
