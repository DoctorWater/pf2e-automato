// Честный partial недугов (plan-affliction-text.md §6.3): заметка, смертельная стадия, долг с причиной, группа, заглушки и лор.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAffliction, afflictionRule, outsideText, outsideTexts, noteOf, FLAVOR_OK, DEATH_NOTE } from "../tools/affliction.mjs";
import { checkAffliction, partialGaps, parseGroups } from "../tools/affliction-batch.mjs";
import { NOTE_MAX } from "../scripts/rules.mjs";

const condSlug = (u) => (u.includes(".conditionitems.") ? u.split(".").pop() : null);
const P = (html, o = {}) => parseAffliction(html, { name: "X", traits: ["disease"], condSlug, ...o });
const stage = (n, body) => `<p><strong>Stage ${n}</strong> ${body}</p>`;
const SV = `<p><strong>Saving Throw</strong> @Check[fortitude|dc:20]</p>`;
const D = (n) => `@Damage[${n}d6[poison]] damage (1 day)`;
const sick = `@UUID[Compendium.pf2e.conditionitems.Item.sickened]{Sickened 1}`;
const mk = (...ss) => SV + ss.map((b, i) => stage(i + 1, b)).join("");

test("смертельная стадия: срок снят, maxDuration недуга снят, «отметьте смерть» в text стадии, не в note", () => {
  const h = SV + `<p><strong>Maximum Duration</strong> 6 days</p>` + stage(1, D(1)) + stage(2, `${D(2)}`) + stage(3, "dead (1 day)");
  const p = P(h, { traits: ["poison"] });
  assert.equal(p.def.maxDuration, null);
  const last = p.def.stages[2];
  assert.equal(last.duration, null);
  assert.ok(last.text.endsWith(DEATH_NOTE));
  assert.equal(p.def.note, undefined);
  assert.equal(p.group, "смерть");
  assert.deepEqual(p.debt, []);
  assert.ok(afflictionRule(h, { name: "X", traits: ["poison"], condSlug }).rule, "правило проходит валидатор");
  // checkAffliction: у яда конечная смертельная стадия без срока — не расхождение
  const r = afflictionRule(h, { name: "X", traits: ["poison"], condSlug }).rule;
  assert.deepEqual(checkAffliction(r, h, { traits: ["poison"] }, { conditions: {}, effects: {} }, { partial: true }), []);
});

test("смерть не в последней стадии, «or/if/until» рядом, случайный срок — долг с причиной, не partial", () => {
  assert.match(P(mk(D(1), "dead (1 day)", D(2))).debt[0], /^stage clarification: death before/);
  assert.match(P(mk(D(1), "dead if you fail (1 day)")).debt[0], /^stage clarification: if/);
  assert.match(P(mk(D(1), `${sick} until cured (1 day)`)).debt[0], /^stage clarification: until/);
  assert.match(P(mk(`${sick} or blinded (1 day)`, D(2))).debt[0], /^stage clarification: or/);
  assert.match(P(mk(`${sick} for each hour (1 day)`, D(2))).debt[0], /^stage clarification: for each/);
  assert.match(P(mk(`${sick} for [[/gmr 1d4 #hours]]{1d4 hours}`, D(2))).debt[0], /^stage clarification/);
  assert.ok(P(mk(`${sick} against fear (1 day)`, D(2))).debt[0].includes("against"));
});

test("случайный срок: долг; срок соседа такой стадии не берётся", () => {
  const h = mk(`${sick} and [[/gmr 1d4 #hours]]{1d4 hours}`, `${D(1)}`, `${D(2)}`);
  const p = P(h);
  assert.ok(p.debt.includes("random duration"));
  assert.equal(p.def.stages[0].duration, null, "срок соседа не подставлен");
  assert.ok(P(mk(`Paralyzed for 1d4 hours`, D(1))).debt.includes("random duration"));
});

test("linger: расширенная регулярка -> долг; обычная заметка — нет", () => {
  const st = stage(1, D(1)) + stage(2, `${D(2)} plus dead`);
  const base = (t) => `<p>${t}</p>` + SV + st;
  for (const t of ["The drained condition persists after the poison's duration ends.", "Any drained condition remains even after the disease ends.", "The enfeebled condition lasts for 24 hours.", "The value reduces by 1 every hour.", "This disease's condition ends after 1 hour."]) {
    assert.ok(P(base(t)).debt.some((x) => x.startsWith("linger")), t);
  }
  assert.ok(!P(base("The sickened condition can't be reduced until the disease is cured.")).debt.some((x) => x.startsWith("linger")));
});

test("запись без единой механики в стадиях — долг", () => {
  const p = P(mk("the creature gets strange dreams (1 day)", "the creature dreams of the sea (1 day)"));
  assert.ok(p.debt.includes("no stage mechanics"));
  assert.ok(!P(mk(`${D(1)} and strange dreams`, D(2))).debt.includes("no stage mechanics"));
});

