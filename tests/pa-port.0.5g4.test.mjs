// 0.5g4, перенос PA: шаги damage / choose / reduce / duration из правил и handler-ов PA, правила-носители на эффектах, вложенные предметы как носители. Без Foundry.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true }, settings: { get: () => true }, i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null } };
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o) } };

const pa = await import("../tools/pa-port.mjs");
const ev = await import("../tools/pa-events.mjs");
const { CARRIERS } = await import("../tools/pa-carriers.mjs");
const { validateRule } = await import("../scripts/rules.mjs");
const { roundTrip } = await import("../tools/validate.mjs");
const events = await import("../scripts/events.mjs");
const { MOD } = await import("../scripts/util.mjs");

const FX = "Compendium.pf2e.feat-effects.Item.AAAAAAAAAAAAAAAA";
const pctx = { effects: { [FX]: "Effect: X" }, condSlugs: new Set(["frightened", "stunned"]), condIds: {}, grants: {}, labels: {}, condSlugByUuid: () => null, condNames: [] };
const feat = (extra = {}) => ({ type: "feat", slug: "my-feat", name: "My Feat", traits: [], actionType: "passive", ...extra });
const group = (rules, extra = {}) => ({ rules: rules.map((r) => ({ type: "base", extend: null, range: null, triggerType: "skill-check", ...r })), ownSlugs: new Set(["my-feat"]), srcTypes: new Set(["feat"]), ...extra });
const tr = (rules, item = feat(), html = "", g = group(rules)) => pa.translateItem(item, html, g, pctx);

test("SelfDamage / TargetDamage -> шаг damage: формула и тип из «формула[тип]»; чужой тип или нет скобок — долг damage-step", () => {
  const act = feat({ type: "action", actionType: "action" });
  const g = (value, target = "SelfDamage") => group([{ triggerType: "postInfo", target, value, predicate: ["origin:item:my-feat"] }]);
  const r = tr([], act, "", g("@actor.level[fire]"));
  assert.deepEqual(r.rule.onUse.apply, [{ to: "self", damage: { formula: "@actor.level", damageType: "fire" } }]);
  assert.deepEqual(tr([], act, "", g("1d6[bludgeoning]", "TargetDamage")).rule.onUse.apply, [{ to: "target", damage: { formula: "1d6", damageType: "bludgeoning" } }]);
  assert.match(tr([], act, "", g("1d6[plasma]")).reason, /damage-step/);
  assert.match(tr([], act, "", g("1d6")).reason, /damage-step/);
});

test("PA: кубик в сроке значения — duration у шага (и у состояния, и у эффекта); формула — долг; срок эффекта pf2e не отличается — шага срока нет", () => {
  const cx = (duration, extra) => group([{ type: "complex", triggerType: "use", target: "SelfEffect", predicate: [], values: [{ ...extra, duration }] }]);
  const act = feat({ type: "action", actionType: "action" });
  const eff = tr([], act, "", cx({ value: "1d4", unit: "rounds", expiry: "turn-end" }, { effects: [FX] }));
  assert.deepEqual(eff.rule.onUse.apply, [{ to: "self", effect: { uuid: FX }, duration: { value: "1d4", unit: "rounds", expiry: "turn-end" } }]);
  const cond = tr([], act, "", cx({ value: "1d4", unit: "rounds", expiry: "turn-end" }, { conditions: ["stunned"] }));
  assert.deepEqual(cond.rule.onUse.apply[0].duration, { value: "1d4", unit: "rounds", expiry: "turn-end", of: "origin" });
  assert.match(tr([], act, "", cx({ value: "1d4+@level", unit: "rounds" }, { conditions: ["stunned"] })).reason, /dice-duration/);
  const same = pa.translateItem(act, "", cx({ value: 10, unit: "minutes" }, { effects: [FX] }), { ...pctx, effectDur: { [FX]: { value: 10, unit: "minutes" } } });
  assert.equal(same.rule.onUse.apply[0].duration, undefined);
  const diff = pa.translateItem(act, "", cx({ value: 8, unit: "hours" }, { effects: [FX] }), { ...pctx, effectDur: { [FX]: { value: 10, unit: "minutes" } } });
  assert.deepEqual(diff.rule.onUse.apply[0].duration, { value: 8, unit: "hours", expiry: null });
});

test("handler-ы 0.5g4 из таблицы: проходят валидатор и форму туда-обратно; Аура отваги — reduce союзникам в 15 фт", () => {
  for (const name of ["auraOfCourage", "monsterHunter", "wardingStatuetteAttack"]) {
    const h = ev.EVENT_HANDLERS[name], v = validateRule({ v: 1, onEvent: [{ on: "turn-end", side: "self", apply: h.steps }] });
    assert.equal(v.ok, true, `${name}: ${v.errors?.join(";")}`);
    assert.equal(roundTrip(v.rule), true, name);
  }
  const aura = tr([{ type: "handler", triggerType: "end-turn", value: "auraOfCourage", target: "none", predicate: ["feat:my-feat", "champions-aura"] }]);
  assert.deepEqual(aura.rule.onEvent, [{ on: "turn-end", side: "self", apply: [{ to: "allies", range: 15, condition: { slug: "frightened", policy: "reduce" } }] }]);   // champions-aura — подразумевается
  assert.equal(aura.confidence, "high");
});

