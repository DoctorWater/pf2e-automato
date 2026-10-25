// Детекторы «только враги» и «испытание после Удара» (rules.mjs), derive и нормализация ответов моделей (tools/validate.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enemiesOnly, strikeGate, deriveFromMarkup, setWho } from "../scripts/rules.mjs";
import { checkAnswer, normalizeRule, processAnswers, emptyState } from "../tools/validate.mjs";
import { withAccepted } from "../tools/coverage.mjs";
import { modelCatalog } from "../tools/drafts.mjs";
import { triageItem, makeContext } from "../tools/triage.mjs";

const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));
const p = (t) => `<p>${t}</p>`;

test("enemiesOnly: враги в области", () => {
  for (const t of [
    "Each enemy in a @Template[type:burst|distance:20] takes damage with a save.",
    "All enemies within 30 feet must attempt a @Check[will|dc:20] save.",
    "Enemies in the area are Dazzled.",
    "You deal 4d10 damage to enemies in the area with a basic Reflex save.",
    "Each living enemy within the aura must succeed at a save."
  ]) assert.equal(enemiesOnly(p(t)), true, t);
});

test("enemiesOnly: ложные срабатывания отсеяны", () => {
  for (const t of [
    "Your enemies in the aura take a -1 status penalty to attacks.",                      // бонус/штраф, «your enemies»
    "You are flanking against all enemies within your reach.",                            // «against all enemies»
    "She must end her movement in a space that isn't adjacent to any enemies.",           // «adjacent to any enemies»
    "Use this to send false signals to any enemy forces observing the signaler.",         // «enemy forces»
    "When an enemy's attack misses you, make a Strike.",                                  // «an enemy's»
    "You and all allies within the area gain resistance 15. All enemies take a penalty.", // союзники тоже затронуты
    "Each creature in the area must attempt a save. Enemies in the area are also Off-Guard.", // «each creature» раньше врагов
    "The target must attempt a save. Heightened (7th) the spell affects all enemies within 30 feet.", // только в heightened
    "Choose another enemy adjacent to the Grabbed enemy."                                 // единственная цель, не область
  ]) assert.equal(enemiesOnly(p(t)), false, t);
});

test("strikeGate: Удар, затем испытание", () => {
  for (const t of [
    "Make a Strike. If it hits, the target must attempt a @Check[fortitude|dc:25] save.",
    "Make a Strike against a creature. If the Strike hits and deals damage, the creature must attempt a Fortitude save.",
    "Make a melee Strike. On a hit, you deal extra damage. On a critical hit, the target must succeed at a Will save.",
    "Make a Strike. If you hit, the target takes 4d6 extra precision damage with a Fortitude save.",
    "Make a Strike. On a successful Strike, the target must succeed at a Fortitude save or be knocked Prone.",
    "You make a crossbow Strike. If you get a critical success on your attack roll, the target must succeed at a Fortitude save or die."
  ]) assert.equal(strikeGate(p(t)), true, t);
});

test("strikeGate: ложные срабатывания отсеяны", () => {
  for (const t of [
    "Make a Strike. If the Strike was a critical hit, the target takes a -2 circumstance penalty to its saving throw.",   // штраф к спасброску
    "Make a Strike. If the Strike hits, allies within the aura gain a +2 status bonus to attack rolls and saving throws.", // бонус
    "Make a Strike. If it hits, the creature uses the outcome one degree worse than the result of its save.",             // степень чужого спасброска
    "Trigger An enemy attacks. If the triggering Strike was a hit, the target must succeed at a Fortitude save.",         // Удар чужой
    "The ghost has a spirit touch. All enemies take damage whenever they're critically hit by an attack or critically fail a saving throw.", // «hit by»
    "The target must attempt a @Check[will|dc:20] save. Your Strikes deal 1d6 extra damage on a hit.",                    // испытание не после Удара
    "Cast the spell. A creature that fails the saving throw is slowed. You can Strike afterwards.",                       // порядок наоборот
    "Make a spell attack roll. On a hit, the target must attempt a Reflex save."                                          // заклинание-атака, не Удар
  ]) assert.equal(strikeGate(p(t)), false, t);
});

const H = (t) => ({ type: "action", slug: "x", name: "X", system: { description: { value: p(t) }, actionType: { value: "action" }, traits: { value: [] } } });
const derive = (t) => deriveFromMarkup(H(t), labels, (u) => (u.endsWith("TBSHQspnbcqxsmjL") ? "frightened" : null), null);

test("deriveFromMarkup: враги в области -> who:enemy на шагах к цели", () => {
  const d = derive("Each enemy in a @Template[type:burst|distance:20] must attempt a @Check[will|dc:20] save. @Damage[2d6[fire]] On a failure, the creature is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}.");
  const steps = Object.values(d.rule.onUse.challenge.byDegree).flat();
  assert.ok(steps.length);
  assert.ok(steps.every((s) => s.who === "enemy"), JSON.stringify(steps));
  assert.equal(d.strikeGate, undefined);
});

