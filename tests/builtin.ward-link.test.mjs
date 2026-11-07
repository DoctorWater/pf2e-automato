// 0.5g6: встроенные обработчики под группы — щит прикрывает союзника, перенос урона, трата слота как реакция, чутьё сущности, доля добычи. Чистая логика, без Foundry.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = {
  combats: [],
  user: { isActiveGM: true }, users: [], modules: { get: () => null }, settings: { get: () => true },
  i18n: { localize: (k) => k, format: (k) => k }
};

const lib = await import("../scripts/builtin/lib.mjs");
const ward = await import("../scripts/builtin/shield-ward.mjs");
const chan = await import("../scripts/builtin/channeling-block.mjs");
const link = await import("../scripts/builtin/damage-link.mjs");
const app = await import("../scripts/builtin/apparition-sense.mjs");
const share = await import("../scripts/builtin/prey-share.mjs");
const { GROUP_HANDLERS: BUILTIN_HANDLERS, SCRIPT_EFFECTS } = await import("../tools/pa-port.mjs");

test("slug предмета: свой, иначе по исходному имени babele, иначе по имени (копии NPC и перевод)", () => {
  assert.equal(lib.itemSlug({ slug: "shield-warden", name: "Щитоносец" }), "shield-warden");
  assert.equal(lib.itemSlug({ slug: null, name: "Щитоносец", flags: { babele: { originalName: "Shield Warden" } } }), "shield-warden");
  assert.equal(lib.itemSlug({ name: "Warden's Boon" }), "wardens-boon");
  const actor = { items: [{ type: "effect", slug: "shield-warden" }, { type: "feat", slug: "x", name: "X" }, { type: "action", slug: null, name: "Shield Warden" }] };
  assert.equal(lib.heldSlug(actor, ["shield-warden"]), "shield-warden");   // эффект с тем же slug не в счёт, копия NPC — да
  assert.equal(lib.heldSlug({ items: [{ type: "effect", slug: "shield-warden" }] }, ["shield-warden"]), null);
});

test("прикрытие щитом: досягаемость, поднятый щит, реакция, физический урон у Стойки кенотафа и сама стойка", () => {
  const base = { entry: ward.COVER["shield-warden"], raised: true, hp: 10, reaction: true, distance: 5, types: ["slashing"], stance: false };
  assert.equal(ward.canCover(base), true);
  assert.equal(ward.canCover({ ...base, distance: 10 }), false);
  assert.equal(ward.canCover({ ...base, raised: false }), false);
  assert.equal(ward.canCover({ ...base, reaction: false }), false);
  assert.equal(ward.canCover({ ...base, hp: 0 }), false);
  assert.equal(ward.canCover({ ...base, entry: undefined }), false);
  const ceno = { ...base, entry: ward.COVER["cenotaph-stance"], distance: 15, stance: true };
  assert.equal(ward.canCover(ceno), true);
  assert.equal(ward.canCover({ ...ceno, stance: false }), false);
  assert.equal(ward.canCover({ ...ceno, types: ["fire"] }), false);
  assert.equal(ward.canCover({ ...ceno, types: ["fire", "piercing"] }), true);
  assert.equal(ward.canCover({ ...ceno, types: null }), true);   // типов не видно — не отказываем
  assert.deepEqual(ward.damageTypes({ rolls: [{ instances: [{ type: "fire" }, { type: "piercing" }] }] }), ["fire", "piercing"]);
  assert.equal(ward.damageTypes({ rolls: [{}] }), null);
});

