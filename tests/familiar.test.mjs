// L1-W02 «способность фамильяра» (docs/plan-familiar.md): валидатор, каталог первой партии, запуск при сотворении/Поддержании, дальность от токена фамильяра, СЛ и бросающий WF07.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = {};
let msgs, uuids, created, dialogs, actors, scene, world, now;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v; return a; };
globalThis.game = {
  user: { isActiveGM: true, isGM: true, id: "gm" }, users: [{ id: "gm", isGM: true }],
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k, has: () => true },
  modules: { get: () => null },
  messages: { get: (id) => msgs.get(id), find: (fn) => [...msgs.values()].find(fn), get contents() { return [...msgs.values()]; } },
  get actors() { return actors; },
  get combats() { return world.combat ? [{ ...world.combat, started: true, combatants: [{ actor: world.witch }] }] : []; },
  get combat() { return world.combat ?? null; },
  pf2e: { ConditionManager: { conditions: new Map(), getCondition: (slug) => ({ uuid: null, _stats: { compendiumSource: `Compendium.pf2e.conditionitems.Item.${slug}` }, name: slug, img: "i.svg", system: { value: { isValued: true } }, toObject() { return { name: slug, type: "condition", system: { slug, value: { isValued: true, value: null } } }; } }) } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { applications: { api: { DialogV2: { wait: async (c) => {
  const labels = [...c.content.matchAll(/<option value="\d+">([^<]*)<\/option>/g)].map((m) => m[1]);
  dialogs.shown.push(labels);
  const p = dialogs.pick, i = typeof p === "string" ? labels.indexOf(p) : p;
  return i == null || i < 0 ? null : { action: "ok", form: { choice: String(i) } };
} } } }, data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) },
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => structuredClone(o), setProperty: setDeep, mergeObject: merge, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: {} } } } }, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const sustain = await import("../scripts/sustain.mjs");
const fam = await import("../scripts/familiar.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const CAT = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8")).bySource;
const FA = (id) => `Compendium.pf2e.familiar-abilities.Item.${id}`;
const WF = { WF01: FA("6ZmgkMHUGGb1mDhr"), WF06: FA("HNoR0D2sKQaDNh5Z"), WF07: FA("J5Wyh1EPmk848ivR"), WF09: FA("ZCze1FY3Rmnvd6Dx"), WF10: FA("bhpa7DVdMsaNfodz") };
const FE = (id) => `Compendium.pf2e.feat-effects.Item.${id}`;
const validate = rules.validateRule;

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = []; dialogs = { shown: [], pick: 0 }; actors = []; world = { combat: { id: "c1", round: 1 } }; now = 1_000_000;
  Date.now = () => now;
});

/* ---------- мир ---------- */

scene = { tokens: [], grid: { size: 100, measurePath: ([a, b]) => ({ distance: (Math.hypot(a.x - b.x, a.y - b.y) / 100) * 5 }) } };
scene.tokens.filter = Array.prototype.filter;
const effectDoc = (uuid, over = {}) => ({ type: "effect", name: uuid.split(".").pop(), toObject: () => structuredClone({ name: uuid, type: "effect", system: { rules: [], duration: { value: 1, unit: "rounds", expiry: "turn-end" }, level: { value: 1 }, ...over }, flags: {} }) });
const DC = 19;

