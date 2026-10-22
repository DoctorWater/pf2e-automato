import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveFromMarkup } from "../scripts/rules.mjs";

const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));
const IDS = { TBSHQspnbcqxsmjL: "frightened", sDPxOjQ9kx2RZE8D: "fleeing", xYTAsEpcJE1Ccni3: "slowed", XgEqL1kFApUbl5Z2: "blinded", fesd1n5eVhpCSS18: "sickened", ConfusedAAAAAAAA: "confused" };
const condSlug = (u) => IDS[u.split(".").pop()] ?? null;
const U = (id) => `@UUID[Compendium.pf2e.conditionitems.Item.${id}]`;
// как runtimeCondNames: английский slug + локализованное имя
const NAMES = [["Испуг", "frightened"], ["Паника", "fleeing"], ["Замедление", "slowed"], ["Слепота", "blinded"], ["Тошнота", "sickened"], ["Замешательство", "confused"], ["frightened", "frightened"], ["fleeing", "fleeing"]];

const derive = (html) => deriveFromMarkup({ type: "spell", name: "T", system: { description: { value: html }, defense: { save: { statistic: "will", basic: false } } } }, labels, condSlug, NAMES);
const by = (d) => Object.fromEntries(Object.entries(d.rule.onUse.challenge.byDegree).map(([k, v]) => [k, v.map((a) => [a.condition.slug, a.condition.value, a.duration && `${a.duration.value}${a.duration.unit}${a.duration.expiry ? ":" + a.duration.expiry + ":" + a.duration.of : ""}`])]));

test("Страх RU: простой текст и длительность", () => {
  const d = derive(`<b>Критический успех:</b> цель избегает эффекта.\n<br>\n<b>Успех:</b> цель получает ${U("TBSHQspnbcqxsmjL")}{испуг} 1.\n<br>\n<b>Провал:</b> цель получает испуг 2.\n<br>\n<b>Критический провал:</b> цель получает испуг 3 и в ${U("sDPxOjQ9kx2RZE8D")}{панике} в течение\n1 раунда.\n<hr>\n<b>Повышенное (3 круг):</b> вы можете выбрать целями 5 или менее существ.`);
  assert.equal(d.confidence, "high");
  assert.deepEqual(by(d), {
    success: [["frightened", 1, undefined]],
    failure: [["frightened", 2, undefined]],
    criticalFailure: [["frightened", 3, undefined], ["fleeing", undefined, "1rounds"]]
  });
});

test("Страх EN: frightened 2, for 1 round", () => {
  const d = derive(`<p><strong>Success</strong> The target is ${U("TBSHQspnbcqxsmjL")}{Frightened 1}.</p>
<p><strong>Failure</strong> The target is frightened 2.</p>
<p><strong>Critical Failure</strong> The target is frightened 3 and ${U("sDPxOjQ9kx2RZE8D")}{fleeing} for 1 round.</p>`);
  assert.deepEqual(by(d), {
    success: [["frightened", 1, undefined]],
    failure: [["frightened", 2, undefined]],
    criticalFailure: [["frightened", 3, undefined], ["fleeing", undefined, "1rounds"]]
  });
});

test("slow: падеж без ссылки, длительность на раунд/минуту", () => {
  const d = derive(`<b>Успех:</b> цель получает ${U("xYTAsEpcJE1Ccni3")}{замедление} 1 на 1 раунд.<br><b>Провал:</b> цель получает замедление 1 на 1 минуту.<br><b>Критический провал:</b> цель получает замедление 2 на 1 минуту.`);
  assert.deepEqual(by(d), {
    success: [["slowed", 1, "1rounds"]],
    failure: [["slowed", 1, "1minutes"]],
    criticalFailure: [["slowed", 2, "1minutes"]]
  });
});

test("blindness: слепоту без числа, «навсегда» без длительности", () => {
  const d = derive(`<b>Успех:</b> цель получает ${U("XgEqL1kFApUbl5Z2")}{слепоту} до начала своего следующего хода.<br><b>Провал:</b> цель получает слепоту на 1 минуту.<br><b>Критический провал:</b> цель получает слепоту навсегда.`);
  assert.equal(d.confidence, "high");   // слепота есть ссылкой в описании — простой текст берётся без понижения
  assert.deepEqual(by(d), {
    success: [["blinded", undefined, "1rounds:turn-start:target"]],
    failure: [["blinded", undefined, "1minutes"]],
    criticalFailure: [["blinded", undefined, undefined]]
  });
});