test("группа прикрытия выводится из текста: дистанция, физический урон, стойка; скакун и общий slug — долг", async () => {
  const { coverOf, buildCover } = await import("../tools/ward-cover.mjs");
  assert.deepEqual(coverOf("you can use your Shield Block reaction when an attack is made against an ally adjacent to you"), { feet: 5, physical: undefined });
  assert.deepEqual(coverOf("Shield Block reaction when an ally within 15 feet of you takes physical damage"), { feet: 15, physical: true });
  assert.deepEqual(coverOf("Raises their Shield, but grants the benefit to an adjacent ally and can Shield Block for that ally."), { feet: 5, physical: undefined });
  assert.deepEqual(coverOf("Shield Block reaction, you can use it when your mount would take physical damage"), { mount: true });
  assert.equal(coverOf("adjacent allies who would take damage also benefit from the damage reduction of Shield Block"), null);
  const d = (slug, descEn, extra = {}) => ({ type: "feat", slug, descEn, ...extra });
  const { cover, debt } = buildCover([
    d("a", "Shield Block when an ally within 10 feet is hit"), d("m", "Shield Block when your mount would take damage"),
    d("s", "Shield Block when an ally adjacent to you is attacked", { selfEffect: "x", traits: ["stance"] }), d("g", "Shield Block, nothing", { uuid: "U1" }), d("g", "Shield Block when an adjacent ally is hit", { uuid: "U2" })
  ]);
  assert.deepEqual(cover, { a: { feet: 10 }, g: { feet: 5, sources: ["U2"] }, s: { feet: 5, stance: "stance-s" } });   // общий slug — по исходному документу
  assert.deepEqual(debt, { g: "actor-source-only", m: "mount-link" });
  assert.equal(ward.COVER["living-shield"].feet, 10);
  // реальная форма: у предмета NPC compendiumSource нет, он есть у актёра (…Actor.<id>)
  const held = (slug, src) => ({ _stats: { compendiumSource: src }, items: [{ type: "action", slug, sourceId: null, _stats: { compendiumSource: null } }] });
  cover.g.sources = ["Compendium.p.Actor.AID.Item.I2"];
  assert.equal(ward.coverSlug(held("g", "Compendium.p.Actor.AID"), cover), "g");
  assert.equal(ward.coverSlug(held("g", "Compendium.p.Actor.OTHER"), cover), null);   // другая способность с тем же slug
  assert.equal(ward.coverSlug(held("g", null), cover), null);   // актёр не из пака — не срабатывает
  assert.equal(ward.coverSlug(held("a", null), cover), "a");
  assert.ok(ward.COVER["shield-warden"] && ward.COVER["blanket-defense"] && ward.COVER["shield-warden-fighter"] && ward.COVER["guardian-shield"]);
});

test("прикрытие: стойка кенотафа — любой физический урон, остальные — только атака; настоящий щит и варианты без дублей", () => {
  const base = { entry: ward.COVER["cenotaph-stance"], raised: true, hp: 5, reaction: true, distance: 10, types: ["bludgeoning"], stance: true };
  assert.equal(ward.canCover({ ...base, attack: false }), true);
  assert.equal(ward.canCover({ ...base, attack: false, types: ["fire"] }), false);
  assert.equal(ward.canCover({ ...base, entry: ward.COVER["shield-warden"], distance: 5, attack: false }), false);
  assert.equal(chan.realShield({ items: { get: () => ({ type: "shield" }) }, attributes: { shield: { itemId: "s" } } }), true);
  assert.equal(chan.realShield({ items: { get: () => ({ type: "effect" }) }, attributes: { shield: { itemId: "s" } } }), false);
  const o = (slot) => ({ entry: "E", spell: "h", rank: 3, slot });
  assert.equal(chan.uniqueOptions([o(0), o(1), { ...o(2), rank: 4 }]).length, 2);
});

test("прикрытие: щит держателя вместо щита цели, урон щиту только по сообщению pf2e о нём", () => {
  const s = { name: "Щит", hardness: 5, itemId: "G1", raised: true, hp: { value: 20, max: 20 } };
  const w = ward.wardShield(s, "n1");
  assert.deepEqual(w, { ...s, itemId: "af-ward:n1:G1" });   // фиктивный id: pf2e не тронет настоящий щит, сообщение ловится по нему
  assert.equal(ward.realShieldId(w.itemId), "G1");
  assert.notEqual(w.hp, s.hp);
  const taken = (shield) => ({ flags: { pf2e: { context: { type: "damage-taken" }, appliedDamage: { shield } } } });
  assert.equal(ward.shieldDamage(taken({ id: "G1", damage: 7 }), "G1"), 7);
  assert.equal(ward.shieldDamage(taken({ id: "OTHER", damage: 7 }), "G1"), null);
  assert.equal(ward.shieldDamage(taken(null), "G1"), null);
  assert.equal(ward.shieldDamage({ flags: { pf2e: { context: { type: "damage-roll" } } } }, "G1"), null);
});

