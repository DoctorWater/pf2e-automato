import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { reasonOf, turnKey, LIMITS } = await import("../scripts/builtin/impulse-gate.mjs");

const base = { traits: [], aura: true, auraEffect: true, kinetic: true, actorType: "character" };

test("hex: второй наговор за тот же ход — блок; другой ход и вне боя — нет; первый отмечается", () => {
  const c = { ...base, traits: ["hex", "witch"], turn: "c:1:0" };
  assert.equal(reasonOf({ ...c, hexTurn: "c:1:0" }), "hex");
  assert.equal(reasonOf({ ...c, hexTurn: "c:1:3" }), null);
  assert.equal(reasonOf({ ...c, hexTurn: undefined }), null);
  assert.equal(reasonOf({ ...c, turn: null, hexTurn: "c:1:0" }), null);
  assert.deepEqual(LIMITS.find((l) => l.reason === "hex").mark(c), ["hexTurn", "c:1:0"]);
  assert.ok(!LIMITS.find((l) => l.reason === "hex").mark({ ...c, turn: null }));
});

test("turnKey: ход любого участника, только начатый бой", () => {
  assert.equal(turnKey({ started: true, id: "c", round: 2, turn: 3 }), "c:2:3");
  assert.equal(turnKey({ started: false, id: "c", round: 0, turn: 0 }), null);
  assert.equal(turnKey(null), null);
});

test("Проведение стихийной энергии: блок при активной ауре, без ауры — можно; карточка-ожидание ауры (aura) не мешает", () => {
  const c = { ...base, slug: "channel-elements" };
  assert.equal(reasonOf({ ...c, auraEffect: true }), "auraActive");
  assert.equal(reasonOf({ ...c, auraEffect: false, aura: true }), null);
});

test("реакция с листа: вторая за раунд — блок; персонаж — да, NPC — нет; флаг ставится только в бою", () => {
  const c = { ...base, reaction: true, round: "c:1", inCombat: true, reactionFlag: { combat: "c", round: 1 } };
  assert.equal(reasonOf({ ...c, reactionSpent: true }), "reaction");
  assert.equal(reasonOf({ ...c, reactionSpent: false }), null);
  assert.equal(reasonOf({ ...c, reactionSpent: true, actorType: "npc" }), null);
  assert.equal(reasonOf({ ...c, reactionSpent: true, reaction: false }), null);
  const mark = LIMITS.find((l) => l.reason === "reaction").mark;
  assert.deepEqual(mark(c), ["reactionSpent", { combat: "c", round: 1 }]);
  assert.ok(!mark({ ...c, round: null, inCombat: false }));
});

test("импульс: нет свободной руки — блок; kinetic:false (нет Channel Elements) — строки импульса молчат", () => {
  const imp = { ...base, traits: ["impulse", "fire"], handsFree: 0 };
  assert.equal(reasonOf(imp), "noHand");
  assert.equal(reasonOf({ ...imp, handsFree: 1 }), null);
  assert.equal(reasonOf({ ...imp, handsFree: undefined }), null);   // данных нет — не блокируем
  assert.equal(reasonOf({ ...imp, kinetic: false }), null);
  assert.equal(reasonOf({ ...imp, aura: false }), "noAura");   // аура раньше руки
});

test("наговор-реакция: и hex, и reaction — первым срабатывает hex, потом reaction", () => {
  const c = { ...base, traits: ["hex"], reaction: true, turn: "c:1:0", round: "c:1", hexTurn: "c:1:0", reactionSpent: true };
  assert.equal(reasonOf(c), "hex");
  assert.equal(reasonOf({ ...c, hexTurn: null }), "reaction");
});

// --- preCreate / пропуски / откат отметок ---
const { preCreate, onCreate, unchecked, staleMarks, onDelete, grantPass } = await import("../scripts/builtin/impulse-gate.mjs");
const { MOD } = await import("../scripts/util.mjs");

