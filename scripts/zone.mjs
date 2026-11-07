// K1: живые зоны на RegionBehavior. Контракт — plan.md §2 zone.mjs, §3.B, §3.H.
// Мутации — только у активного ГМа. apply.* сами берут queue("actor:"+uuid): здесь этот ключ НЕ оборачиваем.
import { MOD, L, debug, isActiveGM } from "./util.mjs";
import { combatOf } from "./builtin/lib.mjs";
import { modeOf, S } from "./settings.mjs";
import { applyCondition, applyEffect, removeByKey } from "./apply.mjs";
import { runMacros } from "./macros.mjs";
import { resolveDC } from "./saves.mjs";
import { emanationDefault } from "./use.mjs";
import { pathRects, rectOf, insideAura } from "./aura.mjs";
import { visionActive, refreshZone, dropSource } from "./vision.mjs";
import { gapFeet } from "./aura.mjs";
import { sustained, attach as attachSustain, anchorKey } from "./sustain.mjs";
import { itemRange, tableRange } from "./range.mjs";
import { rangeEntry } from "./rules.mjs";

const TYPE = `${MOD}.zone`;
const KEY = (regionUuid) => `zone:${regionUuid}`;

/* ---------- срок по ходу автора («до конца вашего следующего хода») ---------- */

/** Раунд, в конце хода автора которого зона кончается: ход автора (idx в порядке) ещё впереди в этом раунде — этот раунд, иначе следующий. */
export const nextTurnEndRound = (round, turn, idx) => (turn < idx ? round : round + 1);
/** Ход автора (раунд endRound, место idx) уже закончился: бой ушёл дальше. idx < 0 — автора из боя убрали. */
export const turnPassed = (endRound, idx, round, turn) => idx < 0 || round > endRound || (round === endRound && turn > idx);
/** Поддержание: ещё один «следующий ход». null — выше максимума («up to 1 minute»). */
export const extendedEnd = (end, max) => (max == null || end + 1 <= max ? end + 1 : null);
/** Футы от прямоугольника токена до основания области (центр круга). Центр на углу клеток — берём ближайшую из четырёх: лишних блоков нет. */
export function baseGap(rect, shape, size, unit) {
  const cells = (v) => (v % size === 0 ? [v / size - 1, v / size] : [Math.floor(v / size)]);
  let best = Infinity;
  for (const x of cells(shape.x)) for (const y of cells(shape.y)) best = Math.min(best, gapFeet(rect, { x, y, w: 1, h: 1 }, unit));
  return best;
}

/** Чистая формула срока (§2 zone): срок по миру, счётчик раундов или ручное закрытие. */
export const isExpired = (s, worldTime) =>
  !!s.closed || s.roundsLeft === 0 || (s.expiresAt != null && worldTime >= s.expiresAt);

const zoneBehavior = (region) => region.behaviors.find((b) => b.type === TYPE) ?? null;
// Дым/туман (concealed) при активном Vision — метки в матрице вместо состояния на актёре.
const marks = (sys) => sys.condition === "concealed" && visionActive();
// Пересчёт меток зоны; макросы zoneEnter/zoneExit — по смене множества «внутри».
async function syncMarks(sys) {
  const { entered, exited } = await refreshZone(sys.region);
  for (const [ids, phase] of [[entered, "zoneEnter"], [exited, "zoneExit"]])
    for (const id of ids) { const t = sys.region.parent.tokens.get(id); if (t) await zoneMacros(phase, sys, t); }
}
// Порядок ядра при ходе заклинателя (проверено живой пробой): regionBoundary (region.tokens — ещё без наехавших) -> moveToken заклинателя ->
// tokenEnter стоящих с movement:null. Boundary снимает состав region.tokens, moveToken докладывает id хода, tokenEnter(null) засчитывается
// токену, которого в снимке не было, один раз за ход. Снятие hidden и включение поведения boundary не шлют — записи нет.
// ponytail: бросок токена внутрь области в течение MOVE_TTL после хода заклинателя засчитается входом; различить нечем (тот же tokenEnter(null)).
const bounds = new Map();
const MOVE_TTL = 3000;
const carrierOf = (region) => region?.parent?.tokens.get(region._source?.attachment?.token);
const realMove = (mv) => (mv?.id && !["undo", "config"].includes(mv.method) ? mv : null);   // откат и настройка — не ход
const followedMove = (region, token) => {
  const b = bounds.get(region?.id);
  if (!b?.id || Date.now() - b.at > MOVE_TTL || b.snap.has(token.id) || b.done.has(token.id)) return null;
  b.done.add(token.id);
  return b.id;
};

