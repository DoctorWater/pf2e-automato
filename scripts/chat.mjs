// K4: блок автоматизации в сообщении чата. Контракт — plan.md §2 chat.mjs, §1.4, §3.G, §5.
import { MOD, L, DEGREES, callGM, damageLabel, sluggify, condValued } from "./util.mjs";
import { placeUnder } from "./damage-button.mjs";
import { modeOf, effectiveMode, S } from "./settings.mjs";
import { automationsGroups, toolbeltTargetHelper } from "./compat.mjs";
import * as saves from "./saves.mjs";
import * as checks from "./checks.mjs";
import * as cast from "./cast.mjs";
import { visionActive, zoneCells } from "./vision.mjs";
import { hintsView, hintList } from "./hints.mjs";
import { whenHuman } from "./predicate.mjs";
import { isActiveStep, activateOf } from "./rules.mjs";
import { textOfMods } from "./inline-effect.mjs";

const TEMPLATE = "modules/pf2e-automato/templates/chat-block.hbs";
let template = null;
// ponytail: снимок прошлого рендера по id сообщения растёт с числом показанных сообщений; чистить в deleteChatMessage, если станет заметно
const lastRender = new Map();   // messageId -> {mt, sigs: Map(key -> подпись строки), flash: Set(key), open} — одна запись на все виды (сайдбар, попаут, уведомление)

export function init() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    renderBlock(message, html).catch((e) => console.error(`${MOD} | chat render`, e));
  });
}

export async function ready() {
  template = await foundry.applications.handlebars.getTemplate(TEMPLATE);
}

/** Статистики проверок, которых нет в CONFIG.PF2E.saves/skills/attributes (игроку — перевод pf2e, не служебное имя). */
const STAT_KEYS = { "spell-attack": "PF2E.SpellAttackLabel", perception: "PF2E.PerceptionLabel", lore: "PF2E.Lore" };

/* ---------- окружение (подменяется в тестах) ---------- */

const tokenDocOf = (key, use) => {
  const t = use.targets?.find((x) => x.key === key);
  if (t?.uuid) return fromUuidSync(t.uuid);
  const sceneId = use.state?.area?.regionUuid?.match(/^Scene\.([^.]+)/)?.[1];
  return game.scenes.get(sceneId)?.tokens.get(key) ?? null;
};
// токен цели на ТЕКУЩЕЙ сцене и видимый пользователю (как pf2e для заголовков сообщений); иначе null
const visibleToken = (key, use) => {
  const doc = tokenDocOf(key, use);
  const obj = doc?.parent === canvas.scene ? doc.object : null;
  return obj?.isVisible ? obj : null;
};
const nameOfUuid = (uuid) => { try { return fromUuidSync(uuid)?.name; } catch { return null; } };

const defaultEnv = () => ({
  t: L,
  mode: modeOf,
  vision: visionActive,
  visCells: zoneCells,
  now: Date.now(),
  lang: game.i18n.lang,
  resumeMinutes: S.get("resumeMinutes"),
  groups: automationsGroups,
  toolbelt: (() => { const th = toolbeltTargetHelper(); return th.enabled && th.checks && S.get("useToolbeltTargetHelper"); })(),
  tokenName: (key, use) => tokenDocOf(key, use)?.name ?? key,
  itemBasic: (use) => !!fromUuidSync(use.item?.uuid)?.system?.defense?.save?.basic,
  metagame: { dcs: !!game.pf2e?.settings?.metagame?.dcs, results: !!game.pf2e?.settings?.metagame?.results },
  isActorPc: (uuid) => !!fromUuidSync(uuid)?.hasPlayerOwner,
  isPc: (key, use) => !!tokenDocOf(key, use)?.actor?.hasPlayerOwner,
  isOwner: (key, use, user) => !!tokenDocOf(key, use)?.actor?.testUserPermission(user, "OWNER"),
  isActorOwner: (uuid, user) => !!fromUuidSync(uuid)?.testUserPermission?.(user, "OWNER"),
  statLabel: (s) => {
    const k = CONFIG.PF2E?.saves?.[s] ?? CONFIG.PF2E?.skills?.[s]?.label ?? CONFIG.PF2E?.skills?.[s] ?? CONFIG.PF2E?.attributes?.[s] ?? STAT_KEYS[s];
    return k ? game.i18n.localize(k) : s;
  },
  valued: condValued,
  conditionLabel: (slug) => {
    const k = CONFIG.PF2E?.conditionTypes?.[slug];
    return k ? game.i18n.localize(k) : slug;
  },
  uuidName: nameOfUuid,
  castInfo: (use, c) => { try { return cast.castInfo(fromUuidSync(use.item?.uuid), c); } catch { return { why: null, left: null, dc: null }; } },
  damageLabel,
  checkDc: (key, use) => checks.checkDcOf(use, tokenDocOf(key, use)?.actor, use.rule.onUse.check),
  skipped: (key, use, ch) => !saves.challengeApplies(ch, tokenDocOf(key, use)?.actor, use.actor, !!use.state?.challenge?.results?.[key]),
  immune: (key, use) => checks.hasImmunity(tokenDocOf(key, use)?.actor, (use.rule.onUse.challenge ?? use.rule.onUse.check).immunity, use.actor)
});