test("заметка: текст вне стадий, разметка читаема, стадийный остаток в заметку не дублируется, лимит NOTE_MAX", () => {
  const h = `<p>The target can't recover from drained until the disease is cured. See @UUID[Compendium.pf2e.conditionitems.Item.drained]{Drained}.</p>` + SV + stage(1, `${D(1)} and strange dreams`) + stage(2, D(2));
  const p = P(h);
  assert.equal(p.def.note, "The target can't recover from drained until the disease is cured. See Drained.");
  assert.ok(!p.def.note.includes("strange dreams"));
  assert.match(p.def.stages[0].text, /strange dreams/);
  assert.equal(p.group, "нельзя снять");
  assert.deepEqual(P(h.replace("<p>The target", `<p>${"long ".repeat(400)} The target`)).def.note.length, NOTE_MAX);
  const r = afflictionRule(h, { name: "X", traits: ["disease"], condSlug });
  assert.equal(r.rule.onUse.challenge.byDegree.failure[0].affliction.def.note, p.def.note, "валидатор note не отбрасывает");
});

test("группы partial: приоритет и метки", () => {
  const g = (t, last = D(2)) => P(`<p>${t} The GM decides.</p>` + mk(D(1), last)).group;
  assert.equal(g("This disease can't be healed until cured."), "нельзя снять");
  assert.equal(g("The curse ends only if a counteract check succeeds."), "особое излечение");
  assert.equal(g("Oozes are immune to this poison."), "иммунитет");
  assert.equal(g("This curse affects anyone who wears the armor."), "экспозиция");
  assert.equal(g("While infected, a creature is dazzled."), "пока под действием");
  assert.equal(g("The victim rises as a ghoul."), "сюжетное");
  assert.equal(g("Strange lore here."), "прочее");
  assert.equal(g("Strange lore here.", "dead (1 day)"), "смерть");
});

test("заглушки вне стадий («Level 7», «(1 day)», «DC 38», «Access …», «Effect: …») не механика; лишний текст — механика", () => {
  const body = SV + stage(1, D(1)) + stage(2, D(2));
  for (const s of ["<p><strong>Level</strong> 7</p>", "<p>(1 day)</p>", "<p>DC 38</p>", "<p><strong>Access</strong> member of the Red Mantis</p>", "<p>@UUID[Compendium.pf2e.bestiary-effects.Item.Q5pWxWsb4MIgfwxd]{Effect: Bogwid Fever}</p>"]) {
    assert.deepEqual(outsideTexts(s + body), [], s);
  }
  assert.equal(outsideText(`<p>@UUID[Compendium.pf2e.conditionitems.Item.sickened]{Sickened}</p>` + body), "@UUID[Compendium.pf2e.conditionitems.Item.sickened]{Sickened}");
  assert.equal(outsideText(`<p>Oozes are immune.</p>` + body), "Oozes are immune.");
});

test("лор по FLAVOR_OK: ignoreOutside -> «готово» (unsure пуст, note нет); checkAffliction с partial не ругается на текст", () => {
  assert.ok(FLAVOR_OK.size >= 8);
  const h = `<p>Lore: it remains of arachnids.</p>` + mk(D(1), D(2));
  assert.match(P(h).unsure[0], /^text outside/);
  const p = P(h, { ignoreOutside: true });
  assert.deepEqual(p.unsure, []);
  assert.equal(p.def.note, undefined);
  const r = afflictionRule(h, { name: "X", traits: ["disease"], condSlug, ignoreOutside: true }).rule;
  const refs = { conditions: {}, effects: {} };
  assert.ok(checkAffliction(r, h, { traits: ["disease"] }, refs).some((x) => /^text outside/.test(x)));
  assert.deepEqual(checkAffliction(r, h, { traits: ["disease"] }, refs, { partial: true }), []);
});

const rest = (h, o) => P(h, o).debt;
const lk = (slug, n) => `@UUID[Compendium.pf2e.conditionitems.Item.${slug}]{${slug} ${n}}`;

test("«as stage N»: чистая ссылка копирует стадию; своё содержимое/остаток («except», «plus») — долг, не копия", () => {
  const p = P(mk(`${lk("clumsy", 2)} (1 round)`, "as stage 1 (2 rounds)"));
  assert.deepEqual(p.debt, []);
  assert.deepEqual(p.def.stages[1].conditions, [{ slug: "clumsy", value: 2 }]);
  assert.equal(p.def.stages[1].duration.value, 2);
  for (const t of ["as stage 1, except " + lk("clumsy", 3), "as stage 1 plus " + lk("slowed", 1), "as stage 1, but lasts longer"]) {
    assert.ok(rest(mk(`${lk("clumsy", 2)} (1 day)`, `${t} (1 day)`)).includes("stage clarification: as stage 1 with changes"), t);
  }
});

