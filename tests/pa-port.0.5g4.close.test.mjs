// 0.5g4, закрытие п.29–35: выбор оружия эффектом (Celestial Armaments), challenge.when (Lay on Hands), боеприпасы Conjure Bullet, СЛ репеллента без расходника, учёт partial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

globalThis.game = { user: { isActiveGM: true }, settings: { get: () => true }, i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null } };
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o) } };

const events = await import("../scripts/events.mjs");
const saves = await import("../scripts/saves.mjs");
const rules = await import("../scripts/rules.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const pa = await import("../tools/pa-port.mjs");
const ev = await import("../tools/pa-events.mjs");
const cov = await import("../tools/coverage.mjs");

const json = (u) => JSON.parse(readFileSync(new URL(u, import.meta.url), "utf8"));
const g4 = json("../rules/drafts-accepted/pa-port.g4.json").items;
const cat = json("../rules/catalog.pa.json");

test("п.29: Celestial Armaments — условие по оружию из выбора эффекта; опция есть только у выбранного оружия", () => {
  const weapon = { id: "W1" }, other = { id: "W2" };
  const actor = { itemTypes: { effect: [{ slug: "effect-celestial-armaments", flags: { pf2e: { rulesSelections: { weapon: "W1" } } } }] } };
  const opts = (it) => new Set(events.chosenOptions(actor, it));
  assert.ok(opts(weapon).has("item:chosen:celestial-armaments:weapon") && opts(weapon).has("item:chosen:effect-celestial-armaments:weapon"));
  assert.equal(opts(other).size, 0);
  const rule = cat.bySource["Compendium.pf2e.feats-srd.Item.hSm66XVNVjPdbL2c"];
  assert.ok(rule.onEvent[0].when.includes("item:chosen:celestial-armaments:weapon"));
  const base = ["target", "outcome:criticalSuccess", "self:effect:celestial-armaments"];
  assert.equal(events.matchEntries(rule, "attack-roll", "self", new Set([...base, ...opts(weapon)])).length, 1);
  assert.equal(events.matchEntries(rule, "attack-roll", "self", new Set([...base, ...opts(other)])).length, 0);
});

test("п.30: эффекты с TokenMark в правилах вердиктов g4 (onUse и onEvent) всегда с mark:enemy", () => {
  const walk = (o, path, out) => { if (o && typeof o === "object") { if (o.effect?.uuid && ev.hasTokenMark(o.effect.uuid)) out.push([path, o.mark]); for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, out); } return out; };
  const marked = g4.filter((v) => v.rule).flatMap((v) => walk(v.rule, v.slug, []));
  assert.ok(marked.length > 0);
  for (const [path, mark] of marked) assert.equal(mark, "enemy", path);
});

test("п.31: Conjure Bullet — GrantItem на свои боеприпасы с количеством 1 и каскадом", () => {
  const dir = (d) => new URL(`../packs/_source/${d}/`, import.meta.url);
  const read = (d, id) => json(`../packs/_source/${d}/${readdirSync(dir(d)).find((f) => f.endsWith(`_${id}.json`))}`);
  for (const [eff, item] of [["CnjrBulletEffct1", "CnjrBulletItem01"], ["CnjrBoltEffect01", "CnjrBoltItem0001"]]) {
    const grant = read("effects", eff).system.rules[0];
    assert.equal(grant.uuid, `Compendium.pf2e-automato.equipment.Item.${item}`);
    assert.equal(grant.onDeleteActions.granter, "cascade");
    const doc = read("equipment", item);
    assert.deepEqual([doc.type, doc.system.quantity, doc._id], ["ammo", 1, item]);
  }
});

test("п.32: challenge.when — схема, форма туда-обратно, фильтр целей (Lay on Hands: бросает только нежить)", () => {
  const rule = { v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { source: "spell" }, basic: true, when: ["target:trait:undead"], byDegree: {} }, apply: [] } };
  const v = rules.validateRule(rule);
  assert.equal(v.ok, true);
  assert.deepEqual(v.rule.onUse.challenge.when, ["target:trait:undead"]);
  assert.deepEqual(rules.validateRule(formToRule(ruleToForm(v.rule))).rule, v.rule);
  assert.equal(rules.validateRule({ ...rule, onUse: { ...rule.onUse, challenge: { ...rule.onUse.challenge, when: 5 } } }).ok, false);
  const ch = v.rule.onUse.challenge;
  const actor = (uuid, opts) => ({ uuid, getSelfRollOptions: () => opts });
  assert.equal(saves.challengeApplies(ch, actor("A.zombie", ["target:trait:undead"]), "A.cleric"), true);
  assert.equal(saves.challengeApplies(ch, actor("A.fighter", ["target:trait:humanoid"]), "A.cleric"), false);
  assert.equal(saves.challengeApplies({ ...ch, when: undefined }, actor("A.fighter", []), "A.cleric"), true);
  assert.equal(saves.challengeApplies({ ...ch, when: [{ not: "target:self" }] }, actor("A.cleric", []), "A.cleric"), false);
  const loh = cat.bySource["Compendium.pf2e.spells-srd.Item.zNN9212H2FGfM7VS"];
  assert.deepEqual(loh.onUse.challenge.when, ["target:trait:undead"]);
});

