// Недуги со стадиями (шаг affliction, plan-affliction.md): арифметика стадий, схема, конвертер текста, носитель, часы, откат. Без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created, now, dealt;
const warned = [];
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
const isPlain = (x) => x && typeof x === "object" && !Array.isArray(x);
const merge = (t, s) => { for (const [k, v] of Object.entries(s)) t[k] = isPlain(v) && isPlain(t[k]) ? merge(t[k], v) : structuredClone(v); return t; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  time: { get worldTime() { return now; } },
  combats: [], actors: [], scenes: { contents: [] },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map(), getCondition: (slug) => ({ uuid: null, _stats: { compendiumSource: `Compendium.pf2e.conditionitems.Item.${slug}` }, name: slug, img: "i.svg", system: { value: { isValued: false } }, toObject() { return { name: slug, type: "condition", system: { slug, value: { isValued: false, value: null } } }; } }) } }
};
globalThis.ui = { notifications: { warn(k) { warned.push(k); }, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o), hasProperty: (o, p) => p.split(".").every(function (k) { return o != null && k in Object(o) && ((o = o[k]), true); }), escapeHTML: (s) => s } };
globalThis.CONFIG = { PF2E: { damageTypes: { poison: 1, void: 1, bleed: 1 } }, Canvas: { polygonBackends: { move: { testCollision: () => false } } }, Dice: { rolls: [class DamageRoll { constructor(f) { this.f = f; } async evaluate() { this.total = 5; return this; } alter() { return this; } }] } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: ({ actor }) => ({ actor: actor.id }), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const A = await import("../scripts/affliction.mjs");
const run = await import("../scripts/affliction-run.mjs");
const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const { afflictionRule, parseAffliction } = await import("../tools/affliction.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const { stepText } = await import("../scripts/chat.mjs");

const validate = rules.validateRule;

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = []; dealt = []; warned.length = 0; now = 1000;
  game.combats = []; run.resetTracked();
});

const stg = (o = {}) => ({ duration: { value: 1, unit: "rounds" }, damage: [{ formula: "1d10", damageType: "poison" }], conditions: [{ slug: "sickened", value: 1 }], ...o });
const DEF = (o = {}) => ({ name: "Spider Venom", kind: "poison", save: { statistic: "fortitude", dc: 22 }, maxDuration: { value: 6, unit: "rounds" },
  stages: [stg(), stg({ damage: [{ formula: "1d12", damageType: "poison" }], conditions: [{ slug: "clumsy", value: 1 }, { slug: "sickened", value: 2 }] }), stg({ duration: null, damage: [], conditions: [] })], ...o });
const chRule = (def, stage = 1) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 22 }, byDegree: { failure: [{ to: "target", affliction: { stage, def } }] } } } });

/* ---------- арифметика ---------- */

test("stageDelta: 4 степени обычного недуга", () => {
  assert.deepEqual([0, 1, 2, 3].map((d) => A.stageDelta(d).delta), [2, 1, -1, -2]);
});

test("stageDelta virulent: два успеха подряд для −1, крит. успех −1 без счётчика, любая не-успех степень обнуляет streak", () => {
  assert.deepEqual(A.stageDelta(2, true, 0), { delta: 0, streak: 1 });
  assert.deepEqual(A.stageDelta(2, true, 1), { delta: -1, streak: 0 });
  assert.deepEqual(A.stageDelta(3, true, 0), { delta: -1, streak: 0 });
  assert.deepEqual(A.stageDelta(3, true, 1), { delta: -1, streak: 0 });
  assert.deepEqual(A.stageDelta(1, true, 1), { delta: 1, streak: 0 });
  assert.deepEqual(A.stageDelta(0, true, 1), { delta: 2, streak: 0 });
});

test("advance: ниже первой — снят, выше последней — остаёмся и повторяем (только при росте)", () => {
  const def = DEF();
  assert.deepEqual(A.advance(1, -1, def), { stage: 0, cleared: true, repeated: false });
  assert.deepEqual(A.advance(2, -2, def), { stage: 0, cleared: true, repeated: false });
  assert.deepEqual(A.advance(2, 1, def), { stage: 3, cleared: false, repeated: false });
  assert.deepEqual(A.advance(3, 1, def), { stage: 3, cleared: false, repeated: true });
  assert.deepEqual(A.advance(3, 2, def), { stage: 3, cleared: false, repeated: true });
  assert.deepEqual(A.advance(3, 0, def), { stage: 3, cleared: false, repeated: false });   // virulent: первый успех
  assert.equal(A.intervalOf(def, 1), 6);
  assert.equal(A.intervalOf(def, 3), null);   // конечная стадия
  assert.equal(A.secondsOf({ value: 1, unit: "days" }), 86400);
});

test("startMeta: раунд = 6 с; onset сдвигает первый интервал, endsAt от старта; стадия 2 берёт свой интервал", () => {
  const m = A.startMeta(DEF(), 2, { dc: 22, now: 1000 });
  assert.deepEqual([m.nextAt, m.endsAt, m.onsetEnds, m.slug, m.applied, m.streak], [1006, 1036, null, "spider-venom", null, 0]);
  const o = A.startMeta(DEF({ onset: { value: 1, unit: "hours" } }), 1, { dc: 22, now: 1000 });
  assert.deepEqual([o.onsetEnds, o.nextAt, o.endsAt], [4600, 4606, 1036]);
  assert.deepEqual(m.traits, ["poison"]);
});

test("reexpose: яд +1/+2 с потолком, остальное не действует; dueOf: end важнее roll, onset, один бросок после пропуска 8 ч", () => {
  const m = A.startMeta(DEF(), 1, { dc: 22, now: 1000 });
  assert.deepEqual(A.reexpose(m, 1, 1), { stage: 2, repeated: false });
  assert.deepEqual(A.reexpose(m, 2, 2), { stage: 3, repeated: true });
  assert.deepEqual(A.reexpose({ def: DEF({ kind: "disease" }) }, 1, 1), { skipped: true });
  assert.deepEqual(A.reexpose({ def: DEF({ kind: "curse" }) }, 1, 2), { skipped: true });
  assert.equal(A.dueOf(m, 1005), null);
  assert.equal(A.dueOf(m, 1006), "roll");
  assert.equal(A.dueOf(m, 1036), "end");
  const d = A.startMeta(DEF({ maxDuration: null, onset: { value: 1, unit: "hours" } }), 1, { dc: 22, now: 1000 });
  assert.equal(A.dueOf(d, 2000), null);   // onset идёт
  assert.equal(A.dueOf(d, 4600), "onset");
  assert.equal(A.dueOf({ ...d, applied: 1 }, 1000 + 8 * 3600), "roll");   // восемь часов за раз: один бросок
});

/* ---------- схема ---------- */

test("vAffliction: нормализация, стадия по умолчанию 1, СЛ можно опустить", () => {
  const r = validate(chRule({ ...DEF(), save: { statistic: "fortitude" }, stages: [{ damage: [{ formula: " 1d10 ", damageType: "poison" }] }] }, undefined));
  assert.deepEqual(r.errors, []);
  const a = r.rule.onUse.challenge.byDegree.failure[0].affliction;
  assert.equal(a.stage, 1);
  assert.deepEqual(a.def.stages[0], { duration: null, damage: [{ formula: "1d10", damageType: "poison" }], persistent: null, conditions: [], mods: null, text: "" });
  assert.deepEqual(a.def.save, { statistic: "fortitude" });
  assert.deepEqual([a.def.onset, a.def.virulent], [null, false]);
});

