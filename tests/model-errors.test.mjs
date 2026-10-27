// Ошибки ответов модели, найденные Критиком (пачки долга 1-3): strike-gate, area без области, СЛ class-spell.
import test from "node:test";
import assert from "node:assert/strict";
import { strikeGate } from "../scripts/rules.mjs";
import { checkAnswer } from "../tools/validate.mjs";

const any = new Proxy({}, { get: () => true });
const refs = { conditions: any, effects: any };
const chk = (rule, html, kind) => checkAnswer({ uuid: "u", rule }, refs, `<p>${html}</p>`, kind);
const save = (against, to = { to: "target", condition: { slug: "prone" } }) => ({ statistic: "reflex", dc: { against }, basic: false, byDegree: { failure: [to] } });

test("strikeGate: формулировки из ответов Критика", () => {
  for (const t of [
    "You Stride and then make a tusk Strike. The creature you hit must succeed at a @Check[reflex|dc:35] save or fall prone.",
    "Make a ranged Strike. On a hit, the target additionally takes 2d8 persistent bleed damage. The target must also attempt a @Check[fortitude|against:class] save.",
    "Make a melee Strike. The target dealt damage by your Strike must succeed at a @Check[fortitude|against:class] saving throw or become stunned.",
    "Make two frenzied claw attacks against the same target. If both attacks hit, the target must succeed at a @Check[fortitude|against:class] save or be enfeebled."
  ]) assert.equal(strikeGate(`<p>${t}</p>`), true, t);
  for (const t of [
    "Make a Strike. On a hit, the target takes 2d8 bleed damage. The weapon gleams. The target must also attempt a save.",   // абзац между
    "The mantis makes two leg attacks. The target must attempt a @Check[fortitude|dc:20] save.",                             // без исхода ударов
    "A creature you hit takes 1d6 extra damage. You can Strike. The target attempts a Will save."                              // Удар после
  ]) assert.equal(strikeGate(`<p>${t}</p>`), false, t);
});

test("check-answer: strike-gate, который инструмент не перенёс, и многоударный — unsure с ключом", () => {
  const one = "Make a melee Strike. On a successful hit, the target must succeed at a @Check[fortitude|dc:20] save or become prone.";
  const rule = { v: 1, onUse: { targets: "selected", apply: [], challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, byDegree: { failure: [{ to: "target", condition: { slug: "prone" } }] } } } };
  assert.equal(chk(rule, one, { type: "feat", actionType: "action" }).kind, "accepted");                       // карточка есть: перенос сработал
  const passive = chk(rule, one, { type: "feat", actionType: "passive" });
  assert.deepEqual([passive.kind, passive.key], ["unsure", "strike-gate"]);                                     // Sword of Sealing
  const multi = chk(rule, "Make two claw attacks. If both attacks hit, the target must succeed at a @Check[fortitude|dc:20] save or become prone.", { type: "feat", actionType: "action" });
  assert.deepEqual([multi.kind, multi.key], ["unsure", "multi-strike"]);                                        // Tear Tendons
});

test("check-answer: targets area только при area в шапке или @Template", () => {
  const rule = (targets, move) => ({ v: 1, onUse: { targets, challenge: { statistic: "reflex", dc: { against: "class" }, basic: true, byDegree: { failure: [{ to: "target", move }] } }, apply: [] } });
  const txt = "All creatures adjacent to you must attempt a @Check[reflex|against:class] save.";
  const bad = chk(rule("area", { mode: "push", distance: 10, from: "point" }), txt, { type: "action", area: null });
  assert.equal(bad.kind, "error");
  assert.match(bad.errors[0], /targets "area" needs an area/);
  assert.equal(chk(rule("selected", { mode: "push", distance: 10 }), txt, { type: "action", area: null }).kind, "accepted");
  assert.equal(chk(rule("area", { mode: "push", distance: 10, from: "point" }), txt, { type: "action", area: "emanation 30ft" }).kind, "accepted");
  assert.equal(chk(rule("area", { mode: "push", distance: 10, from: "point" }), txt + " @Template[type:burst|distance:10]", { type: "action", area: null }).kind, "accepted");
});

test("check-answer: dc.against сверяется с @Check текста", () => {
  const txt = "Make a Fortitude save: @Check[fortitude|against:class-spell] against the higher of your class DC or spell DC.";
  const rule = (a) => ({ v: 1, onUse: { targets: "selected", challenge: save(a), apply: [] } });
  const bad = chk(rule("class"), txt, { type: "feat", actionType: "action", area: null });
  assert.equal(bad.kind, "error");
  assert.match(bad.errors[0], /against:class-spell/);
  assert.equal(chk(rule("class-spell"), txt, { type: "feat", actionType: "action", area: null }).kind, "accepted");
  assert.equal(chk(rule("class"), txt.replace("class-spell", "gunslinger"), { type: "feat", actionType: "action", area: null }).kind, "accepted");   // слаг класса — тот же класс
});

