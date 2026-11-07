// Переброс после провала (rule.onFailed, docs/plan-reroll.md). Сообщение проверки с кандидатом на переброс рождается удержанным (hold.mjs, причина "reroll"):
// модуль не пересчитывает исход после применения, поэтому до решения никто его не обрабатывает. ГМ шлёт адресатам шёпот-подсказку с кнопками
// «<предмет>» и «Без переброса»; переброс делает клиент автора проверки (pf2e Check.rerollFromMessage — удаляет старое сообщение и создаёт новое
// с isReroll, оно проходит как первое), затем списывается цена. Нет решения за HOLD_MS, смена хода, «Без переброса» у всех — удержание выпускается (replay).
import { L, MOD, queue, socket, isActiveGM } from "../util.mjs";
import { testPredicate } from "../predicate.mjs";
import { modeOf } from "../settings.mjs";
import { itemRange } from "../range.mjs";
import { isRerollHold, resolve, REROLL } from "../hold.mjs";
import { esc, card, cardButton, headOf, combatOf, recipients, distanceOf, ownerQueue, reactorsOf, itemsWith, useOnce, bindHint, expireWhere } from "./lib.mjs";
import { eligible, resourceOk, requiresOk, rangeOk, turnKey, staleTurn } from "./damaged.mjs";

export { tokensOf } from "./damaged.mjs";
export const hintOf = (m) => m?.flags?.[MOD]?.failed;
export const HOLD_MS = 30_000;   // как окно реакции: нет решения — проверка принимается как есть

/* ---------- чистые функции ---------- */

const TYPES = { save: ["saving-throw"], skill: ["skill-check"], perception: ["perception-check"], attack: ["attack-roll", "spell-attack-roll"] };
/** Тип проверки (ctx.type) входит в `check` правила. */
export const typeOk = (check, type) => (check ?? []).some((c) => TYPES[c]?.includes(type));

const DEGREE_OUTCOMES = { fail: ["failure", "criticalFailure"], critFail: ["criticalFailure"], failNotCrit: ["failure"] };
/** Исход проверки (ctx.outcome) подходит под degree правила; нет исхода (проверка без СЛ) — нет. */
export const degreeOk = (degree, outcome) => !!outcome && (DEGREE_OUTCOMES[degree] ?? []).includes(outcome);

/** Удача уже сработала на этом броске (переброс, бросок дважды с лучшим): вторую «удачу» к тому же броску не применить. */
// roll — бросок сообщения: pf2e не даёт перебрасывать кости с kh/kl (CheckRoll.isRerollable, pf2e.mjs:19322).
// Подстановка (Уверенность — fortune, бросок без кубов): перебрасывать нечего, а isRerollable у неё true.
export const noLuck = (ctx, roll) => !!ctx?.isReroll || (ctx?.options ?? []).includes("check:reroll") || ctx?.rollTwice === "keep-higher" || roll?.isRerollable === false
  || !!ctx?.substitutions?.some?.((s) => s.selected) || (Array.isArray(roll?.dice) && roll.dice.length === 0);

/** Опции проверки для `when`: опции броска pf2e и опции источника (origin:…). */
// check:type:<ctx.type> — свой: у Удара pf2e опции check:type нет (не StatisticCheck), а when каталога (Perfect Clarity) её ждёт
export const optionsOf = (message) => {
  const ctx = message?.flags?.pf2e?.context, set = new Set([...(ctx?.options ?? []), ...(message?.flags?.pf2e?.origin?.rollOptions ?? [])]);
  if (ctx?.type) set.add(`check:type:${ctx.type}`);
  return set;
};

// Словарь опций проверки, которые pf2e реально выдаёт (pf2e.mjs: check:statistic:, check:type:, item:trait:, origin:trait:, action:, damaging-effect) — ни одно `when` каталога не должно быть мёртвым.
const OPTION_VOCAB = [/^check:statistic:[a-z0-9-]+$/, /^check:type:(saving-throw|skill|perception|attack-roll|spell-attack-roll|flat)$/, /^item:trait:[a-z-]+$/, /^origin:trait:[a-z-]+$/, /^action:[a-z-]+$/, /^damaging-effect$/];
export const knownOption = (t) => OPTION_VOCAB.some((re) => re.test(t));