test("vAffliction: ошибки — вид, стадия за границей, лишние поля, штрафы, срок, получатель, совмещение с другими видами", () => {
  const keys = (r) => validate(r).errors.map((e) => e.key);
  assert.deepEqual(keys(chRule(DEF(), 4)), ["afflict.stage"]);
  assert.deepEqual(keys(chRule(DEF({ kind: "plague" }))), ["afflict.def"]);
  assert.deepEqual(keys(chRule(DEF({ save: { statistic: "ac" } }))), ["afflict.save"]);
  assert.deepEqual(keys(chRule(DEF({ stages: [] }))), ["afflict.stages"]);
  assert.deepEqual(keys(chRule(DEF({ maxDuration: { value: 0, unit: "rounds" } }))), ["afflict.dur"]);
  assert.deepEqual(keys(chRule(DEF({ stages: [{ foo: 1 }] }))), ["afflict.stage"]);
  assert.deepEqual(keys(chRule(DEF({ stages: [stg({ damage: [{ formula: "bad", damageType: "poison" }] })] }))), ["afflict.damage"]);
  assert.deepEqual(keys(chRule(DEF({ stages: [stg({ conditions: [{ slug: "sickened" }, { slug: "sickened" }] })] }))), ["afflict.conditions"]);
  assert.deepEqual(keys(chRule(DEF({ stages: [stg({ mods: [{ speed: { type: "status", value: 0 } }] })] }))), ["afflict.mods"]);
  const step = (s) => ({ v: 1, onUse: { targets: "selected", apply: [s] } });
  assert.deepEqual(keys(step({ to: "self", affliction: { def: DEF() } })), ["afflict.to"]);
  assert.deepEqual(keys(step({ to: "target", affliction: { def: DEF() }, note: "x" })), ["apply.kind"]);
  assert.deepEqual(keys(step({ to: "target", affliction: { def: DEF() }, repeat: { on: "turn-end" } })), ["apply.repeat"]);
  const ok = validate(step({ to: "target", affliction: { def: DEF({ stages: [stg({ mods: [{ speed: { type: "status", value: -10 } }] })] }) } }));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rule.onUse.apply[0].affliction.def.stages[0].mods, [{ speed: { type: "status", value: -10 } }]);
  assert.equal(rules.isActiveStep({ to: "target", stageDelta: { slug: "x" } }), true);
});

test("форма и текст шага: недуг переживает ruleToForm -> formToRule; в чате — «стадия N из M»", () => {
  const r = validate(chRule(DEF(), 2)).rule;
  const back = validate(formToRule(ruleToForm(r)));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.rule.onUse.challenge.byDegree.failure[0], r.onUse.challenge.byDegree.failure[0]);
  const t = (k, v) => `${k}:${v.stage}/${v.of}/${v.dc}`;
  assert.equal(stepText(r.onUse.challenge.byDegree.failure[0], { t }), "chat.stepAfflictionDC:2/3/22");
});

/* ---------- детектор и конвертер на настоящих текстах ---------- */

const C = (slug) => `Compendium.pf2e.conditionitems.Item.${slug}`;
const condSlug = (u) => (u.includes(".conditionitems.") ? u.split(".").pop() : null);
const link = (slug, label) => `@UUID[${C(slug)}]{${label}}`;
const SPIDER = `<p>This spider venom erodes a target's defenses.</p><hr /><p><strong>Activate</strong> <span class="action-glyph">2</span> (manipulate)</p>
<p><strong>Saving Throw</strong> @Check[fortitude|dc:22|showDC:all]</p>
<p><strong>Maximum Duration</strong> 6 rounds</p>
<p><strong>Stage 1</strong> @Damage[1d10[poison]] damage and ${link("sickened", "Sickened 1")} (1 round)</p>
<p><strong>Stage 2</strong> @Damage[1d12[poison]] damage, ${link("clumsy", "Clumsy 1")}, and ${link("sickened", "Sickened 2")} (1 round)</p>
<p><strong>Stage 3</strong> @Damage[2d6[poison]] damage, ${link("clumsy", "Clumsy 2")}, and ${link("sickened", "Sickened 3")} (1 round)</p>`;
const CENTIPEDE = `<p><strong>Saving Throw</strong> @Check[fortitude|dc:17|showDC:all]</p><p><strong>Maximum Duration</strong> 6 rounds</p>
<p><strong>Stage 1</strong> @Damage[1d4[poison]] damage (1 round)</p>
<p><strong>Stage 2</strong> 1d4 poison damage and ${link("fatigued", "Fatigued")} (1 round)</p>
<p><strong>Stage 3</strong> 1d4 poison damage, ${link("clumsy", "Clumsy 1")}, and fatigued (1 round)</p>`;
const PURPLE = `<p><strong>Saving Throw</strong> @Check[fortitude|dc:32|traits:alchemical,injury,poison]</p><p><strong>Maximum Duration</strong> 6 rounds</p>
<p><strong>Stage 1</strong> @Damage[5d6[poison]] damage and ${link("enfeebled", "Enfeebled 2")} (1 round)</p>
<p><strong>Stage 2</strong> @Damage[6d6[poison]] damage and enfeebled 2 (1 round)</p>
<p><strong>Stage 3</strong> @Damage[8d6[poison]] damage and enfeebled 2 (1 round)</p>`;
const GHOUL = `<p><strong>Saving Throw</strong> @Check[fortitude|dc:]</p><hr />
<p><strong>Stage 1</strong> carrier with no ill effect (1 day)</p>
<p><strong>Stage 2</strong> @Damage[2d6[void]] damage and regains half as many Hit Points from all healing (1 day)</p>
<p><strong>Stage 3</strong> as stage 2 (1 day)</p>
<p><strong>Stage 4</strong> @Damage[2d6[void]] damage and gains no benefit from healing (1 day)</p>
<p><strong>Stage 5</strong> as stage 4 (1 day)</p>
<p><strong>Stage 6</strong> dead, and rises as a @UUID[Compendium.pf2e.pathfinder-bestiary.Actor.LHHgGSs0ELCR4CYK]{Ghoul} the next midnight.</p>`;
const POX = `<p>The target must attempt a Fortitude save.</p><hr />
<p><strong>Goblin Pox</strong> (disease) <strong>Level</strong> 1; Creatures that have the goblin trait are immune</p>
<p><strong>Stage 1</strong> ${link("sickened", "Sickened 1")} (1 round)</p>
<p><strong>Stage 2</strong> ${link("sickened", "Sickened 1")} and ${link("slowed", "Slowed 1")} (1 round)</p>
<p><strong>Stage 3</strong> ${link("sickened", "Sickened 1")} and the creature can't reduce its Sickened value below 1 (1 day)</p><hr />
<p><strong>Success</strong> The target is ${link("sickened", "Sickened 1")}.</p>
<p><strong>Failure</strong> The target is afflicted with goblin pox at stage 1.</p>
<p><strong>Critical Failure</strong> The target is afflicted with goblin pox at stage 2.</p>`;
const ONSET = `<p><strong>Saving Throw</strong> @Check[will|dc:20|traits:curse]</p><p><strong>Onset</strong> 1 hour</p><p><strong>Maximum Duration</strong> 2 days</p>
<p><strong>Stage 1</strong> –10-foot status penalty to Speeds (1 day)</p><p><strong>Stage 2</strong> @Damage[1d6[persistent,bleed]] damage and ${link("frightened", "Frightened 1")} (1 day)</p>`;

test("afflictionStages: недуг — да; заклинание без стадий и текст про одну «Stage» — нет", () => {
  for (const h of [SPIDER, CENTIPEDE, GHOUL, POX, ONSET]) assert.equal(rules.afflictionStages(h), true);
  assert.equal(rules.afflictionStages("<p>The target is stunned. Stage 1 of the rite is simple.</p>"), false);
  assert.equal(rules.afflictionStages("<p><strong>Saving Throw</strong> @Check[will|dc:20]</p><p>On a failure the target is frightened 1.</p>"), false);
  assert.equal(rules.afflictionStages(null), false);
});