/* ---------- чистые части ---------- */

const mult = saves.damageMultiplier;
const isEmpty = (o) => !o || !Object.keys(o).length;
const authorId = (m) => m.author?.id ?? m.author ?? m.user?.id;

// «(@item.rank)d4» -> «1d4 за круг»; прочие переменные — словами
function persFormulaText(f, t) {
  const m = /^\(@item\.rank\)d(\d+)$/.exec(f);
  if (m) return t("chat.perRank", { dice: `1d${m[1]}` });
  return f.replace(/@item\.rank/g, t("chat.varRank")).replace(/@item\.level/g, t("chat.varItemLevel")).replace(/@actor\.level/g, t("chat.varActorLevel"));
}

/** Заметка с `when` в плане не показывается: applyOps шепчет её ГМу, когда условие выполнено. В режиме off applyOps не запустится — тогда заметка остаётся в плане текстом. */
const planned = (off) => (a) => off || !(a.note && a.when);

/** «Испуг 2»; value не задан у состояния со значением — «Испуг 1» (по умолчанию pf2e). */
export const condText = (env, c) => { const v = c.value || (env.valued?.(c.slug) ? 1 : 0); return `${env.conditionLabel(c.slug)}${v ? ` ${v}` : ""}`; };

export function stepText(a, env, defTo) {
  const t = env.t;
  if (a.note) return a.note;
  if (a.visibility) {
    const v = a.visibility, until = (v.until ?? []).map((u) => t(`chat.visUntil.${u}`)).join(", ");
    const text = t((a.to ?? defTo) === "self" ? "chat.stepVisSelf" : "chat.stepVisTarget", { level: t(`chat.visLevel.${v.level}`), until: until ? ` (${until})` : "" });
    return env.vision?.() === false ? `${text} ${t("chat.visManual")}` : text;
  }
  if (a.affliction) {
    const { def, stage } = a.affliction, v = { name: def.name, stage, of: def.stages.length, dc: def.save.dc };
    return def.save.dc ? t("chat.stepAfflictionDC", v) : t("chat.stepAffliction", v);
  }
  if (a.stageDelta) return t("chat.stepStageDelta");
  if (a.coat) return t("chat.stepCoat");
  if (a.removeKey) return t("chat.stepRemoveKey");
  if (a.hold) return t(`chat.stepHold.${a.hold}`);
  const p = a.persistent;
  if (a.choose) return t(`chat.stepChoose.${a.choose.from}`, { options: (a.choose.options ?? []).map((o) => o.label ?? o.value).join(" / ") });
  const to = { self: "Self", target: "Target", party: "Party", allies: "Allies", chosen: "Chosen" }[a.to ?? defTo] ?? "Target", rank = a.rank ? `[${t("chat.stepRank", { range: a.rank.min != null && a.rank.max != null ? (a.rank.min === a.rank.max ? a.rank.min : `${a.rank.min}–${a.rank.max}`) : a.rank.min != null ? `${a.rank.min}+` : `≤${a.rank.max}` })}] ` : "";
  const when = a.when ? ` [${t("chat.stepWhen", { when: whenHuman(a.when) })}]` : "", say = (key, what) => rank + t(`chat.${key}${to}`, { what, range: a.range }) + when;
  if (a.removeCondition) return say("stepRemove", env.conditionLabel(a.removeCondition.slug));
  if (a.removeEffect) return say("stepRemove", t("chat.stepEffect", { name: a.removeEffect.uuid ? env.uuidName(a.removeEffect.uuid) ?? a.removeEffect.uuid : a.removeEffect.slug }));
  if (a.extendEffect) return say("step", t(a.extendEffect.cast ? "chat.stepExtendCast" : a.extendEffect.chosen ? "chat.stepExtendChosen" : "chat.stepExtend", a.extendEffect));
  if (a.refundFocus) return say("step", t("chat.stepRefundFocus"));
  if (a.rollOption) return say("step", t(a.rollOption.value === false ? "chat.stepOptionOff" : "chat.stepOption", { option: a.rollOption.option }));
  if (a.move) return say("step", t(`chat.stepMove.${a.move.mode}${a.move.from === "point" ? "Point" : ""}`, { distance: a.move.distance }));
  if (a.damage) return say("step", t(a.damage.damageType === "healing" ? "chat.stepHeal" : "chat.stepDamage", { formula: persFormulaText(a.damage.formula, t), type: env.damageLabel?.(a.damage.damageType) ?? a.damage.damageType }) + (a.damage.basic ? ` ${t("chat.stepBasic")}` : ""));
  if (a.condition?.policy === "reduce") return say("step", t("chat.stepReduce", { what: env.conditionLabel(a.condition.slug), n: a.condition.value ?? 1 }));
  const what = p ? t("chat.stepPersistent", { formula: persFormulaText(p.formula, t), type: env.damageLabel?.(p.damageType) ?? p.damageType }) + (p.dc && p.dc !== 15 ? ` (${t("chat.dc", { dc: p.dc })})` : "")
    : a.condition
    ? condText(env, a.condition)
    : a.effect?.mods ? textOfMods(a.effect.mods, { t })
    : (env.uuidName(a.effect?.uuid) ?? a.effect?.uuid ?? "?") + (a.effect?.badge ? ` (${t(a.effect.badge === "decrement" ? "chat.stepBadgeDec" : "chat.stepBadge")})` : "");
  return say("step", what);
}