/** Предмет — реакция (тратит реакцию владельца); остальное — свободное действие или заклинание без реакции. */
export const isReactionItem = (item) => item?.system?.actionType?.value === "reaction" || item?.system?.time?.value === "reaction";

/** Тайная проверка: подсказку видит только ГМ. */
export const isSecret = (message) => !!message?.blind || (message?.whisper?.length ?? 0) > 0 || ["blind", "gm"].includes(message?.flags?.pf2e?.context?.messageMode);

/** Кто бросал: токен сцены по speaker и его актёр. */
export function rollerOf(message) {
  const s = message?.speaker ?? {}, token = game.scenes?.get(s.scene)?.tokens?.get(s.token) ?? null;
  return { token, actor: token?.actor ?? message?.actor ?? game.actors?.get(s.actor) ?? null };
}

/* ---------- кандидаты ---------- */

let deps = null;   // ruleOfItem, slugOf, reactionAvailable, requirementOf, alliesIn — ленивые импорты (reactions -> macros -> builtin/index), нужны синхронно в preCreate
export const setDeps = (d) => { deps = d; };
export async function loadDeps() {
  const [r, c, a, rules] = await Promise.all([import("../reactions.mjs"), import("../cast.mjs"), import("../apply.mjs"), import("../rules.mjs")]);
  deps = { ruleOfItem: r.ruleOfItem, reactionAvailable: r.reactionAvailable, requirementOf: c.requirementOf, alliesIn: a.alliesIn, slugOf: rules.slugOf };
}

/**
 * Кто и чем может перебросить эту проверку. Синхронно (preCreateChatMessage клиента бросающего): видны только актёры, которых клиент знает.
 * -> [{ owner, ownerToken, item, d, roller, token }]
 */
export function candidates(message, env = deps) {
  const ctx = message?.flags?.pf2e?.context;
  if (!ctx || !env || noLuck(ctx, message.rolls?.[0]) || !ctx.outcome) return [];
  const { actor: roller, token } = rollerOf(message);
  if (!roller) return [];
  const options = optionsOf(message), out = [];
  for (const { actor: owner, token: ownerToken } of token ? reactorsOf(token) : [{ actor: roller, token: null }]) {
    if (!(owner.hitPoints?.value > 0)) continue;
    for (const { item, d } of itemsWith(owner, "onFailed", env.ruleOfItem, env.slugOf)) {
      if (!typeOk(d.check, ctx.type) || !degreeOk(d.degree, ctx.outcome) || (d.when && !testPredicate(d.when, options))) continue;
      const same = owner.uuid === roller.uuid, f = { same, familiar: false, ally: false };
      if (d.who !== "self" && !same && ownerToken) f.ally = env.alliesIn(owner, ownerToken, d.range, d.who === "any" ? "any" : "isAllyOf", d.withSelf).some((a) => a.uuid === roller.uuid);
      if (!eligible(d, f) || !requiresOk(d.requires, item, owner, env.requirementOf) || !resourceOk(item, owner)) continue;
      if (isReactionItem(item) && !env.reactionAvailable(owner)) continue;
      const limits = [d.who !== "self" ? d.range : null, itemRange(item, [])].filter((x) => x != null);
      if (!rangeOk(d.who === "self" ? "self" : "ally", { onScene: !!ownerToken, dist: ownerToken && token ? distanceOf(ownerToken, token) : NaN, limit: limits.length ? Math.min(...limits) : null })) continue;
      out.push({ owner, ownerToken, item, d, roller, token });
    }
  }
  return out;
}

const enabled = () => !!game.users?.activeGM && modeOf("reaction") !== "off";

/**
 * preCreateChatMessage на клиенте бросающего: проверка с кандидатом на переброс рождается удержанной. Сомнение — не трогаем.
 * Порядок: этот хук (builtin, при импорте macros.mjs) идёт раньше events.onPreCreate — Святилище потом перезаписывает hold на true и побеждает.
 * ponytail: атака по цели под Святилищем теряет подсказку переброса; нужен общий порядок хуков удержания, если понадобится.
 */
