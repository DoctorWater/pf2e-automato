// Исполняется ТОЛЬКО на клиенте активного ГМа. Записи на актёре сериализованы queue("actor:<uuid>").
// ВАЖНО: queue не реентерабелен — вызывающий (zone.hold и т.п.) НЕ должен сам держать queue("actor:"+uuid)
// вокруг applyCondition/applyEffect/removeByKey, иначе зависнет. Очередь "msg:<id>" apply не берёт (её держит вызывающий).
import { MOD, L, DEGREES, flagPath, sluggify, queue, forcedDelete, socket, ENDS_EARLY, sharedDialog } from "./util.mjs";
import { runMacros } from "./macros.mjs";
import { effectSource, messageTargets } from "./builtin/lib.mjs";
import { card } from "./card.mjs";
import { inRange } from "./range.mjs";
import { resolveFormula, isZeroFormula, isActiveStep, DAMAGE_TYPES } from "./rules.mjs";
import { testPredicate } from "./predicate.mjs";
import { setSource, dropSource, visionActive } from "./vision.mjs";
import { escapeDC, offerEscape } from "./escape.mjs";
import { repeatMeta, sameCarrier } from "./repeat.mjs";
import { forcedMove, undoMove, areaPoint } from "./move.mjs";
import { rulesOfMods, textOfMods, inlineSlug } from "./inline-effect.mjs";
import { afflictionStep, afflictionUndo, afflictionUnmake, afflictionRestore } from "./affliction-run.mjs";
import { coatStep, coatArm, coatUnarm, coatUnmake } from "./coat.mjs";
import * as hold from "./hold.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const metaOf = (item) => item?.flags?.[MOD]?.meta;
const notify = (key, data) => globalThis.ui?.notifications?.warn?.(L(key, data));
const noted = new Set();   // moveSkip.noPoint/noOrigin: один тост на сообщение, не на цель и шаг
export const noteOnce = (message, kind, data) => { const k = `${message?.id}:${kind}`; if (!noted.has(k)) { noted.add(k); notify(`moveSkip.${kind}`, data); } };

export function findByKey(actor, key) {
  return key ? actor.items.find((i) => metaOf(i)?.key === key) ?? null : null;
}

/** Формула дедупа эффекта (§1.4): тот же источник + тот же автор, либо совпал meta.key. byActorUuid==null — автор не важен. */
export function hasEffect(actor, uuid, byActorUuid, key = null) {
  if (key && findByKey(actor, key)) return true;
  return actor.items.some((i) => i.type === "effect" && i._stats?.compendiumSource === uuid
    && (byActorUuid == null || i.system?.context?.origin?.actor === byActorUuid));
}

const withMeta = (data, meta) => { data.flags ??= {}; data.flags[MOD] = { ...data.flags[MOD], meta }; };

/** Автор срока и цель созданного эффекта. pf2e считает turn-start/turn-end по ходу context.origin.actor: для of:"target" автором срока делаем получателя. */
function timedWho(actor, d, ctx) {
  const tToken = ctx.target ?? actor.getActiveTokens(true, true)[0];
  const who = d.of === "target" ? { actor: actor.uuid, token: tToken?.uuid, item: ctx.originItem?.uuid }
    : { actor: ctx.originActor?.uuid, token: ctx.originToken?.uuid, item: ctx.originItem?.uuid };
  return { tToken, who };
}

/**
 * Inline-эффект шага (`effect: {mods}`): эффект pf2e создаётся на лету из кубиков (inline-effect.mjs) со сроком шага (обязателен, of — чей ход считает).
 * Идемпотентность — по meta.key (как у состояний со сроком); откат — общий (op created). Имя «Эффект: <предмет>», slug детерминирован (af-<slug предмета>).
 */
export function applyInlineEffect(actor, spec /* {mods, duration} */, meta = {}, ctx = {}) {
  return queue(`actor:${actor.uuid}`, async () => {
    if (findByKey(actor, meta.key)) return { op: "skipped" };
    const d = spec.duration, item = ctx.originItem;
    const { tToken, who } = timedWho(actor, d, ctx);
    const t = (k, data) => L(k, data);
    const list = textOfMods(spec.mods, { t });
    const data = effectSource({
      name: L("inline.name", { name: item?.name ?? "?" }), img: item?.img, rules: rulesOfMods(spec.mods),
      description: `<p>${esc(L("workshop.desc.prefix", { list }))}</p>${who.item ? `<p>@UUID[${who.item}]</p>` : ""}`,
      duration: { value: typeof d.value === "string" ? (await new Roll(d.value).evaluate()).total : d.value, unit: d.unit, expiry: d.expiry ?? null }, origin: who, target: { actor: actor.uuid, token: tToken?.uuid }
    });
    data.system.slug = inlineSlug(item?.slug ?? sluggify(item?.name));
    const valid = globalThis.CONFIG?.PF2E?.Item?.documentClasses?.effect?.validTraits ?? {};
    if (item) data.system.traits = { value: (item.system?.traits?.value ?? []).filter((x) => x in valid) };
    withMeta(data, meta);
    const [created] = await actor.createEmbeddedDocuments("Item", [data]);
    return created ? { op: "created", item: created } : { op: "skipped" };
  });
}

/**
 * Состояние с длительностью: эффект-обёртка pf2e + GrantItem состояния (значение — алтерацией badge-value, она применяется один раз при выдаче).
 * Снимается вместе с обёрткой (cascade). Обычные состояния обёртка держит (grantee restrict — ГМ не удалит состояние, пока жива обёртка);
 * убывающие и кончающиеся досрочно (ENDS_EARLY) — detach: ГМ уменьшает/снимает их вручную, а обёртка по истечении срока снимет остаток.
 * «Шок на срок» (stunned без значения): в имени числа нет; значение — 4 на раунд срока: pf2e само значение не убавляет, ГМ (или модуль) убавляет вручную в начале хода цели, и остатка должно хватать на запрет реакций до снятия обёртки. Не restrict: убавление до нуля ГМ вправе снять сам (иначе RemovalPrevented).
 * Носитель повтора (meta.repeat) — cascade: конец выданного состояния уносит и обёртку (иначе пустая обёртка слала бы карточки вечно).
 */
const STUN_ROUNDS = { rounds: 1, minutes: 10, hours: 600, days: 14400 };
/** Значение под «шок на срок»: 4 на каждый раунд срока (d.value — уже брошенное число); потолок 99. */
const stunValue = (d) => Math.min(99, 4 * d.value * (STUN_ROUNDS[d.unit] ?? 1));

async function createTimed(actor, spec, meta, ctx, base) {
  const d = spec.duration, valued = !!base.system?.value?.isValued;
  const forStun = sluggify(spec.slug) === "stunned" && spec.value == null;   // шок на срок
  const dur = typeof d.value === "string" ? (await new Roll(d.value).evaluate()).total : d.value;   // срок бросаем до расчёта значения
  // getCondition() отдаёт копию без uuid — источник в компендиуме берём из _stats/sourceId
  const uuid = base.uuid ?? base._stats?.compendiumSource ?? base.sourceId;
  const grant = { key: "GrantItem", uuid, onDeleteActions: { grantee: meta.repeat ? "cascade" : ENDS_EARLY.has(sluggify(spec.slug)) ? "detach" : "restrict" },
    ...(valued && { alterations: [{ mode: "override", property: "badge-value", value: spec.value ?? (forStun ? stunValue({ ...d, value: dur }) : 1) }] }) };
  const { tToken, who } = timedWho(actor, d, ctx);
  const data = effectSource({
    name: `${base.name}${valued && !forStun ? ` ${spec.value ?? 1}` : ""}`, img: base.img, rules: [grant],
    description: who.item ? `<p>@UUID[${who.item}]</p>` : "",   // ссылка на источник: оговорки предмета (лишнее действие Haste только на…) не теряются
    duration: { value: dur, unit: d.unit, expiry: d.expiry ?? null }, origin: who, target: { actor: actor.uuid, token: tToken?.uuid }
  });
  withMeta(data, meta);
  const [item] = await actor.createEmbeddedDocuments("Item", [data]);
  return item ? { op: "created", item } : { op: "skipped" };   // pf2e выкинул документ (иммунитет к состоянию)
}

// при активном Vision видимость — только метками матрицы, без состояний на актёрах
const SIGHT_CONDITIONS = new Set(["concealed", "hidden", "undetected", "unnoticed", "observed"]);

/**
 * policy "reduce": действующее значение состояния падает на n, на нуле состояние снимается (Аура отваги). Нет состояния, оно без значения или выдано другим предметом — пропуск.
 * Вызывается внутри очереди актёра (applyCondition). -> {op:"raised", item, prev, key} | {op:"removed", slug, prev, key} | {op:"skipped"}
 */
