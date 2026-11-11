// K2: конвейер использования. Контракт — plan.md §2 use.mjs, §3.A–C, §3.H, §1.4.
import { MOD, L, flagPath, guardActiveGM, queue, debug, forcedDelete, useTargetOverride, afterDice, sceneOfUuid } from "./util.mjs";
import { S, modeOf } from "./settings.mjs";
import * as compat from "./compat.mjs";
import * as rules from "./rules.mjs";
import * as apply from "./apply.mjs";
import * as zone from "./zone.mjs";
import * as areaCleanup from "./area-cleanup.mjs";
import * as saves from "./saves.mjs";
import * as macros from "./macros.mjs";
import * as reactions from "./reactions.mjs";
import * as actions from "./actions.mjs";
import { itemRange, markFar, inRange, TENTACLES } from "./range.mjs";
import { recentShape, spentOptions, optionOf } from "./builtin/spellshape.mjs";
import { moveOrder, areaPoint } from "./move.mjs";
import { asksActions, pf2eVariants, variantActions } from "./builtin/variable-cast.mjs";
import { isHeld, replayers } from "./hold.mjs";
import * as sustain from "./sustain.mjs";
import { whisper, esc } from "./builtin/lib.mjs";
import { spellDcOf } from "./familiar.mjs";
import { strikeLinked } from "./strike-link.mjs";

const CAST = "origin:action:slug:cast-a-spell";
const CARD_TYPES = new Set(["consumable", "equipment", "spell", "weapon", "armor", "treasure", "backpack", "shield", "ammo"]);   // ammo: активация боеприпаса (Golden-Cased Bullet) — с карточки

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
/** Бой и раунд сотворения (бой, где актёр участвует) — для Поддержания: «сотворено в этом раунде = поддержано». null — вне боя. */
const castAt = (actorUuid) => { const p = globalThis.game?.combats ? sustain.posOfActor({ uuid: actorUuid }) : null; return p?.combat ? p : null; };   // тот же бой, что у Поддержания и лимитов (combatOf)
export function buildSnapshot(i) {
  const rule = JSON.parse(JSON.stringify(i.resolved.rule));
  const state = {};
  if (i.yielded) state.yielded = i.yielded;
  // расходник с областью: актом использования станет регион из карточки (§3.A-6)
  if (i.kind === "use" && (i.consume || i.activation) && rule.onUse?.targets === "area") state.awaitingRegion = true;   // активация: шаблон — из текста Effect в сообщении активации
  // переменное заклинание: исполнение ждёт число действий, его пишет и флаг снимает variable-cast (state.awaitingActions), продолжает updateChatMessage
  if (i.kind === "use" && i.awaitingActions && !i.yielded) state.awaitingActions = true;
  return {
    v: 1, kind: i.kind, rule, src: i.resolved.source, confidence: i.resolved.confidence,
    ...(((i.resolved.hints?.possible?.length ?? 0) + (i.resolved.hints?.excluded?.length ?? 0)) && { hints: { possible: i.resolved.hints.possible ?? [], excluded: i.resolved.hints.excluded ?? [] } }),   // подсказки разметки (только ГМу в чате)
    slug: i.resolved.slug ?? null, sourceUuid: i.resolved.sourceUuid ?? null,
    item: i.item, actor: i.actor ?? null, token: i.token ?? null,
    dc: i.dc ?? null, createdAt: i.now, ...(castAt(i.actor) && { at: castAt(i.actor) }), targets: i.targets ?? [], state,
    ...(i.rollOptions?.length && { rollOptions: i.rollOptions })
  };
}

/** Нужен ли снимок: у карточки — только для правила с областью (§3.A-2); без onUse/macros снимать нечего. */
export function wantsSnapshot(kind, rule) {
  if (!rule || (!rule.onUse && !rule.macros?.length && !rules.activateOf(rule)?.length)) return false;
  if (rules.activateOf(rule)?.length) return true;   // кнопки «Сотворить» рисуются на карточке предмета (cast.mjs), снимок нужен всегда
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
  if (!use || use.kind !== "use" || use.state?.yielded || use.state?.done || use.state?.awaitingRegion || use.state?.awaitingActions) return false;
  return now - (use.createdAt ?? 0) <= maxAgeMinutes * 60000;
}