function mkActor(name, { type = "npc", side = "foe", hp = 10, max = 10, x = 0, items = [], level = 1, master = null, down = false } = {}) {
  const list = [];
  let n = 0;
  const a = { uuid: `Actor.${name}`, name, id: name, type, level, side, system: { master: master ? { id: master } : undefined }, items: list, hitPoints: { value: hp, max }, isDead: false,
    hasCondition: (s) => down && s === "unconscious", getActiveTokens: () => [], testUserPermission: () => false, parties: [],
    getRollOptions: () => [`hp-percent:${Math.floor((a.hitPoints.value / a.hitPoints.max) * 100)}`], getSelfRollOptions: (p) => [`${p}:test`],
    isEnemyOf: (o) => o.side !== a.side, isAllyOf: (o) => o.side === a.side,
    get itemTypes() { return { condition: list.filter((i) => i.type === "condition"), effect: list.filter((i) => i.type === "effect") }; },
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: `${name}.i${++n}`, uuid: `Actor.${name}.Item.i${n}`, actor: a, isExpired: false };
        it.update = async (ch) => { for (const [p, v] of Object.entries(ch)) setDeep(it, p, v); };
        it.delete = async (opts) => { list.splice(list.indexOf(it), 1); await sustain.onDeleteItem(it, opts); };
        list.push(it); uuids.set(it.uuid, it);
        return it;
      });
    } };
  const tok = { id: `T${name}`, uuid: `Scene.s.Token.T${name}`, actorId: name, name, actor: a, parent: scene, x: x * 100, y: 0, width: 1, height: 1, disposition: side === "foe" ? -1 : 1, hidden: false };
  a.token = tok;
  actors.push(a); scene.tokens.push(tok); uuids.set(a.uuid, a); uuids.set(tok.uuid, tok);
  for (const i of items) { i.actor = a; i.parent = a; list.push(i); uuids.set(i.uuid, i); }
  return a;
}
const ability = (wf) => { const rule = validate({ v: 1, onEvent: CAT[WF[wf]].onEvent }).rule; return { type: "action", id: wf, uuid: `Actor.fam.Item.${wf}`, name: wf, slug: wf.toLowerCase(), system: {}, flags: { [MOD]: { rule } } }; };
const SPELL = (over = {}) => ({ type: "spell", uuid: "Item.evil-eye", name: "Evil Eye", slug: "evil-eye", img: "ee.svg", system: { duration: { value: "", sustained: true }, range: { value: "30 feet" } }, getRollOptions: (p) => [`${p}:trait:hex`], spellcasting: { statistic: { dc: { value: DC } } }, ...over });
// ведьма x=0, фамильяр x=1; кандидаты: near x=4 (15 фт от фамильяра), mid x=5 (20), far x=9 (40); sick ОЗ задаются
function world1(wf = "WF10", { famOver = {}, withFam = true } = {}) {
  scene.tokens.length = 0;
  effectUuids();
  const witch = mkActor("witch", { type: "character", side: "pc", x: 0 });
  world.witch = witch;
  const f = withFam ? mkActor("fam", { type: "familiar", side: "pc", x: 1, master: witch.id, items: [ability(wf)], ...famOver }) : null;
  const near = mkActor("near", { x: 4 }), mid = mkActor("mid", { x: 5 }), far = mkActor("far", { x: 9 }), ally = mkActor("ally", { side: "pc", x: 2 });
  return { witch, fam: f, near, mid, far, ally, wtok: witch.token };
}
function effectUuids() {
  for (const id of ["0JvxhEv83bAD5PGv", "IgLMAwovQ9roTsRN", "twvhTLrLEfr7dz1m"]) uuids.set(FE(id), effectDoc(FE(id), id === "0JvxhEv83bAD5PGv" ? { rules: [{ key: "ChoiceSet", flag: "familiarOfBalancedLuck", choices: [{ value: -1 }, { value: 1 }] }] } : {}));
}
let msgN = 0;
const cast = (w, { spell = SPELL(), hex = true, targets = [], card = true } = {}) => {
  const id = `C${++msgN}`;
  const m = { id, item: spell, actor: w.witch, token: w.wtok, author: { targets: new Set(targets.map((t) => ({ document: t.token }))) },
    flags: { pf2e: { origin: { type: "spell", actor: w.witch.uuid, uuid: spell.uuid, castRank: 1, rollOptions: [...(card ? ["origin:action:slug:cast-a-spell"] : []), ...(hex ? ["origin:item:trait:hex"] : [])] } } },
    async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(id, m);
  uuids.set(spell.uuid, spell);
  return m;
};
const run = (m) => ev.onMessage(m);
const effectsOf = (a) => a.items.filter((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.source === "apply");
const mine = (a) => a.items.filter((i) => i.flags?.[MOD]?.meta?.message?.startsWith?.("ev:") && i.flags[MOD].meta.source !== "sustain");
const hostCards = () => created.filter((c) => c.flags?.[MOD]?.use);

/* ---------- 1. валидатор и каталог ---------- */

test("валидатор: on строкой и массивом, side:familiar, creatures/where", () => {
  const e = CAT[WF.WF10].onEvent[0];
  const ok = (p) => validate({ v: 1, onEvent: [{ ...e, ...p }] });
  assert.deepEqual(ok({}).errors, []);
  assert.deepEqual(ok({}).rule.onEvent[0].on, ["spell-cast", "spell-sustain"]);
  assert.equal(ok({ on: "spell-cast" }).rule.onEvent[0].on, "spell-cast");
  assert.equal(ok({ on: "spell-sustain" }).ok, true);
  assert.equal(ok({ side: "self" }).ok, false);   // spell-sustain только у familiar
  assert.equal(ok({ on: ["spell-cast", "turn-start"] }).ok, false);   // familiar — только сотворение/Поддержание
  assert.equal(ok({ on: ["spell-cast", "spell-cast"] }).ok, false);
  assert.equal(validate({ v: 1, onEvent: [{ on: ["spell-cast", "turn-start"], side: "self", apply: [{ to: "self", condition: { slug: "stupefied", value: 1 } }] }] }).ok, false);   // массив — только у familiar
  const st = { to: "self", condition: { slug: "stupefied", value: 1 } };
  assert.equal(validate({ v: 1, onEvent: [{ on: ["spell-cast", "damage-roll"], side: "self", apply: [st] }] }).ok, false);
  const f1 = (p) => validate({ v: 1, onEvent: [{ ...e, ...p }] }).ok;
  for (const to of ["target", "allies", "party"]) assert.equal(f1({ apply: [e.apply[0], { ...e.apply[1], to, ...(to === "allies" && { range: 5 }) }] }), false, to);   // получатели familiar — только chosen/self
  assert.equal(f1({ cost: "reaction" }), false);
  assert.equal(f1({ challenge: CAT[WF.WF07].onEvent[0].challenge }), true);   // есть choose существа
  assert.equal(f1({ apply: [{ to: "self", condition: { slug: "stupefied", value: 1 } }], challenge: CAT[WF.WF07].onEvent[0].challenge }), false);   // challenge без choose
  const ch = (c) => ok({ apply: [{ choose: c }, e.apply[1]] }).ok;
  assert.equal(ch({ from: "creatures", range: 15, where: [{ lt: ["hp-percent", 50] }] }), true);
  assert.equal(ch({ from: "creatures", withSelf: true }), true);
  assert.equal(ch({ from: "allies", where: ["x"] }), true);
  assert.equal(ch({ from: "options", options: ["a"], where: ["x"] }), false);
  assert.equal(ch({ from: "creatures", where: 5 }), false);
});

test("каталог: 5 записей первой партии валидны, срок до начала хода ведьмы, onUse Restored Spirit сохранён", () => {
  for (const [wf, uuid] of Object.entries(WF)) {
    const r = validate(CAT[uuid]);
    assert.deepEqual(r.errors, [], wf);
    const entry = r.rule.onEvent[0];
    assert.deepEqual([entry.on, entry.side, entry.when], [["spell-cast", "spell-sustain"], "familiar", ["origin:item:trait:hex"]], wf);
    for (const s of entry.apply.filter((x) => x.to === "chosen")) assert.deepEqual(s.duration, { value: 1, unit: "rounds", expiry: "turn-start", ...(s.condition && { of: "origin" }) }, wf);   // у эффекта по uuid `of` не пишется: автор эффекта — ведьма и так
  }
  const rs = validate(CAT[WF.WF09]).rule;
  assert.equal(rs.onUse.apply[0].effect.uuid, FE("twvhTLrLEfr7dz1m"));
  assert.deepEqual(rs.onEvent[0].apply[0].choose, { from: "creatures", range: 15, withSelf: true });
  assert.deepEqual(validate(CAT[WF.WF07]).rule.onEvent[0].apply[0].choose.where, [{ lt: ["hp-percent", 50] }]);
});

test("форма Мастерской: запись с on-массивом, creatures/where, challenge не теряется", () => {
  for (const wf of ["WF01", "WF07", "WF09"]) {
    const r = validate(CAT[WF[wf]]).rule;
    assert.deepEqual(validate(formToRule(ruleToForm(r))).rule, r, wf);
  }
});

test("familiarsOf/familiarToken/familiarDown: чужой фамильяр, токен по документам сцены, 0 ОЗ", () => {
  const w = world1();
  const other = mkActor("otherwitch", { type: "character", side: "pc", x: 3 });
  mkActor("fam2", { type: "familiar", side: "pc", x: 3, master: other.id });
  assert.deepEqual(fam.familiarsOf(w.witch).map((a) => a.id), ["fam"]);
  assert.equal(fam.familiarToken(w.fam, scene).id, "Tfam");
  assert.equal(fam.familiarToken(w.fam, { tokens: [] }), null);
  assert.equal(fam.familiarToken(w.fam, null), null);
  w.fam.hitPoints.value = 0;
  assert.equal(fam.familiarDown(w.fam), true);
  w.fam.hitPoints.value = 3;
  assert.equal(fam.familiarDown(w.fam), false);
  assert.equal(fam.familiarDown({ ...w.fam, hasCondition: () => true }), true);
});

/* ---------- 2. запуск при сотворении ---------- */

test("WF10: hex-сотворение — окно, stupefied 1 выбранному до начала хода ведьмы; закрытое окно — ничего", async () => {
  const w = world1("WF10");
  dialogs.pick = "mid";   // 20 фт от фамильяра — в радиусе 20
  await run(cast(w));
  assert.equal(dialogs.shown.length, 1);
  assert.deepEqual(dialogs.shown[0].sort(), ["ally", "mid", "near", "witch"]);   // сам фамильяр не кандидат, far (40 фт) вне радиуса
  const st = w.mid.items.find((i) => i.type === "effect" && i.system.rules.some((r) => r.key === "GrantItem" && /stupefied/.test(r.uuid)));   // состояние со сроком — обёртка-эффект
  assert.ok(st, "stupefied выдан");
  assert.deepEqual([st.system.duration.value, st.system.duration.unit, st.system.duration.expiry], [1, "rounds", "turn-start"]);
  assert.equal(st.system.context.origin.actor, "Actor.witch");   // срок считает ход ведьмы
  dialogs.pick = null;
  const m2 = cast(w);
  await run(m2);
  assert.equal(dialogs.shown.length, 2);
  assert.equal(w.near.items.length, 0);   // отказ
});

test("не-hex заклинание, карточка-описание и дубль сообщения — без запуска", async () => {
  const w = world1("WF10");
  await run(cast(w, { hex: false, spell: SPELL({ uuid: "Item.other" }) }));
  await run(cast(w, { card: false }));   // карточка-описание: события нет
  assert.equal(dialogs.shown.length, 0);
  const m = cast(w);
  await Promise.all([run(m), run(m)]);
  await run(m);
  assert.equal(dialogs.shown.length, 1);
});

test("две цели сотворения — один запуск способности фамильяра", async () => {
  const w = world1("WF10");
  await run(cast(w, { targets: [w.near, w.mid] }));
  assert.equal(dialogs.shown.length, 1);
});

test("дальность — от токена фамильяра, не ведьмы; WF01 15 фт: near (15) да, mid (20) нет; ведьма — кандидат", async () => {
  const w = world1("WF01");
  await run(cast(w));
  assert.deepEqual(dialogs.shown[0].sort(), ["ally", "near", "witch"]);
  // 15 фт от ведьмы (x=3): ally x=2 был бы в 5 фт; near x=4 в 20 фт от ведьмы, но 15 от фамильяра — кандидат
});

test("фамильяр на 0 ОЗ / без сознания — тишина; нет токена фамильяра — один шёпот ГМу за сессию; нет фамильяра — тишина", async () => {
  let w = world1("WF10", { famOver: { hp: 0 } });
  await run(cast(w));
  assert.equal(dialogs.shown.length, 0);
  w = world1("WF10", { famOver: { down: true } });
  await run(cast(w));
  assert.equal(dialogs.shown.length, 0);
  w = world1("WF10");
  scene.tokens.splice(scene.tokens.indexOf(w.fam.token), 1);   // токен фамильяра убран со сцены
  const before = created.length;
  await run(cast(w));
  assert.equal(dialogs.shown.length, 0);
  const warns = created.slice(before).filter((c) => /familiar\.noToken/.test(c.content));
  assert.equal(warns.length, 1);
  await run(cast(w));
  assert.equal(created.slice(before).filter((c) => /familiar\.noToken/.test(c.content)).length, 1);   // раз за сессию
  w = world1("WF10", { withFam: false });
  await run(cast(w));
  assert.equal(dialogs.shown.length, 0);
});

test("токен ведьмы не на холсте (getActiveTokens пуст): запуск идёт по документам сцены", async () => {
  const w = world1("WF10");
  assert.deepEqual(w.witch.getActiveTokens(), []);
  await run(cast(w));
  assert.equal(dialogs.shown.length, 1);
});

/* ---------- 3. эффекты записей ---------- */

const eff = (a, id) => a.items.filter((i) => i._stats?.compendiumSource === FE(id));
const DUR = (e) => [e.system.duration.value, e.system.duration.unit, e.system.duration.expiry];
// окна по очереди: первое — существо, дальше — варианты
const picks = (...list) => { let n = 0; Object.defineProperty(dialogs, "pick", { get: () => list[Math.min(n++, list.length - 1)], configurable: true }); };

test("WF06: союзник в 5 фт от фамильяра (враг, дальше, сам фамильяр — нет); срок перебит на turn-start, а не родной turn-end", async () => {
  const w = world1("WF06");
  dialogs.pick = "ally";   // x=2: 5 фт от фамильяра x=1
  await run(cast(w));
  assert.deepEqual(dialogs.shown[0].sort(), ["ally", "witch"]);   // witch x=0 тоже 5 фт
  const e = eff(w.ally, "IgLMAwovQ9roTsRN");
  assert.equal(e.length, 1);
  assert.deepEqual(DUR(e[0]), [1, "rounds", "turn-start"]);
  assert.equal(e[0].system.context.origin.actor, "Actor.witch");
});

test("WF01: два числовых выбора — selection ChoiceSet число -1/1 (второго окна pf2e нет); закрытое окно — эффекта нет", async () => {
  const w = world1("WF01");
  picks("near", "PF2E_AUTOMATO.choose.opt.minus");
  await run(cast(w));
  const e = eff(w.near, "0JvxhEv83bAD5PGv");
  assert.equal(e.length, 1);   // шаг «+1» пропущен по when
  assert.strictEqual(e[0].system.rules.find((r) => r.key === "ChoiceSet").selection, -1);
  assert.deepEqual(DUR(e[0]), [1, "rounds", "turn-start"]);
  assert.equal(dialogs.shown.length, 2);
  picks("ally", "PF2E_AUTOMATO.choose.opt.plus");
  await run(cast(w));
  assert.strictEqual(eff(w.ally, "0JvxhEv83bAD5PGv")[0].system.rules.find((r) => r.key === "ChoiceSet").selection, 1);
  dialogs.shown.length = 0;
  picks(null);   // окно существа закрыто: запись оборвана, второго окна (варианты) нет
  await run(cast(w));
  assert.equal(dialogs.shown.length, 1);
  assert.equal(w.far.items.length, 0);
});

test("WF09: эффект с автором-ведьмой (не фамильяр), у ведьмы 1 ур. -> временные ОЗ 2 + floor(1/2); ведьма — кандидат", async () => {
  const w = world1("WF09");
  dialogs.pick = "witch";
  await run(cast(w));
  assert.ok(dialogs.shown[0].includes("witch"));
  const e = eff(w.witch, "twvhTLrLEfr7dz1m");
  assert.equal(e.length, 1);
  assert.equal(e[0].system.context.origin.actor, "Actor.witch");   // @item.origin.level берётся у автора эффекта
  assert.equal(w.witch.level, 1);
  assert.equal(2 + Math.floor(w.witch.level / 2), 2);
  assert.deepEqual(DUR(e[0]), [1, "rounds", "turn-start"]);
});

/* ---------- 4. WF07: where, бросающий и СЛ ---------- */

test("WF07 where: 5/10 нет, 4/10 да, 49/100 да, 50/100 нет", async () => {
  const w = world1("WF07");
  w.near.hitPoints.value = 5; w.mid.hitPoints.value = 4;   // mid дальше 15 фт — вне списка
  w.ally.hitPoints.max = 100; w.ally.hitPoints.value = 49;
  w.witch.hitPoints.max = 100; w.witch.hitPoints.value = 50;
  dialogs.pick = null;
  await run(cast(w));
  assert.deepEqual(dialogs.shown[0], ["ally"]);   // near 5/10 и witch 50/100 — не кандидаты
  w.near.hitPoints.value = 4;
  await run(cast(w));
  assert.deepEqual(dialogs.shown[1].sort(), ["ally", "near"]);
});

test("WF07: Fortitude бросает выбранная цель, СЛ — из колдовства наговора, а не первой записи актёра; закрытое окно и нет кандидатов — карточки нет", async () => {
  const w = world1("WF07");
  w.near.hitPoints.value = 3;
  dialogs.pick = "near";
  await run(cast(w, { spell: SPELL({ spellcasting: { statistic: { dc: { value: 23 } } } }) }));
  assert.equal(hostCards().length, 1);
  const use = hostCards()[0].flags[MOD].use;
  assert.equal(use.dc, 23);
  assert.deepEqual(use.targets.map((t) => t.uuid), [w.near.token.uuid]);
  assert.deepEqual([use.rule.onUse.challenge.statistic, use.rule.onUse.challenge.dc], ["fortitude", { source: "spell" }]);
  assert.equal(use.actor, "Actor.witch");
  dialogs.pick = null;
  await run(cast(w));
  assert.equal(hostCards().length, 1);
  w.near.hitPoints.value = 10; dialogs.pick = 0;
  const n = dialogs.shown.length;
  await run(cast(w));
  assert.equal(dialogs.shown.length, n);   // кандидатов нет — окна нет
  assert.equal(hostCards().length, 1);
});

/* ---------- 5. Поддержание и автоякорь ---------- */

const anchorsOf = (a) => sustain.anchorsOf(a);
const wait = () => new Promise((r) => setTimeout(r, 20));
const tick = (w, round) => { world.combat = { id: "c1", round }; const a = anchorsOf(w.witch)[0]; return sustain.run(w.witch.uuid, a.flags[MOD].meta.key); };

test("автоякорь hex с Поддержанием: ключ anchorKey(message.id), без привязок, offer не уходит ГМу, повтор — один якорь; не-hex с Поддержанием — тоже якорь, без Поддержания — нет", async () => {
  const w = world1("WF10");
  dialogs.pick = null;
  const m = cast(w);
  await run(m);
  const [a] = anchorsOf(w.witch);
  assert.equal(anchorsOf(w.witch).length, 1);
  assert.equal(a.flags[MOD].meta.key, sustain.anchorKey(m.id));
  assert.deepEqual(a.flags[MOD].sustain.actors, []);
  const isOffer = (c) => c.flags?.[MOD]?.builtin === "sustain";
  assert.equal(created.filter(isOffer).length, 0);   // в бою при сотворении предложения нет — в ход сотворения Поддерживать нечего
  world.combat = { id: "c1", round: 2 };
  await sustain.remind({ actor: w.witch });   // начало следующего хода ведьмы
  const offers = created.filter(isOffer);
  assert.equal(offers.length, 1);   // владельца-игрока нет — короткое предложение ГМу, один раз
  assert.match(offers[0].content, /sustain.offerQuiet/);
  game.users.push({ id: "p1", isGM: false }); w.witch.testUserPermission = () => true;   // есть игрок-владелец: предложение только ему
  world.combat = { id: "c1", round: 3 };
  await sustain.remind({ actor: w.witch });
  game.users.pop();
  const o2 = created.filter(isOffer).at(-1);
  assert.deepEqual(o2.whisper, ["p1"]);
  world.combat = { id: "c1", round: 1 };
  const m3 = cast(w); await run(m3);
  await run(m);
  assert.equal(anchorsOf(w.witch).length, 2);   // m и m3 — по якорю на сообщение; повтор m второго не создал
  const w2 = world1("WF10");
  await run(cast(w2, { hex: false }));
  assert.equal(anchorsOf(w2.witch).length, 1);   // любое заклинание с Поддержанием — якорь (пак D)
  await run(cast(w2, { spell: SPELL({ uuid: "Item.nosustain", system: { duration: { value: "", sustained: false }, range: { value: "30 feet" } } }) }));
  assert.equal(anchorsOf(w2.witch).length, 1);
});

test("автоякорь без привязок: пропуск Поддержания якорь снимает, но «пропущено» не шлёт", async () => {
  const w = world1("WF10");
  dialogs.pick = null;
  await run(cast(w));
  const before = created.length;
  assert.equal(await sustain.check([w.witch], { combat: "c1", round: 1 }, "round"), 0);
  assert.equal(await sustain.check([w.witch], { combat: "c1", round: 3 }, "round"), 1);
  assert.equal(anchorsOf(w.witch).length, 0);
  assert.equal(created.slice(before).filter((c) => /sustain\.ended/.test(c.content)).length, 0);
});

test("Поддержание hex-якоря: один запуск за раунд (again — события нет); сотворение и Поддержание — два запуска (Cackle)", async () => {
  const w = world1("WF10");
  dialogs.pick = "mid";
  await run(cast(w));
  assert.equal(dialogs.shown.length, 1);
  const listener = (e) => ev.onSustain(e);
  sustain.sustained.add(listener);   // events.init() в node не зовём
  try {
    assert.equal((await tick(w, 1)).result, "again");   // сотворено в этом раунде
    await wait();
    assert.equal(dialogs.shown.length, 1);
    assert.equal((await tick(w, 2)).result, "fresh");
    await wait();
    assert.equal(dialogs.shown.length, 2);
    assert.equal((await tick(w, 2)).result, "again");
    await wait();
    assert.equal(dialogs.shown.length, 2);
  } finally { sustain.sustained.delete(listener); }
});

test("Поддержание не-hex якоря не запускает; hex — запускает, тот же раунд повторно — нет", async () => {
  const w = world1("WF10");
  const plain = SPELL({ uuid: "Item.plain", getRollOptions: (p) => [`${p}:trait:fire`] });
  const hex = SPELL({ uuid: "Item.hex" });
  for (const s of [plain, hex]) uuids.set(s.uuid, s);
  await sustain.attach(w.witch, null, { key: "P:sustain", msg: "P", item: plain, token: w.wtok });
  await sustain.attach(w.witch, null, { key: "H:sustain", msg: "H", item: hex, token: w.wtok });
  const by = (k) => anchorsOf(w.witch).find((a) => a.flags[MOD].meta.key === k);
  const pos = { combat: "c1", round: 2 };
  dialogs.pick = 0;
  await ev.onSustain({ anchor: by("P:sustain"), actor: w.witch, pos });
  assert.equal(dialogs.shown.length, 0);
  await ev.onSustain({ anchor: by("H:sustain"), actor: w.witch, pos });
  assert.equal(dialogs.shown.length, 1);
  await ev.onSustain({ anchor: by("H:sustain"), actor: w.witch, pos });
  assert.equal(dialogs.shown.length, 1);
});

test("Поддержание: не-активный ГМ — ноль; вне боя дедуп окном 6 с", async () => {
  const w = world1("WF10");
  const hex = SPELL({ uuid: "Item.hex2" }); uuids.set(hex.uuid, hex);
  await sustain.attach(w.witch, null, { key: "H2:sustain", msg: "H2", item: hex, token: w.wtok });
  const anchor = anchorsOf(w.witch)[0];
  dialogs.pick = 0;
  globalThis.game.user.isActiveGM = false;
  await ev.onSustain({ anchor, actor: w.witch, pos: { combat: "c1", round: 2 } });
  globalThis.game.user.isActiveGM = true;
  assert.equal(dialogs.shown.length, 0);
  const off = { combat: null, round: null };
  await ev.onSustain({ anchor, actor: w.witch, pos: off });
  await ev.onSustain({ anchor, actor: w.witch, pos: off });
  assert.equal(dialogs.shown.length, 1);
  now += 7000;
  await ev.onSustain({ anchor, actor: w.witch, pos: off });
  assert.equal(dialogs.shown.length, 2);
});

/* ---------- 6. доработки по Критику ---------- */

test("кандидаты creatures: скрытый токен и существо на 0 ОЗ не в списке; ведьма (WF09) остаётся; фамильяр на скрытом токене годится как центр", async () => {
  const w = world1("WF09");
  w.near.token.hidden = true; w.mid.hitPoints.value = 0; w.ally.isDead = true;
  dialogs.pick = null;
  await run(cast(w));
  assert.deepEqual(dialogs.shown[0], ["witch"]);
  w.fam.token.hidden = true;
  await run(cast(w));
  assert.equal(dialogs.shown.length, 2);
});

test("WF07: режим challenge=off — окна нет; нет кандидатов — тишина (apply.noCandidates не шлём)", async () => {
  const w = world1("WF07");
  w.near.hitPoints.value = 3;
  settings["mode.challenge"] = "off";
  await run(cast(w));
  assert.equal(dialogs.shown.length, 0);
  settings["mode.challenge"] = "auto";
  w.near.hitPoints.value = 10;
  const warns = [];
  globalThis.ui.notifications.warn = (m) => warns.push(m);
  await run(cast(w));
  globalThis.ui.notifications.warn = () => {};
  assert.deepEqual(warns.filter((m) => /noCandidates/.test(m)), []);
});

test("WF07: СЛ — запись колдовства самого наговора, даже если у ведьмы первая запись другая; то же на Поддержании", async () => {
  const w = world1("WF07");
  w.near.hitPoints.value = 3;
  w.witch.spellcasting = { contents: [{ statistic: { dc: { value: 99 } } }, { statistic: { dc: { value: 23 } } }] };   // первая запись — не та
  const spell = SPELL({ spellcasting: w.witch.spellcasting.contents[1] });
  dialogs.pick = "near";
  await run(cast(w, { spell }));
  assert.equal(hostCards().at(-1).flags[MOD].use.dc, 23);
  uuids.set(spell.uuid, spell);
  await sustain.attach(w.witch, null, { key: "S:sustain", msg: "S", item: spell, token: w.wtok });
  const anchor = anchorsOf(w.witch).find((a) => a.flags[MOD].meta.key === "S:sustain");
  await ev.onSustain({ anchor, actor: w.witch, pos: { combat: "c1", round: 4 } });
  assert.equal(hostCards().length, 2);
  assert.equal(hostCards().at(-1).flags[MOD].use.dc, 23);
});
