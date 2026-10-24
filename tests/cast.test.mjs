// cast: активация снаряжения «You cast X» (plan-cast-activation.md) — схема, форма, вывод из разметки, чистые части рантайма, кнопки карточки.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) } };   // use.mjs тянет zone.mjs
const { validateRule, deriveCast, deriveFromMarkup, frequencyOf } = await import("../scripts/rules.mjs");
const { ruleToForm, formToRule, blankCast, buildReport, ruleUuids, dropSpec } = await import("../scripts/sheet.mjs");
const { rankSource, usesLeft, withUse, withoutUse, requirementOf, highDc, highAttack, levelDc, tracksUses, entryId, ID } = await import("../scripts/cast.mjs");
const { wantsSnapshot } = await import("../scripts/use.mjs");
const { buildViewModel } = await import("../scripts/chat.mjs");
const { castLine } = await import("../scripts/workshop/automation.mjs");
const { checkAnswer, semanticErrors } = await import("../tools/validate.mjs");
const { stepCount } = await import("../tools/triage.mjs");

const ARC = "Compendium.pf2e.spells-srd.Item.kBhaPuzLUSwS6vVf";
const rule = (cast) => ({ v: 1, cast });
const errs = (cast) => validateRule(rule(cast)).errors.map((e) => e.toString());

/* ---------- схема ---------- */

test("cast: правило из одних активаций валидно, id по умолчанию — slug метки или заклинания (стабилен при правке списка), пустой список — поля нет", () => {
  const v = validateRule(rule([{ spell: ARC }, { spell: ARC, id: "again" }]));
  assert.ok(v.ok);
  assert.deepEqual(v.rule.cast.map((c) => c.id), ["kbhapuzlusws6vvf", "again"]);
  // п.10: id не сдвигается при вставке перед ним; повтор того же заклинания получает номер; метка важнее хвоста UUID
  assert.deepEqual(validateRule(rule([{ spell: ARC, label: "Electric Arc" }, { spell: ARC }, { spell: ARC }])).rule.cast.map((c) => c.id), ["electric-arc", "kbhapuzlusws6vvf", "kbhapuzlusws6vvf-3"]);
  assert.equal(validateRule(rule([{ spell: "Compendium.x.Item.zzz" }, { spell: ARC }])).rule.cast[1].id, "kbhapuzlusws6vvf");
  assert.equal(validateRule(rule([{ spell: ARC, label: "Дуга" }])).rule.cast[0].id, "kbhapuzlusws6vvf");   // кириллическая метка — хвост UUID
  assert.equal(validateRule({ v: 1, onUse: { targets: "self", apply: [{ condition: { slug: "prone" } }] }, cast: [] }).rule.cast, undefined);
  assert.equal(validateRule({ v: 1, cast: [] }).errors[0].key, "rule.empty");
});

test("cast: spell обязателен, rank 1–10, dc — число или {level:high}, attack — целое, per.unit из единиц Apply, requires из списка, id уникален", () => {
  assert.match(errs([{}])[0], /cast\.bad \(cast\[0\]\.spell\)/);
  assert.match(errs([{ spell: ARC, rank: 0 }])[0], /\.rank/);
  assert.match(errs([{ spell: ARC, rank: 11 }])[0], /\.rank/);
  assert.match(errs([{ spell: ARC, dc: 0 }])[0], /\.dc/);
  assert.match(errs([{ spell: ARC, dc: { level: "low" } }])[0], /\.dc/);
  assert.match(errs([{ spell: ARC, dc: { level: "high", x: 1 } }])[0], /\.dc/);
  assert.match(errs([{ spell: ARC, attack: 1.5 }])[0], /\.attack/);
  assert.match(errs([{ spell: ARC, per: { value: 1, unit: "weeks" } }])[0], /\.per/);
  assert.match(errs([{ spell: ARC, per: { value: 0, unit: "days" } }])[0], /\.per/);
  assert.match(errs([{ spell: ARC, requires: "worn" }])[0], /\.requires/);
  assert.match(errs([{ spell: ARC, id: "a" }, { spell: ARC, id: "a" }])[0], /cast\[1\]\.id/);
  assert.match(errs([{ spell: ARC, id: "Not Slug" }])[0], /\.id/);
  assert.match(errs([{ spell: ARC, note: "" }])[0], /\.note/);
  assert.ok(validateRule(rule([{ spell: ARC, rank: 10, dc: { level: "high" }, attack: -2, per: { value: 10, unit: "minutes", uses: 2 }, requires: "none", label: "x", note: "y" }])).ok);
  assert.deepEqual(validateRule(rule([{ spell: ARC, per: { value: 1, unit: "days", uses: 1 } }])).rule.cast[0].per, { value: 1, unit: "days" });   // один раз — uses не пишется
});

