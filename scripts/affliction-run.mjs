// Исполнение недугов (plan-affliction.md §4): только активный ГМ. Носитель — эффект цели (meta.affliction + счётчик system.badge.value = стадия).
// Стадию применяет applyStage: из шагов (affliction/stageDelta) вызывается напрямую с флагом direct у update, из хука updateItem — только правка бейджа ГМом (клик = лечение).
// Часы: одно поле nextAt в мировом времени. В бою — на конце хода цели (pf2e.endTurn), вне боя и у не-участников — updateWorldTime / смена лидера.
import { MOD, L, queue, flagPath, guardActiveGM } from "./util.mjs";
import { modeOf } from "./settings.mjs";
import { applyCondition, applyPersistent, dealDamage, removeByKey, findByKey, immuneToTraits } from "./apply.mjs";
import { card } from "./card.mjs";
import { esc, combatOf, worldActors, effectSource } from "./builtin/lib.mjs";
import { rulesOfMods, inlineSlug } from "./inline-effect.mjs";
import * as rules from "./rules.mjs";
import { slugOfDef, carrierKey, stageKey, linkedPrefix, UNLINKED, startMeta, reexpose, advance, stageDelta, intervalOf, dueOf, afflictionChallenge, stagesText } from "./affliction.mjs";

const DIRECT = { [MOD]: { direct: true } };   // свои update: хук updateItem их пропускает (стадию применили сами)
const FOREVER = { value: -1, unit: "unlimited", expiry: null, of: "target" };
const metaOf = (item) => item?.flags?.[MOD]?.meta?.affliction ?? null;
const isCarrier = (i) => i?.type === "effect" && !!metaOf(i);
const safeDoc = async (uuid) => { try { return uuid ? await fromUuid(uuid) : null; } catch { return null; } };
const tokenOf = (actor) => actor?.getActiveTokens?.(false, true)?.[0] ?? null;
const now = () => game.time.worldTime;
const warn = (key, data) => globalThis.ui?.notifications?.warn?.(L(key, data));
const busy = new Set();   // id носителей, которые тик обходит прямо сейчас
let tracked = null;   // актёры с носителями: sweep не обходит весь мир на каждый updateWorldTime
const track = (actor) => { if (tracked && actor) tracked.set(actor.uuid, actor); };
/** Тесты и смена мира: кэш актёров с носителями пересобирается при следующем sweep. */
export const resetTracked = () => { tracked = null; };
const fired = new Set();   // ponytail: ключи броска в памяти активного ГМа; после перезагрузки их заменяет meta.pending + лента (pendingAlive)

/* ---------- применение стадии ---------- */

function say(def, actor, text, extra = "") {
  return ChatMessage.create({ content: card(`${text}${extra ? `<br>${extra}` : ""}`, "", { title: esc(def.name), icon: "fa-biohazard" }), speaker: { alias: def.name } });
}

/**
 * Эффекты стадии n носителя: состояния, штрафы (system.rules носителя), урон, карточка. Идемпотентно по ключам документов.
 * damage:false — откат (урон не повторяем); from — стадия, чьи связанные состояния заменить (при откате прежняя применённая уже затёрта).
 * Пока идёт onset (стадия записана, но ничего не применялось) — ничего не делает: эффекты придут с onset-тиком.
 */