/** Токен, от которого построена эманация региона: у фигуры `emanation` с `base.type:"token"` те же x/y/размер/форма, что в `_source` токена сцены
 *  (признак самого ядра при сдвиге). tokens — коллекция/массив токенов сцены. Точного совпадения нет (отложенный запуск: заклинатель уже ушёл) —
 *  единственный токен сцены актёра-автора `actorUuid` (ядро само сдвинет фигуру на дельту ходов); иначе null. */
export function emanationToken(region, tokens = region.parent?.tokens ?? [], actorUuid = "") {
  const list = [...tokens];
  let onToken = false;
  for (const s of region.shapes ?? []) {
    const b = s.base;
    if (s.type !== "emanation" || b?.type !== "token") continue;
    onToken = true;
    const t = list.find((t) => ["x", "y", "width", "height", "shape"].every((k) => t._source?.[k] === b[k]));
    if (t) return t;
  }
  if (!onToken || !actorUuid) return null;
  const own = list.filter((t) => t.actor?.uuid === actorUuid || t.baseActor?.uuid === actorUuid);
  return own.length === 1 ? own[0] : null;
}

const fightOf = (token) => { const c = game.combats.find((x) => x.started && x.combatants.some((m) => m.tokenId === token.id)); return { combat: c?.id, round: c?.round, turn: c?.turn }; };

/** enterBy:"path": стоящие токены сцены, оказавшиеся в радиусе эманации в какой-либо клетке пути заклинателя, будучи вне её в начале хода. */
export function pathEntrants(region, carrier, movement) {
  const shape = (region.shapes ?? []).find((s) => s.type === "emanation");
  if (!shape) return [];
  const grid = carrier.parent?.grid ?? {}, unit = grid.distance || 5;
  const feet = (shape.radius / (grid.size || 100)) * unit;   // radius фигуры ядра — всегда в пикселях (gridBased лишь выбирает метрику)
  const [from, ...rects] = pathRects(carrier, movement);
  return [...carrier.parent.tokens].filter((t) => {
    if (t.id === carrier.id || !t.actor) return false;
    const r = rectOf(t);
    return !insideAura(feet, from, r, unit) && rects.some((c) => insideAura(feet, c, r, unit));
  });
}

const hasZoneItem = (actor, regionUuid) => actor.items.some((i) => i.flags?.[MOD]?.meta?.key?.startsWith(KEY(regionUuid)));

async function zoneMacros(phase, sys, tokenDoc) {
  const message = game.messages.get(sys.messageId);
  const rule = message?.flags?.[MOD]?.use?.rule;
  if (!rule?.macros?.some((m) => m.phase === phase)) return;
  try { await runMacros(phase, { message, rule, region: sys.region, target: tokenDoc }); }
  catch (e) { console.error(`${MOD} | zone macros ${phase}`, e); }
}