test("Охотник на чудовищ: бросок Вспоминания, крит. успех (у мастера — и успех); выбор союзника и шаги выбранному", () => {
  const r = tr([{ type: "handler", triggerType: "skill-check", value: "monsterHunter", target: "none", predicate: ["action:recall-knowledge", "feat:my-feat", { or: ["outcome:criticalSuccess", { and: ["feat:master-monster-hunter", "outcome:success"] }] }] }]);
  const e = r.rule.onEvent[0];
  assert.equal(e.on, "skill-check");
  assert.deepEqual(e.when, ["action:recall-knowledge", { or: ["outcome:criticalSuccess", { and: ["feat:master-monster-hunter", "outcome:success"] }] }]);
  assert.deepEqual(e.apply.map((s) => s.to), ["self", "self", "self", "chosen", "chosen"]);
  assert.deepEqual(e.apply[2], { to: "self", choose: { from: "allies" } });
  // метка врага — у эффектов с TokenMark (шаг mark:"enemy" проставляет withMarks)
  const marked = ev.withMarks(r.rule, (u) => u.includes("W2tWq0gdAcnoz2MO") || u === FX);
  assert.ok(marked.onEvent[0].apply.filter((s) => s.effect).every((s) => s.mark === "enemy" || !s.effect.uuid.includes("W2tW")));
});

test("Bane: правило у заклинателя (side origin) на эффект ауры у врага; испытание Воли со степенями и иммунитетом; applyBaneImmunity — часть того же правила", () => {
  const spell = feat({ type: "spell", slug: "bane", name: "Bane", actionType: undefined });
  const g = { rules: [
    { type: "handler", triggerType: "saving-throw", value: "applyBaneImmunity", target: "none", predicate: ["item:slug:bane", { or: ["outcome:success", "outcome:criticalSuccess"] }] },
    { type: "handler", triggerType: "create-item", value: "rollSavingThrowVsBane", target: "none", predicate: ["effect:origin", "effect:slug:spell-effect-bane"] }], ownSlugs: new Set(["bane"]), srcTypes: new Set(["spell"]) };
  const r = pa.translateItem(spell, "", g, pctx);
  assert.equal(r.rule?.onEvent?.length, 1, r.reason);
  const e = r.rule.onEvent[0];
  assert.deepEqual([e.on, e.side, e.when], ["effect-created", "origin", ["effect:origin", "effect:slug:spell-effect-bane"]]);
  assert.equal(e.challenge.statistic, "will");
  assert.deepEqual(e.challenge.immunity.degrees, ["success", "criticalSuccess"]);
  assert.deepEqual(Object.keys(e.challenge.byDegree), ["success", "criticalSuccess"]);
});

test("правила-носители на эффектах: валидны, форма туда-обратно; Репеллент ловит членистоногих в ближнем бою, Маска ужаса — любую атаку по носителю", () => {
  for (const [uuid, rule] of Object.entries(CARRIERS)) {
    const v = validateRule(rule);
    assert.equal(v.ok, true, `${uuid}: ${v.errors?.join(";")}`);
    assert.equal(roundTrip(v.rule), true, uuid);
    assert.ok(v.rule.onEvent.every((x) => x.side === "target" && x.challenge), uuid);
  }
  const vermin = validateRule(CARRIERS["Compendium.pf2e.equipment-effects.Item.UhV9TLdFjtSOppog"]).rule;
  const hit = (opts) => events.matchEntries(vermin, "attack-roll", "target", new Set(opts)).length;
  assert.equal(hit(["self:trait:arthropod", "item:melee"]), 1);
  assert.equal(hit(["self:trait:arthropod"]), 0);   // не ближний бой
  assert.equal(hit(["item:melee"]), 0);   // не членистоногое
});

test("вложенные предметы оружия — носители правил события (Защитная статуэтка)", () => {
  const rule = { v: 1, onEvent: [{ on: "attack-roll", side: "self", when: ["sub-item:warding-statuette"], apply: [{ to: "self", choose: { from: "allies", range: 10, of: "target" } }, { to: "chosen", effect: { uuid: FX } }] }] };
  const v = validateRule(rule);
  assert.equal(v.ok, true, v.errors?.join(";"));
  const statuette = { type: "equipment", name: "Warding Statuette", slug: "warding-statuette", flags: { [MOD]: { rule: v.rule } }, system: {} };
  const weapon = { type: "weapon", name: "Sword", slug: "sword", subitems: [statuette], flags: {}, system: {} };
  assert.deepEqual(events.eventItems({ items: [weapon] }).map((x) => x.item.name), ["Warding Statuette"]);
  assert.equal(validateRule({ v: 1, onEvent: [{ on: "attack-roll", apply: [{ to: "self", choose: { from: "options", options: ["a"], of: "target" } }] }] }).ok, false);   // of — только у существ
});
