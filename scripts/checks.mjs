// Проверки автора против защиты цели (onUse.check, plan.md §1.1a): бросает АВТОР, результат принимает общий движок saves.mjs.
// Чистые функции (defenseDc, hasImmunity, ...) не трогают Foundry — tests/checks.test.mjs.
import { MOD, L, DEGREES, flagPath, degreeFromTotal, isActiveGM } from "./util.mjs";
import { S } from "./settings.mjs";
import { useOf, safeUuid, marker, isPcActor, challengeOf, challengeTargets, recordResult, markTried } from "./saves.mjs";
import { applyEffect } from "./apply.mjs";
import { isHeld } from "./hold.mjs";
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

/** use.dc перекрывает фиксированную vs.dc только если её задал ГМ (state.dcSet) или карточка проверки записи (state.castMessage); иначе use.dc — СЛ активации/сотворения. */
export const dcOverridden = (use) => Number.isFinite(use?.dc) && !!(use.state?.dcSet || use.state?.castMessage);

/** СЛ проверки карточки: фиксированная vs.dc может быть исправлена ГМом (use.dc, кнопка «СЛ»); остальные защиты — от цели. */
export const checkDcOf = (use, actor, check) => (check?.vs?.dc != null && dcOverridden(use) ? use.dc : defenseDc(actor, check?.vs));

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

/** Эффект-иммунитет цели к этому действию ОТ ЭТОГО автора (scope:"slug" — от любого): тот же источник (uuid) либо наш флаг slug, origin.actor = автор; истёкший не в счёт. */
export function hasImmunity(actor, imm, authorUuid) {
  if (!actor || !imm || (!authorUuid && imm.scope !== "slug")) return false;
  return actor.items.some((i) => i.type === "effect" && !i.system?.expired && (imm.scope === "slug" || i.system?.context?.origin?.actor === authorUuid)
    && ((imm.uuid && i._stats?.compendiumSource === imm.uuid) || i.flags?.[MOD]?.immunity?.slug === imm.slug));
}

/** Ставится ли иммунитет при этой степени (индекс 0..3): нет `degrees` — при любой. */
export const immunityAt = (imm, degree) => !!imm && (!imm.degrees || imm.degrees.includes(DEGREES[degree]));

export const immunityName = (imm, itemName = null) => L("checks.immunityName", { name: imm.label ?? itemName ?? imm.slug });

/** Цель иммунна к этому действию от автора сообщения: испытание или проверка (token — что угодно с .actor). */
export async function isImmune(use, token, check) {
  const author = check?.immunity ? await authorOf(use) : null;
  return !!author && hasImmunity(token?.actor, check.immunity, author.uuid);
}

/** Номер MAP (0..2) у автора для атакующего манёвра с карточки; null — отмена. */
export async function askMap() {
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
  const dc = checkDcOf(use, tActor, check);
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
  return { degree: roll.degreeOfSuccess ?? degreeFromTotal(roll.total, dc, die), total: roll.total, die, dc, rollMessage };
}

/** oneRoll: ОДИН бросок автора (по СЛ первой цели), степени остальных — от того же итога. */
async function runOneRoll(message, ck, author, only) {
  const res = () => useOf(message).state?.challenge?.results ?? {};
  const pending = (await challengeTargets(message)).filter((t) => !res()[t.key] && !hasImmunity(t.token?.actor, ck.immunity, author.uuid));
  const rk = `${message.id}:*`;
  if (!pending.length || rolling.has(rk)) return [];
  rolling.add(rk);
  const fail = async () => { if (!only) for (const t of pending) await markTried(message.id, "rollTried", t.key); return []; };
  try {
    const first = pending[0];
    const r = await rollCheck(author, ck, { message, tokenKey: first.key, target: first.token, skipDialog: true, askMap: !!only, messageMode: S.get("challenge.messageMode") });
    if (!r) return await fail();
    if (isHeld(r.rollMessage)) return [];   // удержан ради переброски (hold.mjs): исход запишет replay; rollTried не ставим (см. runCheck)
    return (await recordOneRoll(message, { total: r.total, die: r.die, key: first.key, degree: r.degree, dc: r.dc, by: game.user.id, rollMessageId: r.rollMessage?.id ?? null, src: "own" })).keys;
  } catch (e) { console.error(`${MOD} | runCheck oneRoll`, e); return await fail(); }
  finally { rolling.delete(rk); }
}

/**
 * oneRoll: один итог -> результат каждой цели карточки по её СЛ (key — цель, по которой бросал pf2e: берём её степень и СЛ).
 * Иммунные и уже решённые пропускаются (при переброске пересчитываются все). Возвращает {ok, keys}.
 */
