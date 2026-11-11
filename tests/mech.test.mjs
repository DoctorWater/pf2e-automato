import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { MOD } = await import("../scripts/util.mjs");
const mech = await import("../scripts/mech.mjs");
const { reasonOf, preCreate } = await import("../scripts/builtin/impulse-gate.mjs");
const { initOverlays, validateRule } = await import("../scripts/rules.mjs");
const { strikeLinkEntry, strikeLinkState, strikeLinked } = await import("../scripts/strike-link.mjs");
const { resetIndex } = await import("../scripts/compat.mjs");
const { pickManeuvers, maneuversOf } = await import("../scripts/builtin/maneuver.mjs");
const { permanentOf, PERMANENT } = await import("../scripts/builtin/neutralize-rules.mjs");

const flagged = (item, m) => ({ ...item, flags: { [MOD]: { mech: m } } });

/* ---------- флаг и форма ---------- */

test("normalizeMech: допустимое остаётся, мусор и неизвестные ключи отбрасываются", () => {
  assert.deepEqual(mech.normalizeMech({ recharge: false, req: false, strike: false, permanent: false, maneuvers: ["trip", "disarm"] }),
    { recharge: false, req: false, strike: false, permanent: false, maneuvers: ["disarm", "trip"] }, "манёвры в порядке таблицы");
  assert.deepEqual(mech.normalizeMech({ recharge: " 1D6 " }), { recharge: "1d6" });
  assert.deepEqual(mech.normalizeMech({ recharge: "1d4 + 1" }), { recharge: "1d4+1" });
  assert.deepEqual(mech.normalizeMech({ recharge: "1к6" }), { recharge: "1d6" }, "кириллическая «к» — как d");
  assert.deepEqual(mech.normalizeMech({ recharge: " 1К4 + 1" }), { recharge: "1d4+1" });
  for (const bad of [{ recharge: "abc" }, { recharge: "1ж6" }, { recharge: true }, { recharge: 5 }, { req: true }, { strike: "no" }, { permanent: 0 }, { maneuvers: [] }, { maneuvers: ["fly"] }, { maneuvers: "trip" }, { other: 1 }, [], "x", null, undefined]) {
    assert.deepEqual(mech.normalizeMech(bad), {}, JSON.stringify(bad));
  }
  assert.deepEqual(mech.normalizeMech({ maneuvers: ["fly", "trip"] }), { maneuvers: ["trip"] });
  assert.deepEqual(mech.mechOf({ flags: { [MOD]: { mech: { req: false } } } }), { req: false });
  assert.deepEqual(mech.mechOf({}), {});
});

test("форма: флаг -> форма -> флаг без потерь; значения из data-v приходят строками", () => {
  for (const m of [{}, { recharge: false }, { recharge: "1d4+1" }, { recharge: { on: "button", dice: "1d6" } }, { req: false, strike: false, permanent: false }, { maneuvers: ["shove", "trip"] }]) {
    const f = mech.mechToForm(m);
    assert.deepEqual(mech.formToMech(f), m, JSON.stringify(m));
    assert.deepEqual(mech.mechErrors(f), []);
  }
  const f = mech.mechToForm({});
  f.maneuvers.auto = "false"; f.maneuvers.list.trip = "true"; f.strike.off = "true";
  assert.deepEqual(mech.formToMech(f), { strike: false, maneuvers: ["trip"] });
});