test("phantom-pain: «от тошноты» без числа и «испуганный» не ловятся", () => {
  const d = derive(`<b>Провал:</b> цель получает ${U("fesd1n5eVhpCSS18")}{тошноту} 1. Если цель избавится от тошноты, урон прекращается.<br><b>Критический провал:</b> цель получает тошноту 2.<br><b>Успех:</b> испуганный страж не реагирует. Неиспуг 2.`);
  assert.deepEqual(by(d), {
    failure: [["sickened", 1, undefined]],
    criticalFailure: [["sickened", 2, undefined]]
  });
});

test("состояния восприятия простым текстом не вешаются", () => {
  const d = deriveFromMarkup({ type: "spell", name: "T", system: { description: { value: `<b>Провал:</b> цель hidden 1 и off-guard.` }, defense: { save: { statistic: "will" } } } }, labels, condSlug, [["hidden", "hidden"], ["off guard", "off-guard"]]);
  assert.deepEqual(d.rule.onUse.challenge.byDegree, {});
});

const one = (deg, txt, names = NAMES, pre = "") => deriveFromMarkup({ type: "spell", name: "T", system: { description: { value: `${pre}<b>${deg}:</b> ${txt}` }, defense: { save: { statistic: "will" } } } }, labels, condSlug, names)?.rule.onUse.challenge.byDegree ?? "null";
const BL = `<p>${U("XgEqL1kFApUbl5Z2")}</p>`;   // ссылка на состояние где-то в описании
const bd = (deg, txt, pre = "") => by({ rule: { onUse: { challenge: { byDegree: one(deg, txt, en, pre) } } } });
const en = [...NAMES, ["blinded", "blinded"], ["confusion", "confused"], ["Замешательство", "confused"], ["prone", "prone"], ["Захват", "grabbed"], ["Ускорение", "quickened"], ["Слепота", "blinded"], ["hastened", "quickened"], ["stunned", "stunned"], ["Истощение", "drained"], ["drained", "drained"], ["slowed", "slowed"], ["sickened", "sickened"]];

test("стоп-слова: избавление, избегание, отрицание, условие", () => {
  for (const t of ["цель избавляется от слепоты.", "цель избегает паники и замешательства.", "the target is no longer blinded.", "если цель уже в замешательстве, ничего.",
    "the target can't be knocked prone.", "цель высвобождается из захвата.", "цель теряет ускорение.", "immune to blinded."])
    assert.deepEqual(one("Провал", t, en), {}, t);
});

test("EN: for 1 minute / for 1 day не ломают правило", () => {
  assert.deepEqual(by({ rule: { onUse: { challenge: { byDegree: one("Failure", "The target is frightened 2 for 1 minute.") } } } }), { failure: [["frightened", 2, "1minutes"]] });
  assert.deepEqual(by({ rule: { onUse: { challenge: { byDegree: one("Failure", "The target is frightened 2 for 1 day.") } } } }), { failure: [["frightened", 2, "1days"]] });
  assert.deepEqual(by({ rule: { onUse: { challenge: { byDegree: one("Провал", "цель получает испуг 2 на 1 день.") } } } }), { failure: [["frightened", 2, "1days"]] });
});

test("длительность только в том же предложении", () => {
  assert.deepEqual(by({ rule: { onUse: { challenge: { byDegree: one("Провал", "цель получает испуг 2, она 1 раунд не может ничего.") } } } }), { failure: [["frightened", 2, undefined]] });
  assert.deepEqual(bd("Провал", "цель получает слепоту. Её скорость снижается на 10 футов на 1 минуту.", BL), { failure: [["blinded", undefined, undefined]] });
});

test("значение простым текстом — максимум", () => {
  assert.deepEqual(by({ rule: { onUse: { challenge: { byDegree: one("Провал", "если у цели испуг 1, она получает испуг 3.") } } } }), { failure: [["frightened", 3, undefined]] });
  assert.deepEqual(by({ rule: { onUse: { challenge: { byDegree: one("Провал", "испуг 1; затем испуг 2.") } } } }), { failure: [["frightened", 2, undefined]] });
});

test("blindness EN: until the end of its next turn", () => {
  const d = derive(`<b>Success:</b> The target is ${U("XgEqL1kFApUbl5Z2")}{blinded} until the end of its next turn.<br><b>Failure:</b> The target is blinded for 1 minute. Until the start of your next turn, x.`);
  assert.deepEqual(by(d), { success: [["blinded", undefined, "1rounds:turn-end:target"]], failure: [["blinded", undefined, "1minutes"]] });
});

const hintsOf = (txt) => deriveFromMarkup({ type: "spell", name: "T", system: { description: { value: `<b>Провал:</b> ${txt}` }, defense: { save: { statistic: "will" } } } }, labels, condSlug, en);