// PF2e (Areas of Effect): эманация, конус и линия исходят от создателя и его не задевают (эманация — «если не сказано иное»); взрыв/цилиндр задевают всех внутри, в т.ч. автора.
const SELF_EXCLUDED_SHAPES = new Set(["emanation", "cone", "line"]);
export const emanationDefault = (region) => SELF_EXCLUDED_SHAPES.has(region?.flags?.pf2e?.areaShape);
/** Исключать ли автора из целей области: явный onUse.excludeSelf важнее умолчания по фигуре. */
export const excludesAuthor = (onUse, region) => !!(onUse?.excludeSelf ?? emanationDefault(region));

/* ---------- клиент автора (синхронно) ---------- */

/** Снимок use уже есть. Другие флаги модуля (castTargets, preyTargets встроенных обработчиков) снимку не мешают. */
export const hasSnapshot = (message) => !!message.flags?.[MOD]?.use;

function onPreCreateMessage(message, data, options, userId) {
  if (userId !== game.user.id) return;
  if (hasSnapshot(message)) return;
  const kind = useKindOf(message);
  if (!kind) return;
  const origin = message.flags.pf2e.origin;
  const item = message.item ?? (origin.uuid ? fromUuidSync(origin.uuid) : null);
  if (item?.system?.selfEffect) return;   // делает система (pf2e:54140)
  // способность, которую модуль запускает сам по урону Удара (strike-link.mjs): карточка без кнопок, обход — Alt (решение ГМа); иначе ручной путь дал бы второе применение
  const linked = kind === "use" && item && strikeLinked(item);
  if (linked && !game.keyboard?.isModifierActive?.("Alt")) { ui.notifications.info(L("events.strike.linked", { item: item.name, strike: linked.strikes.map((s) => s.name).join(", ") })); return; }
  const found = rules.resolveRule({ origin, item });
  const resolved = found && { ...found, rule: rules.withActivation(found.rule, message.flags?.[MOD]?.activation) };   // срок/иммунитет записи активации поверх правила заклинания (копия)
  if (!resolved || !wantsSnapshot(kind, resolved.rule)) return;

  const sp = message.speaker ?? {};
  const tokenDoc = speakerToken(sp);
  const actor = origin.actor ?? tokenDoc?.actor?.uuid ?? (sp.actor ? game.actors.get(sp.actor)?.uuid : null);
  const targets = liveTargets(resolved.rule.onUse, sp, item, origin.rollOptions, message.flags?.["pf2e-vision"]?.flatFailed);
  const chDc = resolved.rule.onUse?.challenge?.dc;
  let dc = (message.flags?.[MOD]?.activation ?? message.flags?.[MOD]?.cast)?.dc ?? chDc?.value ?? null;   // СЛ активации (cast.mjs) приоритетнее СЛ правила заклинания
  if (dc == null && !resolved.rule.onUse?.check && (!chDc || chDc.source === "spell")) {   // СЛ заклинателя — только если правило её и просит (K7 п.7)
    try { dc = item?.spellcasting?.statistic?.withRollOptions?.({ item })?.dc?.value ?? null; } catch { dc = null; }
  }
  const yielded = compat.shouldYield(resolved.rule, { slug: resolved.slug, sourceUuid: resolved.sourceUuid }) ? "pf2e-automations" : null;
  const snapshot = buildSnapshot({
    kind, resolved, consume: isConsume(message), yielded, dc, targets, now: Date.now(),
    // варианты pf2e: ждать кнопку варианта и без макросов — окна нет, от варианта зависят цели
    awaitingActions: (modeOf("macro") !== "off" || pf2eVariants(item)) && !message.flags?.[MOD]?.cast?.actions && asksActions(origin, item?.system?.time?.value),
    item: { uuid: origin.uuid ?? null, name: item?.name ?? origin.name ?? "", type: origin.type ?? item?.type ?? null, sourceId: resolved.sourceUuid },
    actor, token: tokenDoc?.uuid ?? null
  });
  message.updateSource({ [flagPath("use")]: snapshot });
}

/** Автор: цели Toolbelt (targetHelper) без провалившихся чистую проверку PF2e Vision — иначе его кнопки спасброска и урона остаются по ним.
 *  После создания: порядок хуков preCreate AuTOMATO и Toolbelt не гарантирован. */