function world(altHeld = false) {
  const updates = [];
  const actor = {
    uuid: "A.1", type: "character", flags: {}, itemTypes: { action: [], effect: [] }, abilities: { con: { mod: 0 } }, system: {},
    update: async (u) => { updates.push(u); }
  };
  globalThis.game = {
    user: { id: "u", isActiveGM: true }, messages: { contents: [] }, settings: { get: () => "on" },
    keyboard: { isModifierActive: () => altHeld }, i18n: { localize: (k) => k, format: (k) => k },
    combats: [{ id: "c", started: true, active: true, scene: {}, round: 1, turn: 0, combatants: [{ actor: { uuid: "A.1" } }, { actor: { uuid: "A.2" } }] }]
  };
  globalThis.ui = { notifications: { warn() {} } };
  return { actor, updates };
}
const msg = (actor, item, rollOptions = ["origin:action:slug:cast-a-spell"]) => {
  const m = { actor, item, flags: { pf2e: { context: { type: "spell-cast" }, origin: { rollOptions } } }, updateSource(ch) { m.upd = ch; } };
  return m;
};
const hexSpell = { type: "spell", slug: "evil-eye", uuid: "I.1", name: "Evil Eye", system: { traits: { value: ["hex"] } } };

test("preCreate: карточка заклинания без сотворения (нет cast-a-spell) — не блок и не отметка", () => {
  const { actor, updates } = world();
  actor.flags[MOD] = { hexTurn: "c:1:0" };
  assert.equal(preCreate(msg(actor, hexSpell, []), {}, {}, "u"), undefined);
  assert.equal(updates.length, 0);
});

test("preCreate: второй наговор в ход — блок; первый — отметка на сообщении, на актёра пишет onCreate; пропуск wrapCast снимает повторный блок один раз", async () => {
  const { actor, updates } = world();
  const m = msg(actor, hexSpell);
  assert.equal(preCreate(m, {}, {}, "u"), undefined);
  assert.equal(updates.length, 0);   // отметка пишется не в preCreate, а когда карточка создана
  assert.deepEqual(m.upd[`flags.${MOD}.limitMarks`], { hexTurn: "c:1:0" });
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), false);   // быстрый повтор до записи: ожидающая отметка уже блокирует
  await onCreate({ ...m, isAuthor: true, flags: { [MOD]: { limitMarks: { hexTurn: "c:1:0" } } } });
  assert.deepEqual(updates, [{ [`flags.${MOD}.hexTurn`]: "c:1:0" }]);
  actor.flags[MOD] = { hexTurn: "c:1:0" };
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), false);
  grantPass(actor, hexSpell);   // отпущенный Alt в wrapCast
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), undefined);
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), false);   // разовый
});

test("unchecked: пропуск только для своего актёра и предмета", async () => {
  const { actor } = world();
  actor.flags[MOD] = { hexTurn: "c:1:0" };
  const other = { ...actor, uuid: "A.2", flags: { [MOD]: { hexTurn: "c:1:0" } } };
  await unchecked(actor, hexSpell, async () => {
    assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), undefined);
    assert.equal(preCreate(msg(other, hexSpell), {}, {}, "u"), false);
  });
  assert.equal(preCreate(msg(actor, hexSpell), {}, {}, "u"), false);
});

test("откат отметок: удаление карточки возвращает флаг, только если он тот же", async () => {
  assert.deepEqual(staleMarks({ hexTurn: "c:1:0", reactionSpent: { combat: "c", round: 1 } }, { hexTurn: "c:1:0", reactionSpent: { combat: "c", round: 2 } }), ["hexTurn"]);
  const { actor, updates } = world();
  actor.flags[MOD] = { hexTurn: "c:1:0" };
  await onDelete({ actor, flags: { [MOD]: { limitMarks: { hexTurn: "c:1:0" } } } });
  assert.deepEqual(updates, [{ [`flags.${MOD}.-=hexTurn`]: null }]);
  updates.length = 0;
  actor.flags[MOD] = { hexTurn: "c:2:0" };
  await onDelete({ actor, flags: { [MOD]: { limitMarks: { hexTurn: "c:1:0" } } } });
  assert.equal(updates.length, 0);
});

