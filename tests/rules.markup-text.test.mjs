// dc {expr:"markup"}: «текст копии решает» — степени и иммунитет из текста, провал прозой, тёзка без спасброска; pa-port: saveBeyondSelf.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initCatalog, resolveRule, proseBlocks, immunityFromText, immunityDuration } from "../scripts/rules.mjs";
import { saveBeyondSelf } from "../tools/pa-port.mjs";

const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));
const CONDS = { SICK: "sickened", SLOW: "slowed", CLUM: "clumsy", DOOM: "doomed" };
const link = (id, label) => `@UUID[Compendium.pf2e.conditionitems.Item.${id}]{${label}}`;
const slugOf = (u) => CONDS[/Item\.(\w+)$/.exec(u)?.[1]] ?? null;
const SICK = link("SICK", "Sickened 1"), SLOW = link("SLOW", "Slowed 1"), CLUM = link("CLUM", "Clumsy 1"), DOOM2 = link("DOOM", "Doomed 2");

test("proseBlocks: «save or become X (plus Y … on a critical failure)» — Y на срок «пока X» в подсказку, X наследуется", () => {
  const p = proseBlocks(`<p>must succeed at a @Check[fortitude|dc:20] save or become ${SICK} (plus ${SLOW} as long as it's sickened on a critical failure). A creature that succeeds is immune.</p>`, slugOf);
  assert.equal(p.blocks.failure.includes("Sickened 1"), true);
  assert.match(p.blocks.criticalFailure, /^As failure,/);
  assert.deepEqual(p.possible, ["criticalFailure:slowed"]);
});

test("proseBlocks: «On a failure … or X on a critical failure», «(1 minute on a critical failure)», крит. провал отдельным предложением", () => {
  const a = proseBlocks(`<p>On a failure, the creature is ${SICK}, or ${link("SICK", "Sickened 2")} on a critical failure.</p>`, slugOf);
  assert.match(a.blocks.failure, /Sickened 1/); assert.doesNotMatch(a.blocks.failure, /Sickened 2/);
  assert.match(a.blocks.criticalFailure, /\{Sickened 2\}/);
  const b = proseBlocks(`<p>A creature that fails its save becomes ${CLUM} for 1 round (1 minute on a critical failure).</p>`, slugOf);
  assert.match(b.blocks.criticalFailure, /for 1 minute/);
  const c = proseBlocks(`<p>must succeed at a save or gain the ${link("DOOM", "Doomed 1")} condition. A critical failure increases this condition to ${DOOM2}.</p>`, slugOf);
  assert.match(c.blocks.failure, /Doomed 1/); assert.match(c.blocks.criticalFailure, /Doomed 2/);
  const d = proseBlocks(`<p>If it fails, it's ${link("SICK", "Sickened 1")} and if it critically fails, it's blinded permanently.</p>`, slugOf);
  assert.doesNotMatch(d.blocks.criticalFailure, /^As failure/);   // «навсегда» — не срок провала
});

test("proseBlocks: сомнительная форма и чужой бросок не разбираются", () => {
  assert.deepEqual(proseBlocks(`<p>The creature is ${SICK} on a critical failure.</p>`, slugOf).blocks, {});
  assert.deepEqual(proseBlocks(`<p>On a failed Athletics check, the creature is ${SICK}.</p>`, slugOf).blocks, {});
});

const markupRule = (imm) => ({ v: 1, label: "Stench", onUse: { targets: "selected", apply: [], challenge: { statistic: "fortitude", dc: { expr: "markup" }, basic: false, byDegree: {}, ...(imm && { immunity: imm }) } } });
const item = (slug, html) => ({ type: "action", name: slug, slug, _stats: {}, system: { description: { value: html }, traits: { value: [] } } });
const run = (rule, it) => {
  initCatalog([{ bySlug: { stench: rule } }], labels);
  globalThis.game = { pf2e: { ConditionManager: { conditions: new Map(Object.keys(CONDS).map((id) => [`Compendium.pf2e.conditionitems.Item.${id}`, { slug: CONDS[id] }])) } } };
  try { return resolveRule({ item: it }); } finally { delete globalThis.game; }
};