test("итог формы без значений по умолчанию: «выбрать вручную → Авто», «1к6» при сохранённом «1d6», срок как в тексте — не правка", () => {
  const base = { dice: "1d4", maneuvers: ["disarm", "trip"] }, out = (f) => mech.formToMech(f, base);
  const dirty = (f, saved) => JSON.stringify(out(f)) !== JSON.stringify(mech.pruneMech(saved, base));
  const f = mech.mechToForm({});
  f.maneuvers.auto = false; f.maneuvers.list = { disarm: true, shove: false, reposition: false, trip: true };   // «Выбрать вручную» стартует с авто-списка
  assert.equal(dirty(f, {}), false, "ручной список = авто — правки нет");
  assert.deepEqual(out(f), {});
  f.maneuvers.list.shove = true;
  assert.equal(dirty(f, {}), true, "реальная правка списка");
  f.maneuvers.auto = true;
  assert.equal(dirty(f, {}), false, "обратно в Авто");
  const g = mech.mechToForm({ recharge: "1d6" });
  g.recharge.dice = "1к6";
  assert.equal(dirty(g, { recharge: "1d6" }), false, "«1к6» = сохранённое «1d6»");
  g.recharge.dice = "1d4";
  assert.deepEqual(out(g), {}, "срок как в тексте не пишется");
  assert.equal(dirty(g, { recharge: "1d6" }), true, "снятие своего срока — правка");
  assert.deepEqual(mech.formToMech(g), { recharge: "1d4" }, "без base — как раньше");
});

test("mechErrors: неверный срок и пустой выбор манёвров — ошибки; «1к6» — не ошибка; «не ограничивать» глушит ошибку срока", () => {
  const f = mech.mechToForm({});
  f.recharge.mode = "auto"; f.recharge.dice = "1к6";
  assert.deepEqual(mech.mechErrors(f), []);
  assert.deepEqual(mech.formToMech(f), { recharge: "1d6" });
  f.recharge.dice = "1ж6";
  assert.deepEqual(mech.mechErrors(f), ["workshop.mech.err.dice"]);
  f.recharge.mode = "off";
  assert.deepEqual(mech.mechErrors(f), []);
  f.recharge.mode = "button"; f.recharge.dice = "";
  assert.deepEqual(mech.mechErrors(f), ["workshop.mech.err.diceNeeded"], "срок обязателен, если из текста его нет");
  assert.deepEqual(mech.mechErrors(f, { dice: "1d4" }), [], "срок из текста есть");
  f.recharge.mode = "auto"; f.recharge.dice = "1d6";
  assert.deepEqual(mech.mechErrors(f), []);
  f.maneuvers.auto = false;
  assert.deepEqual(mech.mechErrors(f), ["workshop.mech.err.maneuvers"]);
  f.maneuvers.list.disarm = true;
  assert.deepEqual(mech.mechErrors(f), []);
});

/* ---------- сохранение: каждая часть только если менялась ---------- */

const RULE = `flags.${MOD}.rule`, MECH = `flags.${MOD}.mech`;
const norm = (p) => Object.keys(p).map((k) => k.replace(/\.-=|\.==/, "."));   // ForcedReplacement/Deletion вне Foundry — устаревшие `==`/`-=`

test("savePatch: без правки правила флаг rule не пишется (пустое onUse не перекрывает мир, каталог и разметку)", () => {
  const rule = { v: 1, kind: "onUse" };
  assert.deepEqual(norm(mech.savePatch({ ruleDirty: false, rule, mechDirty: true, mech: { req: false } })), [MECH], "только mech");
  assert.deepEqual(mech.savePatch({ ruleDirty: false, rule, mechDirty: false, mech: {} }), {}, "ничего не менялось — ничего не пишем");
  assert.deepEqual(norm(mech.savePatch({ ruleDirty: true, rule, areaPatch: { "system.area": { type: "burst", value: 20 } }, mechDirty: false, mech: {} })), [RULE, "system.area"], "правка правила не пишет mech");
  assert.deepEqual(norm(mech.savePatch({ ruleDirty: true, rule, mechDirty: true, mech: { strike: false } })), [RULE, MECH]);
});

