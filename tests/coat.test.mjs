// Нанесение яда на оружие (plan-weapon-poison.md): схема, события носителя, нанесение, трата/взвод/замена, гонка двух Ударов, режимы, откат. Без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
const isPlain = (x) => x && typeof x === "object" && !Array.isArray(x);
const merge = (t, s) => { for (const [k, v] of Object.entries(s)) t[k] = isPlain(v) && isPlain(t[k]) ? merge(t[k], v) : structuredClone(v); return t; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  combats: [], actors: [], scenes: { contents: [] },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };

const { MOD, setSocket } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const coat = await import("../scripts/coat.mjs");
const { coatOf } = await import("../tools/affliction.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const { roundTrip, semanticErrors } = await import("../tools/validate.mjs");
const { stepText } = await import("../scripts/chat.mjs");

const validate = rules.validateRule;

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false });
  msgs = new Map(); uuids = new Map(); created = [];
  game.user.isActiveGM = true;
});

/* ---------- данные ---------- */

const DEF = { name: "Spider Venom", kind: "poison", save: { statistic: "fortitude" }, maxDuration: { value: 6, unit: "rounds" },
  stages: [{ duration: { value: 1, unit: "rounds" }, conditions: [{ slug: "sickened", value: 1 }] }, { duration: { value: 1, unit: "rounds" }, conditions: [{ slug: "clumsy", value: 1 }] }, { conditions: [{ slug: "slowed", value: 1 }] }] };
const CH = (dc = { value: 22 }) => ({ statistic: "fortitude", dc, basic: false, rollerRole: "target", traits: ["poison", "injury"],
  byDegree: { failure: [{ to: "target", affliction: { stage: 1, def: DEF } }], criticalFailure: [{ to: "target", affliction: { stage: 2, def: DEF } }] } });
const COAT = (o = {}) => ({ to: "self", coat: { weapon: "choose", challenge: CH(), ...o } });
const ruleOf = (step = COAT()) => ({ v: 1, label: "Spider Venom", onUse: { targets: "self", apply: [step] } });
const keys = (r) => validate(r).errors.map((e) => e.key);

/* ---------- схема ---------- */

test("coat: валидный шаг нормализуется (challenge — как у onUse, срок по желанию), isActiveStep, текст в чате", () => {
  const r = validate(ruleOf());
  assert.deepEqual(r.errors, []);
  const s = r.rule.onUse.apply[0];
  assert.equal(s.coat.weapon, "choose");
  assert.equal(s.coat.challenge.dc.value, 22);
  assert.equal("duration" in s.coat, false);
  assert.equal(rules.isActiveStep(s), true);
  const env = validate(ruleOf(COAT({ duration: { value: 1, unit: "rounds", expiry: "turn-end" } }))).rule.onUse.apply[0].coat.duration;
  assert.deepEqual(env, { value: 1, unit: "rounds", expiry: "turn-end" });
  assert.equal(stepText(s, { t: (k) => k }), "chat.stepCoat");
});

test("coat: dc в любой форме допустим (against, expr markup, source spell), без challenge, не-choose, чужие поля, to != self — отказ", () => {
  for (const dc of [{ against: "class-spell" }, { expr: "markup" }, { source: "spell" }]) assert.deepEqual(keys(ruleOf(COAT({ challenge: CH(dc) }))), [], JSON.stringify(dc));
  assert.deepEqual(keys(ruleOf({ to: "self", coat: { weapon: "choose" } })), ["coat.challenge"]);
  assert.deepEqual(keys(ruleOf(COAT({ weapon: "sword" }))), ["coat.bad"]);
  assert.deepEqual(keys(ruleOf(COAT({ foo: 1 }))), ["coat.bad"]);
  assert.deepEqual(keys(ruleOf(COAT({ duration: { value: 0, unit: "rounds" } }))), ["coat.dur"]);
  assert.deepEqual(keys(ruleOf({ ...COAT(), to: "target" })), ["coat.to"]);
  assert.deepEqual(keys(ruleOf({ ...COAT(), note: "x" })), ["apply.kind"]);
});

test("coat: только один и только в onUse.apply — не в событиях, не в степенях испытания, не внутри самого coat", () => {
  assert.deepEqual(keys({ v: 1, onUse: { targets: "self", apply: [COAT(), COAT()] } }), ["coat.place"]);
  assert.deepEqual(keys({ v: 1, onEvent: [{ on: "attack-roll", apply: [COAT()] }] }), ["coat.place"]);
  assert.deepEqual(keys({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 20 }, byDegree: { failure: [COAT()] } } } }), ["coat.place"]);
  assert.deepEqual(keys(ruleOf(COAT({ challenge: { ...CH(), byDegree: { failure: [COAT()] } } }))), ["coat.place"]);
});