test("deriveFromMarkup: без «врагов» who не ставится", () => {
  const d = derive("Each creature in a @Template[type:burst|distance:20] must attempt a @Check[will|dc:20] save. On a failure, the creature is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}.");
  const st = Object.values(d.rule.onUse.challenge.byDegree).flat();
  assert.ok(st.length && st.every((s) => s.who === undefined));
});

test("deriveFromMarkup: strike-gate — голова правила остаётся (ограждения тёзок), но помечено strikeGate", () => {
  const d = derive("Make a Strike. If it hits, the target must attempt a @Check[fortitude|dc:25] save. On a failure, the target is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}.");
  assert.equal(d.strikeGate, true);
  assert.equal(d.rule.onUse.challenge.statistic, "fortitude");
  assert.equal(derive("The target must attempt a @Check[fortitude|dc:25] save.").strikeGate, undefined);
});

test("setWho не перетирает who и не трогает self", () => {
  const u = { apply: [{ to: "target", who: "ally", note: "a" }, { to: "target", note: "b" }, { to: "self", note: "c" }] };
  setWho(u, "enemy");
  assert.deepEqual(u.apply.map((a) => a.who), ["ally", "enemy", undefined]);
});

test("triage: strike-gate показывается причиной, а не «готово»", () => {
  const it = { uuid: "u", slug: "x", name: "X", type: "action", actionType: "action", traits: [], level: 1, descEn: "", ruleKeys: [], dupTop: null };
  const html = p("Make a Strike. If it hits, the target must attempt a @Check[fortitude|dc:25] save. On a failure, the target is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}.");
  const ctx = makeContext({ refs: { conditions: { TBSHQspnbcqxsmjL: "frightened" }, effects: {} }, catalogJsons: [], automationsRules: null, labels, items: [it] });
  const t = triageItem(it, html, ctx);
  assert.equal(t.status, "manual");
  assert.match(t.reason, /needs-primitive: strike-gate/);
  assert.equal(t.rule, null);
});

const challengeRule = { v: 1, onUse: { targets: "area", challenge: { statistic: "will", dc: { source: "spell" }, rollerRole: "target", byDegree: { failure: [{ to: "target", condition: { slug: "frightened", value: 1 } }] } } } };
const refs = { conditions: { frightened: true }, effects: {} };

test("normalizeRule: только враги -> who:enemy; вход не мутируется", () => {
  const html = p("Each enemy in a @Template[type:burst|distance:20] must attempt a Will save.");
  const { rule, gate } = normalizeRule(challengeRule, html);
  assert.equal(rule.onUse.challenge.byDegree.failure[0].who, "enemy");
  assert.equal(challengeRule.onUse.challenge.byDegree.failure[0].who, undefined);
  assert.equal(gate, false);
  assert.equal(checkAnswer({ uuid: "u", rule: challengeRule }, refs, html).rule.onUse.challenge.byDegree.failure[0].who, "enemy");
});

test("normalizeRule: без текста правило как есть", () => {
  assert.equal(normalizeRule(challengeRule, "").rule, challengeRule);
});

test("checkAnswer/processAnswers: strike-gate -> unsure (ключ strike-gate), на последней ступени needs-primitive, правило сохранено, в каталог и «готово» не идёт", () => {
  const html = p("Make a Strike. If it hits, the target must attempt a Will save or become Frightened 1.");
  const c = checkAnswer({ uuid: "u", rule: challengeRule }, refs, html);
  assert.deepEqual([c.kind, c.key], ["unsure", "strike-gate"]);
  assert.ok(c.guess);
  assert.equal(processAnswers([{ uuid: "u", rule: challengeRule, unsure: false }], [{ uuid: "u", slug: "x", name: "X", status: "manual" }], refs, emptyState(), { htmlOf: () => html }).sonnet.length, 1);
  const d = { uuid: "u", slug: "x", name: "X", status: "manual" };
  const res = processAnswers([{ uuid: "u", rule: challengeRule, unsure: false, note: "хит" }], [d], refs, emptyState(), { htmlOf: () => html, final: true });
  const [a] = res.accepted;
  assert.equal(a.confidence, "needs-primitive");
  assert.equal(a.status, "manual");
  assert.match(a.reason, /^needs-primitive: strike-gate; /);
  assert.ok(a.rule);
  assert.equal(modelCatalog([a]).includes('"u"'), false);
  assert.equal(withAccepted([{ uuid: "u", status: "manual" }], [a])[0].status, "manual");
});

test("checkAnswer: обычный ответ при том же правиле без Удара принимается", () => {
  assert.equal(checkAnswer({ uuid: "u", rule: challengeRule }, refs, p("The target must attempt a Will save.")).kind, "accepted");
});

