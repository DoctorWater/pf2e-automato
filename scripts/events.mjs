// 0.5g3: onEvent — правило на предмете актёра (черта, эффект, снаряжение) срабатывает по событию: бросок, урон, ход, эффект, сотворение. plan.md §1.1b.
// Исполняет только активный ГМ. Шаги идут через apply.applyOps на сообщении-двойнике (в чат не пишется): снимок use и запись ops живут в нём,
// а в самом сообщении события — только свой флаг `events` (журнал для переброса). Испытание (challenge) получает свою карточку со снимком use — дальше всё как у onUse.
import { MOD, L, DEGREES, flagPath, guardActiveGM, queue, debug, sluggify } from "./util.mjs";
import { modeOf, rev } from "./settings.mjs";
import * as compat from "./compat.mjs";
import * as rules from "./rules.mjs";
import * as apply from "./apply.mjs";
import { testPredicate } from "./predicate.mjs";
import { useKindOf, buildSnapshot } from "./use.mjs";
import { card } from "./card.mjs";
import { messageTargets, esc, combatOf } from "./builtin/lib.mjs";
import { parseMarker, challengeApplies } from "./saves.mjs";
import { isImmune } from "./checks.mjs";
import { repeatChallenge } from "./repeat.mjs";
import { nearRadius, insideAura, pathRects, rectOf, auraOf } from "./aura.mjs";
import { armedAt } from "./coat.mjs";

/* ---------- чистые функции ---------- */

// context.type сообщения pf2e -> событие
const MSG_EVENT = { "attack-roll": "attack-roll", "spell-attack-roll": "attack-roll", "skill-check": "skill-check", "perception-check": "skill-check", "saving-throw": "saving-throw", "damage-roll": "damage-roll", "damage-taken": "damage-taken" };

/** Сообщение pf2e -> событие | null. Сотворение — карточка заклинания (useKindOf: origin со `cast-a-spell`). */
export function eventOfMessage(message) {
  const pf = message?.flags?.pf2e;
  const on = MSG_EVENT[pf?.context?.type];
  if (on) return on;
  return pf?.origin?.type === "spell" && useKindOf(message) === "use" ? "spell-cast" : null;
}

/* afterUse (strike-gate): запись срабатывает только на бросок владельца сразу после карточки этого предмета. Состояний нет — лента чата:
 * идём назад по сообщениям этого актёра; карточка того же предмета — связь есть; бросок того же вида или карточка другого предмета — обрыв
 * (одна карточка = один бросок: второй Удар, как и Удар после промаха, уже не «по этому использованию»). */
export const AFTER_USE_MS = 10 * 60000;   // вне боя / нет начала хода: карточка не старше; ponytail: без боя «залежавшуюся» карточку отличает только время
const actorUuidOf = (m) => m?.flags?.pf2e?.origin?.actor ?? m?.actor?.uuid ?? null;   // не speaker.actor: он общий у несвязанных копий NPC
const cardSlug = (m) => rules.slugOf(m?.flags?.pf2e?.origin ?? null, null);
/** Slug предмета-носителя: так же схлопываются action и feat одного slug в eventItems. */
export const carrierSlug = (item) => rules.slugOf(null, item) || sluggify(item?.name ?? "") || null;

/**
 * Карточка предмета, к которой относится бросок message, или null. before — сообщения чата до него (по возрастанию),
 * stopId — последнее сообщение ленты на начало текущего хода актёра в бою: карточка не раньше него (позиция, не часы:
 * game.time.serverTime в v14 — не эпоха, а message.timestamp ставит сервер); AFTER_USE_MS действует всегда.
 */
export function strikeCardFor(before, message, item, { stopId = null, slugOf = cardSlug } = {}) {
  const who = actorUuidOf(message), on = eventOfMessage(message), t = message.timestamp ?? 0;
  if (!(item?.uuid || item?.slug) || !who || !on) return null;
  for (const m of [...before].slice(-50).reverse()) {
    if (stopId && m.id === stopId) return null;   // граница хода — любое сообщение, не только этого актёра
    if (m.id === message.id || actorUuidOf(m) !== who) continue;
    if (t - (m.timestamp ?? 0) > AFTER_USE_MS) return null;
    if (eventOfMessage(m) === on) return null;
    // предмет — по uuid (точно), slug — запасной путь: копии и переводы
    if (useKindOf(m) === "use") return (item.uuid && m.flags?.pf2e?.origin?.uuid === item.uuid) || (item.slug && slugOf(m) === item.slug) ? m : null;
  }
  return null;
}

const turnStarts = new Map();   // actor uuid -> id последнего сообщения ленты на начало его хода (в памяти ГМа, из pf2e.startTurn); не состояние мира
const noteTurn = (combatant) => { const u = combatant?.actor?.uuid; if (u) turnStarts.set(u, game.messages.contents.at(-1)?.id ?? null); };

/** Бросок message после карточки найденного носителя? Только у активного ГМа (лента — game.messages). */
function linkedCard(message, item) {
  if (!message) return null;
  const all = game.messages.contents, i = all.findIndex((m) => m.id === message.id);
  const actor = message.actor ?? null;
  const inCombat = actor && combatOf(game.combats, actor)?.started;
  return strikeCardFor(i < 0 ? all : all.slice(0, i), message, { uuid: item.uuid, slug: carrierSlug(item) }, { stopId: inCombat ? turnStarts.get(actorUuidOf(message)) ?? null : null });
}

/** Ключ идемпотентности: сообщение/событие, предмет-носитель, номер записи onEvent. */
export const entryKey = (evId, itemUuid, i) => `${evId}:${itemUuid}:${i}`;

const pass = (when, opts) => (globalThis.game?.pf2e?.Predicate?.test ? game.pf2e.Predicate.test(when, opts) : testPredicate(when, opts));

