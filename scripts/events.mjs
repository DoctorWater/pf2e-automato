// 0.5g3: onEvent — правило на предмете актёра (черта, эффект, снаряжение) срабатывает по событию: бросок, урон, ход, эффект, сотворение. plan.md §1.1b.
// Исполняет только активный ГМ. Шаги идут через apply.applyOps на сообщении-двойнике (в чат не пишется): снимок use и запись ops живут в нём,
// а в самом сообщении события — только свой флаг `events` (журнал для переброса). Испытание (challenge) получает свою карточку со снимком use — дальше всё как у onUse.
import { MOD, L, DEGREES, flagPath, guardActiveGM, queue, debug } from "./util.mjs";
import { modeOf, rev } from "./settings.mjs";
import * as compat from "./compat.mjs";
import * as rules from "./rules.mjs";
import * as apply from "./apply.mjs";
import { testPredicate } from "./predicate.mjs";
import { useKindOf, buildSnapshot } from "./use.mjs";
import { card } from "./card.mjs";
import { messageTargets, esc } from "./builtin/lib.mjs";
import { parseMarker } from "./saves.mjs";

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
  if (applied.shield?.damage > 0) out.push("damage-taken:shield");
  return out;
}

/**
 * Опции `item:attack-effect:<slug>` для Удара: pf2e связывает пассивные способности NPC с Ударом через его attackEffects (tongue-grab у «Языка»).
 * Правило способности («при попадании цель схвачена») ловит именно такие Удары, а не любые Удары существа.
 */
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
  const base = entry.once ? `once:${item.uuid}:${i}` : entryKey(ev.id, item.uuid, i);   // once — ключ без события: эффект/состояние получателя ставится и продлевается один раз
  const key = entryKey(ev.id, item.uuid, i);
  if (fired.has(key) || ev.message?.flags?.[MOD]?.events?.some((r) => r.key === key)) return null;
  remember(key);
  const res = { key, recs: [] };
  sink?.push(res);   // журнал уже применённого остаётся, даже если ниже что-то упадёт
  const ownerToken = tokenOf(owner), other = ev.other ?? null, otherToken = ev.otherToken ?? tokenOf(other);
  const tk = otherToken?.id ?? other?.id ?? null;
  const slug = rules.slugOf(null, item), src = rules.sourceOf(null, item);
  // эффект-носитель на «чужом» актёре (Маска ужаса, репеллент): СЛ испытания — у автора эффекта и его предмета-источника, а не у носителя
  const origin = item.type === "effect" ? item.system?.context?.origin : null;
  const authorItem = origin?.item ? await safeDoc(origin.item) : null;
  const snap = (r, kind) => buildSnapshot({
    kind, resolved: { rule: r, source: "catalog", slug, sourceUuid: src, confidence: "high" },
    item: kind === "use" && authorItem ? { uuid: authorItem.uuid, name: authorItem.name, type: authorItem.type, sourceId: rules.sourceOf(null, authorItem) } : { uuid: item.uuid, name: item.name, type: item.type, sourceId: src },
    actor: kind === "use" && origin?.actor ? origin.actor : owner.uuid, token: kind === "use" && origin?.token ? origin.token : ownerToken?.uuid ?? null, dc: null, now: Date.now(),
    targets: other ? [{ key: tk, uuid: otherToken?.uuid ?? other.uuid, name: otherToken?.name ?? other.name, pc: !!other.hasPlayerOwner }] : []
  });

  if (entry.apply?.length && modeOf("effect") === "auto") {
    const twin = makeTwin(`ev:${base}`, snap({ v: 1, label: rule.label, onEvent: [entry] }, "event"), ev.message?.flags?.pf2e ?? null);
    // picks — общий на запись выбор шагов choose: шаги идут по одному (свой applyOps), а выбор нужен следующим
    const ctx = { scope: "apply", originActor: owner, originToken: ownerToken, originItem: item, rollOptions: [...ev.options], degree: ev.degree, total: ev.total, picks: { opts: new Set(), actor: null }, ...(other && { target: otherToken ?? other }) };
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

  if (entry.challenge && other && modeOf("challenge") !== "off") {
    const t = otherToken ?? tokenOf(other);
    if (t) {
      const r = hostRule(entry, item.name);
      const use = snap(r, "use");
      use.targets = [{ key: t.id, uuid: t.uuid, name: t.name, pc: !!other.hasPlayerOwner }];
      use.state.event = key;   // карточка испытания: события на её бросках не запускаем (цепочки нет)
      const msg = await ChatMessage.create({
        content: card(L("events.host", { item: esc(item.name), target: esc(t.name) }), "", { title: esc(item.name), icon: "fa-bolt" }),
        speaker: ChatMessage.getSpeaker?.({ actor: owner }), flags: { [MOD]: { use } }
      });
      if (msg) res.host = msg.id;
    }
  }
  debug("event", ev.id, item.name, i, res.recs.length);
  return res.recs.length || res.host ? res : null;
}

/** Все владельцы события с подходящими записями. parties: { self:[Actor], target:[Actor], origin:[Actor] }. */
async function runEvent(ev, on, parties) {
  const log = [];
  for (const side of ["self", "target", "origin"]) {
    for (const owner of parties[side] ?? []) {
      for (const found of eventItems(owner)) {
        if (compat.shouldYield(found.rule, { slug: rules.slugOf(null, found.item), sourceUuid: rules.sourceOf(null, found.item) })) continue;
        for (const m of matchEntries(found.rule, on, side, ev.options)) {
          try { await runEntry({ ...ev, other: ev.otherFor(side), otherToken: ev.otherTokenFor(side) }, owner, found, m, log); }
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
  return !!(s.area?.value || (t && !/^(?:you|self)/i.test(t)) || range);
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
  await queue(`events:${evId}`, () => runEvent(ev, on, { self: [actor], origin: origins }));
}

const onTurn = (on) => (combatant, encounter) => actorEvent(on, `turn:${encounter?.id}:${encounter?.round}:${encounter?.turn}:${combatant?.id}:${on}`, combatant?.actor).catch((e) => console.error(`${MOD} | events ${on}`, e));
const onItem = (on) => (item) => {
  if (item?.type !== "effect" || !item.parent?.items || isOwnEffect(item) || !guardActiveGM()) return;
  actorEvent(on, `item:${item.id}:${on}`, item.parent, { extra: [...(item.getRollOptions?.("item") ?? []), ...effectOptions(item)], effect: item }).catch((e) => console.error(`${MOD} | events ${on}`, e));
};

export function init() {
  Hooks.on("createChatMessage", (m) => { onMessage(m).catch((e) => console.error(`${MOD} | events`, e)); });
  Hooks.on("deleteChatMessage", (m) => { try { onDeleteMessage(m); } catch (e) { console.error(`${MOD} | events.onDelete`, e); } });
  Hooks.on("updateChatMessage", (m, ch) => { onUpdateMessage(m, ch).catch((e) => console.error(`${MOD} | events.update`, e)); });
  Hooks.on("pf2e.startTurn", onTurn("turn-start"));
  Hooks.on("pf2e.endTurn", onTurn("turn-end"));
  Hooks.on("createItem", onItem("effect-created"));
  Hooks.on("deleteItem", onItem("effect-deleted"));
}