export async function applyStage(item, n, { damage = true, from = null, quiet = false, onset = false } = {}) {
  const actor = item.actor, m = metaOf(item), st = m?.def?.stages?.[n - 1], res = { made: [], dealt: false };
  if (!actor || !st) return res;
  if (m.applied == null && m.onsetEnds != null && now() < m.onsetEnds) return res;
  // созданное и поднятое по max вне обёртки: откат стадии вернёт (afflictionUnmake)
  const note = (r) => { if (r?.item && (r.op === "created" || r.op === "raised")) res.made.push({ item: r.item.uuid, ...(r.op === "raised" && { prev: r.prev }) }); };
  try {
    const old = from ?? m.applied, ctx = { target: actor.getActiveTokens?.(true, true)?.[0] }, meta = (key) => ({ key, source: "affliction" });
    if (old != null && old !== n) await removeByKey(actor, linkedPrefix(m.slug, old));
    for (const c of st.conditions) {
      const spec = { slug: c.slug, ...(c.value != null && { value: c.value }), policy: "max" };
      // связанные состояния живут в обёртке (сменятся со стадией), перечисленные pf2e (zl) — поднимаются по max и остаются
      if (UNLINKED.has(c.slug)) note(await applyCondition(actor, spec, meta(stageKey(m.slug, n, c.slug)), ctx));
      else await applyCondition(actor, { ...spec, duration: FOREVER }, meta(stageKey(m.slug, n, c.slug, true)), ctx);
    }
    if (st.persistent) note(await applyPersistent(actor, st.persistent, meta(stageKey(m.slug, n, "P")), {}));
    await queue(`actor:${actor.uuid}`, () => item.update({ "system.rules": rulesOfMods(st.mods ?? []), [flagPath("meta", "affliction", "applied")]: n }, DIRECT));
    if (damage) for (const d of st.damage) { await dealDamage(actor, d, {}, null); res.dealt = true; }
    if (!quiet) await say(m.def, actor, (onset ? `<span class="paf-onset">${L("affliction.onset")}</span> ` : "") + L("affliction.stage", { item: esc(m.def.name), target: esc(actor.name), n, of: m.def.stages.length }), st.text ? esc(st.text) : "");
  } catch (e) { console.error(`${MOD} | affliction stage ${m.def.name}:${n}`, e); }
  return res;
}

/** applyStage с журналом урона в сообщении (state.damaged): после отката и повторного «Применить» урон стадии второй раз не наносится. */
async function stageOnce(item, n, c) {
  const msg = c.message, dk = msg ? `${msg.id}:${c.tokenKey}:${metaOf(item).slug}:${n}` : null;
  const log = (dk && foundry.utils.getProperty(msg, flagPath("use", "state", "damaged"))) || [];
  const r = await applyStage(item, n, { damage: !log.includes(dk) });
  if (r.dealt && dk) await msg.update({ [flagPath("use", "state", "damaged")]: [...log, dk] });
  return r.made;
}

/** Откат созданного и поднятого стадией: созданное снимается, поднятое возвращается к прежнему значению. */
export async function afflictionUnmake(made = []) {
  for (const x of [...made].reverse()) {
    const doc = await safeDoc(x.item);
    if (!doc?.actor) continue;
    await queue(`actor:${doc.actor.uuid}`, () => (x.prev == null ? doc.delete({ [MOD]: { undo: true } }) : game.pf2e.ConditionManager.updateConditionValue(doc.id, doc.actor, x.prev)));
  }
}

/* ---------- шаги apply ---------- */

/** Данные нового носителя: эффект без срока (стадии ведёт модуль), счётчик стадии, штрафы стадии в system.rules. */
function carrierSource(actor, def, stage, m, c) {
  const token = actor.getActiveTokens?.(true, true)?.[0];
  const data = effectSource({
    name: def.name, img: c.originItem?.img ?? undefined, rules: [],
    description: `<p>${esc(stagesText(def))}</p>${c.originItem?.uuid ? `<p>@UUID[${c.originItem.uuid}]</p>` : ""}`,
    duration: { value: -1, unit: "unlimited", expiry: null },
    origin: { actor: c.selfActor?.uuid, token: c.originToken?.uuid, item: c.originItem?.uuid }, target: { actor: actor.uuid, token: token?.uuid }
  });
  data.system.slug = inlineSlug(m.slug);
  data.system.badge = { type: "counter", value: stage, min: 1, max: def.stages.length, labels: null };
  const valid = globalThis.CONFIG?.PF2E?.Item?.documentClasses?.effect?.validTraits ?? {};
  data.system.traits = { value: m.traits.filter((t) => t in valid) };
  data.flags = { [MOD]: { meta: { ...c.meta, key: carrierKey(m.slug), affliction: m } } };
  return data;
}