test("resolveRule: dc markup — степени и иммунитет (степени, охват, срок) берутся из текста каждой копии", () => {
  const imm = { slug: "stench", duration: { value: 1, unit: "minutes" }, degrees: ["success", "criticalSuccess"] };
  const a = run(markupRule(imm), item("stench", `<p>Creatures must succeed at a @Check[fortitude|dc:22|options:area-effect] save or become ${SICK}. A creature that succeeds is temporarily immune to all stench auras for 1 hour.</p>`)).rule.onUse.challenge;
  assert.deepEqual([a.dc, a.byDegree.failure.map((x) => x.condition.slug), a.immunity.scope, a.immunity.duration], [{ value: 22 }, ["sickened"], "slug", { value: 1, unit: "hours" }]);
  const b = run(markupRule(imm), item("stench", `<p>Creatures must succeed at a @Check[fortitude|dc:30] save or become ${link("SICK", "Sickened 2")}. A creature that succeeds is temporarily immune for 1 minute.</p>`)).rule.onUse.challenge;
  assert.deepEqual([b.dc, b.byDegree.failure[0].condition.value, b.immunity.scope, b.immunity.duration], [{ value: 30 }, 2, undefined, { value: 1, unit: "minutes" }]);
  // английский текст об иммунитете молчит — иммунитета в правиле нет; русский текст разбирать нечем — иммунитет каталога
  const c = run(markupRule(imm), item("stench", `<p>Creatures must succeed at a @Check[fortitude|dc:30] save or become ${SICK}.</p>`)).rule.onUse.challenge;
  assert.equal(c.immunity, undefined);
  assert.deepEqual(run(markupRule(imm), item("stench", `<p>Существо совершает @Check[fortitude|dc:30]. Иммунно на 1 минуту.</p>`)).rule.onUse.challenge.immunity.slug, "stench");
  assert.deepEqual(run(markupRule(imm), item("stench", `<p>@Check[fortitude|dc:30] Существо избегает.</p>`)).rule.onUse.challenge.immunity, imm);
  // степени, заданные в каталоге, текстом не подменяются
  const fixed = markupRule(); fixed.onUse.challenge.byDegree = { failure: [{ to: "target", condition: { slug: "clumsy", value: 1 } }] };
  assert.equal(run(fixed, item("stench", `<p>save or become ${SICK} @Check[fortitude|dc:30]</p>`)).rule.onUse.challenge.byDegree.failure[0].condition.slug, "clumsy");
});

test("resolveRule: тёзка без спасброска в описании правила «СЛ из текста» по slug не получает", () => {
  assert.equal(run(markupRule(), item("stench", "<p>It is also clumsy.</p>")), null);
});

test("immunityFromText / immunityDuration: «isn't affected by any … for 1 minute» — иммунитет; срок из предложения", () => {
  const t = immunityFromText("<p>A creature that succeeds at its save isn't affected by any ghoul's stench for 1 minute.</p>");
  assert.deepEqual([t.has, t.degrees, t.anySource], [true, ["success", "criticalSuccess"], true]);
  assert.deepEqual(immunityDuration("<p>It is immune for 24 hours.</p>"), { value: 24, unit: "hours" });
  assert.equal(immunityDuration("<p>No such thing for 3 days.</p>"), null);
});

test("saveBeyondSelf: состояние после спасброска или шаблон области при правиле «на себя»", () => {
  assert.equal(saveBeyondSelf(`<p>Drink. @Check[fortitude|dc:20] to avoid becoming ${SICK}.</p>`), true);
  assert.equal(saveBeyondSelf("<p>@Template[emanation|distance:10] creatures in the area gain resistance.</p>"), true);   // Thawing Candle: область без спасброска
  assert.equal(saveBeyondSelf("<p>@Template[cone|distance:15] @Check[reflex|dc:20|basic] save</p>"), false);              // дыхание: спасбросок «только урон»
  assert.equal(saveBeyondSelf("<p>Fortitude @Check[fortitude|dc:20|basic] damage only.</p>"), false);
  assert.equal(saveBeyondSelf(`<p>You are ${SICK}. @Check[fortitude|dc:20] damage.</p>`), false);   // состояние до спасброска — не его результат
});