test("cast: форма Мастерской туда-обратно без потерь", () => {
  const r = validateRule(rule([
    { id: "electric-arc", spell: ARC, rank: 4, dc: 17, attack: 7, per: { value: 1, unit: "days" }, requires: "invested", label: "Дуга", note: "заметка" },
    { id: "fear", spell: ARC, dc: { level: "high" }, per: { value: 10, unit: "minutes", uses: 2 }, requires: "none" },
    { id: "plain", spell: ARC }
  ])).rule;
  const back = validateRule(formToRule(ruleToForm(r)));
  assert.ok(back.ok, back.errors.join());
  assert.deepEqual(back.rule, r);
  assert.equal(ruleToForm(r).kind, "cast");
  assert.deepEqual(blankCast().dcType, "auto");
  const f = ruleToForm(null);
  f.cast.push({ ...blankCast(), spell: ARC });
  assert.deepEqual(validateRule(formToRule(f)).rule.cast, [{ id: "kbhapuzlusws6vvf", spell: ARC }]);
});

test("cast: dropSpec распознаёт заклинание (по источнику у вложенного), ruleUuids и отчёт видят активации", () => {
  assert.deepEqual(dropSpec({ type: "Item", uuid: ARC }, { type: "spell" }), { kind: "spell", text: ARC });
  assert.equal(dropSpec({ type: "Item", uuid: "Actor.a.Item.b" }, { type: "spell", parent: {}, _stats: { compendiumSource: ARC } }).text, ARC);
  const r = validateRule(rule([{ spell: ARC, rank: 3, dc: 17 }])).rule;
  assert.ok(ruleUuids(r).includes(ARC));
  const env = { t: (k, d) => `${k}${JSON.stringify(d ?? {})}`, uuidName: () => "Arc", conditionKnown: () => true, statLabel: (s) => s, cast: [{ dc: 17 }] };
  const rep = buildReport(r, [], env);
  assert.deepEqual(rep.cast, ['sheet.test.cast{"name":"Arc","rank":3,"dc":17}']);
  assert.deepEqual(buildReport(r, [], { ...env, uuidName: () => null }).problems.length, 1);   // заклинания нет в мире — проблема
});

/* ---------- вывод из разметки ---------- */