/**
 * Шаг affliction/stageDelta -> { op, item?, prev?, data? } как у остальных applyX (apply.mjs пишет в ops).
 * c: { meta (ключ шага), scope, use, tokenKey, degree, selfActor, originToken, originItem, traits }.
 */
export async function afflictionStep(actor, step, c) {
  if (step.stageDelta) return applyDelta(actor, step.stageDelta, c);
  const { stage, def } = step.affliction, slug = slugOfDef(def);
  // повтор того же шага (второй клик, вторая вкладка): носитель уже знает ключ
  const known = () => { const h = findByKey(actor, carrierKey(slug)); return !!h && metaOf(h).keys.includes(c.meta.key); };
  if (known()) return { op: "skipped" };
  const dc = def.save.dc ?? (c.scope === "challenge" ? c.use.dc ?? c.use.state?.challenge?.results?.[c.tokenKey]?.dc ?? await (await import("./saves.mjs")).resolveDC(c.use) : c.use.dc ?? null);
  if (dc == null) { warn("apply.afflictionNoDC", { name: actor.name }); return { op: "skipped" }; }
  // проверка носителя и создание/сдвиг — в одной очереди актёра: два одновременных шага не создадут двух носителей
  const r = await queue(`actor:${actor.uuid}`, async () => {
    const have = findByKey(actor, carrierKey(slug));
    if (have && metaOf(have).keys.includes(c.meta.key)) return { op: "skipped" };
    if (!have) {
      if (immuneToTraits(actor.attributes?.immunities, [...c.traits, def.kind, ...(def.traits ?? [])])) { warn("apply.immune", { name: actor.name }); return { op: "skipped" }; }
      const m = startMeta(def, stage, { dc, now: now(), by: c.selfActor?.uuid ?? null, origin: c.originItem?.uuid ?? null, key: c.meta.key });
      const created = (await actor.createEmbeddedDocuments("Item", [carrierSource(actor, def, stage, m, c)]))[0];
      return created ? { op: "created", item: created, stage } : { op: "skipped" };   // pf2e мог выкинуть документ
    }
    // повторное воздействие: болезнь и проклятие не действуют; яд — стадия +1 (крит. провал +2), endsAt и onsetEnds не меняются
    const m = metaOf(have), cur = have.system.badge.value;
    const x = reexpose(m, cur, c.degree === 0 ? 2 : c.degree === 1 ? 1 : stage > 1 ? 2 : 1);
    if (x.skipped) { warn("apply.afflictionTaken", { name: actor.name, item: def.name }); return { op: "skipped" }; }
    const prev = { stage: cur, aff: foundry.utils.deepClone(m) };
    await have.update({ "system.badge.value": x.stage, [flagPath("meta", "affliction", "keys")]: [...m.keys, c.meta.key] }, DIRECT);
    return { op: "afflicted", item: have, prev, stage: x.stage, apply: x.stage !== cur || x.repeated };
  });
  if (r.op === "skipped") return r;
  track(actor);
  const made = r.op === "created" || r.apply ? await stageOnce(r.item, r.stage, c) : [];
  return { op: r.op, item: r.item, ...(r.prev && { prev: r.prev }), made };
}

