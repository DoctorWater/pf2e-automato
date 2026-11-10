// «Перенос урона на другое существо»: Связь жизни (Life Link), Разделённая жизнь (Share Life), Щит за другого (Shield Other, старый текст Share Life; копии NPC).
// pf2e этого не делает: у заклинаний нет ни правил, ни эффекта (проверено по 8.6.1). Две части:
// 1) сотворение — на цели (одна или несколько по рангу) ложится эффект с origin = заклинатель; slug эффекта — признак для второй части (те же slug у эффектов pf2e-automations,
//    так что уже наложенные ими эффекты тоже работают, когда PA выключен);
// 2) цель получила урон (сообщение pf2e «damage-taken») — часть урона возвращается цели и вычитается у заклинателя без сопротивлений (applyDamage с skipIWR).
// ДОЛГ: откат урона кнопкой pf2e цели перенос заклинателю не откатывает (урон заклинателю уже записан settle; связи между сообщениями нет).
import { L, MOD } from "../util.mjs";
import { castOrigin, effectSource, addEffect, esc, whisper, paHas, messageTargets, itemSlug, combatOf } from "./lib.mjs";
import { kindOf } from "./spellshape.mjs";

/** Таблица группы: slug заклинания -> эффект и способ переноса. cap: [ранг от, значение], по убыванию. */
export const LINKS = {
  "life-link": { effect: "effect-life-link", mode: "cap", caps: [[9, 15], [6, 10], [3, 5], [0, 3]], count: [[9, 4], [6, 3], [3, 2], [0, 1]], once: true, text: "builtin.link.lifeLink" },
  "share-life": { effect: "effect-share-life", mode: "half", range: 30, text: "builtin.link.shareLife" },
  "shield-other": { effect: "effect-share-life", mode: "half", range: 30, text: "builtin.link.shareLife" }
};
const BY_EFFECT = Object.fromEntries(Object.entries(LINKS).reverse().map(([slug, d]) => [d.effect, { slug, ...d }]));
const pick = (table, rank) => table.find(([from]) => rank >= from)?.[1];

/** Чистая: сколько существ можно связать на этом ранге. */
export const linkCount = (def, rank) => (def.count ? pick(def.count, rank) : 1);

/** Чистая: уменьшение урона одной связью. cap — не больше значения по рангу; half — половина (округление вниз цели, остаток заклинателю). */
export const reduction = (def, rank, damage) => Math.max(0, def.mode === "cap" ? Math.min(damage, pick(def.caps, rank)) : damage - Math.floor(damage / 2));

/** Чистая: связи по очереди (Связь жизни — первой) делят урон: [{i, amount}], сумма не больше урона. */
export function distribute(defs, damage) {
  let rest = damage;
  return defs.map((d, i) => {
    const amount = Math.min(rest, reduction(d.def, d.rank, rest));
    rest -= amount;
    return { i, amount };
  });
}

/** Чистая: срок заклинания «10 minutes» -> {value, unit} | null (неразобранный — эффект без срока). */
export function spellDuration(text) {
  const m = /^(\d+)\s*(round|minute|hour|day)s?$/i.exec(String(text ?? "").trim());
  return m ? { value: +m[1], unit: `${m[2].toLowerCase()}s` } : null;
}

/** Чистая: связи на цели, отсортированные (Связь жизни первой). effects — предметы-эффекты актёра. */
export function linksOf(effects, targetUuid) {
  return effects.filter((e) => BY_EFFECT[e.slug] && e.system?.context?.origin?.actor && e.system.context.origin.actor !== targetUuid)
    .map((e) => ({ effect: e, def: BY_EFFECT[e.slug], rank: e.system.level?.value ?? 1, caster: e.system.context.origin.actor }))
    .sort((a, b) => (a.def.mode === "cap" ? 0 : 1) - (b.def.mode === "cap" ? 0 : 1));
}

/** Сотворение (активный ведущий): эффект связи на цели. Повторное сотворение того же заклинателя заменяет прежний эффект. */
export async function onMessage(message) {
  const origin = castOrigin(message);
  if (kindOf(origin) !== "cast") return;   // настоящее сотворение, не карточка «в чат»
  const spell = await fromUuid(origin.uuid), slug = itemSlug(spell), def = LINKS[slug];
  if (!def || paHas(slug)) return;
  const caster = await fromUuid(origin.actor);
  if (!caster) return;
  const rank = message.flags?.pf2e?.origin?.castRank ?? spell.rank ?? 1;
  const targets = messageTargets(message).filter((t) => t.actor.uuid !== caster.uuid).slice(0, linkCount(def, rank));
  if (!targets.length) return void ui.notifications.warn(L("builtin.link.needTarget", { name: caster.name }));
  const sp = message.speaker ?? {}, { removeByKey } = await import("../apply.mjs");
  for (const t of targets) {
    const key = `link:${caster.uuid}:${def.effect}`;
    await removeByKey(t.actor, key);
    const src = effectSource({
      name: L("builtin.link.effect", { name: spell.name }), description: `<p>${L(def.text, { name: esc(caster.name) })}</p>`, img: spell.img,
      duration: { sustained: false, ...(spellDuration(spell.system?.duration?.value) ?? { value: -1, unit: "unlimited" }), expiry: "turn-start" },
      origin: { actor: caster.uuid, token: sp.scene && sp.token ? `Scene.${sp.scene}.Token.${sp.token}` : null, item: spell.uuid }, target: { actor: t.actor.uuid, token: t.uuid }
    });
    src.system.slug = def.effect;
    src.system.level = { value: rank };
    await addEffect(t.actor, src, key);
  }
}