test("крит-Удар у владельца «Draconic Momentum» снимает перезарядку Дыхания; откат карточки возвращает; удаление карточки удаляет шёпот перезарядки", async () => {
  const { actor, updates } = world();
  const breath = { id: "b1", type: "action", slug: "breath-weapon", name: "Breath Weapon", system: { traits: { value: ["breath"] }, description: { value: "" } } };
  const other = { id: "o1", type: "action", slug: "tail-slap", name: "Tail Slap", system: { traits: { value: [] }, description: { value: "" } } };
  const momentum = { id: "m1", type: "action", slug: "draconic-momentum", name: "Draconic Momentum", system: { traits: { value: [] }, description: { value: "" } } };
  actor.items = [breath, other, momentum];
  const lock = { c: "c", until: 5 };
  actor.flags[MOD] = { rc_b1: lock, rc_o1: { c: "c", until: 6 } };
  const strike = (outcome) => { const m = { actor, item: { type: "melee", slug: "jaws", name: "Jaws", system: {} }, flags: { pf2e: { context: { type: "attack-roll", outcome } } }, updateSource(ch) { Object.assign(m.upd ??= {}, ch); } }; return m; };
  const plain = strike("success"); preCreate(plain, {}, {}, "u");
  assert.equal(plain.upd?.[`flags.${MOD}.limitClear`], undefined, "не крит — замок цел");
  const crit = strike("criticalSuccess"); preCreate(crit, {}, {}, "u");
  assert.deepEqual(crit.upd[`flags.${MOD}.limitClear`], { rc_b1: lock }, "только Дыхание, не другой rc_");
  await onCreate({ actor, isAuthor: true, flags: { [MOD]: { limitClear: { rc_b1: lock } } } });
  assert.deepEqual(updates.pop(), { [`flags.${MOD}.-=rc_b1`]: null });
  actor.flags[MOD] = { rc_o1: { c: "c", until: 6 } };
  await onDelete({ actor, id: "card", flags: { [MOD]: { limitClear: { rc_b1: lock } } } });
  assert.deepEqual(updates.pop(), { [`flags.${MOD}.rc_b1`]: lock }, "откат карточки возвращает замок");
  actor.items = [breath, other];   // без способности крит ничего не снимает
  const crit2 = strike("criticalSuccess"); preCreate(crit2, {}, {}, "u");
  assert.equal(crit2.upd?.[`flags.${MOD}.limitClear`], undefined);
  // шёпот «снова доступно с раунда N» уходит вместе с карточкой
  const deleted = [];
  globalThis.ChatMessage = { deleteDocuments: async (ids) => { deleted.push(...ids); } };
  game.messages.contents = [{ id: "w1", flags: { [MOD]: { rechargeFor: "card" } } }, { id: "w2", flags: { [MOD]: { rechargeFor: "other" } } }];
  actor.flags[MOD] = { rc_b1: lock };
  await onDelete({ actor, id: "card", flags: { [MOD]: { limitMarks: { rc_b1: lock } } } });
  assert.deepEqual(deleted, ["w1"]);
});

// --- перезарядка (M1) и требования (M2) ---
const { initOverlays } = await import("../scripts/rules.mjs");
const base2 = { ...base, inCombat: true, limitsOn: true, combatId: "c", roundNum: 2, itemId: "i1", rc: { dice: "1d4" }, rcMark: { c: "c", until: 5, n: 3, dice: "1d4", r: [3], mod: 0 } };