async function reduceCondition(actor, slug, n, meta) {
  const c = actor.itemTypes.condition.find((x) => x.slug === slug && !x.isLocked && !x.grantedBy);
  const cur = c?._source?.system?.value?.value ?? c?.system?.value?.value ?? null;
  if (cur == null) return { op: "skipped" };
  if (cur - n >= 1) {
    await game.pf2e.ConditionManager.updateConditionValue(c.id, actor, cur - n);
    return { op: "raised", item: c, prev: cur, key: meta.key };   // откат возвращает прежнее значение (как у поднятого)
  }
  await actor.decreaseCondition(c, { forceRemove: true });
  return actor.itemTypes.condition.some((x) => x.slug === slug) ? { op: "skipped" } : { op: "removed", slug, prev: cur, key: meta.key };
}

export function applyCondition(actor, spec /* {slug,value,policy,duration?} */, meta = {}, ctx = {}) {
  if (SIGHT_CONDITIONS.has(sluggify(spec.slug)) && visionActive()) return Promise.resolve({ op: "skipped", reason: "vision" });
  return queue(`actor:${actor.uuid}`, async () => {
    if (findByKey(actor, meta.key)) return { op: "skipped" };
    const slug = sluggify(spec.slug);
    const CM = game.pf2e.ConditionManager;
    if (spec.duration) {
      const b = CM.getCondition(slug);
      if (!b) throw new Error(`applyCondition: неизвестное состояние "${spec.slug}"`);
      return createTimed(actor, spec, meta, ctx, b);
    }
    if (spec.policy === "reduce") return reduceCondition(actor, slug, spec.value ?? 1, meta);
    const policy = spec.policy ?? "max";
    // зона всегда создаёт свою копию (meta.key "zone:<uuid>"), остальное работает с уже существующим состоянием
    const existing = meta.source === "zone" ? null : actor.itemTypes.condition.find((c) => c.slug === slug && !c.isLocked && !c.grantedBy);   // выданное обёрткой-сроком не повышаем: истечёт вместе с чужим значением
    if (existing) {
      const cur = existing._source?.system?.value?.value ?? existing.system?.value?.value ?? null;
      if (cur === null) return { op: "skipped" };   // не valued
      const want = spec.value ?? 1;
      const next = policy === "add" ? cur + want : want;
      if (next <= cur) return { op: "skipped" };
      await CM.updateConditionValue(existing.id, actor, next);
      return { op: "raised", item: existing, prev: cur };
    }
    const base = CM.getCondition(slug);
    if (!base) throw new Error(`applyCondition: неизвестное состояние "${spec.slug}"`);
    const data = base.toObject();
    if (data.system.value?.isValued) data.system.value.value = spec.value ?? 1;
    withMeta(data, meta);
    const [item] = await actor.createEmbeddedDocuments("Item", [data]);
    return item ? { op: "created", item } : { op: "skipped" };   // pf2e выкинул документ (иммунитет к состоянию)
  });
}

/**
 * Снять состояние целиком (шаг removeCondition: Встать, Стабилизация). Выданное другим предметом и заблокированное не трогаем (как applyCondition);
 * не исчезло после удаления — skipped. Снятие dying по правилам pf2e: Раненый +1, при 0 ОЗ — Без сознания (его держал GrantItem dying и ушёл с ним, без него pf2e считает существо мёртвым).
 * -> {op:"removed", slug, prev, also?: [{slug, prev}]} | {op:"skipped"}. also — созданное/поднятое попутно: откат возвращает.
 */
export async function removeCondition(actor, slug) {
  const r = await queue(`actor:${actor.uuid}`, async () => {
    const c = actor.itemTypes.condition.find((x) => x.slug === slug && !x.isLocked && !x.grantedBy);
    if (!c) return { op: "skipped" };
    const prev = c._source?.system?.value?.value ?? c.system?.value?.value ?? null;
    await actor.decreaseCondition(c, { forceRemove: true });
    if (actor.itemTypes.condition.some((x) => x.slug === slug)) return { op: "skipped" };   // не удалилось
    return { op: "removed", slug, prev };
  });
  if (r.op !== "removed" || slug !== "dying") return r;
  const also = [];
  const hp = actor.hitPoints?.value ?? actor.system?.attributes?.hp?.value;
  if (hp === 0 && !actor.itemTypes.condition.some((x) => x.slug === "unconscious")) {
    const u = await applyCondition(actor, { slug: "unconscious", policy: "max" });
    if (u.op === "created") also.push({ slug: "unconscious", prev: null });
  }
  const w = await applyCondition(actor, { slug: "wounded", value: 1, policy: "add" });
  if (w.op === "created") also.push({ slug: "wounded", prev: null });
  else if (w.op === "raised") also.push({ slug: "wounded", prev: w.prev });
  return also.length ? { ...r, also } : r;
}

/** Продолжительный урон как у pf2e (applyDamage / PersistentDamageEditor): состояние persistent-damage с system.persistent; иммунитеты и сопротивления учтёт pf2e при броске. */
/** vars: {rank, level, actorLevel} — для формул с @item.rank / @item.level / @actor.level (подставляются и считаются здесь, в состояние уходит готовая формула). */
export function applyPersistent(actor, spec /* {formula,damageType,dc?} */, meta = {}, vars = {}) {
  return queue(`actor:${actor.uuid}`, async () => {
    if (findByKey(actor, meta.key)) return { op: "skipped" };
    if (!(spec.damageType in (CONFIG.PF2E?.damageTypes ?? {}))) throw new Error(`applyPersistent: неизвестный тип урона "${spec.damageType}"`);
    const base = game.pf2e.ConditionManager.getCondition("persistent-damage");
    if (!base) throw new Error("applyPersistent: нет состояния persistent-damage");
    const formula = spec.formula.includes("@") ? resolveFormula(spec.formula, vars) : spec.formula;
    if (!formula) throw new Error(`applyPersistent: формула "${spec.formula}" не считается`);
    if (isZeroFormula(formula)) { notify("apply.zeroPersistent", { name: actor.name }); return { op: "skipped", reason: "zero" }; }
    const data = foundry.utils.mergeObject(base.toObject(), { system: { persistent: { formula, damageType: spec.damageType, dc: spec.dc ?? 15 } } });
    withMeta(data, meta);
    const [item] = await actor.createEmbeddedDocuments("Item", [data]);
    return item ? { op: "created", item } : { op: "skipped" };   // pf2e выкинул документ (иммунитет к типу урона)
  });
}

/**
 * Шаг damage: бросок DamageRoll и применение через pf2e (applyDamage: сопротивления, слабости, щит, временные ОЗ), без карточки с кнопками.
 * Лечение (damageType "healing") — applyDamage с отрицательным числом, без IWR. vars — как у продолжительного урона (@item.rank, @actor.level).
 * -> { amount } | null (нулевая формула). Откат не предусмотрен: pf2e сам пишет в чат карточку полученного урона с кнопкой отмены.
 */
export async function dealDamage(actor, spec, vars = {}, token = null, degree = null) {
  const formula = spec.formula.includes("@") ? resolveFormula(spec.formula, vars) : spec.formula;
  if (!formula) throw new Error(`dealDamage: формула "${spec.formula}" не считается`);
  if (isZeroFormula(formula)) return null;
  const mult = spec.basic && degree != null ? BASIC_MULT[degree] ?? 1 : 1;   // degree — degreeOfSuccess pf2e: 0 крит. провал … 3 крит. успех
  if (!mult) return null;
  const DamageRoll = CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll");
  const heal = spec.damageType === "healing";
  const roll = await new DamageRoll(`(${formula})[${spec.damageType}]`).evaluate();
  token ??= actor.getActiveTokens?.(true, true)?.[0] ?? actor.prototypeToken;   // pf2e applyDamage читает token.name: без токена на сцене — прототип
  const dealt = mult === 1 ? roll : roll.alter(mult, 0);   // как у карточки урона pf2e: слагаемые умножаются, сопротивления считаются после
  if (heal) await actor.applyDamage({ damage: -roll.total, token, skipIWR: true });
  else await actor.applyDamage({ damage: dealt, token });
  return { amount: dealt.total };
}
const BASIC_MULT = [2, 1, 0.5, 0];

/** Подпись варианта choose: своя (label) -> перевод модуля choose.opt.<value> -> код. */
const optionLabel = (o) => o.label ?? (game.i18n?.has?.(`PF2E_AUTOMATO.choose.opt.${o.value}`) ? L(`choose.opt.${o.value}`) : o.value);

