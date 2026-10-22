// Проверки автора против защиты цели (onUse.check, plan.md §1.1a): бросает АВТОР, результат принимает общий движок saves.mjs.
// Чистые функции (defenseDc, hasImmunity, ...) не трогают Foundry — tests/checks.test.mjs.
import { MOD, L, flagPath, degreeFromTotal, isActiveGM } from "./util.mjs";
import { S } from "./settings.mjs";
import { useOf, safeUuid, marker, isPcActor, challengeOf, challengeTargets, recordResult } from "./saves.mjs";
import { applyEffect } from "./apply.mjs";
import { effectSource, addEffect, ask } from "./builtin/lib.mjs";

const rolling = new Set();

export const isCheck = (ch) => ch?.rollerRole === "author";

/* ---------- чистые функции ---------- */

const num = (v) => (Number.isFinite(v) ? v : null);

/** СЛ защиты цели: vs {defense}|{dc}|{against} -> число|null. actor — актёр цели. */
export function defenseDc(actor, vs) {
  if (!vs) return null;
  if (num(vs.dc) != null) return vs.dc;
  if (!actor) return null;
  const d = vs.defense;
  if (d === "ac") return num(actor.armorClass?.value ?? actor.getStatistic?.("ac")?.dc?.value);
  if (d === "perception") return num(actor.perception?.dc?.value);
  if (d) return num(actor.saves?.[d]?.dc?.value ?? actor.getStatistic?.(d)?.dc?.value);
  if (vs.against) return num((vs.against === "perception" ? actor.perception : actor.getStatistic?.(vs.against))?.dc?.value);
  return null;
}

/** slug защиты для `dc.slug` pf2e (контекст цели: бонусы против атакующего); у фиксированной СЛ slug нет. */
export const dcSlug = (vs) => (vs?.defense === "ac" ? "armor" : vs?.defense ?? vs?.against ?? null);

/** Статистика автора: slug или список slug (берём с наибольшим модификатором). */
export function pickStatistic(actor, statistic) {
  const list = (Array.isArray(statistic) ? statistic : [statistic]).map((slug) => {
    if (slug === "perception") return actor.perception;
    if (slug === "flat") {
      const Stat = actor.perception?.constructor;   // у pf2e нет флэт-статистики; класс Statistic общий (pf2e.mjs:28716)
      return Stat && new Stat(actor, { label: "", slug: "flat", modifiers: [], check: { type: "flat-check" } });
    }
    return actor.getStatistic?.(slug) ?? null;
  }).filter(Boolean);
  return list.reduce((best, s) => (!best || (s.check?.mod ?? s.mod ?? 0) > (best.check?.mod ?? best.mod ?? 0) ? s : best), null);
}

/** Эффект-иммунитет цели к этому действию ОТ ЭТОГО автора: тот же источник (uuid) либо наш флаг slug, origin.actor = автор. */
export function hasImmunity(actor, imm, authorUuid) {
  if (!actor || !imm || !authorUuid) return false;
  return actor.items.some((i) => i.type === "effect" && i.system?.context?.origin?.actor === authorUuid
    && ((imm.uuid && i._stats?.compendiumSource === imm.uuid) || i.flags?.[MOD]?.immunity?.slug === imm.slug));
}

export const immunityName = (imm) => imm.label ?? L("checks.immunityName", { name: imm.slug });

/** Цель иммунна к этому действию от автора сообщения (для применения по уже сделанному броску). */
export async function isImmune(use, token, check) {
  const author = check?.immunity ? await authorOf(use) : null;
  return !!author && hasImmunity(token?.actor, check.immunity, author.uuid);
}

/** Номер MAP (0..2) у автора для атакующего манёвра с карточки; null — отмена. */
async function askMap() {
  const id = await ask(L("checks.mapTitle"), `<p>${L("checks.mapPrompt")}</p>`, [0, 1, 2].map((n) => ({ id: String(n), label: L(`checks.mapOption${n}`) })));
  return id == null ? null : Number(id);
}

/* ---------- бросок ---------- */

/**
 * Бросок автора по одной цели. author — Actor, check — onUse.check, ctx: {message, tokenKey, target: TokenDocument, token?, skipDialog?, messageMode?, askMap?}.
 * Маркер в extraRollOptions: по нему acceptSavingThrow узнаёт бросок (и перебросы).
 */
export async function rollCheck(author, check, ctx = {}) {
  const { message, tokenKey, target } = ctx, use = useOf(message), tActor = target?.actor;
  if (!tActor) return null;
  if (hasImmunity(tActor, check.immunity, author.uuid)) { ui.notifications.info(L("checks.immuneNote", { name: tActor.name })); return null; }
  const dc = defenseDc(tActor, check.vs);
  if (dc == null) { ui.notifications.warn(L("checks.dcUnknown", { name: tActor.name })); return null; }
  const stat = pickStatistic(author, check.statistic);
  if (!stat) { ui.notifications.warn(L("saves.noStatistic", { name: author.name, stat: [check.statistic].flat().join("/") })); return null; }

  const item = await safeUuid(use?.item?.uuid);
  const slug = dcSlug(check.vs);
  const params = {
    dc: { value: dc, ...(slug && { slug }) }, target: tActor, item: item ?? undefined,
    token: ctx.token ?? (use?.token ? await safeUuid(use.token) : null) ?? author.getActiveTokens(true, true)[0] ?? undefined,
    extraRollOptions: [...(tokenKey ? [marker(message.id, tokenKey)] : []), ...(check.options ?? [])],
    traits: check.traits ?? []
  };
  let map = check.mapIncreases ?? 0;
  // карточка предмета: pf2e не хранит текущий MAP — у атакующих манёвров (trait attack) спрашиваем при ручном броске (ctx.askMap)
  if (ctx.askMap && !map && check.traits?.includes("attack")) {
    map = await askMap();
    if (map == null) return null;
  }
  if (map) params.attackNumber = map + 1;
  if (ctx.skipDialog != null) params.skipDialog = ctx.skipDialog;
  if (ctx.messageMode) params.messageMode = ctx.messageMode;
  let rollMessage = null;
  params.callback = (_r, _o, msg) => { rollMessage = msg; };
  const roll = await stat.check.roll(params);
  if (!roll) return null;
  const die = roll.dice?.[0]?.results?.find((r) => r.active && !r.discarded)?.result ?? null;
  return { degree: roll.degreeOfSuccess ?? degreeFromTotal(roll.total, dc, die), total: roll.total, dc, rollMessage };
}