test("recharge: блок до раунда until, не после; другой бой, вне боя, mode.limits=off — нет блока; отметка — rc_<id> с числом", () => {
  const row = LIMITS.find((l) => l.reason === "recharge");
  assert.equal(reasonOf({ ...base2, rcLock: { c: "c", until: 5 } }), "recharge");
  assert.equal(reasonOf({ ...base2, rcLock: { c: "c", until: 5 }, roundNum: 5 }), null);
  assert.equal(reasonOf({ ...base2, rcLock: { c: "old", until: 9 } }), null);
  assert.equal(reasonOf({ ...base2, rcLock: { c: "c", until: 5 }, inCombat: false }), null);
  assert.equal(reasonOf({ ...base2, rcLock: { c: "c", until: 5 }, limitsOn: false }), null);
  assert.equal(reasonOf({ ...base2, rc: null, rcLock: { c: "c", until: 5 } }), null);
  assert.deepEqual(row.vars({ ...base2, rcLock: { c: "c", until: 5 } }), { n: 3, until: 5 });
  assert.deepEqual(row.mark(base2), ["rc_i1", base2.rcMark]);
  assert.ok(!row.applies({ ...base2, limitsOn: false }), "off — не бросаем и не ставим");
});

const breath = { type: "action", slug: "breath-weapon", uuid: "I.b", id: "b1", name: "Breath Weapon", system: { traits: { value: [] }, actionType: { value: "action" }, description: { value: "can't use Breath Weapon again for [[/gmr 1d4 #Recharge Breath Weapon]]{1d4 rounds}." } } };
const useMsg = (actor, item, extra = {}) => {
  const m = { actor, item, flags: { pf2e: { context: { type: "self-effect" } } }, ...extra, updateSource(ch) { m.upd = { ...m.upd, ...ch }; } };
  return m;
};

test("preCreate: перезарядка — число на флаге от CONFIG.Dice.randomUniform, повтор блокируется, Alt пускает, две копии независимы, off не бросает", () => {
  globalThis.CONFIG = { Dice: { randomUniform: () => 0.99 } };
  const { actor } = world();
  const copy = { ...actor, uuid: "A.2", flags: {} };
  const m = useMsg(actor, breath);
  assert.equal(preCreate(m, {}, {}, "u"), undefined);
  assert.deepEqual(m.upd[`flags.${MOD}.limitMarks`], { rc_b1: { c: "c", until: 5, n: 4, dice: "1d4", r: [4], mod: 0 } });   // раунд 1 + 4
  assert.equal(preCreate(useMsg(actor, breath), {}, {}, "u"), false, "тот же автор в тот же раунд");
  assert.equal(preCreate(useMsg(copy, breath), {}, {}, "u"), undefined, "несвязанная копия — свой замок");
  const alt = world(true).actor;
  assert.equal(preCreate(useMsg(alt, breath), {}, {}, "u"), undefined);
  const off = world().actor;
  game.settings.get = () => "off";
  const mo = useMsg(off, breath);
  assert.equal(preCreate(mo, {}, {}, "u"), undefined);
  assert.ok(!mo.upd?.[`flags.${MOD}.limitMarks`], "mode.limits=off: ни броска, ни rc_*");
  delete globalThis.CONFIG;
});

test("recharge: замок снимается по истечении раундов (раунд >= until)", () => {
  const { actor } = world();
  actor.uuid = "A.9"; game.combats[0].combatants.push({ actor: { uuid: "A.9" } });   // pending (5 с) общий на файл по uuid актёра — чужие отметки предыдущих тестов не должны подмешиваться
  actor.flags[MOD] = { rc_b1: { c: "c", until: 2 } };
  assert.equal(preCreate(useMsg(actor, breath), {}, {}, "u"), false, "раунд 1 < 2");
  game.combats[0].round = 2;
  assert.equal(preCreate(useMsg(actor, breath), {}, {}, "u"), undefined, "раунд 2 >= 2");
});

const clawStrike = (actor, outcome, o = {}) => ({ actor, item: { type: "melee", slug: "claw", name: "claw", system: { attackEffects: { value: ["grab"] } }, ...o }, flags: { pf2e: { context: { type: "attack-roll", outcome } } }, updateSource(ch) { this.upd = { ...this.upd, ...ch }; } });
const grabItem = { type: "action", slug: "grab", uuid: "I.g", id: "g1", name: "Grab", _stats: { compendiumSource: "Compendium.pf2e.test.Item.GRAB" }, system: { traits: { value: [] }, actionType: { value: "action" } } };