const visText = (env, uuid) => { const n = env.visCells?.(uuid); return n == null ? null : env.t("vision.zoneCells", { n }); };

function zoneWhat(zone, env) {
  const c = zone?.condition;
  return c ? condText(env, c) : (env.uuidName(zone?.effect?.uuid) ?? "");
}

// stepKey производных шагов (§3.G): "zone" | "u<i>" (onUse.apply) | "c<степень>.<i>" (byDegree); иное — показываем как есть
function describeStep(rule, stepKey, env) {
  const on = rule.onUse ?? {};
  if (stepKey === "zone" && on.zone) return env.t("chat.stepZone", { what: zoneWhat(on.zone, env) });
  let m = /^(?:apply\.|u)?(\d+)$/.exec(stepKey);
  if (m && on.apply?.[m[1]]) return stepText(on.apply[m[1]], env, "self");
  m = /^c(\d)\.(\d+)$/.exec(stepKey);
  const a = m && (on.challenge ?? on.check)?.byDegree?.[DEGREES[m[1]]]?.[m[2]];
  return a ? stepText(a, env, "target") : stepKey;
}

const vsLabel = (vs, env, showDc) => !vs ? "" : vs.dc != null ? (showDc ? env.t("chat.dc", { dc: vs.dc }) : env.t("chat.dcHidden"))
  : vs.defense === "ac" ? env.t("checks.ac") : env.statLabel(vs.defense ?? vs.against);

const PLURALS = new Set(["one", "few", "many", "other"]);   // ключи в lang; zero/two (ar, cy…) -> other
const pendingText = (n, env) => {
  const cat = new Intl.PluralRules(env.lang).select(n);
  return n ? env.t(`chat.pending.${PLURALS.has(cat) ? cat : "other"}`, { n }) : null;
};