test("конвертер: Spider Venom — стадии, урон, состояния, срок; провал = стадия 1, крит. провал = стадия 2, def один и тот же", () => {
  const r = afflictionRule(SPIDER, { name: "Spider Venom", traits: ["poison"], condSlug });
  assert.deepEqual(r.unsure, []);
  const by = r.rule.onUse.challenge.byDegree, d = by.failure[0].affliction.def;
  assert.equal(by.failure[0].affliction.stage, 1);
  assert.equal(by.criticalFailure[0].affliction.stage, 2);
  assert.deepEqual(by.criticalFailure[0].affliction.def, d);
  assert.deepEqual([d.kind, d.save, d.maxDuration, d.stages.length], ["poison", { statistic: "fortitude", dc: 22 }, { value: 6, unit: "rounds" }, 3]);
  assert.deepEqual(d.stages[1].conditions, [{ slug: "clumsy", value: 1 }, { slug: "sickened", value: 2 }]);
  assert.deepEqual(d.stages[1].damage, [{ formula: "1d12", damageType: "poison" }]);
  assert.deepEqual(r.rule.onUse.challenge.dc, { value: 22 });
});

test("конвертер: простой текст урона и условие без ссылки (Giant Centipede), трейты из @Check (Purple Worm)", () => {
  const c = parseAffliction(CENTIPEDE, { name: "Giant Centipede Venom", traits: ["poison"], condSlug });
  assert.deepEqual(c.unsure, []);
  assert.deepEqual(c.def.stages.map((s) => s.damage.length), [1, 1, 1]);
  assert.deepEqual(c.def.stages[2].conditions, [{ slug: "clumsy", value: 1 }, { slug: "fatigued" }]);
  const p = parseAffliction(PURPLE, { name: "Purple Worm Venom", condSlug });
  assert.deepEqual(p.unsure, []);
  assert.equal(p.def.kind, "poison");
  assert.deepEqual(p.def.stages[1].conditions, [{ slug: "enfeebled", value: 2 }]);   // «enfeebled 2» без ссылки
  assert.deepEqual(p.def.traits, ["alchemical", "injury"]);
});

test("разбор стадии: число после ссылки — значение только valued-состоянию; несколько кубиков в @Damage; bonus, связки, carrier", async () => {
  const { parseStage } = await import("../tools/affliction.mjs");
  const ps = (h, known = []) => parseStage(h, { condSlug, known });
  const L = (s) => `@UUID[Compendium.pf2e.conditionitems.Item.${s}]{${s}}`;
  let r = ps(`${L("frightened")} 1 and ${L("dazzled")} 1 (1 round)`);
  assert.deepEqual(r.stage.conditions, [{ slug: "frightened", value: 1 }, { slug: "dazzled" }]);
  assert.equal(r.unsure, true);   // «1» у dazzled — неразобранный остаток, не значение
  r = ps(`${L("paralyzed")} (1 round)`);
  assert.deepEqual([r.stage.conditions, r.unsure], [[{ slug: "paralyzed" }], false]);
  r = ps(`${L("sickened")} 2 for 1 round`);
  assert.deepEqual(r.stage.conditions, [{ slug: "sickened", value: 2 }]);
  r = ps(`slowed 1 and blinded`);   // без ссылки
  assert.deepEqual([r.stage.conditions, r.unsure], [[{ slug: "slowed", value: 1 }, { slug: "blinded" }], false]);
  r = ps(`confused 1`);
  assert.equal(r.unsure, true);
  r = ps(`@Damage[2d6[poison],1d6[persistent,fire]] plus ${L("sickened")} 1`);
  assert.deepEqual([r.stage.damage, r.stage.persistent, r.unsure], [[{ formula: "2d6", damageType: "poison" }], { formula: "1d6", damageType: "fire" }, false]);
  r = ps(`+1 status bonus to Will saves but ${L("clumsy")} 1`);
  assert.deepEqual([r.stage.mods, r.stage.conditions, r.unsure], [[{ bonus: { target: "will", type: "status", value: 1 } }], [{ slug: "clumsy", value: 1 }], false]);
  r = ps(`carrier with no ill effect`);
  assert.deepEqual([r.stage.conditions, r.unsure], [[], false]);
  r = ps(`dazzled 1`, ["dazzled"]);   // названо ссылкой в документе — значение всё равно не valued
  assert.deepEqual([r.stage.conditions, r.unsure], [[{ slug: "dazzled" }], true]);
  assert.equal(ps(`clumsy 1 or enfeebled 1`).unsure, true);
  assert.equal(ps(`stunned 1, then unconscious`).unsure, true);
  r = ps(`+1 status bonus to Perception rolls`);   // «Perception rolls» — известная цель
  assert.deepEqual([r.stage.mods?.length, r.unsure], [1, false]);
  r = ps(`+1 status bonus to Smell rolls`);   // неизвестная цель не теряется молча
  assert.deepEqual([r.stage.mods, r.unsure], [null, true]);
  r = ps(`@Damage[1d6[persistent,fire]] and @Damage[1d6[persistent,bleed]]`);
  assert.equal(r.unsure, true);
  r = ps(`@UUID[Compendium.pf2e.conditionitems.Item.clumsy]{Clumsy 1} 2`);
  assert.deepEqual([r.stage.conditions, r.unsure], [[{ slug: "clumsy", value: 1 }], true]);
  r = ps(`@Damage[2d6[poison],ghost] and @Damage[1d4[fire]]`);   // чужой хвост — не сумма, остаётся в unsure
  assert.equal(r.unsure, true);
});

test("конвертер: Ghoul Fever — «as stage N», конечная «dead», carrier — чистая стадия, СЛ без числа -> unsure; сюжет остаётся текстом", () => {
  const g = parseAffliction(GHOUL, { name: "Ghoul Fever", traits: ["disease"], condSlug });
  assert.equal(g.def.stages.length, 6);
  assert.deepEqual(g.def.stages[2].damage, [{ formula: "2d6", damageType: "void" }]);   // as stage 2
  assert.deepEqual(g.def.stages[2].duration, { value: 1, unit: "days" });
  assert.equal(g.def.stages[5].duration, null);
  assert.match(g.def.stages[5].text, /dead/);
  assert.equal(g.def.save.dc, undefined);
  assert.ok(g.unsure.includes("dc") && !g.unsure.some((x) => x.startsWith("stage 1:")) && g.unsure.some((x) => x.startsWith("stage 6:")));   // «carrier with no ill effect» — чистая стадия
});

test("конвертер: заклинание Goblin Pox — защита документа, база модели сохраняет остальные степени; onset и штраф к Скорости", () => {
  const base = { v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { source: "spell" }, byDegree: { success: [{ to: "target", condition: { slug: "sickened", value: 1 } }], failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } } };
  const r = afflictionRule(POX, { name: "Goblin Pox", base, save: { statistic: "fortitude" }, condSlug });
  const ch = r.rule.onUse.challenge;
  assert.deepEqual(ch.dc, { source: "spell" });
  assert.deepEqual(ch.byDegree.success, validate(base).rule.onUse.challenge.byDegree.success);
  assert.equal(ch.byDegree.failure[0].affliction.def.kind, "disease");
  assert.deepEqual(ch.byDegree.failure[0].affliction.def.stages[2].duration, { value: 1, unit: "days" });
  assert.ok(r.unsure.some((x) => /^stage 3:/.test(x)));   // «can't reduce below 1» — текстом
  const o = afflictionRule(ONSET, { name: "Gloom Curse", condSlug });
  const d = o.rule.onUse.challenge.byDegree.failure[0].affliction.def;
  assert.deepEqual([d.kind, d.onset, d.maxDuration], ["curse", { value: 1, unit: "hours" }, { value: 2, unit: "days" }]);
  assert.deepEqual(d.stages[0].mods, [{ speed: { type: "status", value: -10 } }]);
  assert.deepEqual(d.stages[1].persistent, { formula: "1d6", damageType: "bleed" });
});

