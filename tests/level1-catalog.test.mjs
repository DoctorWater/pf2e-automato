import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validateRule, buildCatalog, initCatalog, resolveRule } from "../scripts/rules.mjs";
import { testPredicate } from "../scripts/predicate.mjs";
import { hasEffect } from "../scripts/apply.mjs";

const catalog = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8"));
const workshop = "Compendium.pf2e.spells-srd.Item.rzcXUF5YmJYxgxEa";
const workshopEffect = "Compendium.pf2e.spell-effects.Item.qXWCvqt24iczeN8V";

test("Traveling Workshop: валидное правило применяется владельцу и находится по точному источнику", () => {
  const checked = validateRule(catalog.bySource[workshop]);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  const built = buildCatalog([catalog]);
  assert.deepEqual(built.errors, []);
  assert.ok(built.bySource.has(workshop));

  initCatalog([catalog], {});
  const found = resolveRule({ type: "spell", system: { slug: "traveling-workshop" }, _stats: { compendiumSource: workshop } });
  assert.equal(found?.source, "catalog");
  assert.equal(found.sourceUuid, workshop);
  const use = found.rule.onUse;
  assert.equal(use.targets, "self");
  assert.equal(use.challenge, null);
  assert.equal(use.apply.length, 1);
  assert.equal(use.apply[0].to, "self");
  assert.equal(use.apply[0].effect.uuid, workshopEffect);
});

test("Information Overload и Clinging Ice: срок привязан к Поддержанию (sustain:true), правила валидны", () => {
  // Фиксированная минута без sustain переживала бы прекращение поддержания (C01); теперь каждое выданное привязано к якорю.
  const io = catalog.bySource["Compendium.pf2e.spells-srd.Item.PesUKf0lIt5zRofj"], ice = catalog.bySource["Compendium.pf2e.spells-srd.Item.MraZBLJ4Be3ogmWL"];
  for (const r of [io, ice]) { const v = validateRule(r); assert.equal(v.ok, true, JSON.stringify(v.errors)); }
  const by = io.onUse.challenge.byDegree;
  assert.deepEqual(Object.keys(by).sort(), ["criticalFailure", "failure"]);   // успех и крит. успех — без эффекта
  for (const [deg, value] of [["failure", 1], ["criticalFailure", 2]]) {
    assert.equal(by[deg].length, 1);
    assert.deepEqual(by[deg][0].condition, { slug: "stupefied", value });
    assert.equal(by[deg][0].sustain, true);
    assert.equal(by[deg][0].duration.value, 1); assert.equal(by[deg][0].duration.unit, "minutes");
  }
  assert.equal(io.onUse.challenge.statistic, "will");
  const speed = ice.onUse.challenge.byDegree;
  assert.deepEqual([speed.failure[0].choice, speed.criticalFailure[0].choice], [-5, -10]);
  assert.ok([speed.failure[0], speed.criticalFailure[0]].every((s) => s.sustain === true && s.effect.uuid.endsWith("2sMXAGZfdqiy10kk")));
  assert.equal(ice.onUse.challenge.statistic, "reflex");
  assert.equal(catalog.bySlug["information-overload"], undefined);   // правило по источнику, не по slug
});

/* ---------- плут: Организатор, Пройдоха, Вовлекающий финт (plan §13, L1-R1/R2) ---------- */

const campaign = JSON.parse(readFileSync(new URL("../rules/catalog.campaign.json", import.meta.url), "utf8"));
const FX = "Compendium.pf2e-automato.effects.Item.";
const pack = (id) => { const d = new URL("../packs/_source/effects/", import.meta.url); return JSON.parse(readFileSync(new URL(readdirSync(d).find((f) => f.endsWith(`_${id}.json`)), d), "utf8")); };
const feint = campaign.bySource["Compendium.pf2e.actionspf2e.Item.QNAVeNKtHA0EUw4X"];
/** Исполняемые шаги степени Финта при опциях автора (feat/feature) и выборе. Заметка без when — текст плана карточки, не шаг. */
const live = (deg, opts) => feint.onUse.check.byDegree[deg].filter((s) => s.when ? testPredicate(s.when, new Set(opts)) : !s.note);
const kinds = (list) => list.map((s) => s.choose ? "choose" : s.condition ? `cond:${s.duration.value}` : s.effect ? s.effect.uuid.replace(FX, "") : "note");

test("плут: правила Организатора, Вовлекающего финта и Финта валидны; Финт одинаков по source и slug", () => {
  for (const r of [catalog.bySource["Compendium.pf2e.classfeatures.Item.RyOkmu0W9svavuAB"], catalog.bySource["Compendium.pf2e.feats-srd.Item.9CaaU5szcf3mtJXD"], feint]) {
    const v = validateRule(r);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  }
  assert.deepEqual(buildCatalog([catalog, campaign]).errors, []);
  assert.deepEqual(campaign.bySlug.feint, feint);
});

