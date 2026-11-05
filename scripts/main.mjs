import { MOD, L, setSocket, guardActiveGM, flagPath, callGM, degreeFromTotal, debug, queue, allowed } from "./util.mjs";
import * as settings from "./settings.mjs";
import * as compat from "./compat.mjs";
import * as rules from "./rules.mjs";
import * as apply from "./apply.mjs";
import * as zone from "./zone.mjs";
import * as height from "./height.mjs";
import * as use from "./use.mjs";
import * as saves from "./saves.mjs";
import * as macros from "./macros.mjs";
import * as chat from "./chat.mjs";
import * as reactions from "./reactions.mjs";
import * as sheet from "./sheet.mjs";
import * as badge from "./badge.mjs";
import * as vision from "./vision.mjs";
import * as invis from "./invis.mjs";
import * as actions from "./actions.mjs";
import * as workshop from "./workshop/app.mjs";
import * as leader from "./leader.mjs";
import * as shieldBlock from "./builtin/shield-block.mjs";
import * as hud from "./hud.mjs";
import * as damageGate from "./damage-gate.mjs";
import * as turnConditions from "./turn-conditions.mjs";
import * as escape from "./escape.mjs";
import * as events from "./events.mjs";
import * as hold from "./hold.mjs";
import * as cast from "./cast.mjs";
import * as migrateActivate from "./migrate-activate.mjs";
import * as affliction from "./affliction-run.mjs";
import * as sustain from "./sustain.mjs";

const { S } = settings;

// Обёртка обработчика: только активный ГМ; ошибки возвращаются как { ok:false, reason:"error" }.
// need — права отправителя (util.allowed): "gm" | "author" | "owner"; check(user, ...args) -> ctx для allowed.
// Обработчики — обычные function (не стрелки): внутри доступен this.socketdata.userId.
const gm = (name, fn, need = "gm", check = null) => ({
  [name]: async function (...args) {
    if (game.user?.isActiveGM && !leader.isLeader()) return new Promise(() => {});   // не-лидер никогда не отвечает и не исполняет: результат пришлёт лидер (socketlib берёт первый ответ)
    if (!guardActiveGM()) return { ok: false, reason: "not-active-gm" };
    try {
      const user = game.users.get(this.socketdata?.userId);
      if (!allowed(user, need, need === "gm" ? {} : await check(user, ...args))) return { ok: false, reason: "forbidden" };
      return { ok: true, result: await fn.apply(this, args) };
    } catch (e) { console.error(`${MOD} | ${name}`, e); return { ok: false, reason: "error", error: String(e?.message ?? e) }; }
  }
})[name];
function msgOf(id) {
  const m = game.messages.get(id);
  if (!m) throw new Error(`нет сообщения ${id}`);
  return m;
}
const authorOf = (_user, messageId) => ({ authorId: game.messages.get(messageId)?.author?.id });
const ownsActor = (actor, user) => !!actor?.testUserPermission?.(user, "OWNER");

