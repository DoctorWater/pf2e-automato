import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { critRecharges, isBreath, rechargeOf, parseDice, rollDice, rollData, rechargeLeft, hitOf, lastAct, clauseState, reqFails, holdsFrom, reqSig } from "../scripts/builtin/limit-text.mjs";
import { reqOf, clauseOf, buildLimits } from "../tools/use-limits.mjs";

const MOD = "pf2e-automato";

test("critRecharges: Draconic/Kobold Momentum, тексты крита, не Frenzy/Scream/Spitting Rage; isBreath", () => {
  assert.ok(critRecharges("draconic-momentum", ""));
  assert.ok(critRecharges("kobold-momentum", ""));
  assert.ok(critRecharges(null, "<p>The dragon recharges its Breath Weapon whenever it scores a critical hit with a Strike.</p>"));
  assert.ok(critRecharges(null, "On a critical hit with an unarmed Strike gained from dragon form, you recharge the spell's breath weapon immediately."));
  assert.ok(critRecharges(null, "Когда существо наносит критическое попадание, оно перезаряжает Дыхание."));
  assert.ok(!critRecharges("scream-in-agony", "recharges the ability whenever they take damage from an attacker's critical hit"));
  assert.ok(!critRecharges("draconic-frenzy", "If any of these attacks critically hits an enemy, your eidolon instantly recovers the use of their Dragon Breath."));
  assert.ok(!critRecharges("spitting-rage", "Trigger A creature scores a critical hit on the mukradi Effect The mukradi's Breathe Energy recharges."));
  assert.ok(isBreath(["breath"], "x") && isBreath([], "breath-weapon") && !isBreath(["fire"], "fireball"));
});

// --- M1: разбор встроенного броска #Recharge (реальные строки tools/out/items.json) ---
test("rechargeOf: формы en/ru, срок в раундах", () => {
  assert.deepEqual(rechargeOf("and you can't use Overdrive again for [[/r 1d4 #Recharge Overdrive]] rounds as your gizmos reset."), { dice: "1d4" });
  assert.deepEqual(rechargeOf("The golem can't use Vent again for [[/gmr 1d6 #Recharge Vent]]{1d6 rounds}."), { dice: "1d6" });
  assert.deepEqual(rechargeOf("can't use Crew's Call again for [[/gmr 1d4+1 #Recharge Crew's Call]]{1d4+1 rounds}."), { dice: "1d4+1" });
  assert.deepEqual(rechargeOf("The cinder rat can't use Breath Weapon again for [[/br {1d4} #Recharge Breath Weapon]]{1d4 rounds}."), { dice: "1d4" });
  assert.deepEqual(rechargeOf("не можете использовать Перегрузку в течение [[/r 1d4 #Recharge Overdrive]]{1d4} раундов, пока не восстановятся"), { dice: "1d4" });
  assert.deepEqual(rechargeOf("повторно только через [[/gmr 1d4 #Recharge Breath Weapon]]{1d4} раунда."), { dice: "1d4" });
  assert.deepEqual(rechargeOf("только через [[/gmr 1d4 #Recharge Scree Breath]]{1d4}\nраунда."), { dice: "1d4" }, "перенос строки между подписью и единицей");
  assert.deepEqual(rechargeOf("once every [[/gmr 1d4 #Recharge Gaze]] rounds"), { dice: "1d4" }, "без «again»");
});

test("rechargeOf: не раунды / другой механизм / неоднозначно — null (пропуск, не ложный блок)", () => {
  assert.equal(rechargeOf("she cannot do so again for [[/gmr 1d10 #Recharge Tempest Rage]] minutes."), null);
  assert.equal(rechargeOf("the bone croupier rolls [[/br 2d6 #Recharge Change of Luck]] at the start of each of their turns, recharging the ability"), null);
  assert.equal(rechargeOf("Автоматизация: [[/r 1d4 #Recharge Kobold Breath]]{1d4} @Check[fortitude]"), null, "вспомогательный бросок pf2ru без срока");
  assert.equal(rechargeOf("[[/r 1d4 #Recharge A]] rounds and [[/r 1d6 #Recharge B]] rounds"), null);
  assert.equal(rechargeOf("[[/r 1d4 #Duration X]] rounds"), null);
  assert.equal(rechargeOf(""), null);
  assert.equal(rechargeOf(undefined), null);
});

