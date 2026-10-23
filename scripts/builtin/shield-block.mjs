// «Блок щитом». В pf2e это не действие, а флаг shieldBlockRequest при применении урона (applyDamage). Две части:
// 1) на карточку урона по существу с поднятым щитом и свободной реакцией — шёпот с кнопкой «Блок» (применяет урон с блоком);
// 2) после ЛЮБОГО применения урона с блоком (кнопки pf2e/toolbelt/наша) заклинание «Щит» (эффект в attributes.shield) снимается.
//    Признака блока в флагах «damage-taken» для щита заклинания нет (appliedDamage.shield пуст при hp щита 0) — оборачиваем Actor#applyDamage.
// Та же обёртка применяет перенос урона (damage-link.mjs) до pf2e. Подсказка «Блок» может прийти и держателю щита рядом (shield-ward.mjs: h.guard),
// и нести варианты «Блок + трата слота» (channeling-block.mjs: кнопки с data-af-cb).
import { L, MOD, queue, callGM } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { esc, whisper, cardButton } from "./lib.mjs";
import { guardHints, wardShield, watchShieldDamage, damageHolderShield } from "./shield-ward.mjs";
import * as channeling from "./channeling-block.mjs";
import * as damageLink from "./damage-link.mjs";

export const settleLink = damageLink.settle;

const TB = "pf2e-toolbelt";

/** Чистая: поднятый и целый щит из actor.attributes.shield -> {name, hardness, itemId} | null. */
export function raisedShield(shield) {
  if (!shield?.raised || shield.broken || shield.destroyed) return null;
  return { name: shield.name, hardness: shield.hardness ?? 0, itemId: shield.itemId ?? null };
}

/** Чистая: UUID токенов-целей карточки урона: цели toolbelt, иначе цель контекста pf2e, иначе выбранные автором (authorTargets). */
export function damageTargets(message, authorTargets = []) {
  const tb = message?.flags?.[TB]?.targetHelper?.targets;
  const ctx = message?.flags?.pf2e?.context?.target?.token;
  const list = tb?.length ? tb : ctx ? [ctx] : authorTargets;
  return [...new Set(list)];
}

/** Чистая: урон по этому токену уже применён — toolbelt (applied[tokenId][rollIndex]) или наша метка. */
export function alreadyApplied(message, tokenId) {
  const tb = message?.flags?.[TB]?.targetHelper?.applied?.[tokenId];
  return !!(tb && Object.values(tb).some(Boolean)) || !!message?.flags?.[MOD]?.shieldBlock?.done?.[tokenId];
}

// Эффекты, текст которых прямо говорит «после Блока щитом заклинание заканчивается» (Щит). Glass Shield и Fire Shield такого не говорят.
const SPELL_ENDS = new Set(["spell-effect-shield"]);
const AMPED = "spell-effect-shield-amped";   // слои-бейдж: Блок ломает столько слоёв, сколько выбрано в roll option shield-block-layers

/** Чистая: что делать с эффектом щита после блока: {id, slug, layers} (layers только у Amped) или null. */
export function spellShieldEffect(shield, items, rollOptions = {}) {
  const item = shield?.itemId && items?.get?.(shield.itemId);
  if (item?.type !== "effect") return null;
  const slug = item.slug ?? item.system?.slug;
  if (SPELL_ENDS.has(slug)) return { id: item.id, slug, layers: 0 };
  if (slug !== AMPED) return null;
  const layers = [3, 2].find((n) => rollOptions?.[`shield-block-layers:${n}`]) ?? 1;
  return { id: item.id, slug, layers };
}

/** Чистая: значение бейджа Amped после слома слоёв; <=0 -> эффект снимается. */
export const ampedLeft = (value, layers) => (Number(value) || 0) - layers;

/** Чистая: подсказка только для урона атаки (не лечение, не испытание). */
export function isAttackDamage(message) {
  const ctx = message?.flags?.pf2e?.context;
  return ctx?.type === "damage-roll" && ctx.sourceType === "attack" && !!message.rolls?.[0]?.kinds?.has?.("damage");
}

