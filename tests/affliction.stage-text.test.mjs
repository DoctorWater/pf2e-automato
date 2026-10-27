// Недуги: разбор уточнений в стадиях (plan-affliction-stage-text.md): подстановка стадии-образца, СЛ из сегмента «Saving Throw», узкое послабление «or/upon/while», белый список REFINE_OK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAffliction, afflictionRule, headSecondSave, REFINE_OK } from "../tools/affliction.mjs";
import { checkAffliction } from "../tools/affliction-batch.mjs";

const condSlug = (u) => (u.includes(".conditionitems.") ? u.split(".").pop() : null);
const P = (html, o = {}) => parseAffliction(html, { name: "X", traits: ["curse"], condSlug, ...o });
const lk = (slug, n) => `@UUID[Compendium.pf2e.conditionitems.Item.${slug}]{${slug}${n ? ` ${n}` : ""}}`;
const stage = (n, body) => `<p><strong>Stage ${n}</strong> ${body}</p>`;
const SV = `<p><strong>Saving Throw</strong> @Check[fortitude|dc:20]</p>`;
const mk = (...ss) => SV + ss.map((b, i) => stage(i + 1, b)).join("");
const D = "@Damage[1d6[poison]] damage";
const txt = (p) => p.def.stages.map((s) => s.text);
const REFS = { conditions: {}, effects: {} };

test("подстановка образца: Agonizing Welts — состояние поверх, остаток образца в тексте, без «Clumsy 2»", () => {
  const p = P(mk(`${lk("clumsy", 1)} (1 round)`, `${lk("clumsy", 2)} and all speeds are reduced by 10 feet (1 round)`, `As stage 2, except ${lk("clumsy", 3)} (1 round)`, `As stage 2, except clumsy 3 and ${lk("slowed", 1)} (1 round)`));
  assert.deepEqual(p.debt, []);
  assert.deepEqual(p.def.stages[2].conditions, [{ slug: "clumsy", value: 3 }]);
  assert.deepEqual(p.def.stages[3].conditions, [{ slug: "clumsy", value: 3 }, { slug: "slowed", value: 1 }]);
  assert.match(txt(p)[2], /all speeds are reduced by 10 feet/);
  assert.doesNotMatch(txt(p)[2], /Clumsy 2/i);
  assert.match(txt(p)[3], /all speeds are reduced by 10 feet/);
  assert.equal(p.def.stages[2].duration.value, 1);
});

