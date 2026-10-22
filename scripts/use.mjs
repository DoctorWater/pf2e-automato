// K2: конвейер использования. Контракт — plan.md §2 use.mjs, §3.A–C, §3.H, §1.4.
import { MOD, L, flagPath, guardActiveGM, queue, debug, forcedDelete } from "./util.mjs";
import { S, modeOf } from "./settings.mjs";
import * as compat from "./compat.mjs";
import * as rules from "./rules.mjs";
import * as apply from "./apply.mjs";
import * as zone from "./zone.mjs";
import * as saves from "./saves.mjs";
import * as macros from "./macros.mjs";
import * as reactions from "./reactions.mjs";
import * as actions from "./actions.mjs";
import { itemRange, markFar, inRange, TENTACLES } from "./range.mjs";
import { recentShape, spentOptions } from "./builtin/spellshape.mjs";

const CAST = "origin:action:slug:cast-a-spell";
const CARD_TYPES = new Set(["consumable", "equipment", "spell", "weapon", "armor", "treasure", "backpack", "shield"]);

/* ---------- чистые функции (юнит-тесты) ---------- */

/** consume-сообщение: origin без rollOptions, предмет — расходник (pf2e:51064). */
export function isConsume(message) {
  const o = message?.flags?.pf2e?.origin;
  return !!o && !Array.isArray(o.rollOptions) && o.type === "consumable";
}

/** §3.A-1,2: "use" | "card" | null. Наш флаг не смотрит (работает и по записанным сообщениям). */
export function useKindOf(message) {
  const pf = message?.flags?.pf2e;
  const o = pf?.origin;
  const ctx = pf?.context?.type;
  if (!o || (ctx && ctx !== "spell-cast")) return null;
  if (isConsume(message)) return "use";
  if (o.rollOptions?.includes(CAST)) return "use";
  if (o.type === "action" || o.type === "feat") return "use";
  if (Array.isArray(o.rollOptions) && CARD_TYPES.has(o.type)) return "card";
  return null;
}

/** Вид использования предмета в листе (для значка): как useKindOf, но по самому предмету. selfEffect делает система. */
export function itemUseKind(item) {
  if (!item || item.system?.selfEffect) return null;
  if (["consumable", "action", "feat", "spell"].includes(item.type)) return "use";
  return CARD_TYPES.has(item.type) ? "card" : null;
}

/**
 * Сборка снимка §1.4. i: { kind, resolved:{rule,source,slug,sourceUuid,confidence}, item:{uuid,name,type,sourceId},
 * actor, token, dc, targets, yielded, consume, now }.
 */
export function buildSnapshot(i) {
  const rule = JSON.parse(JSON.stringify(i.resolved.rule));
  const state = {};
  if (i.yielded) state.yielded = i.yielded;
  // расходник с областью: актом использования станет регион из карточки (§3.A-6)
  if (i.kind === "use" && i.consume && rule.onUse?.targets === "area") state.awaitingRegion = true;
  return {
    v: 1, kind: i.kind, rule, src: i.resolved.source, confidence: i.resolved.confidence,
    ...(((i.resolved.hints?.possible?.length ?? 0) + (i.resolved.hints?.excluded?.length ?? 0)) && { hints: { possible: i.resolved.hints.possible ?? [], excluded: i.resolved.hints.excluded ?? [] } }),   // подсказки разметки (только ГМу в чате)
    slug: i.resolved.slug ?? null, sourceUuid: i.resolved.sourceUuid ?? null,
    item: i.item, actor: i.actor ?? null, token: i.token ?? null,
    dc: i.dc ?? null, createdAt: i.now, targets: i.targets ?? [], state
  };
}

/** Нужен ли снимок: у карточки — только для правила с областью (§3.A-2); без onUse/macros снимать нечего. */
export function wantsSnapshot(kind, rule) {
  if (!rule || (!rule.onUse && !rule.macros?.length)) return false;
  const on = rule.onUse;   // проверку бросает система — снимок ляжет на сообщение броска (actions.mjs), карточке он не нужен
  if (on?.check?.roll === "system" && !on.apply?.length && !on.zone && !rule.macros?.length) return false;
  return kind === "use" || rule.onUse?.targets === "area";
}

