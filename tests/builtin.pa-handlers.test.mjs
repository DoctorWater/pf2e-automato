// 0.5e: встроенные обработчики под группы pf2e-automations — удушье, эффекты попавшего Удара, ярость, добыча NPC, чередование энергии. Чистая логика, без Foundry.
import { test } from "node:test";
import assert from "node:assert/strict";

const calls = { actions: [], whispers: [] };
globalThis.game = {
  user: { isActiveGM: true }, users: [], modules: { get: () => null },
  settings: { get: () => true },
  i18n: { localize: (k) => k, format: (k) => k },
  pf2e: { actions: { get: (a) => ({ use: async (o) => { calls.actions.push([a, o.actors[0].name, o.target ?? null]); } }) } }
};
globalThis.ChatMessage = { create: async (d) => { calls.whispers.push(d); }, getSpeaker: () => ({}) };
globalThis.fromUuid = async (u) => ({ uuid: u, name: "Цель", object: { id: "canvas-token" } });

const suf = await import("../scripts/builtin/suffocation.mjs");
const strike = await import("../scripts/builtin/strike-effects.mjs");
const rage = await import("../scripts/builtin/rage.mjs");
const prey = await import("../scripts/builtin/hunt-prey.mjs");
const wave = await import("../scripts/builtin/oscillating-wave.mjs");
const { BUILTIN_HANDLERS, translateItem, subpackOf } = await import("../tools/pa-port.mjs");

test("удушье: воздух кончился — удаление «Оставшегося воздуха» со счётчиком 1, пока хозяин на актёре (форма данных pf2e)", () => {
  const air = (value, host = "H1") => ({ slug: "effect-remaining-air", system: { badge: { type: "counter", value, min: null } }, flags: { pf2e: { grantedBy: host ? { id: host } : undefined } } });
  const has = (...ids) => (id) => ids.includes(id);
  assert.equal(suf.airRanOut(air(1), has("H1")), true);       // pf2e удалил эффект при попытке опустить счётчик ниже min ?? 1
  assert.equal(suf.airRanOut(air(1), has()), false);          // хозяин удалён вместе с ним — Освобождение
  assert.equal(suf.airRanOut(air(1, null), has()), true);     // выдан вручную, без хозяина
  assert.equal(suf.airRanOut(air(5), has("H1")), false);      // удалён с запасом воздуха
  assert.equal(suf.airRanOut({ ...air(1), slug: "effect-rage" }, has("H1")), false);
  assert.equal(suf.airRanOut(null, has()), false);
});

test("удушье: СЛ 20 + 5 за каждую прошлую проверку; крит. провал — смерть, провал — n d10, успех — ничего", () => {
  assert.deepEqual([1, 2, 3, 4].map(suf.suffocationDC), [20, 25, 30, 35]);
  assert.deepEqual(suf.suffocationOutcome(0, 3), { dead: true });
  assert.deepEqual(suf.suffocationOutcome(1, 3), { dice: 3 });
  assert.deepEqual(suf.suffocationOutcome(2, 3), {});
  assert.deepEqual(suf.suffocationOutcome(3, 3), {});
});

test("эффекты Удара: промах — ничего; улучшенное вытесняет обычное; по одному действию", () => {
  assert.deepEqual(strike.followUps(["grab"], 1), []);
  assert.deepEqual(strike.followUps(["grab"], 2).map((f) => [f.effect, f.action, f.free]), [["grab", "grapple", false]]);
  assert.deepEqual(strike.followUps(["grab", "improved-grab"], 3).map((f) => [f.effect, f.free]), [["improved-grab", true]]);
  assert.deepEqual(strike.followUps(["improved-grab", "grab"], 2).map((f) => [f.effect, f.free]), [["improved-grab", true]]);
  assert.deepEqual(strike.followUps(["knockdown", "push", "ghoul-paralysis"], 2).map((f) => [f.action, f.free]), [["trip", false], ["shove", false]]);
  assert.deepEqual(strike.followUps(["improved-knockdown", "improved-push"], 2).map((f) => [f.action, f.free]), [["trip", true], ["shove", true]]);
  assert.deepEqual(strike.followUps(undefined, 3), []);
});

test("эффекты Удара: варианты с расстоянием и «или притянуть» — те же; свои способности — по [[/act …]] в тексте; не attackEffect — ничего", () => {
  const info = (e, own) => strike.effectInfo(e, own);
  assert.deepEqual(info("push-20-feet"), { action: "shove", free: false, pa: "push" });
  assert.deepEqual(info("push-or-pull-10-feet"), { action: "shove", free: false, pa: "push" });
  assert.deepEqual(info("improved-push-20-feet"), { action: "shove", free: true, pa: "push" });
  assert.deepEqual(info("trip"), { action: "trip", free: false, pa: null });
  assert.equal(info("grapple"), null);        // не attackEffect pf2e
  assert.equal(info("constrict"), null);
  assert.equal(info("pull"), null);
  assert.equal(info("tongue-grab"), null);    // нет способности у актёра
  const own = (t) => () => t;
  assert.equal(info("throat-grab", own("it can attempt to [[/act grapple]] the target"))?.action, "grapple");
  assert.equal(info("tongue-grab", own("the creature becomes Grabbed")), null);   // свой хват без Захвата — не наше
});

