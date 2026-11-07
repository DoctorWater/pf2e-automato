// Урон по итогам обычного (basic) спасброска. Бросок урона pf2e, идущий за карточкой модуля с basic-испытанием, наносится каждой цели
// карточки в её доле по степени (×0/×½/×1/×2); поздние результаты и перебросы спасброска (saves.afterRecord) досчитываются.
// Связь «урон — карточка» живёт во флагах: на карточке use.state.basicDamage = {msg}, на сообщении урона flags.<MOD>.basicDamage = {card, done}.
// Нанесение — по образцу pf2e applyDamageFromMessage, но по токенам карточки; откат штатной кнопкой pf2e (маркер в rollOptions) снимает отметку.
// plans/plan-basic-damage.md, раздел «v2».
import { L, MOD, DEGREES, queue, flagPath, isActiveGM, callGM } from "../util.mjs";
import { modeOf, effectiveMode } from "../settings.mjs";
import { esc, headOf, card, combatOf } from "./lib.mjs";
import { EXTERNAL } from "../compat.mjs";
import { alreadyApplied } from "./shield-block.mjs";
import { damageMultiplier } from "../saves.mjs";
import { ruleDamageSteps, normFormula, dealModes } from "../damage-button.mjs";

const WINDOW = 200;   // сообщений назад: между карточкой и уроном бывают Удары и чужие броски
const MULT_TEXT = { 0: "×0", 0.5: "×½", 1: "×1", 2: "×2" };

/* ---------- чистые функции ---------- */

const BASIC = [0, 1, 2, 3].map((d) => damageMultiplier(d, true));   // по степени pf2e 0..3: ×2 ×1 ×½ ×0
/** Множитель по степени: table — массив по индексу степени (как BASIC), иначе обычный (basic). */
export const multOf = (degree, table = BASIC) => table[degree] ?? null;
export const linkOf = (m) => m?.flags?.[MOD]?.basicDamage ?? null;
export const markerOf = (dmgId, key) => `${MOD}:basic:${dmgId}:${key}`;

/** Маркер нанесения в roll options damage-taken -> {dmgId, key} | null. */
export function parseMarker(options) {
  const re = new RegExp(`^${MOD}:basic:([^:]+):([^:]+)$`);
  for (const o of options ?? []) { const m = re.exec(o); if (m) return { dmgId: m[1], key: m[2] }; }
  return null;
}

/** Урон-бросок не от атаки и не лечение. */
export function isBasicDamage(message) {
  const ctx = message?.flags?.pf2e?.context;
  return ctx?.type === "damage-roll" && ctx.sourceType !== "attack" && !!message.rolls?.[0]?.kinds?.has?.("damage");
}

/** Правило само наносит урон шагами damage (в onUse.apply или по степеням) — механизм молчит, иначе урон удвоится. */
export function ruleDealsDamage(rule) {
  const u = rule?.onUse ?? {}, ch = u.challenge;
  return [...(u.apply ?? []), ...Object.values(ch?.byDegree ?? {}).flat()].some((s) => s?.damage);
}

/** basic: явный признак правила, иначе (basic не указан) признак заклинания defense.save.basic. check (бросок автора) — не испытание цели. */
export function isBasicChallenge(rule, item) {
  const ch = rule?.onUse?.challenge;
  if (!ch) return false;
  return ch.basic === true || (ch.basic == null && !!item?.system?.defense?.save?.basic);
}

/**
 * Таблица множителей урона по степени (массив по индексу степени) или null — урона по итогам нет. basic — ×2/×1/×½/×0; иначе у не-basic
 * испытания — challenge.damageByDegree правила (оверлей rules/damage-degrees.json вливает rules.resolveRule нижним слоем).
 */
export function degreeTable(rule, item) {
  const ch = rule?.onUse?.challenge;
  if (!ch) return null;
  if (isBasicChallenge(rule, item)) return BASIC;
  const t = ch.damageByDegree ?? null;
  return t ? DEGREES.map((d) => t[d] ?? 0) : null;
}

const squash = (f) => String(f ?? "").replace(/\s+/g, "").toLowerCase();

