// A24 Discomfiting Whispers: запись заклинания (метка ауры под Поддержанием + near turn-start с Волей) и запись штатного эффекта (урон void при провале). Без Foundry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validateRule } from "../scripts/rules.mjs";
import { testPredicate } from "../scripts/predicate.mjs";

const catalog = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8")).bySource;
const SPELL = "Compendium.pf2e.spells-srd.Item.t1e3U2eluRsp2izf", MIS = "Compendium.pf2e.spell-effects.Item.JfvVyMWuD8yvSrIe", AURA_ID = "DscmfWhspAura001";
const dir = new URL("../packs/_source/effects/", import.meta.url);
const aura = JSON.parse(readFileSync(new URL(readdirSync(dir).find((f) => f.endsWith(`_${AURA_ID}.json`)), dir), "utf8"));

test("A24: записи валидны", () => {
  for (const k of [SPELL, MIS]) { const v = validateRule(catalog[k]); assert.equal(v.ok, true, JSON.stringify(v.errors)); }
});

test("A24: метка ауры на авторе под Поддержанием; near turn-start срабатывает только пока она есть", () => {
  const r = catalog[SPELL], [step] = r.onUse.apply;
  assert.deepEqual([r.onUse.targets, step.to, step.effect.uuid, step.sustain], ["self", "self", `Compendium.pf2e-automato.effects.Item.${AURA_ID}`, true]);
  assert.equal(aura.system.duration.sustained, true);
  const [e] = r.onEvent;
  assert.deepEqual([e.on, e.side, e.range, e.per], ["turn-start", "near", 5, "round"]);
  assert.ok(testPredicate(e.when, new Set([`self:effect:${aura.system.slug.replace(/^(?:spell-)?effect-/, "")}`])));
  assert.ok(!testPredicate(e.when, new Set()));
});

test("A24: Воля — провал и крит. провал дают эффект misfortune, успех — нет", () => {
  const ch = catalog[SPELL].onEvent[0].challenge;
  assert.deepEqual([ch.statistic, ch.basic, ch.rollerRole], ["will", false, "target"]);
  assert.deepEqual(Object.keys(ch.byDegree).sort(), ["criticalFailure", "failure"]);
  for (const d of Object.values(ch.byDegree)) assert.equal(d.find((s) => s.effect).effect.uuid, MIS);
  // срок по цели: иначе pf2e берёт инициативу автора и эффект рождается истёкшим, если цель ходит после него
  for (const d of Object.values(ch.byDegree)) assert.deepEqual(d.find((s) => s.effect).duration, { value: 0, unit: "rounds", expiry: "turn-end", of: "target" });
});

test("A24: штатный эффект уже бросает дважды и расходуется; запись добавляет только void при провале атаки", () => {
  const [e] = catalog[MIS].onEvent, [s] = e.apply;
  assert.deepEqual([e.on, e.side, s.to, s.damage.damageType], ["attack-roll", "self", "self", "void"]);
  assert.equal(s.damage.formula, "(ceil(@item.level/2))d6");
  assert.ok(testPredicate(e.when, new Set(["outcome:failure"])) && testPredicate(e.when, new Set(["outcome:criticalFailure"])));
  assert.ok(!testPredicate(e.when, new Set(["outcome:success"])));
});
