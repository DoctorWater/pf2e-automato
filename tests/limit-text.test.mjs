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
  assert.deepEqual(reqOf("Requirements The dragon's last action was a successful melee Strike"), { any: [{ k: "strike", melee: true }] }, "melee — тип Удара, не имя");
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

// --- M1: чья перезарядка (оценка на выборке: подпись #Recharge ≠ имя предмета, условные броски, общая перезарядка) ---
import { rechargeFull, rechargeIds } from "../scripts/builtin/limit-text.mjs";

const FEED = "Frequency once per round\n---\nEffect The voidglutton feeds on the creature's terror.\n\nIt cannot use Consume Light again for [[/gmr 1d4 #Recharge Consume Light]]{1d4 rounds}, as it is too glutted on fear to suppress its Glow.";
const BREATH2 = "The linnorm can't use Corrosive Breath or Double Breath again for [[/gmr 1d4 #Recharge Corrosive Breath or Double Breath]]{1d4 rounds}.";
const ids = (label, name, others = []) => rechargeIds(label, [name, name.toLowerCase().replace(/\W+/g, "-")], "self", others.map(([id, n]) => ({ id, names: [n] })));

test("M1: Feed on Fear — метка Consume Light: свой замок не ставится, замок на Consume Light; без такой способности — ничего", () => {
  assert.equal(rechargeFull(FEED).label, "Consume Light");
  assert.deepEqual(ids("Consume Light", "Feed on Fear"), []);
  assert.deepEqual(ids("Consume Light", "Feed on Fear", [["cl", "Consume Light"], ["x", "Glow"]]), ["cl"]);
  assert.deepEqual(ids("Feed on Fear", "Feed on Fear"), ["self"]);
});

test("M1: метка совпадает с именем — по переводу, английскому имени и без артиклей/скобок/регистра", () => {
  assert.deepEqual(rechargeIds("Consume Light", ["Поглощение света", "consume-light", "Consume Light"], "s", []), ["s"], "исходное английское имя (babele.originalName)");
  assert.deepEqual(rechargeIds("Inhabit an Object", ["(Ghost) Inhabit Object"], "s", []), ["s"]);
  assert.deepEqual(rechargeIds("it", ["Monk's Flurry"], "s", []), ["s"], "подпись-местоимение — своя перезарядка");
  assert.deepEqual(rechargeIds("Fortune Fog", ["Fog of Chance"], "s", []), [], "чужая подпись без такой способности — не блокируем");
  assert.deepEqual(rechargeIds("Breath Weapon", ["Black Water Breath"], "s", []), ["s"], "общее «Breath Weapon» у способности с Breath в имени — свой замок");
});

test("M1: цели берутся из оборота «can't use X», подпись — запасной вариант; опечатки и местоимения — свой замок", () => {
  const cant = (t) => rechargeFull(t).cant;
  assert.equal(cant(FEED), "Consume Light");
  assert.equal(cant(BREATH2), "Corrosive Breath or Double Breath");
  assert.equal(cant("The fiddling bones can't use Dance with Death or Destructive Finale for [[/gmr 1d4 #Recharge]]{1d4 rounds}."), "Dance with Death or Destructive Finale");
  assert.equal(cant("The firewyrm can't Breathe Fire again for [[/gmr 1d4 #Recharge Breathe Fire]]{1d4 rounds}."), "Breathe Fire");
  assert.equal(cant("Существо не может использовать Огненный шар снова в течение [[/gmr 1d4 #Recharge]]{1d4 раундов}."), "Огненный шар");
  const my = (label, c, name, others = []) => rechargeIds(label, [name], "s", others.map(([id, n]) => ({ id, names: [n] })), c);
  assert.deepEqual(my("", "Dance with Death or Destructive Finale", "Destructive Finale", [["d", "Dance with Death"]]), ["s", "d"], "метка пуста");
  assert.deepEqual(my("Acid Action", "Bombardier's Spray or Burning Pool", "Burning Pool"), ["s"], "метка чужая, оборот называет свою");
  assert.deepEqual(my("Ectoplasmatic Form", "it", "Ectoplasmic Form"), ["s"], "опечатка + местоимение");
  assert.deepEqual(my("Breathe Fire", "Breathe Fire", "Breath Fire"), ["s"], "опечатка");
  assert.deepEqual(my("Breath Weapon", "Breath Weapon", "Forge-Flame Breath"), ["s"]);
  assert.deepEqual(my("Full Bloom", "it", "Wail of the Forest"), ["s"], "«it», ничего не найдено — на себя");
  assert.deepEqual(my("Full Bloom", "it", "Wail of the Forest", [["fb", "Full Bloom"]]), ["fb"], "подпись находит другую способность");
  assert.deepEqual(my("Consume Light", "Consume Light", "Feed on Fear"), [], "чужая способность не найдена — не блокируем");
});