/** Чистая: (сообщение, пользователь[, env]) -> модель блока | null. env подменяет доступ к Foundry (тесты). */
export function buildViewModel(message, user, env = null) {
  const use = message?.flags?.[MOD]?.use;
  if (!use?.rule) return null;
  env ??= defaultEnv();
  const t = env.t, rule = use.rule, on = rule.onUse ?? {}, state = use.state ?? {};
  const isGM = !!user.isGM;
  const canAct = isGM || authorId(message) === user.id;
  // метаигра pf2e (game.pf2e.settings.metagame): ГМ видит всё; игрок — СЛ по dcs (СЛ PC видна всегда), итоги по results (владельцу — только число броска)
  const meta = env.metagame ?? { dcs: true, results: true };
  const showDc = isGM || meta.dcs || !!env.isActorPc?.(use.actor);   // СЛ предмета PC видна всегда (pf2e :18900)
  const vm = {
    messageId: message.id, title: rule.label || use.item?.name || t("chat.title"), isGM,
    yielded: null, warnings: [], waiting: null, awaitingRegion: null, zone: null, challenge: null,
    useApply: null, cast: null, derived: [], macroErrors: [], empty: false
  };

  // карточка pf2e над блоком уже показывает название предмета
  if (vm.title === use.item?.name || (use.slug && sluggify(vm.title) === use.slug)) vm.title = null;   // английский label правила = исходное имя предмета: заголовок карточки pf2e уже есть, на языке игрока

  if (state.yielded) {
    vm.yielded = t("chat.yielded");
    return vm;
  }

  if (isGM && rule.yield === false) {
    for (const name of env.groups({ slug: use.slug, sourceUuid: use.sourceUuid })) vm.warnings.push(t("chat.yieldWarn", { name }));
  }

  // все цели вне дальности: проверять и применять не к кому — хватает пометки выше (без «нет целей» и без кнопки СЛ)
  const allFar = on.targets !== "area" && !!use.targets?.length && use.targets.every((x) => x.far);
  if (on.targets !== "area") for (const x of use.targets ?? []) if (x.far) vm.warnings.push(x.far.flat ? t("chat.flatFailed", { name: x.name }) : t("chat.outOfRange", { name: x.name, d: x.far.d, r: x.far.r }));

  const isUse = use.kind === "use", isRoll = use.kind === "roll";   // roll — бросок действия из листа: результат уже есть
  const hasState = ["zone", "area", "challenge", "apply", "derived", "macros"].some((k) => !isEmpty(state[k]));
  // awaitingRegion — до проверки done: runUse ставит done и у расходника, ждущего область
  if (isUse && !hasState && state.awaitingActions) vm.awaitingRegion = t("chat.awaitingActions");   // та же строка-ожидание в блоке
  else if (isUse && !hasState && state.awaitingRegion) vm.awaitingRegion = t("chat.awaitingRegion");
  else if (isUse && !hasState && !state.done) {   // done ставит runUse (use.mjs)
    const waitsArea = on.targets === "area" && !state.area && !state.zone;
    if (waitsArea) vm.awaitingRegion = t("chat.awaitingRegion");
    else if (on.zone || on.challenge || on.check || on.apply?.length || rule.macros?.length) {
      const ageMin = (env.now - (use.createdAt ?? env.now)) / 60000;
      vm.waiting = { text: t("chat.waiting"), canResume: isGM && ageMin >= env.resumeMinutes };
    }
  }

  // зона
  if (state.zone?.status) {
    const st = state.zone.status;
    vm.zone = {
      text: `${t("chat.zone")}: ${t(`chat.zone${st[0].toUpperCase()}${st.slice(1)}`)}`,
      regionUuid: state.zone.regionUuid ?? "",
      canCreate: isGM && st === "pending" && !(state.derived?.pending ?? []).includes("zone"),   // low: зону ставит applyDerived("zone")
      canClose: canAct && st === "active",
      vis: isGM && st === "active" && state.zone.regionUuid ? visText(env, state.zone.regionUuid) : null
    };
  }

  // испытание
  const ck = on.check, ch = on.challenge ?? ck;   // check: бросает автор (checks.mjs), результаты и применение — общие
  if (ch) {
    const modeApply = effectiveMode("apply", use, env.mode), modeChallenge = env.mode("challenge");
    const keys = [...new Set([
      ...(state.area?.keys ?? (on.targets === "area" ? [] : (use.targets ?? []).filter((x) => !x.far).map((x) => x.key))),
      ...Object.keys(state.challenge?.results ?? {})
    ])];
    const basicCh = ch.basic ?? (!ck && !!env.itemBasic?.(use));   // basic не указан в правиле — признак заклинания defense.save.basic (как у builtin/basic-damage)
    const resultsSeen = isGM || meta.results;
    // move в auto: применение ждёт всех бросков (saves.afterRecord), пока пакет не отработал
    const deferred = modeApply === "auto" && !state.challenge?.autoAll && Object.values(ch.byDegree ?? {}).flat().some((s) => s?.move);
    const rows = keys.filter((key) => !env.skipped?.(key, use, ch)).map((key) => {
      const r = state.challenge?.results?.[key];
      const ap = state.challenge?.applied?.[key];
      const steps = r ? (ch.byDegree?.[DEGREES[r.degree]] ?? []) : [];
      const m = r ? mult(r.degree, basicCh) : null;
      const immune = !ap && !!ch.immunity && env.immune(key, use);
      const imm = r && checks.immunityAt(ch.immunity, r.degree) ? ch.immunity : null;   // ставится при этой степени
      const dcN = ck && (isGM || meta.dcs || (ck.vs?.dc == null && env.isPc?.(key, use))) ? (r?.dc ?? env.checkDc(key, use)) : null;
      const seen = !r || isGM || meta.results;   // степень и всё, что её выдаёт (pf2e скрывает и от владельца)
      const seenTotal = seen || env.isOwner(key, use, user);   // бросок публичный: владельцу число оставляем
      const plan = seen ? steps.filter(planned(modeApply === "off")).map((a) => stepText(a, env, "target")) : [];
      if (imm) plan.push(t("checks.immunityPlan", { name: imm.label ?? use.item?.name ?? imm.slug }));
      return {
        key,
        name: use.targets?.find((x) => x.key === key)?.name ?? env.tokenName(key, use),
        dc: dcN != null ? t("chat.dc", { dc: dcN }) : null,
        total: seenTotal ? r?.total ?? null : null,
        label: r ? (seen ? t(`chat.degree.${DEGREES[r.degree]}`) : t("chat.resultHidden")) : immune ? t("checks.immune") : t("chat.noResult"),
        note: r && immune ? t("checks.immuneSkipped") : null,
        degree: r && seen ? DEGREES[r.degree] : "none",
        multiplier: m == null || !seen ? null : t("chat.multiplier", { value: m === 0.5 ? "½" : m }),
        changed: r?.changedAfterApply ? t("chat.changed") : null,
        applied: ap && seen ? t("chat.applied", { degree: t(`chat.degree.${DEGREES[ap.degree]}`) }) : null,
        plan,
        canRoll: !r && !immune && modeChallenge !== "off" && !(modeChallenge === "auto" && !state.challenge?.rollTried?.[key] && (ck ? env.isActorPc && !env.isActorPc(use.actor) : env.isPc && !env.isPc(key, use))) && ck?.roll !== "system" && (ck ? (isGM || env.isActorOwner(use.actor, user)) : !env.toolbelt && (isGM || env.isOwner(key, use, user))),
        canApply: isGM && !!r && !ap && !immune && (steps.some((a) => isActiveStep({ ...a, visibility: a.visibility && env.vision?.() !== false })) || !!imm) && (modeApply === "button" || (modeApply === "auto" && (!!state.challenge?.autoTried?.[key] || deferred))),   // auto применяет сам; после попытки (сбой, «Отменить») кнопка возвращается
        canUndo: isGM && !!ap,
        waiting: !r && !immune,
        // применять больше нечего: иммунная цель отработана без броска; при apply=off применение не требуем
        settled: immune || (!!r && (!!ap || modeApply === "off" || !(steps.some((a) => isActiveStep({ ...a, visibility: a.visibility && env.vision?.() !== false })) || !!imm)))
      };
    });
    const dcKnown = ck || !showDc ? null : use.dc ?? ch.dc?.value ?? null;
    vm.challenge = {
      stat: ck ? (ck.vs ? t("checks.head", { stat: [ck.statistic].flat().map(env.statLabel).join(" / "), vs: vsLabel(ck.vs?.dc != null && checks.dcOverridden(use) ? { ...ck.vs, dc: use.dc } : ck.vs, env, showDc) }) : t("checks.headSelf", { stat: [ck.statistic].flat().map(env.statLabel).join(" / ") }))
        : t("chat.challenge", { stat: env.statLabel(ch.statistic) }),
      basic: basicCh ? t("chat.basic") : null,
      dc: dcKnown != null ? t("chat.dc", { dc: dcKnown }) : null,
      dcUnknown: !ck && showDc && dcKnown == null ? t("chat.dcUnknown") : null,
      canSetDC: isGM && !allFar && (ck ? ck.vs?.dc != null : dcKnown == null) && isEmpty(state.challenge?.results),   // у проверки с фиксированной СЛ — ГМ правит её (Lingering Composition: СЛ по уровню существ)
      toolbelt: ck ? (rows.length || allFar || !(isUse || isRoll) ? null : t(isRoll ? "checks.noTargetRoll" : "checks.noTargets")) : env.toolbelt ? t("chat.challengeOff") : null,
      rows,
      canApplyAll: rows.some((r) => r.canApply),
      canUndoAll: rows.some((r) => r.canUndo),
      pending: pendingText(rows.filter((r) => r.canApply).length, env),
      waiting: deferred && isGM && rows.some((r) => r.canApply) ? rows.filter((r) => r.waiting).length || null : null,   // move в auto: ждём остальных бросков; «Применить всем» — явный выход
      // при скрытых итогах сводка и сворачивание выдали бы, что все прошли
      settled: resultsSeen && rows.length > 0 && rows.every((r) => r.settled),
      resolved: rows.every((r) => !r.waiting),   // у всех целей есть итог (или иммунитет): можно бросать урон — порядок «спасброски → урон» (damage-button.placeUnder)
      summary: resultsSeen ? t("chat.summary", { applied: rows.filter((r) => state.challenge?.applied?.[r.key]).length }) : null
    };
    if (!rows.length && !isUse && !isRoll) vm.challenge = null;
  }

  // onUse.apply (режим effect=button), только high
  if (on.apply?.length && use.confidence !== "low" && isUse) {
    const done = !isEmpty(state.apply);
    const noneToApply = allFar && on.apply.every((a) => a.to === "target");   // шаги только на цели — применять нечего, кнопку не показываем
    vm.useApply = {
      plan: on.apply.filter(planned(env.mode("effect") === "off")).map((a) => stepText(a, env, "self")),
      done: done ? t("chat.applyDone") : null,
      noTargets: !done && on.targets === "selected" && on.apply.some((a) => a.to === "target") && !(use.targets?.length) ? t("checks.noTargets") : null,
      canApply: canAct && !done && !noneToApply && (on.targets !== "area" || !!state.area) && (env.mode("effect") === "button" || (env.mode("effect") === "auto" && !!state.done))   // по области — после размещения   // auto: после попытки (state.done) кнопка на случай сбоя
    };
  }

  // активации cast: кнопка на каждую — владельцу актёра (ведущему всегда); исполняет нажавший клиент, ведущий применит результат из сообщения (cast.mjs)
  // low (вывод из разметки в рантайме) — кнопка только ведущему
  if (activateOf(rule)?.length && use.actor && (use.confidence === "low" ? isGM : env.isActorOwner(use.actor, user))) {
    vm.cast = activateOf(rule).map((c) => {
      const info = env.castInfo(use, c);
      const rank = info.rank ?? (typeof c.rank === "number" ? c.rank : null), showDc = info.dc != null && !!(c.spell || c.onUse?.challenge || c.onUse?.check);   // СЛ нужна заклинанию и испытанию; у выбора и самобаффа её нет
      const meta = [showDc && t("chat.dc", { dc: info.dc }), showDc && info.byLevel && t("cast.byLevel"), rank != null && t("cast.rank", { rank }), c.per && cast.perText(c.per, t), info.left === 0 && t("cast.spent")].filter(Boolean);
      return { id: c.id, text: t(c.spell ? "cast.btn" : "cast.btnUse", { name: c.label ?? env.uuidName(c.spell) ?? c.id }), meta: meta.join(" · "), note: c.note ?? null, why: info.why && t(`cast.why.${info.why}`) };
    });
  }

  // распознанные шаги (low): режим вида off скрывает кнопку
  const applied = state.derived?.applied ?? [];
  for (const key of state.derived?.pending ?? []) {
    if (applied.includes(key)) continue;
    if (env.mode(key === "zone" ? "zone" : "effect") === "off") continue;
    const text = describeStep(rule, key, env);
    vm.derived.push({ key, text, title: t("chat.applyDerivedTitle", { text }), canApply: canAct });
  }

  if (isGM && use.src === "markup" && use.hints) {
    const hv = hintsView(use.hints, { condLabel: env.conditionLabel, degLabel: (d) => t(`chat.degree.${d}`).toLowerCase() });
    const parts = [hv.possible.length && t("chat.hintPossible", { list: hintList(hv.possible) }), hv.excluded.length && t("chat.hintExcluded", { list: hintList(hv.excluded) })].filter(Boolean);
    if (parts.length) vm.hints = parts;
  }

  if (isGM) vm.macroErrors = (state.macros?.errors ?? []).map((e) => `${e.key}: ${e.msg}`);

  vm.empty = !(vm.warnings.length || vm.waiting || vm.awaitingRegion || vm.zone || vm.challenge || vm.useApply || vm.cast || vm.derived.length || vm.macroErrors.length);
  return vm;
}

