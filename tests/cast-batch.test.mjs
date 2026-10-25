// Конвертер cast (tools/cast-batch.mjs), шаг 2 plan-activate.md: partial, «effects of», вспомогательный текст, сужение выбора, имя -> uuid, NPC-действие, честные причины.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) } };
const { deriveCast, validateRule } = await import("../scripts/rules.mjs");
const { checkCast, linkSpells, deriveAction, checkAction, whyNoCast, route, readable } = await import("../tools/cast-batch.mjs");

const ARC = "Compendium.pf2e.spells-srd.Item.kBhaPuzLUSwS6vVf", L1 = `@UUID[${ARC}]{Electric Arc}`;
const refs = { conditions: {}, effects: {} }, defs = { [ARC]: { slug: "electric-arc", save: false } };
const act = (eff, { head = "<strong>Activate</strong> Cast a Spell", freq = "" } = {}) => `<p>${head}</p>${freq && `<p><strong>Frequency</strong> ${freq}</p>`}<p><strong>Effect</strong> ${eff}</p>`;
const run = (html, opts) => checkCast({ v: 1, cast: deriveCast(html, { spellDefs: defs }).cast }, html, refs, defs, opts);
const manual = "<p><strong>Activate</strong> Strike</p><p><strong>Effect</strong> You hit harder.</p>";

test("partial: каст + ручная активация — правило закрывает кастовую; без partial прежняя строгость", () => {
  const html = act(`You cast ${L1}.`) + manual;
  assert.match(run(html)[0], /activations 2 != cast 1/);
  assert.deepEqual(run(html, { partial: true }), []);
  // лишнее после сотворения в кастовой активации остаётся долгом и при partial
  assert.match(run(act(`You cast ${L1}. Then @Damage[2d6[fire]] fire.`) + manual, { partial: true }).join(), /extra/);
});

