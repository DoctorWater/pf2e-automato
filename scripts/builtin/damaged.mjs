// Реакции «would take damage» (rule.onDamaged, docs/plan-on-damaged.md). Карточка урона -> шёпот владельцу реакции и ГМу с кнопками
// «<предмет>» и «Без реакции»; нанесение урона по цели ждёт решения (подписчик Actor#applyDamage, apply-hook.mjs) — любой путь
// (кнопка pf2e, toolbelt, auto basic-damage) не обгоняет реакцию.
// Состояние удержания и решение живут на документе токена цели (flags[MOD].damagedHold.<id подсказки>, пишет ГМ): его видит любой клиент,
// наносящий урон, а шёпот подсказки — только адресаты. Нажатие — у ГМа (callGM): предмет используется один раз, реакция тратится, решение
// записывается в подсказку и в токен; уменьшение / половину / сопротивление / перенос применяет подписчик у того, кто наносит урон.
import { L, MOD, queue, callGM, forcedDelete, isActiveGM } from "../util.mjs";
import { testPredicate } from "../predicate.mjs";
import { resolveFormula } from "../rules.mjs";
import { modeOf } from "../settings.mjs";
import { itemRange } from "../range.mjs";
import { esc, card, cardButton, headOf, combatOf, effectSource, recipients, distanceOf, ownerQueue, reactorsOf, itemsOf, useOnce, bindHint, expireWhere as expireHints } from "./lib.mjs";
import { subscribe, install } from "./apply-hook.mjs";
import { damageTargets, alreadyApplied } from "./shield-block.mjs";
import { LINK_OPTION, applyHp } from "./damage-link.mjs";

export const hintOf = (m) => m?.flags?.[MOD]?.damaged;
export const HOLD_MS = 30_000;       // как окно реакции: нет решения — «без реакции»
export const PENDING_MS = 120_000;   // подсказка без ответа дольше не держит урон (зависшая метка не блокирует нанесение навсегда)
const EFFECT_WAIT_MS = 3000;
const MARK = `${MOD}:damaged:`;

/* ---------- чистые функции ---------- */

const kebab = (s) => String(s).replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * Опции карточки урона для `when`: опции pf2e (self: -> origin:), тип урона из экземпляров броска (damage:type:<t>, в опциях pf2e их нет),
 * исход как у pf2e (check:outcome:critical-success), attack (урон Удара), item:type:spell и area-damage (заклинание с областью).
 */
export function damageOptions(message) {
  const ctx = message?.flags?.pf2e?.context, set = new Set((ctx?.options ?? []).map((o) => o.replace(/^self(?=:|$)/, "origin")));
  for (const i of message?.rolls?.[0]?.instances ?? []) if (i?.type) set.add(`damage:type:${i.type}`);
  if (ctx?.outcome) set.add(`check:outcome:${kebab(ctx.outcome)}`);
  if (ctx?.sourceType === "attack") set.add("attack");
  const item = message?.item;
  if (item?.type === "spell" || message?.flags?.pf2e?.origin?.type === "spell") set.add("item:type:spell");
  if (item?.area ?? item?.system?.area) set.add("area-damage");
  return set;
}

/** Типы урона карточки (без префикса). */
export const typesOf = (options) => [...options].filter((o) => o.startsWith("damage:type:")).map((o) => o.slice(12));

const WHEN_TYPES = /^damage:type:(.+)$/;
/** Типы урона, упомянутые в предикате when (любой вложенности). */
export function whenTypes(when) {
  const out = new Set();
  const walk = (x) => { if (typeof x === "string") { const m = WHEN_TYPES.exec(x); if (m) out.add(m[1]); } else if (x && typeof x === "object") Object.values(x).forEach(walk); };
  walk(when);
  return [...out];
}