/** Записи правила под это событие и сторону, у которых выполнено условие when. -> [{i, entry}] */
export function matchEntries(rule, on, side, opts) {
  return (rule?.onEvent ?? []).map((entry, i) => ({ i, entry })).filter(({ entry }) => entry.on === on && entry.side === side && (!entry.when || pass(entry.when, opts)));
}

/** Шаги записи: «на владельца» (self, party, allies) и «на другого участника» (target). */
export const splitSteps = (entry) => ({
  mine: (entry.apply ?? []).filter((s) => s.to !== "target"),
  theirs: (entry.apply ?? []).filter((s) => s.to === "target")
});

/**
 * Правило карточки испытания: другой участник события бросает challenge записи против СЛ владельца; шаги по степеням — как у onUse
 * («self» — владелец, «target» — тот, кто бросает).
 */
export const hostRule = (entry, label) => ({
  v: 1, ...(label && { label }), yield: null,
  onUse: { targets: "selected", excludeSelf: null, zone: null, challenge: entry.challenge, check: null, apply: [] },
  onAttacked: null, macros: [], onTurn: null
});

/** Опции для `when` у урона: damage-taken, потеря ОЗ, щит, лечение, откат (pf2e: flags.pf2e.appliedDamage). */
export function damageOptions(applied) {
  const out = ["damage-taken"];
  if (!applied) return out;
  if (applied.isHealing) out.push("damage-taken:healing");
  if (applied.isReverted) out.push("damage-taken:reverted");
  if ((applied.updates ?? []).some((u) => u.path === "system.attributes.hp.value" && u.value > 0 && !applied.isHealing)) out.push("damage-taken:hp");
  if ((applied.updates ?? []).some((u) => u.path === "system.attributes.hp.temp" && u.value > 0 && !applied.isHealing)) out.push("damage-taken:temp");   // урон ушёл во временные ОЗ
  if (applied.shield?.damage > 0) out.push("damage-taken:shield");
  return out;
}

/**
 * Опции `item:attack-effect:<slug>` для Удара: pf2e связывает пассивные способности NPC с Ударом через его attackEffects (tongue-grab у «Языка»).
 * Правило способности («при попадании цель схвачена») ловит именно такие Удары, а не любые Удары существа.
 */
/** Предмет броска выбран эффектом бросавшего (ChoiceSet с flag): `item:chosen:<slug эффекта>:<flag>` (Celestial Armaments: оружие из выбора эффекта). */
export const chosenOptions = (actor, item) => !item?.id ? [] : (actor?.itemTypes?.effect ?? []).flatMap((e) => Object.entries(e.flags?.pf2e?.rulesSelections ?? {}).filter(([, v]) => v === item.id).flatMap(([k]) => [...new Set([e.slug, e.slug.replace(/^(?:spell-)?effect-/, "")])].map((sl) => `item:chosen:${sl}:${k}`)));
/** uuid предмета компендия среди выбранных значений ChoiceSet эффекта (rulesSelections) или null. */
export const chosenSourceUuid = (effect) => Object.values(effect?.flags?.pf2e?.rulesSelections ?? {}).find((v) => typeof v === "string" && v.startsWith("Compendium.")) ?? null;
export const attackEffectOptions = (strike) => (strike?.system?.attackEffects?.value ?? []).filter((e) => typeof e === "string" && e).map((e) => `item:attack-effect:${e}`);

/** Опции эффекта для `when` у effect-created/-deleted: `effect:<slug>`, `item:slug:<slug>`, `effect:origin` (у эффекта есть автор). */
export function effectOptions(item) {
  const slug = item?.slug ?? item?.system?.slug;
  return [...(slug ? [`effect:${slug}`, `effect:slug:${slug}`, `item:slug:${slug}`] : []), ...(item?.system?.context?.origin?.actor ? ["effect:origin"] : [])];
}

/** Эффект создан нашим же шагом onEvent: цепочку событий не продолжаем (иначе правило, создающее эффект по эффекту, зациклится). */
export const isOwnEffect = (item) => String(item?.flags?.[MOD]?.meta?.message ?? "").startsWith("ev:");

const ruleCache = new Map();   // uuid -> { mt, rv, rule }; ponytail: растёт с числом предметов, сбрасывается сменой каталога/предмета
/**
 * Носитель правила: тот же порядок, что у resolveRule (флаг -> мировой -> встроенный, bySource/bySlug/byName), поэтому мировое правило перекрывает встроенное целиком.
 * Физический предмет — не брошенный и не в рюкзаке. Разбор разметки при этом не нужен, но дёшев после первого раза (кэш по предмету и версии каталогов).
 */
export function eventRuleOf(item) {
  const eq = item?.system?.equipped?.carryType;
  if (eq === "dropped" || eq === "stowed") return null;
  if (item?.flags?.[MOD]?.coat && item.isExpired) return null;   // носитель яда с истёкшим сроком (Envenom) при выключенном автоистечении pf2e не работает
  const mt = item?._stats?.modifiedTime ?? 0, rv = rev.n, hit = ruleCache.get(item.uuid);
  if (hit && hit.mt === mt && hit.rv === rv && !item.flags?.[MOD]?.rule) return hit.rule;
  let rule = null;
  try { rule = rules.resolveRule(item)?.rule ?? null; } catch (e) { console.warn(`${MOD} | events: правило ${item.name}`, e); }
  rule = rule?.onEvent?.length ? rule : null;
  ruleCache.set(item.uuid, { mt, rv, rule });
  return rule;
}

/** Предметы актёра с правилами onEvent; дубль способности (action и feat с одним slug) — одна запись. -> [{item, rule}] */
export function eventItems(actor) {
  const out = [], seen = new Set();
  // вложенные предметы оружия (Warding Statuette) — тоже носители: их нет среди actor.items
  for (const item of [...(actor?.items ?? [])].flatMap((i) => [i, ...(i.subitems ?? [])])) {
    const rule = eventRuleOf(item);
    const key = rules.slugOf(null, item) || item.name;
    if (rule && !seen.has(key)) { seen.add(key); out.push({ item, rule }); }
  }
  return out;
}