/** Подсказка реакции (шёпот K5, §3.D'): flags[MOD].reaction = {attack, actor, item, before, after, used}. Общая для чата и окна реакции.
 *  Метаигра: игроку при скрытых результатах (pf2e metagame.results) степени не показываем, ГМу — всегда. */
export function buildReactionViewModel(message, user, env = null) {
  const r = message?.flags?.[MOD]?.reaction;
  if (!r) return null;
  env ??= defaultEnv();
  const t = env.t;
  const item = env.uuidName(r.item) ?? r.item ?? "";
  const showDegrees = !!user.isGM || (env.metagame ?? { results: true }).results;
  const degree = (k) => t(`reactions.degree.${DEGREES[r[k]]}`);   // «попадание/промах», как в окне
  return {
    text: showDegrees ? t("chat.reaction.hint", { item, before: degree("before"), after: degree("after") }) : t("chat.reaction.hintHidden", { item }),
    popup: showDegrees
      ? t("chat.reaction.popup", { item, actor: r.actorName ?? env.uuidName(r.actor) ?? "", before: degree("before"), after: degree("after") })
      : t("chat.reaction.popupHidden", { item, actor: r.actorName ?? env.uuidName(r.actor) ?? "" }),
    used: r.used ? t("chat.reaction.used") : null,
    canUse: !r.used && (!!user.isGM || (!!r.actor && env.isActorOwner(r.actor, user)))
  };
}