const hit = (effects, degree = 2) => ({
  flags: { pf2e: { context: { type: "attack-roll", outcome: ["criticalFailure", "failure", "success", "criticalSuccess"][degree], target: { token: "Scene.s.Token.t" } } } },
  rolls: [{ degreeOfSuccess: degree }], actor: { name: "Тварь", uuid: "Actor.a" }, item: { type: "melee", name: "Челюсти", system: { attackEffects: { value: effects } } }
});

test("эффекты Удара: улучшенный захват проводится сам по цели Удара, обычный — шёпот с кнопкой, а не бросок", async () => {
  calls.actions.length = 0; calls.whispers.length = 0;
  await strike.onMessage(hit(["improved-grab"]));
  assert.deepEqual(calls.actions, [["grapple", "Тварь", { id: "canvas-token" }]]);
  assert.equal(calls.whispers.length, 0);
  calls.actions.length = 0;
  await strike.onMessage(hit(["grab"]));
  assert.equal(calls.actions.length, 0);
  assert.equal(calls.whispers.length, 1);
  assert.match(calls.whispers[0].content, /data-af-follow/);
  assert.equal(calls.whispers[0].flags["pf2e-automato"].strike.action, "grapple");
});

test("эффекты Удара: промах, перебросок, не Удар NPC и Удар без цели — ничего", async () => {
  calls.actions.length = 0; calls.whispers.length = 0;
  await strike.onMessage(hit(["improved-grab"], 1));
  await strike.onMessage({ ...hit(["improved-grab"]), flags: { pf2e: { context: { type: "attack-roll", isReroll: true, outcome: "success", target: { token: "T" } } } } });
  await strike.onMessage({ ...hit(["improved-grab"]), item: { type: "weapon", system: {} } });
  await strike.onMessage({ ...hit(["improved-grab"]), flags: { pf2e: { context: { type: "attack-roll", outcome: "success" } } } });
  assert.equal(calls.actions.length + calls.whispers.length, 0);
});

test("ярость: признак — эффект effect-rage", () => {
  assert.equal(rage.isRage({ type: "effect", slug: "effect-rage" }), true);
  assert.equal(rage.isRage({ type: "effect", slug: "effect-rage-temporary-hit-points-immunity" }), false);
  assert.equal(rage.isRage({ type: "action", slug: "effect-rage" }), false);
  assert.equal(rage.isRage(null), false);
});

test("ярость: требования, Вспыльчивость, концентрация", () => {
  assert.equal(rage.blockedBy({ raging: true, fatigued: true }), "raging");
  assert.equal(rage.blockedBy({ raging: false, fatigued: true }), "fatigued");
  assert.equal(rage.blockedBy({ raging: false, fatigued: false }), null);
  assert.equal(rage.quickTempered({ encumbered: false, heavy: false }), true);
  assert.equal(rage.quickTempered({ encumbered: true, heavy: false }), false);
  assert.equal(rage.quickTempered({ encumbered: false, heavy: true, invulnerable: false }), false);
  assert.equal(rage.quickTempered({ encumbered: false, heavy: true, invulnerable: true }), true);
  const br = (traits, slug, type) => rage.breaksRage({ type, traits, slug });
  assert.equal(br(["concentrate", "manipulate"], "fear", "spell-cast"), true);
  assert.equal(br(["auditory", "concentrate", "emotion", "mental"], "demoralize", "skill-check"), true);
  assert.equal(br(["concentrate", "secret"], "seek", "perception-check"), false);    // Поиск разрешён
  assert.equal(br(["concentrate", "rage"], "x", undefined), false);                  // есть «ярость»
  assert.equal(br(["concentrate", "emotion"], "rage", "self-effect"), false);         // сама Ярость — требования
  assert.equal(br(["concentrate"], "x", "damage-roll"), false);                       // бросок, не использование
  assert.equal(br(["attack"], "strike", undefined), false);
});

