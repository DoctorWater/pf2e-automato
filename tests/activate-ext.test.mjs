// activate-ext (plan-activate-ext.md §6 п.1): свой срок и иммунитет записи активации — схема, форма, наложение на правило заклинания, предупреждения.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRule, withActivation } from "../scripts/rules.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { checkAnswer, extraKeys, roundTrip, activationWarnings } from "../tools/validate.mjs";

const SPELL = "Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6";
const dur = { value: 1, unit: "minutes" };
const imm = { slug: "dominate", label: "Dominate", duration: { value: 24, unit: "hours" }, degrees: ["success", "criticalSuccess"] };
const act = (e) => ({ v: 1, activate: [{ id: "a", spell: SPELL, ...e }] });
const ok = (raw) => { const r = validateRule(raw); assert.ok(r.ok, r.errors?.join("; ")); return r.rule; };
const any = new Proxy({}, { get: () => true });

test("validateRule: duration и immunity записи и варианта переживают нормализацию", () => {
  const r = ok(act({ duration: dur, immunity: imm })).activate[0];
  assert.deepEqual(r.duration, { ...dur, expiry: null });
  assert.deepEqual(r.immunity, imm);
  const v = ok({ v: 1, activate: [{ id: "x", label: "X", choices: [{ id: "c1", spell: SPELL, duration: { value: 0, unit: "rounds", expiry: "turn-end" }, immunity: imm }, { id: "c2", spell: SPELL }] }] }).activate[0].choices;
  assert.deepEqual(v[0].duration, { value: 0, unit: "rounds", expiry: "turn-end" });
  assert.deepEqual(v[0].immunity, imm);
  assert.equal("duration" in v[1], false);
  assert.equal(ok(act({ duration: { value: "1D4", unit: "hours" } })).activate[0].duration.value, "1d4");
});

test("validateRule: без spell и с кривыми значениями — ошибка", () => {
  const onUse = { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] };
  for (const e of [{ duration: dur }, { immunity: imm }]) {
    assert.equal(validateRule({ v: 1, activate: [{ id: "a", label: "A", onUse, ...e }] }).ok, false);
    assert.equal(validateRule({ v: 1, activate: [{ id: "x", label: "X", choices: [{ id: "c1", label: "C", onUse, ...e }, { id: "c2", spell: SPELL }] }] }).ok, false);
  }
  for (const d of [{ value: 0, unit: "rounds" }, { value: 1, unit: "years" }, { value: 1, unit: "rounds", expiry: "now" }, { value: 1, unit: "rounds", of: "origin" }, "1 minute"]) assert.equal(validateRule(act({ duration: d })).ok, false, JSON.stringify(d));
  assert.equal(validateRule(act({ immunity: { slug: "x" } })).ok, false);   // ни uuid, ни срока
});

test("форма <-> правило: duration и immunity записи и варианта без потерь", () => {
  const rules = [
    ok(act({ duration: dur, immunity: imm })),
    ok(act({ duration: { value: 0, unit: "rounds", expiry: "turn-end" } })),
    ok(act({ duration: { value: "1d4", unit: "hours" } })),
    ok({ v: 1, activate: [{ id: "x", label: "X", choices: [{ id: "c1", spell: SPELL, duration: dur, immunity: imm }, { id: "c2", spell: SPELL }] }] })
  ];
  for (const r of rules) {
    assert.deepEqual(validateRule(formToRule(ruleToForm(r))).rule, r);
    assert.ok(roundTrip(r));
  }
});