/** Чистая: подсказка и карточка допустимы — иначе причина отказа. Подсказку создаёт только ГМ. */
export function checkHint(hint, dmg, token) {
  const h = hintOf(hint);
  if (!h || hint.flags?.[MOD]?.builtin !== "shield-block" || !hint.author?.isGM) return "no-hint";
  if (!dmg || !token?.actor || token.actor.uuid !== h.actor || dmg.flags?.pf2e?.context?.type !== "damage-roll") return "gone";
  return null;
}

/** Чистая: блок состоялся — запрошен, щит поднят и целый, твёрдость >0, урон >0. damage — число или бросок. */
export function blockHappened({ request, damage, shield }) {
  const n = typeof damage === "number" ? damage : damage?.total;
  const s = raisedShield(shield);
  return !!request && !!s && s.hardness > 0 && n > 0;
}

const hintOf = (m) => m?.flags?.[MOD]?.shieldBlock;

export async function onMessage(message) {
  const ctx = message?.flags?.pf2e?.context, attack = isAttackDamage(message);
  // не от атаки подсказка нужна только держателям «от физического урона» (стойка кенотафа): любой урон-бросок, не лечение
  if (modeOf("shieldBlock") === "off" || !(attack || (ctx?.type === "damage-roll" && message.rolls?.[0]?.kinds?.has?.("damage"))) || !(message.rolls?.[0]?.total > 0)) return;
  const { reactionAvailable } = await import("../reactions.mjs");   // ленивый импорт: reactions -> macros -> builtin/index
  const authorTargets = (game.users.get(message.author?.id ?? message.author)?.targets ?? []).map((t) => t.document.uuid);
  for (const uuid of damageTargets(message, authorTargets)) {
    const token = await fromUuid(uuid), actor = token?.actor;
    if (actor?.hitPoints?.value > 0 && !alreadyApplied(message, token.id)) await guardHints(message, token, { raisedShield, reactionAvailable, attack }).catch((e) => console.error(`${MOD} | shield-ward`, e));
    const shield = raisedShield(actor?.attributes?.shield);
    if (!attack || !shield || !(actor.hitPoints?.value > 0) || !reactionAvailable(actor) || alreadyApplied(message, token.id)) continue;
    await whisper(actor,
      L("builtin.shieldBlock.hint", { name: esc(actor.name), hardness: shield.hardness }),
      "shield-block", { shieldBlock: { message: message.id, token: token.uuid, actor: actor.uuid, used: false } },
      cardButton("data-af-shield-block", L("builtin.shieldBlock.button")) + channeling.buttons(actor));
  }
}