/**
 * Бросок, чей урон наносит само правило (ссылка @Damage в описании: опасная местность, шаг damage/persistent) — к карточке не относится.
 * roll: {formula, _formula?, instances?}; steps — ruleDamageSteps. У pf2e DamageRoll.formula локализован и упрощён («1 огонь», «1d6 огонь»),
 * поэтому формула шага (с подставленными @actor.level/@item.rank/@item.level — resolve) прогоняется через тот же DamageRoll (normalize) и сравнивается по .formula.
 * Бросок из одних продолжительных экземпляров — только кнопка «Наложить продолжительный урон», к урону карточки не относится.
 */
export function rollIsRuleDamage(roll, steps, { resolve = () => null, normalize = (s) => s } = {}) {
  if (!roll) return false;
  if (roll.instances?.length && roll.instances.every((i) => i.persistent)) return true;
  const f = squash(roll.formula), raw = normFormula(String(roll._formula ?? "").replace(/^\{(.*)\}$/, "$1"));
  return steps.some((st) => {
    const r = resolve(st.formula);
    if (r == null) return false;
    const n = squash(normalize(`{(${r})[${st.persistent ? "persistent," : ""}${st.type}]}`));
    return (!!n && n === f) || (!!raw && normFormula(r) === raw);
  });
}

/** Нормализатор формул через DamageRoll живой системы; нет класса или формула не разбирается — null. */
const damageNormalizer = () => {
  const D = globalThis.CONFIG?.Dice?.rolls?.find((r) => r.name === "DamageRoll");
  return (str) => { try { return D ? new D(str).formula : null; } catch { return null; } };
};



/**
 * Карточка модуля, к которой относится бросок урона, или null. before — сообщения до урона (по возрастанию).
 * q: {actor, uuid, slug, at, maxMs, stopId}. Ближайшая карточка этого актёра и предмета (по снимку use); Удары и чужие броски между ними
 * не мешают. Граница хода (stopId) и maxMs обрывают поиск; уже связанная карточка — второй бросок урона не связывается.
 */
export function findCard(before, { actor, uuid, slug, at = 0, maxMs = Infinity, stopId = null, exists = () => true, onLinked = null }) {
  if (!actor || !(uuid || slug)) return null;
  for (const m of [...before].slice(-WINDOW).reverse()) {
    if (stopId && m.id === stopId) return null;
    if (at - (m.timestamp ?? 0) > maxMs) return null;
    const use = m.flags?.[MOD]?.use;
    if (!use || use.actor !== actor || use.state?.yielded) continue;
    if ((uuid && use.item?.uuid === uuid) || (slug && use.slug === slug)) {
      const linked = use.state?.basicDamage;
      if (linked && exists(linked.msg)) { onLinked?.(m, linked.msg); return null; }   // связь с удалённым уроном не считается
      return m;
    }
  }
  return null;
}

/**
 * Что нанести/пересчитать. results — use.state.challenge.results, keys — цели, done — уже нанесённое {key:{degree, skipped?, reverted?}}.
 * fresh — нет отметки (откатанное pf2e — только при manual); changed — степень после нанесения изменилась (переброс).
 */
export function planBasicDamage(results, keys, done = {}, { manual = false, table } = {}) {
  const fresh = [], changed = [];
  for (const key of keys) {
    const r = results?.[key];
    if (!r) continue;
    const d = done[key], row = { key, degree: r.degree, mult: multOf(r.degree, table) };
    if (row.mult == null) continue;
    if (!d) fresh.push(row);
    else if (d.skipped) continue;
    else if (d.reverted) { if (manual) fresh.push(row); }
    else if (d.degree !== r.degree && d.mult !== row.mult) changed.push({ ...row, from: d.degree });   // тот же множитель (провал и крит. провал ×1) — пересчитывать нечего
  }
  return { fresh, changed };
}

/** Откат damage-taken кнопкой pf2e -> ключ цели, чью отметку снять (только если откатана именно наша запись), иначе null. */
export function revertedKey(message, link) {
  if (!message?.flags?.pf2e?.appliedDamage?.isReverted) return null;
  const mk = parseMarker(message.flags.pf2e.context?.options);
  return mk && link?.done?.[mk.key]?.taken === message.id ? mk.key : null;
}