export async function recordOneRoll(message, { total, die = null, key, degree = null, dc = null, ...meta }) {
  const use = useOf(message), ck = challengeOf(use), author = await authorOf(use), keys = [];
  const targets = await challengeTargets(message);
  // состав целей фиксируется при первой записи: поздно испугавшаяся цель не получит бросок (challengeTargets берёт state.challenge.eligible)
  if (!use.state?.challenge?.eligible) await message.update({ [flagPath("use", "state", "challenge", "eligible")]: targets.map((t) => t.key) });
  for (const t of targets) {
    const own = t.key === key, has = !!useOf(message).state?.challenge?.results?.[t.key];
    if (has ? !meta.isReroll : hasImmunity(t.token?.actor, ck.immunity, author?.uuid)) continue;   // иммунная без результата не участвует; с результатом пересчитывается при переброске
    const d = own && dc != null ? dc : defenseDc(t.token?.actor, ck.vs);
    if (d == null) continue;
    // ponytail: степень неглавных целей — по статической СЛ; AdjustDegreeOfSuccess автора и контекстные модификаторы СЛ цели учтены только у главной (её считает pf2e); upgrade — отдельный расчёт pf2e по цели
    const r = await recordResult(message.id, t.key, { ...meta, total, dc: d, degree: own && degree != null ? degree : degreeFromTotal(total, d, die) });
    if (r.ok) keys.push(t.key);
  }
  return { ok: keys.length > 0, keys };
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
  if (ck.oneRoll) return runOneRoll(message, ck, author, only);
  const done = [];
  for (const { key, token } of await challengeTargets(message)) {
    if (only && only !== key) continue;
    const rk = `${message.id}:${key}`;
    if (rolling.has(rk) || useOf(message).state?.challenge?.results?.[key]) continue;
    rolling.add(rk);
    try {
      const r = await rollCheck(author, ck, { message, tokenKey: key, target: token, skipDialog: true, askMap: !!only, messageMode: S.get("challenge.messageMode") });
      if (!r) { if (!only) await markTried(message.id, "rollTried", key); continue; }
      if (isHeld(r.rollMessage)) continue;   // удержан ради переброски (hold.mjs): исход запишет replay; rollTried не ставим — кнопка «Бросить» не нужна, бросок уже есть
      await recordResult(message.id, key, { degree: r.degree, total: r.total, dc: r.dc, by: game.user.id, rollMessageId: r.rollMessage?.id ?? null, src: "own" });
      done.push(key);
    } catch (e) { console.error(`${MOD} | runCheck ${key}`, e); if (!only) await markTried(message.id, "rollTried", key); }
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
    // oneRoll: бросок касается всех (выбранная цель может быть не в списке) — берём её или первую нерешённую, остальные получат степень от того же итога
    const hit = targets.find((t) => t.token.uuid === tok) ?? (ck.oneRoll ? targets.find((t) => !use.state?.challenge?.results?.[t.key]) ?? (ctx.isReroll ? targets[0] : null) : !tok && targets.length === 1 ? targets[0] : null);
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
  if (!immunityAt(imm, degree) || !tActor || !author || hasImmunity(tActor, imm, author.uuid)) return [];
  const key = `${message.id}:${tokenKey}:imm`;
  let item;
  if (imm.uuid) {
    const originItem = (use.item?.uuid ? await safeUuid(use.item.uuid) : null) ?? ((message.flags?.[MOD]?.activation ?? message.flags?.[MOD]?.cast) ? message.item : null);
    const r = await applyEffect(tActor, { uuid: imm.uuid }, { key, source: "challenge", message: message.id, origin: use.item?.uuid ?? null, by: author.uuid },
      { originActor: author, originToken: use.token ? await safeUuid(use.token) : null, originItem, target: token });
    item = r.item;
  } else {
    const source = effectSource({
      name: immunityName(imm, use.item?.name), duration: { ...imm.duration, expiry: "turn-start" },
      origin: { actor: author.uuid, token: use.token, item: use.item?.uuid }, target: { actor: tActor.uuid, token: token.uuid }
    });
    source.flags = { [MOD]: { immunity: { slug: imm.slug } } };
    source.system.slug = `${imm.slug}-immunity`;   // предикаты вида not target:effect:<slug>-immunity (аура Bane) видят иммунитет
    item = await addEffect(tActor, source, key);
  }
  if (!item) return [];
  const path = flagPath("use", "state", "challenge", "applied", tokenKey);
  const prev = foundry.utils.getProperty(message, path) ?? null;
  await message.update({ [path]: { ops: [...(prev?.ops ?? []), { op: "created", item: item.uuid }], degree: prev?.degree ?? degree } });
  return [{ op: "created", item: item.uuid }];
}