test("без ссылки в описании состояние без значения — только hints.possible, high", () => {
  const d = hintsOf("цель получает слепоту на 1 минуту.");
  assert.equal(d.confidence, "high");
  assert.deepEqual(d.rule.onUse.challenge.byDegree, {});
  assert.deepEqual(d.hints.possible, ["failure:blinded"]);
});

test("срок: его/её/своего -> target, вашего/your -> origin", () => {
  const d = (w) => by(derive(`<b>Провал:</b> цель получает ${U("XgEqL1kFApUbl5Z2")}{слепоту} до конца ${w} следующего хода.`)).failure[0][2];
  for (const w of ["его", "её", "своего"]) assert.equal(d(w), "1rounds:turn-end:target");
  assert.equal(d("вашего"), "1rounds:turn-end:origin");
});

test("срок — только непосредственно предшествующему состоянию", () => {
  assert.deepEqual(bd("Провал", "цель получает замедление 1 и испуг 2 на 1 минуту.", ""), { failure: [["slowed", 1, undefined], ["frightened", 2, "1minutes"]] });
  assert.deepEqual(bd("Провал", "цель получает слепоту и замешательство на 1 минуту.", BL + `<p>${U("ConfusedAAAAAAAA")}</p>`), { failure: [["blinded", undefined, undefined], ["confused", undefined, "1minutes"]] });
  assert.deepEqual(bd("Провал", "в течение 1 минуты цель получает замедление 1.", ""), { failure: [["slowed", 1, undefined]] });
});

/* регрессии корпуса: valued-состояние не получает чужой срок */
test("корпус: чужой срок не липнет к состоянию со значением", () => {
  const E = (txt) => bd("Failure", txt);
  assert.deepEqual(E("The target is off-guard for 1 round and stunned 2."), { failure: [["stunned", 2, undefined]] });                       // Stunning Snare
  assert.deepEqual(E("The target is stunned 1. It is then immune for 24 hours."), { failure: [["stunned", 1, undefined]] });                // Touch of Death
  assert.deepEqual(E("The target is stunned 1, and its Speed is reduced by 10 feet for 1 minute."), { failure: [["stunned", 1, undefined]] });   // Mudrock Snare
  assert.deepEqual(bd("Провал", "цель растеряна на 1 раунд и получает истощение 1."), { failure: [["drained", 1, undefined]] });                   // Herald's Strike
  assert.deepEqual(E("The target is frightened 1 and can't act for 1 round."), { failure: [["frightened", 1, undefined]] });
});

test("«вы» от начала фразы; или/or между состояниями — hints.possible", () => {
  assert.deepEqual(bd("Провал", "вы сами, не раздумывая, а затем цель получает испуг 1."), { failure: [["frightened", 1, undefined]] });
  assert.deepEqual(bd("Провал", "вы сами, получаете испуг 1."), { failure: [["frightened", 1, undefined]] });   // «вы» до запятой — другая фраза
  assert.deepEqual(bd("Провал", "вы сами получаете испуг 1."), {});
  const d = hintsOf("цель получает испуг 1 или тошноту 2.");
  assert.deepEqual(d.rule.onUse.challenge.byDegree, {});
  assert.deepEqual(d.hints.possible, ["failure:frightened", "failure:sickened"]);
});

test("стоп-слова: не, ни, из-за, от огня, at the end of; вы/you", () => {
  assert.deepEqual(bd("Провал", "цель не получает испуг 1."), {});
  assert.deepEqual(bd("Провал", "урон от огня и испуг 1."), { failure: [["frightened", 1, undefined]] });
  assert.deepEqual(bd("Провал", "из-за боли цель получает тошноту 1."), { failure: [["sickened", 1, undefined]] });
  assert.deepEqual(bd("Failure", "at the end of its turn and is frightened 2."), { failure: [["frightened", 2, undefined]] });
  assert.deepEqual(bd("Failure", "the effect ends and you are frightened 2."), {});
  assert.deepEqual(bd("Провал", "вы получаете испуг 2."), {});
});

test("альтернатива/условие не берётся в максимум", () => {
  assert.deepEqual(bd("Провал", "испуг 1 вместо испуга 2."), { failure: [["frightened", 2, undefined]] });
  assert.deepEqual(bd("Failure", "frightened 2, or frightened 3 if it is a beast."), { failure: [["frightened", 2, undefined]] });
});

test("&nbsp; между именем и числом; срок 0 — не срок", () => {
  assert.deepEqual(bd("Провал", "цель получает испуг&nbsp;2 на 1 минуту."), { failure: [["frightened", 2, "1minutes"]] });
  assert.deepEqual(bd("Провал", "цель получает испуг 2 на 0 раундов."), { failure: [["frightened", 2, undefined]] });
});