/** Опции для урона, как у pf2e: без self/target (они пересчитываются под цель). */
export const baseOptions = (opts) => opts.filter((o) => !/^(?:self|target)(?::|$)/.test(o));

/** По тому же отряду (troop.id) этим сообщением урона уже нанесено (не пропущено и не откачено) другой записью. */
export const troopTaken = (done, troop, key) => !!troop && Object.entries(done ?? {}).some(([k, e]) => k !== key && e.troop === troop && !e.skipped && !e.reverted);

/** Состояние старого нанесения: null — откатывать нечего (×0) или уже откатано; "alive" — откатать можно; "no-taken"/"gone" — откат не доказан, не наносим. */
export function undoProof(entry, taken) {
  if (!(entry.mult > 0)) return null;
  if (!entry.taken) return "no-taken";
  if (!taken) return "gone";
  return taken.flags?.pf2e?.appliedDamage?.isReverted ? null : "alive";
}

/** Текст строки результата для карточки урона: [ключ, значения]. */
export function lineOf(entry, name) {
  if (entry.reverted) return ["builtin.basicDamage.reverted", { name }];
  if (entry.skipped) return ["builtin.basicDamage.skipped", { name }];
  return ["builtin.basicDamage.line", { name, mult: MULT_TEXT[entry.mult] ?? entry.mult }];
}

/* ---------- связь ---------- */

/** Хук createChatMessage (активный ГМ): урон-бросок -> связь с карточкой, подсказки реакций «получит урон» (damaged.mjs) и, в auto, нанесение уже известных результатов. */
export async function onMessage(dmg) {
  if (!isActiveGM()) return;
  const linked = await link(dmg);
  const { onMessage: hints } = await import("./damaged.mjs");   // после связи (цели испытания) и до нанесения: иначе auto обгонит подсказку
  await hints(dmg).catch((e) => console.error(`${MOD} | builtin damaged`, e));
  if (linked && effectiveMode("apply", linked) === "auto") await settle(dmg.id);
}

async function link(dmg) {
  if (modeOf("apply") === "off" || !isBasicDamage(dmg) || linkOf(dmg)) return null;
  const origin = dmg.flags.pf2e.origin ?? null;
  const actor = origin?.actor ?? dmg.actor?.uuid, uuid = origin?.uuid ?? dmg.item?.uuid ?? null;
  const { slugOf } = await import("../rules.mjs"), { AFTER_USE_MS, turnStartOf } = await import("../events.mjs");
  const who = dmg.actor, inCombat = who && combatOf(game.combats, who)?.started;
  const before = game.messages.contents, i = before.findIndex((m) => m.id === dmg.id);
  const cardMsg = findCard(i < 0 ? before : before.slice(0, i), {
    actor, uuid, slug: slugOf(origin, dmg.item) || null, at: dmg.timestamp ?? 0, maxMs: AFTER_USE_MS, stopId: inCombat ? turnStartOf(actor) : null, exists: (id) => game.messages.has(id),
    onLinked: (m, firstId) => tell(L("chat.basicUnlinked", { item: esc(m.flags[MOD].use.item?.name ?? ""), roll: esc(firstId) }))   // findCard вызывает один раз на бросок
  });
  if (!cardMsg) return null;
  const { useOf } = await import("../saves.mjs"), { resolveFormula } = await import("../rules.mjs");
  return queue(`basic-link:${cardMsg.id}`, async () => {
    const fresh = game.messages.get(cardMsg.id), use = useOf(fresh);
    if (!use || (use.state?.basicDamage && game.messages.has(use.state.basicDamage.msg))) return null;
    const table = degreeTable(use.rule, dmg.item);
    if (!table || ruleDealsDamage(use.rule)) return null;
    // бросок по ссылке, чью формулу наносит само правило (опасная местность, продолжительный урон), — не урон заклинания: связывать нельзя, настоящий бросок потом не связался бы
    const it = dmg.item, rank = it?.rank ?? it?.system?.level?.value ?? 1, level = it?.system?.level?.value ?? rank;
    if (rollIsRuleDamage(dmg.rolls?.[0], ruleDamageSteps(use.rule, dealModes()), { resolve: (f) => resolveFormula(f, { rank, level, actorLevel: dmg.actor?.level ?? 1 }), normalize: damageNormalizer() })) return null;
    await fresh.update({ [flagPath("use", "state", "basicDamage")]: { msg: dmg.id } });
    await dmg.update({ [`flags.${MOD}.basicDamage`]: { card: fresh.id, done: {}, table } });
    return use;
  });
}