/** «Последний регион задаёт цели» (§3.C-3): новые area/targets и неприменённые результаты к удалению. */
export function areaUpdate(use, regionUuid, tokens) {
  const keys = tokens.map((t) => t.key);
  const applied = use.state?.challenge?.applied ?? {};
  const results = use.state?.challenge?.results ?? {};
  const drop = Object.keys(results).filter((k) => !keys.includes(k) && !applied[k]);
  const kept = (use.targets ?? []).filter((t) => !keys.includes(t.key) && applied[t.key]);
  return { area: { regionUuid, keys }, targets: [...tokens, ...kept], drop };
}

/** §3.H: можно ли дозапускать автоматически. */
export function isResumable(use, now, maxAgeMinutes) {
  if (!use || use.kind !== "use" || use.state?.yielded || use.state?.done || use.state?.awaitingRegion) return false;
  return now - (use.createdAt ?? 0) <= maxAgeMinutes * 60000;
}

const emanationDefault = (region) => region?.flags?.pf2e?.areaShape === "emanation";

/* ---------- клиент автора (синхронно) ---------- */

function onPreCreateMessage(message, data, options, userId) {
  if (userId !== game.user.id) return;
  if (message.flags?.[MOD]) return;
  const kind = useKindOf(message);
  if (!kind) return;
  const origin = message.flags.pf2e.origin;
  const item = message.item ?? (origin.uuid ? fromUuidSync(origin.uuid) : null);
  if (item?.system?.selfEffect) return;   // делает система (pf2e:54140)
  const resolved = rules.resolveRule({ origin, item });
  if (!resolved || !wantsSnapshot(kind, resolved.rule)) return;

  const sp = message.speaker ?? {};
  const tokenDoc = sp.scene && sp.token ? game.scenes.get(sp.scene)?.tokens.get(sp.token) : null;
  const actor = origin.actor ?? tokenDoc?.actor?.uuid ?? (sp.actor ? game.actors.get(sp.actor)?.uuid : null);
  const targets = [...(game.user.targets ?? [])].map((t) => t.document ?? t).map((d) => ({
    key: d.id, uuid: d.uuid, name: d.name, pc: !!d.actor?.hasPlayerOwner
  }));
  const onUse = resolved.rule.onUse;
  if (onUse?.targets !== "area" && targets.length && (onUse?.challenge || onUse?.check || onUse?.apply?.some((a) => a.to === "target"))) {
    const far = markFar(targets, tokenDoc?.object, itemRange(item, [...(origin.rollOptions ?? []), ...casterOptions(item?.actor ?? tokenDoc?.actor)])).filter((t) => t.far);
    for (const t of far) targets.find((x) => x.key === t.key).far = t.far;
    if (far.length) ui.notifications?.warn(far.map((t) => L("chat.outOfRange", { name: t.name, d: t.far.d, r: t.far.r })).join(" "));
  }
  const chDc = resolved.rule.onUse?.challenge?.dc;
  let dc = chDc?.value ?? null;
  if (dc == null && !resolved.rule.onUse?.check && (!chDc || chDc.source === "spell")) {   // СЛ заклинателя — только если правило её и просит (K7 п.7)
    try { dc = item?.spellcasting?.statistic?.withRollOptions?.({ item })?.dc?.value ?? null; } catch { dc = null; }
  }
  const yielded = compat.shouldYield(resolved.rule, { slug: resolved.slug, sourceUuid: resolved.sourceUuid }) ? "pf2e-automations" : null;
  const snapshot = buildSnapshot({
    kind, resolved, consume: isConsume(message), yielded, dc, targets, now: Date.now(),
    item: { uuid: origin.uuid ?? null, name: item?.name ?? origin.name ?? "", type: origin.type ?? item?.type ?? null, sourceId: resolved.sourceUuid },
    actor, token: tokenDoc?.uuid ?? null
  });
  message.updateSource({ [flagPath("use")]: snapshot });
}