test("внутренние поля носителя: gate и coatArm валидны для флага предмета; семантика каталога их не пускает", () => {
  assert.deepEqual(keys({ v: 1, onEvent: [{ on: "attack-roll", gate: ["target", "removed", "idle"], apply: [{ to: "self", coatArm: true }] }] }), []);
  assert.deepEqual(keys({ v: 1, onEvent: [{ on: "attack-roll", gate: ["x"], apply: [{ to: "self", coatArm: true }] }] }), ["ev.gate"]);
  assert.deepEqual(keys({ v: 1, onEvent: [{ on: "attack-roll", apply: [{ to: "self", coatArm: false }] }] }), ["coat.arm"]);
  const refs = { conditions: { sickened: 1, clumsy: 1, slowed: 1 }, effects: {} };
  assert.deepEqual(semanticErrors(validate(ruleOf()).rule, refs, null), []);
  assert.ok(semanticErrors(validate({ v: 1, onEvent: [{ on: "attack-roll", gate: ["target"], apply: [{ to: "self", coatArm: true }] }] }).rule, refs, null).some((e) => /internal/.test(e)));
});

test("semanticErrors: coat без недуга/состояния на цели — ошибка; состояния недуга внутри coat проверяются; against.dc известный", () => {
  const refs = { conditions: { sickened: 1 }, effects: {} };
  const bare = validate(ruleOf(COAT({ challenge: { ...CH(), byDegree: { failure: [{ to: "target", note: "x" }] } } }))).rule;
  assert.ok(semanticErrors(bare, refs, null).some((e) => /does nothing/.test(e)));
  const cond = validate(ruleOf(COAT({ challenge: { ...CH(), byDegree: { failure: [{ to: "target", condition: { slug: "clumsy", value: 1 } }] } } }))).rule;
  assert.deepEqual(semanticErrors(cond, { conditions: { clumsy: 1 }, effects: {} }, null), []);
  assert.ok(semanticErrors(cond, refs, null).some((e) => /clumsy/.test(e)));
  assert.ok(semanticErrors(validate(ruleOf(COAT({ challenge: CH({ against: "bogus" }) }))).rule, { conditions: { sickened: 1, clumsy: 1, slowed: 1 }, effects: {} }, null).some((e) => /bogus/.test(e)));
});

test("форма: coat переживает ruleToForm -> formToRule и roundTrip (шаг не пропадает как «note»)", () => {
  const r = validate(ruleOf(COAT({ duration: { value: 1, unit: "rounds", expiry: "turn-end" } }))).rule;
  const back = validate(formToRule(ruleToForm(r)));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.rule.onUse.apply, r.onUse.apply);
  assert.equal(roundTrip(r), true);
});

test("coatOf: onUse.challenge уходит в шаг coat, использование — на себя, остальные шаги остаются; без испытания — null", () => {
  const base = validate({ v: 1, label: "Spider Venom", onUse: { targets: "selected", challenge: CH(), apply: [{ to: "self", note: "n" }] } }).rule;
  const c = coatOf(base, { duration: { value: 1, unit: "rounds", expiry: "turn-end" } });
  assert.equal(c.onUse.challenge, null);
  assert.equal(c.onUse.targets, "self");
  assert.deepEqual(c.onUse.apply.map((a) => Object.keys(a).filter((k) => k !== "to")[0]), ["coat", "note"]);
  assert.deepEqual(c.onUse.apply[0].coat.duration, { value: 1, unit: "rounds", expiry: "turn-end" });
  assert.equal(validate(c).ok, true);
  assert.equal(coatOf(validate({ v: 1, onUse: { targets: "self", apply: [{ to: "self", note: "n" }] } }).rule), null);
});

/* ---------- чистые функции ---------- */

const C0 = { weapon: "w1", slug: "coat-spider-venom-w1", ammo: false, poison: "Spider Venom", challenge: validate({ v: 1, onUse: { targets: "selected", challenge: CH() } }).rule.onUse.challenge };
const evs = (c, armed) => coat.coatEvents(c, armed).onEvent;

test("coatEvents: не взведён — крит. провал тратит, успех взводит; боеприпасы — любой исход тратит; все варианты проходят валидатор", () => {
  const plain = evs(C0, false);
  assert.deepEqual(plain.map((e) => [e.on, e.when.at(-1)]), [["attack-roll", "outcome:criticalFailure"], ["attack-roll", { or: ["outcome:success", "outcome:criticalSuccess"] }]]);
  assert.deepEqual(plain[0].apply, [{ to: "self", removeEffect: { slug: C0.slug } }]);
  assert.deepEqual(plain[1].apply, [{ to: "self", coatArm: true }]);
  assert.ok(plain.every((e) => e.when[0] === "item:id:w1" && e.side === "self"));
  const ammo = evs({ ...C0, ammo: true }, false);
  assert.deepEqual(ammo.map((e) => [e.when, e.apply]), [[["item:id:w1"], [{ to: "self", removeEffect: { slug: C0.slug } }]]]);
  for (const c of [C0, { ...C0, ammo: true }]) for (const armed of [false, true]) {
    const r = validate(coat.coatEvents(c, armed));
    assert.deepEqual(r.errors, [], `${c.ammo}/${armed}`);
    assert.equal(r.rule.onEvent.length, evs(c, armed).length);
  }
});