test("конвертер: нет стадий, нет спасброска или вида — null", () => {
  assert.equal(parseAffliction("<p>The target is frightened.</p>", { name: "x" }), null);
  assert.equal(parseAffliction(SPIDER.replace("Saving Throw", "x").replace(/@Check\[[^\]]*\]/, ""), { name: "x", traits: ["poison"], condSlug }), null);
  assert.equal(parseAffliction(SPIDER, { name: "x", traits: [], condSlug, kind: "plague" }), null);
});

/* ---------- носитель, часы, откат ---------- */

function mkActor(uuid, name = uuid) {
  let n = 0;
  const items = Object.assign([], { has(id) { return items.some((i) => i.id === id); } });
  const actor = {
    uuid, name, id: uuid.split(".").pop(), level: 5, attributes: { immunities: [] }, items, rollOptions: {}, isDead: false, hasPlayerOwner: false,
    get itemTypes() { return { condition: items.filter((i) => i.type === "condition"), effect: items.filter((i) => i.type === "effect") }; },
    tokens: [], getActiveTokens() { return this.tokens; },
    getRollOptions: () => [], getSelfRollOptions: (p) => [`${p}:test`],
    async applyDamage({ damage }) { dealt.push(damage.f ?? damage); },
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: `i${++n}`, uuid: `${uuid}.Item.i${n}`, actor, parent: actor, isLocked: false, slug: d.system?.slug ?? d.name, _stats: d._stats ?? {} };
        it.toObject = () => ({ ...structuredClone({ name: it.name, type: it.type, system: it.system, flags: it.flags }), _id: it.id });
        it.delete = async () => { items.splice(items.indexOf(it), 1); };
        it.update = async (up, opts = {}) => { for (const [p, v] of Object.entries(up)) { const cur = foundry.utils.getProperty(it, p); setDeep(it, p, isPlain(v) && isPlain(cur) ? merge(cur, v) : structuredClone(v)); } it.lastOpts = opts; };
        uuids.set(it.uuid, it); items.push(it);
        return it;
      });
    },
    async deleteEmbeddedDocuments(_, ids) { for (const id of ids) items.splice(items.findIndex((i) => i.id === id), 1); }
  };
  uuids.set(uuid, actor);
  return actor;
}
const mkToken = (id, actor) => { const t = { id, uuid: `Scene.s.Token.${id}`, name: id, actor, disposition: -1 }; actor.tokens = [t]; uuids.set(t.uuid, t); return t; };
const mkMsg = (use) => {
  const m = { id: "M", flags: { [MOD]: { use } }, async update(d) { for (const [p, v] of Object.entries(d)) setDeep(m, p, v); } };
  msgs.set(m.id, m);
  return m;
};
const useOf = (rule, o = {}) => ({ actor: "Actor.author", token: null, item: { uuid: "Item.spider", name: "Spider Venom" }, rule, dc: null, targets: [{ key: "t1", uuid: "Scene.s.Token.t1" }], state: {}, ...o });
const carriers = (a) => a.items.filter((i) => i.flags?.[MOD]?.meta?.affliction);
const carrierOf = (a) => carriers(a)[0];
const condOf = (a, slug) => a.items.find((i) => i.type === "condition" && i.slug === slug);
const startStep = (def, stage = 1) => ({ to: "target", affliction: { stage, def: validate(chRule(def, stage)).rule.onUse.challenge.byDegree.failure[0].affliction.def } });
async function expose(victim, step, degree = 1, key = "M") {
  const rule = validate(chRule(step.affliction.def, step.affliction.stage)).rule;
  const m = mkMsg(useOf(rule));
  m.id = key; msgs.set(key, m);
  return { m, ops: await applyOps(m, "t1", [step], { scope: "challenge", degree, originActor: mkActor("Actor.author") }) };
}
const setup = () => { const v = mkActor("Actor.victim", "Гоблин"); mkToken("t1", v); return v; };

test("наложение: носитель — effect без срока, бейдж = стадия, meta, штрафы в rules, состояние и урон стадии, повтор шага — тишина", async () => {
  const v = setup();
  const def = DEF({ stages: [stg({ mods: [{ speed: { type: "status", value: -10 } }] }), stg()] });
  const step = startStep(def);
  const { m, ops } = await expose(v, step);
  const c = carrierOf(v), meta = c.flags[MOD].meta;
  assert.deepEqual(ops.map((o) => o.op), ["created"]);
  assert.deepEqual(c.system.badge, { type: "counter", value: 1, min: 1, max: 2, labels: null });
  assert.deepEqual(c.system.duration, { sustained: false, value: -1, unit: "unlimited", expiry: null });
  assert.equal(meta.key, "affl:spider-venom");
  assert.deepEqual([meta.affliction.nextAt, meta.affliction.endsAt, meta.affliction.dc, meta.affliction.applied], [1006, 1036, 22, 1]);
  assert.equal(c.system.rules.length, 1);
  assert.equal(c.system.rules[0].key, "FlatModifier");
  assert.equal(condOf(v, "sickened").flags[MOD].meta.key, "affl:spider-venom:1:sickened");
  assert.deepEqual(dealt, ["(1d10)[poison]"]);
  assert.equal((await applyOps(m, "t1", [step], { scope: "challenge", degree: 1 })).length, 0);   // тот же ключ шага
  assert.equal(v.items.filter((i) => i.type === "effect").length, 1);
  assert.equal(dealt.length, 1);
});

test("наложение: СЛ — из use.dc / результата цели, если в def её нет; нет СЛ вовсе — отказ с предупреждением", async () => {
  const v = setup();
  const def = DEF({ save: { statistic: "fortitude" } });
  const rule = validate(chRule(def)).rule, step = rule.onUse.challenge.byDegree.failure[0];
  rule.onUse.challenge.dc = { source: "spell" };   // СЛ из испытания не вычисляется: только снимок результата
  await applyOps(mkMsg(useOf(rule, { state: { challenge: { results: { t1: { degree: 1, dc: 31 } } } } })), "t1", [step], { scope: "challenge", degree: 1 });
  assert.equal(carrierOf(v).flags[MOD].meta.affliction.dc, 31);
  const v2 = setup(); mkToken("t1", v2);
  await applyOps(mkMsg(useOf(rule)), "t1", [step], { scope: "challenge", degree: 1 });
  assert.equal(carrierOf(v2), undefined);
  assert.deepEqual(warned, ["PF2E_AUTOMATO.apply.afflictionNoDC"]);
});

test("иммунитет цели к яду: недуг не создаётся", async () => {
  const v = setup();
  v.attributes.immunities = [{ type: "poison" }];
  await expose(v, startStep(DEF()));
  assert.equal(carrierOf(v), undefined);
  assert.deepEqual(warned, ["PF2E_AUTOMATO.apply.immune"]);
});