test("savePatch: пустой mech удаляет флаг, непустой заменяет целиком", () => {
  assert.deepEqual(norm(mech.savePatch({ ruleDirty: false, mechDirty: true, mech: {} })), [MECH]);
  const del = mech.savePatch({ ruleDirty: false, mechDirty: true, mech: {} }), set = mech.savePatch({ ruleDirty: false, mechDirty: true, mech: { permanent: false } });
  assert.equal(Object.values(del)[0], null, "удаление");
  assert.deepEqual(Object.values(set)[0], { permanent: false });
});

/* ---------- читатели рантайма ---------- */

const BREATH_TEXT = "You can't use Breath Weapon again for [[/gmr 1d4 #Recharge Breath Weapon]]{1d4 rounds}.";
const breath = { id: "b1", type: "action", slug: "breath-weapon", uuid: "I.b", name: "Breath Weapon", system: { traits: { value: [] }, actionType: { value: "action" }, description: { value: BREATH_TEXT } } };

test("M1: rechargeEntry — текст, свой срок, «не ограничивать»; тип предмета как в preCreate", () => {
  assert.deepEqual(mech.rechargeEntry(breath), { dice: "1d4", ids: ["b1"] });
  assert.deepEqual(mech.rechargeEntry(flagged(breath, { recharge: "1d6" })), { dice: "1d6", ids: ["b1"] });
  assert.equal(mech.rechargeEntry(flagged(breath, { recharge: false })), null);
  assert.equal(mech.rechargeEntry({ ...breath, type: "equipment" }), null, "лимиты — spell/action/feat");
  const none = { ...breath, system: { description: { value: "no roll" } } };
  assert.equal(mech.rechargeEntry(none), null);
  assert.deepEqual(mech.rechargeEntry(flagged(none, { recharge: "1d6" })), { dice: "1d6", ids: ["b1"] }, "добавленная в Мастерской: замок на самом предмете");
  assert.equal(mech.rechargeEntry(flagged(none, { recharge: { on: "button", dice: "1d6" } })), null, "по кнопке — автозамка нет");
  const c = (item) => ({ traits: [], rc: mech.rechargeEntry(item), inCombat: true, limitsOn: true, combatId: "c", roundNum: 2, rcLock: mech.mechOf(item).recharge === false ? null : { c: "c", until: 5 } });   // как ctxOf: «не ограничивать» гасит и замок
  assert.equal(reasonOf(c(breath)), "recharge");
  assert.equal(reasonOf(c(flagged(breath, { recharge: false }))), null, "строка LIMITS не срабатывает");
});

let seq = 0;   // pending (5 с) общий на файл по uuid актёра: у каждого мира свой
function world() {
  const uuid = `A.${++seq}`, actor = { uuid, type: "npc", flags: {}, itemTypes: { action: [], effect: [] }, abilities: { con: { mod: 0 } }, system: {}, update: async () => {} };
  globalThis.game = {
    user: { id: "u", isActiveGM: true }, messages: { contents: [] }, settings: { get: () => "auto" }, keyboard: { isModifierActive: () => false },
    i18n: { localize: (k) => k, format: (k) => k }, combats: [{ id: "c", started: true, active: true, scene: {}, round: 1, turn: 0, combatants: [{ actor: { uuid } }] }]
  };
  globalThis.ui = { notifications: { warn() {} } };
  globalThis.CONFIG = { Dice: { randomUniform: () => 0.99 } };
  return actor;
}
const useMsg = (actor, item) => { const m = { actor, item, flags: { pf2e: { context: { type: "self-effect" } } }, updateSource(ch) { m.upd = { ...m.upd, ...ch }; } }; return m; };