/** saves.afterRecord / переброс: у карточки есть связанный урон — досчитать (только auto; в button — кнопкой). */
export async function onResult(cardId) {
  const link = game.messages.get(cardId)?.flags?.[MOD]?.use?.state?.basicDamage;
  if (!link?.msg || !isActiveGM()) return;
  const { onResult: hints } = await import("./damaged.mjs");   // итог спасброска — подсказки реакций по цели, до нанесения
  await hints(cardId).catch((e) => console.error(`${MOD} | builtin damaged`, e));
  await settle(link.msg);
}

/* ---------- нанесение ---------- */

/** Нанести (и при redo пересчитать) урон по итогам спасбросков. manual — по кнопке ГМа (в любом режиме кроме off). Очередь — на сообщение урона. */
export const settle = (dmgId, opts = {}) => queue(`basic:${dmgId}`, () => run(dmgId, opts));

async function run(dmgId, { manual = false, redo = false } = {}) {
  const dmg = game.messages.get(dmgId), link = linkOf(dmg);
  if (!isActiveGM() || !link || modeOf("apply") === "off") return { ok: false, reason: "no-link" };
  const { useOf, challengeTargets } = await import("../saves.mjs");
  const cardMsg = game.messages.get(link.card), use = useOf(cardMsg);
  if (!use) return { ok: false, reason: "no-card" };
  const targets = await challengeTargets(cardMsg);
  const results = use.state?.challenge?.results;
  const plan = planBasicDamage(results, targets.map((t) => t.key), link.done, { manual, table: link.table });
  if (!manual && effectiveMode("apply", use) !== "auto") {   // button: сами не наносим, но о перебросе шепчем
    await tellChanged(dmg, use, plan.changed, link.done);
    return { ok: true, applied: [] };
  }
  const byKey = new Map(targets.map((t) => [t.key, t.token]));
  const applied = [];
  const todo = [...plan.fresh, ...(redo ? plan.changed : [])];
  for (const row of todo) {
    const token = byKey.get(row.key), troop = token.flags?.pf2e?.troop?.id ?? null;
    const entry = { degree: row.degree, mult: row.mult, name: token.name, troop, taken: null, skipped: false, reverted: false, told: null };   // все поля явно: update сливает объекты, старые отметки иначе остались бы
    const cur = linkOf(game.messages.get(dmgId)), old = cur?.done?.[row.key];
    if (old && !old.reverted && !old.skipped) {   // пересчёт: старое нанесение откатывается, и только доказанно
      const takenMsg = old.taken ? game.messages.get(old.taken) : null, proof = undoProof(old, takenMsg);
      if (proof === "no-taken" || proof === "gone") { await tell(L("builtin.basicDamage.noUndo", { name: esc(token.name) })); continue; }
      if (proof === "alive") await undoTaken(takenMsg);
    }
    // ponytail: окно между проверкой alreadyApplied и записью отметок узкое (одна цель), ручная кнопка pf2e в этот миг даст двойной урон; потолок — гонка на доли секунды, лечится только перехватом applyDamage (apply-hook) с проверкой отметки
    if (troopTaken(cur?.done, troop, row.key) || (!old && alreadyApplied(game.messages.get(dmgId), token.id))) entry.skipped = true;   // ручная кнопка pf2e / Toolbelt / Блок щитом / отряд уже нанесли
    else if (row.mult > 0 && token.actor) entry.taken = await dealTo(dmg, token, row.key, row.mult);
    await game.messages.get(dmgId).update({
      [`flags.${MOD}.basicDamage.done.${row.key}`]: entry,
      ...(!entry.skipped && { [`flags.${MOD}.shieldBlock.done.${token.id}`]: true, [EXTERNAL.flags.tbApplied(token.id)]: true })
    });
    applied.push(row.key);
    if (token.uuid) { const { expireFor } = await import("./damaged.mjs"); await expireFor(dmgId, token.uuid); }   // урон по цели учтён (в т. ч. ×0): подсказки реакции по ней гаснут
  }
  if (!redo) await tellChanged(dmg, use, plan.changed, link.done);
  return { ok: true, applied };
}