test("Преданный страж: +2 с башенным щитом, иначе +1; бонус только пока щит стража поднят", () => {
  assert.equal(ward.guardBonus("tower-shield"), 2);
  assert.equal(ward.guardBonus("steel-shield"), 1);
  assert.equal(ward.guardBonus(undefined), 1);
  const [r] = ward.guardRules(2, "L");
  assert.equal(r.type, "circumstance");
  assert.deepEqual(r.predicate, ["parent:origin:shield:raised"]);
  assert.ok(ward.GUARD.has("devoted-guardian"));
});

test("Проводящий блок: подготовленные — слот с Лечением/Вредом не потрачен; спонтанные — есть слот ранга; сигнатурное — любой ранг от базового", () => {
  const spells = [{ id: "h", slug: "heal", name: "Heal", base: 1, signature: true }, { id: "m", slug: "harm", name: "Harm", base: 3, signature: false }, { id: "x", slug: "fireball", name: "Fireball", base: 3 }];
  const prepared = { id: "E1", name: "Cleric", mode: "prepared", spells, slots: { 1: { max: 2, prepared: [{ id: "h", expended: false }, { id: "x" }] }, 2: { max: 1, prepared: [{ id: "h", expended: true }] }, 3: { max: 2, prepared: [{ id: "m" }, { id: "h" }] } } };
  assert.deepEqual(chan.blockOptions([prepared]).map((x) => x.id), ["E1:h:1:0", "E1:m:3:0", "E1:h:3:1"]);
  const spont = { id: "E2", name: "Sorc", mode: "counted", spells, slots: { 1: { max: 2, value: 0 }, 2: { max: 2, value: 1 }, 3: { max: 1, value: 1 } } };
  assert.deepEqual(chan.blockOptions([spont]).map((x) => x.id), ["E2:h:2:", "E2:h:3:", "E2:m:3:"]);   // 1-й ранг без слотов; Вред не сигнатурный — только свой ранг
  assert.deepEqual(chan.blockOptions([{ ...spont, spells: [spells[2]] }]), []);
  assert.equal(chan.EFFECT, "Compendium.pf2e.feat-effects.Item.Rzg3c7hfkvTlxPDp");
});

test("перенос урона: Связь жизни — порог по рангу, Кровные узы — половина вниз цели; вместе — по очереди, не больше урона", () => {
  const L1 = link.LINKS["life-link"], S = link.LINKS["share-life"];
  assert.deepEqual([1, 2, 3, 5, 6, 8, 9, 10].map((r) => link.reduction(L1, r, 99)), [3, 3, 5, 5, 10, 10, 15, 15]);
  assert.equal(link.reduction(L1, 1, 2), 2);   // урона меньше порога
  assert.deepEqual([0, 1, 5, 7, 10].map((d) => link.reduction(S, 4, d)), [0, 1, 3, 4, 5]);   // цель берёт floor(d/2), заклинатель остаток
  assert.deepEqual([1, 3, 6, 9].map((r) => link.linkCount(L1, r)), [1, 2, 3, 4]);
  assert.equal(link.linkCount(S, 9), 1);
  assert.deepEqual(link.distribute([{ def: L1, rank: 1 }, { def: S, rank: 4 }], 10), [{ i: 0, amount: 3 }, { i: 1, amount: 4 }]);   // 10 -> -3 = 7 -> -4 = 3
  assert.deepEqual(link.distribute([{ def: L1, rank: 9 }, { def: S, rank: 4 }], 2), [{ i: 0, amount: 2 }, { i: 1, amount: 0 }]);
  assert.equal(link.LINKS["shield-other"].effect, link.LINKS["share-life"].effect);   // Щит за другого — тот же текст
});

test("перенос урона до применения: бросок и число уменьшаются на перенос; урон самого переноса и лечение не трогаются", () => {
  globalThis.fromUuidSync = () => ({ uuid: "C", getActiveTokens: () => [] });
  const eff = (slug, level = 1) => ({ id: slug, slug, flags: {}, system: { level: { value: level }, context: { origin: { actor: "C" } } } });
  const actor = { uuid: "T", itemTypes: { effect: [eff("effect-life-link"), eff("effect-share-life", 4)] } };
  const r = link.intercept(actor, { damage: 10 });
  assert.equal(r.damage, 3);   // 10 -3 (Life Link) = 7, -4 (Share Life) = 3
  assert.deepEqual(r.rows.map((x) => [x.id, x.amount]), [["effect-life-link", 3], ["effect-share-life", 4]]);
  const roll = { total: 10, alter: (m, a) => ({ altered: a }) };
  assert.deepEqual(link.intercept(actor, { damage: roll }).damage, { altered: -7 });
  assert.equal(link.intercept(actor, { damage: 10, rollOptions: new Set([link.LINK_OPTION]) }), null);
  assert.equal(link.intercept(actor, { damage: -5 }), null);
  assert.equal(link.intercept({ uuid: "T", itemTypes: { effect: [] } }, { damage: 10 }), null);
});