test("coatEvents: взведён — испытание при потере ОЗ (в т.ч. временных) и колющем/рубящем; иначе трата без испытания; конец хода тратит; Удар тратит только вне боя", () => {
  const [hit, spend, turnEnd, next] = validate(coat.coatEvents(C0, true)).rule.onEvent;
  assert.deepEqual([hit.on, hit.side, hit.gate, !!hit.challenge, hit.challenge.dc], ["damage-taken", "origin", ["target", "removed"], true, { value: 22 }]);
  assert.deepEqual([spend.gate, spend.challenge], [["target"], undefined]);
  assert.deepEqual([turnEnd.on, turnEnd.side, turnEnd.when, turnEnd.apply], ["turn-end", "self", undefined, [{ to: "self", removeEffect: { slug: C0.slug } }]]);
  assert.deepEqual([next.on, next.when, next.gate, next.challenge], ["attack-roll", ["item:id:w1"], ["idle"], undefined]);
  const opts = (...o) => new Set(["damage-taken", "item:id:w1", ...o]);
  const pass = (e, o) => ev.matchEntries({ onEvent: [e] }, e.on, e.side, o).length === 1;
  assert.equal(pass(hit, opts("damage-taken:hp", "item:damage:type:slashing")), true);
  assert.equal(pass(hit, opts("damage-taken:temp", "item:damage:type:piercing")), true);      // урон целиком во временные ОЗ — урон нанесён
  assert.equal(pass(hit, opts("damage-taken:hp", "item:damage:type:bludgeoning")), false);   // дробящее: испытания нет
  assert.equal(pass(hit, opts("item:damage:type:slashing")), false);                          // ни ОЗ, ни временные не убыли (щит)
  assert.equal(pass(spend, opts("item:damage:type:bludgeoning", "damage-taken:hp")), true);
  assert.equal(pass(spend, opts("item:damage:type:slashing")), true);
  assert.equal(pass(spend, opts("damage-taken:hp", "item:damage:type:piercing")), false);     // испытание — другая запись
  assert.equal(pass(spend, opts("damage-taken:temp", "item:damage:type:piercing")), false);
  assert.equal(pass(hit, new Set(["damage-taken", "damage-taken:hp", "item:damage:type:slashing", "item:id:w2"])), false);   // урон другим оружием
});

test("damageOptions: временные ОЗ — damage-taken:temp, лечение их не даёт", () => {
  const t = { updates: [{ path: "system.attributes.hp.temp", value: 5 }] };
  assert.deepEqual(ev.damageOptions(t), ["damage-taken", "damage-taken:temp"]);
  assert.deepEqual(ev.damageOptions({ ...t, isHealing: true }), ["damage-taken", "damage-taken:healing"]);
});

test("признак боеприпасов: expend > 0 и не встроенный — не зависит от выбранного боеприпаса; s/p — по опциям предмета", () => {
  assert.equal(coat.takesAmmo({ system: { expend: 1 } }), true);
  assert.equal(coat.takesAmmo({ system: { expend: 1, ammo: { builtIn: true } } }), false);
  assert.equal(coat.takesAmmo({ system: { expend: null } }), false);
  assert.equal(coat.takesAmmo({ system: {} }), false);
  const w = (...o) => ({ getRollOptions: (p) => o.map((x) => `${p}:${x}`) });
  assert.deepEqual([w("damage:type:slashing"), w("damage:type:piercing"), w("damage:type:bludgeoning"), w()].map(coat.hasSP), [true, true, false, false]);
  assert.equal(coat.coatSlug("spider-venom", "w1"), "coat-spider-venom-w1");
});

test("coatDc: число как есть; против защиты автора и класса — через resolveDC в число", async () => {
  assert.equal(await coat.coatDc(CH({ value: 22 })), 22);
  const actor = { getStatistic: (s) => ({ dc: { value: s === "class-spell" ? 19 : 0 } }) };
  assert.equal(await coat.coatDc(CH({ against: "class-spell" }), { actor }), 19);
  assert.equal(await coat.coatDc(CH({ against: "class-spell" }), { actor: {} }), null);
});

/* ---------- мир ---------- */

let nid = 0;
function mkActor(uuid, { type = "character", weapons = [] } = {}) {
  const items = Object.assign([], { has(id) { return items.some((i) => i.id === id); }, get(id) { return items.find((i) => i.id === id); } });
  const actor = {
    uuid, name: uuid, id: uuid.split(".").pop(), type, level: 5, attributes: { immunities: [] }, items, rollOptions: {}, isDead: false, hasPlayerOwner: false, tokens: [],
    get itemTypes() { return Object.fromEntries(["weapon", "melee", "effect", "condition"].map((t) => [t, items.filter((i) => i.type === t)])); },
    getActiveTokens() { return this.tokens; }, getRollOptions: () => [], getSelfRollOptions: (p) => [`${p}:test`], testUserPermission: () => true, getStatistic: (s) => ({ dc: { value: s === "class-spell" ? 19 : 0 } }),
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: d._id ?? `n${++nid}`, actor, parent: actor, isLocked: false, _stats: d._stats ?? {} };
        it.uuid = `${uuid}.Item.${it.id}`; it.slug = d.system?.slug ?? d.name;
        it.toObject = () => structuredClone({ name: it.name, type: it.type, system: it.system, flags: it.flags });
        it.delete = async () => { items.splice(items.indexOf(it), 1); uuids.delete(it.uuid); };
        it.update = async (up) => { for (const [p, v] of Object.entries(up)) { const cur = foundry.utils.getProperty(it, p); setDeep(it, p, isPlain(v) && isPlain(cur) ? merge(cur, v) : structuredClone(v)); } };
        uuids.set(it.uuid, it); items.push(it);
        return it;
      });
    }
  };
  for (const w of weapons) mkWeapon(actor, w);
  uuids.set(uuid, actor);
  return actor;
}
function mkWeapon(actor, { id, name, dmg = "slashing", expend = null, carry = "held", type = "weapon" }) {
  const w = { id, type, name, uuid: `${actor.uuid}.Item.${id}`, actor, parent: actor, slug: id, flags: {}, system: { expend, equipped: { carryType: carry } }, getRollOptions: (p) => [`${p}:id:${id}`, `${p}:damage:type:${dmg}`] };
  actor.items.push(w); uuids.set(w.uuid, w);
  return w;
}
const mkToken = (id, actor) => { const t = { id, uuid: `Scene.s.Token.${id}`, name: id, actor, disposition: -1 }; actor.tokens = [t]; uuids.set(t.uuid, t); return t; };
const mkPoison = (name = "Spider Venom") => { const p = { uuid: `Item.${name}`, name, type: "consumable", slug: name.toLowerCase().replace(/ /g, "-"), img: "p.svg", system: { traits: { value: ["poison", "injury"] } } }; uuids.set(p.uuid, p); return p; };