test("повторное воздействие: яд +1 (крит. +2) без сдвига endsAt, в onset тоже; болезнь и проклятие — skipped; ключ шага не прибавляет дважды", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ onset: { value: 1, unit: "hours" } })), 1, "M1");
  const meta = () => carrierOf(v).flags[MOD].meta.affliction;
  const ends = meta().endsAt;
  assert.deepEqual([meta().onsetEnds, meta().applied], [4600, null]);   // onset: эффектов нет
  assert.equal(condOf(v, "sickened"), undefined);
  assert.equal(dealt.length, 0);
  now = 1010;
  const r2 = await expose(v, startStep(DEF({ onset: { value: 1, unit: "hours" } })), 1, "M2");
  assert.deepEqual(r2.ops.map((o) => o.op), ["afflicted"]);
  assert.equal(carrierOf(v).system.badge.value, 2);
  assert.deepEqual([meta().endsAt, meta().onsetEnds, meta().applied], [ends, 4600, null]);
  const r3 = await expose(v, startStep(DEF({ onset: { value: 1, unit: "hours" } })), 0, "M3");   // крит. провал: +2, но потолок — 3
  assert.equal(carrierOf(v).system.badge.value, 3);
  assert.equal((await applyOps(r3.m, "t1", [startStep(DEF({ onset: { value: 1, unit: "hours" } }))], { scope: "challenge", degree: 0 })).length, 0);
  assert.equal(carrierOf(v).system.badge.value, 3);
  // болезнь
  const w = setup(); mkToken("t1", w);
  await expose(w, startStep(DEF({ kind: "disease", name: "Goblin Pox" })), 1, "D1");
  const again = await expose(w, startStep(DEF({ kind: "disease", name: "Goblin Pox" })), 0, "D2");
  assert.equal(again.ops.length, 0);
  assert.equal(carrierOf(w).system.badge.value, 1);
  assert.deepEqual(warned, ["PF2E_AUTOMATO.apply.afflictionTaken"]);
});

test("опознание по slug недуга, не по автору: другой NPC того же яда — тот же носитель; другой недуг — свой", async () => {
  const v = setup();
  await expose(v, startStep(DEF()), 1, "A1");
  const other = mkActor("Actor.other");
  const rule = validate(chRule(DEF(), 1)).rule, m = mkMsg(useOf(rule, { actor: "Actor.other" })); m.id = "A2"; msgs.set("A2", m);
  await applyOps(m, "t1", rule.onUse.challenge.byDegree.failure, { scope: "challenge", degree: 1, originActor: other });
  assert.equal(carriers(v).length, 1);
  assert.equal(carrierOf(v).system.badge.value, 2);
  await expose(v, startStep(DEF({ name: "Ghoul Fever", kind: "disease" })), 1, "A3");
  assert.equal(carriers(v).length, 2);
});

test("стадии: бейдж вверх применяет эффекты новой стадии, связанное состояние заменяется, нужное pf2e (sickened) только растёт; без урона при откате", async () => {
  const v = setup();
  const def = DEF({ stages: [stg({ conditions: [{ slug: "sickened", value: 1 }, { slug: "blinded" }] }), stg({ conditions: [{ slug: "sickened", value: 2 }, { slug: "dazzled" }] })] });
  await expose(v, startStep(def));
  assert.ok(v.items.some((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === "affl:spider-venom:1:L:blinded"));   // связанное — в обёртке
  const c = carrierOf(v);
  await run.applyStage(c, 2);
  assert.equal(v.items.some((i) => i.flags?.[MOD]?.meta?.key === "affl:spider-venom:1:L:blinded"), false);
  assert.equal(v.items.some((i) => i.flags?.[MOD]?.meta?.key === "affl:spider-venom:2:L:dazzled"), true);
  assert.equal(condOf(v, "sickened").flags[MOD].meta.key, "affl:spider-venom:1:sickened");
  assert.deepEqual(dealt, ["(1d10)[poison]", "(1d10)[poison]"]);
  const before = dealt.length;
  await run.applyStage(c, 1, { damage: false, from: 2 });   // откат
  assert.equal(dealt.length, before);
  assert.equal(c.flags[MOD].meta.affliction.applied, 1);
});

test("хук updateItem: клик ГМа по бейджу применяет стадию; свои update с флагом direct хук пропускает; снятие носителя уносит состояния по ключу", async () => {
  const v = setup();
  const h = {}; globalThis.Hooks = { on: (n, f) => { (h[n] ??= []).push(f); } };
  run.init();
  await expose(v, startStep(DEF()));
  const c = carrierOf(v), ch = (value) => ({ system: { badge: { value } } });
  const before = dealt.length;
  c.system.badge.value = 2;
  h.updateItem[0](c, ch(2), {}); await new Promise((r) => setTimeout(r, 20));
  assert.equal(dealt.length, before + 1);   // стадия 2: урон
  h.updateItem[0](c, ch(3), { [MOD]: { direct: true } }); await new Promise((r) => setTimeout(r, 20));
  assert.equal(dealt.length, before + 1);
  assert.equal(v.items.some((i) => i.flags?.[MOD]?.meta?.key?.startsWith("affl:spider-venom:")), true);
  await c.delete();
  h.deleteItem[0](c); await new Promise((r) => setTimeout(r, 20));
  assert.equal(v.items.length, 0);
  delete globalThis.Hooks;
});

/* часы: карточка спасброска, pending, пропуск времени, конец срока, onset */

const cards = () => created.filter((m) => m.flags?.[MOD]?.use?.state?.event);

test("тик: на конце интервала — одна карточка (СЛ из снимка, все степени = stageDelta), pending не даёт вторую, nextAt сдвинут", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null })));
  await run.tick(v, "e1");
  assert.equal(cards().length, 0);   // интервал не вышел
  now = 1006;
  await run.tick(v, "e2");
  assert.equal(cards().length, 1);
  const use = cards()[0].flags[MOD].use, ch = use.rule.onUse.challenge, meta = carrierOf(v).flags[MOD].meta.affliction;
  assert.deepEqual([ch.statistic, ch.dc, use.dc, use.item.name], ["fortitude", { value: 22 }, 22, "Spider Venom"]);
  assert.deepEqual(Object.keys(ch.byDegree).sort(), ["criticalFailure", "criticalSuccess", "failure", "success"]);
  assert.deepEqual(ch.byDegree.success, [{ to: "target", stageDelta: { slug: "spider-venom" } }]);
  assert.deepEqual([meta.pending.key, meta.nextAt], [`e2:${carrierOf(v).uuid}:affliction`, 1012]);
  now = 1012;
  await run.tick(v, "e3");   // карточка без результата: нового броска нет
  assert.equal(cards().length, 1);
});

test("пропуск времени (8 ч за раз): одна карточка, пропущенные интервалы не догоняем; конец срока важнее броска", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null })));
  now = 1000 + 8 * 3600;
  await run.tick(v, "s1");
  assert.equal(cards().length, 1);
  assert.equal(carrierOf(v).flags[MOD].meta.affliction.nextAt, now + 6);
  const w = setup(); mkToken("t1", w);
  await expose(w, startStep(DEF({ name: "Short", maxDuration: { value: 2, unit: "rounds" } })), 1, "S2");
  now += 3600;
  const n = created.length;
  await run.tick(w, "s2");
  assert.equal(carrierOf(w), undefined);   // срок вышел: снят, карточка-сообщение «закончился», броска нет
  assert.equal(cards().length, 1);
  assert.equal(created.length, n + 1);
});

test("onset: до срока эффектов нет и карточек нет; после — стадия применяется, затем бросок по nextAt", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null, onset: { value: 1, unit: "hours" } })));
  now = 3000;
  await run.tick(v, "o1");
  assert.deepEqual([created.length, dealt.length], [0, 0]);
  now = 4600;
  await run.tick(v, "o2");
  assert.equal(dealt.length, 1);
  assert.equal(carrierOf(v).flags[MOD].meta.affliction.applied, 1);
  assert.equal(cards().length, 0);
  now = 4606;
  await run.tick(v, "o3");
  assert.equal(cards().length, 1);
});

test("mode.challenge=off и мёртвая цель: карточек нет", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null })));
  now = 1006; settings["mode.challenge"] = "off";
  await run.tick(v, "m1");
  assert.equal(cards().length, 0);
  settings["mode.challenge"] = "auto"; v.isDead = true;
  await run.tick(v, "m2");
  assert.equal(cards().length, 0);
});

