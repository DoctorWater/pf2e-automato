// Испытания: бросок, приём результата (любой saving-throw), применение по степеням. plan.md §2 saves, §3.C, §3.F.
import { MOD, L, DEGREES, flagPath, queue, degreeFromTotal, debug, callGM, isActiveGM } from "./util.mjs";
import { S, modeOf } from "./settings.mjs";
import { card } from "./card.mjs";
import { headOf } from "./builtin/lib.mjs";
import { inRange } from "./range.mjs";
import { toolbeltTargetHelper, toolbeltMessageTargets } from "./compat.mjs";
import { applyOps, opposed } from "./apply.mjs";
import { moveOrder, areaPoint } from "./move.mjs";
import { challengeWho } from "./rules.mjs";
import { testPredicate } from "./predicate.mjs";
import { runMacros } from "./macros.mjs";
import { runCheck, findCheckByOrigin, applyImmunity, isCheck, isImmune, recordOneRoll } from "./checks.mjs";

const MARKER = new RegExp(`^${MOD}:([^:]+):([^:]+)$`);
const rolling = new Set();

export const useOf = (message) => message?.flags?.[MOD]?.use ?? null;
/** Испытание цели (challenge) или проверка автора (check) — общий движок результатов/степеней. */
export const challengeOf = (use) => use?.rule?.onUse?.challenge ?? use?.rule?.onUse?.check ?? null;
export const safeUuid = async (uuid) => { try { return uuid ? await fromUuid(uuid) : null; } catch { return null; } };
const safeSync = (uuid) => { try { return uuid ? fromUuidSync(uuid) : null; } catch { return null; } };
export const marker = (messageId, key) => `${MOD}:${messageId}:${key}`;

export function init() {
  // Toolbelt Target Helper бросает спасброски с createMessage:false и saving-throw-сообщений не создаёт — результат только в хуках
  Hooks.on("pf2e-toolbelt.rollSave", (p) => acceptToolbeltSave(p).catch((e) => console.error(`${MOD} | toolbelt rollSave`, e)));
  Hooks.on("pf2e-toolbelt.rerollSave", (p) => acceptToolbeltSave({ ...p, roll: p.keptRoll, isReroll: true }).catch((e) => console.error(`${MOD} | toolbelt rerollSave`, e)));
}
export const isPcActor = (actor) => !!actor?.hasPlayerOwner;

/** Маркер `pf2e-automato:<msgId>:<tokenKey>` в roll options -> {messageId, tokenKey}|null. */
export function parseMarker(options) {
  for (const o of options ?? []) {
    const m = MARKER.exec(o);
    if (m) return { messageId: m[1], tokenKey: m[2] };
  }
  return null;
}

export function damageMultiplier(degree, basic) {
  if (!basic) return null;
  return [2, 1, 0.5, 0][degree] ?? null;
}

/* ---------- СЛ ---------- */

/** СЛ из HTML после enrichHTML: первая `a.inline-check` с числовым data-pf2-dc и (если задано) нужным data-pf2-check. */
export function dcFromEnriched(html, statistic = null) {
  for (const m of String(html ?? "").matchAll(/<a\b[^>]*>/g)) {
    const tag = m[0];
    if (!/inline-check/.test(tag)) continue;
    const attr = (n) => tag.match(new RegExp(`\\s${n}="([^"]*)"`))?.[1];
    if (statistic && attr("data-pf2-check") !== statistic) continue;
    const raw = attr("data-pf2-dc");
    if (raw != null && raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  }
  return null;
}

async function enrich(content, rollData) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  return TE.enrichHTML(content, { rollData });
}

const num = (v) => (Number.isFinite(v) ? v : null);