test("подстановка образца: Corrupting Spite — Drained растёт, «не считает никого союзником» остаётся", () => {
  const p = P(mk(`${lk("drained", 1)} (1 round)`, `${lk("drained", 2)} and doesn't treat any creatures as allies (1 round)`, `As stage 2, except ${lk("drained", 3)} (1 round)`, `As stage 2, except ${lk("drained", 4)} (1 round).`));
  assert.deepEqual(p.debt, []);
  assert.deepEqual(p.def.stages.map((s) => s.conditions[0].value), [1, 2, 3, 4]);
  assert.match(txt(p)[3], /doesn't treat any creatures as allies/);
  assert.doesNotMatch(txt(p)[3], /Drained 2/);
});

test("подстановка образца: Jelly Blood — «as stage N plus» цепочкой, смерть в конце", () => {
  const p = P(mk("target gains resistance 5 to bleed damage (1 hour)", `as stage 1 plus ${lk("slowed", 1)} (1 day)`, `as stage 2 plus ${lk("drained", 1)} (1 day)`, "dead"));
  assert.deepEqual(p.debt, []);
  assert.deepEqual(p.def.stages[2].conditions, [{ slug: "slowed", value: 1 }, { slug: "drained", value: 1 }]);
  assert.match(txt(p)[2], /resistance 5 to bleed damage/);
  assert.match(txt(p)[3], /dead/);
});

test("подстановка образца: Void's Embrace — «but also has void healing» без разобранной механики остаётся текстом", () => {
  const p = P(mk(`${lk("dazzled")} in any light (1 hour)`, `gains lifesense 30 feet but is ${lk("blinded")} in any light (1 hour)`, "as stage 2, but also has void healing (1 hour)", "dead"));
  assert.deepEqual(p.debt, []);
  assert.deepEqual(p.def.stages[2].conditions, [{ slug: "blinded" }]);
  assert.match(txt(p)[2], /has void healing/);
  assert.match(txt(p)[2], /lifesense 30 feet/);
  assert.match(txt(p)[2], /blinded/i);   // текст образца целиком, не остаток после вырезания состояний
});

test("подстановка образца, отрицательные: Sloughing Toxin, Ghoul Whispers, Phantom Mold Spores, «but also» — долг", () => {
  const slough = P(mk(`${D} for each action with the attack or move trait the victim uses (1 round)`, `${D} for each action (1 round)`, `as stage 2, but @Damage[2d6[slashing]] damage, and forced movement also causes damage (1 hour)`), { traits: ["poison"] });
  assert.match(slough.debt.join("|"), /stage clarification: for each/);
  const ghoul = P(mk("carrier with no ill effects (1 day)", `@Damage[2d6[void]] damage and the target is ${lk("sickened", 1)} until it consumes raw meat (1 day)`, "as stage 2", `as stage 2 unless the target has consumed raw meat in the past 24 hours, then it takes @Damage[4d6[void]] damage;`, "if the creature has eaten raw meat, it dies and rises as a ghoul, if not, it returns to stage 4"));
  assert.ok(ghoul.debt.some((x) => /^stage clarification: (?:until|unless|if|returns)/.test(x)), ghoul.debt.join("|"));
  const mold = P(mk(`${D} (1 round)`, `${D}, and the victim takes a -1 status penalty on visual Perception checks (1 round)`, "as stage 2, but a -2 status penalty (1 round)"), { traits: ["poison"] });
  assert.ok(mold.debt.includes("stage clarification: as stage 2 with changes"), mold.debt.join("|"));
  for (const t of [`as stage 1, but also ${lk("slowed", 1)}`, `as stage 1, but also ${D}`, `as stage 1 plus ${D}`, `as stage 1 and ${D}`]) {
    assert.ok(P(mk(`${lk("sickened", 1)} (1 day)`, `${t} (1 day)`)).debt.includes("stage clarification: as stage 1 with changes"), t);
  }
  // урон при «but/except» заменяет урон образца
  const rep = P(mk(`${D} (1 day)`, `as stage 1, but @Damage[2d6[poison]] damage (1 day)`), { traits: ["poison"] });
  assert.deepEqual(rep.debt, []);
  assert.deepEqual(rep.def.stages[1].damage, [{ formula: "2d6", damageType: "poison" }]);
});

const stages4 = (dmg) => stage(1, `${dmg} (1 round)`) + stage(2, `${dmg} (1 round)`);
const poisonOpts = { traits: ["poison"] };

test("СЛ из сегмента «Saving Throw»: Demon Dust — СЛ 20, не addiction 24; virulent=false и без долга virulent", () => {
  const h = `<p>The save for addiction to demon dust is @Check[fortitude|dc:24|name:Demon Dust Addiction|traits:virulent|showDC:owner], and the addiction has the virulent trait.</p>`
    + `<p><strong>Saving Throw</strong> @Check[fortitude|dc:20|showDC:owner]</p><p><strong>Maximum Duration</strong> 8 hours</p>` + stages4(D);
  const p = P(h, poisonOpts);
  assert.equal(p.def.save.dc, 20);
  assert.equal(p.def.virulent, false);
  assert.ok(!p.unsure.includes("second save check in head"));
  assert.ok(!p.debt.includes("virulent in text, not in traits"));
});

test("СЛ из сегмента: Execution Powder — fortitude, а не will из описания", () => {
  const h = `<p>If a creature is reduced to 0 Hit Points, it must succeed at a @Check[will|dc:34] save or die.</p>`
    + `<p><strong>Saving Throw</strong> @Check[fortitude|dc:34]</p><p><strong>Maximum Duration</strong> 6 rounds</p>` + stages4(D);
  const p = P(h, poisonOpts);
  assert.equal(p.def.save.statistic, "fortitude");
  assert.ok(!p.unsure.includes("second save check in head"));
});

test("второй @Check: Counteflora (вторая СЛ в сегменте), Tarantula Ampoule и Kraken Bottle (ворота «exposed» в описании) — долг", () => {
  const counter = `<p><strong>Saving Throw</strong> @Check[fortitude|dc:30|traits:inhaled,poison] (@Check[fortitude|dc:32|traits:contact,poison] for plants and fungi)</p><p><strong>Maximum Duration</strong> 6 rounds</p>` + stages4(D);
  const tarantula = `<p>If the target fails a @Check[fortitude|dc:21] save, it takes damage. If the target critically fails the save, it's also exposed to tarantula venom.</p>`
    + `<p><strong>Saving Throw</strong> @Check[fortitude|dc:23|traits:poison]</p><p><strong>Maximum Duration</strong> 8 rounds</p>` + stages4(D);
  const kraken = `<p>Unless the target succeeds at a @Check[fortitude|dc:38] save, the kraken repositions it.</p><p>Creatures inside the cloud are exposed to kraken ink poison.</p>`
    + `<p><strong>Saving Throw</strong> @Check[fortitude|dc:39|traits:poison]</p><p><strong>Maximum Duration</strong> 10 rounds</p>` + stages4(D);
  for (const h of [counter, tarantula, kraken]) assert.ok(P(h, poisonOpts).unsure.includes("second save check in head"));
});

test("конвертер и checkAffliction не расходятся: СЛ и «second save check» одинаково на всех головах", () => {
  const sv = `<p><strong>Saving Throw</strong> @Check[fortitude|dc:20|traits:poison]</p><p><strong>Maximum Duration</strong> 8 rounds</p>`;
  const heads = {
    plain: sv,
    addiction: `<p>The save for addiction is @Check[fortitude|dc:24|traits:virulent].</p>` + sv,
    willIntro: `<p>It must succeed at a @Check[will|dc:34] save or die.</p>` + sv,
    gated: `<p>On a failed @Check[fortitude|dc:21] save it takes damage; on a critical failure it's exposed to the poison.</p>` + sv,
    twoInSegment: `<p><strong>Saving Throw</strong> @Check[fortitude|dc:20] (@Check[fortitude|dc:22] for plants)</p><p><strong>Maximum Duration</strong> 8 rounds</p>`
  };
  for (const [k, head] of Object.entries(heads)) {
    const h = head + stages4(D), r = afflictionRule(h, { name: "X", traits: ["poison"], condSlug });
    assert.ok(r?.rule, k);
    const bad = checkAffliction(r.rule, h, { traits: ["poison"] }, REFS, { partial: true });
    assert.equal(r.unsure.includes("second save check in head"), bad.includes("second save check in head"), k);
    assert.equal(r.unsure.includes("second save check in head"), headSecondSave(head), k);
    assert.ok(!bad.some((x) => x.startsWith("dc ")), `${k}: ${bad}`);   // СЛ правила = СЛ сегмента, которую видит и проверка
    assert.equal(r.def.save.dc, 20, k);
  }
});

test("«addiction is virulent» — не признак virulent; «the poison is virulent» без трейта — по-прежнему долг", () => {
  const body = mk(`${D} (1 day)`, `${D} (1 day)`);
  assert.deepEqual(P(`<p>The addiction is virulent.</p>` + body, poisonOpts).debt, []);
  assert.ok(P(`<p>The poison is virulent.</p>` + body, poisonOpts).debt.includes("virulent in text, not in traits"));
});

test("плоский @Damage[1[poison]] разбирается как урон 1", () => {
  const h = mk(`@Damage[1[poison]] damage and ${lk("enfeebled", 1)} (1 round)`, `@Damage[1d4[poison]] damage and ${lk("enfeebled", 1)} (1 round)`);
  const p = P(h, poisonOpts);
  assert.deepEqual(p.def.stages[0].damage, [{ formula: "1", damageType: "poison" }]);
  assert.deepEqual(p.unsure, []);
  assert.deepEqual(p.debt, []);
  assert.ok(afflictionRule(h, { name: "X", traits: ["poison"], condSlug }).rule, "правило проходит валидатор");
});

test("Q1 узко: or/upon/while в стадии без механики — текст; «or» рядом со смертью или степенью успеха — долг; при механике — долг", () => {
  const p = (last) => P(mk(`${D} (1 day)`, last), poisonOpts).debt;
  assert.deepEqual(p("dead. A creature that dies while infected rises as a zombie"), []);
  assert.deepEqual(p("dead upon the next sunrise"), []);
  assert.deepEqual(p("the victim's skin hardens or cracks"), []);
  assert.match(p("dead, rising as a zombie or a ghoul").join("|"), /stage clarification: or/);
  assert.match(p("mutation (on a failure) or something worse").join("|"), /stage clarification: or/);   // Ayrzul's Blight: «mutation (on a failure) or death (on a critical failure)»
  assert.match(p("mutation (on a failure) or death (on a critical failure)").join("|"), /stage clarification: or/);
  assert.match(p("dead if you fail").join("|"), /stage clarification: if/);
  assert.match(p(`${lk("sickened", 1)} while in water (1 day)`).join("|"), /stage clarification: while/);
  assert.match(p(`${lk("sickened", 1)} or ${lk("blinded")} (1 day)`).join("|"), /stage clarification: or/);
});

test("REFINE_OK: пуст; запись снимает только своё слово, устаревшая запись (слова нет в тексте) — долг", () => {
  assert.equal(REFINE_OK.size, 18);
  for (const [u, e] of REFINE_OK) assert.ok(u.startsWith("Compendium.") && e.word && e.why, u);
  const h = mk(`${lk("sickened", 1)} or ${lk("blinded")} (1 day)`, `${D} (1 day)`);
  assert.match(P(h, poisonOpts).debt.join("|"), /stage clarification: or/);
  assert.deepEqual(P(h, { ...poisonOpts, refineOk: { word: "or", why: "тест" } }).debt, []);
  assert.match(P(h, { ...poisonOpts, refineOk: { word: "if", why: "тест" } }).debt.join("|"), /REFINE_OK stale \(if\)/);
  const two = mk(`${lk("sickened", 1)} or ${lk("blinded")} if wet (1 day)`, `${D} (1 day)`);
  assert.match(P(two, { ...poisonOpts, refineOk: { word: "or", why: "тест" } }).debt.join("|"), /stage clarification: if/);
});

test("«against»/«versus» не попадает в mods: условный бонус остаётся текстом и долгом", () => {
  for (const [t, w] of [["+1 item bonus to Will saves against fear", "against"], ["+1 item bonus to saves versus mental effects", "versus"], ["+1 item bonus to Perception checks against illusions", "against"]]) {
    const p = P(mk(`${t} (1 day)`, `${D} (1 day)`), poisonOpts);
    assert.equal(p.def.stages[0].mods, null, t);
    assert.ok(p.debt.includes(`stage clarification: ${w}`), t);
  }
  assert.deepEqual(P(mk(`+1 item bonus to Will saves (1 day)`, `${D} (1 day)`), poisonOpts).def.stages[0].mods, [{ bonus: { target: "will", type: "item", value: 1 } }]);
});

test("стадия-копия: «but … also» с промежуточными словами, отрицание, тот же slug при plus, флаги своей стадии — долг", () => {
  const WITH = "stage clarification: as stage 1 with changes";
  const base = (t) => P(mk(`${lk("sickened", 1)} (1 day)`, `${t} (1 day)`), poisonOpts);
  assert.ok(base("as stage 1, but the victim also takes @Damage[2d6[fire]] damage").debt.includes(WITH), "but … also");
  assert.ok(base(`as stage 1, but not ${lk("blinded")}`).debt.includes(WITH), "not");
  assert.ok(base("as stage 1, but without a speed penalty").debt.includes(WITH), "without");
  assert.ok(P(mk(`${lk("drained", 2)} (1 day)`, `as stage 1 plus ${lk("drained", 1)} (1 day)`), poisonOpts).debt.includes(WITH), "тот же slug");
  assert.ok(base("as stage 1, but must attempt a @Check[flat|dc:5] check").debt.includes("stage clarification: @Check in stage"), "@Check");
});

test("смерть в условной конструкции («upon death», «dies while») — не смертельная стадия; «dead, and rises» — смертельная", () => {
  const p = P(mk(`${D} (1 day)`, `${D} (1 day)`, `as stage 2, but @Damage[2d6[poison]] damage and arise as a root rotter upon death (1 day)`, `${D} (1 day)`), poisonOpts);
  assert.ok(!p.debt.includes("stage clarification: death before the last stage"), p.debt.join("|"));
  const q = P(mk(`${D} (1 day)`, "a creature that dies while infected rises as a zombie (1 day)", `${D} (1 day)`), poisonOpts);
  assert.ok(!q.debt.includes("stage clarification: death before the last stage"), q.debt.join("|"));
  const g = P(mk(`${D} (1 day)`, "dead, and rises as a ghoul"), poisonOpts);
  assert.ok(g.def.stages[1].text.endsWith("Отметьте смерть."));
  assert.ok(P(mk(D, "dead, and rises as a ghoul", D), poisonOpts).debt.includes("stage clarification: death before the last stage"));
});

test("REFINE_OK: слово со спецсимволами регулярки не роняет разбор", () => {
  const h = mk(`${lk("sickened", 1)} for [[/gmr 1d4 #hours]]{1d4 hours}`, `${D} (1 day)`);
  assert.doesNotThrow(() => P(h, { ...poisonOpts, refineOk: { word: "for [[/gmr", why: "тест" } }));
  assert.ok(!P(h, { ...poisonOpts, refineOk: { word: "for [[/gmr", why: "тест" } }).debt.some((x) => /stale/.test(x)));
});