export function onPreCreate(message) {
  try {
    if (message.flags?.[MOD]?.gate?.hold || !enabled() || !candidates(message).length) return;
    message.updateSource({ flags: { [MOD]: { gate: { hold: REROLL } } } });
  } catch (e) { console.warn(`${MOD} | failed.onPreCreate`, e); }
}

/* ---------- подсказка (ГМ) ---------- */

const patch = (state) => ({ [`flags.${MOD}.failed.state`]: state });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const hintsOf = (id) => game.messages.contents.filter((m) => hintOf(m)?.message === id);
const live = (h) => h.state === "pending" || h.state === "rerolling";
const closeHint = (hint, state) => hint.update(patch(state));

const timers = new Map();
const disarm = (id) => { clearTimeout(timers.get(id)); timers.delete(id); };
const arm = (id, ms = HOLD_MS) => {
  disarm(id);
  // не активный ГМ/лидер ничего не делает: удержание выпустит sweep нового лидера (main.mjs, onLead)
  const t = setTimeout(() => { if (isActiveGM()) timeout(id).catch((e) => console.error(`${MOD} | failed.timeout`, e)); }, ms);
  t.unref?.();   // node-тесты: таймер не держит процесс
  timers.set(id, t);
};

/** Выпустить удержанную проверку (replay): подсказок, ждущих решения, не осталось. В очереди failed:<id>. */
async function settle(id) {
  if (hintsOf(id).some((m) => live(hintOf(m)))) return;
  disarm(id);
  const m = game.messages.get(id);
  if (m && isRerollHold(m)) await resolve(m, "release", { wait: false });   // wait:false — replay не ждём внутри очереди
}

/** Таймаут / ready / смена хода: нерешённые подсказки гаснут, проверка выпускается. all — и зависшие «перебрасывается» (после перезагрузки ГМа). */
export function timeout(id, all = false) {
  return queue(`failed:${id}`, async () => {
    for (const m of hintsOf(id)) if (hintOf(m).state === "pending" || (all && hintOf(m).state === "rerolling")) await closeHint(m, "expired");
    await settle(id);
  });
}

/** Подсказки по созданному удержанному сообщению (активный ГМ). Нет ни одной — сообщение выпускается. */
export async function onMessage(message) {
  if (!isActiveGM() || !isRerollHold(message)) return;
  try {
    if (!deps) await loadDeps();
    await queue(`failed:${message.id}`, async () => {
      if (hintsOf(message.id).length) return;   // повтор хука
      try {
        const secret = isSecret(message);
        for (const { owner, ownerToken, item, d, roller, token } of candidates(message)) {
          const whisper = recipients(owner, secret ? ["gm"] : d.notify);
          if (!whisper.length) continue;
          const turn = turnKey(combatOf(game.combats, roller));
          const h = { message: message.id, actor: owner.uuid, token: ownerToken?.uuid ?? null, roller: roller.uuid, rollerToken: token?.uuid ?? null, item: item.uuid, actorName: owner.name, itemName: item.name, targetName: roller.name, state: "pending", turn, keep: d.keep, reaction: isReactionItem(item) };
          const buttons = cardButton('data-af-failed="use"', esc(item.name)) + cardButton('data-af-failed="skip"', L("builtin.failed.skip"), "paf-ghost");
          await ChatMessage.create({
            whisper, speaker: ChatMessage.getSpeaker?.({ actor: owner }),
            content: card(L("builtin.failed.hint", { actor: esc(owner.name), target: esc(roller.name), item: esc(item.name) }), buttons, headOf("on-failed")),
            flags: { [MOD]: { builtin: "on-failed", failed: h } }
          });
        }
      } catch (e) { console.error(`${MOD} | failed.onMessage hints`, e); }
      // сбой создания подсказок: созданные ждут таймера, нет ни одной — выпуск; проверка не остаётся удержанной
      if (hintsOf(message.id).length) arm(message.id); else await settle(message.id);
    });
  } catch (e) {
    console.error(`${MOD} | failed.onMessage`, e);
    await timeout(message.id, true).catch(() => {});
  }
}