function world(o = {}) {
  const hero = mkActor("Actor.hero", { weapons: [{ id: "w1", name: "Longsword" }, ...(o.weapons ?? [])] });
  const foe = mkActor("Actor.foe", { type: "npc" }), other = mkActor("Actor.other", { type: "npc" });
  const ht = mkToken("ht", hero), ft = mkToken("ft", foe), ot = mkToken("ot", other);
  return { hero, foe, other, ht, ft, ot, venom: mkPoison() };
}

let mid = 0;
async function applyCoat(w, { poison = w.venom, step = COAT(), message = null } = {}) {
  const rule = validate(ruleOf(step)).rule;
  const m = message ?? { id: `U${++mid}`, flags: { [MOD]: { use: { v: 1, kind: "use", rule, actor: w.hero.uuid, token: w.ht.uuid, item: { uuid: poison.uuid, name: poison.name }, targets: [], state: {} } } }, async update(d) { for (const [p, v] of Object.entries(d)) setDeep(m, p, v); } };
  msgs.set(m.id, m);
  const ops = await applyOps(m, "self", rule.onUse.apply, { scope: "apply" });
  return { m, ops };
}
const carriers = (a) => a.items.filter((i) => i.flags?.[MOD]?.coat);
const carrier = (a) => carriers(a)[0];
const cards = () => created.filter((m) => m.flags?.[MOD]?.use?.state?.event);
const whispers = (key) => created.filter((m) => m.whisper && String(m.content).includes(`coat.${key}`));

const attack = (w, outcome, { id = `A${++mid}`, weapon = "w1", extra = {} } = {}) => {
  const m = { id, actor: w.hero, token: w.ht, flags: { pf2e: { context: { type: "attack-roll", options: [`item:id:${weapon}`], outcome, target: { actor: w.foe.uuid, token: w.ft.uuid }, ...extra } } }, rolls: [], async update(d) { for (const [p, v] of Object.entries(d)) setDeep(m, p, v); } };
  msgs.set(id, m);
  return m;
};
const HP = { updates: [{ path: "system.attributes.hp.value", value: 6 }] };
const damage = (w, { id = `D${++mid}`, applied = HP, options = ["item:id:w1", "item:damage:type:slashing"], victim = "foe" } = {}) => {
  const a = w[victim], t = w[{ foe: "ft", other: "ot" }[victim]];
  const m = { id, actor: a, token: t, flags: { pf2e: { context: { type: "damage-taken", options }, appliedDamage: applied, origin: { actor: w.hero.uuid } } }, rolls: [], async update(d) { for (const [p, v] of Object.entries(d)) setDeep(m, p, v); } };
  msgs.set(id, m);
  return m;
};
const send = (m) => ev.onMessage(m);

/* ---------- нанесение ---------- */

test("нанесение: носитель на оружии — slug с id оружия, бессрочный, правило и снимок СЛ/недуга во флагах; повтор той же карточки — второго нет", async () => {
  const w = world();
  const { m, ops } = await applyCoat(w);
  const c = carrier(w.hero);
  assert.deepEqual(ops.map((o) => o.op), ["coatMade"]);
  assert.equal(carriers(w.hero).length, 1);
  assert.equal(c.system.slug, "coat-spider-venom-w1");
  assert.deepEqual(c.system.duration, { sustained: false, value: -1, unit: "unlimited", expiry: null });
  assert.deepEqual([c.flags[MOD].coat.weapon, c.flags[MOD].coat.ammo, c.flags[MOD].coat.challenge.dc], ["w1", false, { value: 22 }]);
  assert.deepEqual(c.flags[MOD].rule.onEvent.length, 2);
  assert.equal(c.flags[MOD].meta.key, `${m.id}:self:0`);
  assert.equal(validate(c.flags[MOD].rule).ok, true);
  await applyCoat(w, { message: m });   // повтор кнопки
  assert.equal(carriers(w.hero).length, 1);
});