export class ZoneBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PF2E_AUTOMATO.zone", "BEHAVIOR.TYPES.base"];

  static defineSchema() {
    const f = foundry.data.fields;
    return {
      condition: new f.StringField({ blank: true }),
      conditionValue: new f.NumberField({ integer: true, nullable: true, initial: null }),
      effectUuid: new f.StringField({ blank: true }),
      expiresAt: new f.NumberField({ nullable: true, initial: null }),   // без min: worldTime может быть отрицательным
      roundsLeft: new f.NumberField({ integer: true, nullable: true, initial: null }),
      endCombat: new f.StringField({ blank: true }),   // срок по ходу автора: бой, раунд конца его хода, участник, потолок Поддержания
      endRound: new f.NumberField({ integer: true, nullable: true, initial: null }),
      endCombatant: new f.StringField({ blank: true }),
      maxRound: new f.NumberField({ integer: true, nullable: true, initial: null }),
      originUuid: new f.StringField({ blank: true }),
      originActor: new f.StringField({ blank: true }),
      messageId: new f.StringField({ blank: true }),
      closed: new f.BooleanField(),
      triggers: new f.ArrayField(new f.ObjectField()),   // onUse.zone.triggers снимком: переживают удаление карточки
      dc: new f.NumberField({ nullable: true, initial: null }),   // СЛ триггеров на момент создания (автор мог исчезнуть): запасная
      dcs: new f.ArrayField(new f.NumberField({ nullable: true, initial: null })),   // СЛ по каждому триггеру (по индексу)
      castRank: new f.NumberField({ integer: true, nullable: true, initial: null }),   // круг сотворения: @item.rank и уровень эффекта шагов триггеров
      enterBy: new f.StringField({ initial: "end" }),   // "path": вход и по пути заклинателя (эманация)
      onCarrierGone: new f.StringField({ initial: "close" }),   // "stay": токен удалён — область остаётся
      skipOrigin: new f.BooleanField()   // автор области (эманация) триггеров не получает
    };
  }

  // Статические события: работают при любом system.events и не редактируются в UI.
  static events = {
    regionBoundary: ZoneBehaviorType.#boundary,
    tokenEnter: ZoneBehaviorType.#enter,
    tokenExit: ZoneBehaviorType.#exit,
    tokenTurnStart: ZoneBehaviorType.#turn("turn-start"),
    tokenTurnEnd: ZoneBehaviorType.#turn("turn-end")
  };

  static async #enter(event) {
    if (!isActiveGM()) return;
    const { token, movement } = event.data;
    await this.hold(token);
    // movement == null: регион создан/включён поверх токена или снят hidden — это не вход, стартовое испытание выдаёт сам запуск;
    // исключение — регион, поехавший за своим токеном: ход заклинателя доложили regionBoundary + moveToken
    const id = movement ? realMove(movement)?.id : followedMove(this.region, token);
    if (id) {   // откат и настройка — не вход
      await this.trigger(token, "enter", { evId: `enter:${id}`, ...fightOf(token) });
    }
  }
  // Граница региона, привязанного к токену, сменилась: снимок region.tokens (наехавших ещё нет); id хода доложит moveToken.
  static async #boundary(event) {
    const { region } = event;
    if (carrierOf(region)) bounds.set(region.id, { snap: new Set([...region.tokens].map((t) => t.id)), at: Date.now(), id: null, done: new Set() });
  }
  /** moveToken заклинателя: докладывает id хода своим регионам (для tokenEnter(null)); enterBy:"path" — входы задетых по пути (весь ход уже известен). */
  static async onCarrierMoved(doc, mv) {
    if (!isActiveGM() || !realMove(mv)) return;
    for (const r of doc.parent?.regions ?? []) {
      if (r._source.attachment?.token !== doc.id) continue;
      const rec = bounds.get(r.id);
      if (rec && Date.now() - rec.at < MOVE_TTL) rec.id = mv.id;
      const b = zoneBehavior(r);
      if (b?.disabled || b?.system.enterBy !== "path") continue;
      for (const t of pathEntrants(r, doc, mv)) await b.system.trigger(t, "enter", { evId: `enter:${mv.id}`, ...fightOf(t) });
    }
  }
  static #turn(on) {
    return async function (event) {
      const { token, combat, round, turn, skipped } = event.data;
      if (!isActiveGM() || skipped) return;   // ядро шлёт события и за пропущенные ходы
      await this.trigger(token, on, { evId: `${combat.id}:${round}:${turn}:${on}`, combat: combat.id, round, turn });
    };
  }
  static async #exit(event) { if (isActiveGM()) await this.release(event.data.token); }

  /** Триггеры зоны (onUse.zone.triggers); events.mjs подгружаем лениво: он сам зависит от use.mjs -> zone.mjs. */
  async trigger(tokenDoc, on, ev) {
    if (!this.triggers?.some((t) => t.on === on) || !tokenDoc?.actor || this.region?.hidden || this.expired) return;
    try { await (await import("./events.mjs")).fireZoneTrigger(this, tokenDoc, on, ev); }
    catch (e) { console.error(`${MOD} | zone trigger`, e); }
  }

  get expired() { return isExpired(this, game.time.worldTime); }

  /** Поставить состояние/эффект зоны токену. Идемпотентно по meta.key; макрос zoneEnter — только при реальном создании. */
  async hold(tokenDoc, sync = true) {
    const region = this.region, actor = tokenDoc?.actor;
    if (!actor || !region || region.hidden || this.expired) return false;
    const key = KEY(region.uuid);
    const meta = { key, source: "zone", message: this.messageId || null, region: region.uuid, origin: this.originUuid || null, by: this.originActor || null };
    let created = false;
    if (marks(this)) { if (sync) await syncMarks(this); }
    else if (this.condition) {
      const spec = { slug: this.condition, value: this.conditionValue ?? undefined, policy: "max" };
      created = (await applyCondition(actor, spec, meta)).op === "created" || created;
    }
    if (this.effectUuid) {
      const ctx = {
        originActor: this.originActor ? await fromUuid(this.originActor) : null,
        originItem: this.originUuid ? await fromUuid(this.originUuid) : null,
        target: tokenDoc
      };
      created = (await applyEffect(actor, { uuid: this.effectUuid }, { ...meta, key: `${key}:fx` }, ctx)).op === "created" || created;
    }
    if (created) await zoneMacros("zoneEnter", this, tokenDoc);
    return created;
  }

  /** Снять всё с ключом зоны. zoneExit — только если что-то реально снято. */
  async release(tokenDoc, sync = true) {
    const region = this.region, actor = tokenDoc?.actor;
    if (!actor || !region) return false;
    if (marks(this) && sync) await syncMarks(this);
    const n = await removeByKey(actor, KEY(region.uuid));
    if (n) await zoneMacros("zoneExit", this, tokenDoc);
    return n > 0;
  }
}