const JOLT = `<p>Contained within this small glass tube is a twisted wire filament. The spell DC of any spell cast by activating this item is 17.</p><ul><li><p><strong>Armor</strong> You gain resistance 2 to electricity.</p></li></ul>
<p>@Check[reflex|dc:17|basic|name:Jolt Coil Spell|traits:spell|showDC:all]</p><hr /><p><strong>Activate</strong> Cast a Spell</p>
<p><strong>Effect</strong> You cast @UUID[${ARC}]{Electric Arc}.</p>`;
const EEL = `<p>Shining eelskin covers the plates.</p><hr /><p><strong>Activate—Unleash Charge</strong> <span class="action-glyph">2</span> (manipulate)</p>
<p><strong>Frequency</strong> once per hour</p><hr /><p><strong>Effect</strong> You cast a 2nd-rank @UUID[Compendium.pf2e.spells-srd.Item.zDJS8E66UI0himqV]{Thunderstrike} with a @Check[reflex|dc:29|basic|traits:electricity,sonic,spell].</p>
<hr /><p><strong>Craft Requirements</strong> Supply one casting of <em>thunderstrike</em>.</p>`;
const NECK = `<p>Several sapphires.</p><p><strong>Activate—Win Them Over</strong> <span class="action-glyph">2</span> (concentrate)</p><p><strong>Frequency</strong> once per hour</p><hr />
<p><strong>Effect</strong> You cast a 4th-rank @UUID[Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6]{Charm} spell with a @Check[will|dc:38].</p>`;
const CUDGEL = `<p>Club.</p><hr /><p><strong>Activate</strong> <span class="action-glyph">2</span> Interact</p><p><strong>Frequency</strong> once per day</p><hr />
<p><strong>Effect</strong> You gesture at a square. The club casts @UUID[Compendium.pf2e.spells-srd.Item.4koZzrnMXhhosn0D]{Fear} (@Check[will|dc:24|name:Habu's Cudgel Fear|traits:fear]) targeting the creature.</p>`;
const BETRAYAL = `<p><strong>Suit</strong> Crowns</p><p><strong>Activate</strong> <span class="action-glyph">f</span> envision</p><p><strong>Frequency</strong> once per day</p><hr />
<p><strong>Effect</strong> You cast @UUID[Compendium.pf2e.spells-srd.Item.OsOhx3TGIZ7AhD0P]{Dominate} on a creature, and the save DC is your class DC (@Check[will|against:class|traits:incapacitation,mental,spell]).</p>`;
const STAFF = `<p>A staff.</p><hr /><p><strong>Activate—Sunder</strong> <span class="action-glyph">2</span> (death, force)</p><p><strong>Effect</strong> You destroy the staff, dealing @Damage[2d6[force]] with a @Check[reflex|dc:30|traits:death,force|basic] save.</p>
<hr /><p><strong>Activate</strong> Cast a Spell</p><p><strong>Effect</strong> You expend charges from the staff to cast a spell from its list.</p><ul><li><strong>1st</strong> @UUID[Compendium.pf2e.spells-srd.Item.xqmHD8JIjak15lRk]{Phantasmal Minion}</li><li><strong>2nd</strong> @UUID[Compendium.pf2e.spells-srd.Item.ynm8JIU3sc3qUMpa]{Everlight}</li></ul>`;
const SUN = `<p>A medallion.</p><hr /><p><strong>Activate</strong> <span class="action-glyph">1</span> (concentrate)</p>
<p><strong>Effect</strong> The <em>sun wheel</em> casts a @UUID[Compendium.pf2e.spells-srd.Item.TVKNbcgTee19PXZR]{Shield} spell benefiting you.</p>
<p>If the attacker is adjacent, you can deal @Damage[2d6[fire]] damage, which it gets a @Check[reflex|dc:21|basic] save to resist.</p>`;

test("deriveCast: Jolt Coil — СЛ из «spell DC … is 17», спеллхарт даёт раз в день; ранг не задан", () => {
  const d = deriveCast(JOLT, { traits: ["spellheart"] });
  assert.deepEqual(d.cast, [{ id: "electric-arc", spell: ARC, dc: 17, per: { value: 1, unit: "days" } }]);
  assert.equal(d.confidence, "high");
  assert.equal(deriveCast(JOLT).cast[0].per, undefined);   // без черты и фразы частоты нет
  assert.equal(deriveCast(JOLT.replace("</p>\n<p><strong>Effect", " Once per day for each spell.</p>\n<p><strong>Effect")).cast[0].per.unit, "days");
});

test("deriveCast: Eelskin, Necklace, Habu's Cudgel — ранг, СЛ из @Check абзаца, частота из Frequency", () => {
  assert.deepEqual(deriveCast(EEL).cast, [{ id: "thunderstrike", spell: "Compendium.pf2e.spells-srd.Item.zDJS8E66UI0himqV", rank: 2, dc: 29, per: { value: 1, unit: "hours" } }]);
  assert.deepEqual(deriveCast(NECK).cast, [{ id: "charm", spell: "Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6", rank: 4, dc: 38, per: { value: 1, unit: "hours" } }]);
  const c = deriveCast(CUDGEL);
  assert.deepEqual(c.cast, [{ id: "fear", spell: "Compendium.pf2e.spells-srd.Item.4koZzrnMXhhosn0D", dc: 24, per: { value: 1, unit: "days" } }]);
  assert.equal(c.confidence, "high");
});

