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
  // Пройдоха: успех — эффект с меткой вместо состояния на ход; Шаг — подсказкой при любом исходе, только с ловким/точным ближним оружием в руке
  const agile = ["feature:scoundrel", "self:held:melee", "self:held:melee:trait:agile"];
  assert.deepEqual(kinds(live("success", agile)), ["ScndrlOffGuard01", "note"]);
  assert.equal(live("success", agile)[0].mark, "enemy");
  for (const d of ["criticalSuccess", "failure", "criticalFailure"]) assert.ok(live(d, agile).some((s) => s.to === "self" && /Шагнуть/.test(s.note ?? "")), d);
  for (const d of ["success", "failure"]) assert.ok(!live(d, ["feature:scoundrel", "self:held:melee"]).some((s) => /Шагнуть/.test(s.note ?? "")), `${d}: без ловкого/точного — без Шага`);
  assert.ok(live("success", ["feature:scoundrel", "self:held:melee:trait:finesse"]).some((s) => /Шагнуть/.test(s.note ?? "")), "точное — Шаг есть");
  // Вовлекающий финт: выбор; «overextend» — только штраф, «feint» — обычный исход
  assert.deepEqual(kinds(live("success", ["feat:overextending-feint", "choice:overextend"])), ["choose", "OvrxtFeintNext01"]);
  assert.deepEqual(kinds(live("criticalSuccess", ["feat:overextending-feint", "choice:overextend"])), ["choose", "OvrxtFeintCrit01"]);
  assert.deepEqual(kinds(live("success", ["feat:overextending-feint", "choice:feint"])), ["choose", "cond:0"]);
  assert.deepEqual(kinds(live("success", ["feat:overextending-feint", ...agile, "choice:overextend"])), ["choose", "OvrxtFeintNext01", "note"]);
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

/* ---------- наговоры ведьмы, первая партия (docs/plan-hexes.md): действующая запись = слои pa → model → onhit → cat → campaign, ключ заменяется целиком ---------- */

const layer = (n) => JSON.parse(readFileSync(new URL(`../rules/catalog${n}.json`, import.meta.url), "utf8")).bySource ?? {};
const merged = Object.assign({}, ...[".pa", ".model", ".onhit", "", ".campaign"].map(layer));
const SP = "Compendium.pf2e.spells-srd.Item.";
const hex = (id) => { const r = merged[SP + id]; const v = validateRule(r); assert.equal(v.ok, true, JSON.stringify(v.errors)); return r.onUse; };
const flat = (u) => [...(u.apply ?? []), ...Object.values(u.challenge?.byDegree ?? {}).flat()];
const IMM = FX + "DscrnSecrImm0001";

test("наговоры ведьмы: Stoke the Heart и Discern Secrets — эффект под Поддержанием, у Discern — иммунитет на минуту", () => {
  const sth = hex("GeUbPvwdZ4B4l0up");
  assert.deepEqual(sth.apply.map((s) => [s.effect.uuid.split(".").pop(), s.sustain]), [["TpVkVALUBrBQjULn", true]]);
  const ds = hex("UmXhuKrYZR3W16mQ").apply;
  assert.equal(ds[0].effect.uuid.split(".").pop(), "pzbU0cdyRvE66XBi");
  assert.equal(ds[0].sustain, true); assert.equal(ds[0].unlessEffect, IMM);   // повтор в минуту — отказ
  assert.equal(ds[1].effect.uuid, IMM); assert.equal(ds[1].sustain, undefined);   // иммунитет не привязан к якорю
  assert.equal(pack("DscrnSecrImm0001").system.duration.value, 1);
});

test("наговоры ведьмы: Share Vision: replace только на первом шаге (снимает прежний у всех актёров; на втором шаге снял бы только что выданный автору); Trade Death — быстрое исцеление под Поддержанием", () => {
  const sv = hex("TRlI5zAbNW2hDiH9").apply.filter((s) => s.effect);
  assert.deepEqual(sv.map((s) => [s.to, s.effect.replace]), [["self", true], ["target", undefined]]);
  const u = hex("4U2ZV1v38D0y2CRl"), by = u.challenge.byDegree;
  assert.equal(u.challenge.basic, true);
  assert.deepEqual(Object.keys(by).sort(), ["criticalFailure", "failure", "success"]);   // крит. успех — ничего
  for (const steps of Object.values(by)) {
    const e = steps.find((s) => s.to === "chosen");
    assert.equal(e.effect.uuid.split(".").pop(), "oNAqqcxPjzPCJJmW"); assert.equal(e.sustain, true);
  }
});

