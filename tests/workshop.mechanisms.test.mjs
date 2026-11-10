import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.game ??= {};
const { MOD } = await import("../scripts/util.mjs");
const { detectMechs, mechRows, mechanismsOf, MECH_IDS } = await import("../scripts/workshop/mechanisms.mjs");
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
  assert.match(row(dragon).sum, /rechargeCrit/);
  assert.doesNotMatch(row(doc()).sum, /rechargeCrit/);
});

test("M1: поля — срок и «не ограничивать»; без формы (вкладка листа) полей нет", () => {
  const d = doc(), f = mechToForm({});
  assert.deepEqual(mechanismsOf(d, env(), f)[0].fields.map((x) => x.path), ["mech.recharge.dice", "mech.recharge.off"]);
  assert.deepEqual(mechanismsOf(d, env())[0].fields, []);
});

test("M3: причины off → пилюли состояния", () => {
  const rule = { onEvent: [{ challenge: null }] }, strikes = [{ name: "Fangs" }];
  const row = (off) => mechanismsOf(doc(), env({ strikeState: () => ({ rule, strikes, off }) })).find((r) => r.id === "strike");
  assert.equal(row(null).state, null);
  assert.match(row("flag").state.text, /state\.flag/);
  assert.match(row("needRule").state.text, /state\.needRule/);
  assert.equal(row("needRule").state.warn, true);
  assert.match(row("mode").state.text, /state\.mode/);
  assert.match(row("yield").state.text, /state\.yield/);
  assert.match(row(null).sum, /Fangs/);
  assert.match(mechanismsOf(doc(), env({ strikeState: () => ({ rule, strikes, off: null }), evText: () => "урон" })).find((r) => r.id === "strike").sum, /урон/);
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
  f.maneuvers.auto = false; f.maneuvers.list.trip = true;
  const manual = mechanismsOf(TK, e, f).find((r) => r.id === "maneuvers");
  assert.deepEqual(manual.fields.map((x) => x.path), ["mech.maneuvers.auto", "mech.maneuvers.list"]);
  assert.deepEqual(manual.fields[1].seg.map((s) => [s.value, s.on]), [["disarm", false], ["shove", false], ["reposition", false], ["trip", true]]);
  const mag = mechanismsOf({ ...TK, slug: "magnetic-attraction" }, e, mechToForm({})).find((r) => r.id === "maneuvers");
  assert.deepEqual(mag.fields, []);
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
  assert.equal(shape.chip, "PF2E.TraitSpellshape");
  assert.match(shape.sum, /Расширенное заклинание/);
  const reach = { id: "r", type: "action", slug: "reach-spell", name: "Reach Spell", system: { description: { value: "" }, traits: { value: [] }, rules: [] }, flags: {}, actor: { type: "npc" } };
  assert.equal(mechanismsOf(reach, env())[0].id, "shape");
  assert.deepEqual(detectMechs({ ...reach, actor: { type: "character" } }, env()), [], "у героя без флага — нет");
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