test("M1 в preCreate: срок из mech идёт в бросок; recharge:false — ни броска, ни блока второго использования", () => {
  let a = world(), m = useMsg(a, breath);
  assert.equal(preCreate(m, {}, {}, "u"), undefined);
  assert.equal(m.upd[`flags.${MOD}.limitMarks`].rc_b1.dice, "1d4");
  a = world(); m = useMsg(a, flagged(breath, { recharge: "1d6" }));
  preCreate(m, {}, {}, "u");
  assert.equal(m.upd[`flags.${MOD}.limitMarks`].rc_b1.dice, "1d6");
  a = world(); m = useMsg(a, flagged(breath, { recharge: false }));
  assert.equal(preCreate(m, {}, {}, "u"), undefined);
  assert.equal(m.upd?.[`flags.${MOD}.limitMarks`], undefined, "ни rc_*");
  a.flags[MOD] = { rc_b1: { c: "c", until: 5 } };
  assert.equal(preCreate(useMsg(a, flagged(breath, { recharge: false })), {}, {}, "u"), undefined, "замок не блокирует");
  assert.equal(preCreate(useMsg(a, breath), {}, {}, "u"), false, "без флага замок блокирует");
  delete globalThis.CONFIG;
});

test("M2: req:false — требование не блокирует; без флага блок", () => {
  const GRAB = "Compendium.pf2e.test.Item.GRAB";
  initOverlays(null, null, null, { v: 1, bySource: { [GRAB]: { any: [{ k: "holds" }] } } });
  try {
    const grab = { id: "g1", type: "action", slug: "grab", uuid: "I.g", name: "Grab", _stats: { compendiumSource: GRAB }, system: { traits: { value: [] }, actionType: { value: "action" } } };
    assert.equal(preCreate(useMsg(world(), grab), {}, {}, "u"), false, "существо никого не держит: блок");
    assert.equal(preCreate(useMsg(world(), flagged(grab, { req: false })), {}, {}, "u"), undefined);
  } finally { initOverlays(null, null, null, null); }
});

const POISON = { v: 1, label: "Venom", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } } };
const passive = (slug, o = {}) => ({ type: "action", slug, name: slug, uuid: `Actor.x.Item.${slug}`, system: { actionType: { value: "passive" }, frequency: null, description: { value: "" } }, flags: {}, ...o });
const strikeOf = (...fx) => ({ type: "melee", name: "Fangs", system: { attackEffects: { value: fx } } });
const res = (rule, source = "catalog") => ({ rule: validateRule(rule).rule, source });
const PA = { g: { name: "Venom", isActive: true, source: ["venom"] } };
const settings = (o = {}) => {
  game.settings = { get: (_m, k) => (k === "rulesV3" ? PA : { "mode.effect": "auto", "mode.challenge": "auto", yieldToAutomations: false, ...o }[k]) };
  game.modules = { get: () => (o.pa ? { active: true } : null) };
  resetIndex();
};
const withActor = (item, strikes) => { item.actor = { items: [item, ...strikes], itemTypes: { melee: strikes } }; return item; };
const OFF = { flags: { [MOD]: { mech: { strike: false } } } };

test("M3: strike:false — strikeLinkEntry null (ручная карточка возвращается); без флага связь есть", () => {
  const item = passive("venom"), s = [strikeOf("venom")];
  assert.ok(strikeLinkEntry(res(POISON), item, s));
  assert.equal(strikeLinkEntry(res(POISON), flagged(item, { strike: false }), s), null);
});