// правило заклинания: шаги с состоянием/эффектом в apply и byDegree, со всеми «не трогать»
const spell = () => ({
  v: 1,
  onUse: {
    targets: "selected",
    apply: [
      { to: "target", condition: { slug: "invisible" }, duration: { value: 10, unit: "minutes", expiry: null, of: "target" } },
      { to: "target", effect: { uuid: "Compendium.pf2e.spell-effects.Item.aaaaaaaaaaaaaaaa" } },
      { to: "target", condition: { slug: "frightened", value: 2 }, rank: { min: 5 } },
      { to: "self", note: "n" },
      { to: "target", removeEffect: { uuid: "Compendium.pf2e.spell-effects.Item.bbbbbbbbbbbbbbbb" } }
    ],
    challenge: {
      statistic: "will", dc: { source: "spell" },
      byDegree: {
        success: [{ to: "target", condition: { slug: "stunned", value: 1 } }],
        failure: [
          { to: "target", condition: { slug: "controlled" }, repeat: { on: "turn-end", end: ["success", "criticalSuccess"] } },
          { to: "target", condition: { slug: "frightened", value: 1, policy: "reduce" } },
          { to: "target", condition: { slug: "slowed", value: 1 } }
        ]
      }
    }
  }
});
const checkSpell = () => ok({ v: 1, onUse: { targets: "selected", check: { statistic: "deception", vs: { defense: "will" }, byDegree: { success: [{ to: "target", condition: { slug: "dazzled" } }] } } } });
const base = () => ok(spell());

test("withActivation: срок на apply, challenge.byDegree, check.byDegree; пропуски и of", () => {
  const rule = base(), r = withActivation(rule, { duration: dur });
  const d = { value: 1, unit: "minutes", expiry: null };
  const [a0, a1, a2, a3, a4] = r.onUse.apply;
  assert.deepEqual(a0.duration, { ...d, of: "target" });   // свой of шага сохраняется
  assert.deepEqual(a1.duration, d);                        // effect по uuid: of нет
  assert.deepEqual(a2.duration, { ...d, of: "origin" });   // condition: origin по умолчанию
  assert.deepEqual(a2.rank, { min: 5 });                   // гейт ранга цел
  assert.equal(a3.duration, undefined);                    // note
  assert.equal(a4.duration, undefined);                    // removeEffect
  const f = r.onUse.challenge.byDegree;
  assert.deepEqual(f.success[0].duration, { ...d, of: "origin" });
  assert.equal(f.failure[0].duration, undefined);          // repeat
  assert.equal(f.failure[1].duration, undefined);          // reduce
  assert.deepEqual(f.failure[2].duration, { ...d, of: "origin" });
  assert.deepEqual(withActivation(checkSpell(), { duration: dur }).onUse.check.byDegree.success[0].duration, { ...d, of: "origin" });
  assert.ok(validateRule(r).ok, "результат остаётся валидным правилом");
});

test("withActivation: inline-эффект с mods получает of", () => {
  const rule = ok({ v: 1, onUse: { targets: "self", apply: [{ to: "self", effect: { mods: [{ bonus: { target: "will", type: "status", value: -2 } }] }, duration: { value: 1, unit: "rounds", expiry: "turn-start" } }] } });
  const r = withActivation(rule, { duration: dur });
  assert.deepEqual(r.onUse.apply[0].duration, { value: 1, unit: "minutes", expiry: null, of: "origin" });
  assert.ok(validateRule(r).ok);
});

test("withActivation: immunity кладётся в challenge, запись сильнее правила; нет challenge — то же правило", () => {
  const own = { slug: "own", duration: { value: 1, unit: "hours" } };
  const rule = base();
  rule.onUse.challenge.immunity = own;
  assert.deepEqual(withActivation(rule, { immunity: imm }).onUse.challenge.immunity, imm);
  assert.deepEqual(rule.onUse.challenge.immunity, own);
  const noCh = ok({ v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } });
  assert.deepEqual(withActivation(noCh, { immunity: imm }), noCh);
  assert.equal(withActivation(noCh, undefined), noCh);
  assert.equal(withActivation(noCh, { dc: 20, rank: 3 }), noCh);   // в метке нет duration/immunity — то же правило
  assert.equal(withActivation(null, { duration: dur }), null);
});