test("нанесение: оружие без выбора — единственное годное (брошенное и в рюкзаке не в счёт); нет оружия — шёпот; боеприпасы — признак на носителе; СЛ against — числом", async () => {
  const w = world({ weapons: [{ id: "w2", name: "Dropped", carry: "dropped" }, { id: "w3", name: "Stowed", carry: "stowed" }] });
  await applyCoat(w, { step: COAT({ challenge: CH({ against: "class-spell" }) }) });
  assert.equal(carrier(w.hero).flags[MOD].coat.weapon, "w1");
  assert.deepEqual(carrier(w.hero).flags[MOD].coat.challenge.dc, { value: 19 }, "против защиты автора — в число при нанесении");
  const b = world({ weapons: [] }); b.hero.items.splice(0);
  await applyCoat(b);
  assert.equal(carriers(b.hero).length, 0);
  assert.equal(whispers("noWeapon").length, 1);
  const bow = world({ weapons: [{ id: "bow", name: "Bow", expend: 1 }] });
  bow.hero.items.splice(bow.hero.items.findIndex((i) => i.id === "w1"), 1);
  await applyCoat(bow);
  assert.equal(carrier(bow.hero).flags[MOD].coat.ammo, true);
  assert.equal(carrier(bow.hero).flags[MOD].rule.onEvent.length, 1);
});
test("нанесение: несколько оружий — выбор игроком-автором; закрытое окно — ничего не создано", async () => {
  const w = world({ weapons: [{ id: "w2", name: "Club", dmg: "bludgeoning" }] });
  let asked = null;
  setSocket({ executeAsUser: async (_n, _id, data) => { asked = data; return data.choices[1].value; } });
  const author = { isGM: false, active: true, id: "p1" };
  const rule = validate(ruleOf()).rule;
  const mk = () => ({ id: `U${++mid}`, author, flags: { [MOD]: { use: { v: 1, kind: "use", rule, actor: w.hero.uuid, token: w.ht.uuid, item: { uuid: w.venom.uuid, name: "Spider Venom" }, targets: [], state: {} } } }, async update() {} });
  await applyCoat(w, { message: mk() });
  assert.equal(carrier(w.hero).flags[MOD].coat.weapon, "w2");
  assert.ok(asked.choices[1].label.includes("coat.noSP"), "дробящее помечено в окне");
  assert.ok(!asked.choices[0].label.includes("coat.noSP"));
  const w2 = world({ weapons: [{ id: "w2", name: "Club" }] });
  setSocket({ executeAsUser: async () => null });
  await applyCoat(w2, { message: mk() });
  assert.equal(carriers(w2.hero).length, 0);
});

test("режимы: effect != auto — шёпот needsAuto, носитель не создаётся", async () => {
  const w = world();
  settings["mode.effect"] = "button";
  const { ops } = await applyCoat(w);
  assert.deepEqual(ops, []);
  assert.equal(carriers(w.hero).length, 0);
  assert.equal(whispers("needsAuto").length, 1);
});

/* ---------- события: трата, взвод ---------- */

test("Удар попал -> взвод (цель и «взведённое» правило), урон по цели с потерей ОЗ -> яд потрачен, одна карточка испытания против СЛ", async () => {
  const w = world();
  await applyCoat(w);
  const c = carrier(w.hero);
  await send(attack(w, "success"));
  assert.equal(c.flags[MOD].coat.armed.target, w.ft.uuid);
  assert.deepEqual(c.flags[MOD].rule.onEvent.map((e) => e.on), ["damage-taken", "damage-taken", "turn-end", "attack-roll"]);
  assert.equal(carriers(w.hero).length, 1);
  assert.equal(cards().length, 0);
  await send(damage(w));
  assert.equal(carriers(w.hero).length, 0, "яд потрачен");
  assert.equal(cards().length, 1);
  const use = cards()[0].flags[MOD].use;
  assert.deepEqual([use.rule.onUse.challenge.statistic, use.rule.onUse.challenge.dc, use.targets[0].uuid], ["fortitude", { value: 22 }, w.ft.uuid]);
  assert.equal(use.rule.onUse.challenge.byDegree.failure[0].affliction.def.name, "Spider Venom");
});

test("крит. провал Удара — трата без испытания; промах — ничего, яд остался и не взведён", async () => {
  const w = world();
  await applyCoat(w);
  await send(attack(w, "failure"));
  assert.equal(carriers(w.hero).length, 1);
  assert.equal(carrier(w.hero).flags[MOD].coat.armed, undefined);
  assert.equal(carrier(w.hero).flags[MOD].rule.onEvent.length, 2);
  await send(attack(w, "criticalFailure"));
  assert.equal(carriers(w.hero).length, 0);
  assert.equal(cards().length, 0);
});