test("strikeGate/multiStrike: «counts as two attacks … attack penalty» — один Удар (Explosive Headbutt, Demolish Defenses)", async () => {
  const { multiStrike } = await import("../tools/strike-gate.mjs");
  assert.equal(multiStrike("<p>The giant attempts a headbutt Strike. This counts as two attacks when calculating the giant's attack penalty. If this Strike hits, the creature must attempt a save.</p>"), false);
  assert.equal(multiStrike("<p>Make a Strike that counts as two attacks for your multiple attack penalty. On a hit the target must save.</p>"), false);
  assert.equal(multiStrike("<p>Make two claw attacks. If both hit, the target must save.</p>"), true);
});

test("check-answer: несколько outcome:* на верхнем уровне when — ошибка, {or} — нет", () => {
  const ev = (when) => ({ v: 1, onEvent: [{ on: "attack-roll", side: "self", when, challenge: save("class") }] });
  const txt = "A creature hit by the claw Strike must attempt a @Check[reflex|against:class] save.";
  const k = { type: "feat", actionType: "passive", area: null };
  const bad = chk(ev(["target", "outcome:success", "outcome:criticalSuccess"]), txt, k);
  assert.equal(bad.kind, "error");
  assert.match(bad.errors.join(), /several outcome/);
  assert.equal(chk(ev(["target", { or: ["outcome:success", "outcome:criticalSuccess"] }]), txt, k).kind, "accepted");
  assert.equal(chk(ev(["target", "outcome:criticalSuccess"]), txt, k).kind, "accepted");
});

test("check-answer: against сверяется только со спасбросками; occult = spell (Brain Drain)", () => {
  const txt = "Roll @Check[acrobatics|against:perception] to hide, then the target attempts @Check[will|against:occult|options:inflicts:stupefied].";
  const rule = (a) => ({ v: 1, onUse: { targets: "selected", challenge: { ...save(a), statistic: "will" }, apply: [] } });
  const k = { type: "feat", actionType: "action", area: null };
  assert.equal(chk(rule("spell"), txt, k).kind, "accepted");
  assert.equal(chk(rule("class"), txt, k).kind, "error");
});

test("check-answer: area для правила с zone советует формы 1a/1c", () => {
  const rule = { v: 1, onUse: { targets: "area", zone: { duration: { seconds: 60 }, triggers: [{ on: "enter", challenge: save("class") }] }, apply: [] } };
  const r = chk(rule, "A cloud of mist.", { type: "feat", actionType: "action", area: null });
  assert.equal(r.kind, "error");
  assert.match(r.errors[0], /1a\/1c/);
  assert.doesNotMatch(r.errors[0], /"selected"/);
});

test("processAnswers --final: unsure, чья догадка — strike-gate, сохраняет догадку с причиной needs-primitive: strike-gate", async () => {
  const { processAnswers } = await import("../tools/validate.mjs");
  const html = "<p>Make a melee Strike. On a successful hit, the target must succeed at a @Check[fortitude|dc:20] save or become prone.</p>";
  const rule = { v: 1, onUse: { targets: "selected", apply: [], challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, byDegree: { failure: [{ to: "target", condition: { slug: "prone" } }] } } } };
  const d = { uuid: "u", name: "X", type: "feat" };
  const res = processAnswers([{ uuid: "u", rule, unsure: true, note: "n" }], [d], refs, undefined, { htmlOf: () => html, final: true, actionTypeOf: () => "passive" });
  assert.equal(res.accepted.length, 1);
  assert.match(res.accepted[0].reason, /^needs-primitive: strike-gate/);
  assert.ok(res.accepted[0].rule);
});

const ACT = '<p><strong>Activate—Tide</strong> <span class="action-glyph">2</span> (concentrate)</p><p><strong>Frequency</strong> once per day</p><hr /><p><strong>Effect</strong> Foes fall prone.</p>';
const useSave = { targets: "selected", challenge: { ...save(), dc: { value: 20 } } };

test("активация с Frequency: шаги в корневом onUse — ошибка, в activate — принято", () => {
  const root = chk({ v: 1, onUse: useSave }, ACT);
  assert.equal(root.kind, "error");
  assert.match(root.errors[0], /activate: \[\{id, label, per, onUse\}\]/);
  assert.equal(chk({ v: 1, activate: [{ id: "tide", label: "Tide", per: { value: 1, unit: "days" }, onUse: useSave }] }, ACT).kind, "accepted");
  // без Frequency: selected/self в корне карточка не исполнит — тоже activate (без per); область — исполнит
  const noFreq = "<p><strong>Activate</strong> 1 Interact</p><p><strong>Effect</strong> Foes fall prone.</p>";
  assert.match(chk({ v: 1, onUse: useSave }, noFreq).errors?.[0] ?? "", /activate: \[\{id, label, onUse\}\]/);
  assert.equal(chk({ v: 1, activate: [{ id: "tide", label: "Tide", onUse: useSave }] }, noFreq).kind, "accepted");
  assert.equal(chk({ v: 1, onUse: { ...useSave, targets: "area" } }, noFreq).kind, "accepted");
  assert.equal(chk({ v: 1, onUse: useSave, activate: [{ id: "tide", label: "Tide", onUse: useSave }] }, noFreq).kind, "error");   // корневой не-area не спасает и соседняя запись activate
});