test("M1: HTML без переводов строк — исход спасброска в соседнем абзаце всё равно делает перезарядку условной", () => {
  const html = "<p>Effect text.</p><p><strong>Critical Failure</strong> The ooze can't use Slime again for [[/gmr 1d4 #Recharge Slime]]{1d4 rounds}.</p>";
  assert.equal(rechargeFull(html), null);
  assert.equal(rechargeFull("<p>Intro.</p><hr /><p>Критический провал: не может использовать Слизь [[/gmr 1d4 #Recharge Слизь]]{1d4 раундов}.</p>"), null);
  assert.equal(rechargeFull("<p>Intro if x.</p><p>It can't use Slime again for [[/gmr 1d4 #Recharge Slime]]{1d4 rounds}.</p>").dice, "1d4", "условие в прошлом абзаце не в счёт");
});

test("M1: общая перезарядка «A or B» — замок на обеих; вторая не найдена — только своя", () => {
  assert.equal(rechargeFull(BREATH2).label, "Corrosive Breath or Double Breath");
  assert.deepEqual(ids("Corrosive Breath or Double Breath", "Corrosive Breath", [["db", "Double Breath"]]), ["self", "db"]);
  assert.deepEqual(ids("Corrosive Breath or Double Breath", "Double Breath", [["cb", "Corrosive Breath"]]), ["self", "cb"]);
  assert.deepEqual(ids("Corrosive Breath or Double Breath", "Double Breath"), ["self"]);
  assert.deepEqual(rechargeIds("Дыхание или Двойное дыхание", ["Дыхание"], "s", [{ id: "d", names: ["Двойное дыхание"] }]), ["s", "d"], "ru: «или»");
});

test("M1: условная перезарядка (исход спасброска, «on these planes», «if …») — не перезарядка", () => {
  const HJ = "Trigger A creature targets the vazgorlu with a Strike\n---\nEffect The target must attempt a @Check[will|dc:39|traits:arcana] save.\n---\nCritical Success The target resists the teleportation, and the vazgorlu can't use Hostile Juxtaposition for [[/gmr 1d4 #Recharge Hostile Juxtaposition]]{1d4 rounds}.\nSuccess The target resists the teleportation.";
  const PULP = "The rift pulper can't Pulp Quintessence again for 1 minute.\n\nThis ability is more effective in the Outer Sphere, and when used on any of these planes, the rift pulper becomes quickened for 2 rounds, and the rift pulper can't use Pulp Quintessence again for [[/gmr 1d4 #Recharge Pulp Quintessence]]{1d4 rounds}.";
  const OVER = "Failure Your gizmos whine.\nCritical Failure Whoops! Something explodes. You take fire damage, and you can't use Overdrive again for [[/r 1d4 #Recharge Overdrive]]";
  const OVER_RU = "Критический провал: упс! Что-то взорвалось. Вы получаете урон огнём и не можете использовать Перегрузку в течение [[/r 1d4 #Recharge Overdrive]]{1d4} раундов.";
  const FLOW = "Effect She gains a +2 circumstance bonus to AC. If she takes electricity damage, she can't use this again for [[/gmr 1d4 #Recharge Go With the Flow]]{1d4 rounds}.";
  const SHELL = "If the iceberg clam does so or the shell is reduced to 0 Hit Points, the iceberg clam can't use Ambush Freeze or Frozen Shell again for [[/gmr 1d4 #Recharge Ambush Freeze or Frozen Shell]]{1d4 rounds}.";
  for (const t of [HJ, PULP, OVER, OVER_RU, FLOW, SHELL]) assert.equal(rechargeOf(t), null, t.slice(0, 40));
  assert.deepEqual(rechargeOf("After you use Dragon Roar, you can't use it again for [[/gmr 1d4 #Recharge Dragon Roar]]{1d4 rounds}."), { dice: "1d4" }, "«after» — не условие");
  assert.deepEqual(rechargeOf(BREATH2), { dice: "1d4" });
});