test("уточнения: every/whenever/except/versus/increases/using/returns to stage, [[/br, @Check в стадии — долг", () => {
  for (const w of ["every hour", "whenever it rests", "except in water", "versus fear", "increases by 1", "using the limb", "returns to stage 1"]) {
    assert.match(rest(mk(`${lk("clumsy", 1)} ${w} (1 day)`, D(2))).join("|"), /stage clarification/, w);
  }
  assert.ok(rest(mk(`${sick} for [[/br 1d4 #h]]{1d4 hours}`, D(2))).includes("random duration"));
  assert.ok(rest(mk(`${sick} and a @Check[will|dc:20] save (1 day)`, D(2))).includes("stage clarification: @Check in stage"));
});

test("сроки: неделя = 7 дней; месяцы/годы и нераспознанные скобки — unsure; Maximum Duration не число — unsure", () => {
  const w = P(mk(D(1).replace("(1 day)", "(1 week)"), D(2)));
  assert.deepEqual(w.def.stages[0].duration, { value: 7, unit: "days" });
  assert.deepEqual(P(SV + `<p><strong>Maximum Duration</strong> 2 weeks</p>` + stage(1, D(1)) + stage(2, D(2)), { traits: ["poison"] }).def.maxDuration, { value: 14, unit: "days" });
  for (const t of ["(1 month)", "(1 year)", "(1d4 days)"]) assert.ok(P(mk(D(1), `${sick} ${t}`)).unsure.includes("duration: unrecognized stage duration"), t);
  assert.ok(P(mk(D(1), `transform (1 year). Lore.`)).unsure.includes("duration: unrecognized stage duration"));
  assert.ok(P(SV + `<p><strong>Maximum Duration</strong> 1d4 days</p>` + stage(1, D(1)) + stage(2, D(2)), { traits: ["poison"] }).unsure.includes("duration: maximum duration not a plain number"));
});

test("linger: permanently, unlimited duration, awakens, «состояние for N ед.» не равное сроку стадии; цвет — косметика", () => {
  const L = (t) => rest(mk(D(1), `${t} (1 day)`)).some((x) => x.startsWith("linger"));
  assert.ok(L("permanently blinded"));
  assert.ok(L("blinded for 1 hour"));
  assert.ok(!L("blinded for 1 day"), "равно сроку стадии");
  assert.ok(L("drained 1 with unlimited duration"));
  assert.ok(rest(mk(D(1), D(2)) + `<p>Once a creature awakens from stage 2, they are drained 1.</p>`).some((x) => x.startsWith("linger")));
  assert.ok(!rest(`<p>The poison turns flesh a scarlet color that persists for 24 hours.</p>` + mk(D(1), D(2))).some((x) => x.startsWith("linger")));
});

test("заметка: механика первой, лор после; обрезка по границе предложения; механика не поместилась — долг", () => {
  assert.equal(noteOf(["Lore sentence here.", "It can't be removed."]).note, "It can't be removed. Lore sentence here.");
  const cut = noteOf(["Some lore. ".repeat(150), "It can't be removed."]);
  assert.ok(cut.note.startsWith("It can't be removed. Some lore."));
  assert.ok(cut.note.length <= NOTE_MAX && cut.note.endsWith("."), "по границе предложения");
  assert.equal(cut.cutMech, false);
  assert.equal(noteOf(["Don't. ".repeat(300)]).cutMech, true);
  assert.equal(noteOf(["x"], "Мой текст.").note, "Мой текст. x");
  assert.ok(P(`<p>${"It can't be removed. ".repeat(100)}</p>` + mk(D(1), D(2))).debt.includes("note: mechanics exceed the limit"));
});

test("автомат неверно -> долг: untyped, «immune to additional exposure», разовый урон при тексте о persistent", () => {
  assert.ok(rest(mk("@Damage[8d6[untyped]] damage (1 day)", D(2))).includes("untyped damage in stage"));
  assert.ok(rest(`<p>A victim is immune to additional exposure.</p>` + mk(D(1), D(2)), { traits: ["poison"] }).includes("immune to additional exposure"));
  assert.ok(rest(`<p>The persistent bleed damage returns.</p>` + mk(`@Damage[3d6[bleed]] (1 day)`, D(2))).some((x) => /persistent/.test(x)));
  assert.ok(!rest(`<p>The persistent bleed damage returns.</p>` + mk(`@Damage[1d6[persistent,bleed]] (1 day)`, D(2))).some((x) => /persistent/.test(x)));
});