test("M3 strikeLinkState: причины off — flag, needRule, mode, yield; связи нет — null; strikeLinked (контракт use.mjs) отдаёт связь только без причины", () => {
  const s = [strikeOf("venom")], mk = (o = {}) => withActor(passive("venom", o), s), poison = () => res(POISON);
  settings();
  assert.equal(strikeLinkState(mk(), poison).off, null);
  assert.equal(strikeLinkState(mk(), poison).strikes.length, 1);
  assert.equal(strikeLinkState(mk(OFF), poison).off, "flag");
  assert.equal(strikeLinkState(mk(), poison).needRule, false, "в кэш строки Мастерской идёт признак связи, не режим и не уступка");
  assert.equal(strikeLinkState(mk(), () => res(POISON, "markup")).needRule, true);
  assert.equal(strikeLinkState(mk(), () => res(POISON, "markup")).off, "needRule", "разметка сама не исполняется");
  assert.equal(strikeLinkState(mk(OFF), () => res(POISON, "markup")).off, "flag", "переопределение предмета — раньше правила");
  assert.equal(strikeLinkState(withActor(passive("venom"), [strikeOf("other")]), poison), null, "Удар не ссылается");
  assert.equal(strikeLinkState(passive("venom"), poison), null, "нет актёра");
  settings({ "mode.challenge": "off" });
  assert.equal(strikeLinkState(mk(), poison).off, "mode");
  settings({ yieldToAutomations: true, pa: true });
  assert.equal(strikeLinkState(mk(), poison).off, "yield");
  settings({ yieldToAutomations: true, pa: true, "mode.challenge": "off" });
  assert.equal(strikeLinkState(mk(), poison).off, "mode", "режим раньше уступки");
  settings();
});

test("M3 strikeLinked: контракт — объект {rule, strikes} или null; mech.strike:false даёт null", () => {
  // resolveRule без каталога вернёт null — проверяем только null-ветки реального вызова; связь с причиной — выше (strikeLinkState с подменой)
  settings();
  assert.equal(strikeLinked(passive("venom")), null, "нет актёра");
  assert.equal(strikeLinked(withActor(passive("venom", OFF), [strikeOf("venom")])), null, "flag: каталога нет, связи нет");
  settings({ "mode.effect": "off", "mode.challenge": "off" });
  assert.equal(strikeLinked(withActor(passive("venom"), [strikeOf("venom")])), null);
  settings();
});

test("M5: переопределение пересекается с таблицей SPELLS; пусто/вне таблицы — вычисленные; режим off — []", () => {
  assert.deepEqual(pickManeuvers("telekinetic-maneuver", ["disarm", "shove", "reposition", "trip"], ["trip", "disarm"]), ["disarm", "trip"]);
  assert.deepEqual(pickManeuvers("telekinetic-maneuver", ["disarm", "trip"], undefined), ["disarm", "trip"]);
  assert.deepEqual(pickManeuvers("magnetic-attraction", ["disarm"], ["trip"]), ["disarm"], "вне таблицы");
  assert.deepEqual(pickManeuvers("nothing", [], ["trip"]), []);
  game.settings = { get: () => "auto" }; game.i18n = { localize: () => "" };
  const tk = { type: "spell", slug: "telekinetic-maneuver", name: "TM", system: { description: { value: "" } } };
  assert.deepEqual(maneuversOf(tk), ["disarm", "shove", "reposition", "trip"]);
  assert.deepEqual(maneuversOf(flagged(tk, { maneuvers: ["trip"] })), ["trip"]);
  game.settings = { get: () => "off" };
  assert.deepEqual(maneuversOf(flagged(tk, { maneuvers: ["trip"] })), []);
});

test("M6: permanent:false — permanentOf null (и у _source), без флага — запись таблицы", () => {
  const zombie = { type: "action", slug: "slow", name: "Slow", flags: {} };
  assert.equal(permanentOf(zombie, "npc"), PERMANENT.slow);
  assert.equal(permanentOf(flagged(zombie, { permanent: false }), "npc"), null);
  assert.equal(permanentOf(zombie, "character"), null);
});

test("вкладка листа: «Сохранить в предмет» пишет правило только через savePatch (без правки _afDraft — ничего)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/sheet.mjs", import.meta.url), "utf8"), line = src.slice(src.indexOf('act === "save-flag"'), src.indexOf('act === "reset-flag"'));
  assert.match(line, /savePatch\(\{ ruleDirty: !!app\._afDraft/);
  assert.doesNotMatch(line, /forcedReplace/, "прямой записи формы во флаг нет");
  const rule = { v: 1, onUse: {} };
  assert.deepEqual(mech.savePatch({ ruleDirty: false, rule }), {}, "форма без правки — снимок каталога/разметки не закрепляется");
  assert.deepEqual(Object.keys(mech.savePatch({ ruleDirty: true, rule })).length > 0, true);
});