const tell = (text) => ChatMessage.create({ content: card(text, "", headOf("basic-damage")), whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id) });

/** Переброс после нанесения: шёпот ГМу один раз на новую степень (кнопка «Пересчитать» — на карточке урона). Уже шепнул saves.changedAfterApply — не дублируем. */
async function tellChanged(dmg, use, changed, done) {
  const upd = {};
  for (const c of changed) {
    if (done[c.key]?.told === c.degree || use.state?.challenge?.results?.[c.key]?.changedAfterApply) continue;
    upd[`flags.${MOD}.basicDamage.done.${c.key}.told`] = c.degree;
    await tell(L("builtin.basicDamage.changed", { name: esc(done[c.key]?.name ?? c.key), item: esc(use.item?.name ?? "") }));
  }
  if (Object.keys(upd).length) await game.messages.get(dmg.id).update(upd);
}

/** Откат нанесённого нами урона, как кнопка pf2e (pf2e.mjs ~56041): undoDamage, без кнопки отката в content, statements.reverted, isReverted. */
async function undoTaken(taken) {
  const applied = taken.flags.pf2e.appliedDamage, actor = await fromUuid(applied.uuid);
  await actor?.undoDamage?.(applied);
  const el = document.createElement("div");
  el.innerHTML = taken.content;
  el.querySelector(EXTERNAL.selectors.revertDamage)?.remove();
  el.querySelector(EXTERNAL.selectors.statements)?.classList.add("reverted");
  await taken.update({ "flags.pf2e.appliedDamage.isReverted": true, content: el.innerHTML });
}

/** Эфемерные эффекты damage-received автора (extractEphemeralEffects pf2e не экспортируется). */
async function ephemeral(origin, target, item, options) {
  const fx = origin?.synthetics?.ephemeralEffects?.["damage-received"]?.target ?? [];
  if (!fx.length) return [];
  const test = [...options, ...origin.getRollOptions(["damage-received"]), ...target.getSelfRollOptions("target")];
  const resolvables = item ? (item.isOfType("spell") ? { spell: item } : { weapon: item }) : {};
  const out = (await Promise.all(fx.map((f) => f({ test, resolvables })))).filter(Boolean);
  for (const e of out) {
    if (e.type !== "effect") continue;
    e.system.context = { origin: { actor: origin.uuid, token: null, item: null, spellcasting: null, rollOptions: [] }, target: { actor: target.uuid, token: null }, roll: null };
    e.system.duration = { value: -1, unit: "unlimited", expiry: null, sustained: false };
  }
  return out;
}

/** applyDamage по одной цели (образец — pf2e applyDamageFromMessage). -> id сообщения damage-taken или null. */
async function dealTo(dmg, token, key, mult) {
  const target = token.actor, origin = dmg.actor, item = dmg.item, marker = markerOf(dmg.id, key);
  const opts = [...(dmg.flags.pf2e.context?.options ?? [])];
  const self = opts.filter((o) => o.startsWith("self:")).map((o) => o.replace(/^self\b/, "origin"));
  const itemOpts = item?.isOfType?.("affliction", "condition", "effect") ? item.getRollOptions("item") : [];
  const all = [...baseOptions(opts), ...self, ...(target.alliance && origin?.alliance ? [`origin:${target.alliance === origin.alliance ? "ally" : "enemy"}`] : []), ...target.getSelfRollOptions("target")];
  const clone = target.getContextualClone(self, await ephemeral(origin, target, item, all));
  await clone.applyDamage({
    damage: dmg.rolls[0].alter(mult, 0), token, item, skipIWR: false, outcome: dmg.flags.pf2e.context?.outcome,   // shieldBlockRequest не передаём: Блок — реакция, идёт своим путём
    rollOptions: new Set([...baseOptions(all), ...itemOpts, ...self, ...clone.getSelfRollOptions(), marker])
  });
  const taken = game.messages.contents.slice(-30).reverse().find((m) => m.flags?.pf2e?.context?.type === "damage-taken" && !m.flags.pf2e.appliedDamage?.isReverted && m.flags.pf2e.context.options?.includes(marker));
  return taken?.id ?? null;
}