test("strikeGate: формулировки NPC (Spectral Corruption, Stunning Strike, Haymaker, Tickle Bite…)", () => {
  for (const t of [
    "The specter makes a vile touch Strike. If it damages a living creature, the target creature must attempt a @Check[fortitude|dc:20] save.",
    "She makes a weapon Strike against the foe. On a success, the foe must succeed at a @Check[fortitude|dc:20] save or become Stunned 1.",
    "She makes a fist Strike. If she hits, the creature must attempt a @Check[fortitude|dc:20] save.",
    "It makes a jaws Strike. If successful, the target must succeed at a @Check[fortitude|dc:20] save.",
    "Make a melee Strike. If the Strike damages the target, the target must also attempt a @Check[will|dc:20] save.",
    "Make a melee Strike. On a successful hit, the target must succeed at a @Check[fortitude|dc:20] save.",
    "The thrall makes two melee unarmed Strikes. A creature hit by one of these Strikes must attempt a @Check[fortitude|dc:20] save.",
    "Each of these Strikes that are successful forces the target to attempt a @Check[will|dc:20] save.",
    "Make a Strike against a creature. If your attack hits, the target must attempt a new saving throw against the disease."
  ]) assert.equal(strikeGate(p(t)), true, t);
});

test("strikeGate: Удар в предусловии и «succeeds at a save» — не ворота", () => {
  for (const t of [
    "<b>Requirements</b> Your last action was a Strike that critically hit a creature <b>Effect</b> The creature you critically hit must attempt a @Check[will|dc:20] save.",
    "<b>Trigger</b> You critically hit with a Strike <b>Effect</b> All enemies within 30 feet must attempt a @Check[will|dc:20] save.",
    "Make a Strike. An unwilling target can resist if it succeeds at a @Check[will|dc:20] save."
  ]) assert.equal(strikeGate(p(t)), false, t);
});

test("enemiesOnly: союзник в единственном числе и «willing» — смешанный текст", () => {
  for (const t of [
    "Each enemy in the area must attempt a save. An ally in the area gains a +1 bonus.",
    "Each enemy in the area must attempt a save. One willing creature is protected.",
    "Enemies within 30 feet must attempt a save, and each ally within 30 feet is bolstered."
  ]) assert.equal(enemiesOnly(p(t)), false, t);
});

test("processAnswers --final: unsure -> needs-primitive с догадкой; без флага — в очередь Sonnet; без догадки — в очередь", () => {
  const d = { uuid: "u", slug: "x", name: "X", status: "manual" };
  const ans = [{ uuid: "u", rule: challengeRule, unsure: true, note: "нужен примитив X" }];
  const fin = processAnswers(ans, [d], refs, emptyState(), { final: true });
  assert.equal(fin.sonnet.length, 0);
  assert.deepEqual([fin.accepted[0].status, fin.accepted[0].confidence, fin.accepted[0].reason], ["manual", "needs-primitive", "needs-primitive: нужен примитив X"]);
  assert.ok(fin.accepted[0].rule);
  const st = emptyState();
  const std = processAnswers(ans, [d], refs, st, {});
  assert.equal(std.accepted.length, 0);
  assert.deepEqual(std.sonnet, ["u"]);
  const none = processAnswers([{ uuid: "u", rule: null, unsure: true, note: "?" }], [d], refs, emptyState(), { final: true });
  assert.deepEqual([none.sonnet.length, none.accepted[0].confidence, none.accepted[0].rule], [0, "needs-primitive", null]);
  const bad = processAnswers([{ uuid: "u", rule: { v: 1, onUse: { challenge: { statistic: "bogus" } } }, unsure: true, note: "?" }], [d], refs, emptyState(), { final: true });
  assert.deepEqual([bad.sonnet.length, bad.accepted[0].status, bad.accepted[0].reason, bad.accepted[0].rule], [0, "manual", "needs-primitive: ?", null]);
  const sem = processAnswers([{ uuid: "u", rule: { v: 1, onUse: { apply: [{ to: "self", condition: { slug: "nonexistent" } }] } }, unsure: true, note: "?" }], [d], refs, emptyState(), { final: true });
  assert.equal(sem.accepted[0].rule, null);   // семантика (условие не в pf2e) — как у обычного ответа
});

test("challengeWho: общее who шагов к цели", async () => {
  const { challengeWho } = await import("../scripts/rules.mjs");
  const s = (who, to = "target") => ({ to, ...(who && { who }), note: "n" });
  assert.equal(challengeWho({ byDegree: { failure: [s("enemy")], criticalFailure: [s("enemy"), s(null, "self")] } }), "enemy");
  assert.equal(challengeWho({ byDegree: { failure: [s("enemy")], criticalFailure: [s(null)] } }), null);
  assert.equal(challengeWho({ byDegree: { failure: [s("enemy"), s("ally")] } }), null);
  assert.equal(challengeWho({ byDegree: {} }), null);
});

test("strikeGate: предусловие кончается чертой <hr> (Fearful Symmetry)", () => {
  assert.equal(strikeGate("<p><strong>Requirements</strong> Your last action was a critically successful Strike.</p><hr /><p>All enemies within 30 feet of the creature you critically hit must attempt a @Check[will|against:class] save.</p>"), false);
});