/** Опции актёра для дальности: метамагия (`spellshape:*`, не feat:reach-spell — это наличие черты) без потраченной на прошлое сотворение,
 *  метамагия, нажатая только что (эффект ведущий ещё не создал), и «Руки-щупальца». */
function casterOptions(caster) {
  if (!caster) return [];
  const spent = spentOptions(caster.items ?? []);
  const own = Object.entries(caster.rollOptions?.all ?? {}).filter(([o, on]) => on && !spent.includes(o) && (o.startsWith("spellshape:") || o === TENTACLES)).map(([o]) => o);
  const recent = recentShape(game.messages.contents, caster.uuid, (uuid) => { const f = fromUuidSync(uuid); return f?.parent === caster ? f.flags?.[MOD]?.spellshape : null; });
  return recent ? [...own, recent] : own;
}

function onPreCreateRegion(region, data, options, userId) {
  if (userId !== game.user.id) return;
  const pf = data?.flags?.pf2e;
  if (!pf) return;
  const useFlag = pf.messageId ? game.messages.get(pf.messageId)?.flags?.[MOD]?.use : null;
  let rule = useFlag?.rule, yielded = useFlag?.state?.yielded;
  if (!useFlag && pf.origin) {
    const r = rules.resolveRule({ origin: pf.origin });
    rule = r?.rule;
    yielded = r && compat.shouldYield(r.rule, { slug: r.slug, sourceUuid: r.sourceUuid });
  }
  if (rule?.onUse?.zone && modeOf("zone") !== "off" && !yielded) {
    region.updateSource({ "flags.pf2e-toolbelt.targetHelper.skip": true });   // Template Helper на зонах не нужен (§3.B-2)
  }
}

/* ---------- активный ГМ ---------- */

async function tolerate(name, fn) {
  try { return await fn(); }
  catch (e) {
    if (String(e?.message).startsWith("not implemented")) debug(e.message);
    else console.error(`${MOD} | use.${name}`, e);
  }
}

const setState = (message, patch) =>
  message.update(Object.fromEntries(Object.entries(patch).map(([k, v]) => [flagPath("use", "state", k), v])));
const useOf = (message) => message?.flags?.[MOD]?.use;

async function onCreateMessage(message) {
  if (!guardActiveGM()) return;
  const ctx = message.flags?.pf2e?.context?.type;
  if (ctx === "saving-throw" || ctx === "skill-check" || ctx === "perception-check" || ctx === "flat-check") {
    const accepted = await tolerate("acceptSavingThrow", () => saves.acceptSavingThrow(message));
    if (!accepted) await tolerate("onRollMessage", () => actions.onRollMessage(message));   // бросок действия из листа/макроса — без карточки
  } else if (ctx === "attack-roll") await tolerate("onRollMessage", () => actions.onRollMessage(message));
  if (ctx === "attack-roll") await tolerate("onAttackMessage", () => reactions.onAttackMessage(message));
  if (useOf(message)?.kind === "use") await tolerate("runUse", () => execUse(message.id, true));
}

async function onCreateRegion(region) {
  if (!guardActiveGM()) return;
  const pf = region.flags?.pf2e;
  if (!pf?.messageId && !pf?.origin) return;
  await tolerate("runRegion", () => runRegion(region, game.messages.get(pf.messageId) ?? null));
}

async function onDeleteRegion(region) {
  if (!guardActiveGM()) return;
  await tolerate("purgeZoneState", () => zone.purgeZoneState(region.uuid));
}

