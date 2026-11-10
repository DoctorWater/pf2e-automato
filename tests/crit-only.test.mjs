import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

globalThis.game ??= {};
const { critOnly, buildCritOnly } = await import("../tools/crit-only.mjs");
const rules = await import("../scripts/rules.mjs");
const { strikeLinkBase } = await import("../scripts/strike-link.mjs");

const ITEMS = new URL("../tools/out/items.json", import.meta.url);
const corpus = existsSync(ITEMS) ? JSON.parse(readFileSync(ITEMS, "utf8")).items : null;
const desc = (name, i = 0) => corpus.filter((x) => x.name === name && x.actionType === "passive" && x.type === "action")[i].descEn;
const skip = { skip: !corpus };

test("critOnly: формулировки (Maiming Chop, Unbalancing Blow, Stunning Shock, Soul Siphon -> крит; Blindness, Feasting Bite, Personal Quake -> нет)", () => {
  assert.equal(critOnly("On a critical hit, the target takes @Damage[1d6[bleed]] and is @UUID[X]{Off-Guard}."), true, "Maiming Chop: крит в начале");
  assert.equal(critOnly("Creatures Mialari hits with a critical hit are @UUID[X]{Off-Guard} against her attacks."), true, "Unbalancing Blow");
  assert.equal(critOnly("Whenever your Strike is a critical hit and deals damage, the target is Off-Guard."), true);
  assert.equal(critOnly("A creature critically hit by the electric eel's tail must attempt a @Check[fortitude|dc:17] save.\n---\nCritical Success unaffected"), true, "Stunning Shock");
  assert.equal(critOnly("When the forge-spurned critically hits a target with its soul chain, it leeches. The target must attempt a save."), true, "Soul Siphon");
  assert.equal(critOnly("A creature damaged by the beam Strike must make a @Check[fortitude] save. If the Strike was a critical hit, the result is worsened."), false, "Blindness");
  assert.equal(critOnly("If Cephal critically succeeds at a jaws Strike against a foe or successfully hits a helpless foe with a jaws Strike, he gnaws."), false, "Feasting Bite");
  assert.equal(critOnly("A creature struck by a seismic spear is Clumsy 3 for 1 round. On a critical hit, a target must succeed at a save or be Petrified."), false, "Personal Quake");
});

test("critOnly: три английские формулировки не дают ложного крита", () => {
  assert.equal(critOnly("On a hit or critical hit, the target is Off-Guard."), false);
  assert.equal(critOnly("She deals @Damage[2d6[untyped]] damage doubled on a critical hit to a metal item."), false);
  assert.equal(critOnly("Hit: Clumsy 3. On a critical hit, also Petrified."), false);
  assert.equal(critOnly("It also deals @Damage[1d4[bleed]] if the target was Off-Guard or if the attack was a critical hit."), false, "Bloodletting: «or if … critical hit»");
});

test("critOnly: корпус — реальные тексты", skip, () => {
  assert.equal(critOnly(desc("Unbalancing Blow", 1)), true);
  assert.equal(critOnly(desc("Stunning Shock")), true);
  assert.equal(critOnly(desc("Soul Siphon")), true);
  for (const n of ["Blindness", "Feasting Bite", "Personal Quake"]) assert.equal(critOnly(desc(n)), false, n);
  assert.equal(critOnly(desc("Bloodletting")), false, "Bloodletting: «Off-Guard or critical hit»");
  assert.equal(critOnly(desc("Bloodletting", 1)), true, "Bloodletting: только крит");
});

const RU = "Существо, получившее критическое попадание, ...";
const item = (src, type = "action", extra = {}) => ({ type, slug: "x-fx", name: "X", _stats: { compendiumSource: src }, system: { actionType: { value: "passive" }, frequency: null, description: { value: RU } }, ...extra });
const RULE = rules.validateRule({ v: 1, label: "L", onUse: { targets: "selected", apply: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } }).rule;
const whenOf = (it) => strikeLinkBase({ rule: RULE, source: "catalog" }, it, [{ type: "melee", system: { attackEffects: { value: ["x-fx"] } } }]).onEvent[0].when;

test("рантайм: признак из оверлея по uuid и slug, русский текст не читается", () => {
  try {
    rules.initOverlays(null, null, null, null, { v: 1, bySource: { SRC: 1 }, bySlug: { "x-fx@feat": 1 } });
    assert.deepEqual(whenOf(item("SRC")), ["target", "item:attack-effect:x-fx", "outcome:criticalSuccess"]);
    assert.ok(whenOf(item(null, "feat")).includes("outcome:criticalSuccess"), "bySlug с типом");
    assert.deepEqual(whenOf(item("OTHER")), ["target", "item:attack-effect:x-fx"], "нет записи — каждое попадание, хоть в тексте «критическое попадание»");
    rules.initOverlays(null, null, null, null, null);
    assert.deepEqual(whenOf(item("SRC")), ["target", "item:attack-effect:x-fx"], "нет оверлея");
  } finally { rules.initOverlays(null, null, null, null, null); }
});

test("оверлей: совпадает с английским текстом корпуса; у остальных признака нет", skip, () => {
  const ov = buildCritOnly(corpus);
  try {
    rules.initOverlays(null, null, null, null, ov);
    let crit = 0, plain = 0;
    for (const it of corpus) {
      if (!["action", "feat"].includes(it.type) || it.actionType !== "passive" || !it.uuid) continue;
      const want = critOnly(it.descEn);
      assert.equal(rules.critOnlyEntry({ type: it.type, slug: it.slug, _stats: { compendiumSource: it.uuid }, system: { description: { value: RU } } }), want || (!!ov.bySlug[`${it.slug}@${it.type}`]), it.name);
      want ? crit++ : plain++;
    }
    assert.ok(crit > 300 && plain > 100, `${crit}/${plain}`);
  } finally { rules.initOverlays(null, null, null, null, null); }
});

test("rules/crit-only.json соответствует сборке по items.json", skip, () => {
  const f = new URL("../rules/crit-only.json", import.meta.url);
  assert.ok(existsSync(f), "node tools/crit-only.mjs");
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { v: 1, ...buildCritOnly(corpus) });
});