const deleting = new Set();
/** Удалить регион ровно один раз: параллельные expire/close/ручное удаление не дают «does not exist». */
async function deleteRegionOnce(region, status = "expired") {
  if (deleting.has(region.id) || !region.parent?.regions.has(region.id)) return false;
  deleting.add(region.id);
  try {
    await setZoneStatus(region, status);
    await region.delete();
    await purgeZoneState(region.uuid);
    return true;
  } catch (e) {
    if (/does not exist/i.test(String(e?.message))) return false;
    throw e;
  } finally { deleting.delete(region.id); }
}

async function setZoneStatus(region, status) {
  const sys = zoneBehavior(region)?.system;
  const m = sys && game.messages.get(sys.messageId);
  if (m?.flags?.[MOD]?.use?.state?.zone?.regionUuid !== region.uuid) return;
  try { await m.update({ [`flags.${MOD}.use.state.zone.status`]: status }); } catch (e) { debug("zone status", e); }
}

const allRegions = () => game.scenes.contents.flatMap((s) => s.regions.contents);

/** rule — Rule (onUse.zone) либо сам Zone; originInfo — { originUuid, originActor, messageId, name?, dc? (снимок use.dc) }. Повторный вызов не дублирует поведение. */
export async function attachZone(region, rule, originInfo = {}) {
  if (!isActiveGM()) throw new Error("attachZone: только активный ведущий");
  const z = rule?.onUse?.zone ?? rule?.zone ?? rule ?? {};
  let behavior = zoneBehavior(region);
  if (!behavior) {
    const d = z.duration ?? {};
    const trg = z.triggers ?? [];
    // СЛ триггеров считаем сейчас, пока автор и предмет на месте; предмета нет (расходник) — снимок use.dc, а не СЛ чужого заклинателя
    const [it, ac] = await Promise.all([originInfo.originUuid, originInfo.originActor].map((u) => u ? fromUuid(u).catch(() => null) : null));
    const dcs = await Promise.all(trg.map(async ({ challenge: ch }) => !ch ? null
      : ch.dc?.value ?? (it ? await resolveDC({ rule: { onUse: { challenge: ch } }, item: it, actor: ac }).catch(() => null) : null) ?? originInfo.dc ?? null));
    const castRank = game.messages.get(originInfo.messageId)?.flags?.pf2e?.origin?.castRank ?? null;
    // срок по ходу автора: нет боя с автором — запасной счётчик rounds
    const combat = d.until === "next-turn-end" && ac ? [combatOf(game.combats, ac)].find((c) => c?.started && c.round > 0) : null;
    const cb = combat?.combatants.find((x) => x.actor?.uuid === ac.uuid);
    const idx = cb ? combat.turns.findIndex((t) => t.id === cb.id) : -1;
    const endRound = combat && idx >= 0 ? nextTurnEndRound(combat.round, combat.turn, idx) : null;
    [behavior] = await region.createEmbeddedDocuments("RegionBehavior", [{
      type: TYPE,
      name: originInfo.name ?? it?.name ?? rule?.label ?? L("zone.name"),   // название с листа; label каталога — английский служебный
      system: {
        condition: z.condition?.slug ?? "",
        conditionValue: z.condition?.value ?? null,
        effectUuid: z.effect?.uuid ?? "",
        expiresAt: d.seconds ? game.time.worldTime + d.seconds : null,
        roundsLeft: endRound == null ? d.rounds ?? null : null,
        ...(endRound != null && { endCombat: combat.id, endRound, endCombatant: cb.id, maxRound: d.sustainMax ? combat.round + d.sustainMax : null }),
        originUuid: originInfo.originUuid ?? "",
        originActor: originInfo.originActor ?? "",
        messageId: originInfo.messageId ?? "",
        triggers: trg, dcs, dc: dcs.find((x) => x != null) ?? originInfo.dc ?? null, castRank,
        enterBy: z.enterBy ?? "end", onCarrierGone: z.onCarrierGone ?? "close",
        skipOrigin: !!trg.length && !!(rule?.onUse?.excludeSelf ?? emanationDefault(region))
      }
    }]);
    // Поддержание зоны: якорь (кнопки «Поддержать»/«Развеять»); засчитанное Поддержание продлевает срок (sustained-слушатель в init)
    if (d.sustainMax && it && ac && originInfo.messageId) {
      await attachSustain(ac, null, { key: anchorKey(originInfo.messageId), msg: originInfo.messageId, item: it }).catch((e) => debug("zone sustain anchor", e));
    }
  }
  // эманация едет за токеном средствами ядра (сдвиг фигуры, членство автора, удаление вместе с токеном, hidden); follow:false — стоит на месте
  if (z.follow !== false && !region._source?.attachment?.token) {
    const t = emanationToken(region, undefined, originInfo.originActor);
    if (t) await region.update({ "attachment.token": t.id });
  }
  await sweepZone(region);
  return behavior;
}