export function init() {
  Hooks.on("preCreateChatMessage", onPreCreateMessage);
  Hooks.on("preCreateRegion", onPreCreateRegion);
  Hooks.on("createChatMessage", onCreateMessage);
  Hooks.on("createRegion", onCreateRegion);
  Hooks.on("deleteRegion", onDeleteRegion);
  Hooks.on("userConnected", () => { if (guardActiveGM()) tolerate("resume", () => resumePending()); });
}

const regionOf = (uuid) => { try { return uuid ? fromUuidSync(uuid) : null; } catch { return null; } };
const allRegions = () => game.scenes.contents.flatMap((s) => s.regions.contents);

/** Общая часть execUse/applyUse: onUse.apply одним разбиением на self/target — от него зависят индексы meta.key (K7 п.11). */
async function applyUseSteps(message, use, { self = true, targets = true, only = null } = {}) {
  const steps = use.rule?.onUse?.apply ?? [];
  const selfSteps = steps.filter((s) => (s.to ?? "self") === "self").map((s) => ({ ...s, to: "self" }));
  const tgtSteps = steps.filter((s) => s.to === "target");
  if (self && !only && selfSteps.length) await apply.applyOps(message, "self", selfSteps, { scope: "apply" });
  if (!targets || !tgtSteps.length) return;
  for (const { key, doc, region } of await stepTargets(use)) {
    if (only && only !== key) continue;
    if (doc) await apply.applyOps(message, key, tgtSteps, { scope: "apply", target: doc, ...(region && { region }) });
  }
}

/** Цели шагов: область — токены state.area.keys своей сцены, иначе use.targets. */
async function stepTargets(use) {
  if (use.rule?.onUse?.targets === "area") {
    const region = regionOf(use.state?.area?.regionUuid), scene = region?.parent;
    return (use.state?.area?.keys ?? []).map((key) => ({ key, doc: scene?.tokens.get(key) ?? null, region }));
  }
  return Promise.all(inRange(use.targets).map(async (t) => ({ key: t.key, doc: await fromUuid(t.uuid) })));
}

/** Кнопка «Применить» (effect=button): onUse.apply для kind use + high. */
export function applyUse(messageId, targetKey) {
  return queue(`use:${messageId}`, async () => {
    const message = game.messages.get(messageId), use = useOf(message);
    if (!use || use.kind !== "use" || use.confidence === "low" || use.state?.yielded) throw new Error("applyUse: недоступно для этого сообщения");
    if (modeOf("effect") === "off") throw new Error("applyUse: режим effect=off");
    await applyUseSteps(message, use, { only: targetKey || null });
    return true;
  });
}

async function attachFor(message, use, region) {
  await zone.attachZone(region, use.rule, { originUuid: use.item?.uuid ?? "", originActor: use.actor ?? "", messageId: message.id, name: use.item?.name });
  await setState(message, { zone: { regionUuid: region.uuid, status: "active" } });
}

/** Кнопка «Создать зону» (zone=button): регион должен принадлежать сообщению и совпадать с state.zone. */
export function createZone(messageId, regionUuid) {
  return queue(`use:${messageId}`, async () => {
    const message = game.messages.get(messageId), use = useOf(message), region = regionOf(regionUuid);
    if (!use?.rule?.onUse?.zone || use.state?.yielded) throw new Error("createZone: у сообщения нет зоны");
    if (!region || region.flags?.pf2e?.messageId !== messageId) throw new Error("createZone: регион не принадлежит сообщению");
    if (use.state?.zone?.regionUuid !== regionUuid) throw new Error("createZone: регион не ожидает зоны");
    await attachFor(message, use, region);
    return true;
  });
}