const authorOf = async (use) => {
  const a = await safeUuid(use?.actor);
  return a?.actor ?? a;   // Token/TokenDocument -> Actor
};

/** ГМ: бросает за автора-NPC по всем целям (auto) либо только `only` (кнопка). Автор-PC — только кнопкой. */
export async function runCheck(message, { only } = {}) {
  const use = useOf(message), ck = challengeOf(use);
  if (!isActiveGM() || !isCheck(ck) || ck.roll === "system" || use.state?.yielded) return [];
  const author = await authorOf(use);
  if (!author) return [];
  if (!only && isPcActor(author)) return [];
  const done = [];
  for (const { key, token } of await challengeTargets(message)) {
    if (only && only !== key) continue;
    const rk = `${message.id}:${key}`;
    if (rolling.has(rk) || useOf(message).state?.challenge?.results?.[key]) continue;
    rolling.add(rk);
    try {
      const r = await rollCheck(author, ck, { message, tokenKey: key, target: token, skipDialog: true, askMap: !!only, messageMode: S.get("challenge.messageMode") });
      if (!r) continue;
      await recordResult(message.id, key, { degree: r.degree, total: r.total, dc: r.dc, by: game.user.id, rollMessageId: r.rollMessage?.id ?? null, src: "own" });
      done.push(key);
    } catch (e) { console.error(`${MOD} | runCheck ${key}`, e); }
    finally { rolling.delete(rk); }
  }
  return done;
}

/**
 * Бросок не через кнопку (игрок кликнул действие в чате): check-сообщение pf2e без маркера -> (сообщение с правилом, ключ цели)
 * по origin-предмету, автору и токену цели из context.target.
 */
export async function findCheckByOrigin(message, ctx) {
  const originUuid = message.flags?.pf2e?.origin?.uuid;
  if (!originUuid) return null;
  const stat = ctx.options?.find((o) => o.startsWith("check:statistic:") && !o.startsWith("check:statistic:base:"))?.slice(16);
  const since = Date.now() - S.get("resumeMinutes") * 60000;
  const msgs = game.messages.contents;
  for (let i = msgs.length - 1, n = 0; i >= 0 && n < 150; i--, n++) {
    const m = msgs[i], use = useOf(m), ck = use?.rule?.onUse?.check;
    if (!ck || use.item?.uuid !== originUuid || use.state?.yielded || (use.createdAt ?? Infinity) < since) continue;
    if (ctx.actor && use.actor && !use.actor.endsWith(ctx.actor)) continue;
    if (stat && ![ck.statistic].flat().includes(stat)) continue;
    const targets = await challengeTargets(m), tok = ctx.target?.token;
    const hit = targets.find((t) => t.token.uuid === tok) ?? (!tok && targets.length === 1 ? targets[0] : null);
    if (hit && (!use.state?.challenge?.results?.[hit.key] || ctx.isReroll)) return { msg: m, key: hit.key };
  }
  return null;
}

/* ---------- иммунитет после попытки ---------- */

/**
 * Эффект-иммунитет на цель (после попытки при любой степени). Идемпотентно (meta.key + hasImmunity);
 * созданное дописывается в state.challenge.applied.<key>.ops — откатывается вместе со степенью. Возвращает ops.
 */
export async function applyImmunity(message, tokenKey, token, imm, degree) {
  const use = useOf(message), tActor = token?.actor, author = await authorOf(use);
  if (!tActor || !author || hasImmunity(tActor, imm, author.uuid)) return [];
  const key = `${message.id}:${tokenKey}:imm`;
  let item;
  if (imm.uuid) {
    const originItem = use.item?.uuid ? await safeUuid(use.item.uuid) : null;
    const r = await applyEffect(tActor, { uuid: imm.uuid }, { key, source: "challenge", message: message.id, origin: use.item?.uuid ?? null, by: author.uuid },
      { originActor: author, originToken: use.token ? await safeUuid(use.token) : null, originItem, target: token });
    item = r.item;
  } else {
    const source = effectSource({
      name: immunityName(imm), duration: { ...imm.duration, expiry: "turn-start" },
      origin: { actor: author.uuid, token: use.token, item: use.item?.uuid }, target: { actor: tActor.uuid, token: token.uuid }
    });
    source.flags = { [MOD]: { immunity: { slug: imm.slug } } };
    item = await addEffect(tActor, source, key);
  }
  if (!item) return [];
  const path = flagPath("use", "state", "challenge", "applied", tokenKey);
  const prev = foundry.utils.getProperty(message, path) ?? null;
  await message.update({ [path]: { ops: [...(prev?.ops ?? []), { op: "created", item: item.uuid }], degree: prev?.degree ?? degree } });
  return [{ op: "created", item: item.uuid }];
}