/** ГМ: применить урон карточки с блоком, потратить реакцию, погасить кнопку. cb — вариант Проводящего блока (id слота) или null. Очередь — на пару «урон + цель», чтобы блок за себя и за союзника не применили урон дважды. */
export function useBlock(hintId, cb = null) {
  const h0 = hintOf(game.messages.get(hintId));
  return queue(`shield-block:${h0?.message}:${h0?.token}`, async () => {
    const hint = game.messages.get(hintId), h = hintOf(hint);
    if (!h) return { ok: false, reason: "no-hint" };
    if (h.used) return { ok: true, skipped: true };
    const dmg = game.messages.get(h.message), token = await fromUuid(h.token), actor = token?.actor;
    const bad = checkHint(hint, dmg, token);
    if (bad) return { ok: false, reason: bad, error: L("builtin.shieldBlock.gone") };
    const guard = h.guard ? await fromUuid(h.guard) : null, holder = guard ?? actor;   // guard — держатель щита, прикрывающий союзника (shield-ward.mjs)
    if (!raisedShield(holder?.attributes?.shield)) return { ok: false, reason: "lowered", error: L("builtin.shieldBlock.lowered") };
    const { reactionAvailable } = await import("../reactions.mjs");
    if (alreadyApplied(dmg, token.id)) return { ok: false, reason: "applied", error: L("builtin.shieldBlock.applied") };
    if (!reactionAvailable(holder)) return { ok: false, reason: "spent", error: L("reactions.spent") };
    const opts = [...(dmg.flags.pf2e.context?.options ?? [])];
    const self = opts.filter((o) => o.startsWith("self:")).map((o) => o.replace(/^self\b/, "origin"));
    const boost = cb ? await channeling.begin(holder, hintId, cb) : null;   // Проводящий блок: слот потрачен, твёрдость щита выросла
    if (alreadyApplied(dmg, token.id)) { await boost?.delete(); return { ok: false, reason: "applied", error: L("builtin.shieldBlock.applied") }; }
    const clone = actor.getContextualClone?.(self, []) ?? actor;
    const held = guard ? wardShield(holder.attributes.shield) : null;
    if (held) clone.system.attributes.shield = held;   // pf2e считает твёрдость и урон по щиту цели — подменяем щитом держателя
    const watch = held ? watchShieldDamage(held.itemId) : null;
    // ponytail: без ephemeral-эффектов (extractEphemeralEffects не экспортируется pf2e); IWR/сопротивления считает applyDamage
    await clone.applyDamage({
      damage: dmg.rolls[0].alter(1, 0), token, item: dmg.item, skipIWR: false, shieldBlockRequest: true, outcome: dmg.flags.pf2e.context?.outcome,
      rollOptions: new Set([...opts.filter((o) => !/^(?:self|target)(?::|$)/.test(o)), ...self, ...clone.getSelfRollOptions()])
    });
    if (watch) await damageHolderShield(holder, held.itemId, await watch.result());
    if (guard) {   // Щит-заклинание держателя заканчивается после блока, как у владельца (обёртка applyDamage видит только щит цели)
      const fx = spellShieldEffect(holder.attributes.shield, holder.items, holder.rollOptions?.all);
      if (fx) await dropSpellShield(holder.uuid, fx.id, fx.layers);
    }
    await boost?.delete();
    await dmg.update({ [`flags.${MOD}.shieldBlock.done.${token.id}`]: true, [`flags.${TB}.targetHelper.applied.${token.id}.0`]: true });   // второе гасит строку toolbelt
    await hint.update({ [`flags.${MOD}.shieldBlock.used`]: true });
    const c = game.combat;
    if (c?.started && c.combatants.some((x) => x.actorId === holder.id)) await holder.setFlag(MOD, "reactionSpent", { combat: c.id, round: c.round });
    return { ok: true };
  });
}

/** ГМ: урон карточки применён штатной кнопкой pf2e по токену — наша кнопка его не повторит. */
export async function markApplied(messageId, tokenUuid) {
  const m = game.messages.get(messageId), token = await fromUuid(tokenUuid);
  if (m?.flags?.pf2e?.context?.type === "damage-roll" && token?.id) await m.update({ [`flags.${MOD}.shieldBlock.done.${token.id}`]: true });
}

/** ГМ: Щит — снять эффект; Amped — сломать слои. Идемпотентно; щит не от этого эффекта — ничего. */
export function dropSpellShield(actorUuid, effectId, layers = 0) {
  return queue(`actor:${actorUuid}`, async () => {
    const actor = await fromUuid(actorUuid);
    const item = actor?.items.get(effectId);
    if (item?.type !== "effect" || actor.attributes?.shield?.itemId !== effectId) return;
    const slug = item.slug ?? item.system?.slug;
    if (slug === AMPED && layers > 0) {
      const left = ampedLeft(item.system.badge?.value, layers);
      if (left > 0) await item.update({ "system.badge.value": left }); else await item.delete();
    } else if (SPELL_ENDS.has(slug)) await item.delete();
  });
}

// Клик по штатной кнопке урона pf2e: запоминаем карточку, чтобы обёртка applyDamage знала, откуда урон.
let clicked = null;
const CLICK_MS = 3000;