function dropFlatFromToolbelt(message) {
  const failed = new Set(message.flags?.["pf2e-vision"]?.flatFailed), tb = message.flags?.["pf2e-toolbelt"]?.targetHelper?.targets;
  if (!message.isAuthor || !failed.size || !tb?.some((u) => failed.has(u))) return;
  message.update({ "flags.pf2e-toolbelt.targetHelper.targets": tb.filter((u) => !failed.has(u)) }).catch((e) => console.error(`${MOD} | toolbelt flat`, e));
}

/** Токен автора сообщения по speaker. */
export const speakerToken = (sp) => (sp?.scene && sp.token ? game.scenes.get(sp.scene)?.tokens.get(sp.token) : null);

/** Цели нажавшего в снимок; для шагов по цели вне дальности — пометка far и предупреждение (область цели не берёт). */
export function liveTargets(onUse, sp, item, rollOptions = [], flatFailed = []) {
  const tokenDoc = speakerToken(sp);
  const forced = useTargetOverride.get(item?.actor?.uuid ?? tokenDoc?.actor?.uuid);
  const targets = [...(forced ?? game.user.targets ?? [])].map((t) => t.document ?? t).map((d) => ({
    key: d.id, uuid: d.uuid, name: d.name, pc: !!d.actor?.hasPlayerOwner
  }));
  if (onUse?.targets !== "area" && targets.length && (onUse?.challenge || onUse?.check || onUse?.apply?.some((a) => a.to === "target"))) {
    const far = markFar(targets, tokenDoc?.object, itemRange(item, [...(rollOptions ?? []), ...casterOptions(item?.actor ?? tokenDoc?.actor)])).filter((t) => t.far);
    for (const t of far) targets.find((x) => x.key === t.key).far = t.far;
    if (far.length) ui.notifications?.warn(far.map((t) => L("chat.outOfRange", { name: t.name, d: t.far.d, r: t.far.r })).join(" "));
  }
  return markFlat(targets, flatFailed);
}

/** Чистая: цели, провалившие чистую проверку PF2e Vision (UUID из flags["pf2e-vision"].flatFailed), — far {flat:true}, как цели вне дальности. */
export function markFlat(targets, flatFailed) {
  const failed = new Set(flatFailed ?? []);
  return failed.size ? targets.map((t) => (failed.has(t.uuid) ? { ...t, far: { flat: true } } : t)) : targets;
}

/**
 * Сообщение использования активации: снимок kind "use" с производным правилом {v, onUse}; flags.pf2e.origin нет (его приняли бы за сотворение заклинания),
 * вместо него метка activation = {item, id, choice?, useId}. rollOptions снимка идут в `when` шагов. СЛ уже посчитана (onPreCreateMessage для него пропускается: hasSnapshot).
 * -> данные ChatMessage без speaker.
 */
export function activationUse({ item, resolved, onUse, dc, targets, rollOptions = [], activation, actor, token, content, now = Date.now() }) {
  const snapshot = buildSnapshot({
    kind: "use", activation: true, dc, targets, now, rollOptions, actor, token,
    resolved: { rule: { v: resolved?.rule?.v ?? 1, onUse }, source: resolved?.source, confidence: resolved?.confidence, slug: resolved?.slug, sourceUuid: resolved?.sourceUuid },
    item: { uuid: item.uuid, name: item.name, type: item.type, sourceId: resolved?.sourceUuid ?? null }
  });
  return { content, flags: { [MOD]: { use: snapshot, activation } } };
}

/** Опции актёра для дальности: метамагия (`spellshape:*`, не feat:reach-spell — это наличие черты) без потраченной на прошлое сотворение,
 *  метамагия, нажатая только что (эффект ведущий ещё не создал), и «Руки-щупальца». */
function casterOptions(caster) {
  if (!caster) return [];
  const spent = spentOptions(caster.items ?? []);
  const own = Object.entries(caster.rollOptions?.all ?? {}).filter(([o, on]) => on && !spent.includes(o) && (o.startsWith("spellshape:") || o === TENTACLES)).map(([o]) => o);
  const recent = recentShape(game.messages.contents, caster.uuid, (uuid) => { const f = fromUuidSync(uuid); return f?.parent === caster ? optionOf(f) : null; });
  return recent ? [...own, recent] : own;
}