/* ---------- сообщение-двойник ---------- */

/** Двойник сообщения для applyOps: свой id (по нему ключи meta.key), снимок use и опции pf2e (origin.castRank и др.); update пишет в себя. */
export function makeTwin(id, use, pf2e = null) {
  const twin = { id, flags: { [MOD]: { use }, ...(pf2e && { pf2e }) }, async update(d) { for (const [k, v] of Object.entries(d)) foundry.utils.setProperty(twin, k, v); } };
  return twin;
}

const actorOfDoc = (d) => d?.actor ?? d ?? null;
const tokenOf = (actor) => actor?.getActiveTokens?.(false, true)?.[0] ?? null;

/* ---------- исполнение ---------- */

const fired = new Set();   // ponytail: ключи исполненного в памяти активного ГМа; для сообщений есть и журнал во флаге, для ходов/эффектов повтор хука исключён самим pf2e
const remember = (key) => { if (fired.size > 2000) fired.clear(); fired.add(key); };

const safeDoc = async (uuid) => { try { return uuid ? await fromUuid(uuid) : null; } catch { return null; } };

/**
 * Одна запись onEvent для владельца. ev: { id (сообщение/событие), message?, options:Set, degree?, total?, actor, other, otherToken? }.
 * -> журнал { key, recs:[{tk, ops}], host? } | null (уже исполнялось / нечего).
 */
export async function runEntry(ev, owner, { item, rule }, { i, entry }, sink = null) {
  const key = ev.key ?? entryKey(ev.id, item.uuid, i);   // ev.key — ключ окна per (side:"near"), общий у записей «вход» и «конец хода»
  const base = entry.once ? `once:${item.uuid}:${i}` : key;   // once — ключ без события: эффект/состояние получателя ставится и продлевается один раз
  if (fired.has(key) || ev.message?.flags?.[MOD]?.events?.some((r) => r.key === key)) return null;
  // носитель яда (coat.mjs): запись о уроне — только по цели, на которую яд взведён; другая цель (область) носителя не трогает
  if (entry.gate?.includes("target") && !armedAt(item, ev.otherToken ?? tokenOf(ev.other), ev.other)) return null;
  if (entry.gate?.includes("idle") && combatOf(game.combats, owner)?.started) return null;   // вне боя конца хода нет: яд тратит следующий Удар, в бою — конец хода
  remember(key);
  const res = { key, recs: [] };
  sink?.push(res);   // журнал уже применённого остаётся, даже если ниже что-то упадёт
  const ownerToken = ev.ownerToken ?? tokenOf(owner), other = ev.other ?? null, otherToken = ev.otherToken ?? tokenOf(other);
  const tk = otherToken?.id ?? other?.id ?? null;
  const slug = rules.slugOf(null, item), src = rules.sourceOf(null, item);
  // эффект-носитель на «чужом» актёре (Маска ужаса, репеллент): СЛ испытания — у автора эффекта и его предмета-источника, а не у носителя
  const origin = item.type === "effect" ? item.system?.context?.origin : null;
  // предмет автора исчез (расходник уничтожен последней единицей): СЛ берём из предмета компендия, выбранного ChoiceSet эффекта (Репеллент: вариант — uuid расходника)
  const authorItem = item.type === "effect" ? (origin?.item && await safeDoc(origin.item)) || await safeDoc(chosenSourceUuid(item)) : null;
  const snap = (r, kind) => buildSnapshot({
    kind, resolved: { rule: r, source: "catalog", slug, sourceUuid: src, confidence: "high" },
    item: kind === "use" && authorItem ? { uuid: authorItem.uuid, name: authorItem.name, type: authorItem.type, sourceId: rules.sourceOf(null, authorItem) } : { uuid: item.uuid, name: item.name, type: item.type, sourceId: src },
    actor: kind === "use" && origin?.actor ? origin.actor : owner.uuid, token: kind === "use" && origin?.token ? origin.token : ownerToken?.uuid ?? null, dc: null, now: Date.now(),
    targets: other ? [{ key: tk, uuid: otherToken?.uuid ?? other.uuid, name: otherToken?.name ?? other.name, pc: !!other.hasPlayerOwner }] : []
  });

  if (entry.apply?.length && modeOf("effect") === "auto") {
    const twin = makeTwin(`ev:${base}`, snap({ v: 1, label: rule.label, onEvent: [entry] }, "event"), ev.message?.flags?.pf2e ?? null);
    // picks — общий на запись выбор шагов choose: шаги идут по одному (свой applyOps), а выбор нужен следующим
    const ctx = { scope: "apply", originActor: owner, originToken: ownerToken, originItem: item, rollOptions: [...ev.options], notes: !entry.challenge, degree: ev.degree, total: ev.total, picks: { opts: new Set(), actor: null }, ...(other && { target: otherToken ?? other }) };
    const { mine, theirs } = splitSteps(entry);
    const run = async (tkey, steps, offset) => {
      for (const [j, step] of steps.entries()) {   // по одному шагу: у каждого свой stepKey, а значит свой meta.key
        const ops = await apply.applyOps(twin, tkey, [step], { ...ctx, stepKey: `${i}.${offset + j}` });
        if (ops.length) res.recs.push({ tk: tkey, ops });
      }
    };
    await run("self", mine, 0);
    if (other && theirs.length) await run(tk, theirs, mine.length);
  }

  // gate removed: испытание только если шаг снятия реально снял носитель — второй из двух быстрых Ударов его уже не найдёт (ops пуст), испытания нет
  const removed = !entry.gate?.includes("removed") || res.recs.some((r) => r.ops.some((o) => o.op === "effRemoved"));
  if (entry.challenge && other && removed && modeOf("challenge") !== "off") {
    const id = await hostChallenge({ owner, other, otherToken, challenge: entry.challenge, key, name: item.name, build: (r) => snap(r, "use") });
    if (id) res.host = id;
  }
  debug("event", ev.id, item.name, i, res.recs.length);
  return res.recs.length || res.host ? res : null;
}