test("хуки времени: конец хода участника боя тикает, вне боя — updateWorldTime; бой не стартовал — как вне боя", async () => {
  const v = setup();
  game.actors = Object.assign([v], { has: () => true });
  const h = {}; globalThis.Hooks = { on: (n, f) => { (h[n] ??= []).push(f); } };
  run.init();
  await expose(v, startStep(DEF({ maxDuration: null })));
  now = 1006;
  game.combats = [{ started: true, combatants: [{ actor: { uuid: v.uuid } }] }];
  h.updateWorldTime[0](); await new Promise((r) => setTimeout(r, 20));
  assert.equal(cards().length, 0);   // участник боя ждёт конца своего хода
  await h["pf2e.endTurn"][0]({ id: "c1", actor: v }, { id: "E", round: 2, turn: 0 }); await new Promise((r) => setTimeout(r, 20));
  assert.equal(cards().length, 1);
  game.combats = []; run.resetTracked();
  now = 1012; carrierOf(v).flags[MOD].meta.affliction.pending = null;
  h.updateWorldTime[0](); await new Promise((r) => setTimeout(r, 20));
  assert.equal(cards().length, 2);
  delete globalThis.Hooks;
});

/* результат броска: stageDelta, откат */

const delta = (step, degree, key) => ({ to: "target", stageDelta: { slug: "spider-venom" }, ...step, key });
async function resolveCard(v, degree, id = "R1") {
  const m = mkMsg(useOf({ v: 1, onUse: { targets: "selected", challenge: A.afflictionChallenge(carrierOf(v).flags[MOD].meta.affliction) } }));
  m.id = id; msgs.set(id, m);
  return { m, ops: await applyOps(m, "t1", [{ to: "target", stageDelta: { slug: "spider-venom" } }], { scope: "challenge", degree }) };
}

test("stageDelta в карточке: успех −1 (с 2 на 1), провал +1, повтор того же ключа — тишина; часы пересчитываются по новой стадии, pending сброшен", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null }), 2));
  const meta = () => carrierOf(v).flags[MOD].meta.affliction;
  now = 1006; await run.tick(v, "t1");
  assert.ok(meta().pending);
  now = 1007;
  const r = await resolveCard(v, 2);
  assert.deepEqual(r.ops.map((o) => o.op), ["afflicted"]);
  assert.equal(carrierOf(v).system.badge.value, 1);
  assert.deepEqual([meta().pending, meta().nextAt, meta().applied], [null, 1013, 1]);
  assert.equal((await applyOps(r.m, "t1", [{ to: "target", stageDelta: { slug: "spider-venom" } }], { scope: "challenge", degree: 2 })).length, 0);
  assert.equal(carrierOf(v).system.badge.value, 1);
  const f = await resolveCard(v, 1, "R2");
  assert.equal(carrierOf(v).system.badge.value, 2);
  assert.equal(f.ops.length, 1);
});

test("провал на высшей стадии повторяет её урон; успех на первой снимает носитель и всё созданное, откат возвращает недуг без урона", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null }), 3));
  const dmg0 = dealt.length;
  await resolveCard(v, 1);   // 3 -> 3, повтор
  assert.equal(carrierOf(v).system.badge.value, 3);
  assert.equal(dealt.length, dmg0);   // у стадии 3 урона нет в DEF; повтор отработал без ошибки
  const w = setup(); mkToken("t1", w);
  await expose(w, startStep(DEF({ maxDuration: null }), 1), 1, "W1");
  assert.equal(dealt.length, dmg0 + 1);
  const h = {}; globalThis.Hooks = { on: (n, f) => { (h[n] ??= []).push(f); } };
  run.init();
  const ok = await resolveCard(w, 3, "W2");
  assert.deepEqual(ok.ops.map((o) => o.op), ["afflCleared"]);
  assert.equal(carrierOf(w), undefined);
  h.deleteItem[0]({ parent: w, flags: { [MOD]: { meta: { affliction: { slug: "spider-venom" } } } }, type: "effect" }); await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.items.length, 0);   // и состояние стадии ушло по ключу
  await undoOps(ok.m, "t1");
  assert.equal(carrierOf(w).system.badge.value, 1);
  assert.equal(condOf(w, "sickened")?.flags[MOD].meta.key, "affl:spider-venom:1:sickened");
  assert.equal(dealt.length, dmg0 + 1);   // без повторного урона
  delete globalThis.Hooks;
});

test("откат afflicted: стадия, streak, nextAt и pending возвращаются; virulent копит streak", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null, virulent: true }), 2));
  const meta = () => carrierOf(v).flags[MOD].meta.affliction;
  now = 1006; await run.tick(v, "u1");
  const pend = meta().pending;
  const r1 = await resolveCard(v, 2, "V1");   // первый успех virulent: стадия та же, streak 1
  assert.deepEqual([carrierOf(v).system.badge.value, meta().streak], [2, 1]);
  await undoOps(r1.m, "t1");
  assert.deepEqual([carrierOf(v).system.badge.value, meta().streak, meta().pending], [2, 0, pend]);
  assert.equal(meta().nextAt, 1012);
  await resolveCard(v, 2, "V2"); await resolveCard(v, 2, "V3");   // два успеха подряд: −1
  assert.equal(carrierOf(v).system.badge.value, 1);
  assert.equal(meta().streak, 0);
});

/* ---------- вывод из разметки и конвейер ---------- */

test("deriveFromMarkup: текст со стадиями — правило low (lowWhy: affliction), не вешается автоматически", async () => {
  const { readFileSync } = await import("node:fs");
  const labels = JSON.parse(readFileSync(new URL("../rules/labels.json", import.meta.url), "utf8"));
  const d = rules.deriveFromMarkup({ type: "consumable", name: "Spider Venom", system: { description: { value: SPIDER } } }, labels, condSlug, []);
  assert.equal(d.confidence, "low");
  assert.ok(d.hints.lowWhy.includes("affliction"));
});

test("validate.mjs: на тексте со стадиями null и правило без недуга — ошибка; голова испытания от модели достраивается кодом до недуга", async () => {
  const { checkAnswer } = await import("../tools/validate.mjs");
  const ids = { sickened: "a", clumsy: "b", fatigued: "c" };
  const refs = { conditions: Object.fromEntries(Object.entries(ids).map(([s, id]) => [s, { id }])), effects: {} };
  const html = SPIDER.replace(/conditionitems\.Item\.(sickened|clumsy)\]/g, (_m, s) => `conditionitems.Item.${ids[s]}]`);
  assert.equal(checkAnswer({ uuid: "u", rule: null, unsure: false }, refs, html).kind, "error");
  const head = { v: 1, label: "Spider Venom", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 22 }, byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } } };
  const r = checkAnswer({ uuid: "u", rule: head, unsure: false }, refs, html, { type: "consumable", traits: ["poison"] });   // вид недуга — из трейтов предмета
  assert.equal(r.kind, "accepted");
  const by = r.rule.onUse.challenge.byDegree;
  assert.deepEqual([by.failure[0].affliction.stage, by.failure[0].affliction.def.stages.length, by.criticalFailure[0].affliction.stage], [1, 3, 2]);
  assert.equal(checkAnswer({ uuid: "u", rule: head, unsure: false }, refs, "<p>Failure: sickened 1</p>").kind, "accepted");   // текст без стадий — как раньше
});

/* ---------- замечания Критика ---------- */