function onPreCreateRegion(region, data, options, userId) {
  if (userId !== game.user.id) return;
  const pf = data?.flags?.pf2e;
  if (!pf) return;
  // место области дальше дальности: блок + предупреждение, обход — Alt при размещении (как у целей вне дальности, решение ГМа)
  if (!game.keyboard?.isModifierActive?.("Alt")) {
    const far = zone.areaFarFor(data, region.parent);
    if (far) { ui.notifications?.warn(L("zone.areaFar", far)); return false; }
  }
  const useFlag = pf.messageId ? game.messages.get(pf.messageId)?.flags?.[MOD]?.use : null;
  let rule = useFlag?.rule, yielded = useFlag?.state?.yielded;
  if (!useFlag && pf.origin) {
    const r = rules.resolveRule({ origin: pf.origin });
    rule = r?.rule;
    yielded = r && compat.shouldYield(r.rule, { slug: r.slug, sourceUuid: r.sourceUuid });
  }
  if ((rule?.onUse?.zone && modeOf("zone") !== "off" && !yielded) || (useFlag && areaCleanup.managesArea(useFlag))) {
    region.updateSource({ [compat.EXTERNAL.flags.tbSkip]: true });   // Template Helper на зонах и областях, где цели берёт модуль, не нужен (§3.B-2)
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

// карточку могли удалить, пока модуль ждал (анимация костей Dice So Nice, бросок цели): обновлять нечего
const setState = (message, patch) => (game.messages.get(message.id)
  ? message.update(Object.fromEntries(Object.entries(patch).map(([k, v]) => [flagPath("use", "state", k), v])))
  : Promise.resolve());
const useOf = (message) => message?.flags?.[MOD]?.use;

export async function onCreateMessage(message) {
  if (!guardActiveGM() || isHeld(message)) return;   // удержанная атака (hold.mjs) ждёт выпуска: replay вернётся сюда
  const ctx = message.flags?.pf2e?.context?.type;
  if (ctx === "saving-throw" || ctx === "skill-check" || ctx === "perception-check" || ctx === "flat-check" || ctx === "attack-roll") {
    await afterDice(message);   // применение по итогам броска — после анимации костей
    if (!game.messages.get(message.id)) return;   // бросок удалён (переброс Очком героя), пока ждали: итог не применяем
  }
  if (ctx === "saving-throw" || ctx === "skill-check" || ctx === "perception-check" || ctx === "flat-check") {
    const accepted = await tolerate("acceptSavingThrow", () => saves.acceptSavingThrow(message));
    if (!accepted) await tolerate("onRollMessage", () => actions.onRollMessage(message));   // бросок действия из листа/макроса — без карточки
  } else if (ctx === "attack-roll") await tolerate("onRollMessage", () => actions.onRollMessage(message));
  if (ctx === "attack-roll") await tolerate("onAttackMessage", () => reactions.onAttackMessage(message));
  if (useOf(message)?.kind === "use" && !useOf(message).state?.awaitingActions) await tolerate("runUse", () => execUse(message.id, true));
}

/** variable-cast снял awaitingActions (число записано или окно отменено) — ГМ продолжает исполнение.
 *  Вариант pf2e обрабатывает нажавший: он видит сцену заклинателя и свои цели; не успел — дозапуск ГМа (resumePending). */
export async function onUpdateMessage(message, changes, options, userId) {
  if (userId === game.user.id && changes?.flags?.pf2e?.origin?.variant && useOf(message)?.state?.awaitingActions) return void await tolerate("variantChosen", () => variantChosen(message));
  if (!guardActiveGM() || changes?.flags?.[MOD]?.use?.state?.awaitingActions !== false) return;
  if (useOf(message)?.kind !== "use") return;
  await tolerate("runUse", () => execUse(message.id, true));
  await tolerate("resumeRegion", () => resumeRegion(message.id));   // область поставили до ответа в окне — runRegion её пропустил
}

/** Вариант pf2e выбран кнопкой на карточке (pf2e переписал сообщение): число действий и снятие awaitingActions — исполнение продолжит onUpdateMessage.
 *  Правило с областью, а у варианта её нет (Heal за 1–2 действия) — цели выделенные, с дальностью варианта.
 *  Флаг снимается и при сбое (finally) — иначе карточка ждала бы вечно.
 *  ponytail: смена варианта после исполнения («Выберите другой вариант») снимок не пересчитывает — пересчёт, если в игре это всплывёт. */
async function variantChosen(message) {
  const use = useOf(message), item = message.item, origin = message.flags.pf2e.origin, actions = variantActions(origin);
  const patch = { [flagPath("use", "state", "awaitingActions")]: false, ...(actions && { [flagPath("cast")]: { actions } }) };
  try {
    if (use.rule?.onUse?.targets === "area" && item && !item.system?.area) {
      const caster = use.token ? fromUuidSync(use.token) : null;
      const targets = use.targets?.length ? use.targets : liveTargets({}, message.speaker, item);   // у pf2e сначала сотворение, потом вариант: цель могли навести между ними
      patch[flagPath("use", "rule", "onUse", "targets")] = "selected";
      patch[flagPath("use", "targets")] = markFar(targets, caster?.object, itemRange(item, [...(origin.rollOptions ?? []), ...casterOptions(item.actor)]));
    }
  } finally {
    await message.update(patch);
  }
}

async function onCreateRegion(region) {
  if (!guardActiveGM()) return;
  const pf = region.flags?.pf2e;
  if (!pf?.messageId && !pf?.origin) return;
  await tolerate("runRegion", () => runRegion(region, game.messages.get(pf.messageId) ?? null));
}

async function onDeleteRegion(region) {
  if (!guardActiveGM()) return;
  await tolerate("markZoneGone", () => zone.markZoneGone(region));
  await tolerate("purgeZoneState", () => zone.purgeZoneState(region.uuid));
}

export function init() {
  Hooks.on("preCreateChatMessage", onPreCreateMessage);
  Hooks.on("createChatMessage", dropFlatFromToolbelt);
  Hooks.on("preCreateRegion", onPreCreateRegion);
  Hooks.on("createChatMessage", onCreateMessage);
  replayers.add(onCreateMessage);
  Hooks.on("updateChatMessage", onUpdateMessage);
  Hooks.on("createRegion", onCreateRegion);
  Hooks.on("deleteRegion", onDeleteRegion);
  sustain.sustained.add((e) => onPulse(e).catch((err) => console.error(`${MOD} | use.pulse`, err)));
  Hooks.on("deleteItem", (i) => pulseSeen.delete(i.uuid));
  Hooks.on("userConnected", () => { if (guardActiveGM()) tolerate("resume", () => resumePending()); });
}

const regionOf = (uuid) => { try { return uuid ? fromUuidSync(uuid) : null; } catch { return null; } };
const allRegions = () => game.scenes.contents.flatMap((s) => s.regions.contents);

/** Общая часть execUse/applyUse: onUse.apply одним разбиением на self/target — от него зависят индексы meta.key (K7 п.11). */
async function applyUseSteps(message, use, { self = true, targets = true, only = null } = {}) {
  const steps = use.rule?.onUse?.apply ?? [];
  const selfSteps = steps.filter((s) => s.to !== "target").map((s) => ({ ...s, to: s.to ?? "self" }));   // не на цель: себе и группе (party, allies) — один раз, без цикла по целям
  const tgtSteps = steps.filter((s) => s.to === "target");
  if (self && !only && selfSteps.length) await apply.applyOps(message, "self", selfSteps, { scope: "apply" });
  if (!targets || !tgtSteps.length) return;
  const list = await stepTargets(use);
  for (const { key, doc, region } of moveSorted(tgtSteps, list, list[0]?.region, use)) {
    if (only && only !== key) continue;
    if (doc) await apply.applyOps(message, key, tgtSteps, { scope: "apply", target: doc, ...(region && { region }) });
  }
}

/** Шаги move от центра области: цели идут дальние → ближние (толчок) или наоборот (притяжение); без точки порядок прежний. list — [{doc, ...}]. */
function moveSorted(steps, list, region, use = null) {
  const pt = steps.some((s) => s.move?.from === "point") ? areaPoint(use, region) : null;
  if (!pt) return list;
  const c = (d) => { const g = d?.parent?.grid?.size ?? 100; return { x: (d?.x ?? 0) + ((d?.width ?? 1) * g) / 2, y: (d?.y ?? 0) + ((d?.height ?? 1) * g) / 2 }; };
  return moveOrder(steps, list.map((i) => ({ ...c(i.doc), i })), pt).map((o) => o.i);
}

/** Цели шагов: область — токены state.area.keys своей сцены, иначе (и без региона) use.targets. */
async function stepTargets(use) {
  if (use.rule?.onUse?.targets === "area" && use.state?.area) {
    const region = regionOf(use.state?.area?.regionUuid), scene = region?.parent ?? sceneOfUuid(use.state?.area?.regionUuid);
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
    if (use.state?.awaitingActions) throw new Error("applyUse: ждёт числа действий");
    await applyUseSteps(message, use, { only: targetKey || null });
    return true;
  });
}

async function attachFor(message, use, region) {
  await zone.attachZone(region, use.rule, { originUuid: use.item?.uuid ?? "", originActor: use.actor ?? "", messageId: message.id, name: use.item?.name, dc: use.dc });
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
      } else await apply.applyOps(message, "self", [{ ...step, to: step.to ?? "self" }], ctx);
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

    const low = use.confidence === "low";
    if (onUse?.pulse && !use.state?.pulse && !use.state?.done && !low) await tolerate("pulseAnchor", () => pulseAnchor(use, message));
    if (low) {
      // §3.G: шаги apply не исполняем (только кнопкой); stepKey = "u<i>". Бросок испытания — как у high, применение степеней — кнопкой
      const applied = use.state?.derived?.applied ?? [];
      const pending = (onUse?.apply ?? []).map((_, i) => `u${i}`).filter((k) => !applied.includes(k));
      await setState(message, { derived: { pending, applied } });
    }

    if (!low && onUse?.apply?.length && modeOf("effect") === "auto") await applyUseSteps(message, use, { targets: !area });   // область: цели берёт runRegion

    if (!low && use.rule?.macros?.some((m) => m.phase === "onUse") && modeOf("macro") !== "off") {
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
  if (first?.state?.yielded || first?.state?.awaitingActions) return;   // ждёт числа действий: продолжит onUpdateMessage -> resumeRegion
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
    if (use?.state?.area?.closed) return;   // модуль уже убрал мгновенную область карточки: повторный шаблон целей не берёт (иначе урон старого броска ушёл бы новым)
    const zoneMode = modeOf("zone");

    if (use?.confidence === "low") {
      if (onUse.zone && zoneMode !== "off") {
        const pending = [...new Set([...(use.state?.derived?.pending ?? []), "zone"])];
        await setState(message, { derived: { pending, applied: use.state?.derived?.applied ?? [] }, zone: { regionUuid: region.uuid, status: "pending" } });
      }
    } else if (onUse.zone && zoneMode !== "off") {
      const prev = use?.state?.zone?.regionUuid;
      if (prev && prev !== region.uuid) await tolerate("closeZone", () => zone.closeZone(prev));
      if (zoneMode === "auto") {
        // attachZone сам делает sweepZone
        await zone.attachZone(region, rule, {
          originUuid: use?.item?.uuid ?? origin.uuid ?? "", originActor: use?.actor ?? origin.actor ?? "",
          messageId: message?.id ?? "", name: use?.item?.name, dc: use?.dc
        });
      }
      if (use) await setState(message, { zone: { regionUuid: region.uuid, status: zoneMode === "auto" ? "active" : "pending" } });
    }

    if (!use || onUse.targets !== "area") return;
    const targetSteps = use.kind === "use" ? (onUse.apply ?? []).filter((s) => s.to === "target") : [];
    if (!onUse.challenge && !onUse.check && !targetSteps.length) return;

    const excl = excludesAuthor(onUse, region);
    const tokens = (region.parent?.tokens?.contents ?? [])
      .filter((t) => t.testInsideRegion(region))
      .filter((t) => !(excl && (use.token ? t.uuid === use.token : t.actor?.uuid === use.actor)))
      .map((t) => ({ key: t.id, uuid: t.uuid, name: t.name, pc: !!t.actor?.hasPlayerOwner }));
    const u = areaUpdate(use, region.uuid, tokens), point = areaPoint(null, region);
    await message.update({
      [flagPath("use", "state", "area")]: { ...u.area, ...(point && { point }) },   // точка — для сдвига от центра после удаления региона
      ...(S.get("useToolbeltTargetHelper") && compat.toolbeltTargetHelper().enabled && { "flags.pf2e-toolbelt.targetHelper.targets": tokens.map((t) => t.uuid) }),   // skip Toolbelt: цели области пишем вместо его Template Helper
      [flagPath("use", "targets")]: u.targets,
      ...Object.assign({}, ...u.drop.map((k) => forcedDelete(flagPath("use", "state", "challenge", "results", k))))
    });

    if (targetSteps.length && use.confidence !== "low" && modeOf("effect") === "auto") {
      const list = await Promise.all(tokens.map(async (t) => ({ t, doc: await fromUuid(t.uuid) })));
      for (const { t, doc } of moveSorted(targetSteps, list, region)) {
        if (doc) await apply.applyOps(message, t.key, targetSteps, { scope: "apply", target: doc, region });
      }
    }
    if ((onUse.challenge || onUse.check) && modeOf("challenge") === "auto") await saves.runChallenge(message);
    areaCleanup.settleArea(message.id, { flow: true }).catch((e) => debug("area", e));   // не ждём: очередь area отдельная; нужен после шагов на цель (испытания нет)
  });
}