test("наговоры ведьмы: Evil Eye и Scrounger's Glee — состояние по степеням плюс минимум-эффект под Поддержанием", () => {
  for (const [id, slug, floor] of [["f45JpY7Ph2cAJGW2", "sickened", "EvilEyeFloorEf01"], ["VNv96dJPi0WXKSFN", "frightened", "ScrngGleeFloor01"]]) {
    const ch = hex(id).challenge, by = ch.byDegree;
    assert.equal(ch.statistic, "will");
    assert.deepEqual(Object.keys(by).sort(), ["criticalFailure", "failure"]);
    for (const [deg, value] of [["failure", 1], ["criticalFailure", 2]]) {
      const c = by[deg].find((s) => s.condition), e = by[deg].find((s) => s.effect);
      assert.deepEqual(c.condition, { slug, value, policy: "max" });
      assert.equal(c.sustain, undefined);   // само состояние переживает наговор; под якорь идёт только минимум
      assert.equal(e.effect.uuid, FX + floor); assert.equal(e.sustain, true);
    }
    const doc = pack(floor), g = doc.system.rules[0];
    assert.equal(doc.system.duration.sustained, true);
    assert.equal(g.key, "GrantItem"); assert.equal(g.alterations[0].value, 1); assert.equal(g.onDeleteActions.grantee, "restrict");
  }
});

test("наговоры ведьмы: Information Overload и Clinging Ice остаются под Поддержанием (слои не перекрывают запись)", () => {
  for (const id of ["PesUKf0lIt5zRofj", "MraZBLJ4Be3ogmWL"]) assert.ok(flat(hex(id)).every((s) => s.sustain === true), id);
});

test("Подкидывание улик: действующая запись — Воровство против Восприятия, исходы заметкой в карточке, без автоматики предмета", () => {
  const r = merged["Compendium.pf2e.feats-srd.Item.eww9tuiXPnZFZ3DU"], v = validateRule(r);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const c = r.onUse.check;
  assert.deepEqual([c.statistic, c.vs.defense, c.options], ["thievery", "perception", ["action:plant-evidence"]]);
  assert.deepEqual(Object.keys(c.byDegree), ["criticalSuccess", "success", "criticalFailure"]);
  assert.ok(Object.values(c.byDegree).flat().every((s) => s.to === "self" && s.note && !s.effect && !s.condition));
});

test("последняя партия ведьмы: Forbidding Ward под Поддержанием; Phase Familiar и Cackle — заметки к эффекту/заклинанию", () => {
  const fw = hex("RA7VKcen3p56rVyZ").apply;
  assert.deepEqual(fw.filter((s) => s.effect).map((s) => [s.effect.uuid.split(".").pop(), s.sustain]), [["ctMxYPGEpstvhW9C", true]]);
  const pf = hex("rMOI8JFJ0nT2mrCF").apply;
  assert.equal(pf.find((s) => s.effect).effect.uuid.split(".").pop(), "61Hl31nyzt63vvX9");
  assert.ok(pf.every((s) => !/придерживает/.test(s.note ?? "")));   // удержание урона — механизм onDamaged, не заметка
  const ck = hex("YVK3JUkPVzHIeGXQ").apply;
  assert.ok(ck.length === 1 && /«Поддержать»/.test(ck[0].note) && !ck[0].effect && !ck[0].condition);
});

test("Толчок: подсказка Подкидывания улик — только Головорезу с чертой, на успехе и крит. успехе; bySlug совпадает", () => {
  const shove = campaign.bySource["Compendium.pf2e.actionspf2e.Item.7blmbDrQFNfdT731"];
  assert.deepEqual(campaign.bySlug.shove, shove);
  const by = shove.onUse.check.byDegree;
  for (const d of ["success", "criticalSuccess"]) {
    const n = by[d].filter((s) => /Подкидывание улик/.test(s.note ?? ""));
    assert.equal(n.length, 1, d);
    assert.deepEqual(n[0].when, ["feature:ruffian", "feat:plant-evidence"]);
    assert.equal(testPredicate(n[0].when, new Set(["feature:ruffian"])), false);
    assert.equal(testPredicate(n[0].when, new Set(["feature:ruffian", "feat:plant-evidence"])), true);
  }
  for (const d of ["failure", "criticalFailure"]) assert.ok(!(by[d] ?? []).some((s) => /Подкидывание улик/.test(s.note ?? "")), d);
});