test("перенос урона: срок заклинания; связи цели — по slug эффекта и заклинателю, Связь жизни первой, своя связь не считается", () => {
  assert.deepEqual(link.spellDuration("10 minutes"), { value: 10, unit: "minutes" });
  assert.deepEqual(link.spellDuration("1 minute"), { value: 1, unit: "minutes" });
  assert.equal(link.spellDuration("until the next time you make your daily preparations"), null);
  const fx = (slug, caster, level = 1) => ({ slug, system: { level: { value: level }, context: { origin: { actor: caster } } } });
  const got = link.linksOf([fx("effect-share-life", "A"), fx("effect-rage", "A"), fx("effect-life-link", "A", 6), fx("effect-life-link", "SELF")], "SELF");
  assert.deepEqual(got.map((l) => [l.def.slug, l.rank, l.caster]), [["life-link", 6, "A"], ["share-life", 1, "A"]]);
});

test("Чутьё сущности: скрытые союзники и враги в 30 фт, без видимых, дальних и посторонних черт", () => {
  const n = (o) => ({ traits: ["undead"], hidden: true, feet: 20, ...o });
  assert.deepEqual(app.sensed([n({ ally: true }), n({ ally: false, traits: ["spirit", "undead"] }), n({ traits: ["haunt"] }), n({ traits: ["undead"] })]), ["spirit", "haunt", "undead"]);
  assert.deepEqual(app.sensed([n({ hidden: false }), n({ feet: 30.1 }), n({ traits: ["beast"] })]), []);
  assert.deepEqual(app.sensed([n({ feet: 30 })]), ["undead"]);
});

test("Чутьё сущности: карточка учитывает союзника и не раскрывает токены, имена и позиции", async (t) => {
  const old = { scenes: game.scenes, users: game.users, format: game.i18n.format, config: globalThis.CONFIG, chat: globalThis.ChatMessage };
  t.after(() => { game.scenes = old.scenes; game.users = old.users; game.i18n.format = old.format; globalThis.CONFIG = old.config; globalThis.ChatMessage = old.chat; });
  const actor = { name: "Анимист", testUserPermission: () => true };
  const token = (id, traits, feet, hidden = true) => ({
    id, name: `Токен ${id}`, hidden, actor: { name: `Существо ${id}`, traits, isAllyOf: () => { throw Error("союзность не должна проверяться"); } }, object: { feet }
  });
  const own = token("self", ["spirit"], 0);
  own.object.distanceTo = (target) => target.feet;
  const ally = token("ally-secret", ["undead"], 30);
  ally.actor.hasCondition = () => false;
  const enemy = token("enemy-secret", ["haunt"], 15, false);
  enemy.actor.hasCondition = (...conditions) => conditions.includes("invisible");
  const scene = { tokens: [own, ally, enemy, token("visible", ["spirit"], 10, false), token("far", ["spirit"], 31)] };
  scene.tokens.get = (id) => scene.tokens.find((x) => x.id === id);
  own.parent = scene;
  game.scenes = { get: () => scene };
  game.users = [{ id: "gm", isGM: true }, { id: "owner", isGM: false }];
  game.i18n.format = (_key, data) => `${data.name}: ${data.list}`;
  globalThis.CONFIG = { PF2E: { creatureTraits: { spirit: "spirit", haunt: "haunt", undead: "undead" } } };
  const messages = [];
  globalThis.ChatMessage = { create: (data) => { messages.push(data); }, getSpeaker: () => ({}) };

  await app.onMessage({ flags: { pf2e: { origin: { type: "feat" } } }, item: { slug: app.SLUG, actor }, speaker: { scene: "S", token: "self" } });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].whisper, ["gm", "owner"]);
  assert.match(messages[0].content, /haunt, undead/);
  for (const secret of ["ally-secret", "enemy-secret", "visible", "far", "15", "30"]) assert.doesNotMatch(messages[0].content, new RegExp(secret));
});