test("смертельная стадия: точка перед заметкой, заметка не обрезается", () => {
  const t = (s) => P(mk(D(1), `${s} (1 day)`)).def.stages[1].text;
  assert.equal(t("dead"), `dead. ${DEATH_NOTE}`);
  assert.equal(t("dead."), `dead. ${DEATH_NOTE}`);
  const long = t("dead " + "word ".repeat(200));
  assert.ok(long.endsWith(DEATH_NOTE) && long.length <= 600);
});

test("группы: «can't remove armor» — не «нельзя снять»; «can't heal … until cured»; whenever Strikes; body; ложные immune/exposure", () => {
  const g = (t) => P(`<p>${t}</p>` + mk(D(1), D(2))).group;
  assert.equal(g("This curse affects anyone who wears the armor and can't remove armor."), "экспозиция");
  assert.equal(g("It can't heal damage from the rot until it has been cured of the disease."), "нельзя снять");
  assert.equal(g("The sickened condition doesn't improve on its own."), "нельзя снять");
  assert.equal(g("Whenever the redcap Strikes a creature, it saves."), "прочее");
  assert.equal(g("The body is odd."), "прочее");
  assert.equal(g("Carriers, even if they are immune to their effects."), "прочее");
  assert.equal(g("Recipes have quickly spread across Golarion. Subsequent exposure stacks."), "прочее");
});

test("второй барьер: состояние из ссылки стадии с другим значением/потерянное — расхождение", () => {
  const html = mk(`${lk("sickened", 2)} (1 day)`, D(2));
  const refs = { conditions: { sickened: { id: "sickened" } }, effects: {} }, it = { traits: ["disease"] };
  const r = afflictionRule(html, { name: "X", traits: ["disease"], condSlug }).rule;
  assert.deepEqual(checkAffliction(r, html, it, refs), []);
  const bad = structuredClone(r), st = bad.onUse.challenge.byDegree.failure[0].affliction.def.stages[0];
  st.conditions[0].value = 1;
  assert.ok(checkAffliction(bad, html, it, refs).some((x) => /sickened 1 != text 2/.test(x)));
  st.conditions = [{ slug: "slowed", value: 1 }];
  assert.ok(checkAffliction(bad, html, it, refs).some((x) => /sickened lost/.test(x)));
});

test("partialGaps и --groups: метки, ASCII-псевдонимы, ошибки", () => {
  const r = (h) => afflictionRule(h, { name: "X", traits: ["disease"], condSlug });
  assert.deepEqual(partialGaps(r(mk(D(1), D(2)))), []);
  assert.deepEqual(partialGaps(r(mk(`${D(1)} and strange dreams`, D(2)))), ["stage text"]);
  assert.deepEqual(partialGaps(r(`<p>Lore. It can't be removed.</p>` + mk(D(1), "dead (1 day)"))), ["text outside stages", "stage text", "death stage"]);
  assert.deepEqual(parseGroups("cant,прочее"), ["нельзя снять", "прочее"]);
  assert.deepEqual(parseGroups(null), []);
  assert.throws(() => parseGroups("cant,bogus"), /unknown group "bogus"/);
  assert.throws(() => parseGroups(true), /no value/);
  assert.throws(() => parseGroups("--write"), /no value/);
});

test("extraNote: добавка к заметке идёт первой", () => {
  const p = P(`<p>Lore about it.</p>` + mk(D(1), D(2)), { extraNote: "Кнопка подвергает цель." });
  assert.ok(p.def.note.startsWith("Кнопка подвергает цель."));
});

test("круг 1: virulent только из трейтов/скобок; название в заметку не лезет; «as long as … persists» — не linger; ';' перед смертью", () => {
  const body = mk(D(1), D(2));
  assert.equal(P(`<p>The addiction is virulent.</p>` + body).def.virulent, false);
  assert.ok(P(`<p>The addiction is virulent.</p>` + body).debt.includes("virulent in text, not in traits"));
  assert.equal(P(body, { traits: ["disease", "virulent"] }).def.virulent, true);
  assert.equal(P(`<p>X (disease, virulent)</p>` + body).def.virulent, true);
  assert.equal(P(`<p>It can't be removed.</p><p>X</p>` + body).def.note, "It can't be removed.");
  assert.ok(!rest(`<p>As long as the curse persists, a creature must rest.</p>` + body).some((x) => x.startsWith("linger")));
  assert.equal(P(mk(D(1), "death; (1 day)")).def.stages[1].text, `death. ${DEATH_NOTE}`);
  const g = (t) => P(`<p>${t}</p>` + body).group;
  assert.equal(g("A creature that dies while affected by this poison must rise."), "сюжетное");
  assert.equal(g("The mist turns into a foaming mist that must settle."), "прочее");
  assert.equal(g("Peaceful rest only works after a counteract check against the poison."), "прочее");
});
