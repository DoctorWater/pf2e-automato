import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveFromMarkup, itemDuration } from "../scripts/rules.mjs";

// Срок состояний, второе испытание и последовательность: «markup-high» значит «верно» (образцы текста — из компендия).
const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));
const IDS = { HL2l2VRSaQHu9lUw: "fatigued", MIRkyAjyBeXivMa7: "enfeebled", dfCMdR4wnpbYNTix: "stunned", xYTAsEpcJE1Ccni3: "slowed", AJh5ex99aV6VTggg: "off-guard", i3OJZU2nk64Df3xm: "clumsy" };
const condSlug = (u) => IDS[u.split(".").pop()] ?? null;
const NAMES = [["slowed", "slowed"], ["stunned", "stunned"], ["fatigued", "fatigued"], ["enfeebled", "enfeebled"], ["clumsy", "clumsy"]];
const U = (id, label) => `@UUID[Compendium.pf2e.conditionitems.Item.${id}]{${label}}`;
const FA = U("HL2l2VRSaQHu9lUw", "Fatigued"), EN1 = U("MIRkyAjyBeXivMa7", "Enfeebled 1"), EN2 = U("MIRkyAjyBeXivMa7", "Enfeebled 2"), ST = U("dfCMdR4wnpbYNTix", "Stunned 3"), SL1 = U("xYTAsEpcJE1Ccni3", "Slowed 1");
const p = (deg, txt) => `<p><strong>${deg}</strong> ${txt}</p>`;
const derive = (html, { duration, pre = "<p>The creature must attempt a save.</p><hr />" } = {}) =>
  deriveFromMarkup({ type: "spell", name: "T", system: { description: { value: pre + html }, defense: { save: { statistic: "fortitude", basic: false } }, ...(duration && { duration }) } }, labels, condSlug, NAMES);
const by = (d) => Object.fromEntries(Object.entries(d.rule.onUse.challenge.byDegree).map(([k, v]) => [k, v.map((a) => [a.condition.slug, a.condition.value, a.duration && `${a.duration.value}${a.duration.unit}`])]));

test("itemDuration: конечный срок, sustained — верхняя граница; остальное — null", () => {
  assert.deepEqual(itemDuration({ value: "1 minute", sustained: false }), { value: 1, unit: "minutes" });
  assert.deepEqual(itemDuration({ value: "10 minutes", sustained: true }), { value: 10, unit: "minutes" });
  assert.deepEqual(itemDuration({ value: "sustained up to 1 minute" }), { value: 1, unit: "minutes" });
  for (const v of ["varies", "unlimited", "until the end of your next turn", "", null]) assert.equal(itemDuration({ value: v }), null, String(v));
  assert.equal(itemDuration(undefined), null);
});

test("Day's Weight: «A and B for N» — срок обоим, «for the duration» — из system.duration", () => {
  const html = p("Success", `The target is ${FA} and ${EN1} for 1 round.`) + p("Failure", `The target is fatigued and enfeebled 1 for the duration.`);
  const d = derive(html, { duration: { value: "1 minute", sustained: false } });
  assert.equal(d.confidence, "high");
  assert.deepEqual(by(d), { success: [["fatigued", undefined, "1rounds"], ["enfeebled", 1, "1rounds"]], failure: [["fatigued", undefined, "1minutes"], ["enfeebled", 1, "1minutes"]] });
  assert.deepEqual(by(derive(html, { duration: { value: "1 minute", sustained: true } })).failure[0], ["fatigued", undefined, "1minutes"]);
});

test("Day's Weight: «fatigued doesn't end when the duration does» — low", () => {
  const html = p("Failure", `The target is fatigued and enfeebled 1 for the duration.`) + p("Critical Failure", `The target is fatigued and ${EN2} for the duration. The fatigued condition doesn't end when the spell's duration does.`);
  assert.equal(derive(html, { duration: { value: "1 minute" } }).confidence, "low");
});

test("«for the duration» без конечного срока документа — low, без срока на шаге", () => {
  const html = p("Failure", `The target is ${EN1} for the duration.`);
  for (const duration of [{ value: "varies" }, { value: "unlimited" }, undefined]) {
    const d = derive(html, { duration });
    assert.equal(d.confidence, "low");
    assert.deepEqual(by(d), { failure: [["enfeebled", 1, undefined]] });
  }
});