/**
 * Карточка испытания «другой участник бросает challenge против владельца» (общая для onEvent и повтора спасброска). owner может быть null
 * (автор удалён): говорящий — name, актёр снимка строкой кладёт build. build(rule) -> снимок use; targets и state.event ставим здесь. -> id карточки | null
 */
export async function hostChallenge({ owner, other, otherToken = null, challenge, key, name, build, text = "events.host", castRank = null }) {
  const t = otherToken ?? tokenOf(other);
  if (!t) return null;
  const use = build(hostRule({ challenge }, name));
  use.targets = [{ key: t.id, uuid: t.uuid, name: t.name, pc: !!other.hasPlayerOwner }];
  use.state.event = key;   // карточка испытания: события на её бросках не запускаем (цепочки нет)
  const msg = await ChatMessage.create({
    content: card(L(text, { item: esc(name), target: esc(t.name) }), "", { title: esc(name), icon: "fa-bolt" }),
    speaker: owner ? ChatMessage.getSpeaker?.({ actor: owner }) : { alias: name }, flags: { [MOD]: { use }, ...(castRank != null && { pf2e: { origin: { castRank } } }) }
  });
  return msg?.id ?? null;
}

/**
 * Повторный спасбросок (шаг repeat, repeat.mjs): у актёра на границе его хода каждый носитель с meta.repeat.on === on получает карточку-хозяина.
 * Автор мог пропасть (owner null): СЛ и степени снятия — из снимка в meta.repeat, иначе цель осталась бы под эффектом навсегда.
 */
export async function runRepeats(on, evId, actor) {
  if (!actor || actor.isDead || modeOf("challenge") === "off") return;
  for (const item of [...(actor.items ?? [])]) {
    const m = item.flags?.[MOD]?.meta, rp = m?.repeat;
    if (rp?.on !== on) continue;
    // обёртка-состояние без живого выданного (состояние кончилось само): носитель пуст — снять, не слать карточки вечно
    if ((item.system?.rules ?? []).some((r) => r.key === "GrantItem") && !Object.values(item.flags?.pf2e?.itemGrants ?? {}).some((g) => actor.items.has?.(g.id))) { await item.delete().catch(() => {}); continue; }
    const key = `${evId}:${item.uuid}:repeat`;
    if (fired.has(key)) continue;
    remember(key);
    try {
      const [owner, origin] = [await safeDoc(m.by), await safeDoc(m.origin)];
      const name = origin?.name ?? item.name, src = origin ? rules.sourceOf(null, origin) : null;
      const build = (rule) => buildSnapshot({
        kind: "use", resolved: { rule, source: "catalog", slug: origin ? rules.slugOf(null, origin) : null, sourceUuid: src, confidence: "high" },
        item: { uuid: m.origin ?? item.uuid, name, type: origin?.type ?? item.type, sourceId: src },
        actor: owner?.uuid ?? m.by ?? null, token: (owner && tokenOf(owner)?.uuid) || null, dc: rp.dc, now: Date.now(), targets: []
      });
      await hostChallenge({ owner, other: actor, challenge: repeatChallenge(rp, m.key), key, name, build, text: "events.repeat" });
    } catch (e) { console.error(`${MOD} | repeat ${item.name}`, e); }
  }
}

/**
 * Ключ идемпотентности триггера зоны. per (раунд/ход боя) — один ключ на существо и зону для ВСЕХ записей с этим per (запись и событие в ключ не входят:
 * «вход» и «конец хода» с per:"round" делят один бросок); без per или вне боя — само событие (evId) и номер записи.
 */
export function triggerKey({ per, combat, round, turn, evId, region, token, i }) {
  if (per && combat) return `trg:${combat}:${round}${per === "turn" ? `:${turn}` : ""}:${region}:${token}`;
  return `trg:${evId}:${region}:${token}:${i}`;
}

/** Получит ли существо (токен) карточку испытания автора: предикат `when`, `who` (враг/союзник по расположению автора), иммунитет — до карточки. */
async function cardFits(ch, authorUuid, authorDisp, token) {
  const who = rules.challengeWho(ch);
  return challengeApplies(ch, token.actor, authorUuid)
    && !(who && (who === "enemy") !== apply.opposed(authorDisp ?? 1, token.disposition ?? 0))
    && !(ch.immunity && await isImmune({ actor: authorUuid }, token, ch));
}

const feedHas = (key) => game.messages.contents.slice(-100).some((m) => m.flags?.[MOD]?.use?.state?.event === key);   // переживает перезагрузку: карточка-хозяин помнит свой ключ

/**
 * Триггер зоны (onUse.zone.triggers): существо `token` вошло в область / начало / кончило в ней ход. sys — система поведения зоны.
 * ev: { evId, combat?, round?, turn? } — evId стойкий (id перемещения либо бой:раунд:ход:событие). Закрытая/скрытая/просроченная зона не стреляет.
 * Автор мог исчезнуть: владелец карточки null, СЛ — из снимка зоны (sys.dc).
 */