test("кубики: разбор, бросок по rnd, Roll-данные из выпавших граней", () => {
  assert.deepEqual(parseDice("1d4+1"), { count: 1, faces: 4, mod: 1 });
  assert.equal(parseDice("0d4"), null);
  assert.equal(parseDice("1d4+x"), null);
  assert.deepEqual(rollDice("1d4", () => 0.99), { n: 4, r: [4], mod: 0 });
  assert.deepEqual(rollDice("1d4", () => 0), { n: 1, r: [1], mod: 0 });
  assert.deepEqual(rollDice("2d6+1", () => 0.5), { n: 9, r: [4, 4], mod: 1 });
  assert.equal(rollDice("1d4-3", () => 0).n, 1, "не меньше раунда");
  const d = rollData("2d6+1", [4, 4], 1);
  assert.equal(d.total, 9);
  assert.equal(d.terms.length, 3);
  assert.deepEqual(d.terms[0].results, [{ result: 4, active: true }, { result: 4, active: true }]);
});

test("rechargeLeft: тот же бой и раунд меньше срока", () => {
  const lock = { c: "c", until: 5 };
  assert.equal(rechargeLeft(lock, "c", 3), 2);
  assert.equal(rechargeLeft(lock, "c", 5), 0);
  assert.equal(rechargeLeft(lock, "other", 3), 0, "другой бой");
  assert.equal(rechargeLeft(lock, "c", undefined), 0, "вне боя");
  assert.equal(rechargeLeft(undefined, "c", 3), 0);
});

// --- M2 ---
test("hitOf: трёхзначный (цели нет — null)", () => {
  assert.equal(hitOf("success"), true);
  assert.equal(hitOf("criticalSuccess"), true);
  assert.equal(hitOf("failure"), false);
  assert.equal(hitOf("criticalFailure"), false);
  assert.equal(hitOf(null), null);
  assert.equal(hitOf(undefined), null);
});

test("lastAct: последний штамп именно этого актёра (копии одного NPC не путаются)", () => {
  const m = (who, kind) => ({ flags: { [MOD]: { act: { who, kind } } } });
  const msgs = [m("copy1", "strike"), { flags: {} }, m("copy2", "use"), { flags: {} }];
  assert.equal(lastAct(msgs, "copy1", MOD).kind, "strike");
  assert.equal(lastAct(msgs, "copy2", MOD).kind, "use");
  assert.equal(lastAct(msgs, "copy3", MOD), null);
});

const strike = (o = {}) => ({ turn: "c:1:0", kind: "strike", hit: true, fx: ["grab"], slug: "claw", ...o });
const ctx = (act, o = {}) => ({ turn: "c:1:0", act, holds: false, handsFree: undefined, ...o });
const grab = { any: [{ k: "strike", fx: "grab" }, { k: "holds" }] };

test("клауза strike: попал / промах / без цели / не Удар / прошлый ход / fx / имя", () => {
  assert.equal(reqFails(grab, ctx(strike())), false);
  assert.equal(reqFails(grab, ctx(strike({ hit: false }))), true, "явный промах");
  assert.equal(reqFails(grab, ctx(strike({ hit: null }))), false, "Удар без цели: исхода нет — не блокируем");
  assert.equal(reqFails(grab, ctx({ turn: "c:1:0", kind: "use" })), true, "прошлое действие — не Удар");
  assert.equal(reqFails(grab, ctx(strike({ turn: "c:0:3" }))), true, "Удар прошлого хода");
  assert.equal(reqFails(grab, ctx(null)), false, "журнала нет — неизвестно, пропуск");
  assert.equal(reqFails(grab, ctx(strike({ fx: ["knockdown"] }))), true, "Удар без нужного эффекта");
  assert.equal(reqFails(grab, ctx(strike({ fx: [] }))), false, "список эффектов пуст — неизвестно");
  const claw = { any: [{ k: "strike", name: "claw" }] };
  assert.equal(reqFails(claw, ctx(strike({ slug: "jaws" }))), true);
  assert.equal(reqFails(claw, ctx(strike({ slug: null }))), false, "имя Удара неизвестно — пропуск");
  assert.equal(reqFails({ any: [{ k: "strike", name: "melee-trident" }] }, ctx(strike({ slug: "trident" }))), false);
  assert.equal(reqFails(grab, ctx(strike({ hit: false }), { turn: null })), false, "вне боя «последнее действие» не проверяется");
});