/* ---------- импульс Поддержания (onUse.pulse, docs/plan-sustain-pulse.md) ---------- */

/** Урезанная копия правила для карточки импульса: испытание и шаги to:"target" без inline-эффекта; без pulse/zone/macros и шагов на себя. */
export function pulseRule(rule) {
  const u = rule?.onUse ?? {};
  const apply = (u.apply ?? []).filter((s) => s.to === "target" && !(s.effect && !s.effect.uuid));
  const keep = (list) => (list ?? []).filter((s) => s.to === "target" && !(s.effect && !s.effect.uuid));   // испытание: те же шаги по степеням
  const ch = u.challenge && { ...u.challenge, ...(u.challenge.byDegree && { byDegree: Object.fromEntries(Object.entries(u.challenge.byDegree).map(([k, v]) => [k, keep(v)])) }) };
  return { v: rule?.v ?? 1, onUse: { targets: u.targets, excludeSelf: u.excludeSelf ?? null, ...(ch && { challenge: ch }), apply } };
}

const pulseSeen = new Map();   // якорь -> время последнего импульса вне боя
const areaText = (spell) => { const a = spell?.system?.area; return a?.type && a.value ? `<p>@Template[type:${a.type}|distance:${a.value}]</p>` : ""; };

/**
 * Слушатель sustain.sustained: первое Поддержание раунда -> новая карточка использования с урезанной копией правила.
 * same + живой регион сотворения -> runRegion(регион, карточка). Региона нет (burst снят) либо new: awaitingRegion выставляем здесь и кладём в content @Template
 * (как cast.mjs для активации) — игрок ставит шаблон из карточки, pf2e пишет region.flags.pf2e.messageId, onCreateRegion -> runRegion;
 * resumeRegion («Дозапустить») подхватит последний регион этой карточки, если хук пропущен. same без живого региона ведёт себя как new.
 */