/** СЛ испытания: use.dc (снимок/setDC) -> value -> spell -> against -> expr/markup. ctx: {item?, actor?}. */
export async function resolveDC(use, ctx = {}) {
  if (num(use?.dc) != null) return use.dc;
  const ch = challengeOf(use), dc = ch?.dc;
  if (!dc) return null;
  if (num(dc.value) != null) return dc.value;

  const item = ctx.item ?? await safeUuid(use.item?.uuid);
  const actor = ctx.actor ?? item?.actor ?? await safeUuid(use.actor);
  const actorActor = actor?.actor ?? actor;   // Token/TokenDocument -> Actor
  const spellDC = () => {
    const sc = item?.spellcasting?.statistic;
    const st = sc ? (sc.withRollOptions?.({ item }) ?? sc) : actorActor?.spellcasting?.contents?.find((e) => e.statistic)?.statistic;
    return num(st?.dc?.value);
  };

  if (dc.source === "spell") return spellDC() ?? num(actorActor?.getStatistic?.("class")?.dc?.value);
  if (dc.against) {
    return dc.against === "spell" ? spellDC() : num((actorActor?.getStatistic?.(dc.against) ?? actorActor?.getStatistic?.("class"))?.dc?.value);
  }
  if (dc.expr) {
    const rollData = { actor: actorActor, item };
    if (dc.expr === "markup") {
      const desc = item?.system?.description?.value;
      return desc ? dcFromEnriched(await enrich(desc, rollData), ch.statistic) : null;
    }
    return dcFromEnriched(await enrich(`@Check[${ch.statistic}|dc:${dc.expr}]`, rollData));
  }
  return null;
}

/* ---------- цели ---------- */

/** Цели испытания: [{key, token:TokenDocument}] — Toolbelt (если ведёт цели) -> область -> снимок. */
export async function challengeTargets(message) {
  const use = useOf(message);
  if (!use) return [];
  const ch = challengeOf(use);
  // who у всех шагов к цели («только враги»): союзник области не бросает и не получает иммунитет
  const who = challengeWho(ch), myDisp = who ? (safeSync(use.token)?.disposition ?? 1) : 1;
  // oneRoll: после первого броска состав целей фиксирован (eligible) — позже испугавшаяся цель не добавляется; результат/eligible = «when проверен»
  const res = use.state?.challenge?.results ?? {}, elig = ch?.oneRoll ? use.state?.challenge?.eligible : null;
  return (await challengeTargetsAll(message, use)).filter((t) => (!elig || elig.includes(t.key) || res[t.key]) && challengeApplies(ch, t.token?.actor, use.actor, !!res[t.key] || !!elig?.includes(t.key)) && (!who || (who === "enemy") === opposed(myDisp, t.token?.disposition ?? 0)));
}

/** challenge.when — условие на цель (target:*, target:self): не выполнено — цель не бросает и в карточке не показана (Возложение рук: бросает только нежить). */
export function challengeApplies(ch, actor, authorUuid, resolved = false) {
  if (resolved || !ch?.when || !actor) return true;   // resolved: результат записан — условие проверено при броске и не пересчитывается (испуг снят — цель остаётся в карточке)
  const o = new Set(["target", ...(actor.getSelfRollOptions?.("target") ?? [])]);
  if (authorUuid && actor.uuid === authorUuid) o.add("target:self");
  return testPredicate(ch.when, o);
}

async function challengeTargetsAll(message, use) {
  if (S.get("useToolbeltTargetHelper")) {
    const tb = toolbeltMessageTargets(message);
    const far = new Set((use.targets ?? []).filter((t) => t.far).map((t) => t.key));   // цели Toolbelt берутся из его списка — вне дальности отсеиваем по снимку
    if (tb) return tb.filter((t) => !far.has(t.id)).map((t) => ({ key: t.id, token: t }));
  }
  if (use.rule?.onUse?.targets === "area" && use.state?.area) {   // регион не ставили (цели выделены руками, спасы через Toolbelt) — снимок ниже
    const area = use.state.area;
    const scene = (safeSync(area?.regionUuid)?.parent) ?? canvas?.scene;
    return (area?.keys ?? []).map((k) => scene?.tokens.get(k)).filter(Boolean).map((t) => ({ key: t.id, token: t }));
  }
  return inRange(use.targets).map((t) => safeSync(t.uuid)).filter(Boolean).map((t) => ({ key: t.id, token: t }));
}

const toolbeltRolls = () => S.get("useToolbeltTargetHelper") && toolbeltTargetHelper().checks;