test("урон: щит или не колющий/рубящий тип — яд потрачен без испытания; временные ОЗ — испытание (урон нанесён)", async () => {
  for (const [d, trial] of [[{ applied: { updates: [], shield: { damage: 5 } } }, 0], [{ options: ["item:id:w1", "item:damage:type:bludgeoning"] }, 0], [{ applied: { updates: [{ path: "system.attributes.hp.temp", value: 4 }] } }, 1]]) {
    const w = world();
    await applyCoat(w);
    await send(attack(w, "criticalSuccess"));
    await send(damage(w, d));
    assert.equal(carriers(w.hero).length, 0, JSON.stringify(d));
    assert.equal(cards().length, trial, JSON.stringify(d));
  }
});

// конец хода владельца: pf2e.endTurn -> onTurn("turn-end"); combatant.actor — владелец яда
const endTurn = (w, n = 1) => ev.onTurn("turn-end")({ id: "cb", actor: w.hero }, { id: "enc", round: 1, turn: n });
const inCombat = (w, fn) => { game.combats = [{ started: true, combatants: [{ actor: w.hero }] }]; return fn().finally(() => { game.combats = []; }); };

test("урон сведён к 0 — pf2e сообщения не пишет (appliedDamage: null, onMessage его отбрасывает): конец хода владельца тратит яд без испытания", async () => {
  const w = world();
  await applyCoat(w);
  await inCombat(w, async () => {
    await send(attack(w, "success"));
    await send(damage(w, { applied: null }));
    assert.equal(carriers(w.hero).length, 1, "сообщения нет — носитель ждёт");
    await endTurn(w);
    assert.equal(carriers(w.hero).length, 0);
    assert.equal(cards().length, 0);
  });
});

test("урон другой цели (область) взведённого яда не трогает; урон без item:id оружия (тик, чужой урон) — тоже", async () => {
  const w = world();
  await applyCoat(w);
  await send(attack(w, "success"));
  await send(damage(w, { victim: "other" }));
  await send(damage(w, { options: ["item:damage:type:slashing"] }));
  assert.equal(carriers(w.hero).length, 1);
  assert.equal(cards().length, 0);
  await send(damage(w));
  assert.equal(carriers(w.hero).length, 0);
  assert.equal(cards().length, 1);
});

test("попавший Удар забирает яд: в бою следующие Удары его не несут и не тратят (и не переносят на другую цель), конец хода тратит без испытания", async () => {
  const w = world();
  await applyCoat(w);
  await inCombat(w, async () => {
    await send(attack(w, "success"));
    await send(attack(w, "success", { extra: { target: { actor: w.other.uuid, token: w.ot.uuid } } }));
    await send(attack(w, "criticalFailure"));
    assert.equal(carriers(w.hero).length, 1, "Удары яд не тратят");
    assert.equal(carrier(w.hero).flags[MOD].coat.armed.target, w.ft.uuid, "цель взвода прежняя");
    await endTurn(w);
    assert.equal(carriers(w.hero).length, 0);
    assert.equal(cards().length, 0);
    await send(damage(w));   // урон после конца хода: яда уже нет
    assert.equal(cards().length, 0);
  });
});

test("два Удара до урона: одно испытание — по урону первого; урон второй цели яд не трогает", async () => {
  const w = world();
  await applyCoat(w);
  await inCombat(w, async () => {
    await send(attack(w, "success"));
    await send(attack(w, "success", { extra: { target: { actor: w.other.uuid, token: w.ot.uuid } } }));
    await send(damage(w, { victim: "other" }));
    assert.equal(carriers(w.hero).length, 1);
    await send(damage(w));
    assert.equal(carriers(w.hero).length, 0);
    assert.equal(cards().length, 1);
    assert.equal(cards()[0].flags[MOD].use.targets[0].uuid, w.ft.uuid);
  });
});

test("вне боя конца хода нет: следующий Удар этим оружием тратит взведённый яд без испытания; потом Удары и урон яда не получают", async () => {
  const w = world();
  await applyCoat(w);
  await send(attack(w, "success"));
  await send(attack(w, "failure"));
  assert.equal(carriers(w.hero).length, 0);
  await send(damage(w));
  assert.equal(cards().length, 0);
});

test("урон применён до конца хода: испытание, конец хода уже нечего тратить", async () => {
  const w = world();
  await applyCoat(w);
  await inCombat(w, async () => {
    await send(attack(w, "success"));
    await send(damage(w));
    assert.equal(cards().length, 1);
    await endTurn(w);
    assert.equal(cards().length, 1);
  });
});

test("истёкший носитель (автоистечение pf2e выключено, isExpired) не срабатывает", async () => {
  const w = world();
  await applyCoat(w);
  carrier(w.hero).isExpired = true;
  await send(attack(w, "criticalFailure"));
  assert.equal(carriers(w.hero).length, 1);
});

test("промах (не крит.) не тратит и не взводит яд, и применённый после него урон носитель не трогает (взвода нет — записей урона нет)", async () => {
  const w = world();
  await applyCoat(w);
  await send(attack(w, "failure"));
  await send(damage(w));
  await send(damage(w));
  assert.equal(carriers(w.hero).length, 1);
  assert.equal(carrier(w.hero).flags[MOD].coat.armed, undefined);
  assert.equal(cards().length, 0);
});