const DAMAGE_TYPES = ["acid", "bleed", "bludgeoning", "cold", "electricity", "fire", "force", "mental", "piercing", "poison", "slashing", "sonic", "spirit", "vitality", "void"];
/** Словарь опций карточки урона, которые damageOptions/pf2e реально выдают (для проверки каталога: ни одно when не мёртвое). */
const OPTION_VOCAB = [new RegExp(`^damage:type:(${DAMAGE_TYPES.join("|")})$`), /^check:outcome:(critical-)?(success|failure)$/, /^attack$/, /^area-damage$/, /^item:type:spell$/];
export const knownOption = (t) => OPTION_VOCAB.some((re) => re.test(t));

/** Все строки предиката (any depth). */
export function tokensOf(pred) {
  const out = [];
  const walk = (x) => { if (typeof x === "string") out.push(x); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
  walk(pred);
  return out;
}

/** Чистая: кто может реагировать за цель. f: {same — владелец сам цель, familiar — цель его фамильяр, ally — цель союзник в дальности}. */
export const eligible = (d, f) => (d.who === "self" ? !!f.same : d.who === "familiar" ? !!f.familiar : f.same ? !!d.withSelf : !!f.ally);

/** Чистая: правило подходит этому урону: кандидат по `who` и условие `when` по опциям карточки. */
export const matches = (d, { options, ...f }) => eligible(d, f) && (!d.when || testPredicate(d.when, options));

/** Чистая: у предмета есть чем платить за использование (частота pf2e, фокус у фокус-заклинаний). Ячейки не проверяем: сотворение само откажет, подсказка вернёт ошибку. */
export function resourceOk(item, actor) {
  const f = item?.system?.frequency;
  if (f && f.max != null && !(f.value > 0)) return false;
  if (item?.isFocusSpell && !(actor?.system?.resources?.focus?.value > 0)) return false;
  return true;
}

/** Чистая: опции актёра, по которым проверяется требование вида `сущность:значение`. shield:raised -> self:shield:raised; stance:<slug> -> эффект стойки (у pf2e они — эффекты с self:effect:<slug>). */
export function requireOptions(req) {
  const m = /^stance:(.+)$/.exec(req);
  return m ? [`self:effect:${m[1]}`, `self:effect:spell-effect-${m[1]}`, `self:effect:stance-${m[1]}`] : [req, `self:${req}`];
}

/** Чистая по requirementOf: требование выполнено. Слово (invested/equipped/held/none) — как у активации; иначе опция владельца (см. requireOptions). */
export function requiresOk(req, item, actor, requirementOf) {
  if (!(req && req.includes(":"))) return !requirementOf(item, req);
  const have = new Set(actor?.getRollOptions?.() ?? []);
  return requireOptions(req).some((o) => have.has(o));
}

const ACTOR_OPTIONS = ["self:shield:raised"];   // опции владельца, которые pf2e реально выдаёт и каталог использует (pf2e.mjs: self:shield:raised)
/** Чистая: требование вида `сущность:значение` ссылается на реальную опцию. stances — slug'и заклинаний/черт со стойками (tools/out/items.json). */
export function knownRequire(req, stances) {
  const m = /^stance:(.+)$/.exec(req);
  return m ? stances.has(m[1]) : requireOptions(req).some((o) => ACTOR_OPTIONS.includes(o));
}

/** Чистая: дальность до защищаемого. who self — без дальности; иначе владелец должен быть на сцене. NaN (нет холста) не штрафуем, как farFrom. */
export const rangeOk = (who, { onScene, dist, limit }) => who === "self" || (!!onScene && !(limit != null && dist > limit));

/** Чистая: множитель по итогу спасброска не нулевой (у урона не по спасброску mult == undefined — всегда да). */
export const multGate = (mult) => mult === undefined || (mult != null && mult > 0);

/** Чистая: тип сопротивления "triggering" -> типы урона карточки, подходящие под when правила. */
export const expandResist = (list, card, when) => (list ?? []).flatMap(({ type, value }) => (type === "triggering"
  ? card.filter((t) => !when.length || when.includes(t)).map((t) => ({ type: t, value }))
  : [{ type, value }]));

const PHYSICAL = ["bludgeoning", "piercing", "slashing"];
/**
 * Чистая: сопротивление от реакции действует на нанесение один раз — наибольшее из подходящих к типам карточки
 * (Deflecting Wave: «apply the highest resistance, but apply it only once»; «resistance against the triggering damage» — тоже одно).
 * pf2e применил бы сопротивление к каждому типу отдельно. Ничего не подходит — список как есть (на урон не влияет).
 * ponytail: при равных значениях берётся первый тип карточки (обычно основной), без учёта долей урона по типам.
 */
export function onceResist(list, card) {
  const fits = list.filter(({ type }) => card.includes(type) || (type === "physical" && card.some((t) => PHYSICAL.includes(t))));
  return fits.length ? [fits.reduce((a, b) => (b.value > a.value ? b : a))] : list;
}

/** Чистая: решение по подсказке — формулы правила считаются на момент нажатия. ctx: {rank, level, actorLevel}. fx — эффекты ответа (для triggerOnly). types: {card, when} — для сопротивления "triggering". */
export function decisionOf(d, ctx, fx = [], types = { card: [], when: [] }) {
  const n = (f) => { const r = f == null ? null : resolveFormula(`(${f})`, ctx); return r == null ? null : Number(r); };
  const res = d.damage?.resist ? onceResist(expandResist(d.damage.resist.map((x) => ({ type: x.type, value: n(x.value) })), types.card, types.when).filter((x) => x.value > 0), types.card) : null;
  return {
    reduce: n(d.damage?.reduce), halve: !!d.damage?.halve, redirect: d.damage?.redirect ? d.damage.part ?? "all" : null,
    resist: res, triggerOnly: !!d.triggerOnly, hp: n(d.cost?.hp), fx
  };
}

/** Чистая: как решение меняет урон total: cut — сколько снимается с цели, redirect — сколько из этого получает владелец реакции. Половина — по pf2e: цель получает floor(total/2). */
export function changeOf(dec, total) {
  const half = total - Math.floor(total / 2);
  const cut = dec?.reduce != null ? Math.min(total, Math.max(0, dec.reduce)) : dec?.halve ? half : dec?.redirect === "all" ? total : dec?.redirect === "half" ? half : 0;
  return { cut, redirect: dec?.redirect ? cut : 0 };
}

/** Чистая: несколько решений по очереди (каждое считает остаток урона) -> {cut, rows:[{id, cut, redirect}]}. */
export function planOf(list, total) {
  let rest = total;
  const rows = [];
  for (const { id, dec } of list) {
    const c = changeOf(dec, rest);
    rest -= c.cut;
    rows.push({ id, cut: c.cut, redirect: c.redirect });
  }
  return { cut: total - rest, rows };
}

/** Чистая: временный эффект с Resistance RE на одно нанесение (клон актёра). id — стабильный _id (id подсказки). */
export function resistEffect(id, list, { name, img, owner, target }) {
  const src = effectSource({
    name, img: img ?? "icons/svg/shield.svg", duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
    rules: list.map(({ type, value }) => ({ key: "Resistance", type, value })), origin: { actor: owner }, target: { actor: target }
  });
  src._id = id;
  src.system.slug = "af-damaged-resist";
  return src;
}

/** Чистая: ключ хода боя (null — не в бою). */
export const turnKey = (combat) => (combat?.started ? `${combat.id}:${combat.round}:${combat.turn}` : null);
/** Чистая: подсказка с ходом saved устарела в ходе now (вне боя не устаревает по ходу). */
export const staleTurn = (saved, now) => saved != null && saved !== now;

export const holdOf = (tokenDoc) => tokenDoc?.flags?.[MOD]?.damagedHold ?? {};
export const markOf = (id) => `${MARK}${id}`;
/** Чистая: id подсказок из опций сообщения damage-taken. */
export const marksIn = (options) => (options ?? []).filter((o) => typeof o === "string" && o.startsWith(MARK)).map((o) => o.slice(MARK.length));

/**
 * Чистая: записи удержания на токене, относящиеся к этому нанесению. src — карточка урона, если источник известен (клик pf2e, basic-damage):
 * только её записи; источник неизвестен — только записи этого хода. consumed — уже применённые этим клиентом (id:rev). Зависшие pending (until) не держат.
 */
export function holdsFor(hold, src, now, consumed = new Set(), at = Date.now()) {
  return Object.entries(hold ?? {})
    .filter(([id, e]) => (src ? e.message === src : !staleTurn(e.turn, now)) && !consumed.has(`${id}:${e.rev ?? 0}`) && !(e.state === "pending" && e.until < at))
    .map(([id, e]) => ({ id, ...e }));
}

/** Чистая: урон меньше на cut: число или бросок pf2e (alter(1, -cut), как у damage-link). */
export const cutDamage = (d, cut) => (typeof d === "number" ? d - cut : d.alter(1, -cut));

/**
 * Ждёт, пока ни одна из записей не останется pending (или ms). -> id, всё ещё pending (таймаут).
 * get(id) -> запись удержания (нет записи — решено); on(fn) подписывает fn на изменения и возвращает отписку.
 */
export function waitDecided(ids, ms, get, on) {
  return new Promise((resolve) => {
    let off = null, timer = null;
    const left = () => ids.filter((id) => get(id)?.state === "pending");
    const done = () => { clearTimeout(timer); off?.(); resolve(left()); };
    off = on(() => { if (!left().length) done(); });
    timer = setTimeout(done, ms);
    if (!left().length) done();
  });
}
const hooksOn = (fn) => {
  Hooks.on("updateToken", fn);
  Hooks.on("deleteToken", fn);
  return () => { Hooks.off("updateToken", fn); Hooks.off("deleteToken", fn); };
};

/** Чистая: свежий клон актёра с эфемерными эффектами старого клона (damage-received автора, basic-damage ephemeral) и новыми. null — клонировать нечем. */
export function refreshed(clone, real, extra = []) {
  if (!real || typeof real.getContextualClone !== "function") return null;
  const own = real._source?.flags?.pf2e?.rollOptions?.all ?? {}, ownItems = new Set((real._source?.items ?? []).map((i) => i._id));
  const eph = [...(clone?.items ?? [])].filter((i) => i.type === "effect" && !ownItems.has(i.id)).map((i) => i.toObject());
  const options = Object.keys(clone?.flags?.pf2e?.rollOptions?.all ?? {}).filter((k) => !(k in own));   // контекстные опции — те, что не лежат в источнике настоящего актёра
  return real.getContextualClone(options, [...eph, ...extra]);
}

/* ---------- состояние на токене (ГМ) ---------- */

const holdPath = (id) => `flags.${MOD}.damagedHold.${id}`;
const setHold = (token, id, v) => token?.update(v ? { [holdPath(id)]: v } : forcedDelete(holdPath(id)));
const patch = (state, extra = {}) => ({ [`flags.${MOD}.damaged.state`]: state, ...extra });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const holdEntry = (h, state) => ({ message: h.message, state, turn: h.turn ?? null, rev: h.rev ?? 0, name: h.itemName, until: Date.now() + PENDING_MS, ...(state === "used" && { decision: h.decision }) });

/** Подсказка решена не «использована»: состояние, снятие удержания с токена. */
async function closeHint(hint, state) {
  const h = hintOf(hint);
  await hint.update(patch(state));
  await setHold(await fromUuid(h.token), hint.id, null);
}

/* ---------- подсказка ---------- */

/** Подсказки по карточке урона (активный ГМ). Зовёт basic-damage.onMessage после связи с карточкой испытания и до auto-нанесения; basic-damage.onResult — когда пришёл итог спасброска. */
export async function onMessage(message) {
  const ctx = message?.flags?.pf2e?.context, roll = message?.rolls?.[0];
  if (ctx?.type !== "damage-roll" || !(roll?.total > 0) || !roll.kinds?.has?.("damage")) return;
  const { isHeld } = await import("../hold.mjs");
  if (isHeld(message)) return;
  const { linkOf, multOf } = await import("./basic-damage.mjs"), { challengeTargets } = await import("../saves.mjs");
  const authorTargets = (game.users.get(message.author?.id ?? message.author)?.targets ?? []).map((t) => t.document.uuid);
  const uuids = new Set(damageTargets(message, authorTargets)), link = linkOf(message), mult = new Map();
  if (link) {   // у урона по спасброску цели — на карточке испытания, подсказка — после итога и только при множителе > 0
    const cardMsg = game.messages.get(link.card), results = cardMsg?.flags?.[MOD]?.use?.state?.challenge?.results ?? {};
    for (const t of await challengeTargets(cardMsg)) if (t.token?.uuid) { uuids.add(t.token.uuid); mult.set(t.token.uuid, results[t.key] ? multOf(results[t.key].degree, link.table) : null); }
  }
  const { reactionAvailable } = await import("../reactions.mjs"), { requirementOf } = await import("../cast.mjs"), { alliesIn } = await import("../apply.mjs");
  const options = damageOptions(message);
  for (const uuid of uuids) {
    const token = await fromUuid(uuid), target = token?.actor;
    if (!target || !(target.hitPoints?.value > 0) || alreadyApplied(message, token.id) || !multGate(mult.get(uuid))) continue;
    const turn = turnKey(combatOf(game.combats, target));
    for (const { actor: owner, token: ownerToken } of reactorsOf(token)) {
      if (!(owner.hitPoints?.value > 0) || !reactionAvailable(owner)) continue;
      for (const { item, d } of await itemsOf(owner, "onDamaged")) {
        const same = owner === target;
        const f = { same, familiar: target.type === "familiar" && target.system?.master?.id === owner.id, ally: false, options };
        if (d.who === "ally" && !same && ownerToken) f.ally = alliesIn(owner, ownerToken, d.range, "isAllyOf", d.withSelf).some((a) => a === target);
        if (!matches(d, f) || !requiresOk(d.requires, item, owner, requirementOf) || !resourceOk(item, owner)) continue;
        const limits = [d.who === "ally" ? d.range : null, itemRange(item, [])].filter((x) => x != null);
        if (!rangeOk(d.who, { onScene: !!ownerToken, dist: ownerToken ? distanceOf(ownerToken, token) : NaN, limit: limits.length ? Math.min(...limits) : null })) continue;
        if (game.messages.contents.some((m) => hintOf(m)?.message === message.id && hintOf(m).token === token.uuid && hintOf(m).item === item.uuid)) continue;
        const whisper = recipients(owner, d.notify);
        if (!whisper.length) continue;
        const h = { message: message.id, token: token.uuid, actor: owner.uuid, item: item.uuid, actorName: owner.name, itemName: item.name, targetName: token.name, state: "pending", turn, rev: 0 };
        const buttons = cardButton('data-af-damaged="use"', esc(item.name)) + cardButton('data-af-damaged="skip"', L("builtin.damaged.skip"), "paf-ghost");
        const hint = await ChatMessage.create({
          whisper, speaker: ChatMessage.getSpeaker?.({ actor: owner }),
          content: card(L("builtin.damaged.hint", { actor: esc(owner.name), target: esc(token.name), item: esc(item.name) }), buttons, headOf("on-damaged")),
          flags: { [MOD]: { builtin: "on-damaged", damaged: h } }
        });
        if (hint) await setHold(token, hint.id, holdEntry(h, "pending"));
      }
    }
  }
}

/** saves.afterRecord / basic-damage.onResult: пришёл итог спасброска у карточки со связанным уроном — подсказки по новым целям. */
export async function onResult(cardId) {
  const link = game.messages.get(cardId)?.flags?.[MOD]?.use?.state?.basicDamage, dmg = link?.msg && game.messages.get(link.msg);
  if (dmg) await onMessage(dmg);
}

/** renderChatMessageHTML: кнопки подсказки. */
export const bind = (message, html) => bindHint(message, html, { hint: hintOf, attr: "data-af-damaged", use: "useDamaged", skip: "skipDamaged" });

/* ---------- срок подсказки (ГМ) ---------- */

const expireWhere = (test) => expireHints(test, { hintOf, close: closeHint });

/** Урон карточки по цели нанесён (в т. ч. ×0 у успеха спасброска): подсказки по этой паре гаснут. */
export const expireFor = (messageId, tokenUuid) => expireWhere((h) => h.message === messageId && h.token === tokenUuid);

/** updateCombat: ход/раунд сменился — подсказки прошлого хода гаснут, неиспользованные решения снимаются с токенов. */
export async function onCombat(combat, changes) {
  if (!isActiveGM() || !("turn" in (changes ?? {}) || "round" in (changes ?? {}))) return;
  const now = turnKey(combat), mine = (h) => typeof h.turn === "string" && h.turn.startsWith(`${combat.id}:`) && staleTurn(h.turn, now);
  await expireWhere(mine);
  for (const m of [...game.messages.contents]) {
    const h = hintOf(m);
    if (h?.state === "used" && !h.done && mine(h)) await setHold(await fromUuid(h.token), m.id, null);
  }
}

/* ---------- нажатие (ГМ) ---------- */

/** ГМ: «Без реакции» (или таймаут удержания: timeout = true, пока не прошло HOLD_MS — отказ). Решённая подсказка отдаёт состояние: поздний ответ «использована» не теряется. */
export function skipDamaged(hintId, timeout = false) {
  const h0 = hintOf(game.messages.get(hintId));
  return ownerQueue(h0?.actor, async () => {
    const hint = game.messages.get(hintId), h = hintOf(hint);
    if (!h) return { ok: true, skipped: true };
    if (h.state !== "pending") return { ok: true, skipped: true, state: h.state, hold: h.state === "used" && !h.done ? holdEntry(h, "used") : null };
    if (timeout && Date.now() - (hint.timestamp ?? 0) < HOLD_MS - 1000) return { ok: false, reason: "early" };
    await closeHint(hint, "skipped");
    return { ok: true, state: "skipped" };
  });
}

/** ГМ: использовать реакцию. Очередь — по владельцу реакции (две подсказки одного владельца не тратят реакцию дважды); нанесение урона в очереди не стоит. */
export function useDamaged(hintId, deps = null) {   // deps — подмена apply.mjs {hasEffect, applyEffect} в тестах
  const h0 = hintOf(game.messages.get(hintId));
  return ownerQueue(h0?.actor, async () => {
    const hint = game.messages.get(hintId), h = hintOf(hint);
    if (!h) return { ok: false, reason: "no-hint" };
    if (h.state !== "pending") return { ok: true, skipped: true };
    const fail = (reason, key = "gone") => ({ ok: false, reason, error: L(`builtin.damaged.${key}`) });
    const dmg = game.messages.get(h.message), token = await fromUuid(h.token), owner = await fromUuid(h.actor), item = await fromUuid(h.item);
    if (!dmg || !token?.actor || !owner || !item) return fail("gone");
    if (alreadyApplied(dmg, token.id) || staleTurn(h.turn, turnKey(combatOf(game.combats, token.actor)))) { await closeHint(hint, "expired"); return fail("expired", "expired"); }
    const { reactionAvailable, ruleOfItem, spendReaction } = await import("../reactions.mjs");
    const rule = ruleOfItem(item), d = rule?.onDamaged;
    if (!d) return fail("gone");
    if (!reactionAvailable(owner)) return { ok: false, reason: "spent", error: L("reactions.spent") };
    if (!(await useOnce(owner, item, token))) return fail("not-used", "notUsed");
    // эффекты ответа ложатся на защищаемого: у self — шаги to:self, у familiar/ally — to:target
    const steps = (rule.onUse?.apply ?? []).filter((s) => s.effect?.uuid && s.to === (d.who === "self" ? "self" : "target")), fx = steps.map((s) => s.effect.uuid);
    await ensureEffects(owner, token, item, hintId, steps, deps);
    await spendReaction(owner, null);   // карточка предмета уже создана использованием; второй toMessage трекеру не нужен
    const rank = item.rank ?? item.system?.level?.value ?? 1;
    const dec = decisionOf(d, { rank, level: item.system?.level?.value ?? rank, actorLevel: owner.level ?? rank }, d.triggerOnly ? fx : [], { card: typesOf(damageOptions(dmg)), when: whenTypes(d.when) });
    await hint.update(patch("used", { [`flags.${MOD}.damaged.decision`]: dec }));
    await setHold(token, hintId, holdEntry({ ...h, decision: dec }, "used"));
    // реакция одна на раунд: остальные подсказки этого владельца закрываются
    for (const m of game.messages.contents) if (m.id !== hintId && hintOf(m)?.actor === h.actor && hintOf(m).state === "pending") await closeHint(m, "skipped");
    return { ok: true };
  });
}

/** Эффекты ответа на защищаемом: в auto их кладёт use.mjs по createChatMessage (ждём), иначе (button/off) или если не легли — теми же шагами напрямую, без дубля (hasEffect). */
async function ensureEffects(owner, token, item, hintId, steps, deps) {
  if (!steps.length) return;
  const target = steps[0].to === "self" ? owner : token.actor, { hasEffect, applyEffect } = deps ?? await import("../apply.mjs");
  const missing = () => steps.filter((s) => !hasEffect(target, s.effect.uuid, null));
  if (modeOf("apply") === "auto") for (let t = 0; missing().length && t < EFFECT_WAIT_MS; t += 100) await pause(100);
  for (const s of missing()) {
    await applyEffect(target, s.effect, { key: `damaged:${hintId}:${s.effect.uuid}`, source: "builtin" }, { originActor: owner, originToken: owner.getActiveTokens?.(true, true)?.[0], originItem: item, target: token });
  }
}

/**
 * ГМ, после применения урона: перенос урона владельцу реакции, цена в ОЗ, снятие эффектов ответа (triggerOnly). Один раз на подсказку.
 * Сумму переноса считает ГМ по решению: client присылает только итог нанесённого урона (не больше броска карточки) и список решений, применённых вместе.
 */
export function settle(hintId, total = 0, ids = null) {
  return queue(`damaged-after:${hintId}`, async () => {
    const hint = game.messages.get(hintId), h = hintOf(hint), dec = h?.decision;
    if (!h || h.done || !dec) return { ok: true, skipped: true };
    const cap = game.messages.get(h.message)?.rolls?.[0]?.total, t = Math.max(0, Math.min(Number(total) || 0, cap ?? Infinity));
    const list = (ids?.includes(hintId) ? ids : [hintId]).map((id) => [id, hintOf(game.messages.get(id))]).filter(([, x]) => x?.decision && x.token === h.token).map(([id, x]) => ({ id, dec: x.decision }));
    const redirect = planOf(list, t).rows.find((r) => r.id === hintId)?.redirect ?? 0;
    const hp = redirect + (dec.hp > 0 ? dec.hp : 0);
    await hint.update({ [`flags.${MOD}.damaged.done`]: true, [`flags.${MOD}.damaged.applied`]: hp });
    const owner = await fromUuid(h.actor), token = await fromUuid(h.token);
    await setHold(token, hintId, null);
    if (owner && hp > 0) await applyHp(owner, hp);
    if (dec.triggerOnly && token?.actor) {
      const del = token.actor.itemTypes.effect.filter((e) => dec.fx?.includes(e._stats?.compendiumSource)).map((e) => e.id);
      if (del.length) await token.actor.deleteEmbeddedDocuments("Item", del);
    }
    return { ok: true };
  });
}

/** ГМ: урон откатан кнопкой pf2e — перенос и цена в ОЗ возвращаются, решение снова не израсходовано (повторное нанесение применит его). */
export function unsettle(hintId) {
  return queue(`damaged-after:${hintId}`, async () => {
    const hint = game.messages.get(hintId), h = hintOf(hint);
    if (!h?.done || !h.decision) return { ok: true, skipped: true };
    const owner = await fromUuid(h.actor), token = await fromUuid(h.token), rev = (h.rev ?? 0) + 1;
    if (owner && h.applied > 0) await applyHp(owner, -h.applied);
    await hint.update({ [`flags.${MOD}.damaged.done`]: false, [`flags.${MOD}.damaged.applied`]: 0, [`flags.${MOD}.damaged.rev`]: rev });
    await setHold(token, hintId, holdEntry({ ...h, rev }, "used"));
    return { ok: true };
  });
}

/** updateChatMessage (активный ГМ): откат damage-taken, нанесённого с нашей отметкой, возвращает перенос и цену. */
export async function onUpdate(message, changes) {
  const reverted = globalThis.foundry?.utils?.getProperty?.(changes ?? {}, "flags.pf2e.appliedDamage.isReverted") ?? changes?.flags?.pf2e?.appliedDamage?.isReverted;
  if (!isActiveGM() || !reverted) return;
  for (const id of marksIn(message.flags?.pf2e?.context?.options)) await unsettle(id);
}

/* ---------- удержание и применение (подписчик applyDamage) ---------- */

const consumed = new Set();   // `${id}:${rev}`: решения, которые этот клиент уже применил к урону

export async function onApply(actor, opts, ctx) {
  const doc = opts?.token?.document ?? opts?.token;
  if (!doc?.uuid || opts.rollOptions?.has?.(LINK_OPTION) || !globalThis.game?.messages) return;
  const total = typeof opts.damage === "number" ? opts.damage : opts.damage?.total;
  if (!(total > 0)) return;
  const { parseMarker } = await import("./basic-damage.mjs");
  const src = parseMarker(opts.rollOptions)?.dmgId ?? ctx?.click?.id ?? null;   // карточка урона, если источник известен
  const now = turnKey(combatOf(game.combats, doc.actor ?? actor));
  const pick = () => holdsFor(holdOf(doc), src, now, consumed);
  const pending = pick().filter((e) => e.state === "pending"), late = [];
  if (pending.length) {
    ui.notifications.info(L("builtin.damaged.waiting"));
    const open = await waitDecided(pending.map((e) => e.id), HOLD_MS, (id) => holdOf(doc)[id], hooksOn);
    // таймаут: ответ ГМа решает, а не наше предположение — решение «использована» могло прийти в последний момент
    for (const id of open) {
      const r = await callGM("skipDamaged", id, true).catch((e) => { console.error(`${MOD} | skipDamaged`, e); return null; });
      if (r?.result?.hold) late.push({ id, ...r.result.hold });
    }
  }
  const used = new Map();
  for (const e of [...pick().filter((x) => x.state === "used"), ...late.filter((x) => !consumed.has(`${x.id}:${x.rev ?? 0}`))]) if (e.decision) used.set(e.id, e);
  if (!used.size) return;
  const list = [...used.values()], ids = list.map((e) => e.id);
  list.forEach((e) => consumed.add(`${e.id}:${e.rev ?? 0}`));
  const plan = planOf(list.map((e) => ({ id: e.id, dec: e.decision })), total);
  const target = doc.actor ?? actor;
  const extra = list.filter((e) => e.decision.resist?.length).map((e) => resistEffect(e.id, e.decision.resist, { name: e.name, owner: target.uuid, target: target.uuid }));
  return {
    opts: { ...opts, ...(plan.cut && { damage: cutDamage(opts.damage, plan.cut) }), rollOptions: new Set([...(opts.rollOptions ?? []), ...ids.map(markOf)]) },   // отметка — чтобы откат damage-taken нашёл подсказку (onUpdate)
    actor: refreshed(actor, doc.actor, extra) ?? undefined,
    after() { for (const id of ids) callGM("damagedAfter", id, total, ids).catch((e) => console.error(`${MOD} | damagedAfter`, e)); }
  };
}

export function wrapApplyDamage() {
  subscribe(onApply, { first: true });
  install();
}