/** Все цели имеют результат либо иммунны (иммунная цель не бросает: без этого afterChallenge не дождался бы её). */
async function allResolved(message) {
  const targets = await challengeTargets(message), use = useOf(message), ch = challengeOf(use);
  const res = use?.state?.challenge?.results ?? {};
  const done = await Promise.all(targets.map(async (t) => !!res[t.key] || (!!ch?.immunity && await isImmune(use, t.token, ch))));
  return targets.length > 0 && done.every(Boolean);
}

/* ---------- бросок ---------- */

/**
 * Бросок испытания за актёра цели. ctx: {message, tokenKey, token?, dc?, skipDialog?, messageMode?}.
 * Маркер в extraRollOptions: по нему acceptSavingThrow узнаёт бросок (и перебросы — pf2e копирует options).
 */
export async function rollSave(actor, challenge, ctx = {}) {
  const { message, tokenKey } = ctx;
  const use = useOf(message);
  if (challenge.immunity && await isImmune(use, { actor }, challenge)) { ui.notifications.info(L("checks.immuneNote", { name: actor.name })); return null; }
  const dc = ctx.dc ?? await resolveDC(use);
  if (dc == null) { ui.notifications.warn(L("saves.dcUnknown")); return null; }

  let stat;
  if (challenge.statistic === "flat") {
    // у pf2e нет флэт-статистики на актёре; класс Statistic общий (pf2e.mjs:28716)
    const Stat = actor.perception?.constructor;
    stat = Stat && new Stat(actor, { label: "", slug: "flat", modifiers: [], check: { type: "flat-check" } });
  } else stat = actor.getStatistic(challenge.statistic);
  if (!stat) { ui.notifications.warn(L("saves.noStatistic", { name: actor.name, stat: challenge.statistic })); return null; }

  const item = await safeUuid(use?.item?.uuid);
  const origin = (await safeUuid(use?.actor)) ?? item?.actor ?? undefined;
  const token = ctx.token ?? actor.getActiveTokens(true, true)[0] ?? undefined;
  const extraRollOptions = [...(tokenKey ? [marker(message.id, tokenKey)] : []), ...(challenge.options ?? []),
    ...(challenge.basic ? ["damaging-effect"] : []),
    // черты испытания — и в опции броска: pf2e проверяет incapacitation по опциям до того, как добавит params.traits (как инлайн-@Check)
    ...(challenge.traits ?? []).flatMap((t) => [t, `item:trait:${t}`])];

  let rollMessage = null;
  const params = {
    dc: { value: dc }, origin: origin?.actor ?? origin, item: item ?? undefined, token, extraRollOptions,
    traits: challenge.traits ?? [],
    callback: (_roll, _outcome, msg) => { rollMessage = msg; }
  };
  if (ctx.skipDialog != null) params.skipDialog = ctx.skipDialog;
  if (ctx.messageMode) params.messageMode = ctx.messageMode;
  const roll = await stat.check.roll(params);
  if (!roll) return null;
  const die = roll.dice?.[0]?.results?.find((r) => r.active && !r.discarded)?.result ?? null;
  return { degree: roll.degreeOfSuccess ?? degreeFromTotal(roll.total, dc, die), total: roll.total, rollMessage };
}

/** Отметка «автоматика уже пробовала» (state.challenge.<kind>[key]): чат возвращает кнопку, если автоматика не сработала/откатана. */
export const markTried = (messageId, kind, key) => game.messages.get(messageId)?.update({ [flagPath("use", "state", "challenge", kind, key)]: true }).catch(() => {});