/** Игрок онлайн, владеющий актёром: ему показываем окна выбора, когда у сообщения нет автора (событие onEvent). */
const ownerPlayer = (actor) => globalThis.game?.users?.find?.((u) => !u.isGM && u.active && actor?.testUserPermission?.(u, "OWNER")) ?? null;

/**
 * Предзаполнить selection у ChoiceSet с массивом choices по предмету-источнику (так же делает pf2e-automations):
 * совпал value с UUID источника, либо предикат варианта называет slug/уровень источника (parent:origin:item:slug:X).
 * Берём только единственное совпадение; иначе pf2e сам спросит ГМа. Мутирует rules, возвращает число нерешённых ChoiceSet.
 */
export function presetChoiceSets(rules, { slug, uuids = [], level } = {}) {
  const quoted = (p, t) => JSON.stringify(p ?? []).includes(`:${t}"`);
  let unresolved = 0;
  for (const r of rules ?? []) {
    if (r?.key !== "ChoiceSet" || r.selection != null) continue;
    if (Array.isArray(r.choices)) {
      const hit = r.choices.filter((c) => uuids.includes(c.value)
        || (slug && quoted(c.predicate, `origin:item:slug:${slug}`)) || (level != null && quoted(c.predicate, `origin:item:level:${level}`)));
      if (hit.length === 1) { r.selection = hit[0].value; continue; }
    }
    if (!r.allowNoSelection) unresolved++;
  }
  return unresolved;
}


const effectsOf = (actor, { slug, uuid }) => actor.itemTypes.effect.filter((i) => (uuid ? i._stats?.compendiumSource === uuid : i.slug === slug || i.slug?.replace(/^(?:spell-)?(?:effect|stance)-/, "") === slug));   // slug — как у предмета (effect-rage) или как в roll options (rage)
/** Снять эффекты и вернуть их исходные данные (откат создаёт заново). */
async function dropEffects(list, actor = list[0]?.actor) {
  const all = list.map((e) => { const d = e.toObject(); delete d._id; return { e, d, id: e.id }; });
  const gone = [];
  for (const x of all) {
    await x.e.delete();
    if (!actor?.items?.has?.(x.id)) gone.push(x.d);   // pf2e молча отменяет удаление при onDelete:"restrict" — такой эффект не снят и в откат не идёт
  }
  return gone.length ? { op: "effRemoved", data: gone } : { op: "skipped" };
}

/** Шаг removeEffect {slug|uuid, of?}: снять эффекты получателя; of:"origin" — только созданные автором шага. */
export function removeEffect(actor, spec, ctx = {}) {
  return queue(`actor:${actor.uuid}`, async () => {
    // выданное другим предметом (grantedBy) и эффект ауры (fromAura) не трогаем — как состояния в removeCondition
    const hit = effectsOf(actor, spec).filter((e) => !e.grantedBy && !e.fromAura && (spec.of !== "origin" || e.system?.context?.origin?.actor === ctx.originActor?.uuid));
    return hit.length ? dropEffects(hit, actor) : { op: "skipped" };
  });
}

/** Шаг removeKey (карточка повтора): снять носитель с meta.key; выданное состояние уходит с обёрткой (granter cascade). -> effRemoved | skipped */
export function removeCarrier(actor, key) {
  return queue(`actor:${actor.uuid}`, async () => {
    const hit = actor.items.filter((i) => metaOf(i)?.key === key && metaOf(i)?.repeat);
    if (!hit.length) return { op: "skipped" };
    return dropEffects(hit, actor);
  });
}

const ROUNDS_IN = { rounds: 1, minutes: 10, hours: 600, days: 14400 };
/** Шаг extendEffect {slug, rounds}: продлить действующий эффект получателя на раунды (Затяжная композиция, Фортиссимо, Extend Boost). Срок в минутах/часах переводится в раунды; бессрочный и «до конца встречи» — пропуск. Повтор того же шага (meta.key) не продлевает дважды.
 * {cast:true, rounds} + spec.message (applyOps кладёт state.castMessage): вместо slug — эффект, выданный сотворением с этим id сообщения (Lingering Composition: аура на барде). */
export async function extendEffect(actor, spec, meta = {}) {
  // эффект сотворения ставит execUse того же сообщения: ждём его до очереди актёра (execUse сам берёт её — иначе тупик)
  if (spec.cast && spec.message) await queue(`use:${spec.message}`, () => {});
  return queue(`actor:${actor.uuid}`, async () => {
    // эффект сотворения лежит на барде или на цели сотворения (Allegro, Uplifting Overture)
    const holders = spec.cast ? [actor, ...(game.messages?.get(spec.message) ? messageTargets(game.messages.get(spec.message)).map((t) => t.actor) : [])] : [actor];
    const own = spec.cast ? [...new Set(holders)].flatMap((h) => h.itemTypes.effect.filter((e) => spec.message && metaOf(e)?.message === spec.message)) : effectsOf(actor, spec);
    const cur = own.find((e) => ROUNDS_IN[e.system?.duration?.unit] && e.system.duration.value >= 0);
    const done = cur?.flags?.[MOD]?.bumped ?? [];
    if (!cur && spec.cast) notify("apply.noCastEffect", { name: actor.name });
    if (!cur || !meta.key || done.includes(meta.key)) return { op: "skipped" };
    const d = cur.system.duration, prev = { value: d.value, unit: d.unit, expiry: d.expiry ?? null };
    // expiry передаём явно: pf2e при смене unit без expiry подставляет turn-start (EffectPF2e#_preUpdate)
    await cur.update({ "system.duration.value": d.value * ROUNDS_IN[d.unit] + spec.rounds, "system.duration.unit": "rounds", "system.duration.expiry": d.expiry ?? null, [`flags.${MOD}.bumped`]: [...done, meta.key] });
    return { op: "extended", item: cur, prev, key: meta.key };
  });
}

/** Шаг refundFocus: вернуть владельцу n очков фокуса (не выше максимума). -> сколько вернулось (0 — нечего) */
export function refundFocus(actor, n = 1) {
  return queue(`actor:${actor.uuid}`, async () => {
    const f = actor.system?.resources?.focus, value = f?.value ?? 0, delta = Math.min(n, (f?.max ?? value) - value);
    if (!(delta > 0)) return 0;
    await actor.update({ "system.resources.focus.value": value + delta });
    return delta;
  });
}

/** Шаг rollOption {domain, option, value?}: включить (по умолчанию) или выключить переключаемую опцию RollOption получателя (Mighty Rage, Quick-Tempered). Нет такого правила у актёра — пропуск с предупреждением. */
export function setRollOption(actor, spec) {
  return queue(`actor:${actor.uuid}`, async () => {
    const want = spec.value !== false, prev = !!actor.rollOptions?.[spec.domain]?.[spec.option];
    if (prev === want) return { op: "skipped" };
    // toggle возвращает новое значение (в т.ч. false), null — нет правила или отказ; не-toggleable бросает исключение — другие шаги не обрываем
    let res = null;
    try { res = await actor.toggleRollOption(spec.domain, spec.option, null, want); } catch (e) { console.warn(`${MOD} | rollOption`, e); }
    if (res === null || res === undefined) { notify("apply.noOption", { name: actor.name, option: spec.option }); return { op: "skipped" }; }
    return { op: "option", prev, domain: spec.domain, option: spec.option };
  });
}

/** Получатели «party» и «allies»: участники партий автора; союзники автора в радиусе range футов от его токена без преграды стен (как PA OnlyAllyWithinRange). */
const partyOf = (actor) => [...new Map([...(actor?.parties ?? [])].flatMap((p) => [...p.members]).map((m) => [m.uuid, m])).values()];
export function alliesIn(actor, token, range, rel = "isAllyOf", withSelf = false) {   // withSelf — сам автор тоже кандидат (если он не центр отсчёта)
  const src = token?.object, scene = token?.parent;
  if (!actor || !scene) return [];
  // сцена не на холсте (нет .object): расстояние по документам (центры токенов), стены проверить нечем — предупреждаем ГМа
  const live = !!src && scene === globalThis.canvas?.scene;
  const center = (t) => { const s = scene.grid.size; return { x: t.x + (t.width * s) / 2, y: t.y + (t.height * s) / 2 }; };
  const dist = (t) => (live && t.object ? src.distanceTo(t.object) : scene.grid.measurePath([center(token), center(t)]).distance);
  if (range != null && !live) notify("apply.noWalls", { name: token.name ?? "" });
  // range == null — вся сцена, без стен (выбор союзника/врага шагом choose)
  const hit = scene.tokens.filter((t) => t.actor && (t.actor === actor ? withSelf && token.actor !== actor : actor[rel](t.actor)) && (range == null || dist(t) <= range)
    && !(range != null && live && t.object && CONFIG.Canvas.polygonBackends.move.testCollision(t.object.center, src.center, { type: "move", mode: "any", ...(token.level && token.parent?.levels?.get?.(token.level) && { level: token.parent.levels.get(token.level) }) }))).map((t) => t.actor);
  return [...new Map(hit.map((a) => [a.uuid, a])).values()];
}