/** Согласовать токены сцены с зоной. hidden/истёкшая/закрытая — только снимаем (ядро шлёт TOKEN_EXIT уже после updateRegion). */
export async function sweepZone(region) {
  const sys = zoneBehavior(region)?.system;
  if (!sys) return;
  const off = region.hidden || sys.expired;
  if (marks(sys)) await syncMarks(sys);   // один пересчёт на зону, не на токен
  for (const token of region.parent.tokens) {
    if (!token.actor) continue;
    if (!off && token.testInsideRegion(region)) await sys.hold(token, false);
    else if (hasZoneItem(token.actor, region.uuid)) await sys.release(token, false);
  }
}

export async function expireZones() {
  if (!isActiveGM()) return;
  for (const region of allRegions()) {
    const sys = zoneBehavior(region)?.system;
    if (sys?.expired) await deleteRegionOnce(region, sys.closed ? "closed" : "expired");
  }
}

export async function closeZone(regionUuid) {
  const region = fromUuidSync(regionUuid);
  if (!region) return true;   // уже удалён
  if (!zoneBehavior(region)) return false;   // не наш регион — не трогаем (K7 п.1)
  await deleteRegionOnce(region, "closed");
  return true;
}

/** messageId из поведения зоны региона (для проверки прав сокета closeZone); null — региона/поведения нет. */
export function zoneMessageId(regionUuid) {
  try { return zoneBehavior(fromUuidSync(regionUuid))?.system.messageId || null; } catch { return null; }
}