test("добыча NPC: переключатель на способности без selfEffect; у PC (selfEffect) и без переключателя — нет", () => {
  const rules = (o, extra = {}) => [{ key: "RollOption", option: o, toggleable: true, ...extra }];
  assert.equal(prey.preyToggle({ type: "action", system: { rules: rules("hunted-prey") } }), "hunted-prey");
  assert.equal(prey.preyToggle({ type: "action", system: { rules: rules("hunt-prey") } }), "hunt-prey");
  assert.equal(prey.preyToggle({ type: "action", system: { selfEffect: { uuid: "x" }, rules: rules("hunted-prey") } }), null);
  assert.equal(prey.preyToggle({ type: "action", system: { rules: rules("hunted-prey", { toggleable: false }) } }), null);
  assert.equal(prey.preyToggle({ type: "feat", system: { rules: rules("hunted-prey") } }), null);
  assert.equal(prey.preyToggle({ type: "action", system: { rules: rules("first-attack") } }), null);
  assert.deepEqual(prey.markRules([{ key: "TokenMark", slug: "hunted-prey" }, { key: "Other" }], "Scene.s.Token.t"), [{ key: "TokenMark", slug: "hunted-prey", uuid: "Scene.s.Token.t" }, { key: "Other" }]);
});

test("добыча: две цели у «Двойной добычи» и у NPC с «one or two»", () => {
  assert.equal(prey.maxPrey({}, "<p>designates a single creature</p>"), 1);
  assert.equal(prey.maxPrey({ "feat:double-prey": true }, ""), 2);
  assert.equal(prey.maxPrey({}, "<p>designates one or two targets he can see</p>"), 2);
});

test("Колебание волны: одно переключение на сотворение (по карточке сотворения того же предмета)", () => {
  const m = (id, uuid, ctx) => ({ id, flags: { pf2e: { origin: { uuid }, ...(ctx && { context: { type: ctx } }) } } });
  const msgs = [m("c1", "S1", "spell-cast"), m("a1", "S1", "attack-roll"), m("d1", "S1", "damage-roll"), m("c2", "S1", "spell-cast"), m("d2", "S1", "damage-roll"), m("x", "S2", "damage-roll")];
  assert.equal(wave.castKey(msgs, msgs[2]), "c1");
  assert.equal(wave.castKey(msgs, msgs[4]), "c2");
  assert.equal(wave.castKey(msgs, msgs[5]), "x");   // карточки сотворения нет — урон сам по себе
});

test("Колебание волны: огонь <-> холод; набор заклинаний берётся из DamageAlteration черты, а не списком имён", () => {
  assert.equal(wave.flip("fire"), "cold");
  assert.equal(wave.flip("cold"), "fire");
  assert.equal(wave.flip(undefined), null);
  const rules = [
    { key: "RollOption", option: "conservation-of-energy", toggleable: true },
    { key: "DamageAlteration", predicate: [{ or: ["item:slug:fireball", "item:slug:frostbite"] }], property: "damage-type", value: "{item|flags.system.rulesSelections.conservationOfEnergy}" },
    { key: "DamageAlteration", predicate: ["item:slug:other"], property: "dice-number", value: 2 }
  ];
  assert.deepEqual([...wave.affectedSlugs(rules)].sort(), ["fireball", "frostbite"]);
  assert.equal(wave.waveFeat({ items: [{ system: { rules: [] } }, { id: "w", system: { rules } }] }).id, "w");
  assert.equal(wave.waveFeat({ items: [] }), null);
  // урон брошен с «fire» и это ещё текущее значение — меняем; значение уже сменили — нет
  assert.equal(wave.stateOf(["x", "conservation-of-energy:fire"], { "conservation-of-energy:fire": true }), "fire");
  assert.equal(wave.stateOf(["conservation-of-energy:fire"], { "conservation-of-energy:cold": true }), null);
  assert.equal(wave.stateOf(["x"], {}), null);
});

test("pa-port: обработчики 0.5e закрыты встроенными; остальные правила группы переводятся, как обычно", () => {
  for (const h of Object.keys(BUILTIN_HANDLERS)) assert.equal(subpackOf([`handler:${h}`]), "0.5e", h);
  const item = { uuid: "Compendium.x.Item.1", slug: "swallow-whole", type: "action", name: "Swallow Whole", actionType: "action", embedded: false };
  const grp = { rules: [{ type: "handler", triggerType: "end-turn", value: "suffocatingEndTurn", target: "none", predicate: ["self:effect:suffocating"] }] };
  const ctx = { effects: {}, catalog: { bySlug: new Map() } };
  const r = translateItem(item, "", grp, ctx);
  assert.deepEqual([r.builtin, r.reason, r.rule], [true, "builtin:suffocation", null]);
  const mixed = translateItem(item, "", { rules: [...grp.rules, { type: "handler", triggerType: "x", value: "unconvertedTestHandler", target: "none", predicate: [] }] }, ctx);
  assert.equal(mixed.builtin, undefined);
  assert.match(mixed.reason, /handler:unconvertedTestHandler/);   // чужой обработчик остаётся долгом, наш — снят
  assert.doesNotMatch(mixed.reason, /suffocatingEndTurn/);
});