test("Удар другим оружием яд не трогает и не взводит", async () => {
  const w = world();
  await applyCoat(w);
  mkWeapon(w.hero, { id: "w2", name: "Dagger" });
  await send(attack(w, "success", { weapon: "w2" }));
  await send(attack(w, "criticalFailure", { weapon: "w2" }));
  assert.equal(carriers(w.hero).length, 1);
  assert.equal(carrier(w.hero).flags[MOD].coat.armed, undefined);
});

test("оружие с боеприпасами: любой исход Удара тратит яд, испытания нет", async () => {
  for (const outcome of ["failure", "success", "criticalSuccess", "criticalFailure"]) {
    const w = world({ weapons: [{ id: "bow", name: "Bow", expend: 1 }] });
    w.hero.items.splice(w.hero.items.findIndex((i) => i.id === "w1"), 1);
    await applyCoat(w);
    await send(attack(w, outcome, { weapon: "bow" }));
    assert.equal(carriers(w.hero).length, 0, outcome);
    assert.equal(cards().length, 0, outcome);
  }
});

test("яд у NPC: кандидаты — только melee (оружие инвентаря даёт свой связанный melee, дубля нет); Удар NPC -> испытание цели", async () => {
  const w = world();
  w.hero.type = "npc";
  mkWeapon(w.hero, { id: "claw", name: "Claw", type: "melee" });
  mkWeapon(w.hero, { id: "sword", name: "Sword" });   // оружие инвентаря
  assert.deepEqual(coat.coatCandidates(w.hero).map((x) => x.id), ["claw"]);
  w.hero.items.splice(w.hero.items.findIndex((i) => i.id === "w1"), 1);
  await applyCoat(w);
  assert.equal(carrier(w.hero).flags[MOD].coat.weapon, "claw");
  await send(attack(w, "success", { weapon: "claw" }));
  await send(damage(w, { options: ["item:id:claw", "item:damage:type:slashing"] }));
  assert.equal(cards().length, 1);
});

test("яд у NPC: melee, связанный с оружием с боеприпасами (flags.pf2e.linkedWeapon) — яд тратится любым Ударом без испытания", async () => {
  const w = world();
  w.hero.type = "npc";
  w.hero.items.splice(0);
  mkWeapon(w.hero, { id: "bow", name: "Bow", expend: 1 });
  mkWeapon(w.hero, { id: "shot", name: "Shortbow", type: "melee" }).flags = { pf2e: { linkedWeapon: "bow" } };
  await applyCoat(w);
  assert.equal(carrier(w.hero).flags[MOD].coat.weapon, "shot");
  assert.equal(carrier(w.hero).flags[MOD].coat.ammo, true);
  await send(attack(w, "success", { weapon: "shot" }));
  assert.equal(carriers(w.hero).length, 0);
  assert.equal(cards().length, 0);
});

test("нанесение: не колющее/рубящее единственное оружие — заметка ведущему; гонка двух карточек на одно оружие — один носитель; старая карточка после траты не наносит заново", async () => {
  const w = world();
  w.hero.items.splice(0);
  mkWeapon(w.hero, { id: "club", name: "Club", dmg: "bludgeoning" });
  await applyCoat(w);
  assert.equal(whispers("noSPNote").length, 1);
  assert.equal(carriers(w.hero).length, 1);
  const r = world();
  const p2 = mkPoison("Wyvern Poison");
  await Promise.all([applyCoat(r), applyCoat(r, { poison: p2 })]);
  assert.equal(carriers(r.hero).length, 1, "два носителя на одно оружие");
  const a = world();
  const { m } = await applyCoat(a);
  await send(attack(a, "criticalFailure"));
  assert.equal(carriers(a.hero).length, 0);
  await applyCoat(a, { message: m });   // «Применить» на той же карточке
  assert.equal(carriers(a.hero).length, 0);
});

test("режим challenge = off: яд тратится, карточки нет", async () => {
  const w = world();
  await applyCoat(w);
  await send(attack(w, "success"));
  settings["mode.challenge"] = "off";
  await send(damage(w));
  assert.equal(carriers(w.hero).length, 0);
  assert.equal(cards().length, 0);
});

test("гонка двух Ударов: запись урона, не нашедшая носителя (снятие skipped), испытания не запускает — одна карточка на два сообщения", async () => {
  const w = world();
  await applyCoat(w);
  await send(attack(w, "success"));
  const item = carrier(w.hero), found = { item, rule: ev.eventRuleOf(item) };
  const hit = found.rule.onEvent.findIndex((e) => e.challenge);
  const mk = (id) => ({ id, options: new Set(["damage-taken", "damage-taken:hp", "item:id:w1", "item:damage:type:slashing"]), other: w.foe, otherToken: w.ft, message: null });
  const r1 = await ev.runEntry(mk("R1"), w.hero, found, { i: hit, entry: found.rule.onEvent[hit] });
  const r2 = await ev.runEntry(mk("R2"), w.hero, found, { i: hit, entry: found.rule.onEvent[hit] });   // носитель уже снят: removeEffect не снимает ничего
  assert.ok(r1.host);
  assert.equal(r2?.host ?? null, null);
  assert.equal(cards().length, 1);
});

/* ---------- замена и откат ---------- */