/** Регион удалён не нами (ядро: удаление токена-источника, ГМ): карточка зоны закрывается. Истёкшая/закрытая через deleteRegionOnce уже помечена. */
export async function markZoneGone(region) {
  const m = game.messages.get(zoneBehavior(region)?.system.messageId);
  if (m?.flags?.[MOD]?.use?.state?.zone?.status === "active") await setZoneStatus(region, "closed");
}

/** Страховка: снять всё с ключом зоны у актёров сцены региона и у мировых актёров. */
export async function purgeZoneState(regionUuid) {
  const scene = game.scenes.get(regionUuid.split(".")[1]);
  const actors = new Set([...(scene?.tokens ?? []).map((t) => t.actor), ...game.actors].filter(Boolean));
  for (const a of actors) if (hasZoneItem(a, regionUuid)) await removeByKey(a, KEY(regionUuid));
  if (scene) await dropSource(scene, KEY(regionUuid));
}

/** ready / смена ГМа: sweep живых, удаление истёкших, дозапуск ожидавших зону (только при modeOf("zone")==="auto"). */
export async function reconcileZones() {
  if (!isActiveGM()) return;
  for (const region of allRegions()) {
    const sys = zoneBehavior(region)?.system;
    if (!sys) continue;
    if (sys.expired) await deleteRegionOnce(region, sys.closed ? "closed" : "expired");
    else await sweepZone(region);
  }
  if (modeOf("zone") !== "auto") return;
  const maxAge = S.get("resumeMinutes") * 60000;
  for (const region of allRegions()) {
    if (zoneBehavior(region)) continue;
    const message = game.messages.get(region.flags?.pf2e?.messageId);
    const use = message?.flags?.[MOD]?.use;
    if (!use?.rule?.onUse?.zone || use.confidence === "low" || use.state?.yielded || use.state?.zone?.status) continue;
    if (Date.now() - (use.createdAt ?? 0) > maxAge) continue;
    await attachZone(region, use.rule, { originUuid: use.item?.uuid, originActor: use.actor, messageId: message.id, name: use.item?.name, dc: use.dc });
    await message.update({ [`flags.${MOD}.use.state.zone`]: { regionUuid: region.uuid, status: "active" } });
  }
}

