import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

globalThis.game ??= {};
const { deriveStrikeSave } = await import("../tools/strike-save-cond.mjs");
const rules = await import("../scripts/rules.mjs");

const BY = { sl: "slowed", en: "enfeebled", fr: "frightened", st: "stunned", pa: "paralyzed", sk: "sickened", su: "stupefied", pr: "prone", dz: "dazzled" };
const L = (id, label) => `@UUID[Compendium.pf2e.conditionitems.Item.${id}]{${label}}`;
const run = (html) => deriveStrikeSave(html, "X", BY);
const steps = (r) => [r.rule.onUse.challenge.byDegree.failure[0], r.rule.onUse.challenge.byDegree.criticalFailure[0]];

test("«A target damaged by X's Strike must succeed at save or be Slowed 1 until the end of X's next turn»: срок носителя", () => {
  const r = run(`<p>A target damaged by the warden's melee Strike must succeed at a @Check[fortitude|dc:21] save or be ${L("sl", "Slowed 1")} until the end of the warden's next turn.</p>`);
  const ch = r.rule.onUse.challenge;
  assert.deepEqual([ch.statistic, ch.dc.value, ch.basic], ["fortitude", 21, false]);
  const [f, cf] = steps(r);
  assert.deepEqual(f.condition, { slug: "slowed", value: 1, policy: "max" });
  assert.deepEqual(f.duration, { value: 1, unit: "rounds", expiry: "turn-end", of: "origin" });
  assert.deepEqual(cf, f);
});

test("«(Frightened 2 on a critical failure)»: значение крит. провала", () => {
  const [f, cf] = steps(run(`When the voidglutton damages a creature with its claw Strike, the creature must succeed at a @Check[will|dc:26] save or become ${L("fr", "Frightened 1")} (${L("fr", "Frightened 2")} on a critical failure).`));
  assert.deepEqual([f.condition.value, cf.condition.value], [1, 2]);
});

test("«(or Stunned 3 on a critical failure)» и «, or X on a critical failure»", () => {
  assert.deepEqual(steps(run(`A creature struck by Gerhard's punch must succeed at a @Check[fortitude|dc:23] save or be ${L("st", "Stunned 1")} (or ${L("st", "Stunned 3")} on a critical failure).`)).map((s) => s.condition.value), [1, 3]);
  assert.deepEqual(steps(run(`When the loreavor damages a creature with its touch Strike, the creature must succeed at a @Check[will|dc:28] save or become ${L("su", "Stupefied 1")}, or ${L("su", "Stupefied 2")} on a critical failure.`)).map((s) => s.condition.value), [1, 2]);
});

test("срок «for 1 minute», состояние без значения, options:inflicts -> challenge.options", () => {
  const r = run(`A creature that takes damage from a constellation's attack must succeed at a @Check[fortitude|dc:23|options:inflicts:dazzled] save or be ${L("dz", "Dazzled")} for 1 minute.`);
  assert.deepEqual(r.rule.onUse.challenge.options, ["inflicts:dazzled"]);
  const [f] = steps(r);
  assert.deepEqual(f.condition, { slug: "dazzled", policy: "max" });
  assert.deepEqual(f.duration, { value: 1, unit: "minutes", expiry: null, of: "origin" });
});

test("flavor до фразы и «as …» после допустимы", () => {
  assert.ok(run(`<p>Its attacks spatter targets with rancid flesh.</p><p>A creature damaged by a draugr's Strike must succeed at a @Check[fortitude|dc:15] save or become ${L("sk", "Sickened 1")} (${L("sk", "Sickened 2")} on a critical failure).</p>`).rule);
  assert.ok(run(`A creature that takes damage from the dragon's jaws Strike must succeed at a @Check[fortitude|dc:30] save or become ${L("sk", "Sickened 1")} as a surge of water floods its body.`).rule);
});

test("пропуск: условие на цель (non-evil / living)", () => {
  assert.match(run(`A non-evil creature hit by a tentacle must succeed at a @Check[will|dc:28] save or be ${L("st", "Stunned 2")}.`).skip, /условие на цель/);
  assert.match(run(`Any living, non-elf creature hit by a ghoul's attack must succeed at a @Check[fortitude|dc:22] save or become ${L("pa", "Paralyzed")}.`).skip, /условие на цель/);
});

test("пропуск: повторный спасбросок / иммунитет / урон / два состояния / недуг", () => {
  assert.match(run(`A creature damaged by the claw Strike must succeed at a @Check[will|dc:28] save or be ${L("st", "Stunned 2")}. A creature is then temporarily immune for 24 hours.`).skip, /дополнительные условия/);
  assert.match(run(`A creature damaged by the fist Strike must succeed at a @Check[fortitude|dc:22] save or become ${L("sk", "Sickened 1")} and take @Damage[1d6[fire]] damage.`).skip, /разметка/);
  assert.match(run(`A creature that takes damage from a thunderbird's Strike must succeed at a @Check[fortitude|dc:28] save or be knocked ${L("pr", "Prone")} and ${L("dz", "Dazzled")} for 1 round.`).skip, /состояни/);
  assert.match(run(`<p>Saving Throw @Check[fortitude|dc:20]</p><hr /><p>Stage 1 ${L("en", "Enfeebled 1")} (1 round)</p>`).skip, /недуг/);
});