/** Набор roll options для `when` (как getRollOptions у pf2e-automations): опции броска и origin сообщения + outcome + цель (target:*) + опции автора и предмета. */
async function whenOptions({ use, message, selfActor, targetDoc, originItem, degree, rollOptions }) {
  const set = new Set([...(rollOptions ?? []), ...(use.rollOptions ?? []), ...(message.flags?.pf2e?.origin?.rollOptions ?? [])]);   // use.rollOptions — сообщение активации (без origin)
  if (degree != null) set.add(`outcome:${DEGREES[degree]}`);
  const first = inRange(use.targets)[0]?.uuid;
  const t = actorOf(targetDoc ?? (first ? await fromUuid(first) : null));
  if (t) { set.add("target"); for (const o of t.getSelfRollOptions?.("target") ?? []) set.add(o); if (selfActor && t.uuid === selfActor.uuid) set.add("target:self"); }   // target:self — автор действует на самого себя (Возложение рук: бонус к КБ только другому)
  for (const o of selfActor?.getRollOptions?.() ?? []) set.add(o);
  for (const o of originItem?.getRollOptions?.("item") ?? []) set.add(o);
  return set;
}
const whenPasses = (when, opts) => (globalThis.game?.pf2e?.Predicate?.test ? game.pf2e.Predicate.test(when, opts) : testPredicate(when, opts));

/** ctx: { originActor, originToken, originItem (документы), rollOptions?, target (TokenDocument)?, roll?: {total, degreeOfSuccess} — pf2e по нему сам выбирает вариант ChoiceSet по исходу } */
export function applyEffect(actor, spec /* {uuid, badge?} */, meta = {}, ctx = {}) {
  return queue(`actor:${actor.uuid}`, async () => {
    // badge:"decrement": значок существующего эффекта −1; на минимуме эффект снимается (откат возвращает его из data); нет эффекта — шаг пропущен, копия не создаётся
    if (spec.badge === "decrement") {
      const cur = actor.itemTypes.effect.find((i) => i._stats?.compendiumSource === spec.uuid);
      const done = cur?.flags?.[MOD]?.bumped ?? [];
      if (!cur || !meta.key || done.includes(meta.key)) return { op: "skipped" };
      const b = cur.system.badge;
      if (b?.type === "counter" && b.value - 1 >= (b.min ?? 1)) {
        const prev = b.value;
        await cur.update({ "system.badge.value": prev - 1, [`flags.${MOD}.bumped`]: [...done, meta.key] });
        return { op: "badged", item: cur, prev, key: meta.key };
      }
      return dropEffects([cur]);
    }
    // badge:"increment": такой эффект уже есть — значок растёт на 1 (EffectPF2e.increase); ключ шага в флаге не даёт прибавить дважды при повторе
    if (spec.badge === "increment") {
      if (findByKey(actor, meta.key)) return { op: "skipped" };   // эффект создан этим же шагом: повтор (runUse, второй клик, вторая вкладка) значок не трогает
      const cur = actor.itemTypes.effect.find((i) => i._stats?.compendiumSource === spec.uuid);
      if (cur) {
        const done = cur.flags?.[MOD]?.bumped ?? [];
        const b = cur.system.badge;
        if (!meta.key || done.includes(meta.key) || b?.type !== "counter" || (b.max != null && !b.loop && b.value >= b.max)) return { op: "skipped" };   // упёрлись в максимум значка — прибавлять некуда
        const prev = cur.system.badge.value;
        if (spec.by > 1) await cur.update({ "system.badge.value": b.max != null ? Math.min(b.max, prev + spec.by) : prev + spec.by });   // шаг больше 1 (Кража тени: +2)
        else await cur.increase();
        await cur.update({ [`flags.${MOD}.bumped`]: [...done, meta.key] });
        return { op: "badged", item: cur, prev, key: meta.key };
      }
    }
    // replace: прежний эффект того же источника и автора заканчивается до создания нового; хуки удаления и создания встают в очередь актёра в этом порядке (gear: броня возвращается до выдачи новой)
    if (spec.replace && !(meta.key && findByKey(actor, meta.key))) {
      // «any previous … ends»: прежний эффект снимается с любого актёра (Sweet Dream, Bit of Luck), а не только с текущей цели; без автора — только с этой цели
      const pool = ctx.originActor == null ? [actor] : [actor, ...[...(game.actors ?? []), ...(game.scenes?.contents ?? []).flatMap((s) => s.tokens.filter((t) => !t.actorLink).map((t) => t.actor))].filter((a) => a && a !== actor)];
      for (const a of pool) for (const e of a.itemTypes.effect.filter((i) => i._stats?.compendiumSource === spec.uuid && (ctx.originActor == null || i.system?.context?.origin?.actor === ctx.originActor.uuid))) await e.delete();
    }
    const own = spec.duration?.of === "target";   // срок считает ход самого получателя (метка «до конца вашего хода»): автор эффекта — получатель, иначе pf2e отсчитает ход заклинателя
    // у own автор срока — получатель, у всех меток он один: различаем по meta.by (метка Убежища привязана к защищённому, второй защищённый ставит свою)
    if (own ? (meta.key && findByKey(actor, meta.key)) || actor.items.some((i) => i.type === "effect" && i._stats?.compendiumSource === spec.uuid && i.system?.context?.origin?.actor === actor.uuid && (metaOf(i)?.by ?? null) === (meta.by ?? null))
      : hasEffect(actor, spec.uuid, ctx.originActor?.uuid, meta.key)) return { op: "skipped" };
    const src = await fromUuid(spec.uuid);
    if (!src || src.type !== "effect") { console.warn(`${MOD} | applyEffect: ${spec.uuid} не эффект`); return { op: "skipped" }; }
    const data = src.toObject();
    delete data._id;
    data._stats = { ...data._stats, compendiumSource: spec.uuid };
    const valid = CONFIG.PF2E.Item.documentClasses.effect.validTraits;
    const rollOptions = ctx.rollOptions ?? ctx.originItem?.getOriginData?.().rollOptions ?? [];
    if (spec.start > 1 && data.system.badge?.type === "counter") data.system.badge.value = spec.start;   // значок нового эффекта (иначе — из источника)
    data.system = foundry.utils.mergeObject(data.system, {
      context: {
        origin: { actor: ctx.originActor?.uuid ?? null, token: ctx.originToken?.uuid ?? null, item: ctx.originItem?.uuid ?? null, spellcasting: null, rollOptions },
        target: { actor: actor.uuid, token: (ctx.target ?? actor.getActiveTokens(true, true)[0])?.uuid ?? null },
        roll: ctx.roll ?? null
      },
      ...(ctx.originItem && { traits: { value: (ctx.originItem.system?.traits?.value ?? []).filter((t) => t in valid) } })
    });
    if (own) { const o = data.system.context.origin; o.actor = actor.uuid; o.token = (ctx.target ?? actor.getActiveTokens(true, true)[0])?.uuid ?? null; }
    // уровень эффекта = круг сотворения: формулы @item.level (твёрдость Щита, бонус Защиты, руны) растут как при перетаскивании из карточки
    if (ctx.castRank != null && data.system.level) data.system.level.value = ctx.castRank;
    // срок шага (duration) заменяет срок эффекта; кубик («1d4» раундов) бросается здесь, expiry без указания берётся из эффекта
    if (spec.duration) {
      const d = spec.duration, value = typeof d.value === "string" ? (await new Roll(d.value).evaluate()).total : d.value;
      data.system.duration = { ...data.system.duration, value, unit: d.unit, expiry: d.expiry ?? data.system.duration?.expiry ?? null };
    }
    // метка TokenMark: без uuid pf2e берёт цель/запрос у ГМа (pf2e.mjs TokenMarkRuleElement.preCreate) — подставляем выбранного автором врага
    if (ctx.markUuid) for (const r of data.system.rules ?? []) if (r.key === "TokenMark" && !r.uuid) r.uuid = ctx.markUuid;
    if (ctx.choice != null) { const cs = (data.system.rules ?? []).find((r) => r.key === "ChoiceSet" && r.selection == null); if (cs) cs.selection = ctx.choice; }
    if (!(await chooseChoices(actor, data, ctx.chooser))) { notify("apply.noChoice", { name: data.name }); return { op: "skipped" }; }
    withMeta(data, meta);
    const [item] = await actor.createEmbeddedDocuments("Item", [data]);
    return item ? { op: "created", item } : { op: "skipped" };   // pf2e выкинул документ (иммунитет, отмена метки)
  });
}

