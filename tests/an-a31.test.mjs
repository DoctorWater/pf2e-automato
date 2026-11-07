import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validateRule } from "../scripts/rules.mjs";
import { testPredicate } from "../scripts/predicate.mjs";

/* A31 Gift of the Anemos, первая часть (docs/plan-animist.md): запись заклинания (эффект под Поддержанием) + запись эффекта (крит. промах Ударом по автору). */

const layer = (n) => JSON.parse(readFileSync(new URL(`../rules/catalog${n}.json`, import.meta.url), "utf8")).bySource ?? {};
const merged = Object.assign({}, ...[".pa", ".model", ".onhit", "", ".campaign"].map(layer));
const SPELL = "Compendium.pf2e.spells-srd.Item.x2Gf3lt64eoMocMd", FX = "Compendium.pf2e-automato.effects.Item.";
const pack = (id) => { const d = new URL("../packs/_source/effects/", import.meta.url); return JSON.parse(readFileSync(new URL(readdirSync(d).find((f) => f.endsWith(`_${id}.json`)), d), "utf8")); };
const ok = (r) => { const v = validateRule(r); assert.equal(v.ok, true, JSON.stringify(v.errors)); return v.rule; };

test("A31: заклинание — в catalog.json, запись эффекта (ключ вне pf2e, как Sanctuary) — в catalog.campaign.json; других слоёв нет", () => {
  for (const n of [".pa", ".model", ".onhit"]) assert.ok(!layer(n)[SPELL] && !layer(n)[FX + "AnemosGiftEf0001"], n);
  assert.ok(layer("")[SPELL] && layer(".campaign")[FX + "AnemosGiftEf0001"]);
});

test("A31: сотворение — эффект ауры на себя под Поддержанием, остальное (Step/Shove/Прыжок) — заметка", () => {
  const u = ok(merged[SPELL]).onUse;
  assert.equal(u.targets, "self");
  const [fx, note] = u.apply;
  assert.deepEqual([fx.to, fx.effect.uuid, fx.sustain], ["self", FX + "AnemosGiftEf0001", true]);
  assert.ok(note.note && !note.effect);
});

test("A31: эффект — аура 10 фт. на врагов, метка без правил, оба эффекта под Поддержанием/без срока", () => {
  const g = pack("AnemosGiftEf0001"), m = pack("AnemosMarkEf0001");
  const [aura] = g.system.rules;
  assert.deepEqual([aura.key, aura.radius, aura.effects[0].uuid, aura.effects[0].affects], ["Aura", 10, FX + "AnemosMarkEf0001", "enemies"]);
  assert.equal(g.system.duration.sustained, true);
  assert.deepEqual(m.system.rules, []);
  assert.equal(m.system.slug, "spell-effect-gift-of-the-anemos-aura");
});

test("A31: крит. промах Ударом врага в ауре -> Рефлекс против СЛ заклинаний, провал — off-guard до конца следующего хода автора", () => {
  const [e] = ok(merged[FX + "AnemosGiftEf0001"]).onEvent;
  assert.deepEqual([e.on, e.side], ["attack-roll", "target"]);
  const ch = e.challenge;
  assert.deepEqual([ch.statistic, ch.dc.source, ch.basic, ch.rollerRole], ["reflex", "spell", false, "target"]);
  assert.deepEqual(Object.keys(ch.byDegree).sort(), ["criticalFailure", "failure"]);
  for (const d of ["failure", "criticalFailure"]) {
    const [s] = ch.byDegree[d];
    assert.deepEqual([s.to, s.condition.slug], ["target", "off-guard"], d);
    assert.deepEqual(s.duration, { value: 1, unit: "rounds", expiry: "turn-end", of: "origin" }, d);
  }
  const mark = `origin-effect:${pack("AnemosMarkEf0001").system.slug}`, base = ["self:action:slug:strike", mark, "outcome:criticalFailure"];
  assert.ok(testPredicate(e.when, new Set(base)));
  for (const drop of base) assert.ok(!testPredicate(e.when, new Set(base.filter((o) => o !== drop))), `без ${drop}`);   // не Удар / вне ауры / не крит. промах
  assert.ok(!testPredicate(e.when, new Set([base[1], base[2], "outcome:failure"])));
});