test("откат: состояния, созданные отменяемой стадией, снимаются (и при первом наложении); поднятое возвращается к прежнему значению", async () => {
  const v = setup();
  const def = DEF({ stages: [stg({ conditions: [{ slug: "sickened", value: 1 }] }), stg({ conditions: [{ slug: "sickened", value: 1 }, { slug: "frightened", value: 1 }] })] });
  const step = startStep(def);
  const { m: m1 } = await expose(v, step, 1, "M1");
  const { m: m2 } = await expose(v, step, 1, "M2");   // повторное воздействие ядом: стадия 2, создан frightened
  assert.equal(carrierOf(v).system.badge.value, 2);
  assert.ok(condOf(v, "frightened"));
  await undoOps(m2, "t1");
  assert.equal(condOf(v, "frightened"), undefined);
  assert.ok(condOf(v, "sickened"));
  assert.equal(carrierOf(v).system.badge.value, 1);
  await undoOps(m1, "t1");   // первое наложение: носитель и созданное стадией 1 уходят (хука deleteItem в тесте нет)
  assert.equal(v.items.length, 0);
  // поднятое по max: откат возвращает prev
  const raised = [];
  game.pf2e.ConditionManager.updateConditionValue = async (id, actor, val) => { raised.push([id, val]); };
  const cond = mkActor("Actor.other").createEmbeddedDocuments("Item", [{ name: "sickened", type: "condition", system: { slug: "sickened" } }]);
  const [it] = await cond;
  await run.afflictionUnmake([{ item: it.uuid, prev: 1 }]);
  delete game.pf2e.ConditionManager.updateConditionValue;
  assert.deepEqual(raised, [[it.id, 1]]);
});

test("откат и повторное «Применить»: урон стадии второй раз не наносится (журнал state.damaged сообщения)", async () => {
  const v = setup();
  const step = startStep(DEF());
  const { m } = await expose(v, step);
  assert.equal(dealt.length, 1);
  await undoOps(m, "t1");
  assert.equal(v.items.length, 0);
  await applyOps(m, "t1", [step], { scope: "challenge", degree: 1, originActor: mkActor("Actor.author") });
  assert.equal(carrierOf(v).system.badge.value, 1);
  assert.equal(dealt.length, 1);
});

test("гонка: два одновременных наложения — один носитель; два тика подряд — одна карточка", async () => {
  const v = setup();
  const step = startStep(DEF({ maxDuration: null }));
  await Promise.all([expose(v, step, 1, "M1"), expose(v, step, 1, "M2")]);
  assert.equal(carriers(v).length, 1);
  assert.equal(carrierOf(v).system.badge.value, 2);   // второй шаг — повторное воздействие ядом
  now = 1012;
  await Promise.all([run.tick(v, "a"), run.tick(v, "b")]);
  assert.equal(cards().length, 1);
});

test("pending помнит id карточки: жива — нового броска нет; карточку удалили — на конце интервала бросок заново", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null })));
  now = 1006; await run.tick(v, "p1");
  const id = carrierOf(v).flags[MOD].meta.affliction.pending.msg;
  assert.equal(id, cards()[0].id);
  now = 1012; await run.tick(v, "p2");
  assert.equal(cards().length, 1);
  msgs.delete(id);
  now = 1018; await run.tick(v, "p3");
  assert.equal(cards().length, 2);
});

test("validate.mjs: недуг с неразобранным текстом стадии — unsure (на Sonnet); «XdY тип» без слова damage разбирается", async () => {
  const { checkAnswer } = await import("../tools/validate.mjs");
  const ids = { sickened: "a", clumsy: "b", fatigued: "c" };
  const refs = { conditions: Object.fromEntries(Object.entries(ids).map(([s, id]) => [s, { id }])), effects: {} };
  const html = SPIDER.replace(/conditionitems\.Item\.(sickened|clumsy)\]/g, (_m, s) => `conditionitems.Item.${ids[s]}]`);
  const head = { v: 1, label: "Spider Venom", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 22 }, byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } } };
  const odd = html.replace("<strong>Stage 1</strong>", "<strong>Stage 1</strong> the target hums a sad tune and");
  const r = checkAnswer({ uuid: "u", rule: head, unsure: false }, refs, odd, { type: "consumable", traits: ["poison"] });
  assert.equal(r.kind, "unsure");
  assert.equal(checkAnswer({ uuid: "u", rule: head, unsure: false }, refs, html, { type: "consumable", traits: ["poison"] }).kind, "accepted");
  const plain = parseAffliction(SPIDER.replace("@Damage[1d10[poison]] damage", "1d10 poison"), { name: "Spider Venom", traits: ["poison"], condSlug });
  assert.deepEqual(plain.def.stages[0].damage, [{ formula: "1d10", damageType: "poison" }]);
});

test("раунд недуга берётся из CONFIG.time.roundTime", () => {
  CONFIG.time = { roundTime: 10 };
  assert.equal(A.secondsOf({ value: 2, unit: "rounds" }), 20);
  delete CONFIG.time;
  assert.equal(A.secondsOf({ value: 2, unit: "rounds" }), 12);
});

// Находки Критика по пакету недугов: срок стадии, Onset, второй @Check, текст вне стадий, injury
const P = (html, o = {}) => parseAffliction(html, { name: "X", traits: ["poison"], condSlug, ...o });
const stage = (n, body) => `<p><strong>Stage ${n}</strong> ${body}</p>`;
const SV = `<p><strong>Saving Throw</strong> @Check[fortitude|dc:20]</p>`;

test("«As stage N» без своего срока наследует срок названной стадии; свой срок сохраняется", () => {
  const h = SV + `<p><strong>Maximum Duration</strong> 6 rounds</p>` + stage(1, `@Damage[1d6[poison]] damage (1 round)`) + stage(2, "As stage 1") + stage(3, `@Damage[2d6[poison]] damage (2 rounds)`);
  const r = P(h);
  assert.deepEqual(r.def.stages.map((s) => s.duration), [{ value: 1, unit: "rounds" }, { value: 1, unit: "rounds" }, { value: 2, unit: "rounds" }]);
  assert.deepEqual(r.unsure, []);
});

test("стадия без срока: срок соседа, если однозначен; иначе в долг; конец без срока — только болезнь без Maximum Duration", () => {
  const mk = (max, ...ss) => SV + (max ? `<p><strong>Maximum Duration</strong> 6 rounds</p>` : "") + ss.map((b, i) => stage(i + 1, b)).join("");
  const d = "@Damage[1d6[poison]] damage";
  assert.deepEqual(P(mk(true, `${d} (1 round)`, `${d} (1 round)`, d)).def.stages[2].duration, { value: 1, unit: "rounds" });
  assert.deepEqual(P(mk(true, `${d} (1 round)`, `${d} (2 rounds)`, d)).unsure, ["duration: stage 3 has none, neighbours differ"]);
  assert.deepEqual(P(mk(true, d, d)).unsure, ["duration: no stage has one"]);
  assert.deepEqual(P(mk(false, `${d} (1 round)`, d)).def.stages[1].duration, { value: 1, unit: "rounds" });   // яд: конечной стадии без срока нет
  const dis = P(mk(false, `${d} (1 day)`, `${d} (1 day)`, d), { traits: ["disease"] });
  assert.equal(dis.def.stages[2].duration, null);
  assert.deepEqual(dis.unsure, []);
  assert.deepEqual(P(mk(false, d, d, d), { traits: ["disease"] }).unsure, ["duration: no stage has one"]);
});