/** Подсказка реакции «получит урон»: flags[MOD].damaged. Только для окна реакции; в чате у шёпота свои кнопки (builtin/damaged.mjs). */
export function buildDamagedViewModel(message, user, env = null) {
  const h = message?.flags?.[MOD]?.damaged;
  if (!h) return null;
  env ??= defaultEnv();
  return {
    popup: env.t("builtin.damaged.popup", { item: h.itemName ?? env.uuidName(h.item) ?? "", actor: h.actorName ?? "", target: h.targetName ?? "" }),
    canUse: h.state === "pending" && (!!user.isGM || (!!h.actor && env.isActorOwner(h.actor, user)))
  };
}

/* ---------- DOM ---------- */

async function renderBlock(message, html) {
  const root = html?.querySelector?.(".message-content");
  if (!root) return;
  const vm = buildViewModel(message, game.user);
  const reaction = buildReactionViewModel(message, game.user);
  const showVm = vm && !vm.empty;
  if (!showVm && !reaction) { root.querySelector(":scope > .pf2e-automato")?.remove(); return; }
  template ??= await foundry.applications.handlebars.getTemplate(TEMPLATE);   // до ready() (F5) шаблона ещё нет
  root.querySelector(":scope > .pf2e-automato")?.remove();
  const block = foundry.utils.parseHTML(template({ vm: showVm ? vm : null, reaction }));
  const mt = message._stats?.modifiedTime ?? null;
  let rec = lastRender.get(message.id), fresh = false;
  if (!(rec && mt != null && rec.mt === mt)) {   // тот же mt — это тот же апдейт в другом виде: берём сохранённую подсветку
    const sigs = new Map(), flash = new Set();
    for (const li of block.querySelectorAll(".paf-row[data-key]")) {
      sigs.set(li.dataset.key, li.dataset.sig);
      if (rec && rec.sigs.get(li.dataset.key) !== li.dataset.sig) flash.add(li.dataset.key);   // первый рендер (F5, прокрутка) не мигает
    }
    rec = { mt, sigs, flash, open: rec?.open ?? null };
    fresh = true;
    lastRender.set(message.id, rec);
  }
  for (const li of block.querySelectorAll(".paf-row[data-key]")) if (rec.flash.has(li.dataset.key)) li.classList.add("paf-flash");
  const det = block.querySelector("details.paf-challenge");
  if (det?.classList.contains("paf-settled")) {
    rec.open ??= false;
    det.open = rec.open;   // уже отработанный — свёрнут; дошедший до конца на глазах — остаётся открытым
    det.addEventListener("toggle", () => { lastRender.get(message.id).open = det.open; });
  } else if (fresh) rec.open = true;
  block.addEventListener("click", (ev) => onClick(ev, message.id));
  const tokenOf = (ev) => {
    const el = ev.target.closest?.(".paf-name[data-token]");
    return el && canvas.ready ? visibleToken(el.dataset.token, message.flags[MOD].use) : null;
  };
  block.addEventListener("mouseover", (ev) => { const o = tokenOf(ev); if (o && !o.controlled) o.emitHoverIn(ev); });
  block.addEventListener("mouseout", (ev) => tokenOf(ev)?.emitHoverOut(ev));
  block.addEventListener("click", (ev) => {
    const o = tokenOf(ev);
    if (!o) return;
    if (o.document.isOwner) o.control({ releaseOthers: !ev.shiftKey });
    canvas.animatePan({ ...o.center, duration: 250 });
  });   // новый элемент на каждый рендер -> слушатели не копятся
  root.append(block);
  placeUnder(html, det);   // кнопки «Урон» (damage-button.mjs) — под спасбросками
  const rc = html.querySelector(".paf-recharge-box");
  if (rc?.parentNode === root) root.append(rc);   // «Перезарядка» (recharge-button.mjs) — в самом конце карточки, после блока модуля
}