export const bind = (message, html) => bindHint(message, html, { hint: hintOf, attr: "data-af-failed", use: "useFailed", skip: "skipFailed" });

/** ГМ: «Без переброса». Когда решены все подсказки проверки — выпуск. */
export function skipFailed(hintId) {
  const h0 = hintOf(game.messages.get(hintId));
  return queue(`failed:${h0?.message}`, async () => {
    const hint = game.messages.get(hintId), h = hintOf(hint);
    if (!h) return { ok: true, skipped: true };
    if (h.state !== "pending") return { ok: true, skipped: true, state: h.state };
    await closeHint(hint, "skipped");
    await settle(h.message);
    return { ok: true, state: "skipped" };
  });
}

/* ---------- переброс ---------- */

/**
 * У автора проверки (сокет rerollCheck) или у ГМа: pf2e удаляет старое сообщение и создаёт новое. pf2e ничего не возвращает; false — до вызова
 * сообщения уже нет или оно не удержано (удалено, переброшено очком героя, выпущено): чужой переброс не наш. true — вызов сделан (успех подтверждает удаление, rerolledOn).
 */
export async function doReroll(messageId, keep) {
  const m = game.messages.get(messageId);
  if (!m || !isRerollHold(m) || !game.pf2e?.Check?.rerollFromMessage) return false;
  await game.pf2e.Check.rerollFromMessage(m, { keep: keep === "higher" ? "higher" : "new" });
  return true;
}
/** Сокет: только запрос ГМа. */
export async function rerollCheck(messageId, keep) {
  if (!game.users.get(this?.socketdata?.userId)?.isGM) return false;
  return doReroll(messageId, keep);
}

/** Переброс состоялся: doReroll его выполнил (true) И старое сообщение исчезло (pf2e удаляет его перед созданием нового; ждём доставки удаления до 3 с). */
async function rerolledOn(msg, keep) {
  const author = game.users.get(msg.author?.id ?? msg.author);
  const did = author && !author.isSelf && author.active && !author.isGM ? await socket.executeAsUser("rerollCheck", author.id, msg.id, keep) : await doReroll(msg.id, keep);
  if (!did) return false;
  for (let t = 0; t < 3000 && game.messages.get(msg.id); t += 100) await pause(100);
  return !game.messages.get(msg.id);
}

/**
 * ГМ: перебросить. Очередь — по проверке, затем по владельцу реакции (одна реакция на раунд). Цена (частота, реакция, сотворение) — только после успешного переброса;
 * остальные подсказки этой проверки закрываются (удача одна на бросок).
 */
export function useFailed(hintId) {
  const h0 = hintOf(game.messages.get(hintId));
  const others = [];
  const run = queue(`failed:${h0?.message}`, () => ownerQueue(h0?.actor, async () => {
    const hint = game.messages.get(hintId), h = hintOf(hint);
    if (!h) return { ok: false, reason: "no-hint" };
    if (h.state !== "pending") return { ok: true, skipped: true };
    const fail = (reason, key = "gone") => ({ ok: false, reason, error: L(`builtin.failed.${key}`) });
    const msg = game.messages.get(h.message), owner = await fromUuid(h.actor), item = await fromUuid(h.item), token = h.rollerToken ? await fromUuid(h.rollerToken) : null;
    if (!msg || !owner || !item) { await closeHint(hint, "expired"); return fail("gone"); }
    if (!isRerollHold(msg) || staleTurn(h.turn, turnKey(combatOf(game.combats, (await fromUuid(h.roller)) ?? owner)))) { await closeHint(hint, "expired"); await settle(h.message); return fail("expired", "expired"); }
    const { reactionAvailable, ruleOfItem, spendReaction } = await import("../reactions.mjs"), d = ruleOfItem(item)?.onFailed;
    if (!d) return fail("gone");
    if (h.reaction && !reactionAvailable(owner)) return { ok: false, reason: "spent", error: L("reactions.spent") };
    if (!resourceOk(item, owner)) return fail("spent", "noResource");
    await closeHint(hint, "rerolling");
    let ok = false;
    try { ok = await rerolledOn(msg, d.keep); } catch (e) { console.error(`${MOD} | failed.reroll`, e); }
    if (!ok) { await closeHint(hint, "pending"); arm(h.message, 5000); return fail("not-rerolled", "notRerolled"); }
    if (!(await useOnce(owner, item, token ?? owner.getActiveTokens?.(true, true)?.[0] ?? null))) console.warn(`${MOD} | failed: переброс сделан, но «${item.name}» не использована — цена не списана`);
    if (h.reaction) await spendReaction(owner, null);
    await closeHint(hint, "used");
    for (const m of hintsOf(h.message)) if (m.id !== hintId && hintOf(m).state === "pending") await closeHint(m, "closed");
    if (h.reaction) for (const m of game.messages.contents) if (hintOf(m)?.actor === h.actor && hintOf(m).reaction && hintOf(m).state === "pending") { others.push(hintOf(m).message); await closeHint(m, "skipped"); }
    disarm(h.message);
    return { ok: true };
  }));
  // закрытые чужие подсказки другой проверки могли быть последними — выпускаем её вне очередей (порядок failed -> failed не вкладываем)
  return run.then((r) => { for (const id of others) timeout(id).catch(() => {}); return r; });
}