import { resolveAccepted } from "../tools/pa-port.mjs";

test("resolveAccepted: вердикт по slug раскрывается в документы без своей записи; accept берёт правило черновика; последняя запись по uuid побеждает", () => {
  const rule = { v: 1, onUse: { targets: "self", apply: [] } };
  const d = (uuid, slug, extra = {}) => ({ uuid, slug, type: "action", name: slug, paStatus: "port", rule, confidence: "low", ...extra });
  const drafts = [d("A.Actor.1", "x"), d("B.Actor.2", "x"), d("C.Item.3", "x"), d("D.Actor.4", "x", { paStatus: "covered" }), d("E.Actor.5", "y")];
  const out = resolveAccepted([
    { slug: "x", scope: "npc", accept: true, reason: "r" },
    { uuid: "B.Actor.2", debt: { subpack: "0.5g", reasons: ["z"] }, reason: "r2" },
    { uuid: "B.Actor.2", paStatus: "false-coverage", reason: "r3" },
  ], drafts, () => null);
  assert.deepEqual(out.map((a) => [a.uuid, a.paStatus ?? null, !!a.rule, a.confidence]), [["A.Actor.1", null, true, "manual"], ["B.Actor.2", "false-coverage", false, null]]);   // C — компендий, D — covered, E — другой slug
  assert.throws(() => resolveAccepted([{ slug: "y", accept: true, reason: "r" }], [d("E.Actor.5", "y", { rule: null })], () => null), /без правила/);
});

const L2 = (id, label) => `@UUID[Compendium.pf2e.conditionitems.Item.${id}]{${label}}`;
const FRI = (n) => L2("FRIG", `Frightened ${n}`);
const slug2 = (u) => ({ FRIG: "frightened", SICK: "sickened", OFFG: "off-guard", FATI: "fatigued", STUN: "stunned" })[/Item\.(\w+)$/.exec(u)?.[1]] ?? null;
const links = (t) => [...(t ?? "").matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);

test("proseBlocks: скобка крит. провала где угодно — «(Y on a critical failure) for 1 round», «(plus Y on a critical failure for as long as…)», «, or Y on a critical failure, as …»", () => {
  const a = proseBlocks(`<p>On a failure, it becomes ${L2("SICK", "Sickened 1")} (or ${L2("SICK", "Sickened 2")} on a critical failure) for 1 round.</p>`, slug2);
  assert.deepEqual([links(a.blocks.failure), links(a.blocks.criticalFailure), /for 1 round/.test(a.blocks.failure), /for 1 round/.test(a.blocks.criticalFailure)], [["Sickened 1"], ["Sickened 2"], true, true]);
  const b = proseBlocks(`<p>must succeed at a save or become ${L2("SICK", "Sickened 1")} (plus ${L2("STUN", "Stunned 1")} on a critical failure for as long as it's sickened).</p>`, slug2);
  assert.deepEqual([links(b.blocks.failure), b.possible], [["Sickened 1"], ["criticalFailure:stunned"]]);
  const c = proseBlocks(`<p>On a failure, it is ${L2("SICK", "Sickened 1")}, or ${L2("SICK", "Sickened 2")} on a critical failure, as the spores take root.</p>`, slug2);
  assert.deepEqual(links(c.blocks.criticalFailure), ["Sickened 2"]);
  const d = proseBlocks(`<p>must succeed at a save or be ${L2("OFFG", "Off-Guard")} for 1 round (on a critical failure, they are also ${FRI(1)}).</p>`, slug2);
  assert.deepEqual([links(d.blocks.failure), links(d.blocks.criticalFailure)], [["Off-Guard"], ["Frightened 1"]]);
});