/** Внутренний шаг карточки спасброска: сдвиг стадии по степени. Снятие носителя -> afflCleared (откат создаёт заново и применяет стадию без урона). */
async function applyDelta(actor, spec, c) {
  const { meta, degree } = c;
  const r = await queue(`actor:${actor.uuid}`, async () => {
    const item = findByKey(actor, carrierKey(spec.slug)), m = metaOf(item);
    if (!m || m.keys.includes(meta.key) || degree == null) return { op: "skipped" };
    const cur = item.system.badge.value, { delta, streak } = stageDelta(degree, m.def.virulent, m.streak), nx = advance(cur, delta, m.def);
    if (nx.cleared) return { op: "afflCleared", item, data: (({ _id, ...d }) => d)(item.toObject()) };
    const iv = intervalOf(m.def, nx.stage);
    const prev = { stage: cur, aff: foundry.utils.deepClone(m) };
    await item.update({ "system.badge.value": nx.stage, [flagPath("meta", "affliction")]: { streak, pending: null, keys: [...m.keys, meta.key], nextAt: iv == null ? null : now() + iv } }, DIRECT);
    return { op: "afflicted", item, prev, apply: nx.stage !== cur || nx.repeated };
  });
  if (r.op === "afflCleared") {
    const { item, ...rest } = r, def = metaOf(item).def;
    await item.delete();
    await say(def, actor, L("affliction.cleared", { item: esc(def.name), target: esc(actor.name) }));
    return rest;
  }
  const made = r.apply ? await stageOnce(r.item, r.item.system.badge.value, c) : [];
  return { op: r.op, item: r.item, prev: r.prev, made };
}

/** Откат ops: стадия, streak, часы возвращаются; состояния прежней стадии — без повторного урона. */
export async function afflictionUndo(item, prev, made = []) {
  const from = metaOf(item)?.applied ?? null;
  await afflictionUnmake(made);
  await queue(`actor:${item.actor.uuid}`, () => item.update({ "system.badge.value": prev.stage, [flagPath("meta", "affliction")]: prev.aff }, { [MOD]: { direct: true, undo: true } }));
  await applyStage(item, prev.stage, { damage: false, from, quiet: true });
}

/** Откат снятия носителя: документ создаётся заново, стадия применяется без урона. */
export async function afflictionRestore(actor, data) {
  const [item] = await queue(`actor:${actor.uuid}`, () => actor.createEmbeddedDocuments("Item", [foundry.utils.deepClone(data)]));
  if (item) { track(actor); await applyStage(item, item.system.badge.value, { damage: false, quiet: true }); }
}

/* ---------- часы ---------- */

/** Карточка уже выложена и сдвиг не применён: нового броска не нужно (переживает перезагрузку — карточка помнит свой ключ). */
function pendingAlive(m) {
  const msg = m?.pending?.msg && game.messages.get(m.pending.msg);
  return !!msg && !Object.keys(msg.flags?.[MOD]?.use?.state?.challenge?.applied ?? {}).length;
}

async function rollCard(item, m, evId) {
  const actor = item.actor, key = `${evId}:${item.uuid}:affliction`;
  if (fired.has(key) || pendingAlive(m) || modeOf("challenge") === "off" || !tokenOf(actor)) return;
  fired.add(key);
  const [{ hostChallenge }, { buildSnapshot }] = await Promise.all([import("./events.mjs"), import("./use.mjs")]);   // лениво: events/use тянут zone и пол-модуля
  const stage = item.system.badge.value, iv = intervalOf(m.def, stage);
  if (iv == null) return;
  // карточка: СЛ и степени — из снимка; автор мог пропасть (owner null, как у повтора спасброска)
  const [owner, origin] = [await safeDoc(m.by), await safeDoc(m.origin)], src = origin ? rules.sourceOf(null, origin) : null;
  const build = (rule) => buildSnapshot({
    kind: "use", resolved: { rule, source: "catalog", slug: origin ? rules.slugOf(null, origin) : null, sourceUuid: src, confidence: "high" },
    item: { uuid: m.origin ?? item.uuid, name: m.def.name, type: origin?.type ?? item.type, sourceId: src },
    actor: owner?.uuid ?? m.by ?? null, token: owner?.getActiveTokens?.(false, true)?.[0]?.uuid ?? null, dc: m.dc, now: Date.now(), targets: []
  });
  // pending и сдвиг nextAt — до карточки: перезагрузка между ними не даёт второй бросок. Свежие meta читаем внутри очереди: два тика не выложат две карточки
  const go = await queue(`actor:${actor.uuid}`, async () => {
    const f = metaOf(item);
    if (!f || f.nextAt !== m.nextAt || pendingAlive(f)) return false;
    await item.update({ [flagPath("meta", "affliction")]: { pending: { key }, nextAt: now() + iv } }, DIRECT);
    return true;
  });
  if (!go) return;
  const id = await hostChallenge({ owner, other: actor, challenge: afflictionChallenge(m), key, name: m.def.name, build, text: "events.affliction" });
  if (id) await queue(`actor:${actor.uuid}`, () => item.update({ [flagPath("meta", "affliction", "pending")]: { key, msg: id } }, DIRECT));
}

