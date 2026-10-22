// K1: живые зоны на RegionBehavior. Контракт — plan.md §2 zone.mjs, §3.B, §3.H.
// Мутации — только у активного ГМа. apply.* сами берут queue("actor:"+uuid): здесь этот ключ НЕ оборачиваем.
import { MOD, L, debug, isActiveGM } from "./util.mjs";
import { modeOf, S } from "./settings.mjs";
import { applyCondition, applyEffect, removeByKey } from "./apply.mjs";
import { runMacros } from "./macros.mjs";
import { visionActive, refreshZone, dropSource } from "./vision.mjs";

const TYPE = `${MOD}.zone`;
const KEY = (regionUuid) => `zone:${regionUuid}`;

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
      originUuid: new f.StringField({ blank: true }),
      originActor: new f.StringField({ blank: true }),
      messageId: new f.StringField({ blank: true }),
      closed: new f.BooleanField()
    };
  }

  // Статические события: работают при любом system.events и не редактируются в UI.
  static events = {
    tokenEnter: ZoneBehaviorType.#enter,
    tokenExit: ZoneBehaviorType.#exit
  };

  static async #enter(event) { if (isActiveGM()) await this.hold(event.data.token); }
  static async #exit(event) { if (isActiveGM()) await this.release(event.data.token); }

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

/** rule — Rule (onUse.zone) либо сам Zone; originInfo — { originUuid, originActor, messageId, name? }. Повторный вызов не дублирует поведение. */
export async function attachZone(region, rule, originInfo = {}) {
  if (!isActiveGM()) throw new Error("attachZone: только активный ведущий");
  const z = rule?.onUse?.zone ?? rule?.zone ?? rule ?? {};
  let behavior = zoneBehavior(region);
  if (!behavior) {
    const d = z.duration ?? {};
    [behavior] = await region.createEmbeddedDocuments("RegionBehavior", [{
      type: TYPE,
      name: rule?.label ?? originInfo.name ?? L("zone.name"),
      system: {
        condition: z.condition?.slug ?? "",
        conditionValue: z.condition?.value ?? null,
        effectUuid: z.effect?.uuid ?? "",
        expiresAt: d.seconds ? game.time.worldTime + d.seconds : null,
        roundsLeft: d.rounds ?? null,
        originUuid: originInfo.originUuid ?? "",
        originActor: originInfo.originActor ?? "",
        messageId: originInfo.messageId ?? ""
      }
    }]);
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
    await attachZone(region, use.rule, { originUuid: use.item?.uuid, originActor: use.actor, messageId: message.id, name: use.item?.name });
    await message.update({ [`flags.${MOD}.use.state.zone`]: { regionUuid: region.uuid, status: "active" } });
  }
}

/** Бой: новый раунд вперёд -> roundsLeft-1 у зон сцены боя (переход 0->1 — начало боя, не раунд). */
async function onUpdateCombat(combat, changes, options) {
  if (!isActiveGM() || !("round" in changes) || options.direction !== 1 || changes.round <= 1) return;
  for (const region of combat.scene?.regions ?? []) {
    const b = zoneBehavior(region);
    if (b?.system.roundsLeft > 0) await b.update({ "system.roundsLeft": b.system.roundsLeft - 1 });
  }
  await expireZones();
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
  Hooks.on("userConnected", () => { if (isActiveGM()) reconcileZones(); });
  Hooks.on("pf2e-automato.visionMarks", onMarksToggle);
  Hooks.on("updateRegion", (region, changes) => { if (isActiveGM() && "hidden" in changes) sweepZone(region); });
  Hooks.on("createItem", itemHook("pf2e-automato.zoneEnter"));
  Hooks.on("deleteItem", itemHook("pf2e-automato.zoneExit"));
}