test("proseBlocks: нет крит. провала — он равен провалу («As failure»)", () => {
  assert.equal(proseBlocks(`<p>On a failure, the creature is ${FRI(1)}.</p>`, slug2).blocks.criticalFailure, "As failure");
  assert.deepEqual(proseBlocks("<p>No save here.</p>", slug2).blocks, {});
});

test("proseBlocks: «attempt a save or be X», «succeed … or …, and become X», «takes … (… on a critical failure) and becomes X»", () => {
  assert.deepEqual(links(proseBlocks(`<p>All creatures must attempt a @Check[will|dc:41] save or be ${L2("OFFG", "Off-Guard")} for 1 round.</p>`, slug2).blocks.failure), ["Off-Guard"]);
  assert.deepEqual(links(proseBlocks(`<p>The creature must succeed at a @Check[reflex|dc:21] save or inhale spores for 1 minute, take damage, and become ${L2("SICK", "Sickened 1")} (on a critical failure, double damage and ${L2("SICK", "Sickened 2")}).</p>`, slug2).blocks.criticalFailure), ["Sickened 2"]);
  const t = proseBlocks(`<p>On a failure, the creature takes @Damage[1d6[void]] damage (@Damage[2d6[void]] damage on a critical failure) and becomes ${L2("FATI", "Fatigued")}.</p>`, slug2);
  assert.deepEqual([links(t.blocks.failure), links(t.blocks.criticalFailure), t.blocks.criticalFailure.startsWith("As failure,")], [["Fatigued"], [], true]);
  assert.deepEqual(links(proseBlocks(`<p>The target becomes ${FRI(1)} if it fails a Will save (or ${FRI(2)} on a critical failure).</p>`, slug2).blocks.failure), ["Frightened 1"]);
});

test("proseBlocks: «creatures who critically fail are X» — крит. провал; «on a critical hit» в провал не попадает", () => {
  const s = proseBlocks(`<p>Creatures who fail this save are also ${FRI(1)}, and creatures who critically fail are ${FRI(3)} and ${L2("STUN", "Stunned")} for 1 round.</p>`, slug2);
  assert.deepEqual([links(s.blocks.failure), links(s.blocks.criticalFailure)], [["Frightened 1"], ["Frightened 3", "Stunned"]]);
  const h = proseBlocks(`<p>must succeed at a @Check[fortitude|dc:39] save or be ${L2("STUN", "Stunned 1")} (${L2("STUN", "Stunned 3")} on a critical hit).</p>`, slug2);
  assert.deepEqual(links(h.blocks.failure), ["Stunned 1"]);
  assert.equal(links(h.blocks.criticalFailure).length, 0);
});

test("deriveFromMarkup: из нескольких спасбросков берётся тот, что накладывает состояние; проза читается в пределах своего спасброска", async () => {
  const { deriveFromMarkup } = await import("../scripts/rules.mjs");
  const html = `<p>attempt a @Check[fortitude|against:commander|traits:death] save or die.</p><p>must succeed at a @Check[will|against:commander|options:inflicts:sickened] save or become ${L2("SICK", "Sickened 1")} for 1 round (${L2("SICK", "Sickened 2")} for 1 round on a critical failure).</p>`;
  const d = deriveFromMarkup({ type: "action", slug: "x", system: { description: { value: html }, traits: { value: [] } } }, labels, slug2, null);
  const ch = d.rule.onUse.challenge;
  assert.deepEqual([ch.statistic, ch.byDegree.failure[0].condition.slug, ch.byDegree.criticalFailure[0].condition.value], ["will", "sickened", 2]);
});