test("Onset не числом, второй @Check в голове и механика вне стадий — unsure; вводное описание допустимо", () => {
  const st = stage(1, `@Damage[1d6[poison]] damage (1 round)`) + stage(2, `@Damage[2d6[poison]] damage (1 round)`);
  const ok = `<p>A bitter poison.</p><hr />` + SV + `<p><strong>Onset</strong> 1 round</p>` + st;
  assert.deepEqual(P(ok).unsure, []);
  assert.deepEqual(P(ok).def.onset, { value: 1, unit: "rounds" });
  assert.match(P(ok.replace("1 round</p>", "[[/gmr 1d4 #days]]{1d4 days}</p>")).unsure[0], /^onset:/);
  assert.match(P(SV.replace("</p>", " @Check[will|dc:21]</p>") + st).unsure[0], /second save check/);
  assert.match(P(`<p>Any drained value is reduced by 1 every hour.</p>` + SV + st).unsure[0], /^text outside stages/);
  assert.match(P(SV + st + `<p><strong>Note</strong> The clumsy condition persists.</p>`).unsure[0], /^text outside stages/);
});

test("checkAffliction: срок null при Maximum Duration, потерянный Onset, второй @Check, текст вне стадий", async () => {
  const { checkAffliction } = await import("../tools/affliction-batch.mjs");
  const st = stage(1, `@Damage[1d6[poison]] damage (1 round)`) + stage(2, `@Damage[2d6[poison]] damage (1 round)`);
  const html = SV + `<p><strong>Maximum Duration</strong> 6 rounds</p>` + st;
  const item = { traits: ["poison"] }, refs = { conditions: {}, effects: {} };
  const rule = afflictionRule(html, { name: "X", traits: ["poison"], condSlug }).rule;
  assert.deepEqual(checkAffliction(rule, html, item, refs), []);
  const bad = structuredClone(rule);
  bad.onUse.challenge.byDegree.failure[0].affliction.def.stages[1].duration = null;
  assert.ok(checkAffliction(bad, html, item, refs).some((x) => /duration null/.test(x)));
  assert.ok(checkAffliction(rule, html.replace("<p><strong>Maximum", "<p><strong>Onset</strong> 1d4 days</p><p><strong>Maximum"), item, refs).includes("onset lost"));
  assert.ok(checkAffliction(rule, html.replace(SV, SV.replace("</p>", " @Check[will|dc:21]</p>")), item, refs).includes("second save check in head"));
  assert.ok(checkAffliction(rule, html + `<p>Any drained value is reduced by 1 every hour.</p>`, item, refs).some((x) => /^text outside stages/.test(x)));
});

test("coatEntry: чистый недуг injury -> coat-запись каталога; не-недуг и gate/coatArm не проходят", async () => {
  const { coatEntry } = await import("../tools/affliction-batch.mjs");
  const st = stage(1, `@Damage[1d6[poison]] damage (1 round)`) + stage(2, `@Damage[2d6[poison]] damage (1 round)`);
  const html = SV + st, refs = { conditions: {}, effects: {} };
  const rule = afflictionRule(html, { name: "X", traits: ["poison", "injury"], condSlug }).rule;
  const { rule: c, why } = coatEntry(rule, html, refs);
  assert.equal(why, undefined);
  assert.equal(c.onUse.challenge, null);
  assert.equal(c.onUse.apply[0].coat.weapon, "choose");
  assert.ok(c.onUse.apply[0].coat.challenge.byDegree.failure[0].affliction);
  assert.equal(rules.validateRule(c).ok, true);
  assert.match(coatEntry({ v: 1, onUse: { targets: "self", apply: [] } }, html, refs).why, /^coat:/);
});

test("coatEntry: semanticErrors (gate/coatArm в каталоге) -> отказ coat:, черты испытания poison+injury", async () => {
  const { coatEntry } = await import("../tools/affliction-batch.mjs");
  const st = stage(1, `@Damage[1d6[poison]] damage (1 round)`) + stage(2, `@Damage[2d6[poison]] damage (1 round)`);
  const html = SV + st, refs = { conditions: {}, effects: {} };
  const rule = afflictionRule(html, { name: "X", traits: ["poison", "injury"], condSlug }).rule;
  const ok = coatEntry(rule, html, refs).rule;
  assert.deepEqual(ok.onUse.apply[0].coat.challenge.traits, ["poison", "injury"]);
  const bad = structuredClone(ok);
  bad.onUse.apply[0].coat.coatArm = true;
  bad.onEvent = [{ when: "x", gate: ["target"], apply: [] }];
  const { semanticErrors } = await import("../tools/validate.mjs");
  assert.ok((semanticErrors(bad, refs, html) ?? []).length, "gate/coatArm запрещены каталогу");
  assert.match(coatEntry({ ...rule, onEvent: [{ when: "x", gate: ["target"], apply: [] }] }, html, refs).why, /^coat:/);
});

test("parseStage: «@Damage … or @Damage» и абзац заражения — неразобранный остаток", () => {
  const alt = stage(1, `@Damage[1d6[poison]] or @Damage[1d6[vitality]]{vitality} damage (1 round)`) + stage(2, `@Damage[2d6[poison]] damage (1 round)`);
  assert.match(P(SV + alt).unsure[0], /^stage 1/);
  const st = stage(1, `@Damage[1d6[poison]] damage (1 round)`) + stage(2, `@Damage[2d6[poison]] damage (1 round)`);
  assert.match(P(`<p>While poisoned, the first time per round the victim succeeds at an unarmed attack, the target is exposed.</p>` + SV + st).unsure[0], /^text outside stages/);
});

/* def.note: схема, показ по настройке, конечная стадия */

test("def.note: обрезается до 1200 с «…», пробелы по краям снимаются, пустая и нестрока — ошибка/пропуск", () => {
  const note = (n) => validate(chRule(DEF({ note: n }))).rule?.onUse.challenge.byDegree.failure[0].affliction.def.note;
  assert.equal(note("  Cannot be removed.  "), "Cannot be removed.");
  assert.equal(note("x".repeat(1500)).length, 1200);
  assert.equal(note("x".repeat(1500)).endsWith("…"), true);
  assert.equal(note("   "), undefined);
  assert.equal(validate(chRule(DEF({ note: "" }))).ok, true);   // пустая строка не роняет правило
  assert.deepEqual(validate(chRule(DEF({ note: 5 }))).errors.map((e) => e.key), ["afflict.def"]);
});

test("заметка: публично — в описании носителя и первой карточке стадии (один раз); шёпотом — не в описании, отдельная карточка ГМу", async () => {
  const mk = async (mode) => {
    const v = setup(); settings["affliction.noteMode"] = mode;
    await expose(v, startStep(DEF({ note: "Mark death <b>here</b>." })));
    return v;
  };
  let v = await mk("public");
  const desc = carrierOf(v).system.description.value, stageCards = created.filter((m) => /paf-card/.test(m.content ?? ""));
  assert.match(desc, /Mark death &lt;b&gt;here&lt;\/b&gt;\./);
  assert.equal(stageCards.length, 1);
  assert.match(stageCards[0].content, /Mark death/);
  assert.equal(stageCards[0].whisper, undefined);
  await run.applyStage(carrierOf(v), 2);   // вторая стадия — без заметки
  assert.equal(created.filter((m) => /Mark death/.test(m.content ?? "")).length, 1);

  created.length = 0; v = await mk("gm");
  assert.doesNotMatch(carrierOf(v).system.description.value, /Mark death/);
  const w = created.filter((m) => /Mark death/.test(m.content ?? ""));
  assert.equal(w.length, 1);
  assert.ok(Array.isArray(w[0].whisper));
  delete settings["affliction.noteMode"];
});

test("конечная стадия (смерть): без срока и без maxDuration бросков нет, носитель не удаляется даже через сутки", async () => {
  const v = setup();
  await expose(v, startStep(DEF({ maxDuration: null }), 3));
  const m = carrierOf(v).flags[MOD].meta.affliction;
  assert.deepEqual([m.nextAt, m.endsAt], [null, null]);
  const before = created.length;
  now = 1000 + 24 * 3600;
  await run.tick(v, "f1");
  assert.equal(cards().length, 0);
  assert.equal(created.length, before);
  assert.equal(carriers(v).length, 1);
});
