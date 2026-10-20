// K5 «Реакции»: подсказка шёпотом + пересчёт исхода этой атаки, без висящего бонуса. plan.md §3.D'.
import { MOD, L, DEGREES, degreeFromTotal, isActiveGM, queue, debug } from "./util.mjs";
import { modeOf, S } from "./settings.mjs";
import { onAttackedIndex, itemFlagRule, slugOf, sourceOf } from "./rules.mjs";
import { runMacros } from "./macros.mjs";

const clamp = (n) => Math.min(3, Math.max(0, n));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

export function init() {
  Hooks.on("pf2e.startTurn", onStartTurn);
}

/** Чистая: исход атаки при КБ+bonus. after = clamp(degree + delta), delta по degreeFromTotal (dosAdjustments pf2e уже внутри degree). */
export function recalcWithBonus(message, bonus) {
  const roll = message?.rolls?.[0];
  const ctx = message?.flags?.pf2e?.context;
  const dc = ctx?.dc?.value;
  const degree = roll?.options?.degreeOfSuccess ?? roll?.degreeOfSuccess ?? DEGREES.indexOf(ctx?.outcome);
  const same = Math.max(degree ?? 0, 0);
  if (!Number.isFinite(dc) || !Number.isFinite(roll?.total) || !(degree >= 0)) return { before: same, after: same, changes: false };
  const die = roll.dice?.find((d) => d.faces === 20)?.total ?? null;
  const delta = degreeFromTotal(roll.total, dc + bonus, die) - degreeFromTotal(roll.total, dc, die);
  const after = clamp(degree + delta);
  return { before: degree, after, changes: after !== degree };
}

/** Флаг reactionSpent = {combat, round} действует только в том же раунде того же боя. */
export function reactionAvailable(actor) {
  const f = actor?.getFlag?.(MOD, "reactionSpent");
  if (!f) return true;
  const c = game.combat;
  return !(c && c.id === f.combat && c.round === f.round);
}

// Правило onAttacked предмета: каталоги (slug/источник) или флаг на предмете.
function ruleOfItem(item, idx = onAttackedIndex()) {
  const slug = slugOf(null, item), src = sourceOf(null, item);
  return (slug && idx.get(slug)) || (src && idx.get(src)) || itemFlagRule(item);
}

function reactionItems(actor) {
  const idx = onAttackedIndex();
  const out = [];
  for (const item of actor.items) {
    const rule = ruleOfItem(item, idx);
    if (rule?.onAttacked) out.push({ item, reaction: rule.onAttacked });
  }
  return out;
}

const hintOf = (m) => m?.flags?.[MOD]?.reaction;
const findHint = (key) => game.messages.contents.findLast((m) => {
  const h = hintOf(m);
  return h && h.attacker === key.attacker && h.actor === key.actor && h.item === key.item;
});

function content(h) {
  const name = (k) => L(`reactions.degree.${DEGREES[h[k]]}`);
  const text = L("reactions.hint", { actor: esc(h.actorName), item: esc(h.itemName), bonus: signed(h.bonus), attacker: esc(h.attackerName), before: name("before"), after: name("after") });
  // кнопку рисует chat.mjs по flags[MOD].reaction (K7 п.8) — здесь только текст
  const tail = h.used ? `<p>${L("reactions.used", { after: name("after") })}</p>${h.rerolled ? `<p>${L("reactions.rerolled")}</p>` : ""}` : "";
  return `<div class="pf2e-automato-reaction"><p>${text}</p>${tail}</div>`;
}

export async function onAttackMessage(message) {
  if (!isActiveGM() || modeOf("reaction") === "off") return;
  const ctx = message.flags?.pf2e?.context;
  if (!["attack-roll", "spell-attack-roll"].includes(ctx?.type) || !ctx.target?.actor) return;
  if (ctx.dc?.slug && !["ac", "armor"].includes(ctx.dc.slug)) return;
  const actor = await fromUuid(ctx.target.actor);
  if (!actor || !reactionAvailable(actor)) return;
  const attacker = message.speaker?.actor ?? message.speaker?.token ?? null;
  const attackerName = message.speaker?.alias ?? "";

  for (const { item, reaction } of reactionItems(actor)) {
    if (reaction.trigger !== "attack-on-self" || reaction.bonus?.stat !== "ac") continue;
    const bonus = reaction.bonus.value;
    const r = recalcWithBonus(message, bonus);
    const existing = ctx.isReroll ? findHint({ attacker, actor: actor.uuid, item: item.uuid }) : null;
    if (existing) {   // переброс: обновляем подсказку, не дублируем
      const h = { ...hintOf(existing), attack: message.id, before: r.before, after: r.after };
      if (h.used) h.rerolled = true;
      await existing.update({ content: content(h), [`flags.${MOD}.reaction`]: h });
      continue;
    }
    if (r.before < 2) continue;   // не попала
    if (!r.changes && S.get("reaction.onlyWhenChanges")) continue;
    const h = { attack: message.id, attacker, attackerName, actor: actor.uuid, actorName: actor.name, item: item.uuid, itemName: item.name, bonus, before: r.before, after: r.after, used: false };
    const notify = reaction.notify ?? ["owner", "gm"];
    const whisper = game.users.filter((u) => (notify.includes("gm") && u.isGM) || (notify.includes("owner") && actor.testUserPermission(u, "OWNER"))).map((u) => u.id);
    if (!whisper.length) continue;
    await ChatMessage.create({ whisper, content: content(h), speaker: { alias: "pf2e-automato" }, flags: { [MOD]: { reaction: h } } });
    debug("reaction hint", item.name, r);
  }
}

export function useReaction(hintMessageId) {
  return queue(`reaction:${hintMessageId}`, async () => {
    const msg = game.messages.get(hintMessageId);
    const h = hintOf(msg);
    if (!h) return { ok: false, reason: "no-hint" };
    if (h.used) return { ok: true, skipped: true };
    const attack = game.messages.get(h.attack);
    if (!attack) return { ok: false, reason: "attack-gone" };   // атака переброшена/удалена
    const { before, after } = recalcWithBonus(attack, h.bonus);
    const next = { ...h, before, after, used: true };
    await msg.update({ content: content(next), [`flags.${MOD}.reaction`]: next });

    const actor = await fromUuid(h.actor), item = await fromUuid(h.item);
    // Трекер списывает реакцию по карточке предмета (system.time.value === "reaction")
    if (item && game.modules.get("pf2e-auto-action-tracker")?.active) await item.toMessage();
    const c = game.combat;
    if (actor && c?.started && c.combatants.some((x) => x.actorId === actor.id)) {
      await actor.setFlag(MOD, "reactionSpent", { combat: c.id, round: c.round });
    }
    try { await runMacros("onReaction", { message: attack, rule: item ? ruleOfItem(item) : null, actor, item, degree: after }); }
    catch (e) { console.warn(`${MOD} | onReaction macros`, e); }
    return { ok: true, before, after };
  });
}

async function onStartTurn(combatant) {
  if (!isActiveGM()) return;
  const a = combatant?.actor;
  if (a?.getFlag(MOD, "reactionSpent")) await a.unsetFlag(MOD, "reactionSpent");
}