/** Кнопка распознанного шага (low): "u<i>" — один шаг onUse.apply, "zone" — зона по state.zone.regionUuid. */
export function applyDerived(messageId, stepKey) {
  return queue(`use:${messageId}`, async () => {
    const message = game.messages.get(messageId), use = useOf(message);
    if (!use || use.state?.yielded) throw new Error("applyDerived: нет снимка");
    const d = use.state?.derived ?? {}, applied = d.applied ?? [];
    if (!(d.pending ?? []).includes(stepKey)) throw new Error(`applyDerived: шаг ${stepKey} не ожидается`);
    if (applied.includes(stepKey)) return false;
    if (modeOf(stepKey === "zone" ? "zone" : "effect") === "off") throw new Error("applyDerived: режим off");

    if (stepKey === "zone") {
      const region = regionOf(use.state?.zone?.regionUuid);
      if (!region) throw new Error("applyDerived: регион зоны не найден");
      await attachFor(message, use, region);
    } else {
      const m = /^u(\d+)$/.exec(stepKey), step = m && use.rule?.onUse?.apply?.[+m[1]];
      if (!step) throw new Error(`applyDerived: неизвестный шаг ${stepKey}`);
      const ctx = { scope: "derived", stepKey };
      if (step.to === "target") {
        for (const { key, doc, region } of await stepTargets(use)) {
          if (doc) await apply.applyOps(message, key, [step], { ...ctx, target: doc, ...(region && { region }) });
        }
      } else await apply.applyOps(message, "self", [{ ...step, to: "self" }], ctx);
    }
    await setState(message, { derived: { pending: d.pending, applied: [...applied, stepKey] } });
    return true;
  });
}

/** Публичный вход (кнопка «Дозапустить», api): выполняет всегда; идемпотентность — meta.key и state.*. */
export const runUse = (messageId) => execUse(messageId, false);

// Ключ очереди "use:" (не "msg:"): saves.runChallenge берёт "msg:<id>", а queue не реентерабелен.
function execUse(messageId, skipIfDone) {
  return queue(`use:${messageId}`, async () => {
    const message = game.messages.get(messageId);
    const use = useOf(message);
    if (!use || use.kind !== "use" || use.state?.yielded) return;
    if (skipIfDone && use.state?.done) return;
    const onUse = use.rule?.onUse;
    const area = onUse?.targets === "area";

    if (use.confidence === "low") {
      // §3.G: не исполняем; stepKey шагов apply = "u<i>"
      const applied = use.state?.derived?.applied ?? [];
      const pending = (onUse?.apply ?? []).map((_, i) => `u${i}`).filter((k) => !applied.includes(k));
      await setState(message, { derived: { pending, applied }, done: true });
      return;
    }

    if (onUse?.apply?.length && modeOf("effect") === "auto") await applyUseSteps(message, use, { targets: !area });   // область: цели берёт runRegion

    if (use.rule.macros?.some((m) => m.phase === "onUse") && modeOf("macro") !== "off") {
      const targets = (await Promise.all(inRange(use.targets).map((t) => fromUuid(t.uuid)))).filter(Boolean);
      await macros.runMacros("onUse", { message, rule: use.rule, targets });
    }

    // область — только из createRegion; consume-снимок с областью сам испытание не запускает
    if ((onUse?.challenge || onUse?.check) && !area && modeOf("challenge") === "auto") await saves.runChallenge(message);
    await setState(message, { done: true });
  });
}