test("п.33: Защитная статуэтка — «adjacent» 5 фт, владелец среди кандидатов", () => {
  const choose = ev.EVENT_HANDLERS.wardingStatuetteAttack.steps[0].choose;
  assert.deepEqual(choose, { from: "allies", range: 5, of: "target", withSelf: true });
  assert.equal(cat.bySlug["warding-statuette"].onEvent[0].apply[0].choose.withSelf, true);
});

test("п.34: СЛ Репеллента берётся из предмета компендия, выбранного ChoiceSet эффекта", () => {
  const uuid = "Compendium.pf2e.equipment-srd.Item.C6v5p0ZtIUroYlU2";
  assert.equal(events.chosenSourceUuid({ flags: { pf2e: { rulesSelections: { x: 3, y: uuid } } } }), uuid);
  assert.equal(events.chosenSourceUuid({ flags: { pf2e: { rulesSelections: { w: "Item.abc" } } } }), null);
  assert.equal(events.chosenSourceUuid({}), null);
});

test("п.35: partial — пробелы у вердикта и пометки поверх выведенного правила; в каталог запись не попадает; coverage.md выводит список", () => {
  const drafts = [{ uuid: "U.1", slug: "a", type: "spell" }, { uuid: "Compendium.x.Actor.A.Item.2", slug: "a", type: "action" }, { uuid: "U.3", slug: "b", type: "spell" }];
  const verdicts = [{ slug: "a", partial: ["пробел"] }, { slug: "b", type: "spell", scope: "npc", partial: ["не тот scope"] }, { slug: "b", reason: "без partial" }];
  pa.annotateGaps(drafts, verdicts);
  assert.deepEqual(drafts.map((d) => d.gaps ?? null), [["пробел"], ["пробел"], null]);
  assert.equal(pa.gapsOnly({ slug: "a", partial: ["x"] }), true);
  assert.equal(pa.gapsOnly({ slug: "a", partial: ["x"], rule: {} }), false);
  assert.equal(pa.gapsOnly({ slug: "a", partial: ["x"], accept: true }), false);
  const out = pa.resolveAccepted([{ slug: "a", type: "spell", partial: ["x"], rule: { v: 1 } }], drafts, () => null);
  assert.equal("partial" in out[0], false);
  for (const slug of ["mask-of-terror", "sleep", "bane", "conjure-bullet", "aura-of-courage", "master-strike", "warding-statuette", "warding-statuette-greater"])
    assert.ok(g4.some((v) => v.slug === slug && v.partial?.length && v.partial.every((x) => typeof x === "string" && x)), slug);
  const md = cov.renderMd({ pf2eVersion: "x", generatedAt: "2026-01-01", total: 1, overall: { need: 1, pf2e: 0, catalog: 0, "markup-high": 0, skip: 0 }, skipReasons: {}, byType: {}, byLayer: {}, byBatch: {}, byPriority: {}, priority1ByBatch: {},
    pa: { paVersion: "1", docs: { applicable: 1, total: 1, falseCoverage: 0, notPorted: 0, done: 1, percent: 100, ported: 1, covered: 0, native: 0, debt: 0, partial: 2 }, debt: { bySubpack: {}, byReason: {} }, partialList: [{ slug: "sleep", name: "Sleep", gaps: ["g1", "g2"], docs: 2 }] } });
  assert.match(md, /Партиальные[^\n]*документов 2, правил 1:\n\n- Sleep \(`sleep`, документов 2\): g1; g2/);
});

test("п.35: basic урона — поле строки формы (не в JSON keep), туда-обратно", () => {
  const rule = { v: 1, onUse: { targets: "selected", challenge: { statistic: "reflex", dc: { value: 20 }, basic: true, byDegree: { failure: [{ to: "target", damage: { formula: "1d6", damageType: "fire", basic: true } }] } }, apply: [] } };
  const form = ruleToForm(rule), txt = JSON.stringify(form);
  assert.match(txt, /"dmgBasic":true/);   // поле строки
  assert.doesNotMatch(txt, /keep":"[^"]*dmgBasic/);   // в JSON keep не едет
  assert.deepEqual(rules.validateRule(formToRule(form)).rule, rules.validateRule(rule).rule);
});