test("«любое из»: держит существо или свободная рука выручают", () => {
  assert.equal(reqFails(grab, ctx(strike({ hit: false }), { holds: true })), false);
  assert.equal(clauseState({ k: "holds" }, ctx(null, { holds: false })), false);
  const hand = { any: [{ k: "hand" }] };
  assert.equal(reqFails(hand, ctx(null, { handsFree: 0 })), true);
  assert.equal(reqFails(hand, ctx(null, { handsFree: 1 })), false);
  assert.equal(reqFails(hand, ctx(null, { handsFree: undefined })), false, "у NPC нет system.hands");
});

test("holdsFrom: третий актёр не в счёт; автор, сам держатель и неизвестный — в счёт", () => {
  assert.equal(holdsFrom([{ uuid: "T", origin: "A" }], "A"), true);
  assert.equal(holdsFrom([{ uuid: "T", origin: "T" }], "A"), true, "модуль пишет origin = получатель (of:target)");
  assert.equal(holdsFrom([{ uuid: "T", origin: null }], "A"), true);
  assert.equal(holdsFrom([{ uuid: "T", origin: "B" }], "A"), false, "держит третий");
  assert.equal(holdsFrom([], "A"), false);
});

// --- разбор требований (tools/use-limits.mjs) на реальных строках ---
test("reqOf: универсальные способности бестиария", () => {
  const grabTxt = "Requirements The monster's last action was a successful Strike that lists Grab in its damage entry, or the monster has a creature @UUID[Compendium.pf2e.conditionitems.Item.kWc1fhmv9LBiTuei]{Grabbed} or @UUID[Compendium.pf2e.conditionitems.Item.VcDeM8A5oI6VqhbM]{Restrained}\n---\nEffect If used after a Strike";
  assert.deepEqual(reqOf(grabTxt), { any: [{ k: "strike", fx: "grab" }, { k: "holds" }] });
  assert.deepEqual(reqOf("Requirements The monster's last action was a successful Strike that lists Knockdown in its damage entry\n---\nEffect x"), { any: [{ k: "strike", fx: "knockdown" }] });
  assert.deepEqual(reqOf("Trigger The monster's last action was a successful Strike that lists Improved Push in its damage entry\n---\nEffect x"), { any: [{ k: "strike", fx: "improved-push" }] });
  assert.deepEqual(reqOf("Requirements The dragon's last action was a successful claw Strike."), { any: [{ k: "strike", name: "claw" }] });
  assert.deepEqual(reqOf("Requirements The monster's last action was a success with a Strike that lists Pull in its damage entry"), { any: [{ k: "strike", fx: "pull" }] });
  assert.deepEqual(reqOf("Requirements The dragon's last action was a successful melee Strike"), { any: [{ k: "strike" }] }, "melee — тип, не имя");
});

test("reqOf: держит существо и свободная рука; всё неразобранное — null", () => {
  assert.deepEqual(reqOf("Requirements You have a creature @UUID[Compendium.pf2e.conditionitems.Item.kWc1fhmv9LBiTuei]{Grabbed} or @UUID[Compendium.pf2e.conditionitems.Item.VcDeM8A5oI6VqhbM]{Restrained}."), { any: [{ k: "holds" }] });
  assert.deepEqual(reqOf("Requirements The chupacabra has a creature @UUID[Compendium.pf2e.conditionitems.Item.kWc1fhmv9LBiTuei]{Grabbed}"), { any: [{ k: "holds" }] });
  assert.deepEqual(reqOf("Requirements You have a free hand."), { any: [{ k: "hand" }] });
  assert.equal(reqOf("Requirements Your most recent action was to cast a non-cantrip spell."), null);
  assert.equal(reqOf("Requirements The monster must have a free hand but can Release anything it's holding as part of this reaction."), null);
  assert.equal(reqOf("Requirements The monster's last action was a successful Strike that lists Grab in its damage entry, or it has a creature grabbed using this action."), null, "один клауз не разобран — записи нет целиком");
  assert.equal(reqOf("When the wolf succeeds at its jaws Strike, it can use this action immediately after to attempt to [[/act trip]] the target."), null);
  assert.equal(clauseOf("A Grabbed, Paralyzed, Restrained, or Unconscious creature is within the vampire's reach"), null);
});