const STUN = "A creature critically hit by the electric eel's tail must attempt a @Check[fortitude|dc:17] save.<hr>Critical Success unaffected";
const SIPHON = "When the accursed forge-spurned critically hits a target with its soul chain, the chain leeches away. The target must attempt a @Check[fortitude|dc:36] save.";
const RU_CRIT = "Существо, получившее критический удар хвостом, проходит @Check[fortitude|dc:17]{испытание Стойкости}.";
const withText = (slug, html) => passive(slug, { system: { actionType: { value: "passive" }, frequency: null, description: { value: html } } });

test("M3 крит: признак из оверлея crit-only (по английскому тексту при сборке), не из текста предмета — описание может быть русским", () => {
  const s = [strikeOf("venom")], when = (html) => strikeLinkEntry(res(POISON), withText("venom", html), s).onEvent[0].when;
  try {
    initOverlays(null, null, null, null, { v: 1, bySlug: { "venom@action": 1 } });
    for (const t of [STUN, SIPHON, RU_CRIT, "Обычный текст"]) assert.ok(when(t).includes("outcome:criticalSuccess"), t.slice(0, 30));
    initOverlays(null, null, null, null, null);
    for (const t of [STUN, SIPHON, RU_CRIT]) assert.ok(!when(t).includes("outcome:criticalSuccess"), "нет записи — каждое попадание: " + t.slice(0, 30));
  } finally { initOverlays(null, null, null, null, null); }
});

test("M3 исход: правило из разметки без byDegree — «нужно правило» (noOutcome), с исходом — «нужно принять»; недуг каталога связан", () => {
  settings();
  const s = [strikeOf("venom")], mk = () => withActor(passive("venom"), s);
  const bare = { v: 1, label: "Venom", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: {} } } };
  const st = strikeLinkState(mk(), () => res(bare, "markup"));
  assert.equal(st.off, "needRule"); assert.equal(st.noOutcome, true);
  assert.equal(strikeLinkState(mk(), () => res(POISON, "markup")).noOutcome, false, "исход есть — принять можно");
  assert.equal(strikeLinkState(mk(), () => res(POISON, "markup")).off, "needRule");
  assert.equal(strikeLinkState(mk(), () => res(POISON, "catalog")).off, null);
});

test("M3 каталожное правило с крит-текстом запускается только критом (strikeLinkState и strikeLinkEntry)", () => {
  settings();
  const s = [strikeOf("shock")], it = withActor(withText("shock", STUN), s), st = () => strikeLinkState(it, () => res(POISON, "catalog")).rule.onEvent[0].when;
  try {
    initOverlays(null, null, null, null, { v: 1, bySlug: { "shock@action": 1 } });
    assert.ok(st().includes("outcome:criticalSuccess"));
  } finally { initOverlays(null, null, null, null, null); }
  assert.ok(!st().includes("outcome:criticalSuccess"), "без записи оверлея текст предмета признак не задаёт");
});