/* ---------- анимист, первая партия (docs/plan-animist.md): действующая запись = слои, ключ заменён целиком ---------- */

const model = layer(".model");
const sourceOf = (id) => id.split(".").pop();

test("анимист: A27, A28, A33, A20, A32 — шаг эффекта под Поддержанием, остальная запись как в model", () => {
  for (const [id, fx] of [["ew4ToaTU3o8ahKio", "aaA6cgroFMRMsisy"], ["wTldMJx0vyBAehrI", "Le5Sewk43o7V60nO"], ["X4On99Nti8gjWywG", "uiXWJVwWuMS3KvkV"], ["h2DLv8TQV0Z83tQp", "C2jiokGoehvLu0fi"], ["rzcXUF5YmJYxgxEa", "qXWCvqt24iczeN8V"]]) {
    const u = hex(id);
    assert.equal(u.targets, "self", id);
    assert.deepEqual(u.apply.map((s) => [s.to, sourceOf(s.effect.uuid), s.sustain]), [["self", fx, true]], id);
    // перенос из model ничего не потерял: без sustain запись совпадает с модельной
    const base = model[SP + id];
    if (id !== "rzcXUF5YmJYxgxEa") assert.ok(base, `в catalog.model нет ${id}`);
    if (base) { const s = structuredClone(merged[SP + id]); delete s.onUse.apply[0].sustain; assert.deepEqual(s, base, id); }
  }
});

test("Garden of Healing: лечение rank d4 в области, метка под Поддержанием; конец — эффект JhxAUu3JEyERedMd; повторного лечения при нём нет", () => {
  const r = merged[SP + "w4M6Vqvq8k6MOFvj"], u = hex("w4M6Vqvq8k6MOFvj"), LING = "Compendium.pf2e.spell-effects.Item.JhxAUu3JEyERedMd";
  assert.equal(u.targets, "area");
  const [heal, mark] = u.apply;
  assert.deepEqual(heal.damage, { formula: "(@item.rank)d4", damageType: "healing" });
  assert.equal(mark.effect.uuid, FX + "GardnHealedMark1"); assert.equal(mark.sustain, true);
  assert.ok([heal, mark].every((s) => s.unlessEffect === LING && s.to === "target"));
  const [e] = r.onEvent;
  assert.deepEqual([e.on, e.side, e.apply[0].effect.uuid], ["effect-deleted", "origin", LING]);
  const slug = pack("GardnHealedMark1").system.slug;
  assert.equal(slug, "spell-effect-garden-of-healing-healed");
  assert.ok(testPredicate(e.when, new Set(["effect:origin", `effect:slug:${slug}`])));
  assert.ok(!testPredicate(e.when, new Set(["effect:origin", "effect:slug:spell-effect-garden-of-healing"])));   // конец самого бонуса цепочку не запускает
  assert.equal(pack("GardnHealedMark1").system.duration.sustained, true);
});

test("Earth's Bile: Рефлекс basic, огонь и дробящий 1d4 за два круга; персистент — только при провале, ×2 при крит. провале", () => {
  const ch = hex("PrlR2sLWeiuTcPF2").challenge, by = ch.byDegree;
  assert.deepEqual([ch.statistic, ch.basic], ["reflex", true]);
  assert.deepEqual(Object.keys(by).sort(), ["criticalFailure", "failure", "success"]);
  const dmg = (d) => by[d].filter((s) => s.damage).map((s) => [s.damage.damageType, s.damage.basic]);
  for (const d of Object.keys(by)) assert.deepEqual(dmg(d), [["fire", true], ["bludgeoning", true]], d);
  assert.deepEqual(by.success.filter((s) => s.persistent), []);
  assert.deepEqual([by.failure, by.criticalFailure].map((l) => l.find((s) => s.persistent).persistent.formula), ["(ceil(@item.rank/2))", "(2*ceil(@item.rank/2))"]);
});