test("расходник, действие и черта: корневой onUse при Frequency второй активации — не ошибка", () => {
  for (const type of ["consumable", "action", "feat"]) assert.equal(chk({ v: 1, onUse: useSave }, ACT, { type }).kind, "accepted", type);
  assert.equal(chk({ v: 1, onUse: useSave }, ACT, { type: "equipment" }).kind, "error");
});

test("постоянный урон от круга: формулы из ответов Критика считаются по кругу", async () => {
  const { resolveFormula, isPersFormula } = await import("../scripts/rules.mjs");
  for (const f of ["(1+floor((@item.rank-1)/2))", "(2+2*floor((@item.rank-1)/2))", "(1+max(0,floor((@item.rank-5)/2)))d10"]) assert.ok(isPersFormula(f), f);
  assert.deepEqual([1, 3, 5].map((rank) => resolveFormula("(2+2*floor((@item.rank-1)/2))", { rank })), ["2", "4", "6"]);
  assert.deepEqual([5, 7, 9].map((rank) => resolveFormula("(1+max(0,floor((@item.rank-5)/2)))d10", { rank })), ["1d10", "2d10", "3d10"]);
});

test("снаряжение: блоков Activate больше, чем записей activate — ошибка; unsure и consumable не трогаем", () => {
  const two = '<p><strong>Activate</strong> Light <strong>Effect</strong> glow</p><p><strong>Activate</strong> Flash <strong>Frequency</strong> once per day <strong>Effect</strong> flash</p>';
  const one = { id: "flash", label: "Flash", per: { value: 1, unit: "days" }, onUse: { targets: "selected", apply: [{ to: "target", condition: { slug: "blinded" } }] } };
  const e = checkAnswer({ uuid: "u", rule: { v: 1, activate: [one] } }, refs, two, { type: "equipment" });
  assert.equal(e.kind, "error");
  assert.match(e.errors[0], /1 more `Activate` block/);
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, activate: [one, { ...one, id: "light", per: undefined }] } }, refs, two, { type: "equipment" }).kind, "accepted");
  assert.match(e.errors[0], /single `note` step/);   // подсказка не разрешает молча пропустить
  const note = { id: "light", label: "Light", onUse: { targets: "self", apply: [{ to: "self", note: "Только сюжет." }] } };
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, activate: [one, note] } }, refs, two, { type: "equipment" }).kind, "accepted");
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, activate: [one] }, unsure: true }, refs, two, { type: "equipment" }).kind, "unsure");
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, activate: [one] } }, refs, two, { type: "consumable" }).kind, "accepted");
});

test("атака заклинанием против спасброска (Murderous Vine) — ошибка; против AC и навык против Fortitude — принято", () => {
  const atk = (vs) => ({ v: 1, onUse: { targets: "selected", check: { statistic: "spell-attack", vs, roll: "system", byDegree: { success: [{ to: "target", condition: { slug: "grabbed" } }] } } } });
  const html = "Make a ranged spell attack roll against the target's Fortitude DC. On a success, the creature is grabbed.";
  for (const vs of [{ defense: "fortitude" }, { against: "will" }]) assert.match(chk(atk(vs), html).errors?.[0] ?? "", /spell-attack-save/);
  assert.equal(chk(atk({ defense: "ac" }), html).kind, "accepted");
  const skill = atk({ defense: "fortitude" });
  skill.onUse.check.statistic = "athletics"; delete skill.onUse.check.roll;
  assert.equal(chk(skill, html).kind, "accepted");
});

test("--final: догадка с пропущенной активацией не теряется, пропуск идёт в partial", async () => {
  const { processAnswers, emptyState } = await import("../tools/validate.mjs");
  const two = '<p><strong>Activate</strong> Light <strong>Effect</strong> glow</p><p><strong>Activate</strong> Flash <strong>Frequency</strong> once per day <strong>Effect</strong> flash</p>';
  const one = { id: "flash", label: "Flash", per: { value: 1, unit: "days" }, onUse: { targets: "selected", apply: [{ to: "target", condition: { slug: "blinded" } }] } };
  const r = processAnswers([{ uuid: "u", rule: { v: 1, activate: [one] }, unsure: true, note: "activation Light: narrative" }], [{ uuid: "u", type: "equipment", name: "X" }], refs, emptyState(), { htmlOf: () => two, final: true });
  const [a] = r.accepted;
  assert.equal(a.confidence, "needs-primitive");
  assert.equal(a.rule?.activate?.length, 1);
  assert.match(a.partial[0], /1 activation/);
});