export async function fireZoneTrigger(sys, token, on, ev) {
  const actor = token?.actor, region = sys.region, list = (sys.triggers ?? []).map((t, i) => ({ t, i })).filter(({ t }) => t.on === on);
  if (!list.length || !actor || actor.isDead || !isCreature(actor) || !region || region.hidden || sys.expired || !guardActiveGM()) return;
  if (sys.skipOrigin && sys.originActor && actor.uuid === sys.originActor) return;
  const [owner, origin] = [await safeDoc(sys.originActor), await safeDoc(sys.originUuid)];
  const name = origin?.name ?? sys.parent?.name ?? "";
  const src = origin ? rules.sourceOf(null, origin) : null;
  const build = (rule, dc) => buildSnapshot({
    kind: "use", resolved: { rule, source: "catalog", slug: origin ? rules.slugOf(null, origin) : null, sourceUuid: src, confidence: "high" },
    item: { uuid: sys.originUuid || null, name, type: origin?.type ?? "feat", sourceId: src },
    actor: owner?.uuid ?? (sys.originActor || null), token: (owner && tokenOf(owner)?.uuid) || null, dc: dc ?? null, now: Date.now(), targets: []
  });
  await queue(`ztrg:${region.uuid}:${token.id}`, async () => {
    for (const { t, i } of list) {
      const key = triggerKey({ ...ev, per: t.per, region: region.uuid, token: token.id, i });
      if (fired.has(key) || feedHas(key)) continue;
      const ch = t.challenge, dc = ch?.dc?.value ?? sys.dcs?.[i] ?? sys.dc ?? null;
      const card = ch && modeOf("challenge") !== "off" && await cardFits(ch, owner?.uuid ?? sys.originActor, tokenOf(owner)?.disposition ?? 1, token);
      // ponytail: триггер только с apply ключ не пишет в ленту (нет карточки): после перезагрузки повтор того же раунда возможен; ядро события не переигрывает, так что цена — откат хода
      const steps = t.apply?.length && modeOf("effect") === "auto";
      if (!card && !steps) continue;
      remember(key);   // после проверок: цель, не попавшая под испытание, раунд не гасит; remember — до первого await ниже
      try {
        if (steps) {
          const twin = makeTwin(`ev:${key}`, { ...build({ v: 1, label: name, onEvent: [] }, dc), kind: "event", targets: [{ key: token.id, uuid: token.uuid, name: token.name, pc: !!actor.hasPlayerOwner }] }, sys.castRank != null ? { origin: { castRank: sys.castRank } } : null);
          for (const [j, step] of t.apply.entries()) await apply.applyOps(twin, token.id, [step], { scope: "apply", originActor: owner, originToken: tokenOf(owner), originItem: origin, rollOptions: [], notes: !ch, target: token, stepKey: `${i}.${j}` });
        }
        if (card) await hostChallenge({ owner, other: actor, otherToken: token, challenge: ch, key, name, build: (r) => build(r, dc), text: "events.zone", castRank: sys.castRank });
      } catch (e) { console.error(`${MOD} | zone trigger ${name}[${i}]`, e); }
    }
  });
}

const isCreature = (actor) => actor.isOfType?.("creature") ?? true;   // жертва — существо (не транспорт, лут, опасность); без isOfType — как есть

/** Стена между центрами прямоугольников (луч как в apply.alliesIn); не на холсте проверить нечем — не блокирует. */
function wallBlocked(token, a, b) {
  const scene = token.parent;
  if (!scene || globalThis.canvas?.scene !== scene) return false;
  const g = scene.grid?.size || 100, mid = (r) => ({ x: (r.x + r.w / 2) * g, y: (r.y + r.h / 2) * g });
  const level = token.level && scene.levels?.get?.(token.level);
  return !!CONFIG.Canvas?.polygonBackends?.move?.testCollision?.(mid(a), mid(b), { type: "move", mode: "any", ...(level && { level }) });
}

const hasNear = (token) => !!token.actor && eventItems(token.actor).some(({ rule }) => rule.onEvent.some((e) => e.side === "near"));
/** Токены сцены, у актёров которых есть записи near: одна выборка на событие, дальше — только они. ponytail: обход предметов каждого токена на событие (правила в кэше eventRuleOf); кэш по сцене — если токенов на сцене станут сотни. */
const nearCarriers = (scene) => (scene?.tokens ?? []).filter(hasNear);

/**
 * Аура владельца (onEvent side:"near", T3): `victim` — тот, чей ход / кто вошёл; `carrier` — токен с правилом (у несвязанного NPC актёр — токена).
 * ev: { evId, combat?, round?, turn? }; moved — для enter: { id, origin, destination, passed? } токена, который двигался (carrier или victim).
 * Окно per — общий ключ на носителя+предмет+аура и жертву (вход и конец хода в одном ходе/раунде — одна карточка).
 * Порядок: геометрия (дёшево) -> опции и when -> очередь и карточка.
 */
export async function fireNear(on, carrier, victim, ev, moved = null) {
  const owner = carrier?.actor, actor = victim?.actor;
  if (!owner || !actor || !isCreature(actor) || carrier.id === victim.id || owner.isDead || actor.isDead || carrier.hidden || victim.hidden || !guardActiveGM()) return;
  const unit = carrier.parent?.grid?.distance || 5;
  const cands = [];
  for (const found of eventItems(owner)) for (const [i, entry] of (found.rule.onEvent ?? []).entries()) if (entry.side === "near" && entry.on === on) cands.push({ found, i, entry });
  if (!cands.length) return;
  const inside = (radius, c, o) => insideAura(radius, c, o, unit) && !wallBlocked(carrier, c, o);
  let pairs = null;   // enter: пары (носитель, жертва) вдоль пути двигавшегося; [0] — до перемещения
  if (on === "enter") {
    if (!moved) return;
    const track = pathRects(moved.id === carrier.id ? carrier : victim, moved);
    pairs = moved.id === carrier.id ? track.map((r) => [r, rectOf(victim)]) : track.map((r) => [rectOf(carrier), r]);
  }
  const hits = cands.filter((m) => {
    const radius = nearRadius(m.entry, carrier);
    if (radius == null) return false;
    // turn-start/turn-end на просматриваемой сцене: аура pf2e сама знает свои стены (тип по чертам ауры) и высоту
    const native = !pairs && m.entry.aura && globalThis.canvas?.scene === carrier.parent ? auraOf(carrier, m.entry.aura) : null;
    if (native?.containsToken) return !!native.containsToken(victim);
    return pairs ? !inside(radius, ...pairs[0]) && pairs.some((p) => inside(radius, ...p)) : inside(radius, rectOf(carrier), rectOf(victim));
  });
  if (!hits.length) return;
  const options = new Set(["target", ...(actor.getSelfRollOptions?.("target") ?? []), ...(owner.getSelfRollOptions?.("self") ?? [])]);
  await queue(`near:${carrier.uuid}:${victim.id}`, async () => {
    for (const { found, i, entry: src } of hits) {
      if (src.when && !pass(src.when, options)) continue;
      if (compat.shouldYield(found.rule, { slug: rules.slugOf(null, found.item), sourceUuid: rules.sourceOf(null, found.item) })) continue;
      const region = `${carrier.uuid}:${carrierSlug(found.item)}:${src.aura ?? `r${src.range}`}`;
      const key = triggerKey({ ...ev, per: src.per, region, token: victim.id, i });
      if (fired.has(key) || feedHas(key)) continue;
      let entry = src;
      if (entry.challenge && !(modeOf("challenge") !== "off" && await cardFits(entry.challenge, owner.uuid, carrier.disposition, victim))) {
        if (!entry.apply?.length) continue;   // иммунная/не подходящая цель карточки не получает; шаги записи при этом остаются
        entry = { ...entry, challenge: null };
      }
      try { await runEntry({ id: ev.evId, key, options, other: actor, otherToken: victim, ownerToken: carrier }, owner, found, { i, entry }); }
      catch (e) { console.error(`${MOD} | near ${found.item.name}[${i}]`, e); }
    }
  });
}