test("withActivation: исходное правило не мутируется, результат — другой объект", () => {
  const rule = base(), before = structuredClone(rule);
  const r = withActivation(rule, { duration: dur, immunity: imm });
  assert.notEqual(r, rule);
  assert.deepEqual(rule, before);
  assert.notEqual(r.onUse, rule.onUse);
  assert.notEqual(r.onUse.apply[0], rule.onUse.apply[0]);
});

test("extraKeys: duration/immunity записи и варианта не отбрасываются; чужой ключ — отбрасывается", () => {
  const raw = { v: 1, activate: [{ id: "a", spell: SPELL, duration: dur, immunity: imm }, { id: "x", label: "X", choices: [{ id: "c1", spell: SPELL, duration: dur, immunity: imm }, { id: "c2", spell: SPELL }] }] };
  assert.deepEqual(extraKeys(raw, validateRule(raw).rule), []);
  const bad = structuredClone(raw);
  bad.activate[0].durationn = dur;
  assert.deepEqual(extraKeys(bad, validateRule(bad).rule), [".activate[0].durationn"]);
  assert.equal(checkAnswer({ uuid: "u", rule: raw }, { conditions: any, effects: any }).kind, "accepted");
});

test("activationWarnings: нет правила / нет challenge / нет применимых шагов — предупреждения, не ошибки", () => {
  const rule = ok(act({ duration: dur, immunity: imm }));
  assert.equal(validateRule(rule).ok, true);
  const w = (sr) => activationWarnings(rule, () => sr);
  assert.equal(w(null).length, 1);
  assert.equal(w(base()).length, 1);   // base: есть шаг с repeat — предупреждение
  assert.deepEqual(w(ok({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { source: "spell" }, byDegree: { failure: [{ to: "target", condition: { slug: "slowed", value: 1 } }] } } } })), []);
  const bare = ok({ v: 1, onUse: { targets: "self", apply: [{ to: "self", note: "n" }] } });
  assert.equal(w(bare).length, 2);   // и срок, и иммунитет без носителя
  const reduceOnly = ok({ v: 1, onUse: { targets: "self", challenge: { statistic: "will", dc: { value: 20 }, byDegree: { failure: [{ to: "target", condition: { slug: "frightened", policy: "reduce" } }] } } } });
  assert.match(w(reduceOnly).join(), /duration/);
  assert.deepEqual(activationWarnings(ok(act({})), () => null), []);   // без полей предупреждать не о чем
});

test("withActivation на сыром правиле каталога: Heroism (PA, bySource) и Invisibility (bySlug) — валидно, вход не мутирован", () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../rules/${f}`, import.meta.url), "utf8"));
  const heroism = read("catalog.pa.json").bySource["Compendium.pf2e.spells-srd.Item.KqvqNAfGIE5a9wSv"], invis = read("catalog.json").bySlug.invisibility;
  for (const raw of [heroism, invis]) {
    const before = structuredClone(raw), r = withActivation(raw, { duration: dur });
    assert.notEqual(r, raw);
    assert.deepEqual(raw, before);
    assert.ok(validateRule(r).ok, validateRule(r).errors?.join("; "));
    assert.notDeepEqual(r, raw, "срок реально наложился");
  }
});

test("activationWarnings: шаг с repeat среди прочих и затирание собственного иммунитета правила", () => {
  const rule = ok(act({ duration: dur, immunity: imm }));
  const w = activationWarnings(rule, () => base());   // в base есть и repeat-шаг, и другие
  assert.ok(w.some((x) => /repeat/.test(x)), w.join());
  const stench = JSON.parse(readFileSync(new URL("../rules/catalog.pa.json", import.meta.url), "utf8")).bySlug.stench;
  assert.ok(activationWarnings(rule, () => stench).some((x) => /replaces/.test(x)));
  const v = ok({ v: 1, activate: [{ id: "x", label: "X", choices: [{ id: "c1", spell: SPELL, duration: dur }, { id: "c2", spell: SPELL }] }] });
  assert.match(activationWarnings(v, () => null)[0], /^x.c1:/);
});