test("reqSig: подпись абзаца требований без языка; одноимённая способность другого вида — null", () => {
  const en = "<p><p><strong>Requirements</strong> The monster's last action was a successful Strike that lists Grab in its damage entry, or the monster has a creature @UUID[Compendium.pf2e.conditionitems.Item.kWc1fhmv9LBiTuei]{Grabbed} or @UUID[Compendium.pf2e.conditionitems.Item.VcDeM8A5oI6VqhbM]{Restrained}</p><hr /><p><strong>Effect</strong> x</p>";
  const ru = "<p><strong>Требования</strong> Последнее действие монстра — успешный Удар… или у монстра есть существо в состоянии @UUID[Compendium.pf2e.conditionitems.Item.kWc1fhmv9LBiTuei]{Схвачен} или @UUID[Compendium.pf2e.conditionitems.Item.VcDeM8A5oI6VqhbM]{Обездвижен}</p>";
  assert.equal(reqSig(en), "kWc1fhmv9LBiTuei,VcDeM8A5oI6VqhbM");
  assert.equal(reqSig(ru), reqSig(en));
  assert.equal(reqSig("<p><strong>Requirements</strong> The monster's last action was a successful Strike that lists Knockdown in its damage entry</p>"), "");
  assert.equal(reqSig("<p>When the wolf succeeds at its jaws Strike, it can use this action immediately after to attempt to [[/act trip]] the target.</p>"), null);
  assert.equal(reqSig(undefined), null);
  assert.equal(reqSig("@Localize[PF2E.NPC.Abilities.Glossary.Grab]"), "loc:Grab", "глоссарий бестиария: описание — ссылка на строку pf2e");
});

test("buildLimits: bySlug — варианты по подписи; общий slug с иным текстом не подхватывается; только action", () => {
  const html = {
    g1: "<p><strong>Requirements</strong> The monster's last action was a successful Strike that lists Knockdown in its damage entry</p>",
    g2: "<p><strong>Requirements</strong> The monster's last action was a successful Strike that lists Knockdown in its damage entry</p>",
    wolf: "<p>When the wolf succeeds at its jaws Strike, it can use this action immediately after to attempt to [[/act trip]] the target.</p>",
    f1: "<p><strong>Requirements</strong> You have a free hand.</p>"
  };
  const base = { slug: "knockdown", type: "action", actionType: "action", name: "Knockdown" };
  const items = [
    { ...base, uuid: "g1", descEn: "Requirements The monster's last action was a successful Strike that lists Knockdown in its damage entry\n---\nEffect x", dupCount: 159 },
    { ...base, uuid: "g2", descEn: "Requirements The monster's last action was a successful Strike that lists Knockdown in its damage entry\n---\nEffect y" },
    { ...base, uuid: "wolf", descEn: "When the wolf succeeds at its jaws Strike, it can use this action immediately after to attempt to [[/act trip]] the target." },
    { slug: "trip-up", type: "feat", actionType: "action", name: "Trip Up", uuid: "f1", descEn: "Requirements You have a free hand." }
  ];
  const out = buildLimits(items, html);
  assert.deepEqual(out.bySlug["knockdown@action"], [{ sig: "", req: { any: [{ k: "strike", fx: "knockdown" }] } }]);
  assert.equal(out.bySource.wolf, undefined);
  assert.deepEqual(out.bySource.f1, { any: [{ k: "hand" }] }, "черта — только bySource");
  assert.equal(out.bySlug["trip-up@feat"], undefined);
});

// Охват по реальному корпусу (если извлечён): нижние границы, чтобы разбор не деградировал молча
const ITEMS = new URL("../tools/out/items.json", import.meta.url);
test("корпус: охват перезарядки и требований", { skip: !existsSync(ITEMS) }, () => {
  const items = JSON.parse(readFileSync(ITEMS, "utf8")).items;
  let rc = 0, rcRu = 0, rcRuAll = 0;
  for (const i of items) {
    if (["action", "feat"].includes(i.type) && rechargeOf(i.descEn)) rc += i.dupCount || 1;
    if (/#(?:Recharge|Перезаряд)/i.test(i.descRu ?? "")) { rcRuAll++; if (rechargeOf(i.descRu)) rcRu++; }
  }
  assert.ok(rc >= 1150, `перезарядка action/feat: ${rc} док.`);
  assert.ok(rcRu / rcRuAll >= 0.9, `русские описания: ${rcRu} из ${rcRuAll}`);
  const out = buildLimits(items, JSON.parse(readFileSync(new URL("../tools/out/html.json", import.meta.url), "utf8")));
  assert.ok(out.report.covered >= 1400, `требования: ${out.report.covered} док.`);
  for (const k of ["grab", "knockdown", "push", "improved-grab"]) assert.ok(out.bySlug[`${k}@action`], k);
});
