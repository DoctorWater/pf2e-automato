import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.game ??= {};
const { MOD } = await import("../scripts/util.mjs");
const { detectMechs, mechRows, mechanismsOf, footStatus, MECH_IDS } = await import("../scripts/workshop/mechanisms.mjs");
const { mechToForm } = await import("../scripts/mech.mjs");
const { LIMITS } = await import("../scripts/builtin/impulse-gate.mjs");
const { rechargeOf } = await import("../scripts/builtin/limit-text.mjs");
const { maneuverList } = await import("../scripts/builtin/maneuver.mjs");
const { permanentOf } = await import("../scripts/builtin/neutralize-rules.mjs");
const { optionOf } = await import("../scripts/builtin/spellshape.mjs");
const rules = await import("../scripts/rules.mjs");

const modes = {};
const env = (o = {}) => ({
  t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), loc: (k) => k, mode: (k) => modes[k] ?? "auto", yields: () => false,
  needText: (cl) => cl.k, condLabel: (s) => s, strikeState: () => null, ...o
});
const BREATH = "You can't use Breath Weapon again for [[/gmr 1d4 #Recharge Breath Weapon]]{1d4 rounds}.";
const doc = (o = {}) => ({ id: "i1", type: "action", slug: "breath-weapon", name: "Breath", system: { description: { value: BREATH }, traits: { value: [] }, rules: [] }, flags: {}, ...o });
const withMech = (d, m) => ({ ...d, flags: { [MOD]: { mech: m } } });
const ids = (list) => list.map((d) => d.id);

test("реестр: по одной строке на механизм, порядок M1…M8; предмет без механизмов — пусто", () => {
  assert.deepEqual(ids(detectMechs(doc(), env())), ["recharge"]);
  assert.deepEqual(detectMechs(doc({ system: { description: { value: "x" }, traits: { value: [] }, rules: [] } }), env()), []);
  assert.deepEqual(detectMechs(null, env()), []);
  assert.equal(MECH_IDS.length, 7);
});

test("M1: состояние — предмет раньше режима; свой срок в сводке; критический Удар у Дыхания", () => {
  const row = (d, e = env()) => mechanismsOf(d, e)[0];
  assert.equal(row(doc()).state, null);
  assert.match(row(doc()).sum, /1d4/);
  assert.match(row(withMech(doc(), { recharge: "1d6" })).sum, /1d6/);
  modes.limits = "off";
  assert.match(row(doc()).state.text, /state\.mode/);
  assert.match(row(withMech(doc(), { recharge: false })).state.text, /state\.flag/, "предмет раньше режима");
  delete modes.limits;
  const dragon = doc({ system: { description: { value: BREATH }, traits: { value: ["breath"] }, rules: [] } });
  dragon.actor = { items: [{ type: "action", slug: "draconic-momentum", system: { description: { value: "" } } }] };
  assert.match(row(dragon).sum, /rechargeCrit\{"name":"Breath"\}/, "«Дыхание» — название предмета");
  assert.doesNotMatch(row(doc()).sum, /rechargeCrit/);
});

test("M1: поля — переключатель и срок; без формы (вкладка листа) полей нет; срок недоступен при «Выключено» и при locked", () => {
  const d = doc(), f = mechToForm({});
  const fields = (form, e = env()) => mechanismsOf(d, e, form)[0].fields;
  assert.deepEqual(fields(f).map((x) => x.path), ["mech.recharge.off", "mech.recharge.dice"]);
  assert.deepEqual(fields(f).map((x) => !!x.disabled), [false, false]);
  assert.equal(fields(f)[0].sw, true);
  assert.equal(fields(f)[0].value, true, "включено");
  assert.match(fields(f)[0].label, /switchOn/);
  f.recharge.off = true;
  assert.equal(fields(f)[0].value, false);
  assert.match(fields(f)[0].label, /switchOff/);
  assert.equal(fields(f)[1].disabled, true, "срок при «Выключено» недоступен");
  assert.deepEqual(fields(mechToForm({}), env({ locked: true })).map((x) => !!x.disabled), [true, true]);
  assert.deepEqual(mechanismsOf(d, env())[0].fields, []);
});