async function onClick(ev, messageId) {
  const btn = ev.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;
  ev.preventDefault();
  btn.disabled = true;
  try {
    const res = await dispatch(btn.dataset, messageId);
    if (res && res.ok === false && res.reason !== "no-gm") ui.notifications.warn(L("chat.failed", { reason: res.error ?? res.reason }));
  } catch (e) {
    console.error(`${MOD} | chat action ${btn.dataset.action}`, e);
    ui.notifications.error(L("chat.failed", { reason: e.message }));
  } finally { btn.disabled = false; }
}

async function dispatch(d, id) {
  switch (d.action) {
    case "roll-save": return rollSave(id, d.token);
    case "apply": return callGM("applyByDegree", id, d.token || "all");
    case "undo": return callGM("undoApplied", id, d.token || "all");
    case "apply-use": return callGM("applyUse", id, d.token || undefined);
    case "apply-derived": return callGM("applyDerived", id, d.step);
    case "set-dc": {
      const out = await foundry.applications.api.DialogV2.input({
        window: { title: L("chat.setDCTitle") }, classes: ["paf-dialog"],
        content: `<input type="number" name="dc" step="1" autofocus>`,
        ok: { label: L("chat.setDC") }
      });
      const dc = Number(out?.dc);
      return out && out.dc !== "" && Number.isFinite(dc) ? callGM("setDC", id, dc) : null;
    }
    case "resume": return callGM("resumeUse", id);
    case "create-zone": return callGM("createZone", id, d.region);
    case "close-zone": return callGM("closeZone", d.region);
    case "use-reaction": return callGM("useReaction", id);
    case "cast-item": return cast.castItem(await fromUuid(game.messages.get(id)?.flags?.[MOD]?.use?.item?.uuid ?? ""), d.cast);   // исполняет этот клиент: владельцу ведущий не нужен
  }
}

// PC — бросок своим клиентом (результат придёт из saving-throw-сообщения), остальные — через ГМа.
async function rollSave(messageId, key) {
  const message = game.messages.get(messageId);
  const use = message?.flags?.[MOD]?.use;
  const tokenDoc = use && tokenDocOf(key, use);
  const actor = tokenDoc?.actor;
  const ck = use?.rule?.onUse?.check;
  if (ck) {   // бросает автор: PC — локально, NPC — через ГМа
    const author = await fromUuid(use.actor);
    if (author?.hasPlayerOwner) return checks.rollCheck(author, ck, { message, tokenKey: key, target: tokenDoc, askMap: true });
    return callGM("rollSaveFor", messageId, key);
  }
  if (actor?.hasPlayerOwner) {
    return saves.rollSave(actor, use.rule.onUse.challenge, {
      marker: `${MOD}:${messageId}:${key}`, messageId, tokenKey: key, token: tokenDoc, dc: use.dc, use, message
    });
  }
  return callGM("rollSaveFor", messageId, key);
}