// --- M2: уточнения не отбрасываются молча (реальные строки Requirements) ---
test("reqOf: уточнения, которых клаузы не выражают — записи нет (не мягче текста)", () => {
  const no = (line) => assert.equal(reqOf(`Requirements ${line}\n---\nEffect x`), null, line);
  no("The assassin is wielding a piercing or slashing weapon and has a free hand.");   // Poison Weapon, Ambush Assassin
  no("Nairu is wielding a piercing or slashing weapon and has a free hand.");
  no("The Bloodstorm is in Demon Shape and has a creature Grabbed");   // Biting Constrict
  no("The grave spinosaurus has a creature Grabbed in its jaws");   // Rip and Tear
  no("The owlbear has a creature Grabbed with its talons.");   // Gnaw
  no("Irahkatu has a Medium or smaller creature grabbed with its tail claw");
  no("You have a creature Grabbed or Restrained with your lash.");
  no("The wolverine has a creature Grabbed from its jaws Strike");
  no("Sorvuth-ka's previous action was a successful Strike against the target");
  no("The monster's last action was a successful piercing or slashing weapon Strike");
});

test("reqOf: подлежащее — имя собственное; melee/ranged и имя Удара выражаются; damaged/hit … on its last action", () => {
  assert.deepEqual(reqOf("Requirements Villamor Koth's last action was a successful Strike."), { any: [{ k: "strike" }] });
  assert.deepEqual(reqOf("Requirements The hill giant's last action was a successful melee Strike"), { any: [{ k: "strike", melee: true }] });
  assert.deepEqual(reqOf("Requirements Your last action was a successful ranged Strike"), { any: [{ k: "strike", melee: false }] });
  assert.deepEqual(reqOf("Requirements The urdefhan damaged a creature with a jaws Strike on its last action"), { any: [{ k: "strike", name: "jaws" }] });
  assert.deepEqual(reqOf("Requirements Nils Kelveken hit a creature with a hand drill Strike with his previous action"), { any: [{ k: "strike", name: "hand-drill" }] });
  assert.deepEqual(reqOf("Requirements You hit a creature with a melee Strike on your last action."), { any: [{ k: "strike", melee: true }] });
  assert.deepEqual(reqOf("Requirements Ashrin has a free hand"), { any: [{ k: "hand" }] });
  assert.deepEqual(reqOf("Requirements The little man in the woods has a creature Grabbed or Restrained"), { any: [{ k: "holds" }] });
  assert.deepEqual(reqOf("Requirements The wolf must have a creature Grabbed."), { any: [{ k: "holds" }] });
});

test("reqOf: абзац Requirements во второй секции (Push or Pull 10 feet) — разбирается; в четвёртой и позже — нет", () => {
  const PUSH = "The tidal master can also pull the creature.\n---\nRequirements The monster's last action was a successful Strike that lists Push in its damage entry\n---\nEffect The monster attempts to [[/act shove]] the creature.";
  assert.deepEqual(reqOf(PUSH), { any: [{ k: "strike", fx: "push" }] });
  assert.deepEqual(reqOf("The elemental tsunami can choose whether to push or pull.\n---\nPush 1\nRequirements The monster's last action was a successful Strike that lists Push in its damage entry\n---\nEffect x"), { any: [{ k: "strike", fx: "push" }] });
  assert.equal(reqOf("a\n---\nb\n---\nc\n---\nRequirements You have a free hand."), null);
});

test("clauseState: melee/ranged — тип Удара из штампа; штамп без типа не блокирует", () => {
  const c = (melee) => ({ turn: "t", act: { turn: "t", kind: "strike", hit: true, ...(melee !== undefined && { melee }) } });
  assert.equal(clauseState({ k: "strike", melee: true }, c(false)), false, "дальний Удар при требовании «melee Strike»");
  assert.equal(clauseState({ k: "strike", melee: true }, c(true)), true);
  assert.equal(clauseState({ k: "strike", melee: false }, c(true)), false);
  assert.equal(clauseState({ k: "strike", melee: true }, c(undefined)), true, "тип неизвестен — не блокируем");
});

// --- регрессии повторного замера ---
test("reqOf: Death Roll / Profane Feast / Grasp Power разбираются; «wielding … and has a free hand» — нет записи", () => {
  assert.deepEqual(reqOf("Requirements The crocodile must have a creature Grabbed\n---\nEffect x"), { any: [{ k: "holds" }] });
  assert.deepEqual(reqOf("Requirements The howling spawn has a creature Grabbed\n---\nEffect x"), { any: [{ k: "holds" }] });
  assert.deepEqual(reqOf("Requirements The spellscar fext's last action was a successful fist Strike\n---\nEffect x"), { any: [{ k: "strike", name: "fist" }] });
  assert.equal(reqOf("Requirements The assassin is wielding a piercing or slashing weapon and has a free hand.\n---\nEffect x"), null);
});