/** ChoiceSet без выбора (напр. оружие для Рунного оружия): варианты считает pf2e на временном предмете (без окна),
 *  выбирает автор-игрок у себя (сокет pickChoice) либо, если игрока нет (user = null), ГМ — общим окном во всех своих вкладках;
 *  selection пишется в источник — pf2e при создании берёт её без запроса. false — отказ. */
const PICK_MS = 120000;
/** Окно выбора одного из choices [{value, label}]: у игрока-автора (user) или общее окно ведущего. -> value | null (закрыто, тайм-аут PICK_MS — очередь актёра ждёт ответа). */
export async function askChoice(user, title, prompt, choices) {
  const ask = user
    ? socket.executeAsUser("pickChoice", user.id, { title, prompt, choices: choices.map((c) => ({ value: c.value, label: c.label })) })
    : sharedDialog({ title, content: choiceHtml(prompt, choices), buttons: [{ action: "ok", label: L("apply.choose") }] })
      .then((r) => (r?.form ? choices[Number(r.form.choice)]?.value ?? null : null));
  let timer;
  try { return await Promise.race([ask, new Promise((r) => { timer = setTimeout(() => r(null), PICK_MS); })]); } finally { clearTimeout(timer); }
}

async function chooseChoices(actor, data, user) {
  const idx = (data.system.rules ?? []).flatMap((r, i) => (r.key === "ChoiceSet" && r.selection == null ? [i] : []));
  if (!idx.length) return true;
  const temp = new CONFIG.Item.documentClass(foundry.utils.deepClone(data), { parent: actor });
  const opts = new Set([actor.getRollOptions(), temp.getRollOptions("parent")].flat());
  for (const i of idx) {
    const re = temp.prepareRuleElements({ suppressWarnings: true }).find((r) => r.sourceIndex === i);   // у временного предмета pf2e правил не готовит
    const choices = re?.inflateChoices ? await re.inflateChoices(opts, []) : [];
    if (!choices.length) continue;   // считать нечего — пусть решает pf2e как обычно
    const prompt = re.prompt ? game.i18n.localize(re.prompt) : "";
    const value = choices.length === 1 ? choices[0].value : await askChoice(user, data.name, prompt, choices);
    if (value == null || !choices.some((c) => c.value === value)) return false;
    data.system.rules[i].selection = value;
  }
  return true;
}

/** Сокет, у игрока: окно выбора варианта по запросу ГМа. -> value | null. */
const choiceHtml = (prompt, choices) => {
  const esc = (x) => foundry.utils.escapeHTML(String(x ?? ""));
  return `${prompt ? `<p>${esc(prompt)}</p>` : ""}<select name="choice">${choices.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join("")}</select>`;
};

export async function pickChoice({ title, prompt, choices }) {
  if (!game.users.get(this?.socketdata?.userId)?.isGM) return null;
  const res = await foundry.applications.api.DialogV2.wait({
    window: { title }, classes: ["paf-dialog"], rejectClose: false,
    content: choiceHtml(prompt, choices),
    buttons: [{ action: "ok", label: L("apply.choose"), default: true, callback: (_e, b) => Number(b.form.elements.choice.value) }]
  });
  return Number.isInteger(res) ? choices[res]?.value ?? null : null;
}

/** Чистая: враждебны ли две стороны по disposition токенов (дружественный против прочих). */
export const opposed = (a, b) => (a > 0) !== (b > 0);

// иммунитет к типу урона (fire, sonic, void…) отменяет только урон, не состояние из того же эффекта; poison и mental — ещё и черты эффектов
const DAMAGE_ONLY = new Set(DAMAGE_TYPES.filter((t) => t !== "poison" && t !== "mental"));
/** Чистая: невосприимчив ли получатель к чертам источника (иммунитеты pf2e — по типу, напр. "mental"); damage — шаг урона (persistent), иначе иммунитет к чистому типу урона не в счёт. */
export const immuneToTraits = (immunities = [], traits = [], damage = false) => immunities.some((i) => traits.includes(i.type ?? i) && (damage || !DAMAGE_ONLY.has(i.type ?? i)));

/** Выбор в окнах ChoiceSet делает автор сообщения, если это игрок онлайн и владелец актёра-источника; иначе — ГМ (окно pf2e). */
export function chooserOf(message, originActor) {
  const u = message?.author;
  return u && !u.isGM && u.active && u.id !== globalThis.game?.user?.id && originActor?.testUserPermission?.(u, "OWNER") ? u : null;
}

const actorOf = (doc) => doc?.actor ?? doc ?? null;   // TokenDocument -> синтетический актёр

/** Выборы автора из сохранённых операций `chose` (value без actor — вариант `choice:<value>`, с actor — существо). */
export async function picksFromOps(ops = []) {
  const picks = { opts: new Set(), actor: null };
  for (const o of ops) {
    if (o.op !== "chose") continue;
    if (o.actor) picks.actor = actorOf(await fromUuid(o.actor)); else picks.opts.add(`choice:${o.value}`);
  }
  return picks;
}

/** Ранг сотворения для шагов: origin.castRank, у сообщения активации (без origin) — activation.rank из метки, затем ранг/уровень предмета. */
export const useRank = (message, originItem) => message.flags?.pf2e?.origin?.castRank ?? message.flags?.["pf2e-automato"]?.activation?.rank ?? originItem?.rank ?? originItem?.level ?? 1;

/**
 * Применить шаги Apply[] к цели/автору и записать state.*.applied.
 * ctx: { scope: "challenge"|"apply"|"derived", degree?, total?, stepKey?, target?: TokenDocument, originActor?, originToken?, originItem?, rollOptions?, region? }
 * Возвращает ops, созданные ЭТИМ вызовом ({op, item:uuid, prev?}); повтор = пусто (идемпотентно по meta.key).
 */