// ponytail: память ГМа — после перезагрузки посреди хода конец хода берёт previous и может дать одну лишнюю карточку при per; хранить в флаге боя, если станет заметно
const turnAt = new Map();   // бой:участник -> {round, turn} начала текущего хода; стирается в конце хода

/**
 * Ход в ауре: начало/конец хода `combatant` — для каждого токена сцены, чьё правило near его захватывает.
 * pf2e.endTurn приходит, когда бой уже на следующем ходу: раунд/ход конца хода — из запомненного начала хода, иначе из encounter.previous,
 * иначе конец хода последнего по инициативе попал бы в раунд R+1, а enter и конец одного хода (per:"turn") получили бы разные ключи.
 */
export async function nearTurn(on, combatant, encounter) {
  const victim = combatant?.token;
  if (!victim?.actor || !guardActiveGM() || (modeOf("effect") === "off" && modeOf("challenge") === "off")) return;
  // Начало хода запоминаем сами: encounter.previous в хуке endTurn не гарантирован (вживую он не совпал и конец хода уходил в раунд R+1)
  const started = `${encounter.id}:${combatant.id}`;
  if (on === "turn-start") turnAt.set(started, { round: encounter.round, turn: encounter.turn });
  const prev = encounter.previous?.combatantId === combatant.id && encounter.previous.round != null ? encounter.previous : null;
  const at = on === "turn-end" ? turnAt.get(started) ?? prev ?? encounter : encounter;
  if (on === "turn-end") turnAt.delete(started);
  const ev = { evId: `turn:${encounter.id}:${at.round}:${at.turn}:${combatant.id}:${on}`, combat: encounter.id, round: at.round, turn: at.turn };
  for (const carrier of nearCarriers(victim.parent)) await fireNear(on, carrier, victim, ev);
}

const NEAR_METHODS = new Set(["dragging", "keyboard", "api"]);   // config/paste/undo — правка ГМа или откат, не перемещение существа; создание токена movement не имеет
/**
 * Вход в ауру при перемещении (хук v14 moveToken(doc, movement): origin/destination — положения до и после, passed.waypoints — путь).
 * «Был вне -> побывал внутри» по клеткам пути (пробежал сквозь ауру и встал снаружи — тоже вход); двигаться может и жертва, и носитель.
 * ponytail: групповое перемещение — moveToken приходит после обновления всей пачки, «до» второго токена уже смешано с новым положением первого;
 * потолок — ложные/пропущенные входы при совместном движении носителя и жертвы; чинить — снимком положений до пачки (preMoveToken).
 */
export async function onMoveToken(doc, movement) {
  if (!guardActiveGM() || !movement?.origin || !movement.destination || !NEAR_METHODS.has(movement.method) || (modeOf("effect") === "off" && modeOf("challenge") === "off")) return;
  const scene = doc.parent;
  const carriers = nearCarriers(scene);
  if (!carriers.length) return;
  // v14: бой по умолчанию без scene — ищем по участникам, как zone.mjs
  const fight = (fit) => game.combats.find((x) => x.started && x.combatants.some(fit));   // сначала бой самого токена: на сцене может идти другой
  const c = fight((m) => m.tokenId === doc.id) ?? fight((m) => m.sceneId === scene?.id);
  const ev = { evId: `enter:${movement.id}`, combat: c?.id, round: c?.round, turn: c?.turn };
  const moved = { id: doc.id, origin: movement.origin, destination: movement.destination, passed: movement.passed };
  for (const t of carriers) if (t.id !== doc.id) await fireNear("enter", t, doc, ev, moved);   // жертва двигалась
  if (carriers.some((t) => t.id === doc.id)) for (const t of scene.tokens) if (t.id !== doc.id) await fireNear("enter", doc, t, ev, moved);   // носитель двигался
}

/** Опции `origin-effect:<slug>` для владельца side:origin: эффекты «другого» (носителя), автор которых — именно этот владелец (не любой автор любого эффекта). */
export async function originEffectOptions(carrier, owner) {
  const out = [];
  for (const e of carrier?.items?.filter?.((i) => i.type === "effect") ?? []) {
    const au = e.system?.context?.origin?.actor;
    if (!au || (au !== owner.uuid && (await safeDoc(au))?.uuid !== owner.uuid)) continue;
    const slug = e.slug ?? e.system?.slug;
    if (slug) for (const s of new Set([slug, slug.replace(/^(?:spell-)?effect-/, "")])) out.push(`origin-effect:${s}`);
  }
  return out;
}