/** Бой: новый раунд вперёд -> roundsLeft-1 у зон сцены боя (переход 0->1 — начало боя, не раунд). */
async function onUpdateCombat(combat, changes, options) {
  if (!isActiveGM() || options.direction !== 1 || !("round" in changes || "turn" in changes)) return;
  const roundUp = "round" in changes && changes.round > 1;
  for (const region of allRegions()) {
    const b = zoneBehavior(region);
    if (!b) continue;
    const s = b.system;
    if (s.endCombat === combat.id && s.endRound != null) {   // срок по ходу автора: ход автора позади — зона кончилась
      if (turnPassed(s.endRound, combat.turns.findIndex((t) => t.id === s.endCombatant), combat.round, combat.turn)) await b.update({ "system.roundsLeft": 0 });
    } else if (roundUp && region.parent === combat.scene && s.roundsLeft > 0) await b.update({ "system.roundsLeft": s.roundsLeft - 1 });
  }
  await expireZones();
}

/** Бой закончен: срок «до конца хода автора» потерял точку отсчёта — зона кончается. */
async function onDeleteCombat(combat) {
  if (!isActiveGM()) return;
  for (const region of allRegions()) {
    const b = zoneBehavior(region);
    if (b?.system.endCombat === combat.id && b.system.endRound != null) await b.update({ "system.roundsLeft": 0 });
  }
  await expireZones();
}

/** Поддержание засчитано (sustain.count): зона этого сообщения живёт ещё до конца следующего хода автора, но не дольше maxRound. */
export async function extendZone(messageId) {
  if (!isActiveGM() || !messageId) return false;
  let any = false;
  for (const region of allRegions()) {
    const s = zoneBehavior(region)?.system;
    if (!s || s.messageId !== messageId || s.endRound == null || s.expired) continue;
    const end = extendedEnd(s.endRound, s.maxRound);
    if (end != null) { await zoneBehavior(region).update({ "system.endRound": end }); any = true; }
  }
  return any;
}

/** Конец якоря Поддержания (Прекращение, пропуск; не откат) закрывает зону того же сообщения, которую он поддерживал. */
export async function closeSustainedZones(messageId) {
  if (!isActiveGM() || !messageId) return;
  for (const region of allRegions()) {
    const s = zoneBehavior(region)?.system;
    if (s?.messageId === messageId && s.maxRound != null && !s.expired) await deleteRegionOnce(region, "closed");
  }
}

/* ---------- место области ---------- */

/** {name, d, r}, если основание размещаемой области (первый круг данных региона) дальше дальности предмета от токена автора; иначе null.
 *  Заклинание — с системной дальностью (и областью), не-заклинание — запись area:true (onUse.range правила). Нет токена/предмета/дальности — null.
 *  ponytail: только круг (взрыв/цилиндр) на квадратной сетке; конус/линия идут от автора — дальности нет. */
export function areaFarFor(data, scene) {
  const pf = data?.flags?.pf2e, origin = pf?.origin, shape = data?.shapes?.find((s) => s.type === "circle");
  if (!shape || !origin?.uuid || !scene?.grid?.isSquare) return null;
  const item = fromUuidSync(origin.uuid);
  if (!item) return null;
  let max = null;
  if (item.type === "spell") max = item.system?.area ? itemRange(item, origin.rollOptions ?? []) : null;
  else {
    const e = rangeEntry(item);
    max = e?.area ? tableRange({ ...e, area: false }, item.actor?.level) : null;
  }
  if (!(max > 0)) return null;
  const doc = (origin.token && fromUuidSync(origin.token)) || game.messages.get(pf.messageId)?.token
    || (() => { const own = scene.tokens.filter((t) => t.actor?.uuid === origin.actor); return own.length === 1 ? own[0] : null; })();
  if (!doc || doc.parent !== scene) return null;
  const d = baseGap(rectOf(doc), shape, scene.grid.size, scene.grid.distance || 5);
  return d > max ? { name: item.name, d, r: max } : null;
}