// §5. Права отправителя — seam-review п.1.
export const HANDLERS = {
  rollSaveFor: gm("rollSaveFor", (messageId, tokenKey) => saves.runChallenge(msgOf(messageId), { only: tokenKey }), "owner", async (user, messageId, tokenKey) => {
    const t = (await saves.challengeTargets(game.messages.get(messageId))).find((x) => x.key === tokenKey);
    return { owns: ownsActor(t?.token?.actor, user) };
  }),
  recordToolbeltSave: gm("recordToolbeltSave", (messageId, tokenKey, res) => saves.recordToolbeltResult(messageId, tokenKey, res), "owner", async (user, messageId, tokenKey) => {
    const t = (await saves.challengeTargets(game.messages.get(messageId))).find((x) => x.key === tokenKey);
    return { owns: ownsActor(t?.token?.actor, user) };
  }),
  applyByDegree: gm("applyByDegree", (messageId, tokenKey) => saves.applyByDegree(messageId, tokenKey)),
  undoApplied: gm("undoApplied", (messageId, tokenKey) => queue(`msg:${messageId}`, async () => {
    const m = msgOf(messageId);
    const keys = tokenKey === "all" ? (m.flags[MOD]?.use?.targets ?? []).map((t) => t.key) : [tokenKey];
    for (const k of keys) await apply.undoOps(m, k);
  })),
  applyUse: gm("applyUse", (messageId, targetKey) => use.applyUse(messageId, targetKey), "author", authorOf),
  applyDerived: gm("applyDerived", (messageId, stepKey) => use.applyDerived(messageId, stepKey), "author", authorOf),
  createZone: gm("createZone", (messageId, regionUuid) => use.createZone(messageId, regionUuid)),
  closeZone: gm("closeZone", (regionUuid) => zone.closeZone(regionUuid), "author", (_u, regionUuid) => authorOf(_u, zone.zoneMessageId(regionUuid))),
  resumeUse: gm("resumeUse", (messageId) => use.resumeUse(messageId)),
  setDC: gm("setDC", async (messageId, value) => {
    const m = msgOf(messageId), u = m.flags[MOD]?.use;
    if (!u || !Number.isFinite(value)) throw new Error("setDC: нет снимка или значение не число");
    if (Object.keys(u.state?.challenge?.results ?? {}).length) throw new Error("setDC: уже есть результаты");
    await m.update({ [flagPath("use", "dc")]: value, [flagPath("use", "state.dcSet")]: true });
    await saves.runChallenge(game.messages.get(messageId));   // испытание стартует по введённой СЛ (K7 п.7)
  }),
  useReaction: gm("useReaction", (hintMessageId) => reactions.useReaction(hintMessageId), "owner", async (user, hintMessageId) => {
    const uuid = game.messages.get(hintMessageId)?.flags?.[MOD]?.reaction?.actor;
    return { owns: uuid ? ownsActor(await fromUuid(uuid), user) : false };
  }),
  markStrikeUsed: gm("markStrikeUsed", (messageId) => msgOf(messageId).setFlag(MOD, "strike.used", true), "owner", async (user, messageId) => {
    const uuid = game.messages.get(messageId)?.flags?.[MOD]?.strike?.actor;
    return { owns: uuid ? ownsActor(await fromUuid(uuid), user) : false };
  }),
  useShieldBlock: gm("useShieldBlock", (hintId, cb) => shieldBlock.useBlock(hintId, cb), "owner", async (user, hintId) => {
    const h = game.messages.get(hintId)?.flags?.[MOD]?.shieldBlock;
    if (h?.guard) return { owns: ownsActor(await fromUuid(h.guard), user) };   // прикрывает держатель щита, а не цель
    const uuid = h?.token;   // урон уходит в токен, а не в actor из подсказки
    return { owns: uuid ? ownsActor((await fromUuid(uuid))?.actor, user) : false };
  }),
  markDamageApplied: gm("markDamageApplied", (messageId, tokenUuid) => shieldBlock.markApplied(messageId, tokenUuid), "owner", async (user, _m, tokenUuid) => ({ owns: ownsActor((await fromUuid(tokenUuid))?.actor, user) })),
  settleLink: gm("settleLink", (targetUuid, rows, round) => shieldBlock.settleLink(targetUuid, rows, round), "owner", async (user, targetUuid) => ({ owns: ownsActor(await fromUuid(targetUuid), user) })),
  dropSpellShield: gm("dropSpellShield", (actorUuid, effectId, layers) => shieldBlock.dropSpellShield(actorUuid, effectId, layers), "owner", async (user, actorUuid) => ({ owns: ownsActor(await fromUuid(actorUuid), user) })),
  applyRetch: gm("applyRetch", (actorUuid, degree) => turnConditions.applyRetch(actorUuid, degree), "owner", async (user, actorUuid) => ({ owns: ownsActor(await fromUuid(actorUuid), user) })),
  applyEscape: gm("applyEscape", (actorUuid, items, degree) => escape.applyEscape(actorUuid, items, degree), "owner", async (user, actorUuid) => ({ owns: ownsActor(await fromUuid(actorUuid), user) })),
  sustainRun: gm("sustainRun", (actorUuid, key, how) => sustain.run(actorUuid, key, how), "owner", async (user, actorUuid) => ({ owns: ownsActor(await fromUuid(actorUuid), user) })),   // кнопки «Поддержать / Прекратить» шёпота якоря
  holdResolve: gm("holdResolve", (messageId, how) => hold.resolveManual(messageId, how)),   // ручные кнопки удержанной атаки (damage-gate)
  dismissVis: gm("dismissVis", (sceneId, key) => vision.dismissSource(game.scenes.get(sceneId), key)),
  saveCatalogRule: gm("saveCatalogRule", (key, rule) => rules.saveWorldRule(key, rule))
};