test("Grab: Удар попал / промах / без цели; держит существо; копии не путаются; штамп только свободным не-пассивным действием", () => {
  initOverlays(null, null, null, { v: 1, bySource: { "Compendium.pf2e.test.Item.GRAB": { any: [{ k: "strike", fx: "grab" }, { k: "holds" }] } } });
  const stampOf = (m) => m.upd?.[`flags.${MOD}.act`];
  const run = (outcome, who = "A.1") => {
    const w = world(), a = who === "A.1" ? w.actor : { ...w.actor, uuid: who };
    const s = clawStrike(a, outcome);
    preCreate(s, {}, {}, "u");
    game.messages.contents = [{ flags: { [MOD]: { act: stampOf(s) } } }];
    return { a, s, res: preCreate(useMsg(a, grabItem), {}, {}, "u") };
  };
  let r = run("success");
  assert.deepEqual(stampOf(r.s), { who: "A.1", turn: "c:1:0", kind: "strike", hit: true, fx: ["grab"], slug: "claw" });
  assert.equal(r.res, undefined, "после попадания");
  assert.equal(run("failure").res, false, "после промаха");
  assert.equal(run(null).res, undefined, "Удар без цели: outcome null — блока нет");
  assert.equal(stampOf(run(null).s).hit, null);
  // Grab без Удара: последний штамп — использование другого действия
  const w = world();
  game.messages.contents = [{ flags: { [MOD]: { act: { who: "A.1", turn: "c:1:0", kind: "use" } } } }];
  assert.equal(preCreate(useMsg(w.actor, grabItem), {}, {}, "u"), false, "прошлое действие — не Удар");
  // при держащем: состояние grabbed у другого актёра, выданное этим автором (или без автора)
  const held = (origin) => ({ slug: "grabbed", system: { context: { origin: { actor: origin } } } });
  const prey = (origin) => ({ uuid: "P.1", itemTypes: { condition: [held(origin)] } });
  const withPrey = (origin) => { const a = world().actor; game.messages.contents = [{ flags: { [MOD]: { act: { who: "A.1", turn: "c:1:0", kind: "use" } } } }]; a.getActiveTokens = () => [{ document: { parent: { tokens: [{ actor: prey(origin) }] } } }]; return a; };
  assert.equal(preCreate(useMsg(withPrey("A.1"), grabItem), {}, {}, "u"), undefined, "держит");
  assert.equal(preCreate(useMsg(withPrey("P.1"), grabItem), {}, {}, "u"), undefined, "модуль пишет origin = получатель");
  assert.equal(preCreate(useMsg(withPrey("A.3"), grabItem), {}, {}, "u"), false, "держит третий актёр");
  // несвязанная копия: промах у A.1 не блокирует A.2, у которого журнала нет
  const copyRun = run("failure", "A.2");
  assert.equal(copyRun.res, false);
  game.messages.contents = [{ flags: { [MOD]: { act: { who: "A.1", turn: "c:1:0", kind: "strike", hit: false, fx: ["grab"] } } } }];
  assert.equal(preCreate(useMsg({ ...world().actor, uuid: "A.2" }, grabItem), {}, {}, "u"), undefined, "у копии своего журнала нет — неизвестно, пропуск");
  // свободные действия, реакции и пассивки не штампуются; атака заклинанием — как использование
  const free = useMsg(world().actor, { ...breath, slug: "x", system: { ...breath.system, actionType: { value: "free" }, description: { value: "" } } });
  preCreate(free, {}, {}, "u");
  assert.equal(stampOf(free), undefined);
  const sp = clawStrike(world().actor, "success");
  sp.flags.pf2e.context.type = "spell-attack-roll";
  preCreate(sp, {}, {}, "u");
  assert.equal(stampOf(sp).kind, "use");
  initOverlays(null, null, null, null);
});