/** ГМ: бросает NPC-целей (auto) либо только `only` (кнопка). PC — только кнопкой игрока. */
export async function runChallenge(message, { only } = {}) {
  const use = useOf(message), ch = challengeOf(use);
  if (!isActiveGM() || !ch || use.state?.yielded) return [];
  const mode = modeOf("challenge");
  if (mode === "off" || (mode === "button" && !only) || (!isCheck(ch) && toolbeltRolls())) return [];
  if (isCheck(ch)) return runCheck(message, { only });

  const dc = await resolveDC(use);
  if (dc == null) { ui.notifications.warn(L("saves.dcUnknown")); return []; }
  if (!Number.isFinite(use.dc)) await message.update({ [flagPath("use", "dc")]: dc });   // вычисленная СЛ — в снимок (K7 п.7)
  const done = [];
  for (const { key, token } of await challengeTargets(message)) {
    if (only && only !== key) continue;
    const actor = token.actor;
    if (!actor || (!only && isPcActor(actor))) continue;
    const rk = `${message.id}:${key}`;
    if (rolling.has(rk) || useOf(message).state?.challenge?.results?.[key]) continue;
    rolling.add(rk);
    try {
      const r = await rollSave(actor, ch, { message, tokenKey: key, token, dc, skipDialog: true, messageMode: S.get("challenge.messageMode") });
      if (!r) { if (!only) await markTried(message.id, "rollTried", key); continue; }
      await recordResult(message.id, key, { degree: r.degree, total: r.total, by: game.user.id, rollMessageId: r.rollMessage?.id ?? null, src: "own" });
      done.push(key);
    } catch (e) { console.error(`${MOD} | runChallenge ${key}`, e); if (!only) await markTried(message.id, "rollTried", key); }
    finally { rolling.delete(rk); }
  }
  return done;
}

/* ---------- приём результата ---------- */

const CHECK_TYPES = new Set(["skill-check", "perception-check", "flat-check"]);

/** ГМ: любое saving-throw-сообщение -> результат испытания (по маркеру либо по origin-предмету + токену цели). */
export async function acceptSavingThrow(message) {
  if (!isActiveGM()) return null;
  const pf2e = message.flags?.pf2e, ctx = pf2e?.context;
  const mk = parseMarker(ctx?.options);   // по маркеру принимаем и не-save статистики (навык, Восприятие)
  if (!mk && ctx?.type !== "saving-throw" && !CHECK_TYPES.has(ctx?.type)) return null;
  try {
    const roll = message.rolls?.[0];
    if (!roll) return null;
    let target = mk ? { msg: game.messages.get(mk.messageId), key: mk.tokenKey }
      : ctx.type === "saving-throw" ? await findByOrigin(message, ctx) : await findCheckByOrigin(message, ctx);
    const use = useOf(target?.msg);
    if (!challengeOf(use) || use.state?.yielded) return null;

    const die = roll.dice?.[0]?.results?.find((r) => r.active && !r.discarded)?.result ?? null;
    if (use.rule.onUse.check?.oneRoll) {   // один итог — степень по СЛ каждой цели (ctx.dc — СЛ одной цели, не годится)
      return await recordOneRoll(target.msg, { total: roll.total, die, key: target.key,
        by: message.author?.id ?? message.user?.id ?? null, rollMessageId: message.id, src: "saving-throw", isReroll: !!ctx.isReroll });
    }
    let degree = roll.degreeOfSuccess ?? null;
    if (degree == null) {
      const dc = ctx.dc?.value ?? await resolveDC(use);
      if (dc == null) return null;
      degree = degreeFromTotal(roll.total, dc, die);
    }
    return await recordResult(target.msg.id, target.key, {
      degree, total: roll.total, by: message.author?.id ?? message.user?.id ?? null,
      rollMessageId: message.id, src: "saving-throw", isReroll: !!ctx.isReroll, dc: ctx.dc?.value ?? null
    });
  } catch (e) { console.error(`${MOD} | acceptSavingThrow`, e); return null; }
}

/**
 * Результат Toolbelt: хук {data:{success,value}, message, roll, target(TokenDocument)}. Любой клиент: активный ГМ пишет сам,
 * остальные — через сокет recordToolbeltSave (права: владелец актёра цели).
 */
export async function acceptToolbeltSave({ data, message, roll, target, isReroll = false }) {
  const use = useOf(message);
  if (!challengeOf(use) || use.state?.yielded || !target?.id) return null;
  const idx = DEGREES.indexOf(data?.success);
  const degree = idx >= 0 ? idx : (roll?.degreeOfSuccess ?? null);
  const total = data?.value ?? roll?.total;
  if (!Number.isInteger(degree) || degree < 0 || degree > 3 || !Number.isFinite(total)) return null;
  const res = { degree, total, isReroll };
  if (isActiveGM()) return recordToolbeltResult(message.id, target.id, res);
  return callGM("recordToolbeltSave", message.id, target.id, res);
}