/** Регион из карточки/каста = акт использования зоны/испытания (§3.B-4, §3.C-3), независимо от kind источника. */
export async function runRegion(region, message) {
  const first = useOf(message);
  if (first?.state?.yielded) return;
  let rule = first?.rule;
  if (!first) {
    const r = rules.resolveRule({ origin: region.flags?.pf2e?.origin });
    if (!r || compat.shouldYield(r.rule, { slug: r.slug, sourceUuid: r.sourceUuid })) return;
    rule = r.rule;   // сообщения/снимка нет: возможна только зона, состояние писать некуда
  }
  const onUse = rule?.onUse;
  if (!onUse) return;
  const origin = region.flags?.pf2e?.origin ?? {};

  return queue(first ? `use:${message.id}` : `use:region:${region.uuid}`, async () => {
    const use = useOf(message);   // свежий снимок: предыдущие запуски в очереди могли его менять
    const zoneMode = modeOf("zone");

    if (use?.confidence === "low") {
      if (onUse.zone && zoneMode !== "off") {
        const pending = [...new Set([...(use.state?.derived?.pending ?? []), "zone"])];
        await setState(message, { derived: { pending, applied: use.state?.derived?.applied ?? [] }, zone: { regionUuid: region.uuid, status: "pending" } });
      }
      return;
    }

    if (onUse.zone && zoneMode !== "off") {
      const prev = use?.state?.zone?.regionUuid;
      if (prev && prev !== region.uuid) await tolerate("closeZone", () => zone.closeZone(prev));
      if (zoneMode === "auto") {
        // attachZone сам делает sweepZone
        await zone.attachZone(region, rule, {
          originUuid: use?.item?.uuid ?? origin.uuid ?? "", originActor: use?.actor ?? origin.actor ?? "",
          messageId: message?.id ?? "", name: use?.item?.name
        });
      }
      if (use) await setState(message, { zone: { regionUuid: region.uuid, status: zoneMode === "auto" ? "active" : "pending" } });
    }

    if (!use || onUse.targets !== "area") return;
    const targetSteps = use.kind === "use" ? (onUse.apply ?? []).filter((s) => s.to === "target") : [];
    if (!onUse.challenge && !onUse.check && !targetSteps.length) return;

    const excl = onUse.excludeSelf ?? emanationDefault(region);
    const tokens = (region.parent?.tokens?.contents ?? [])
      .filter((t) => t.testInsideRegion(region))
      .filter((t) => !(excl && (use.token ? t.uuid === use.token : t.actor?.uuid === use.actor)))
      .map((t) => ({ key: t.id, uuid: t.uuid, name: t.name, pc: !!t.actor?.hasPlayerOwner }));
    const u = areaUpdate(use, region.uuid, tokens);
    await message.update({
      [flagPath("use", "state", "area")]: u.area,
      [flagPath("use", "targets")]: u.targets,
      ...Object.assign({}, ...u.drop.map((k) => forcedDelete(flagPath("use", "state", "challenge", "results", k))))
    });

    if (targetSteps.length && modeOf("effect") === "auto") {
      for (const t of tokens) {
        const doc = await fromUuid(t.uuid);
        if (doc) await apply.applyOps(message, t.key, targetSteps, { scope: "apply", target: doc, region });
      }
    }
    if ((onUse.challenge || onUse.check) && modeOf("challenge") === "auto") await saves.runChallenge(message);
  });
}

/** Последний живой регион сообщения -> runRegion, если область ещё не снята (K7 п.5). Вне очереди use:<id> — runRegion берёт её сам. */
async function resumeRegion(messageId) {
  const message = game.messages.get(messageId), use = useOf(message);
  if (!use || use.kind !== "use" || use.state?.yielded || use.rule?.onUse?.targets !== "area" || use.state?.area || use.state?.zone) return false;
  const region = allRegions().filter((r) => r.flags?.pf2e?.messageId === messageId).at(-1);
  if (!region) return false;
  await runRegion(region, message);
  return true;
}

/** Кнопка «Дозапустить»: execUse + (для области) дозапуск по уже существующему региону. */
export async function resumeUse(messageId) {
  await runUse(messageId);
  return resumeRegion(messageId);
}

/** §3.H: дозапуск свежих незавершённых использований; режимы уважает execUse. */
export async function resumePending({ maxAgeMinutes } = {}) {
  const age = maxAgeMinutes ?? S.get("resumeMinutes");
  const now = Date.now();
  const recent = game.messages.contents.slice(-100);
  const list = recent.filter((m) => isResumable(useOf(m), now, age));
  for (const m of list) await tolerate("resume", () => execUse(m.id, true));
  for (const m of recent) {
    const u = useOf(m);
    if (u?.kind === "use" && !u.state?.awaitingRegion && now - (u.createdAt ?? 0) <= age * 60000) await tolerate("resumeRegion", () => resumeRegion(m.id));
  }
  return list.length;
}