test("overlay: Death Roll, Profane Feast, Grasp Power есть и в bySource", { skip: !existsSync(new URL("../rules/use-limits.json", import.meta.url)) }, () => {
  const lim = JSON.parse(readFileSync(new URL("../rules/use-limits.json", import.meta.url), "utf8"));
  const uuids = Object.keys(lim.bySource);
  assert.ok(uuids.length >= 200, String(uuids.length));
});

test("M1: «(Greater Barghest) Mutation - Toxic Breath» — метка Toxic Breath своя", () => {
  assert.deepEqual(rechargeIds("Toxic Breath", ["(Greater Barghest) Mutation - Toxic Breath"], "s", []), ["s"]);
  assert.deepEqual(rechargeIds("Breath", ["(Greater Barghest) Mutation - Toxic Breath"], "s", []), [], "часть слова/фразы не по границе « - » не считается");
});

const ITEMS_JSON = new URL("../tools/out/items.json", import.meta.url);
test("M1 на уровне механизма (rechargeEntry на актёре): Voidglutton — Feed on Fear блокирует Consume Light; Tarn Linnorm — обе способности", { skip: !existsSync(ITEMS_JSON) }, async () => {
  const { rechargeEntry } = await import("../scripts/mech.mjs");
  const all = JSON.parse(readFileSync(ITEMS_JSON, "utf8")).items;
  const actorOf = (name) => {
    const actor = { items: [] };
    for (const i of all.filter((x) => x.embedded?.actor === name && x.type === "action")) actor.items.push({ id: i.name, type: "action", name: i.name, slug: i.slug, actor, system: { description: { value: i.descEn } } });
    return actor;
  };
  const vg = actorOf("Voidglutton"), pick = (a, n) => a.items.find((i) => i.name === n);
  assert.ok(pick(vg, "Feed on Fear") && pick(vg, "Consume Light"));
  assert.deepEqual(rechargeEntry(pick(vg, "Feed on Fear")), { dice: "1d4", ids: ["Consume Light"] });
  const tl = actorOf("Tarn Linnorm");
  assert.deepEqual(rechargeEntry(pick(tl, "Corrosive Breath")).ids.sort(), ["Corrosive Breath", "Double Breath"]);
  assert.deepEqual(rechargeEntry(pick(tl, "Double Breath")).ids.sort(), ["Corrosive Breath", "Double Breath"]);
});

test("reqOf: уточнения Удара — «with the X», «that hit», «hit with a X Strike during its most recent action»; отрицание и несовпадение — null", () => {
  assert.equal(reqOf("Requirements Your last action this turn was a successful Strike with the Noble Branch"), null, "икона/предмет — не имя Удара: штамп хранит slug оружия, запись дала бы ложный блок");
  assert.deepEqual(reqOf("Requirements The drill sergeant's last action was a Strike that hit"), { any: [{ k: "strike" }] });
  assert.deepEqual(reqOf("Requirements The fighter's last action was a Strike that hit an opponent"), { any: [{ k: "strike" }] });
  assert.deepEqual(reqOf("Requirements The kadamel hit with a stone axe Strike during its most recent action"), { any: [{ k: "strike", name: "stone-axe" }] });
  assert.deepEqual(reqOf("Requirements The etheroot's last action was a success with a Strike using its stalked bite."), { any: [{ k: "strike", name: "stalked-bite" }] });
  assert.equal(reqOf("Requirements Fayati's last attack was a successful melee Strike with her rapier"), null, "«attack» — не «action»: между Ударом и использованием мог встать другой штамп");
  assert.equal(reqOf("Requirements The graveknight's last action was a success with a Strike using a shove weapon."), null, "тип оружия — не имя Удара");
  assert.equal(reqOf("Requirements The thrall's last action was a greatclub Strike that missed"), null);
  assert.equal(reqOf("Requirements The olobigonde doesn't have a creature @UUID[Compendium.pf2e.conditionitems.Item.kWc1fhmv9LBiTuei]{Grabbed}"), null, "отрицание не превращается в «держит»");
});

test("reqOf: Requirements приоритетнее Trigger, даже если Trigger стоит выше; Trigger — только без Requirements", () => {
  assert.deepEqual(reqOf("Trigger A creature leaves a square\nRequirements You have a free hand\n---\nEffect x"), { any: [{ k: "hand" }] });
  assert.equal(reqOf("Trigger You have a free hand\nRequirements You are wielding a staff\n---\nEffect x"), null);
});