test("deriveCast: нет СЛ — low, пока spellDefs не скажет, что у заклинания нет испытания; Sun Wheel — приписка с @Check, low", () => {
  const b = deriveCast(BETRAYAL), u = "Compendium.pf2e.spells-srd.Item.OsOhx3TGIZ7AhD0P";
  assert.deepEqual([b.cast[0].dc, b.confidence], [undefined, "low"]);
  assert.equal(deriveCast(BETRAYAL, { spellDefs: { [u]: { slug: "dominate", save: true } } }).confidence, "low");
  assert.equal(deriveCast(BETRAYAL, { spellDefs: { [u]: { slug: "dominate", save: false, attack: false } } }).confidence, "high");
  const s = deriveCast(SUN);
  assert.deepEqual(s.cast.map((c) => c.dc), [undefined]);   // 21 — СЛ приписки предмета, не заклинания
  assert.equal(s.confidence, "low");
});

test("deriveCast: две и более ссылок (список посоха) не выводятся; смешанный предмет — partial, low", () => {
  assert.equal(deriveCast(STAFF), null);
  const mixed = deriveCast(`${JOLT}<hr />${STAFF.slice(STAFF.indexOf("<p><strong>Activate—Sunder"))}`, { traits: ["spellheart"] });
  assert.deepEqual([mixed.cast.length, mixed.partial, mixed.confidence], [1, true, "low"]);
  assert.equal(deriveCast("<p>Nothing to activate.</p>"), null);
});

test("frequencyOf: раз/дважды/N раз за окно, неделя — 7 дней", () => {
  assert.deepEqual(frequencyOf("once per day"), { value: 1, unit: "days" });
  assert.deepEqual(frequencyOf("twice per day"), { value: 1, unit: "days", uses: 2 });
  assert.deepEqual(frequencyOf("once per 10 minutes"), { value: 10, unit: "minutes" });
  assert.deepEqual(frequencyOf("3 times per hour"), { value: 1, unit: "hours", uses: 3 });
  assert.deepEqual(frequencyOf("once per week"), { value: 7, unit: "days" });
  assert.deepEqual(frequencyOf("once per round"), { value: 1, unit: "rounds" });
  assert.equal(frequencyOf("at will"), null);
});

test("deriveFromMarkup: активация даёт cast, а @Check блока не превращается во второе испытание onUse", () => {
  const item = (html, traits = []) => ({ type: "armor", slug: "x", name: "Electric Eelskin", system: { description: { value: html }, traits: { value: traits } } });
  const d = deriveFromMarkup(item(EEL), { en: {} }, () => null);
  assert.equal(d.rule.cast.length, 1);
  assert.equal(d.rule.onUse, null);
  assert.equal(d.confidence, "high");
  const m = deriveFromMarkup(item(`${JOLT}<hr />${STAFF.slice(STAFF.indexOf("<p><strong>Activate—Sunder"))}`, ["spellheart"]), { en: {} }, () => null);
  assert.deepEqual([m.rule.cast.length, m.confidence, m.hints.lowWhy], [1, "low", ["cast-partial"]]);
  assert.equal(deriveFromMarkup(item(STAFF), { en: {} }, () => null)?.rule.cast, undefined);   // нет ни одной выводимой активации — прежний разбор
});

/* ---------- чистые части рантайма ---------- */