export async function onPulse({ anchor, actor, pos }) {
  const d = anchor.flags?.[MOD]?.sustain;
  if (!guardActiveGM() || !actor || !d || (modeOf("effect") === "off" && modeOf("challenge") === "off")) return;
  const spell = d.src ? await fromUuid(d.src).catch(() => null) : null;
  const cast = d.msg ? game.messages.get(d.msg) : null, cu = useOf(cast);
  if (cu?.state?.yielded) return;
  const found = cu ? null : spell && rules.resolveRule(spell);
  const rule = cu?.rule ?? found?.rule;
  const mode = rule?.onUse?.pulse;
  if (!mode || (!cu && compat.shouldYield(rule, { slug: found.slug, sourceUuid: found.sourceUuid }))) return;
  const base = anchor.flags[MOD].meta.key;
  if (pos?.round == null) { if (Date.now() - (pulseSeen.get(anchor.uuid) ?? 0) < 6000) return; pulseSeen.set(anchor.uuid, Date.now()); }
  const key = pos?.round == null ? `${base}:t${Date.now()}` : `${base}:${pos.combat}:${pos.round}`;
  return queue(`pulse:${base}`, async () => {
    if (game.messages.find((m) => m.flags?.[MOD]?.use?.state?.pulse?.key === key)) return;
    const o = cast?.flags?.pf2e?.origin;
    const castRank = o?.castRank ?? spell?.rank;
    const castRegion = mode === "same" ? regionOf(cu?.state?.area?.regionUuid) : null;
    const waiting = rule.onUse.targets === "area" && !castRegion;
    const snap = buildSnapshot({
      kind: "use", now: Date.now(), actor: actor.uuid, token: cu?.token ?? anchor.system?.context?.origin?.token ?? null,
      dc: cu?.dc ?? spellDcOf(spell), targets: rule.onUse.targets === "selected" ? cu?.targets ?? [] : [],
      rollOptions: [...(o?.rollOptions ?? spell?.getRollOptions?.("origin:item") ?? []), "sustain:pulse"],
      resolved: { rule: pulseRule(rule), source: cu?.src ?? found?.source, confidence: "high", slug: cu?.slug ?? found?.slug, sourceUuid: cu?.sourceUuid ?? found?.sourceUuid },
      item: cu?.item ?? { uuid: spell?.uuid ?? d.src, name: spell?.name ?? "", type: "spell", sourceId: found?.sourceUuid ?? null }
    });
    Object.assign(snap.state, { pulse: { key, anchor: anchor.uuid }, sustainKey: base, ...(waiting && { awaitingRegion: true }) });
    const tpl = waiting ? areaText(spell) : "";
    // ponytail: шаблон — по system.area заклинания; у Widen и подобного (область из текста) его нет — ГМу шёпот «поставьте вручную»
    if (waiting && !tpl) whisper(actor, L("sustain.pulseNoArea", { spell: esc(snap.item.name) }), "sustain", {}, "", "gm").catch(() => {});
    const msg = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker?.({ actor }),
      content: L("sustain.pulse", { spell: esc(snap.item.name) }) + tpl,
      // в origin только castRank: любое другое поле сделало бы карточку «сотворением» (useKindOf, spell-cast, автоякорь фамильяра)
      flags: { [MOD]: { use: snap }, ...(castRank != null && { pf2e: { origin: { castRank } } }) }
    });
    if (msg && castRegion) await runRegion(castRegion, game.messages.get(msg.id) ?? msg);
  });
}