export async function applyOps(message, tokenKey, steps, ctx = {}) {
  const use = message.flags?.[MOD]?.use;
  const scope = ctx.scope ?? "apply";
  const tUuid = use.targets?.find((t) => t.key === tokenKey)?.uuid;
  const targetDoc = ctx.target ?? (tUuid ? await fromUuid(tUuid) : null);
  const originToken = ctx.originToken ?? (use.token ? await fromUuid(use.token) : null);
  // актёр токена: у несвязанного токена это синтетический актёр, и pf2e сверяет автора срока с combatant.actor именно с ним
  const selfActor = ctx.originActor ?? originToken?.actor ?? actorOf(await fromUuid(use.actor));
  const originItem = ctx.originItem ?? (use.item?.uuid ? await fromUuid(use.item.uuid) : null) ?? ((message.flags?.[MOD]?.activation ?? message.flags?.[MOD]?.cast) ? message.item : null);   // эфемерное заклинание активации по uuid не найти
  // карточка Воли удержанной атаки (state.event = `<атака>:<носитель>:<i>`): автор меток — защищённый, владелец носителя, а не бросающий нападающий
  const carrierUuid = String(use.state?.event ?? "").split(":")[1];
  const guardUuid = carrierUuid ? (await fromUuid(carrierUuid).catch(() => null))?.actor?.uuid ?? null : null;
  const ectx = { originActor: selfActor, originToken, originItem, rollOptions: ctx.rollOptions,
    roll: ctx.degree != null && Number.isFinite(ctx.total) ? { total: ctx.total, degreeOfSuccess: ctx.degree } : null,
    castRank: originItem?.type === "spell" ? (message.flags?.pf2e?.origin?.castRank ?? originItem.rank ?? null) : null,
    chooser: chooserOf(message, selfActor) ?? (message.author ? null : ownerPlayer(selfActor)) };
  // черты для иммунитета цели: предмет + черты самого испытания (облако яда: у носителя может не быть poison); все пути испытаний (onUse, зона, событие) несут его в use.rule.onUse.challenge
  const traits = [...(originItem?.system?.traits?.value ?? []), ...(scope === "challenge" ? use.rule?.onUse?.challenge?.traits ?? [] : [])];
  // переменные формул: круг (при сотворении — поднятый), уровень предмета (у заклинания это круг), уровень автора
  const rank = useRank(message, originItem);
  const persVars = { rank, level: originItem?.type === "spell" ? rank : originItem?.level ?? rank, actorLevel: selfActor?.level ?? 1 };
  const myDisp = originToken?.disposition ?? 1;
  const ops = [];

  // шаг на группу (party, allies) раскладывается по получателям: дальше всё как у одиночного; «chosen» — получатель известен после шага choose (ищется в цикле)
  const jobs = steps.flatMap((step, i) => (step.to === "self" || step.choose ? [selfActor] : step.to === "party" ? partyOf(selfActor) : step.to === "allies" ? alliesIn(selfActor, originToken, step.range) : step.to === "chosen" ? [null] : [actorOf(targetDoc)]).map((actor) => ({ i, step, actor })));
  let wopts = null;   // roll options для `when`: считаем один раз и только если есть такой шаг
  // выбор автора (шаг choose): вариант -> опция `choice:<value>` для when следующих шагов, существо -> получатель шагов to:"chosen". Общий на запись события (ctx.picks)
  // ctx.picks — общий на запись события; иначе восстанавливаем из сохранённых chose (self-шаги и шаги цели/степеней идут разными вызовами)
  const picks = ctx.picks ?? await picksFromOps(message.flags?.[MOD]?.use?.state?.apply?.self?.ops);
  const statePath = scope === "challenge" ? flagPath("use", "state", "challenge", "applied", tokenKey) : flagPath("use", "state", "apply", tokenKey);
  const doneOps = foundry.utils.getProperty(message, statePath)?.ops ?? [];   // ops уже исполненного: повтор шага без предмета (урон, снижение, выбор) по ключу пропускается

  // note — текст ГМу шёпотом. С `when` — только при истинном условии (в плане чата такие не показываем); в событиях и триггерах зоны (ctx.notes) — всегда: плана там нет
  for (const [i, step] of steps.entries()) {
    if (!step.note || !(step.when || ctx.notes)) continue;
    if (step.rank && (rank < (step.rank.min ?? 1) || rank > (step.rank.max ?? Infinity))) continue;
    const key = `${message.id}:note:${tokenKey}:${ctx.stepKey ?? (scope === "challenge" ? `c${ctx.degree}.${i}` : i)}`;
    if (doneOps.some((o) => o.key === key)) continue;
    if (step.when && !whenPasses(step.when, new Set([...(wopts ??= await whenOptions({ use, message, selfActor, targetDoc, originItem, degree: ctx.degree, rollOptions: ctx.rollOptions })), ...picks.opts]))) continue;
    ops.push({ op: "noted", key });
    const who = tokenKey !== "self" && targetDoc?.name ? `<b>${esc(targetDoc.name)}</b>: ` : "";
    await ChatMessage.create({ whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id), speaker: { alias: "pf2e-automato" }, content: card(who + esc(step.note), "", { title: esc(use.item?.name ?? use.rule?.label ?? ""), icon: "fa-note-sticky" }) });
  }

  for (const job of jobs) {
    const { i, step } = job;
    if (step.hold) { ops.push(...await holdStep(step.hold, message, use, ctx, scope === "challenge" ? `c${ctx.degree}.${i}` : `${i}`, doneOps)); continue; }
    const actor = step.to === "chosen" ? picks.actor : job.actor;
    if (!actor || !isActiveStep(step)) continue;   // note — только текст в блоке
    if (step.rank && (rank < (step.rank.min ?? 1) || rank > (step.rank.max ?? Infinity))) continue;   // круг сотворения вне границ шага
    if (step.when && !whenPasses(step.when, new Set([...(wopts ??= await whenOptions({ use, message, selfActor, targetDoc, originItem, degree: ctx.degree, rollOptions: ctx.rollOptions })), ...picks.opts]))) continue;   // условие предиката не выполнено
    if (step.visibility && !visionActive()) continue;   // без PF2e Vision — заметка (текст «вручную» даёт чат)
    if (step.to !== "self") {
      const hostile = opposed(myDisp, targetDoc?.disposition ?? 0);
      if (step.to === "target" && step.who && (step.who === "enemy") !== hostile) continue;
      if ((step.condition || step.effect || step.persistent) && immuneToTraits(actor.attributes?.immunities, traits, !!step.persistent && !step.condition && !step.effect)) { notify("apply.immune", { name: actor.name }); continue; }
    }
    if (step.unlessEffect && actor.items.some((it) => it.type === "effect" && it._stats?.compendiumSource === step.unlessEffect)) {
      notify("apply.alreadyImmune", { name: actor.name }); continue;
    }
    let markUuid = null;
    if (step.mark === "enemy") {
      const docs = await Promise.all(inRange(use.targets).map((t) => fromUuid(t.uuid)));
      const foes = docs.filter((d) => d && opposed(myDisp, d.disposition));
      if (foes.length !== 1) { notify("apply.needEnemy", { name: use.item?.name ?? "" }); continue; }
      markUuid = foes[0].uuid;
    }
    const stepKey = ctx.stepKey ?? (scope === "challenge" ? `c${ctx.degree}.${i}` : `${i}`);
    // проверка автора — бросок на каждую цель, и «self» считается по каждому броску; испытание — один бросок цели, self общий
    const selfKey = scope === "challenge" && use.rule?.onUse?.check && tokenKey !== "self" ? `self.${tokenKey}` : "self";
    const meta = {
      key: `${message.id}:${step.to === "self" ? selfKey : step.to === "target" ? tokenKey : `grp.${actor.uuid}`}:${stepKey}`,
      rank: ectx.castRank,
      source: scope, message: message.id, region: ctx.region?.uuid ?? null,
      origin: use.item?.uuid ?? null, by: guardUuid ?? selfActor?.uuid ?? null
    };
    if (step.choose) {
      const c = step.choose, prev = doneOps.find((o) => o.op === "chose" && o.key === meta.key);
      let value = prev?.value ?? null, chosen = prev?.actor ? actorOf(await fromUuid(prev.actor)) : null;
      if (!prev) {
        const title = originItem?.name ?? use.item?.name ?? "";
        if (c.from === "options") {
          const wset = new Set([...(wopts ??= await whenOptions({ use, message, selfActor, targetDoc, originItem, degree: ctx.degree, rollOptions: ctx.rollOptions })), ...picks.opts]);
          const choices = c.options.filter((o) => !o.when || whenPasses(o.when, wset)).map((o) => ({ value: o.value, label: optionLabel(o) }));
          if (!choices.length) continue;
          value = choices.length === 1 ? choices[0].value : await askChoice(ectx.chooser, title, c.prompt ?? L("apply.prompt.options"), choices);
        } else {
          const centre = c.of === "target" ? targetDoc : originToken;   // of:"target" — расстояние от цели броска/карточки
          const list = alliesIn(selfActor, centre, c.range ?? null, c.from === "enemies" ? "isEnemyOf" : "isAllyOf", !!c.withSelf);
          if (!list.length) { notify("apply.noCandidates", { name: title }); continue; }
          const uuid = await askChoice(ectx.chooser, title, c.prompt ?? L(`apply.prompt.${c.from}`), list.map((a) => ({ value: a.uuid, label: a.token?.name ?? a.name })));
          chosen = list.find((a) => a.uuid === uuid) ?? null;
          value = chosen?.uuid ?? null;
        }
        if (value == null) continue;   // окно закрыто: ничего не выбрано, следующие шаги с выбором пропускаются
        ops.push({ op: "chose", key: meta.key, value, ...(chosen && { actor: chosen.uuid }) });
      }
      if (c.from === "options") picks.opts.add(`choice:${value}`); else picks.actor = chosen;
      continue;
    }
    if (step.damage) {
      // Журнал нанесённого урона (state.damaged) переживает откат записи: pf2e откатывает урон своей карточкой, повтор шага его не повторяет.
      // Степень в ключе не участвует: переброс испытания после отката не бьёт второй раз.
      const dkey = scope === "challenge" && !ctx.stepKey ? `${meta.key.slice(0, -stepKey.length)}c.${i}` : meta.key;
      // ctx.msgQueued: вызывающий (applyByDegree) уже держит queue("msg:") — queue не реентерабелен
      const r = await (ctx.msgQueued ? (f) => f() : (f) => queue(`msg:${message.id}`, f))(async () => {
        const log = foundry.utils.getProperty(message, flagPath("use", "state", "damaged")) ?? [];
        if (doneOps.some((o) => o.key === meta.key) || log.includes(dkey)) return null;
        const dealt = await dealDamage(actor, step.damage, persVars, step.to === "target" && targetDoc?.actor ? targetDoc : step.to === "self" ? originToken : null, ctx.degree ?? null);
        if (dealt) await message.update({ [flagPath("use", "state", "damaged")]: [...log, dkey] });   // сразу после урона, не в конце вызова
        return dealt;
      });
      if (r) ops.push({ op: "damaged", actor: actor.uuid, amount: r.amount, key: meta.key });
      continue;
    }
    if (step.move) {
      // Ключ без степени (как dkey у урона): переброс успех → крит не двигает второй раз. Очередь msg: не берём — вызывающий её уже держит.
      const mkey = scope === "challenge" && !ctx.stepKey ? `${meta.key.slice(0, -stepKey.length)}c.${i}` : meta.key;
      if (doneOps.some((o) => o.op === "moved" && o.key === mkey)) continue;
      // from:"point" — центр области этого использования; нет области/формы без центра — откат на токен автора с заметкой
      const point = step.move.from === "point" ? areaPoint(use, ctx.region) : null;
      if (step.move.from === "point" && !point) noteOnce(message, "noPoint", { name: use.item?.name ?? "", target: targetDoc?.name ?? "" });
      const r = await forcedMove(targetDoc, originToken, step.move, point);
      if (r.skipped) {
        const d = { name: use.item?.name ?? "", target: targetDoc?.name ?? "" };
        if (r.skipped === "noOrigin") noteOnce(message, "noOrigin", d); else notify(`moveSkip.${r.skipped}`, d);   // noOrigin одинаков для всех целей — один тост
        ops.push({ op: "moved", skipped: r.skipped, key: mkey });   // строка отработана; причина — уведомлением ГМу
      } else ops.push({ op: "moved", token: targetDoc.uuid, from: r.from, to: r.to, id: r.id, key: mkey });
      continue;
    }
    if (step.visibility) {
      const v = step.visibility, sourceKey = `auto:${meta.key}`;
      const [observer, subject] = [step.to === "self" ? originToken : targetDoc, v.of === "self" ? originToken : targetDoc];
      const scene = observer?.parent;
      const prevOps = foundry.utils.getProperty(message, scope === "challenge" ? flagPath("use", "state", "challenge", "applied", tokenKey) : flagPath("use", "state", "apply", tokenKey))?.ops;
      if (prevOps?.some((o) => o.key === sourceKey)) continue;   // повтор — источник уже стоит (или шаг уже отмечен пропущенным)
      // пропуск пишем в ops, чтобы строка считалась отработанной; причина — уведомлением ГМу
      const skip = !scene || !subject ? "noToken" : subject.parent !== scene ? "scene"
        : (await setSource(scene, sourceKey, [{ observerId: observer.id, targetId: subject.id, level: v.level }],
          { label: use.item?.name ?? use.rule?.label, until: v.until, subjectId: subject.id })) !== "ok" ? "refused" : null;   // "no-combat": срок «до хода» вне боя
      if (skip) notify(`visSkip.${skip}`, { name: use.item?.name ?? "" });
      ops.push(skip ? { op: "vis", skipped: skip, key: sourceKey } : { op: "vis", scene: scene.id, key: sourceKey });
      continue;
    }
    if (step.removeCondition) {
      const r = await removeCondition(actor, step.removeCondition.slug);
      if (r.op === "removed") ops.push({ op: "removed", slug: r.slug, actor: actor.uuid, ...(r.prev != null && { prev: r.prev }), ...(r.also && { also: r.also }) });
      continue;
    }
    if (step.refundFocus) {   // очки фокуса самого заклинания (Lingering Composition: 1); повтор шага по ключу не возвращает второй раз
      const n = Number(originItem?.system?.cast?.focusPoints) || 1, done = doneOps.some((o) => o.key === meta.key), delta = done ? 0 : await refundFocus(actor, n);
      if (!done) ops.push({ op: "focus", actor: actor.uuid, delta, key: meta.key });   // и при delta 0 (запас полный): карточка отмечена, поздний клик не вернёт очко задним числом
      continue;
    }
    if (step.affliction || step.stageDelta) {   // недуг: наложение и сдвиг стадии (affliction-run.mjs); носитель — свой эффект с meta.affliction
      const r = await afflictionStep(actor, step, { message, meta, scope, use, tokenKey, degree: ctx.degree, selfActor, originToken, originItem, traits });
      if (r.op !== "skipped") ops.push({ op: r.op, ...(r.item && { item: r.item.uuid }), ...(r.data && { actor: actor.uuid, data: r.data }), ...(r.prev != null && { prev: r.prev }), ...(r.made?.length && { made: r.made }) });
      continue;
    }
    if (step.coat) {   // яд на оружие (coat.mjs): ops пишет сам шаг (замена: effRemoved + coatMade)
      ops.push(...(await coatStep(actor, step, { meta, use, originItem, selfActor, originToken, chooser: ectx.chooser, done: doneOps.some((o) => o.op === "coatMade" && o.key === meta.key) })).ops);
      continue;
    }
    if (step.coatArm) {   // взвод носителя: Удар попал по цели события (ctx.target); носитель — предмет, чьё правило исполняется
      const r = ctx.originItem?.actor ? await coatArm(ctx.originItem, ctx.target?.uuid) : { op: "skipped" };
      if (r.op === "coatArm") ops.push({ op: "coatArm", item: r.item.uuid, actor: actor.uuid, key: metaOf(r.item)?.key });
      continue;
    }
    const tgt = step.to === "target" ? targetDoc : null;
    if (step.condition?.policy === "reduce" && doneOps.some((o) => o.key === meta.key)) continue;
    let dur = step.duration;
    if (step.repeat) {   // носитель — всегда свой документ с meta.repeat; чужой не трогаем (иначе повтор снимет чужое)
      if (findByKey(actor, meta.key)) continue;   // повтор того же шага
      const ch = scope === "challenge" ? use.rule?.onUse?.challenge ?? use.rule?.onUse?.check : null;
      const dc = step.repeat.dc ?? (scope === "challenge" ? use.dc ?? use.state?.challenge?.results?.[tokenKey]?.dc ?? await (await import("./saves.mjs")).resolveDC(use) : null);
      if (dc == null) { notify("apply.repeatNoDC", { name: actor.name }); continue; }
      meta.repeat = repeatMeta(step.repeat, ch, dc);
      const taken = actor.items.some((it) => sameCarrier(meta, metaOf(it)))
        || (step.condition ? actor.itemTypes.condition.some((c) => c.slug === sluggify(step.condition.slug) && !c.isLocked && !c.grantedBy) : step.effect.mods ? false : hasEffect(actor, step.effect.uuid, selfActor?.uuid));
      if (taken) { notify("apply.repeatTaken", { name: actor.name }); continue; }
      if (step.condition) dur ??= { value: -1, unit: "unlimited", expiry: null, of: "origin" };
    }
    const r = step.persistent ? await applyPersistent(actor, step.persistent, meta, persVars)
      : step.condition
      ? await applyCondition(actor, dur ? { ...step.condition, duration: dur } : step.condition, meta, { ...ectx, target: tgt })
      : step.removeKey ? await removeCarrier(actor, step.removeKey)
      : step.removeEffect ? await removeEffect(actor, step.removeEffect, ectx)
      : step.extendEffect ? await extendEffect(actor, step.extendEffect.cast ? { ...step.extendEffect, message: use.state?.castMessage } : step.extendEffect, meta)
      : step.rollOption ? await setRollOption(actor, step.rollOption)
      : step.effect.mods ? await applyInlineEffect(actor, { ...step.effect, duration: step.duration }, meta, { ...ectx, target: tgt })
      : await applyEffect(actor, step.duration ? { ...step.effect, duration: step.duration } : step.effect, meta, { ...ectx, markUuid, choice: step.choice, target: tgt });
    if (step.escape && r.op === "created") {   // жертва вправе освободиться проверкой: шёпот с кнопками (вторичен — сбой не должен терять ops)
      try {
        let spellDc = null, statDc = null;
        try {
          spellDc = originItem?.spellcasting?.statistic?.withRollOptions?.({ item: originItem })?.dc?.value ?? null;
          statDc = step.escape.dcStat && step.escape.dcStat !== "spell" ? selfActor?.getStatistic?.(step.escape.dcStat)?.dc?.value ?? null : null;
        } catch { /* СЛ спросим у жертвы */ }
        await offerEscape(actor, r.item, step.escape, escapeDC(step.escape, { spellDc, statDc, useDc: scope === "challenge" ? use.dc : null }), originItem);
      } catch (e) { console.error(`${MOD} | escape`, e); }
    }
    if (r.reason === "vision") ops.push({ op: "vis", skipped: "marks", key: meta.key });   // видимость — метками: строка отработана
    else if (r.op !== "skipped" && r.op !== "pending") ops.push({ op: r.op, ...(r.item && { item: r.item.uuid }), ...((r.data || r.domain || r.slug) && { actor: actor.uuid }), ...(r.slug && { slug: r.slug }), ...(r.data && { data: r.data }), ...(r.domain && { domain: r.domain, option: r.option }), ...(r.prev != null && { prev: r.prev }), ...(r.key && { key: r.key }) });
  }

  if (ops.length) {
    const path = scope === "challenge" ? flagPath("use", "state", "challenge", "applied", tokenKey) : flagPath("use", "state", "apply", tokenKey);
    const prev = foundry.utils.getProperty(message, path) ?? null;
    await message.update({ [path]: { ops: [...(prev?.ops ?? []), ...ops], ...(scope === "challenge" && { degree: ctx.degree }) } });
  }
  if (ctx.degree != null && use.rule?.macros?.some((m) => m.phase === "onDegree")) {
    await runMacros("onDegree", { message, rule: use.rule, target: targetDoc, degree: ctx.degree });
  }
  return ops;
}