/** Захват клика по штатным кнопкам применения урона в карточке. */
export function trackApplyClicks(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (message?.flags?.pf2e?.context?.type !== "damage-roll" || !root?.addEventListener) return;
  root.addEventListener("click", (e) => {
    if (e.target?.closest?.("[data-action=applyDamage]")) clicked = { id: message.id, at: Date.now() };
  }, true);
}

/** Кнопка «Блок» в шёпоте. */
export function bindBlock(message, html) {
  const h = hintOf(message), root = html instanceof HTMLElement ? html : html?.[0];
  const btns = [...(root?.querySelectorAll?.("[data-af-shield-block]") ?? [])];
  if (!h || !btns.length) return;
  if (h.used) { btns.forEach((b) => { b.disabled = true; }); return; }
  for (const btn of btns) btn.addEventListener("click", async () => {
    btns.forEach((b) => { b.disabled = true; });
    const res = await callGM("useShieldBlock", message.id, btn.dataset.afCb || null);
    if (!res?.ok || res.result?.ok === false) {
      btns.forEach((b) => { b.disabled = false; });
      const r = res?.result ?? res;
      if (r?.reason !== "no-gm") ui.notifications.warn(L("chat.failed", { reason: r?.error ?? r?.reason }));
    }
  });
}

/** Сообщение pf2e «damage-taken» (связи с карточкой урона во флагах нет): свежий клик + токен из speaker -> карточка помечена применённой. Страховка, если applyDamage шёл мимо обёртки. */
export function onDamageTaken(message) {
  if (!message.isAuthor || message.flags?.pf2e?.context?.type !== "damage-taken" || !clicked || Date.now() - clicked.at >= CLICK_MS) return;
  const { scene, token } = message.speaker ?? {};
  const from = clicked.id;
  if (scene && token) callGM("markDamageApplied", from, `Scene.${scene}.Token.${token}`).catch((e) => console.error(`${MOD} | markDamageApplied`, e));
}

const APPLY = "CONFIG.Actor.documentClass.prototype.applyDamage";

/** Обёртка Actor#applyDamage: после применения урона с блоком просит ГМа снять щит заклинания.
 *  Есть libWrapper — регистрируем через него (иначе конфликт-предупреждения с другими модулями), нет — ручная подмена. */
export function wrapApplyDamage() {
  const wrap = async function (orig, opts, ...rest) {
    const shield = this.attributes?.shield ? { ...this.attributes.shield } : null;
    const fx = modeOf("shieldBlock") !== "off" && blockHappened({ request: opts?.shieldBlockRequest, damage: opts?.damage, shield }) ? spellShieldEffect(shield, this.items, this.rollOptions?.all) : null;
    const from = clicked && Date.now() - clicked.at < CLICK_MS ? clicked.id : null;
    // метку не гасим: pf2e применяет урон всем выделенным токенам в цикле; ошибочная метка лишь выключает нашу кнопку (безопасная сторона)
    const link = modeOf("macro") !== "off" ? damageLink.intercept(this, opts) : null;   // Связь жизни / Кровные узы: урон цели уменьшается до применения
    if (link) opts = { ...opts, damage: link.damage };
    const res = await orig.call(this, opts, ...rest);
    if (link) callGM("settleLink", this.uuid, link.rows, link.round).catch((e) => console.error(`${MOD} | settleLink`, e));
    if (fx) callGM("dropSpellShield", this.uuid, fx.id, fx.layers).catch((e) => console.error(`${MOD} | dropSpellShield`, e));
    if (from && opts?.token?.uuid) callGM("markDamageApplied", from, opts.token.uuid).catch((e) => console.error(`${MOD} | markDamageApplied`, e));
    return res;
  };
  if (globalThis.game?.modules?.get("lib-wrapper")?.active && globalThis.libWrapper) {
    libWrapper.register(MOD, APPLY, wrap, "WRAPPER");
    return;
  }
  const proto = CONFIG.Actor.documentClass?.prototype;
  if (!proto?.applyDamage || proto.applyDamage.__afShield) return;
  const orig = proto.applyDamage;
  proto.applyDamage = function (...a) { return wrap.call(this, orig, ...a); };
  proto.applyDamage.__afShield = true;
}
