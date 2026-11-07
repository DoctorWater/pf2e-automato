import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validateRule } from "../scripts/rules.mjs";
import { testPredicate } from "../scripts/predicate.mjs";

const catalog = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8"));
const rule = catalog.bySource["Compendium.pf2e.spells-srd.Item.SAmyaiVKTDrUNjot"];
const dir = new URL("../packs/_source/effects/", import.meta.url);
const pack = (id) => JSON.parse(readFileSync(new URL(readdirSync(dir).find((f) => f.endsWith(`_${id}.json`)), dir), "utf8"));

test("A21 Nymph's Grace: запись валидна, эффект ауры под Поддержанием", () => {
  const v = validateRule(rule);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const [step] = rule.onUse.apply;
  assert.deepEqual([rule.onUse.targets, step.to, step.sustain], ["self", "self", true]);
  const fx = pack(step.effect.uuid.split(".").pop());
  assert.equal(fx.system.duration.sustained, true);
});

test("A21: вход и начало хода в 10 фт, раз в раунд, Воля по СЛ заклинания, confused 1 раунд врагам; живёт, пока есть эффект", () => {
  const fx = pack("NymphGraceAura01");
  assert.deepEqual(rule.onEvent.map((e) => [e.on, e.side, e.range, e.per]), [["enter", "near", 10, "round"], ["turn-start", "near", 10, "round"]]);
  for (const e of rule.onEvent) {
    assert.ok(testPredicate(e.when, new Set([`self:effect:${fx.system.slug.replace(/^(?:spell-)?effect-/, "")}`])));
    assert.ok(!testPredicate(e.when, new Set()));   // якоря нет — запись молчит
    assert.deepEqual([e.challenge.statistic, e.challenge.dc, e.challenge.basic], ["will", { source: "spell" }, false]);
    assert.deepEqual(Object.keys(e.challenge.byDegree).sort(), ["criticalFailure", "failure"]);
    for (const steps of Object.values(e.challenge.byDegree)) {
      assert.ok(steps.every((s) => s.who === "enemy"));
      const c = steps.find((s) => s.condition);
      assert.deepEqual([c.condition.slug, c.condition.value, c.duration.value, c.duration.unit], ["confused", 1, 1, "rounds"]);
      assert.ok(steps.some((s) => s.note));   // «не вредит автору» — заметка ГМу
    }
  }
});