test("effects of: каст только при чистом тексте — без срока и без хвоста после предложения", () => {
  const ok = act(`You drink the vial. You gain the effects of ${L1}.`);
  assert.deepEqual(run(ok, { partial: true }), []);
  assert.match(run(act(`You gain the effects of ${L1} for 1 minute.`)).join(), /own duration/);
  assert.match(run(act(`The ring replicates the effects of ${L1}. It can reflect no more than 9 ranks per day.`)).join(), /aux text \(tail/);
  assert.match(run(act(`The ring grants a +1 item bonus and the effects of ${L1}.`)).join(), /extra effect/);
});

test("выбор между заклинаниями: «or @UUID» — только спеллы spells-srd, «one of them» и ссылки на действия не в счёт", () => {
  const act1 = (s) => checkCast({ v: 1, cast: [{ id: "a", spell: ARC }] }, act(s), refs, defs).join();
  assert.doesNotMatch(act1(`You designate one of them and cast ${L1} on yourself to Feint or @UUID[Compendium.pf2e.actionspf2e.Item.abc]{Demoralize}.`), /choice/);   // хвост — отдельная проверка, «choice» не срабатывает
  assert.match(act1(`You cast ${L1} or @UUID[${ARC.replace("kBha", "zzzz")}]{Other}.`), /spell differs/);   // две ссылки — активация не cast (ручная), «choice» сработать не успевает
  assert.match(act1(`The item casts either see the unseen or ${L1}.`), /choice/);
});

test("вспомогательный текст (also/instead/except/unlike) — «aux text», разметка и бонусы — по-прежнему «extra effect»", () => {
  assert.match(run(act(`You cast ${L1}. Unlike most creatures, it can't speak.`)).join(), /aux text/);
  const both = run(act(`You cast ${L1}. It also grants a +1 status bonus.`)).join();
  assert.match(both, /extra effect/);
  assert.doesNotMatch(both, /aux text/);
});

test("linkSpells: имя без ссылки -> uuid, только однозначное имя и единственное предложение Effect", () => {
  const byName = new Map([["electric arc", [ARC]], ["dup", ["a", "b"]]]);
  assert.match(linkSpells(act("You cast electric arc."), byName), new RegExp(`cast @UUID\\[${ARC}\\]\\{electric arc\\}`));
  assert.match(linkSpells(act("You cast 3rd-rank electric arc on yourself."), byName), /3rd-rank @UUID/);
  const same = (h) => assert.equal(linkSpells(h, byName), h);
  same(act("You cast electric arc. Then the item cools down."));   // хвост не проверить
  same(act("You cast electric arc, dup, or other."));   // список имён — выбор
  same(act("You cast dup."));   // имя неоднозначно
  same(act(`You cast ${L1}.`));   // ссылка уже есть
  assert.deepEqual(run(linkSpells(act("You cast electric arc."), byName), { partial: true }), []);
});

test("NPC-действие: «can cast X at will» / «has the effects of X spell» -> cast; лишнее — aux (note, low), хвост «но» — не cast", () => {
  const byName = new Map([["dominate", ["Compendium.pf2e.spells-srd.Item.dom"]], ["command", ["Compendium.pf2e.spells-srd.Item.cmd"]]]);
  const d = deriveAction("<p>The vampire can cast Dominate at will as a divine innate spell. The save DC uses the high spell DC of the vampire's level.</p>", byName);
  assert.deepEqual(d.cast, [{ id: "dominate", spell: "Compendium.pf2e.spells-srd.Item.dom", dc: { level: "high" } }]);
  assert.match(d.aux, /high spell DC/);
  assert.ok(validateRule({ v: 1, cast: d.cast }).ok);
  const m = deriveAction("<p>This has the effects of a Command spell (@Check[will|dc:24|name:X] save).</p>", byName);
  assert.equal(m.cast[0].dc, 24);
  assert.equal(m.aux, "");
  assert.deepEqual(checkAction({ v: 1, cast: m.cast }, refs, `<p>This has the effects of a Command spell (@Check[will|dc:24]).</p>`, m.aux), []);
  assert.match(checkAction({ v: 1, cast: d.cast }, refs, "<p>x</p>", d.aux).join(), /aux text/);
  assert.equal(deriveAction("<p>It has the effects of a Command spell, but lasts a day.</p>", byName), null);
  assert.equal(deriveAction("<p>The vampire can cast Dominate at will as a divine innate spell that affects only animals.</p>", byName), null);
  assert.equal(deriveAction("<p>It can cast Unknown at will.</p>", byName), null);
});

test("whyNoCast: честные причины вместо метки «cast a spell activation»", () => {
  assert.equal(whyNoCast("<p>Activate Cast a Spell. You expend charges from the staff to cast a spell from its list.</p>"), "spell list with charges (staff)");
  assert.equal(whyNoCast("<p>The tattoo casts Calm or Sanctuary (your choice).</p>"), "choice between spells");
  assert.equal(whyNoCast("<p>The creature can Activate the token to Cast a Spell once per day.</p>"), "spell chosen from a list");
  assert.equal(whyNoCast("<p>The fetch functions as a 2nd-rank Illusory Creature, except it is dumb.</p>"), "effects of a spell with changes");
  assert.equal(whyNoCast("<p>The blade gains charges when you hit.</p>"), "activation without a spell (own mechanic)");
});

/* ---------- route: маршруты ok / partial / low / долг ---------- */

const ctx = { spellDefs: defs, byName: new Map([["electric arc", [ARC]]]), refs };
const it = { uuid: "U1", slug: "x", type: "equipment", name: "Thing", nameRu: null, dupCount: 1 }, tr = { status: "manual", layer: 3, batchName: "b01" };
const go = (html, item = it, a) => route(item, tr, a, html, ctx);
const cond = "@UUID[Compendium.pf2e.conditionitems.Item.abc]{Unconscious}";

test("route: чистый каст — ok; хвост «на вас/по указаниям/СЛ» хвостом не считается", () => {
  assert.equal(go(act(`You cast ${L1} on yourself to your specifications.`)).kind, "ok");
  assert.equal(go(act(`You cast ${L1} (@Check[will|dc:30]).`)).kind, "ok");
});

test("route: каст + текстовая активация — partial с перечнем; активация с другим заклинанием — долг", () => {
  const r = go(act(`You cast ${L1}.`) + manual);
  assert.equal(r.kind, "partial");
  assert.deepEqual(r.entry.partial, ["activation 2: activation without a spell (own mechanic)"]);
  assert.equal(r.entry.confidence, "model");
  const other = "<p><strong>Activate</strong> Peek</p><p><strong>Effect</strong> You cast @UUID[Compendium.pf2e.spells-srd.Item.zzz]{Scrying} and @UUID[Compendium.pf2e.spells-srd.Item.yyy]{Telepathy}.</p>";
  const d = go(act(`You cast ${L1}.`) + other);
  assert.equal(d.kind, "debt");
  assert.match(d.entry.reason, /another activation names 2 spell/);
});

test("route: хвост после ссылки — low с полным текстом в note; смена урона/срока — долг; heightened — долг", () => {
  const low = go(act(`You cast ${L1}, but you can target only yourself. It then fizzles.`));
  assert.equal(low.kind, "low");
  assert.equal(low.entry.confidence, "low");
  assert.equal(low.entry.rule.cast[0].note, "You cast Electric Arc, but you can target only yourself. It then fizzles.");
  assert.equal(go(act(`You cast ${L1}, but all damage is spirit damage.`)).kind, "debt");
  assert.equal(go(act(`You cast ${L1} (heightened to 5th level).`)).kind, "debt");
  assert.equal(go(act(`You cast ${L1}. It lasts 24 hours.`)).kind, "debt");
});

test("route: note — по границе предложения, разметка читаема", () => {
  assert.equal(readable("@Check[reflex|dc:43|basic] and @Damage[2d8[healing]|options:x] in a @Template[type:cone|distance:30]"), "DC 43 reflex (basic) and 2d8 healing in a 30-foot cone");
  const long = `You cast ${L1}. ` + Array.from({ length: 40 }, (_, i) => `Sentence number ${i} adds nothing.`).join(" ");
  const note = go(act(long)).entry.rule.cast[0].note;
  assert.ok(note.length <= 700 && note.endsWith("."));
});

test("route: механика вне блоков Activate — partial с пометкой; общая частота — долг", () => {
  const html = `<p>Once per 10 minutes, you become ${cond} and are no longer dying.</p>` + act(`You cast ${L1}.`);
  const r = go(html);
  assert.equal(r.kind, "partial");
  assert.match(r.entry.partial[0], /^text outside the activations: /);
  assert.equal(go(`<p>Activating them counts against the frequency for both weapons.</p>` + act(`You cast ${L1}.`)).kind, "debt");
  assert.equal(go(`<p>You gain a +1 item bonus to Deception checks.</p>` + act(`You cast ${L1}.`)).kind, "ok");
});

test("route: NPC-действие — остаток с иммунитетом = долг «extra effect», чистый остаток = low; «high DC for the …» -> dc high; старая метка -> честная причина", () => {
  const sp = new Map([["dominate", ["Compendium.pf2e.spells-srd.Item.dom"]]]), c2 = { ...ctx, byName: sp }, npc = { ...it, type: "action", name: "Dominate" };
  const imm = "<p>The vampire can cast Dominate at will as a divine innate spell. The save DC is a high DC for the vampire's level, and a creature that succeeds is temporarily immune for 24 hours.</p>";
  assert.deepEqual(deriveAction(imm, sp).cast[0].dc, { level: "high" });
  assert.match(route(npc, tr, undefined, imm, c2).entry.reason, /extra effect after the cast/);
  const aux = route(npc, tr, undefined, "<p>The vampire can cast Dominate at will. Casting it requires staring into the target's eyes.</p>", c2);
  assert.equal(aux.kind, "low");
  assert.equal(aux.entry.rule.cast[0].note, "Casting it requires staring into the target's eyes.");
  const old = route(it, tr, { confidence: "needs-primitive", reason: "needs-primitive: missing: cast a spell activation", rule: null }, "<p><strong>Activate</strong> Cast a Spell</p><p><strong>Effect</strong> You expend charges from the staff to cast a spell.</p>", ctx);
  assert.equal(old.entry.reason, "needs-primitive: missing: cast: spell list with charges (staff)");
});

/* ---------- круг 2 ---------- */

test("частота: текст Frequency есть, а frequencyOf не разобрал («once per month») — долг; «any number of times» — не долг", () => {
  const r = go(act(`You cast ${L1}.`, { freq: "once per month" }));
  assert.equal(r.kind, "debt");
  assert.match(r.entry.reason, /unparsed frequency "once per month"/);
  assert.equal(go(act(`You cast ${L1}.`, { freq: "any number of times per day" })).kind, "ok");
  assert.equal(go(act(`You cast ${L1}.`, { freq: "once per day" })).kind, "ok");
});

test("механика вне Activate: «After you cast … Activating» и ссылка на equipment-effects — partial, не clean", () => {
  const pre = (t) => `<p>${t}</p>` + act(`You cast ${L1}.`);
  const r = go(pre("Weapon After you cast an electricity spell by Activating the vial, your Strikes deal extra damage."));
  assert.equal(r.kind, "partial");
  assert.match(r.entry.partial[0], /^text outside the activations: Weapon After you cast/);
  assert.equal(go(pre("@UUID[Compendium.pf2e.equipment-effects.Item.abc]{Aura: Vial}")).kind, "partial");
});

test("срок хвоста: Sustain и «as normal with the spell» не считаются, «up to …» — low, «It lasts 24 hours» — долг", () => {
  assert.equal(go(act(`You cast ${L1} on you. You can Sustain the activation for up to 10 minutes. When the activation ends, you return to normal.`)).kind, "ok");
  assert.equal(go(act(`You cast ${L1}. As normal with the spell, you can't cast it again for 10 minutes.`)).kind, "ok");
  assert.equal(go(act(`You cast ${L1}. The effect continues for up to a minute afterwards.`)).kind, "low");
  assert.equal(go(act(`You cast ${L1}. It lasts 24 hours.`)).kind, "debt");
});

test("граница блока Activate — Destruction; бросок [[/r]] без подписи в note — формулой; «Cast a Spell» в чужой активации — не «spell chosen from a list»", () => {
  const html = act(`You cast ${L1}.`) + "<p><strong>Destruction</strong> The item is destroyed if used in the Dimension of Time. It also glows.</p>";
  assert.equal(go(html).kind, "ok");   // Destruction не тянется в Effect (иначе aux «also»)
  assert.equal(readable("modifier [[/r 1d20+35 #Counteract]] total"), "modifier 1d20+35 total");
  assert.equal(readable("[[/r 1d20+35]]{+35}"), "+35");
  assert.equal(whyNoCast("<p><strong>Activate</strong> Strike</p><p><strong>Effect</strong> When the creature attempts to Cast a Spell, it must save.</p>"), "activation without a spell (own mechanic)");
  assert.equal(whyNoCast("<p>Activate Cast a Spell Effect You expend charges.</p>"), "spell list with charges (staff)");
});