test("Организатор: успех — метка до начала хода, крит — 1 минута; эффект — off-guard только против помеченного", () => {
  const [s, c] = catalog.bySource["Compendium.pf2e.classfeatures.Item.RyOkmu0W9svavuAB"].onEvent;
  assert.deepEqual([s.when, c.when], [["action:recall-knowledge", "target", "outcome:success"], ["action:recall-knowledge", "target", "outcome:criticalSuccess"]]);
  assert.equal(s.apply[0].mark, "enemy");
  assert.equal(s.apply[0].duration, undefined);
  assert.deepEqual(c.apply[0].duration, { value: 1, unit: "minutes" });
  const fx = pack("MstrmindOffGrd01");
  assert.deepEqual([fx.system.duration.value, fx.system.duration.unit, fx.system.duration.expiry], [1, "rounds", "turn-start"]);
  const eph = fx.system.rules.find((r) => r.key === "EphemeralEffect");
  assert.deepEqual(eph.predicate, ["self:mark:enemy-mastermind"]);
  assert.ok(fx.system.rules.some((r) => r.key === "TokenMark" && r.slug === "enemy-mastermind" && !r.uuid));
});

test("Финт: обычный исход, Пройдоха и Вовлекающий финт взаимоисключающи", () => {
  // без черт — прежний Финт
  assert.deepEqual(kinds(live("success", [])), ["cond:0"]);
  assert.deepEqual(kinds(live("criticalSuccess", [])), ["cond:1"]);
  assert.deepEqual(live("failure", []), []);
  // Пройдоха: успех — эффект с меткой вместо состояния на ход; Шаг — подсказкой при любом исходе
  assert.deepEqual(kinds(live("success", ["feature:scoundrel"])), ["ScndrlOffGuard01", "note"]);
  assert.equal(live("success", ["feature:scoundrel"])[0].mark, "enemy");
  for (const d of ["criticalSuccess", "failure", "criticalFailure"]) assert.ok(live(d, ["feature:scoundrel"]).some((s) => s.to === "self" && /Шагнуть/.test(s.note ?? "")), d);
  // Вовлекающий финт: выбор; «overextend» — только штраф, «feint» — обычный исход
  assert.deepEqual(kinds(live("success", ["feat:overextending-feint", "choice:overextend"])), ["choose", "OvrxtFeintNext01"]);
  assert.deepEqual(kinds(live("criticalSuccess", ["feat:overextending-feint", "choice:overextend"])), ["choose", "OvrxtFeintCrit01"]);
  assert.deepEqual(kinds(live("success", ["feat:overextending-feint", "choice:feint"])), ["choose", "cond:0"]);
  assert.deepEqual(kinds(live("success", ["feat:overextending-feint", "feature:scoundrel", "choice:overextend"])), ["choose", "OvrxtFeintNext01", "note"]);
});

test("Вовлекающий финт: штраф −2 только против автора; обычный успех снимается первой атакой по плуту", () => {
  for (const id of ["OvrxtFeintNext01", "OvrxtFeintCrit01"]) {
    const r = pack(id).system.rules;
    assert.deepEqual(r.find((x) => x.key === "FlatModifier"), { key: "FlatModifier", selector: "attack-roll", type: "circumstance", value: -2, predicate: ["target:mark:overextending-feint"] });
    assert.equal(r.find((x) => x.key === "TokenMark").uuid, "{item|system.context.origin.token}");
  }
  const [e] = catalog.bySource["Compendium.pf2e.feats-srd.Item.9CaaU5szcf3mtJXD"].onEvent;
  assert.deepEqual([e.on, e.side, e.when], ["attack-roll", "target", ["origin-effect:overextending-feint"]]);   // slug крит. эффекта другой: «все атаки» не снимаются
  assert.ok(!testPredicate(e.when, new Set(["origin-effect:overextending-feint-critical-success"])));
  assert.deepEqual(e.apply[0].removeEffect, { uuid: FX + "OvrxtFeintNext01", of: "origin" });
});

test("hasEffect: тот же эффект с меткой на другого врага — не повтор", () => {
  const U = FX + "MstrmindOffGrd01";
  const mk = (mark) => ({ type: "effect", _stats: { compendiumSource: U }, flags: {}, system: { context: { origin: { actor: "Actor.r" } }, rules: [{ key: "TokenMark", slug: "enemy-mastermind", uuid: mark }] } });
  const actor = { items: [mk("Scene.s.Token.a")] };
  assert.ok(hasEffect(actor, U, "Actor.r", null, "Scene.s.Token.a"));
  assert.ok(!hasEffect(actor, U, "Actor.r", null, "Scene.s.Token.b"));
  assert.ok(hasEffect(actor, U, "Actor.r"));   // без метки — прежний дедуп
});

test("Tumble Behind: действующая запись (campaign поверх pa) снимает эффект только при метке цели", () => {
  const pa = JSON.parse(readFileSync(new URL("../rules/catalog.pa.json", import.meta.url), "utf8"));
  const built = buildCatalog([pa, campaign]);
  assert.deepEqual(built.errors, []);
  const rule = built.bySource.get("Compendium.pf2e.feats-srd.Item.YKqMuuC8j35NFh92");
  const rules = [rule.rule ?? rule, ...["tumble-behind-rogue", "tumble-behind"].map((s) => built.bySlug.get(s)).map((r) => r.rule ?? r)];
  for (const r of rules) {
    const removals = r.onEvent.filter((e) => e.apply.some((a) => a.removeEffect));
    assert.deepEqual(removals.map((e) => e.on), ["damage-roll", "attack-roll"]);
    for (const e of removals) {
      const base = ["self:effect:off-guard-tumble-behind", "outcome:failure"];
      assert.equal(testPredicate(e.when, new Set(base)), false, e.on);
      assert.equal(testPredicate(e.when, new Set([...base, "target:mark:enemy-tumble-behind"])), true, e.on);
    }
  }
});