test("rankSource: явный ранг — heightenedLevel не ниже базового; кантрип — autoHeightenLevel по уровню предмета; исходник не меняется", () => {
  const spell = { system: { level: { value: 3 }, traits: { value: [] }, location: { value: null } } };
  const cantrip = { system: { level: { value: 1 }, traits: { value: ["cantrip"] }, location: { value: null } } };
  assert.deepEqual(rankSource(spell, 8, 4, "af-cast-x").system.location, { value: "af-cast-x", heightenedLevel: 4 });
  assert.equal(rankSource(spell, 8, 2, "e").system.location.heightenedLevel, 3);
  assert.deepEqual(rankSource(spell, 8, null, "e").system.location, { value: "e" });
  assert.equal(rankSource(cantrip, 7, null, "e").system.location.autoHeightenLevel, 4);
  assert.equal(rankSource(cantrip, 0, null, "e").system.location.autoHeightenLevel, 1);
  assert.equal(rankSource(cantrip, 7, 2, "e").system.location.autoHeightenLevel, 2);
  assert.equal(spell.system.location.value, null);
});

test("частота: окна минут/часов по времени мира, раунды — по бою, дни — только отдых; uses; откат по карточке", () => {
  const now = { time: 10_000, combat: "c1", round: 3 };
  assert.equal(usesLeft(undefined, { value: 1, unit: "days" }, now), 1);
  assert.equal(usesLeft(undefined, null, now), null);
  const e1 = withUse(undefined, { value: 1, unit: "days" }, now, "m1");
  assert.deepEqual(e1, { at: now, log: ["m1"] });
  assert.equal(usesLeft(e1, { value: 1, unit: "days" }, { ...now, time: 10_000 + 86400 * 30 }), 0);   // дни время не закрывает
  const hour = { value: 1, unit: "hours" };
  assert.equal(usesLeft(e1, hour, { ...now, time: 10_000 + 3599 }), 0);
  assert.equal(usesLeft(e1, hour, { ...now, time: 10_000 + 3600 }), 1);
  assert.deepEqual(withUse(e1, hour, { ...now, time: 20_000 }, "m2"), { at: { ...now, time: 20_000 }, log: ["m2"] });   // окно закрылось — новое
  const twice = { value: 1, unit: "days", uses: 2 }, e2 = withUse(e1, twice, now, "m2");
  assert.deepEqual([usesLeft(e1, twice, now), usesLeft(e2, twice, now)], [1, 0]);
  const rounds = { value: 2, unit: "rounds" };
  assert.deepEqual([usesLeft(e1, rounds, { ...now, round: 4 }), usesLeft(e1, rounds, { ...now, round: 5 }), usesLeft(e1, rounds, { ...now, combat: "c2" }), usesLeft(e1, rounds, { ...now, combat: null })], [0, 1, 1, 1]);
  assert.deepEqual(withoutUse(e2, "m2"), { at: now, log: ["m1"] });
  assert.equal(withoutUse(e1, "m1"), null);
  assert.equal(withoutUse(e1, "zzz"), e1);
});

test("requirementOf: по предмету — настроенный требует invested, остальное equipped; none и не-физический не проверяются", () => {
  const worn = { isEquipped: true, isInvested: true }, uninvested = { isEquipped: true, isInvested: false }, plain = { isEquipped: false, isInvested: null };
  assert.equal(requirementOf(worn, undefined), null);
  assert.equal(requirementOf(uninvested, undefined), "invested");
  assert.equal(requirementOf(plain, undefined), "equipped");
  assert.equal(requirementOf({ isEquipped: true, isInvested: null, isHeld: false }, "held"), "held");
  assert.equal(requirementOf(plain, "none"), null);
  assert.equal(requirementOf(uninvested, "equipped"), null);
  assert.equal(requirementOf({}, undefined), null);   // способность NPC: не предмет
  assert.equal(requirementOf(null, undefined), null);
});

