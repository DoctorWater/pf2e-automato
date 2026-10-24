// K5 «Реакции»: подсказка шёпотом + пересчёт исхода этой атаки, без висящего бонуса. plan.md §3.D'.
import { MOD, L, DEGREES, degreeFromTotal, isActiveGM, queue, debug, callGM } from "./util.mjs";
import { modeOf, S, rev } from "./settings.mjs";
import { resolveRule, slugOf } from "./rules.mjs";
import { runMacros } from "./macros.mjs";
import { buildReactionViewModel } from "./chat.mjs";
import { noReactions } from "./inline-effect.mjs";

const clamp = (n) => Math.min(3, Math.max(0, n));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

export function init() {
  Hooks.on("pf2e.startTurn", onStartTurn);
  // createChatMessage срабатывает только на свежесозданное сообщение (F5/прокрутка чата его не повторяют)
  Hooks.on("createChatMessage", (m) => { if (game.user && S.get("reaction.showWindow")) showReactionWindow(m); });
  Hooks.on("updateChatMessage", onHintUpdate);
  Hooks.on("deleteChatMessage", (m) => closeReactionWindow(m.id));
  Hooks.on("updateCombat", (_c, ch) => { if ("turn" in ch || "round" in ch) for (const id of [...windows.keys()]) closeReactionWindow(id); });
}

/** Чистая: текст окна для этого пользователя или null (не показывать). Получатель — из whisper, как и шёпот. */
export function reactionWindowText(message, user, env = null) {
  const h = hintOf(message);
  if (!h || h.used || !message.whisper?.includes(user.id)) return null;
  const vm = buildReactionViewModel(message, user, env);
  return vm?.canUse ? vm.popup : null;
}

const WINDOW_TTL = 30_000;   // подсказка живёт в чате как запасной путь; окно — чтобы не пропустить в бою; конец хода/раунда закрывает раньше
const windows = new Map();   // id шёпота -> {app, timer, actor, sig}
const sigOf = (h) => `${h.before}>${h.after}`;

// used -> закрыть все окна этого актёра (реакция одна на раунд); переброс (before/after сменились) -> перерисовать
function onHintUpdate(m) {
  const h = hintOf(m);
  if (!h) return;
  if (h.used) { for (const [id, w] of [...windows]) if (id === m.id || w.actor === h.actor) closeReactionWindow(id); return; }
  const w = windows.get(m.id);
  if (!w || w.sig === sigOf(h)) return;
  closeReactionWindow(m.id);
  if (S.get("reaction.showWindow")) showReactionWindow(m);
}

function showReactionWindow(message) {
  const text = reactionWindowText(message, game.user);
  if (!text || windows.has(message.id)) return;
  const id = message.id, h = hintOf(message);
  const { DialogV2 } = foundry.applications.api;
  const app = new DialogV2({
    window: { title: L("chat.reaction.windowTitle"), minimizable: false },
    classes: ["paf-dialog"],
    position: { width: 340, left: Math.max(0, innerWidth - 340 - 320), top: Math.max(0, innerHeight - 190 - 120 * windows.size) },   // не накладывать друг на друга
    modal: false,
    content: `<p>${esc(text)}</p>`,
    buttons: [
      { action: "use", label: L("chat.reaction.use"), class: "paf-primary", callback: async () => {
        try {
          const res = await callGM("useReaction", id);   // тот же путь, что у кнопки в чате
          if (res && res.ok === false && res.reason !== "no-gm") ui.notifications.warn(L("chat.failed", { reason: res.error ?? res.reason }));
        } catch (e) { ui.notifications.error(L("chat.failed", { reason: e.message })); }
      } },
      { action: "skip", label: L("chat.reaction.skip"), class: "paf-ghost", default: true }
    ]
  });
  windows.set(id, { app, actor: h.actor, sig: sigOf(h), timer: setTimeout(() => closeReactionWindow(id), WINDOW_TTL) });
  const origClose = app.close.bind(app);
  app.close = (opts) => { const w = windows.get(id); if (w) { clearTimeout(w.timer); windows.delete(id); } return origClose(opts); };
  // окно не должно красть фокус (Enter в чате иначе нажмёт кнопку): возвращаем его туда, где он был
  const prevFocus = document.activeElement;
  app.render({ force: true }).then(() => prevFocus?.isConnected && prevFocus.focus?.());
}

function closeReactionWindow(id) {
  windows.get(id)?.app.close();
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
  if (noReactions(actor)) return false;   // эффект «нельзя использовать реакции» (inline-эффект forbid)
  const f = actor?.getFlag?.(MOD, "reactionSpent");
  if (!f) return true;
  const c = game.combat;
  return !(c && c.id === f.combat && c.round === f.round);
}

const ruleCache = new Map();   // uuid -> { mt, rv, rule }, как eventRuleOf в events.mjs; ponytail: растёт с числом предметов
// Правило предмета — тем же resolveRule, что у использования и событий (ограждение копий NPC, ключ slug@type, флаг на предмете).
export function ruleOfItem(item) {
  const mt = item?._stats?.modifiedTime ?? 0, hit = item?.uuid ? ruleCache.get(item.uuid) : null;
  if (hit && hit.mt === mt && hit.rv === rev.n && !item.flags?.[MOD]?.rule) return hit.rule;
  let rule = null;
  try { rule = resolveRule(item)?.rule ?? null; } catch (e) { console.warn(`${MOD} | reactions: правило ${item?.name}`, e); }
  if (item?.uuid) ruleCache.set(item.uuid, { mt, rv: rev.n, rule });
  return rule;
}

export function reactionItems(actor) {
  const out = [];
  const seen = new Set();   // дубли способности на листе (старая и новая копия одного slug) — одна подсказка
  for (const item of actor.items) {
    const rule = ruleOfItem(item), key = slugOf(null, item) || item.name;
    if (rule?.onAttacked && !seen.has(key)) { seen.add(key); out.push({ item, reaction: rule.onAttacked }); }
  }
  return out;
}

const hintOf = (m) => m?.flags?.[MOD]?.reaction;
const findHint = (key) => game.messages.contents.findLast((m) => {
  const h = hintOf(m);
  return h && h.attacker === key.attacker && h.actor === key.actor && h.item === key.item;
});

function content(h) {
  // степени в content не пишем (метаигра) — их показывает блок chat.mjs по flags[MOD].reaction вместе с кнопкой
  const text = L("reactions.hint", { actor: esc(h.actorName), item: esc(h.itemName), bonus: signed(h.bonus), attacker: esc(h.attackerName) });
  const tail = h.used ? `<p>${L("reactions.used")}</p>${h.rerolled ? `<p>${L("reactions.rerolled")}</p>` : ""}` : "";
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
    // подсказку даём при любой атаке по владельцу (ответное действие объявляют, не зная исхода), даже если бонус ничего не меняет
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
    const actor = await fromUuid(h.actor);
    if (actor && !reactionAvailable(actor)) return { ok: false, reason: "spent", error: L(noReactions(actor) ? "reactions.forbidden" : "reactions.spent") };   // вторая подсказка того же актёра
    const { before, after } = recalcWithBonus(attack, h.bonus);
    const next = { ...h, before, after, used: true };
    await msg.update({ content: content(next), [`flags.${MOD}.reaction`]: next });
    await attack.update({ [`flags.${MOD}.gate`]: { degree: after } });   // кнопки урона у стреляющего: damage-gate читает это при перерисовке

    const item = await fromUuid(h.item);
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