/**
 * Шаг hold (hold.mjs): атака, удерживаемая записью-носителем, выпускается (release), отменяется (cancel) или выпускается с концом заклинания (end: носитель снимается с защищённого).
 * Атака — ctx.holdMessage (запись события) либо первая часть use.state.event карточки испытания (`<id атаки>:<uuid носителя>:<i>`); носитель — вторая.
 * Автор заклинания не участвует: карточка и носитель находятся по ключу события. -> ops
 */
async function holdStep(kind, message, use, ctx, at, doneOps) {
  const key = `${message.id}:hold:${ctx.stepKey ?? at}`, out = [];
  if (doneOps.some((o) => o.key === key)) return out;
  const [msgId, carrierUuid] = String(use.state?.event ?? "").split(":");
  const held = ctx.holdMessage ?? game.messages.get(msgId);
  if (kind === "end" && carrierUuid) {
    const carrier = await fromUuid(carrierUuid).catch(() => null);
    const r = carrier?.actor ? await queue(`actor:${carrier.actor.uuid}`, () => dropEffects([carrier], carrier.actor)) : null;
    if (r?.op === "effRemoved") out.push({ op: "effRemoved", actor: carrier.actor.uuid, data: r.data, key });
  }
  const r = held ? await hold.resolve(held, kind === "cancel" ? "cancel" : "release", { wait: !ctx.holdMessage }) : null;
  out.push({ op: "hold", msg: held?.id ?? null, ...(r && { prev: r.prev }), key });
  return out;
}