test("highDc: таблица Spell DC колонка High (-1..24), атака = СЛ - 8, края зажаты; levelDc — calculateDC; id записи разбирается обратно", () => {
  assert.deepEqual([highDc(1), highDc(5), highDc(13), highDc(-1), highDc(0), highDc(99)], [17, 22, 33, 16, 16, 48]);
  // п.7: уровни 22-24 (формула «уровень+2» завышала: 46/48/50)
  assert.deepEqual([22, 23, 24].map(highDc), [45, 46, 48]);
  assert.deepEqual([10, 24].map(highAttack), [21, 40]);
  assert.deepEqual([...Array(26).keys()].map((i) => highDc(i - 1)), [16, 16, 17, 18, 20, 21, 22, 24, 25, 26, 28, 29, 30, 32, 33, 34, 36, 37, 38, 40, 41, 42, 44, 45, 46, 48]);
  assert.deepEqual([levelDc(0), levelDc(1), levelDc(11), levelDc(25), levelDc(undefined)], [14, 15, 28, 50, 14]);
  const id = entryId({ id: "AbCdEfGh12345678" }, "electric-arc");
  assert.deepEqual(ID.exec(id).slice(1), ["AbCdEfGh12345678", "electric-arc"]);
  assert.equal(ID.exec("trick-arcana"), null);
});

test("tracksUses: счётчик не ведём у способности со своей частотой и у «в день» NPC; почасовой — ведём всегда", () => {
  const day = { value: 1, unit: "days" }, hour = { value: 1, unit: "hours" };
  const pc = { actor: { type: "character" } }, npc = { actor: { type: "npc" } };
  assert.deepEqual([tracksUses(pc, day), tracksUses(npc, day), tracksUses(npc, hour), tracksUses(pc, null)], [true, false, true, false]);
  assert.equal(tracksUses({ ...pc, system: { frequency: { max: 1, per: "day" } } }, day), false);
});

test("deriveFromMarkup: расходник (палочка) в живом выводе без cast — заряды ведёт pf2e", () => {
  const html = EEL;
  const mk = (type) => ({ type, slug: "x", name: "Wand", system: { description: { value: html }, traits: { value: [] } } });
  assert.equal(deriveFromMarkup(mk("armor"), { en: {} }, () => null).rule.cast.length, 1);
  assert.equal(deriveFromMarkup(mk("consumable"), { en: {} }, () => null)?.rule.cast, undefined);
});

test("wantsSnapshot: правило только с cast — снимок нужен и карточке предмета; stepCount считает активации", () => {
  const r = validateRule(rule([{ spell: ARC }])).rule;
  assert.equal(wantsSnapshot("card", r), true);
  assert.equal(wantsSnapshot("use", r), true);
  assert.equal(stepCount(r), 1);
});

/* ---------- карточка ---------- */

const MOD = "pf2e-automato";
const mkEnv = (over = {}) => ({
  t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), mode: () => "auto", now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false,
  tokenName: (k) => k, isOwner: () => false, isActorOwner: (uuid, user) => user.owns?.includes(uuid) ?? false, statLabel: (s) => s, conditionLabel: (s) => s,
  uuidName: (u) => (u === ARC ? "Electric Arc" : null), castInfo: () => ({ why: null, left: null, dc: 17 }), ...over
});
const mkMsg = (castRule) => ({ id: "m1", author: { id: "a" }, flags: { [MOD]: { use: { v: 1, kind: "card", confidence: "high", rule: castRule, createdAt: 1, item: { uuid: "Actor.a.Item.i", name: "Jolt Coil" }, actor: "Actor.a", state: {} } } } });
const gm = { id: "gm", isGM: true }, owner = { id: "a", isGM: false, owns: ["Actor.a"] }, other = { id: "x", isGM: false };