test("lacksOwnRoll: правило-проверка и правило-макрос по slug не годятся тёзке без своего броска (Intimidating Strike у Zashathal, Disarm у Werendegar)", async () => {
  const { lacksOwnRoll } = await import("../scripts/rules.mjs");
  const chk = { onUse: { check: { statistic: "athletics" } } }, mac = { macros: [{ builtin: "x" }], onUse: {} };
  assert.equal(lacksOwnRoll(chk, "disarm", "<p>Werendegar knocks a weapon to the ground.</p>"), true);
  assert.equal(lacksOwnRoll(chk, "disarm", "<p>Attempt an @Check[athletics|dc:20] check.</p>"), false);
  assert.equal(lacksOwnRoll(chk, "disarm", "<p>@Check[acrobatics|dc:20]</p>"), true);               // не та статистика
  assert.equal(lacksOwnRoll(mac, "intimidating-strike", "<p>makes an Intimidate check to [[/act demoralize]] the target.</p>"), true);
  assert.equal(lacksOwnRoll(mac, "intimidating-strike", "<p>[[/act intimidating-strike]]</p>"), false);
  assert.equal(lacksOwnRoll(mac, "intimidating-strike", "<p>Trigger Alak hits a creature with a melee Strike Effect Alak makes the target Frightened 1 on a hit.</p>"), false);   // Alak: копия без делегирования — не отсекается
  assert.equal(lacksOwnRoll(chk, "trip", "<p>The ooze makes an Athletics check against the target's Fortitude DC.</p>"), false);   // Injured Weak Otyugh: Атлетика словом
  assert.equal(lacksOwnRoll({ onUse: { apply: [] } }, "x", ""), false);                              // не проверка и не макрос
});

test("immunityFromText: «on a success» при успехе; «and is then immune» при любом исходе; срок — тот «for N», что после «immune»", () => {
  const t = (s) => immunityFromText(`<p>${s}</p>`);
  assert.deepEqual(t("A creature must succeed at a save or become Confused for 1 round; on a success, that creature is temporarily immune for 1 minute.").degrees, ["success", "criticalSuccess"]);
  assert.equal(t("A creature must succeed at a save or be Frightened 1 (Frightened 2 on a critical failure) and is then temporarily immune for 1 minute.").degrees, null);
  assert.deepEqual(immunityDuration("<p>must attempt a save or be Blinded for 1 minute and become temporarily immune for 1 day.</p>"), { value: 1, unit: "days" });
});

test("proseBlocks: «(or Stunned 1 on a critical failure)» — замена; «(or Slowed 2 …)» — остальное от провала сохраняется; «(or for 1 minute …)» — срок; приказ на потом не состояние", () => {
  const rep = proseBlocks(`<p>On a failure, the creature is ${L2("SLOW", "Slowed 1")} for 1 round (or ${L2("STUN", "Stunned 1")} on a critical failure).</p>`, (u) => ({ SLOW: "slowed", STUN: "stunned" })[/Item\.(\w+)$/.exec(u)?.[1]] ?? null);
  assert.doesNotMatch(rep.blocks.criticalFailure, /^As failure/);
  const keep = proseBlocks(`<p>must succeed at a save or be ${L2("OFFG", "Dazzled")} and ${L2("SLOW", "Slowed 1")} (or ${L2("SLOW", "Slowed 2")} on a critical failure) for 1 round.</p>`, (u) => ({ OFFG: "dazzled", SLOW: "slowed" })[/Item\.(\w+)$/.exec(u)?.[1]] ?? null);
  assert.match(keep.blocks.criticalFailure, /^As failure,/);
  const dur = proseBlocks(`<p>A creature that fails its save is ${L2("BLIN", "Blinded")} until the end of its next turn (or for 1 minute on a critical failure).</p>`, () => "blinded");
  assert.match(dur.blocks.criticalFailure, /for 1 minute/);
  assert.deepEqual(proseBlocks(`<p>must make a save to resist being compelled to drop ${L2("PRON", "Prone")} as its first action (on a critical failure, remaining prone).</p>`, () => "prone").blocks, {});
});