test("пропуск: неоднозначный «its next turn» (не разобран), не разрешённое/без значения состояние", () => {
  assert.match(run(`A creature hit by the claw Strike must succeed at a @Check[fortitude|dc:22] save or be ${L("sl", "Slowed 1")} until the end of its next turn.`).skip, /длительность/);
  assert.match(run(`A creature hit by the claw Strike must succeed at a @Check[fortitude|dc:22] save or be ${L("sk", "Sickened")}.`).skip, /значение/);
});

test("rules/catalog.strike-save.json: все правила проходят validateRule, buildCatalog без ошибок", { skip: !existsSync(new URL("../rules/catalog.strike-save.json", import.meta.url)) }, () => {
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.strike-save.json", import.meta.url), "utf8")).bySource;
  assert.ok(Object.keys(cat).length > 0);
  for (const [u, r] of Object.entries(cat)) assert.ok(rules.validateRule(r).ok, u);
  assert.deepEqual(rules.buildCatalog([{ v: 1, bySource: cat }]).errors, []);
});

test("несколько состояний без срока: «Drained 2 and Doomed 1» (крит. провал — тот же набор)", () => {
  BY.dr = "drained"; BY.do = "doomed";
  const r = run(`When a skulltaker hits with a melee Strike, the target must succeed at a @Check[fortitude|dc:42] save or become ${L("dr", "Drained 2")} and ${L("do", "Doomed 1")}.`);
  assert.deepEqual(r.rule.onUse.challenge.byDegree.failure.map((s) => [s.condition.slug, s.condition.value]), [["drained", 2], ["doomed", 1]]);
  assert.match(run(`A creature that takes damage from a Strike must succeed at a @Check[fortitude|dc:28] save or be knocked ${L("pr", "Prone")} and ${L("dz", "Dazzled")} for 1 round.`).skip, /срок при нескольких/);
});

test("повторный спасбросок в конце хода (без убывания СЛ) -> repeat; с убыванием — пропуск", () => {
  const ok = run(`A creature hit by the puffball's tendril must succeed a @Check[fortitude|dc:28] save or become ${L("pa", "Paralyzed")}. The paralyzed creature can attempt a new save at the end of each of its turns.`);
  assert.deepEqual(ok.rule.onUse.challenge.byDegree.failure[0].repeat, { on: "turn-end", end: ["success", "criticalSuccess"] });
  assert.match(run(`A creature hit by the ghast's attack must succeed at a @Check[fortitude|dc:28] save or become ${L("pa", "Paralyzed")}. It can attempt a new save at the end of each of its turns, and the DC cumulatively decreases by 1 on each such save.`).skip, /убывание СЛ/);
});

test("иммунитет после спасброска -> challenge.immunity; чужое имя способности — пропуск", () => {
  const t = (n) => `A creature hit by a tentacle must succeed at a @Check[will|dc:28] save or be ${L("st", "Stunned 2")}. After attempting this save, a creature is temporarily immune to ${n} for 24 hours.`;
  assert.deepEqual(deriveStrikeSave(t("Mind Lash"), "Mind Lash", BY).rule.onUse.challenge.immunity, { slug: "mind-lash", duration: { value: 24, unit: "hours" } });
  assert.match(deriveStrikeSave(t("Other Thing"), "Mind Lash", BY).skip, /иммунитет/);
});

test("крит. попадание в триггере: правило только когда uuid есть в crit-only.json (critKnown)", () => {
  const t = `If the vavakia critically hits with its tail Strike, the target must succeed at a @Check[fortitude|dc:40] save or become ${L("st", "Stunned 1")}.`;
  assert.ok(deriveStrikeSave(t, "X", BY, true).rule);
  assert.match(run(t).skip, /crit-only/);
});

test("незнакомое предложение после спасброска / про «the creature» до него — пропуск; чистая «вода» до — нет", () => {
  const main = `A creature hit by the claw Strike must succeed at a @Check[fortitude|dc:22] save or be ${L("sl", "Slowed 1")} until the end of the warden's next turn.`;
  assert.match(run(`${main} The creature is pulled toward it.`).skip, /дополнительные/);
  assert.match(run(`The creature is pulled toward the warden. ${main}`).skip, /дополнительные/);
  assert.ok(run(`Its claws drip with brine. ${main}`).rule);
});