test("цепочка через запятую и «and»; иммунитет «for 24 hours» не считается сроком", () => {
  const d = derive(p("Failure", `The target is ${SL1}, ${U("i3OJZU2nk64Df3xm", "Clumsy 1")} and ${EN1} for 1 minute.`));
  assert.equal(d.confidence, "high");
  assert.deepEqual(by(d).failure.map((x) => x[2]), ["1minutes", "1minutes", "1minutes"]);
  const imm = derive(p("Failure", `The target is ${SL1}. It is then immune to this spell for 24 hours.`));
  assert.equal(imm.confidence, "high");
  assert.deepEqual(by(imm), { failure: [["slowed", 1, undefined]] });
});

test("Scene Stealer's Tunic: срок есть в тексте цепочки «As …», но состоянию не достался — low", () => {
  const html = p("Success", "The target takes a –1 status penalty to Perception checks; these penalties last for 1 minute.") + p("Failure", `As success, but the target is also ${U("AJh5ex99aV6VTggg", "Off-Guard")}.`) + p("Critical Failure", `As failure, but the target also becomes ${SL1} as they spend extra time admiring you.`);
  const d = derive(html);
  assert.equal(d.confidence, "low");
  assert.deepEqual(by(d).criticalFailure, [["slowed", 1, undefined]]);
});

test("«As failure, but for 1 minute»: срок блока-ссылки не переносится молча — low", () => {
  const d = derive(p("Failure", `The target is ${SL1} for 1 round.`) + p("Critical Failure", "As failure, but for 1 minute."));
  assert.equal(d.confidence, "low");
});

test("убывающие сами состояния (frightened) — без срока и не low; «As failure» берёт срок того же состояния", () => {
  const FR = "@UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}";
  const ids = { ...IDS, TBSHQspnbcqxsmjL: "frightened" };
  const d = deriveFromMarkup({ type: "action", name: "T", system: { description: { value: `<hr />` + p("Failure", `The target is ${FR} and can't act for 1 round.`) }, defense: { save: { statistic: "will" } } } }, labels, (u) => ids[u.split(".").pop()] ?? null, NAMES);
  assert.equal(d.confidence, "high");
  const e = derive(p("Failure", `The target is ${SL1} for 1 round.`) + p("Critical Failure", `As failure, but the target is ${U("xYTAsEpcJE1Ccni3", "Slowed 2")}.`));
  assert.equal(e.confidence, "high");
  assert.deepEqual(by(e).criticalFailure, [["slowed", 2, "1rounds"]]);
});

test("Divinity Leech: блоки степеней относятся ко второму испытанию — low", () => {
  const pre = `<p>If the target fails its save, it is ${FA}.</p><p>For the spell's duration, whenever the target casts a divine spell, the target must attempt another Will save with the following effects.</p><hr />`;
  const html = p("Failure", `The divine spell is lost and target is ${U("dfCMdR4wnpbYNTix", "Stunned 1")}.`);
  const d = derive(html, { pre });
  assert.equal(d.confidence, "low");
  assert.deepEqual(d.hints.lowWhy, ["second-save"]);
  // «another save to end it» — повтор после блоков/для снятия, блоки относятся к первому
  const ok = derive(html, { pre: "<p>The target is paralyzed. It can attempt another save at the end of each turn to end it.</p><hr />" });
  assert.equal(ok.confidence, "high");
});

test("Fracture Timeflow: «stunned 3, then slowed 2 … after they recover» — второе в подсказку, low", () => {
  const html = p("Failure", `The target is ${SL1} for 1 round.`) + p("Critical Failure", `The target is ${ST}, then slowed 2 for 1 round after they recover from being stunned.`);
  const d = derive(html);
  assert.equal(d.confidence, "low");
  assert.deepEqual(by(d).criticalFailure, [["stunned", 3, undefined]]);
  assert.ok(d.hints.possible.includes("criticalFailure:slowed"));
  assert.deepEqual(d.hints.lowWhy, ["sequence"]);
});

test("«then» вне связки двух состояний — не последовательность", () => {
  const d = derive(p("Failure", `The target is ${SL1} for 1 round. It then takes 1d6 damage and is ${U("dfCMdR4wnpbYNTix", "Stunned 1")}.`));
  assert.equal(d.hints.lowWhy.includes("sequence"), false);
  const d2 = derive(p("Failure", `The target is ${SL1} and ${EN1} for 1 round, and then rolls initiative.`));
  assert.equal(d2.confidence, "high");
  assert.deepEqual(by(d2).failure.map((x) => x[2]), ["1rounds", "1rounds"]);
});