/** ГМ: запись результата Toolbelt (поля из сокета перечисляются явно). */
export async function recordToolbeltResult(messageId, tokenKey, { degree, total, isReroll }) {
  // Toolbelt пишет результат любой своей цели: challenge.when проверяем здесь (у решённой цели challengeTargets его не пересчитывает)
  const message = game.messages.get(messageId);
  if (challengeOf(useOf(message))?.when && !(await challengeTargets(message)).some((t) => t.key === tokenKey)) return { ok: false, reason: "not-target" };
  return recordResult(messageId, tokenKey, { degree, total, by: game.user.id, rollMessageId: null, src: "toolbelt", isReroll: !!isReroll });
}

async function findByOrigin(message, ctx) {
  const originUuid = message.flags.pf2e.origin?.uuid;
  if (!originUuid) return null;
  const stat = ctx.options?.find((o) => o.startsWith("check:statistic:") && !o.startsWith("check:statistic:base:"))?.slice(16);
  const since = Date.now() - S.get("resumeMinutes") * 60000;
  const msgs = game.messages.contents;
  for (let i = msgs.length - 1, n = 0; i >= 0 && n < 150; i--, n++) {   // свежайшее сообщение первым
    const m = msgs[i], use = useOf(m), ch = use?.rule?.onUse?.challenge;
    if (!ch || use.item?.uuid !== originUuid || use.state?.yielded || (use.createdAt ?? Infinity) < since) continue;
    if (stat && ch.statistic !== stat) continue;
    const targets = await challengeTargets(m);
    // токен — по id; запасной путь по актёру, только если однозначен
    const hit = targets.find((t) => t.key === ctx.token)
      ?? (targets.filter((t) => t.token.actor?.id === ctx.actor).length === 1 ? targets.find((t) => t.token.actor?.id === ctx.actor) : null);
    if (hit && (!use.state?.challenge?.results?.[hit.key] || ctx.isReroll)) return { msg: m, key: hit.key };
  }
  return null;
}

/**
 * ГМ. Результат принимается, пока не применён; повтор того же — игнор; переброс (isReroll) перезаписывает,
 * после применения — changedAfterApply + шёпот ГМу.
 */
export async function recordResult(messageId, tokenKey, result) {
  const res = await queue(`msg:${messageId}`, async () => {
    const message = game.messages.get(messageId), use = useOf(message);
    if (!use || use.state?.yielded) return { ok: false, reason: "no-use" };
    const cur = use.state?.challenge?.results?.[tokenKey];
    if (cur && (!result.isReroll || (result.rollMessageId && cur.rollMessageId === result.rollMessageId))) return { ok: false, reason: "duplicate" };
    const changed = !!cur && !!use.state?.challenge?.applied?.[tokenKey];
    await message.update({
      [flagPath("use", "state", "challenge", "results", tokenKey)]: {
        degree: result.degree, total: result.total, by: result.by ?? null, rollMessageId: result.rollMessageId ?? null,
        src: result.src ?? "own", changedAfterApply: changed || !!cur?.changedAfterApply,
        ...(Number.isFinite(result.dc) && { dc: result.dc })
      }
    });
    if (changed) {
      const name = (await challengeTargets(message)).find((t) => t.key === tokenKey)?.token.name ?? tokenKey;
      await ChatMessage.create({ content: card(L("saves.changedAfterApply", { name, item: use.item?.name ?? "" }), "", headOf("saves")), whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id) });
    }
    return { ok: true, changed };
  });
  if (res.ok && !res.changed) await afterRecord(messageId, tokenKey);
  return res;
}