test("M1: подпись броска ≠ имя единственной способности — карта по slug (Fog of Chance)", () => {
  const one = (slug, name, type, html) => ({ id: "f1", type, slug, uuid: "I.f", name, system: { traits: { value: [] }, actionType: { value: "action" }, description: { value: html } } });
  assert.deepEqual(mech.rechargeEntry(one("fog-of-chance", "Fog of Chance", "action", "The dragonet can't use Fortune Fog again for [[/r 1d4 #Recharge Fortune Fog]]{1d4 rounds}.")), { dice: "1d4", ids: ["f1"] });
  assert.deepEqual(mech.rechargeEntry({ ...one("", "Фог удачи", "action", "It can't use Fortune Fog again for [[/r 1d4 #Recharge Fortune Fog]]{1d4 rounds}."), slug: null, flags: { babele: { originalName: "Fog of Chance" } } }), { dice: "1d4", ids: ["f1"] }, "slug пуст — алиас по исходному имени");
  assert.deepEqual(mech.rechargeEntry(one("breath-weapon", "Breath Weapon", "action", "It can't use Dragonstorm Breath again for [[/gmr 1d4 #Recharge Dragonstorm Breath]]{1d4 rounds}.")), { dice: "1d4", ids: ["f1"] });
  assert.equal(mech.rechargeEntry(one("other-thing", "Other Thing", "action", "The dragonet can't use Fortune Fog again for [[/r 1d4 #Recharge Fortune Fog]]{1d4 rounds}.")), null);
});

/* ---------- ручная перезарядка: режимы, срез по умолчанию, rechargeSpec ---------- */

const COND_TEXT = "<p><strong>Critical Failure</strong> The ooze can't use Slime again for [[/gmr 1d4 #Recharge Slime]]{1d4 rounds}.</p>";
const mk = (text, o = {}) => ({ id: "s1", type: "action", slug: "slime", uuid: "I.s", name: "Slime", system: { traits: { value: [] }, actionType: { value: "action" }, description: { value: text } }, ...o });

test("normalizeMech: {on:\"button\"} со сроком или без; мусор в объекте отбрасывается", () => {
  assert.deepEqual(mech.normalizeMech({ recharge: { on: "button" } }), { recharge: { on: "button" } });
  assert.deepEqual(mech.normalizeMech({ recharge: { on: "button", dice: "1к6" } }), { recharge: { on: "button", dice: "1d6" } });
  for (const bad of [{ on: "auto" }, { on: "button", dice: "abc" }, { dice: "1d6" }, {}]) assert.deepEqual(mech.normalizeMech({ recharge: bad }), {}, JSON.stringify(bad));
});

test("rechargeSpec: флаг false / по кнопке / срок строкой / текст (безусловный авто, условный по кнопке)", () => {
  const plain = mk("no roll"), cond = mk(COND_TEXT), auto = mk(BREATH_TEXT, { id: "b1", slug: "breath-weapon", name: "Breath Weapon" });
  assert.deepEqual(mech.rechargeSpec(auto), { dice: "1d4", ids: ["b1"], mode: "auto" });
  assert.deepEqual(mech.rechargeSpec(cond), { dice: "1d4", ids: ["s1"], mode: "button" }, "условная — по кнопке сама");
  assert.equal(mech.rechargeEntry(cond), null, "автозамка у условной нет");
  assert.equal(mech.rechargeSpec(plain), null);
  assert.equal(mech.rechargeSpec(flagged(auto, { recharge: false })), null);
  assert.deepEqual(mech.rechargeSpec(flagged(auto, { recharge: { on: "button" } })), { dice: "1d4", ids: ["b1"], mode: "button" }, "по кнопке у распознанной: срок из текста");
  assert.deepEqual(mech.rechargeSpec(flagged(auto, { recharge: { on: "button", dice: "1d6" } })), { dice: "1d6", ids: ["b1"], mode: "button" });
  assert.equal(mech.rechargeEntry(flagged(auto, { recharge: { on: "button" } })), null, "по кнопке — автозамка нет");
  assert.deepEqual(mech.rechargeSpec(flagged(plain, { recharge: "1d6" })), { dice: "1d6", ids: ["s1"], mode: "auto" });
  assert.equal(mech.rechargeSpec(flagged(plain, { recharge: { on: "button" } })), null, "срока нет нигде");
  assert.deepEqual(mech.rechargeSpec(flagged(cond, { recharge: "1d8" })), { dice: "1d8", ids: ["s1"], mode: "auto" }, "условная, переведённая на авто");
  assert.equal(mech.rechargeSpec({ ...auto, type: "equipment" }), null);
});