// Публичные хуки для pf2e-vision: из документов, поэтому срабатывают ровно раз на каждом клиенте.
function itemHook(name) {
  return (item) => {
    const meta = item.flags?.[MOD]?.meta;
    if (!meta?.key?.startsWith("zone:") || !["condition", "effect"].includes(item.type) || !item.actor) return;
    Hooks.callAll(name, {
      region: meta.region ? fromUuidSync(meta.region) : null,
      actor: item.actor, tokens: item.actor.getActiveTokens(false, true), item, meta
    });
  };
}

// Настройка vision.marks переключена: зоны дыма переходят между метками и состояниями.
async function onMarksToggle(on) {
  if (!isActiveGM()) return;
  for (const region of allRegions()) {
    const sys = zoneBehavior(region)?.system;
    if (sys?.condition !== "concealed") continue;
    if (on) for (const t of region.parent.tokens) {   // состояние зоны уходит (эффект остаётся), метки ставит sweepZone
      const ids = (t.actor?.items ?? []).filter((i) => i.type === "condition" && i.flags?.[MOD]?.meta?.key === KEY(region.uuid)).map((i) => i.id);
      if (ids.length) await t.actor.deleteEmbeddedDocuments("Item", ids);
    }
    await sweepZone(region);
  }
}

export function init() {
  CONFIG.RegionBehavior.dataModels[TYPE] = ZoneBehaviorType;
  CONFIG.RegionBehavior.typeLabels[TYPE] = "PF2E_AUTOMATO.zone.label";
  CONFIG.RegionBehavior.typeHints[TYPE] = "PF2E_AUTOMATO.zone.hint";
  CONFIG.RegionBehavior.typeIcons[TYPE] = "fa-solid fa-smog";

  Hooks.on("updateWorldTime", () => expireZones());
  Hooks.on("updateCombat", onUpdateCombat);
  Hooks.on("deleteCombat", onDeleteCombat);
  sustained.add(({ anchor }) => extendZone(anchor.flags?.[MOD]?.sustain?.msg));
  Hooks.on("deleteItem", (item, options) => { const f = item.flags?.[MOD]; if (f?.meta?.source === "sustain" && !options?.[MOD]?.undo) closeSustainedZones(f.sustain?.msg).catch((e) => debug("sustain close", e)); });
  Hooks.on("userConnected", () => { if (isActiveGM()) reconcileZones(); });
  Hooks.on("pf2e-automato.visionMarks", onMarksToggle);
  Hooks.on("moveToken", (doc, mv) => { ZoneBehaviorType.onCarrierMoved(doc, mv).catch((e) => debug("path", e)); });
  // onCarrierGone:"stay": ядро удаляет привязанные регионы в своём _onDeleteOperation, отвязать надо ДО удаления: отменяем удаление,
  // ждём отвязку (ядро по ней чистит token.attachments) и удаляем токен заново с пометкой.
  Hooks.on("preDeleteToken", (token, options) => {
    if (!game.user.isGM || options.afUnlinked) return;
    const stay = [...(token.parent?.regions ?? [])].filter((r) => r._source.attachment?.token === token.id && zoneBehavior(r)?.system.onCarrierGone === "stay");
    if (!stay.length) return;
    // отвязка не удалась — токен всё равно удаляем (удаление не должно зависнуть), область закроет ядро; ГМу об этом говорим
    Promise.allSettled(stay.map((r) => r.update({ "attachment.token": null }))).then((rs) => {
      if (rs.some((x) => x.status === "rejected")) ui.notifications.warn(game.i18n.localize("PF2E_AUTOMATO.zone.stayUnlinkFailed"));
      return token.delete({ ...options, afUnlinked: true });
    }).catch((e) => debug("stay", e));
    return false;
  });
  Hooks.on("updateRegion", (region, changes) => { if (isActiveGM() && "hidden" in changes) { bounds.delete(region.id); sweepZone(region); } });
  Hooks.on("createItem", itemHook("pf2e-automato.zoneEnter"));
  Hooks.on("deleteItem", itemHook("pf2e-automato.zoneExit"));
}