/** Все владельцы события с подходящими записями. parties: { self:[Actor], target:[Actor], origin:[Actor] }. */
async function runEvent(ev, on, parties) {
  const log = [];
  for (const side of ["self", "target", "origin"]) {
    for (const owner of parties[side] ?? []) {
      const options = side === "origin" ? new Set([...ev.options, ...(await originEffectOptions(ev.otherFor(side), owner))]) : ev.options;
      for (const found of eventItems(owner)) {
        if (compat.shouldYield(found.rule, { slug: rules.slugOf(null, found.item), sourceUuid: rules.sourceOf(null, found.item) })) continue;
        for (const m of matchEntries(found.rule, on, side, options)) {
          if (m.entry.afterUse && !linkedCard(ev.message, found.item)) continue;   // после when: ленту листаем только для подходящего исхода
          try { await runEntry({ ...ev, options, other: ev.otherFor(side), otherToken: ev.otherTokenFor(side) }, owner, found, m, log); }
          catch (e) { console.error(`${MOD} | event ${found.item.name}[${m.i}]`, e); }   // одна запись не должна ронять остальные
        }
      }
    }
  }
  return log.filter((r) => r.recs.length || r.host);
}

/* ---------- сообщения чата ---------- */

const stash = new Map();   // переброс: pf2e удаляет старое сообщение и создаёт новое с isReroll — журнал откладываем под (актёр, событие)
const REROLL_TTL = 60000;
const rerollKey = (actorUuid, on) => `${actorUuid}|${on}`;

async function undoLog(log) {
  for (const rec of log) {
    for (const { tk, ops } of rec.recs ?? []) {
      const twin = makeTwin(`ev:${rec.key}`, { state: { apply: { [tk]: { ops } } } });
      await apply.undoOps(twin, tk);
    }
    const host = rec.host ? game.messages.get(rec.host) : null;
    if (host) {
      for (const t of host.flags?.[MOD]?.use?.targets ?? []) await apply.undoOps(host, t.key);
      await host.delete();
    }
  }
}

/** Есть ли у заклинания цель/область/дальность: без них (самоприменяемое) устаревшие цели автора не его цели сотворения. */
export function spellTargets(spell) {
  const s = spell?.system;
  if (!s) return true;   // предмет неизвестен — как раньше
  const t = String(s.target?.value ?? "").trim(), range = String(s.range?.value ?? "").trim();
  return !!(s.area?.value || (t && !/^(?:you|self)\b/i.test(t)) || range);
}

/** Участники события-сообщения. */
async function messageParties(message) {
  const ctx = message.flags.pf2e.context ?? {}, pf = message.flags.pf2e;
  const actor = message.actor ?? null;
  const targetToken = await safeDoc(ctx.target?.token), target = actorOfDoc(targetToken) ?? (await safeDoc(ctx.target?.actor)) ?? null;
  const origin = (await safeDoc(ctx.origin?.actor ?? pf.origin?.actor)) ?? null;
  return { actor, target, origin, targetToken, actorToken: message.token ?? null };
}

function messageOptions(message, { actor, target }, on) {
  const pf = message.flags.pf2e, ctx = pf.context ?? {};
  // тот же набор, что видит предикат у pf2e-automations: опции броска и источника, исход, области (domain:*), цель (`target`, `target:*`) и опции бросавшего
  const set = new Set([...(ctx.options ?? []), ...(pf.origin?.rollOptions ?? []), ...(ctx.domains ?? []).map((d) => `domain:${d}`),
    ...(actor?.getRollOptions?.() ?? []), ...(actor?.getSelfRollOptions?.("self") ?? []), ...(target ? ["target", ...(target.getSelfRollOptions?.("target") ?? [])] : [])]);
  if (on === "damage-taken") for (const o of damageOptions(pf.appliedDamage)) set.add(o);
  for (const o of attackEffectOptions(message.item)) set.add(o);
  for (const o of chosenOptions(actor, message.item)) set.add(o);
  for (const s of message.item?.subitems ?? []) if (s.slug) set.add(`sub-item:${s.slug}`);   // как у PA: вложенные предметы оружия, которым нанесён бросок
  const roll = message.rolls?.[0], idx = DEGREES.indexOf(ctx.outcome);
  const degree = roll?.degreeOfSuccess ?? (idx >= 0 ? idx : null);
  if (degree != null) set.add(`outcome:${DEGREES[degree]}`);
  return { set, degree, total: roll?.total ?? null };
}

export async function onMessage(message) {
  if (!guardActiveGM() || (modeOf("effect") === "off" && modeOf("challenge") === "off")) return;   // шаги и испытания гасятся своими режимами внутри runEntry
  const on = eventOfMessage(message);
  const applied = message.flags?.pf2e?.appliedDamage;
  if (!on || applied?.isReverted || (on === "damage-taken" && (!applied || applied.isHealing))) return;   // без appliedDamage (лечение при полных ОЗ, полная невосприимчивость) урона не было   // откат урона и лечение — не «получен урон» (у PA лечение — отдельный healing-taken)
  const mk = parseMarker(message.flags.pf2e.context?.options);
  if (mk && game.messages.get(mk.messageId)?.flags?.[MOD]?.use?.state?.event) return;   // бросок по карточке испытания события
  const p = await messageParties(message);
  if (!p.actor) return;
  const ctx = message.flags.pf2e.context ?? {};
  if (ctx.isReroll) {   // откат прежнего исполнения: журнал старого сообщения (удалено при перебросе) -> undoOps
    const k = rerollKey(p.actor.uuid, on), old = stash.get(k);
    stash.delete(k);
    if (old && Date.now() - old.at <= REROLL_TTL) await undoLog(old.log);
  }
  // у карточки заклинания нет context.target: цели — снимок use или цели автора (как в use.mjs); область с несколькими целями — по одному запуску на цель
  const cast = on === "spell-cast" && (message.flags?.[MOD]?.use?.targets || spellTargets(message.item)) ? messageTargets(message) : [];
  await queue(`events:${message.id}`, async () => {
    for (const t of cast.length ? cast : [null]) {
      const q = t ? { ...p, target: t.actor, targetToken: t } : p;
      const { set, degree, total } = messageOptions(message, q, on);
      // «другой» у урона — его источник (ctx.origin), у остальных событий — цель броска / бросавший
      const ev = { id: cast.length > 1 ? `${message.id}@${t.id}` : message.id, message, options: set, degree, total,
        otherFor: (side) => (side === "self" ? (on === "damage-taken" ? q.origin : q.target) : q.actor), otherTokenFor: (side) => (side === "self" ? (on === "damage-taken" ? tokenOf(q.origin) : q.targetToken) : q.actorToken) };
      const log = await runEvent(ev, on, { self: [q.actor], target: q.target ? [q.target] : [], origin: q.origin && q.origin.uuid !== q.actor.uuid ? [q.origin] : [] });
      if (log.length) await message.update({ [flagPath("events")]: [...(message.flags?.[MOD]?.events ?? []), ...log] });
    }
  });
}