test("доля добычи: тег pf2e hunters-edge-sharing; действие — Дар заступника, пассивка — Общая добыча / Тройная угроза", () => {
  const f = (slug, type, otherTags = ["hunters-edge-sharing"]) => ({ type: "feat", slug, system: { traits: { otherTags }, actionType: { value: type } } });
  assert.equal(share.isSharer(f("wardens-boon", "action")), true);
  assert.equal(share.isBoon(f("wardens-boon", "action")), true);
  assert.equal(share.isBoon(f("shared-prey", "passive")), false);
  assert.equal(share.isSharer(f("flurry", "passive", [])), false);
  assert.deepEqual(share.PASSIVE_ALLIES, { "shared-prey": [1], "triple-threat": [2, 1] });
  assert.equal(share.boonRounds(20, 15), 0);   // союзник ходит позже в этом раунде — конец его хода в этом раунде
  assert.equal(share.boonRounds(15, 20), 1);   // уже ходил — следующий ход в следующем раунде
  assert.equal(share.boonRounds(15, null), null);
});

test("доля добычи: добыча охотника — метка hunted-prey с токеном; ссылки на эффекты берутся из описания", () => {
  const eff = (rules) => ({ type: "effect", system: { rules } });
  assert.deepEqual(share.preyUuids([eff([{ key: "TokenMark", slug: "hunted-prey", uuid: "Scene.s.Token.t" }]), eff([{ key: "TokenMark", slug: "hunted-prey" }]), eff([{ key: "TokenMark", slug: "other", uuid: "x" }])]), ["Scene.s.Token.t"]);
  const html = `<a data-uuid="Compendium.pf2e.feat-effects.Item.uXCU8GgriUjuj5FV">Effect</a> @UUID[Compendium.pf2e.feat-effects.Item.uXCU8GgriUjuj5FV] <a data-uuid="Compendium.pf2e.actionspf2e.Item.JYi4MnsdFu618hPm">Hunt Prey</a>`;
  assert.deepEqual(share.effectLinks(html), ["Compendium.pf2e.feat-effects.Item.uXCU8GgriUjuj5FV"]);
});

test("учёт pa-port: обработчики PA группы -> встроенные; пустые эффекты Life Link / Share Life ведёт damage-link", () => {
  for (const h of ["shieldWarden", "shieldWardenDamageTaken", "devotedGuardian"]) assert.equal(BUILTIN_HANDLERS[h], "shield-ward");
  assert.equal(BUILTIN_HANDLERS.channelingBlock, "channeling-block");
  assert.equal(BUILTIN_HANDLERS.apparitionSense, "apparition-sense");
  assert.equal(BUILTIN_HANDLERS.wardensBoon, "prey-share");
  assert.equal(BUILTIN_HANDLERS.sharedPrey, "prey-share");
  assert.deepEqual(Object.values(SCRIPT_EFFECTS), ["damage-link", "damage-link"]);
});

test("Тройная угроза: одна добыча — два союзника, две — один; Общая добыча — один при одной добыче", () => {
  assert.deepEqual(share.PASSIVE_ALLIES["triple-threat"], [2, 1]);
  assert.deepEqual(share.PASSIVE_ALLIES["shared-prey"], [1]);
  assert.equal(share.PASSIVE_ALLIES["shared-prey"][1], undefined);   // две добычи — 0 (`?? 0` в afterHunt)
});

test("учёт Heal/Harm: заклинание компендиума покрыто обработчиком (у PC с чертой PA срабатывает), копии NPC без черты — false-coverage", async () => {
  const { readFileSync } = await import("node:fs");
  const acc = JSON.parse(readFileSync(new URL("../rules/drafts-accepted/pa-port.json", import.meta.url), "utf8")).items.filter((a) => ["heal", "harm"].includes(a.slug) && /channeling-block/.test(a.reason));
  assert.equal(acc.length, 4);
  for (const a of acc) assert.equal(a.paStatus, a.uuid.includes(".spells-srd.") ? "covered" : "false-coverage", a.uuid);
});