/** Откат записанного в ops: созданное удаляется, поднятое возвращается к prev; затем запись state чистится. */
export async function undoOps(message, tokenKey) {
  const state = message.flags?.[MOD]?.use?.state ?? {};
  const places = [["challenge", state.challenge?.applied?.[tokenKey]], ["apply", state.apply?.[tokenKey]]];
  let undone = 0;
  for (const [scope, rec] of places) {
    if (!rec) continue;
    for (const o of [...(rec.ops ?? [])].reverse()) {
      if (o.op === "hold") { if (o.prev) await hold.restore(game.messages.get(o.msg), o.prev); continue; }   // атака снова ждёт: карточку можно применить заново
      if ((o.op === "vis" && o.skipped) || o.op === "chose" || o.op === "damaged" || o.op === "noted" || (o.op === "moved" && o.skipped)) continue;   // выбор отменять нечем; урон pf2e откатывает своей карточкой
      if (o.op === "moved") {   // позиция возвращается, только если токен всё ещё там, куда его сдвинули
        if (await undoMove(await fromUuid(o.token), o)) undone++; else notify("moveSkip.undone", { target: (await fromUuid(o.token))?.name ?? "" });
        continue;
      }
      if (o.op === "vis") { await dropSource(game.scenes.get(o.scene), o.key); undone++; continue; }
      if (o.op === "removed") {   // снятое состояние возвращаем с прежним значением
        const a = actorOf(await fromUuid(o.actor));
        if (a) {
          for (const x of o.also ?? []) {   // попутное: созданное снимаем, поднятое возвращаем к прежнему значению
            const c = a.itemTypes.condition.find((y) => y.slug === x.slug && !y.isLocked && !y.grantedBy);
            if (!c) continue;
            if (x.prev == null) await queue(`actor:${a.uuid}`, () => a.decreaseCondition(x.slug, { forceRemove: true }));
            else await queue(`actor:${a.uuid}`, () => game.pf2e.ConditionManager.updateConditionValue(c.id, a, x.prev));
          }
          await applyCondition(a, { slug: o.slug, ...(o.prev != null && { value: o.prev }), policy: "max" });
          undone++;
        }
        continue;
      }
      if (o.op === "effRemoved" || o.op === "option") {   // снятые эффекты создаём заново, опцию возвращаем
        const a = actorOf(await fromUuid(o.actor));
        if (!a) continue;
        await queue(`actor:${a.uuid}`, () => (o.op === "option" ? a.toggleRollOption(o.domain, o.option, null, o.prev) : a.createEmbeddedDocuments("Item", foundry.utils.deepClone(o.data))));
        undone++;
        continue;
      }
      if (o.op === "focus") {   // возврат очков фокуса откатываем дельтой: за это время актёр мог потратить фокус
        const a = actorOf(await fromUuid(o.actor));
        if (a) { await queue(`actor:${a.uuid}`, () => a.update({ "system.resources.focus.value": Math.max(0, a.system.resources.focus.value - o.delta) })); undone++; }
        continue;
      }
      if (o.op === "coatMade") {   // нанесённый яд: носитель по ключу шага (id мог смениться при откате траты)
        const a = actorOf(await fromUuid(o.actor));
        if (a && await coatUnmake(a, o.key)) undone++;
        continue;
      }
      if (o.op === "coatArm") {   // взвод назад; носитель мог быть снят и восстановлен откатом — тогда по ключу
        const it = (await fromUuid(o.item)) ?? findByKey(actorOf(await fromUuid(o.actor)) ?? { items: [] }, o.key);
        if (it?.actor) { await coatUnarm(it); undone++; }
        continue;
      }
      if (o.op === "afflCleared") {   // снятый недуг: носитель создаётся заново, стадия применяется без урона
        const a = actorOf(await fromUuid(o.actor));
        if (a) { await afflictionRestore(a, o.data); undone++; }
        continue;
      }
      if (o.op === "afflicted") {   // стадия, streak и часы назад (вне очереди актёра: внутри applyStage своя)
        const it = await fromUuid(o.item);
        if (it?.actor) { await afflictionUndo(it, o.prev, o.made); undone++; }
        continue;
      }
      const item = await fromUuid(o.item);
      if (!item?.actor) continue;
      if (o.made) await afflictionUnmake(o.made);   // недуг: состояния, созданные/поднятые его стадией, до снятия носителя
      await queue(`actor:${item.actor.uuid}`, async () => {
        if (o.op === "created") await item.delete({ [MOD]: { undo: true } });   // откат — не «снятие эффекта»: events.onItem такие удаления игнорирует
        else if (o.op === "raised") await game.pf2e.ConditionManager.updateConditionValue(item.id, item.actor, o.prev);
        else if (o.op === "extended") await item.update({ "system.duration.value": o.prev.value, "system.duration.unit": o.prev.unit, "system.duration.expiry": o.prev.expiry ?? null, [`flags.${MOD}.bumped`]: (item.flags?.[MOD]?.bumped ?? []).filter((k) => k !== o.key) });
        else if (o.op === "badged") await item.update({ "system.badge.value": o.prev, [`flags.${MOD}.bumped`]: (item.flags?.[MOD]?.bumped ?? []).filter((k) => k !== o.key) });
      });
      undone++;
    }
    const path = scope === "challenge" ? flagPath("use", "state", "challenge", "applied") : flagPath("use", "state", "apply");
    await message.update({ ...forcedDelete(`${path}.${tokenKey}`), ...(scope === "challenge" ? { [flagPath("use", "state", "challenge", "undone", tokenKey)]: true } : {}) });   // откат ГМа: авто-пакет эту цель заново не применит
  }
  return { undone };
}

/** Зона: снять всё, у чего meta.key начинается с prefix. */
export function removeByKey(actor, metaKeyPrefix) {
  return queue(`actor:${actor.uuid}`, async () => {
    const ids = actor.items.filter((i) => metaOf(i)?.key?.startsWith(metaKeyPrefix)).map((i) => i.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
    return ids.length;
  });
}