test("строка считается от черновика: сводка, состояние, отметка «не сохранено», своё значение", () => {
  const d = doc(), f = mechToForm({});
  const row = (form) => mechanismsOf(d, env(), form)[0];
  assert.equal(row(f).draft, false);
  assert.equal(row(f).custom, false);
  f.recharge.dice = "1к6";
  assert.match(row(f).sum, /1d6/, "«1к6» принимается как 1d6");
  assert.equal(row(f).draft, true);
  assert.equal(row(f).custom, true);
  f.recharge.dice = ""; f.recharge.off = true;
  assert.match(row(f).state.text, /state\.flag/, "выключение видно до сохранения");
  assert.equal(row(f).draft, true);
  assert.equal(mechanismsOf(withMech(d, { recharge: "1d6" }), env(), mechToForm({ recharge: "1d6" }))[0].draft, false, "сохранённое значение — не черновик");
  assert.equal(row(mechToForm({ recharge: "1d6" })).custom, true);
  const saved = withMech(d, { recharge: false });
  assert.equal(mechanismsOf(saved, env(), mechToForm({}))[0].state, null, "черновик включён, сохранённое выключено");
  assert.equal(mechanismsOf(saved, env(), mechToForm({}))[0].draft, true);
});

test("M3: причины → пилюли состояния; режим и уступка считаются на каждый рендер, не из кэша признака", () => {
  const rule = { onEvent: [{ challenge: null, apply: [{}] }] }, strikes = [{ name: "Fangs" }];
  const link = (o = {}) => ({ rule, strikes, needRule: false, ids: {}, ...o });
  const row = (o, d = doc(), e = {}) => mechanismsOf(d, env({ strikeState: () => link(o), ...e })).find((r) => r.id === "strike");
  assert.equal(row().state, null);
  assert.match(row({}, withMech(doc(), { strike: false })).state.text, /state\.flag/);
  assert.match(row({ needRule: true }).state.text, /state\.needRule/);
  assert.equal(row({ needRule: true }).state.warn, true);
  modes.effect = "off";
  assert.match(row().state.text, /state\.mode/);
  modes.effect = "button";
  assert.match(row().state.text, /state\.modeButton/, "«По кнопке» — не «Выключено»");
  delete modes.effect;
  const dets = detectMechs(doc(), env({ strikeState: () => link() })), at = (e) => mechRows(dets, doc(), env(e)).find((r) => r.id === "strike").state;
  assert.equal(at({}), null);
  modes.effect = "off";
  assert.match(at({}).text, /state\.mode/, "те же dets, режим сменился — строка пересчитана");
  delete modes.effect;
  assert.match(at({ yields: () => true }).text, /state\.yield/, "то же для уступки");
  const draftOff = mechToForm({ strike: false }), draftOn = mechToForm({});
  const withForm = (e, form, d = doc()) => mechanismsOf(d, env({ strikeState: () => link(), ...e }), form).find((r) => r.id === "strike");
  assert.match(withForm({}, draftOff).state.text, /state\.flag/, "флаг из черновика");
  assert.match(withForm({ yields: () => true }, draftOn, withMech(doc(), { strike: false })).state.text, /state\.yield/, "флаг снят в черновике: видна следующая причина");
  modes.challenge = "off";
  const chRule = { onEvent: [{ challenge: {} }] };
  modes.effect = "off";
  assert.match(row({ rule: chRule }).state.text, /"mode":"settings\.mode\.challenge\.name"/, "испытание выключено — называется оно");
  delete modes.challenge; delete modes.effect;
  assert.match(row().sum, /Fangs/);
  const sum = (parts) => mechanismsOf(doc(), env({ strikeState: () => link(), evParts: () => parts })).find((r) => r.id === "strike").sum;
  assert.match(sum({ save: { stat: "Стойкость", dc: "20" }, fail: "Больной 1", steps: "" }), /sum\.strike\{.*"stat":"Стойкость","dc":"20","fail":"Больной 1"/);
  assert.match(sum({ save: null, fail: "", steps: "Больной 1" }), /strikeSteps/);
  assert.match(sum(null), /strikeShort/);
  assert.doesNotMatch(sum({ save: { stat: "s", dc: "1" }, fail: "x", steps: "" }), /item:attack-effect/);
});

const TK = { id: "tk", type: "spell", slug: "telekinetic-maneuver", name: "TM", system: { description: { value: "" }, traits: { value: [] }, rules: [] }, flags: {} };
test("M5: режим off — состояние (строка остаётся, показ через maneuverList); поля только при нескольких манёврах; Magnetic Attraction — без полей", () => {
  const e = env();
  game.i18n = { localize: () => "" };
  modes.macro = "off";
  const off = mechanismsOf(TK, e).find((r) => r.id === "maneuvers");
  assert.match(off.state.text, /state\.mode/);
  assert.match(off.sum, /Disarm|PF2E\.Actions\.Disarm\.Title/);
  delete modes.macro;
  const f = mechToForm({});
  const auto = mechanismsOf(TK, e, f).find((r) => r.id === "maneuvers");
  assert.deepEqual(auto.fields.map((x) => x.path), ["mech.maneuvers.auto"]);
  assert.match(auto.sum, /maneuvers\{/, "несколько манёвров — множественное");
  assert.equal(mechanismsOf(TK, e, mechToForm({ maneuvers: ["trip"] })).find((r) => r.id === "maneuvers").custom, true);
  assert.deepEqual(mechanismsOf(TK, env({ locked: true }), mechToForm({})).find((r) => r.id === "maneuvers").fields.map((x) => !!x.disabled), [true], "locked: сегмент недоступен");
  f.maneuvers.auto = false; f.maneuvers.list.trip = true;
  const manual = mechanismsOf(TK, e, f).find((r) => r.id === "maneuvers");
  assert.deepEqual(manual.fields.map((x) => x.path), ["mech.maneuvers.auto", "mech.maneuvers.list"]);
  assert.deepEqual(manual.fields[1].seg.map((s) => [s.value, s.on]), [["disarm", false], ["shove", false], ["reposition", false], ["trip", true]]);
  const mag = mechanismsOf({ ...TK, slug: "magnetic-attraction" }, e, mechToForm({})).find((r) => r.id === "maneuvers");
  assert.deepEqual(mag.fields, []);
  assert.match(mag.sum, /maneuversOne/);
});

test("M6: постоянное состояние у NPC; флаг и режим «Эффекты» — состояния; у героя строки нет", () => {
  const slow = { id: "s", type: "action", slug: "slow", name: "Slow", system: { description: { value: "" }, traits: { value: [] }, rules: [] }, flags: {}, actor: { type: "npc" } };
  assert.equal(mechanismsOf(slow, env())[0].state, null);
  assert.match(mechanismsOf(withMech(slow, { permanent: false }), env())[0].state.text, /state\.flag/);
  modes.effect = "off";
  assert.match(mechanismsOf(slow, env())[0].state.text, /state\.mode/);
  delete modes.effect;
  assert.deepEqual(detectMechs({ ...slow, actor: { type: "character" } }, env()), []);
  const own = { ...slow, system: { ...slow.system, rules: [{ key: "GrantItem" }] } };
  assert.match(mechanismsOf(own, env())[0].sum, /permanentOwn/);
  assert.doesNotMatch(mechanismsOf(own, env())[0].sum, /память/);
  const ownOff = mechanismsOf(withMech(own, { permanent: false }), env())[0];
  assert.match(ownOff.state.text, /flagReact/, "при данных pf2e выключение снимает только запрет реакций");
  assert.match(mechanismsOf(own, env(), mechToForm({}))[0].fields[0].hint, /f\.permanentOwn/);
  assert.match(mechanismsOf(slow, env(), mechToForm({}))[0].fields[0].hint, /f\.permanent\{/);
  assert.match(mechanismsOf(withMech(slow, { permanent: false }), env())[0].state.text, /state\.flag/);
});

test("M6: нет состояния «уступает pf2e-automations» (рантайм addPermanent его не проверяет)", () => {
  const slow = { id: "s", type: "action", slug: "slow", name: "Slow", system: { description: { value: "" }, traits: { value: [] }, rules: [] }, flags: {}, actor: { type: "npc" } };
  assert.equal(mechanismsOf(slow, env({ yields: () => true }))[0].state, null);
});

test("M7: Духовная связь — режим «Макросы» и уступка; M8: метамагия у героя (флаг) и у NPC (по slug), общая сводка с именем", () => {
  const spirit = { id: "sp", type: "spell", slug: "spirit-link", name: "Духовная связь", rank: 2, system: { description: { value: "" }, traits: { value: [] }, rules: [] }, flags: {} };
  const r = mechanismsOf(spirit, env())[0];
  assert.equal(r.id, "spirit");
  assert.match(r.sum, /"n":2/);
  assert.equal(r.state, null);
  assert.match(mechanismsOf(spirit, env({ yields: () => true }))[0].state.text, /state\.yield/);
  modes.macro = "off";
  assert.match(mechanismsOf(spirit, env())[0].state.text, /state\.mode/);
  delete modes.macro;
  const hero = { id: "h", type: "feat", slug: "widen-spell", name: "Расширенное заклинание", system: { description: { value: "" }, traits: { value: [] }, rules: [] }, flags: { [MOD]: { spellshape: "widen" } }, actor: { type: "character" } };
  const shape = mechanismsOf(hero, env())[0];
  assert.equal(shape.id, "shape");
  assert.equal(shape.chip, "PF2E.TraitSpellshape", "чип — термин pf2e, не своя строка");
  assert.match(shape.sum, /Расширенное заклинание/);
  const reach = { id: "r", type: "action", slug: "reach-spell", name: "Reach Spell", system: { description: { value: "" }, traits: { value: [] }, rules: [] }, flags: {}, actor: { type: "npc" } };
  assert.equal(mechanismsOf(reach, env())[0].id, "shape");
  assert.deepEqual(detectMechs({ ...reach, actor: { type: "character" } }, env()), [], "у героя без флага — нет");
});

test("статус подвала: с правками — одна фраза, без — две части (правило · «Работает само»)", () => {
  const t = env().t;
  assert.equal(footStatus(t, { dirty: true, source: "flag", mechs: 1, mechSaved: false }), "workshop.au.dirty");
  const s = footStatus(t, { dirty: false, source: "catalog", mechs: 1, mechSaved: true });
  assert.match(s, /statusRule\{"src":"sheet\.src\.catalog"\}/);
  assert.match(s, / · .*statusMech\{"state":"workshop\.au\.mechChanged"\}/);
  assert.match(footStatus(t, { dirty: false, source: "flag", mechs: 1, mechSaved: false }), /ruleItem.*mechDefault/);
  assert.match(footStatus(t, { dirty: false, source: undefined, mechs: 1, mechSaved: false }), /ruleNone/);
  assert.doesNotMatch(footStatus(t, { dirty: false, source: undefined, mechs: 0, mechSaved: false }), /statusMech/, "нет механизмов — одна часть");
});

/* ---------- паритет с рантаймом по корпусу ---------- */

const ITEMS = new URL("../tools/out/items.json", import.meta.url), LIM = fileURLToPath(new URL("../rules/use-limits.json", import.meta.url));
test("паритет: M1/M2/M5/M6/M7/M8 находятся ровно у тех предметов, у которых рантайм-предикат даёт не null", { skip: !existsSync(ITEMS) }, () => {
  const items = JSON.parse(readFileSync(ITEMS, "utf8")).items, e = env();
  rules.initOverlays(null, null, null, JSON.parse(readFileSync(LIM, "utf8")));
  game.i18n = { localize: () => "" };
  const reaches = (d) => ["spell", "action", "feat"].includes(d.type);   // полное условие preCreate: тип предмета (карточка с cast-a-spell у заклинаний — сама карточка)
  const rc = LIMITS.find((l) => l.reason === "recharge"), rq = LIMITS.find((l) => l.reason === "req");
  const n = { recharge: 0, req: 0, maneuvers: 0, permanent: 0, spirit: 0, shape: 0 };
  try {
    for (const i of items) {
      if (!["action", "feat", "spell"].includes(i.type)) continue;
      const d = { id: "x", type: i.type, slug: i.slug, name: i.name, rank: i.rank, system: { description: { value: i.descEn ?? "" }, traits: { value: i.traits ?? [] }, rules: [] }, _stats: { compendiumSource: i.uuid }, flags: {}, actor: { type: "npc", items: [] } };
      const got = new Set(detectMechs(d, e).map((x) => x.id)), req = reaches(d) ? rules.limitEntry(d)?.req : null;
      const want = {
        recharge: reaches(d) && rc.applies({ rc: rechargeOf(d.system.description.value), inCombat: true, limitsOn: true }),
        req: reaches(d) && rq.applies({ req }) && !!req?.any?.length,
        maneuvers: d.type === "spell" && maneuverList(d.slug, d.system.description.value, {}).length > 0,
        permanent: !!permanentOf(d, "npc"),
        spirit: d.type === "spell" && d.slug === "spirit-link",
        shape: optionOf(d) != null
      };
      for (const [id, v] of Object.entries(want)) {
        assert.equal(got.has(id), v, `${id}: ${i.uuid} ${i.name}`);
        if (v) n[id]++;
      }
    }
  } finally { rules.initOverlays(null, null, null, null); }
  assert.ok(n.recharge >= 500 && n.req >= 30 && n.maneuvers >= 1 && n.permanent >= 1 && n.spirit >= 1, JSON.stringify(n));
});

/* ---------- мировое правило: ключ ---------- */

const ACTOR = "Compendium.pf2e.bestiary.Actor.AAAAAAAAAAAAAAAA", KEY = `${ACTOR}.Item.iiiiiiiiiiiiiiii`;
const npcItem = (own, actorSrc) => {
  const a = { type: "npc", _stats: actorSrc ? { compendiumSource: actorSrc } : {} };
  const it = { id: "iiiiiiiiiiiiiiii", type: "action", slug: "x", name: "X", _stats: own ? { compendiumSource: own } : {}, system: { description: { value: "" }, traits: { value: [] } } };
  it.actor = it.parent = a;
  return it;
};

test("worldKeyOf: собственный источник, выведенный от существа, ни того ни другого", () => {
  const OWN = "Compendium.pf2e.feats-srd.Item.OWN";
  assert.deepEqual(rules.worldKeyOf(npcItem(OWN, ACTOR), null, "source"), { source: OWN });
  assert.equal(rules.keyDerived(npcItem(OWN, ACTOR), null), false);
  assert.deepEqual(rules.worldKeyOf(npcItem(null, ACTOR), null, "source"), { source: KEY });
  assert.equal(rules.keyDerived(npcItem(null, ACTOR), null), true);
  assert.equal(rules.worldKeyOf(npcItem(null, null), null, "source").source, null, "нет источника — ключа нет (noSource)");
  assert.equal(rules.sourceKeyOf(npcItem(null, null), null), null);
  assert.deepEqual(rules.worldKeyOf(npcItem(null, ACTOR), null, "slug"), { slug: "x" });
});

test("worldKeyOf: ключ совпадает с тем, под которым resolveRule находит сохранённое правило", () => {
  const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));
  const EFF = "Compendium.pf2e.feat-effects.Item.EEEEEEEEEEEEEEEE";
  const rule = { v: 1, label: "derived", onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: EFF } }] } };
  rules.initCatalog([{ bySource: { [KEY]: rule } }], labels);
  globalThis.game = { pf2e: { ConditionManager: { conditions: new Map() } } };
  try {
    const it = npcItem(null, ACTOR), res = rules.resolveRule({ item: it });
    assert.equal(res?.rule.label, "derived");
    assert.deepEqual(rules.worldKeyOf(it, res, "source"), { source: KEY });
    assert.equal(rules.keyDerived(it, res), true);
  } finally { delete globalThis.game; }
});