test("карточка: кнопка на каждую активацию владельцу и ведущему, прочим — нет; подпись с СЛ и частотой", () => {
  const r = validateRule(rule([{ spell: ARC, rank: 4, per: { value: 1, unit: "days" }, note: "только днём" }, { id: "b", spell: ARC, label: "Вторая" }])).rule;
  const vm = buildViewModel(mkMsg(r), owner, mkEnv());
  assert.deepEqual(vm.cast.map((c) => c.id), ["kbhapuzlusws6vvf", "b"]);
  assert.equal(vm.cast[0].text, 'cast.btn{"name":"Electric Arc"}');
  assert.equal(vm.cast[1].text, 'cast.btn{"name":"Вторая"}');
  assert.match(vm.cast[0].meta, /chat\.dc.*cast\.rank.*cast\.per/);
  assert.equal(vm.cast[0].note, "только днём");
  assert.equal(vm.empty, false);
  assert.equal(buildViewModel(mkMsg(r), gm, mkEnv({ isActorOwner: () => true })).cast.length, 2);
  assert.equal(buildViewModel(mkMsg(r), other, mkEnv()).cast, null);
  assert.equal(buildViewModel(mkMsg(r), other, mkEnv()).empty, true);
});

test("карточка: правило low (вывод из разметки) — кнопки только ведущему, даже владельцу; запасная СЛ подписана", () => {
  const r = validateRule(rule([{ spell: ARC }])).rule, low = mkMsg(r);
  low.flags[MOD].use.confidence = "low";
  assert.equal(buildViewModel(low, owner, mkEnv({ isActorOwner: () => true })).cast, null);
  assert.equal(buildViewModel(low, gm, mkEnv({ isActorOwner: () => true })).cast.length, 1);
  const lv = buildViewModel(mkMsg(r), owner, mkEnv({ castInfo: () => ({ why: null, left: null, dc: 20, byLevel: true }) })).cast[0];
  assert.match(lv.meta, /chat\.dc.*cast\.byLevel/);
});

test("карточка: невыполненное требование отключает кнопку с причиной, исчерпанная частота — пометка, не запрет", () => {
  const r = validateRule(rule([{ spell: ARC, per: { value: 1, unit: "days" } }])).rule;
  const why = buildViewModel(mkMsg(r), owner, mkEnv({ castInfo: () => ({ why: "invested", left: 1, dc: null }) })).cast[0];
  assert.equal(why.why, "cast.why.invested");
  assert.doesNotMatch(why.meta, /chat\.dc/);
  const spent = buildViewModel(mkMsg(r), owner, mkEnv({ castInfo: () => ({ why: null, left: 0, dc: 17 }) })).cast[0];
  assert.equal(spent.why, null);
  assert.match(spent.meta, /cast\.spent/);
});

test("Мастерская: строка активации — заклинание, ранг, СЛ, частота, требование", () => {
  const f = ruleToForm(validateRule(rule([{ spell: ARC, rank: 4, dc: { level: "high" }, per: { value: 1, unit: "days", uses: 2 }, requires: "held" }])).rule);
  const line = castLine(f.cast[0], { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), uuidName: () => "Electric Arc" });
  assert.equal(line.head, "Electric Arc");
  assert.equal(line.body, 'cast.rank{"rank":4} · workshop.au.cast.dcHigh · cast.per{"uses":2,"window":"","unit":"workshop.unitShort.days"} · workshop.au.cast.req.held');
});

/* ---------- инструменты ---------- */

test("tools: ответ агента с cast проходит валидатор и круг формы; чужой UUID заклинания — ошибка по тексту", () => {
  const ans = { uuid: "u", rule: { v: 1, label: "Jolt Coil", cast: [{ id: "electric-arc", spell: ARC, dc: 17, per: { value: 1, unit: "days" } }] } };
  const any = new Proxy({}, { get: () => true });
  assert.equal(checkAnswer(ans, { conditions: any, effects: any }, JOLT).kind, "accepted");
  const bad = checkAnswer({ ...ans, rule: { ...ans.rule, cast: [{ ...ans.rule.cast[0], spell: "Compendium.pf2e.spells-srd.Item.zzz" }] } }, { conditions: any, effects: any }, JOLT);
  assert.equal(bad.kind, "error");
  assert.match(bad.errors[0], /not mentioned/);
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, cast: [{ spell: "" }] } }, { conditions: any, effects: any }).errors[0].includes("Activation (cast)"), true);
  assert.deepEqual(semanticErrors(validateRule(ans.rule).rule, { conditions: {}, effects: {} }, null), []);
});