test("pruneMech: срезается только значение, у которого совпали и режим, и срок", () => {
  const auto = { dice: "1d4", rc: "auto" }, cond = { dice: "1d4", rc: "button" }, none = { rc: "none" };
  assert.deepEqual(mech.pruneMech({ recharge: "1d4" }, auto), {}, "авто, срок как в тексте");
  assert.deepEqual(mech.pruneMech({ recharge: "1d6" }, auto), { recharge: "1d6" });
  assert.deepEqual(mech.pruneMech({ recharge: { on: "button" } }, auto), { recharge: { on: "button" } }, "режим отличается — остаётся");
  assert.deepEqual(mech.pruneMech({ recharge: "1d4" }, cond), { recharge: "1d4" }, "условная -> авто — остаётся");
  assert.deepEqual(mech.pruneMech({ recharge: { on: "button" } }, cond), {}, "по кнопке, срок из текста");
  assert.deepEqual(mech.pruneMech({ recharge: { on: "button", dice: "1d4" } }, cond), {});
  assert.deepEqual(mech.pruneMech({ recharge: { on: "button", dice: "1d6" } }, cond), { recharge: { on: "button", dice: "1d6" } });
  assert.deepEqual(mech.pruneMech({ recharge: false }, none), {}, "false у нераспознанной = по умолчанию");
  assert.deepEqual(mech.pruneMech({ recharge: false }, auto), { recharge: false });
  assert.deepEqual(mech.pruneMech({ recharge: "1d4" }, none), { recharge: "1d4" }, "у нераспознанной срок — это режим «авто»");
  assert.deepEqual(mech.pruneMech({ recharge: { on: "button", dice: "1d4" } }, auto), { recharge: { on: "button", dice: "1d4" } });
});

test("rechargePending: добавленная перезарядка без срока — черновик, форма при этом даёт пустой флаг", () => {
  const f = mech.mechToForm({});
  assert.equal(mech.rechargePending(f), false);
  Object.assign(f.recharge, { mode: "auto", added: true });
  assert.equal(mech.rechargePending(f), true);
  assert.deepEqual(mech.formToMech(f, { rc: "none" }), {}, "флага ещё нет — поэтому нужен отдельный признак черновика");
  assert.ok(mech.mechErrors(f, { rc: "none" }).length, "и сохранить без срока нельзя");
  assert.equal(mech.rechargePending(mech.mechToForm({ recharge: "1d4" })), false, "сохранённая — не черновик");
});

test("formToMech: режимы формы; условная — «по кнопке» по умолчанию не пишется, выбор «авто» остаётся", () => {
  const cond = { dice: "1d4", rc: "button" }, f = mech.mechToForm({});
  assert.equal(f.recharge.mode, "default");
  assert.deepEqual(mech.formToMech(f, cond), {});
  f.recharge.mode = "button";
  assert.deepEqual(mech.formToMech(f, cond), {}, "по кнопке = по умолчанию условной");
  f.recharge.mode = "auto";
  assert.deepEqual(mech.formToMech(f, cond), { recharge: "1d4" }, "авто без срока берёт срок из текста — и это не умолчание условной");
  f.recharge.dice = "1d6";
  assert.deepEqual(mech.formToMech(f, cond), { recharge: "1d6" });
  f.recharge.mode = "button";
  assert.deepEqual(mech.formToMech(f, cond), { recharge: { on: "button", dice: "1d6" } });
  f.recharge.mode = "off";
  assert.deepEqual(mech.formToMech(f, cond), { recharge: false });
  assert.deepEqual(mech.formToMech(f, { rc: "none" }), {}, "«нет» у нераспознанной не пишется");
  for (const m of [{ recharge: { on: "button" } }, { recharge: { on: "button", dice: "1d6" } }]) assert.deepEqual(mech.formToMech(mech.mechToForm(m)), m, JSON.stringify(m));
});