export function onDeleteMessage(message) {
  const log = message.flags?.[MOD]?.events;
  const on = eventOfMessage(message), actor = message.actor?.uuid;
  if (!guardActiveGM() || !on || !actor) return;
  const now = Date.now();
  for (const [k, v] of stash) if (now - v.at > REROLL_TTL) stash.delete(k);
  // удалено сообщение без журнала тоже затирает запись: переброс B после «A с журналом, B удалено без» не должен откатывать чужое исполнение A
  if (log?.length) stash.set(rerollKey(actor, on), { log: foundry.utils.deepClone(log), at: now });
  else stash.delete(rerollKey(actor, on));
}

/** Откат урона кнопкой pf2e (appliedDamage.isReverted): исполненное событием откатывается, журнал очищается. */
export async function onUpdateMessage(message, changes) {
  const log = message.flags?.[MOD]?.events;
  if (!guardActiveGM() || !log?.length || !foundry.utils.getProperty(changes ?? {}, "flags.pf2e.appliedDamage.isReverted") || eventOfMessage(message) !== "damage-taken") return;
  await queue(`events:${message.id}`, async () => {
    await undoLog(log);
    await message.update({ [flagPath("events")]: [] });
  });
}

/* ---------- ходы и эффекты ---------- */

/**
 * Событие без сообщения: актёр (ходит / у него эффект) и его «origin» — авторы эффектов (у эффекта-события — только его автор).
 * Набор опций как у PA: опции актёра, эффекта и (для эффекта) опции автора с `target:*` носителя.
 */
async function actorEvent(on, evId, actor, { extra = [], effect = null } = {}) {
  if (!guardActiveGM() || (modeOf("effect") === "off" && modeOf("challenge") === "off") || !actor) return;
  const origins = [];
  for (const e of effect ? [effect] : actor.items?.filter?.((i) => i.type === "effect") ?? []) {
    const o = await safeDoc(e.system?.context?.origin?.actor);
    if (o && o.uuid !== actor.uuid && !origins.some((x) => x.uuid === o.uuid)) origins.push(o);
  }
  const set = new Set([...(actor.getRollOptions?.() ?? []), ...(actor.getSelfRollOptions?.("self") ?? []), ...extra]);
  if (effect) for (const o of origins) { for (const x of o.getRollOptions?.() ?? []) set.add(x); for (const x of actor.getSelfRollOptions?.("target") ?? []) set.add(x); }
  // у события без броска цели нет: владельцу-носителю «другой» — только тот, на ком эффект (сторона origin)
  const ev = { id: evId, options: set, otherFor: (side) => (side === "origin" ? actor : null), otherTokenFor: () => null };
  await queue(`events:${evId}`, async () => {
    try { await runEvent(ev, on, { self: [actor], origin: origins }); }
    finally { if (!effect && (on === "turn-start" || on === "turn-end")) await runRepeats(on, evId, actor); }   // сбой onEvent не гасит повторы
  });
}

export const onTurn = (on) => (combatant, encounter) => actorEvent(on, `turn:${encounter?.id}:${encounter?.round}:${encounter?.turn}:${combatant?.id}:${on}`, combatant?.actor).catch((e) => console.error(`${MOD} | events ${on}`, e));
const onItem = (on) => (item, options) => {
  if (item?.type !== "effect" || !item.parent?.items || isOwnEffect(item) || options?.[MOD]?.undo || !guardActiveGM()) return;
  actorEvent(on, `item:${item.id}:${on}`, item.parent, { extra: [...(item.getRollOptions?.("item") ?? []), ...effectOptions(item)], effect: item }).catch((e) => console.error(`${MOD} | events ${on}`, e));
};

export function init() {
  Hooks.on("createChatMessage", (m) => { onMessage(m).catch((e) => console.error(`${MOD} | events`, e)); });
  Hooks.on("deleteChatMessage", (m) => { try { onDeleteMessage(m); } catch (e) { console.error(`${MOD} | events.onDelete`, e); } });
  Hooks.on("updateChatMessage", (m, ch) => { onUpdateMessage(m, ch).catch((e) => console.error(`${MOD} | events.update`, e)); });
  const onNear = (on) => (c, e) => nearTurn(on, c, e).catch((err) => console.error(`${MOD} | near ${on}`, err));
  Hooks.on("pf2e.startTurn", (c, e) => { noteTurn(c); onNear("turn-start")(c, e); return onTurn("turn-start")(c, e); });
  Hooks.on("pf2e.endTurn", (c, e) => { onNear("turn-end")(c, e); return onTurn("turn-end")(c, e); });
  Hooks.on("moveToken", (doc, movement) => { onMoveToken(doc, movement).catch((e) => console.error(`${MOD} | near enter`, e)); });
  Hooks.on("createItem", onItem("effect-created"));
  Hooks.on("deleteItem", onItem("effect-deleted"));
}