// socketlib.ready вызывается внутри init socketlib — подписка на верхнем уровне скрипта.
Hooks.once("socketlib.ready", () => {
  const s = socketlib.registerModule(MOD);
  setSocket(s);
  leader.register(s, HANDLERS);
  for (const [name, fn] of Object.entries(HANDLERS)) s.register(name, fn);
  s.register("runPlayerBuiltin", macros.runPlayerBuiltin);   // исполняется у игрока, не у ГМа (проверка отправителя внутри)
  s.register("pickChoice", apply.pickChoice);                // окно выбора ChoiceSet у игрока (проверка отправителя внутри)
});

Hooks.once("setup", () => leader.start());

Hooks.once("init", () => {
  settings.init(); compat.init(); zone.init(); height.init(); saves.init(); use.init(); actions.init(); chat.init(); reactions.init(); sheet.init(); badge.init(); vision.init(); invis.init(); workshop.init(); hud.init(); damageGate.init(); turnConditions.init(); escape.init(); events.init(); sustain.init(); cast.init(); migrateActivate.init(); affliction.init();
  game.modules.get(MOD).api = {
    // контракт plan.md §2 main
    attachZone: zone.attachZone, sweepZone: zone.sweepZone, closeZone: zone.closeZone, expireZones: zone.expireZones,
    resolveRule: rules.resolveRule, runUse: use.runUse, runRegion: use.runRegion,
    runChallenge: saves.runChallenge, recordResult: saves.recordResult, applyByDegree: saves.applyByDegree,
    runMacros: macros.runMacros, automationsCovers: compat.automationsCovers,
    resumePending: use.resumePending, reconcileZones: zone.reconcileZones,
    onAttackMessage: reactions.onAttackMessage, useReaction: reactions.useReaction, recalcWithBonus: reactions.recalcWithBonus,
    // для живой проверки K0 и харнесса
    applyCondition: apply.applyCondition, applyEffect: apply.applyEffect, hasEffect: apply.hasEffect, applyOps: apply.applyOps,
    undoOps: apply.undoOps, removeByKey: apply.removeByKey, findByKey: apply.findByKey,
    automationsGroups: compat.automationsGroups, shouldYield: compat.shouldYield,
    validateRule: rules.validateRule, deriveFromMarkup: rules.deriveFromMarkup, deriveCast: rules.deriveCast, castItem: cast.castItem, slugOf: rules.slugOf, sourceOf: rules.sourceOf,
    openWorkshop: workshop.Workshop.open, afflictionTick: affliction.tick, afflictionSweep: affliction.sweep,
    degreeFromTotal, callGM, HANDLERS, holdResolve: hold.resolveManual, isHeld: hold.isHeld
  };
});

Hooks.once("ready", async () => {
  const protos = game.modules.filter((m) => m.active && m.id.startsWith("pf2e-autoflow-proto"));
  if (protos.length) ui.notifications.warn(`${L("protoWarning")} (${protos.map((m) => m.id).join(", ")})`);
  await rules.ready(); await chat.ready(); compat.ready(); cast.ready();
  // При каждом переходе в лидеры (первый — после ready, потом — когда прежний лидер закрыт/перезагружен): подхватить его работу.
  leader.onLead(async () => {
    if (!guardActiveGM()) return;
    for (const step of [() => zone.reconcileZones(), () => use.resumePending({ maxAgeMinutes: S.get("resumeMinutes") }), () => affliction.sweep(), () => sustain.sweep(game.combat)]) {
      try { await step(); }
      catch (e) { if (String(e?.message).startsWith("not implemented")) debug(e.message); else console.error(`${MOD} | ready`, e); }   // пока куски не готовы — заглушки
    }
  });
  leader.markReady();
});