/* ---------- откат и карточка ---------- */

/** Хук updateChatMessage (активный ГМ): откат нашего нанесения кнопкой pf2e -> отметка reverted (повторно не наносится без кнопки ГМа). */
export async function onUpdate(message, changes) {
  if (!isActiveGM() || !foundry.utils.getProperty(changes ?? {}, "flags.pf2e.appliedDamage.isReverted")) return;
  const mk = parseMarker(message.flags?.pf2e?.context?.options);
  if (!mk) return;
  await queue(`basic:${mk.dmgId}`, async () => {
    const dmg = game.messages.get(mk.dmgId), key = revertedKey(message, linkOf(dmg));
    if (key) await dmg.update({ [`flags.${MOD}.basicDamage.done.${key}.reverted`]: true });
  });
}

/** updateChatMessage на клиентах ГМа: пришёл результат в карточку — перерисовать связанную карточку урона (кнопки button-режима). */
export function onCardUpdate(message) {
  const msg = message.flags?.[MOD]?.use?.state?.basicDamage?.msg, dmg = msg && game.messages.get(msg);
  if (dmg && game.user?.isGM) ui.chat.updateMessage(dmg);
}

/** renderChatMessageHTML: ГМу на карточке урона — строки нанесённого и кнопки «Нанести» / «Пересчитать». */
export async function bind(message, html) {
  const link = linkOf(message), root = html instanceof HTMLElement ? html : html?.[0];
  if (!link || !root || !game.user?.isGM) return;
  const cardMsg = game.messages.get(link.card), use = cardMsg?.flags?.[MOD]?.use, mode = modeOf("apply");
  const { challengeTargets } = await import("../saves.mjs");
  const keys = cardMsg ? (await challengeTargets(cardMsg)).map((t) => t.key) : [];   // те же цели, что у run
  const plan = planBasicDamage(use?.state?.challenge?.results, keys, link.done, { manual: true, table: link.table });
  const lines = Object.values(link.done ?? {}).map((e) => `<div>${esc(L(...lineOf(e, e.name ?? "")))}</div>`).join("");
  const btn = (attr, key) => `<button type="button" class="paf-primary" ${attr}>${L(key)}</button>`;
  const acts = mode === "off" ? "" : (plan.fresh.length ? btn("data-af-basic-apply", "builtin.basicDamage.apply") : "") + (plan.changed.length ? btn("data-af-basic-redo", "builtin.basicDamage.redo") : "");
  if (!lines && !acts) return;
  const el = document.createElement("div");
  el.className = "pf2e-automato";
  el.innerHTML = `<div class="paf-note">${lines}</div>${acts ? `<div class="paf-card-actions">${acts}</div>` : ""}`;
  el.querySelector("[data-af-basic-apply]")?.addEventListener("click", (e) => go(e, message, false));
  el.querySelector("[data-af-basic-redo]")?.addEventListener("click", (e) => go(e, message, true));
  root.querySelector(".message-content")?.append(el);
}

async function go(e, message, redo) {
  e.target.disabled = true;
  const res = await callGM("basicDamage", message.id, redo);
  if (!res?.ok || res.result?.ok === false) { e.target.disabled = false; if (res?.reason !== "no-gm") ui.notifications.warn(L("chat.failed", { reason: res?.result?.reason ?? res?.reason })); }
}