/** Что пора делать с носителем: конец срока (одна карточка и снятие), onset прошёл (применить стадию), конец интервала (карточка спасброска). Пропущенные интервалы не догоняем. */
async function tickItem(item, evId) {
  let m = metaOf(item), due = dueOf(m, now());
  if (due === "end") {
    await say(m.def, item.actor, L("affliction.ended", { item: esc(m.def.name), target: esc(item.actor.name) }));
    await item.delete();
    return;
  }
  if (due === "onset") {
    await applyStage(item, item.system.badge.value, { onset: true });
    m = metaOf(item); due = dueOf(m, now());
  }
  if (due === "roll") await rollCard(item, m, evId);
}

/** Носители актёра. dead — недуг мёртвого не тикает (как повтор спасброска). */
export async function tick(actor, evId = `w:${now()}`) {
  if (!actor || actor.isDead || !guardActiveGM()) return;
  for (const item of [...(actor.items ?? [])].filter(isCarrier)) {
    if (busy.has(item.id)) continue;   // этот носитель уже обходит другой тик (конец хода и смена времени подряд)
    busy.add(item.id);
    try { await tickItem(item, evId); } catch (e) { console.error(`${MOD} | affliction tick ${item.name}`, e); } finally { busy.delete(item.id); }
  }
}

const inCombat = (actor) => !!combatOf(game.combats, actor)?.started;
const hasCarrier = (actor) => !!actor?.items?.some?.(isCarrier);

/** Все актёры мира вне боя: смена времени, смена лидера (подхват работы ушедшего). */
export async function sweep() {
  if (!guardActiveGM()) return;
  tracked ??= new Map(worldActors().filter(hasCarrier).map((a) => [a.uuid, a]));   // новые носители добавляет track (создание, откат снятия, createItem)
  for (const [uuid, actor] of [...tracked]) {
    if (!hasCarrier(actor)) { tracked.delete(uuid); continue; }
    if (!inCombat(actor)) await tick(actor);
  }
}

/* ---------- хуки ---------- */

export function init() {
  Hooks.on("pf2e.endTurn", (c, e) => { if (hasCarrier(c?.actor)) tick(c.actor, `turn:${e?.id}:${e?.round}:${e?.turn}:${c.id}`).catch((err) => console.error(`${MOD} | affliction turn`, err)); });
  Hooks.on("updateWorldTime", () => { sweep().catch((err) => console.error(`${MOD} | affliction time`, err)); });
  // правка бейджа ГМом (клик вниз = Cleanse/Treat) применяет стадию; свои update помечены direct
  Hooks.on("updateItem", (item, changes, options) => {
    if (!isCarrier(item) || options?.[MOD]?.direct || !guardActiveGM() || !foundry.utils.hasProperty(changes ?? {}, "system.badge.value")) return;
    if (item.system.badge.value === metaOf(item).applied) return;   // клик «вверх» на последней стадии: ничего не изменилось
    // урон — только при росте стадии: снижение бейджа ГМом (лечение) урона не наносит
    applyStage(item, item.system.badge.value, { damage: item.system.badge.value > (metaOf(item).applied ?? 0) }).catch((e) => console.error(`${MOD} | affliction badge`, e));
  });
  Hooks.on("createItem", (item) => { if (isCarrier(item)) track(item.parent); });
  // носитель снят (в т.ч. откатом): созданное его стадиями уходит следом
  Hooks.on("deleteItem", (item) => {
    const m = metaOf(item);
    if (m && item.parent && guardActiveGM()) removeByKey(item.parent, `affl:${m.slug}:`).catch((e) => console.error(`${MOD} | affliction delete`, e));
  });
}