test("замена: второй яд на то же оружие снимает первый, шёпот «заменён»; откат карточки второго возвращает первый и снимает второй", async () => {
  const w = world();
  const first = await applyCoat(w);
  const old = carrier(w.hero);
  const p2 = mkPoison("Wyvern Poison");
  const second = await applyCoat(w, { poison: p2 });
  assert.equal(carriers(w.hero).length, 1);
  assert.equal(carrier(w.hero).flags[MOD].coat.poison, "Wyvern Poison");
  assert.equal(carrier(w.hero).system.slug, "coat-wyvern-poison-w1");
  assert.equal(whispers("replaced").length, 1);
  assert.deepEqual(second.ops.map((o) => o.op), ["effRemoved", "coatMade"]);
  await undoOps(second.m, "self");
  assert.equal(carriers(w.hero).length, 1);
  assert.equal(carrier(w.hero).flags[MOD].coat.poison, "Spider Venom");
  assert.notEqual(carrier(w.hero).id, old.id, "пересоздан с новым id");
  assert.equal(first.ops.length, 1);
});

test("откат карточки яда снимает носитель, даже пересозданный (новый id): ищется по ключу шага, не по uuid", async () => {
  const w = world();
  const { m } = await applyCoat(w);
  await send(attack(w, "criticalFailure", { id: "AX" }));   // трата
  assert.equal(carriers(w.hero).length, 0);
  const log = msgs.get("AX").flags[MOD].events;
  for (const rec of log) for (const { tk, ops } of rec.recs) await undoOps(ev.makeTwin(`ev:${rec.key}`, { state: { apply: { [tk]: { ops } } } }), tk);   // как undoLog при переброске
  assert.equal(carriers(w.hero).length, 1, "носитель восстановлен");
  await undoOps(m, "self");
  assert.equal(carriers(w.hero).length, 0);
});

test("откат взвода: переброс Удара вернул правило и цель как были; повтор Удара взводит заново", async () => {
  const w = world();
  await applyCoat(w);
  const m1 = attack(w, "success", { id: "R1" });
  await send(m1);
  assert.ok(carrier(w.hero).flags[MOD].coat.armed);
  ev.onDeleteMessage(m1); msgs.delete("R1");
  await send(attack(w, "failure", { id: "R2", extra: { isReroll: true } }));   // переброс: промах
  const c = carrier(w.hero);
  assert.equal(c.flags[MOD].coat.armed, null);
  assert.equal(c.flags[MOD].rule.onEvent.length, 2);
  assert.equal(c.flags[MOD].rule.onEvent[1].apply[0].coatArm, true);
  await send(attack(w, "success", { id: "R3" }));
  assert.equal(carrier(w.hero).flags[MOD].coat.armed.target, w.ft.uuid);
});

test("откат после взвода идёт путём effRemoved -> undoOps: восстановленный носитель остаётся взведённым и правило у него взведённое", async () => {
  const w = world();
  await applyCoat(w);
  await send(attack(w, "success", { id: "S1" }));
  await send(attack(w, "failure", { id: "S2" }));   // яд потрачен следующим Ударом
  assert.equal(carriers(w.hero).length, 0);
  const log = msgs.get("S2").flags[MOD].events;
  assert.equal(log[0].recs[0].ops[0].op, "effRemoved");
  assert.ok(log[0].recs[0].ops[0].data[0].flags[MOD].coat.armed, "снимок документа хранит взвод");
  for (const rec of log) for (const { tk, ops } of rec.recs) await undoOps(ev.makeTwin(`ev:${rec.key}`, { state: { apply: { [tk]: { ops } } } }), tk);
  const c = carrier(w.hero);
  assert.ok(c, "носитель вернулся");
  assert.equal(c.flags[MOD].coat.armed.target, w.ft.uuid);
  assert.deepEqual(c.flags[MOD].rule.onEvent.map((e) => e.on), ["damage-taken", "damage-taken", "turn-end", "attack-roll"]);
  await send(damage(w));   // после отката урон снова тратит яд и бросает испытание
  assert.equal(cards().length, 1);
  assert.equal(carriers(w.hero).length, 0);
});

test("Envenom: срок носителя — из шага (до конца следующего хода владельца)", async () => {
  const w = world();
  await applyCoat(w, { step: COAT({ duration: { value: 1, unit: "rounds", expiry: "turn-end" } }) });
  assert.deepEqual(carrier(w.hero).system.duration, { sustained: false, value: 1, unit: "rounds", expiry: "turn-end" });
});

test("slug носителя — только [a-z0-9-] (SLUG валидатора): кириллическое имя яда без slug (последняя доза) не делает правило носителя невалидным", async () => {
  assert.match(coat.coatSlug("af-яд-a", "W1"), /^[a-z0-9-]+$/);
  assert.match(coat.coatSlug("яд", "w1"), /^[a-z0-9-]+$/);
  const w = world();
  const p = mkPoison("AF яд A");
  await applyCoat(w, { poison: p });
  uuids.delete(p.uuid);   // последняя доза: pf2e удалил расходник до Удара; slug носителя берётся из имени
  assert.equal(validate(carrier(w.hero).flags[MOD].rule).ok, true);
  await send(attack(w, "success"));
  await send(damage(w));
  assert.equal(carriers(w.hero).length, 0, "яд потрачен");
  assert.equal(cards().length, 1, "испытание из снимка");
});