/** Якорь заклинания с onUse.pulse: ставится при сотворении (идемпотентно по ключу), флаг pulse удерживает его от prune. */
async function pulseAnchor(use, message) {
  const spell = use.item?.uuid ? await fromUuid(use.item.uuid).catch(() => null) : null, author = use.actor ? await fromUuid(use.actor).catch(() => null) : null;
  if (!spell?.system?.duration?.sustained || !author) return;
  const { item: anchor } = await sustain.attach(author, null, { key: sustain.anchorKey(message.id), msg: message.id, item: spell, token: use.token ? await fromUuid(use.token).catch(() => null) : null, at: use.at, pulse: true });
  if (anchor && !use.at) pulseSeen.set(anchor.uuid, Date.now());   // вне боя Поддержание сразу после сотворения — не импульс
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
  for (const m of recent) {   // вариант pf2e выбран, а нажавший флаг не снял (вкладка закрылась)
    const u = useOf(m);
    if (u?.kind === "use" && u.state?.awaitingActions && m.flags?.pf2e?.origin?.variant && now - (u.createdAt ?? 0) <= age * 60000) await tolerate("variantChosen", () => variantChosen(m));
  }
  const list = recent.filter((m) => isResumable(useOf(m), now, age));
  for (const m of list) await tolerate("resume", () => execUse(m.id, true));
  for (const m of recent) {
    const u = useOf(m);
    if (u?.kind === "use" && !u.state?.awaitingRegion && !u.state?.awaitingActions && now - (u.createdAt ?? 0) <= age * 60000) await tolerate("resumeRegion", () => resumeRegion(m.id));
  }
  return list.length;
}