test("срок броском: «for [[/gmr 1d4 #rounds]]» — кубик в duration.value; не дотянулся до состояния — подсказка, не бессрочно", async () => {
  const { deriveFromMarkup } = await import("../scripts/rules.mjs");
  const d = (html) => deriveFromMarkup({ type: "action", slug: "x", system: { description: { value: html }, traits: { value: [] } } }, labels, slug2, null);
  const near = d(`<p>@Check[will|dc:20] save. On a failure, the creature is ${L2("STUN", "Stunned 1")} for [[/gmr 1d4 #rounds]]{1d4 rounds}.</p>`);
  assert.deepEqual(near.rule.onUse.challenge.byDegree.failure[0].duration, { value: "1d4", unit: "rounds", expiry: null, of: "origin" });
  const far = d(`<p>@Check[will|dc:20] save. On a failure, the creature is ${L2("STUN", "Stunned 1")}, which lingers while it reels for [[/gmr 1d4 #rounds]]{1d4 rounds}.</p>`);
  assert.equal(far.rule.onUse.challenge.byDegree.failure, undefined);
  assert.ok(far.hints.possible.includes("failure:stunned"));
});

test("срок броском не вытесняет остальные состояния своей степени: Arrogant Taunts (Frightened 4 + Paralyzed на 1d4)", async () => {
  const { deriveFromMarkup } = await import("../scripts/rules.mjs");
  const C = { FRIG: "frightened", PARA: "paralyzed", FASC: "fascinated", OFFG: "off-guard" }, id = (u) => C[/Item\.(\w+)$/.exec(u)?.[1]] ?? null;
  const l = (k, t) => `@UUID[Compendium.pf2e.conditionitems.Item.${k}]{${t}}`;
  const html = `<p>Each creature must attempt a @Check[will|dc:27] save.</p><hr /><p><strong>Success</strong> The creature is ${l("FRIG", "Frightened 1")}.</p><p><strong>Failure</strong> The creature is ${l("FRIG", "Frightened 2")} and ${l("PARA", "Paralyzed")} for 1 round.</p><p><strong>Critical Failure</strong> The creature is ${l("FRIG", "Frightened 4")} and paralyzed for [[/gmr 1d4 #rounds]]{1d4 rounds}.</p>`;
  const by = deriveFromMarkup({ type: "action", slug: "a", system: { description: { value: html }, traits: { value: [] } } }, labels, id, [["paralyzed", "paralyzed"], ["frightened", "frightened"]]).rule.onUse.challenge.byDegree;
  assert.deepEqual(by.criticalFailure.map((a) => [a.condition.slug, a.condition.value ?? null, a.duration?.value ?? null]), [["frightened", 4, null], ["paralyzed", null, "1d4"]]);
  assert.deepEqual(by.failure.map((a) => a.condition.slug), ["frightened", "paralyzed"]);
});

test("прозой: Luring Laugh («Fascinated, Off-Guard, and compelled to move toward…») не теряет состояния; Throw Shadow Blade «(or [[/gmr 1d4 #rounds]] on a critical failure)» — срок броском на крит. провале; Agonizing Cries — зависимость и у крит. провала", async () => {
  const C = { FASC: "fascinated", SLOW: "slowed", FRIG: "frightened" }, id = (u) => C[/Item\.(\w+)$/.exec(u)?.[1]] ?? null;
  const l = (k, t) => `@UUID[Compendium.pf2e.conditionitems.Item.${k}]{${t}}`;
  assert.deepEqual(links(proseBlocks(`<p>must succeed at a @Check[will|dc:19] save or become ${l("FASC", "Fascinated")}, and compelled to move toward the ghul on the creature's turn.</p>`, id).blocks.failure), ["Fascinated"]);
  const t = proseBlocks(`<p>must succeed at a @Check[fortitude|dc:32] save or be ${l("SLOW", "Slowed 1")} until the end of its next turn (or [[/gmr 1d4 #rounds]]{1d4 rounds} on a critical failure).</p>`, id);
  assert.match(t.blocks.criticalFailure, /for \[\[\/gmr 1d4 #rounds\]\]/);
  const a = proseBlocks(`<p>must succeed at a save or become ${l("FRIG", "Frightened 1")} as long as it remains in the aura (${l("FRIG", "Frightened 2")} on a critical failure).</p>`, id);
  assert.deepEqual([links(a.blocks.failure), links(a.blocks.criticalFailure), a.possible], [[], [], ["failure:frightened", "criticalFailure:frightened"]]);
});