async function afterRecord(messageId, tokenKey) {
  let batch = false, deferred = false;
  try {
    const message = game.messages.get(messageId), ch = challengeOf(useOf(message));
    const by = ch.byDegree ?? {};
    const hasSteps = DEGREES.some((d) => by[d]?.length) || !!ch.immunity;
    const hasMacros = useOf(message).rule.macros?.some((m) => m.phase === "onDegree");
    const apply = modeOf("apply");
    // шаг move: в auto ждём результаты всех целей и применяем разом (дальние первыми); applyByDegree("all") сам зовёт afterChallenge
    const hasMove = Object.values(by).flat().some((s) => s?.move);
    // autoAll — пакет уже отработал: дальше (переброс, откат ГМа) только своя цель, откатанные чужие заново не применяются
    if (apply === "auto" && useOf(message).confidence !== "low" && (hasSteps || hasMacros)) {
      if (!hasMove || useOf(message).state?.challenge?.autoAll) await applyByDegree(messageId, tokenKey);
      else if (await allResolved(message)) { await applyByDegree(messageId, "all", { auto: true }); batch = true; }
      else deferred = true;
    }
    if (!batch && await allResolved(message)) await afterChallenge(message);
  } catch (e) { console.error(`${MOD} | afterRecord`, e); }
  if (modeOf("apply") !== "auto" || useOf(game.messages.get(messageId))?.confidence === "low") return;
  // пакет закрыл всех бросивших; в ожидании «попытки» нет — кнопка «Применить» у них и так есть (chat.mjs)
  if (batch) for (const k of Object.keys(useOf(game.messages.get(messageId))?.state?.challenge?.results ?? {})) await markTried(messageId, "autoTried", k);
  else if (!deferred) await markTried(messageId, "autoTried", tokenKey);
}

export async function afterChallenge(message) {
  const use = useOf(message);
  if (!use || use.state?.yielded) return [];
  return runMacros("afterChallenge", { message, rule: use.rule, targets: (await challengeTargets(message)).map((t) => t.token) });
}

/* ---------- применение по степеням ---------- */

/** ГМ: применить byDegree к одной цели или ко всем с результатом. Идемпотентно (meta.key в applyOps). */
export function applyByDegree(messageId, tokenKey, { auto = false } = {}) {
  return queue(`msg:${messageId}`, async () => {
    const message = game.messages.get(messageId), use = useOf(message), ch = challengeOf(use);
    if (!ch || use.state?.yielded || modeOf("apply") === "off") return [];
    const targets = await challengeTargets(message);
    const all = tokenKey === "all";
    if (all && auto) await message.update({ [flagPath("use", "state", "challenge", "autoAll")]: true });   // постоянно: afterRecord больше не гонит пакет
    const ops = [];
    // толчок идёт от дальних целей к ближним, притяжение — наоборот (передний не мешает заднему)
    const moveSteps = Object.values(ch.byDegree ?? {}).flat();
    const fromPoint = moveSteps.find((s) => s?.move)?.move.from === "point";   // отсчёт от центра области, не от автора
    const originDoc = all && use.token ? await fromUuid(use.token) : null;
    const centreOf = (t) => ({ x: t.x + (t.width * (t.parent?.grid?.size ?? 100)) / 2, y: t.y + (t.height * (t.parent?.grid?.size ?? 100)) / 2 });
    const from = all ? (fromPoint && areaPoint(use)) || (originDoc ? centreOf(originDoc) : null) : null;   // нет точки — как при откате шага: от автора
    const order = from ? moveOrder(moveSteps, targets.map((e) => ({ ...centreOf(e.token), e })), from).map((i) => i.e) : targets;
    for (const { key, token } of order) {
      if (!all && key !== tokenKey) continue;
      const r = useOf(message).state?.challenge?.results?.[key];
      if (!r) continue;
      if (all && auto && useOf(message).state?.challenge?.undone?.[key]) continue;   // ГМ откатил строку до пакета — не возвращаем
      // бросок уже сделан (действие или спасбросок из листа), а цель иммунна к этому автору: ничего не применяем (повтор после применения — идемпотентно, пропуск не нужен)
      if (ch.immunity && !useOf(message).state?.challenge?.applied?.[key] && await isImmune(useOf(message), token, ch)) continue;
      const steps = ch.byDegree?.[DEGREES[r.degree]] ?? [];
      ops.push(...await applyOps(message, key, steps, { scope: "challenge", msgQueued: true, degree: r.degree, total: r.total, target: token }));
      if (ch.immunity) ops.push(...await applyImmunity(message, key, token, ch.immunity, r.degree));
      if (r.changedAfterApply) await message.update({ [flagPath("use", "state", "challenge", "results", key, "changedAfterApply")]: false });
    }
    if (all) await afterChallenge(message);
    debug("applyByDegree", messageId, tokenKey, ops.length);
    return ops;
  });
}