/* ---------- срок и сопровождение ---------- */

/** updateCombat: ход/раунд сменился — подсказки прошлого хода гаснут, их проверки выпускаются. */
export async function onCombat(combat, changes) {
  if (!isActiveGM() || !("turn" in (changes ?? {}) || "round" in (changes ?? {}))) return;
  const now = turnKey(combat), ids = new Set();
  await expireWhere((h) => { const stale = typeof h.turn === "string" && h.turn.startsWith(`${combat.id}:`) && staleTurn(h.turn, now); if (stale) ids.add(h.message); return stale; }, { hintOf, close: closeHint });
  for (const id of ids) await queue(`failed:${id}`, () => settle(id));
}

/** deleteChatMessage (ГМ): удалено удержанное сообщение (не наш переброс) — его подсказки гаснут. */
export async function onDelete(message) {
  if (!isActiveGM() || !isRerollHold(message)) return;
  disarm(message.id);
  for (const m of hintsOf(message.id)) if (hintOf(m).state === "pending") await closeHint(m, "expired");
}

/** Лидер / ready: «перебрасывается» после перезагрузки/смены лидера всегда гаснет (очередь в памяти потеряна); удержания без ответа дольше HOLD_MS выпускаются, свежие получают таймер заново. */
export async function sweep() {
  if (!isActiveGM()) return;
  // переброс прерван перезагрузкой после удаления проверки pf2e: подсказка без сообщения не должна висеть «перебрасывается»
  for (const x of [...game.messages.contents]) if (hintOf(x)?.state === "rerolling" && !game.messages.get(hintOf(x).message)) await closeHint(x, "expired");
  for (const m of [...game.messages.contents]) {
    if (!isRerollHold(m)) continue;   // (deps не нужны: sweep не строит кандидатов)
    const stuck = hintsOf(m.id).filter((x) => hintOf(x).state === "rerolling");
    if (stuck.length) await queue(`failed:${m.id}`, async () => { for (const x of stuck) await closeHint(x, "expired"); });
    const age = Date.now() - (m.timestamp ?? 0);
    if (age >= HOLD_MS || !hintsOf(m.id).some((x) => hintOf(x).state === "pending")) await timeout(m.id, true);
    else arm(m.id, HOLD_MS - age);
  }
}

export function init() {
  if (!globalThis.Hooks) return;
  Hooks.on("preCreateChatMessage", onPreCreate);
  Hooks.on("createChatMessage", (m) => { onMessage(m).catch((e) => console.error(`${MOD} | builtin failed`, e)); });
  Hooks.on("deleteChatMessage", (m) => { onDelete(m).catch((e) => console.error(`${MOD} | builtin failed delete`, e)); });
  Hooks.on("updateCombat", (c, ch) => { onCombat(c, ch).catch((e) => console.error(`${MOD} | builtin failed combat`, e)); });
  Hooks.on("renderChatMessageHTML", bind);
  Hooks.once("ready", () => { loadDeps().catch((e) => console.error(`${MOD} | failed.loadDeps`, e)); });
}