export const LINK_OPTION = "af:link";   // урон самого переноса: обёртка applyDamage его не переносит повторно (попадает в context.options сообщения)

/** Урон заклинателю через applyDamage (смерть/потеря сознания pf2e ведёт сам); без токена на сцене — прямая запись. */
export async function applyHp(actor, delta) {
  const token = actor.getActiveTokens?.(true, true)?.[0];
  if (token) return actor.applyDamage({ damage: delta, token, skipIWR: true, final: true, rollOptions: new Set([LINK_OPTION]) });
  const hp = actor.system.attributes.hp;
  return actor.update({ "system.attributes.hp.value": Math.max(0, Math.min(hp.max, hp.value - delta)) });
}

const farAway = (a, b, feet) => {
  const ta = a.getActiveTokens?.()?.[0], tb = b.getActiveTokens?.()?.[0];
  return !!(ta && tb && ta.distanceTo(tb) > feet);
};

/**
 * Перенос ДО применения урона (обёртка Actor#applyDamage, shield-block.mjs): урон цели уменьшается, как велит текст («reduce the damage it takes»), поэтому урон сверх 0 ОЗ,
 * временные ОЗ, массивный урон и смерть на нуле считает сам pf2e по уменьшенному. Любой клиент: effects и токены синхронны, запись заклинателю — через settle у ведущего.
 * PA ведёт Life Link сам по хуку (не по группе) — пока он активен, молчим целиком. ponytail: размер берётся из броска до сопротивлений цели.
 * -> { damage, rows: [{id, caster, amount, drop}] } | null
 */
export function intercept(actor, opts) {
  if (!opts || opts.rollOptions?.has?.(LINK_OPTION) || paHas("life-link") || paHas("share-life")) return null;
  const d = opts.damage, total = typeof d === "number" ? d : d?.total;
  if (!(total > 0)) return null;
  const links = linksOf(actor.itemTypes?.effect ?? [], actor.uuid);
  if (!links.length) return null;
  const c = combatOf(game.combats, actor), round = c ? `${c.id}:${c.round}` : null, rows = [];
  const live = [];
  for (const l of links) {
    let caster = null;
    try { caster = fromUuidSync(l.caster); } catch { /* заклинатель недоступен */ }
    if (!caster) continue;
    if (l.def.range && farAway(caster, actor, l.def.range)) rows.push({ id: l.effect.id, caster: l.caster, amount: 0, drop: true });   // дальше 30 фт заклинание закончилось
    else if (!(l.def.once && round && l.effect.flags?.[MOD]?.linkRound === round)) live.push(l);
  }
  const out = distribute(live, total);
  const sum = out.reduce((s, r) => s + r.amount, 0);
  rows.push(...out.filter((r) => r.amount > 0).map((r) => ({ id: live[r.i].effect.id, caster: live[r.i].caster, amount: r.amount, drop: false, once: !!live[r.i].def.once, half: live[r.i].def.mode === "half" })));
  if (!rows.length) return null;
  return { damage: sum > 0 ? (typeof d === "number" ? d - sum : d.alter(1, -sum)) : d, rows, round };
}

/** Активный ведущий, после применения урона цели: урон заклинателю, метка раунда, шёпот, конец связи. */
export async function settle(targetUuid, rows, round) {
  const target = await fromUuid(targetUuid);
  if (!target) return;
  for (const r of rows) {
    const effect = target.items.get(r.id), caster = await fromUuid(r.caster);
    if (!effect) continue;
    if (r.drop || !caster) { await effect.delete(); continue; }
    await applyHp(caster, r.amount);
    if (r.once && round) await effect.setFlag(MOD, "linkRound", round);
    await whisper(target, L("builtin.link.card", { name: esc(target.name), caster: esc(caster.name), n: r.amount, spell: esc(effect.name) }), "damage-link");
    if (caster.hitPoints?.value <= 0 || (r.half && target.hitPoints?.value <= 0)) await effect.delete();   // заклинатель без сознания / одно из существ на 0 ОЗ: связь закончилась
  }
}
