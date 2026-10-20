// K4: блок автоматизации в сообщении чата. Контракт — plan.md §2 chat.mjs, §1.4, §3.G, §5.
import { MOD, L, DEGREES, callGM } from "./util.mjs";
import { modeOf, S } from "./settings.mjs";
import { automationsGroups, toolbeltTargetHelper } from "./compat.mjs";
import * as saves from "./saves.mjs";
import * as checks from "./checks.mjs";

const TEMPLATE = "modules/pf2e-automato/templates/chat-block.hbs";
let template = null;

export function init() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    renderBlock(message, html).catch((e) => console.error(`${MOD} | chat render`, e));
  });
}

export async function ready() {
  template = await foundry.applications.handlebars.getTemplate(TEMPLATE);
}

/* ---------- окружение (подменяется в тестах) ---------- */

const tokenDocOf = (key, use) => {
  const t = use.targets?.find((x) => x.key === key);
  if (t?.uuid) return fromUuidSync(t.uuid);
  const sceneId = use.state?.area?.regionUuid?.match(/^Scene\.([^.]+)/)?.[1];
  return game.scenes.get(sceneId)?.tokens.get(key) ?? null;
};
const nameOfUuid = (uuid) => { try { return fromUuidSync(uuid)?.name; } catch { return null; } };

const defaultEnv = () => ({
  t: L,
  mode: modeOf,
  now: Date.now(),
  resumeMinutes: S.get("resumeMinutes"),
  groups: automationsGroups,
  toolbelt: (() => { const th = toolbeltTargetHelper(); return th.enabled && th.checks && S.get("useToolbeltTargetHelper"); })(),
  tokenName: (key, use) => tokenDocOf(key, use)?.name ?? key,
  isOwner: (key, use, user) => !!tokenDocOf(key, use)?.actor?.testUserPermission(user, "OWNER"),
  isActorOwner: (uuid, user) => !!fromUuidSync(uuid)?.testUserPermission?.(user, "OWNER"),
  statLabel: (s) => {
    const k = CONFIG.PF2E?.saves?.[s] ?? CONFIG.PF2E?.skills?.[s]?.label ?? CONFIG.PF2E?.skills?.[s] ?? CONFIG.PF2E?.attributes?.[s];
    return k ? game.i18n.localize(k) : s;
  },
  conditionLabel: (slug) => {
    const k = CONFIG.PF2E?.conditionTypes?.[slug];
    return k ? game.i18n.localize(k) : slug;
  },
  uuidName: nameOfUuid,
  checkDc: (key, use) => checks.defenseDc(tokenDocOf(key, use)?.actor, use.rule.onUse.check.vs),
  immune: (key, use) => checks.hasImmunity(tokenDocOf(key, use)?.actor, use.rule.onUse.check.immunity, use.actor)
});

/* ---------- чистые части ---------- */

const mult = saves.damageMultiplier;
const isEmpty = (o) => !o || !Object.keys(o).length;
const authorId = (m) => m.author?.id ?? m.author ?? m.user?.id;

function stepText(a, env, defTo) {
  const t = env.t;
  if (a.note) return a.note;
  const what = a.condition
    ? `${env.conditionLabel(a.condition.slug)}${a.condition.value ? ` ${a.condition.value}` : ""}`
    : (env.uuidName(a.effect?.uuid) ?? a.effect?.uuid ?? "?");
  return (a.to ?? defTo) === "self" ? t("chat.stepSelf", { what }) : t("chat.stepTarget", { what });
}

function zoneWhat(zone, env) {
  const c = zone?.condition;
  return c ? `${env.conditionLabel(c.slug)}${c.value ? ` ${c.value}` : ""}` : (env.uuidName(zone?.effect?.uuid) ?? "");
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

const vsLabel = (vs, env) => vs.dc != null ? env.t("chat.dc", { dc: vs.dc })
  : vs.defense === "ac" ? env.t("checks.ac") : env.statLabel(vs.defense ?? vs.against);

/** Чистая: (сообщение, пользователь[, env]) -> модель блока | null. env подменяет доступ к Foundry (тесты). */
export function buildViewModel(message, user, env = null) {
  const use = message?.flags?.[MOD]?.use;
  if (!use?.rule) return null;
  env ??= defaultEnv();
  const t = env.t, rule = use.rule, on = rule.onUse ?? {}, state = use.state ?? {};
  const isGM = !!user.isGM;
  const canAct = isGM || authorId(message) === user.id;
  const vm = {
    messageId: message.id, title: rule.label || use.item?.name || t("chat.title"), isGM,
    yielded: null, warnings: [], waiting: null, awaitingRegion: null, zone: null, challenge: null,
    useApply: null, derived: [], macroErrors: [], empty: false
  };

  if (state.yielded) {
    vm.yielded = t("chat.yielded");
    return vm;
  }

  if (isGM && rule.yield === false) {
    for (const name of env.groups({ slug: use.slug, sourceUuid: use.sourceUuid })) vm.warnings.push(t("chat.yieldWarn", { name }));
  }

  const isUse = use.kind === "use", isRoll = use.kind === "roll";   // roll — бросок действия из листа: результат уже есть
  const hasState = ["zone", "area", "challenge", "apply", "derived", "macros"].some((k) => !isEmpty(state[k]));
  // awaitingRegion — до проверки done: runUse ставит done и у расходника, ждущего область
  if (isUse && !hasState && state.awaitingRegion) vm.awaitingRegion = t("chat.awaitingRegion");
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
      canClose: canAct && st === "active"
    };
  }

  // испытание
  const ck = on.check, ch = on.challenge ?? ck;   // check: бросает автор (checks.mjs), результаты и применение — общие
  if (ch) {
    const modeApply = env.mode("apply"), modeChallenge = env.mode("challenge");
    const keys = [...new Set([
      ...(state.area?.keys ?? (on.targets === "area" ? [] : (use.targets ?? []).map((x) => x.key))),
      ...Object.keys(state.challenge?.results ?? {})
    ])];
    const rows = keys.map((key) => {
      const r = state.challenge?.results?.[key];
      const ap = state.challenge?.applied?.[key];
      const steps = r ? (ch.byDegree?.[DEGREES[r.degree]] ?? []) : [];
      const m = r ? mult(r.degree, ch.basic) : null;
      const immune = !!ck && !ap && !!ck.immunity && env.immune(key, use);
      const dcN = ck ? (r?.dc ?? env.checkDc(key, use)) : null;
      const plan = steps.map((a) => stepText(a, env, "target"));
      if (ck?.immunity && r) plan.push(t("checks.immunityPlan", { name: ck.immunity.label ?? ck.immunity.slug }));
      return {
        key,
        name: use.targets?.find((x) => x.key === key)?.name ?? env.tokenName(key, use),
        dc: dcN != null ? t("chat.dc", { dc: dcN }) : null,
        result: r ? t("chat.result", { degree: t(`chat.degree.${DEGREES[r.degree]}`), total: r.total }) + (immune ? ` — ${t("checks.immuneSkipped")}` : "")
          : immune ? t("checks.immune") : t("chat.noResult"),
        degree: r ? DEGREES[r.degree] : "none",
        multiplier: m == null ? null : t("chat.multiplier", { value: m === 0.5 ? "½" : m }),
        changed: r?.changedAfterApply ? t("chat.changed") : null,
        applied: ap ? t("chat.applied", { degree: t(`chat.degree.${DEGREES[ap.degree]}`) }) : null,
        plan,
        canRoll: !r && !immune && modeChallenge !== "off" && ck?.roll !== "system" && (ck ? (isGM || env.isActorOwner(use.actor, user)) : !env.toolbelt && (isGM || env.isOwner(key, use, user))),
        canApply: isGM && !!r && !ap && !immune && (steps.some((a) => a.condition || a.effect) || !!ck?.immunity) && modeApply !== "off",
        canUndo: isGM && !!ap
      };
    });
    const dcKnown = ck ? null : use.dc ?? ch.dc?.value ?? null;
    vm.challenge = {
      stat: ck ? t("checks.head", { stat: [ck.statistic].flat().map(env.statLabel).join(" / "), vs: vsLabel(ck.vs, env) })
        : t("chat.challenge", { stat: env.statLabel(ch.statistic) }),
      basic: ch.basic ? t("chat.basic") : null,
      dc: dcKnown != null ? t("chat.dc", { dc: dcKnown }) : null,
      dcUnknown: !ck && dcKnown == null ? t("chat.dcUnknown") : null,
      canSetDC: !ck && isGM && dcKnown == null && isEmpty(state.challenge?.results),
      toolbelt: ck ? (rows.length || !(isUse || isRoll) ? null : t(isRoll ? "checks.noTargetRoll" : "checks.noTargets")) : env.toolbelt ? t("chat.challengeOff") : null,
      rows,
      canApplyAll: rows.some((r) => r.canApply),
      canUndoAll: rows.some((r) => r.canUndo)
    };
    if (!rows.length && !isUse && !isRoll) vm.challenge = null;
  }

  // onUse.apply (режим effect=button), только high
  if (on.apply?.length && use.confidence !== "low" && isUse) {
    const done = !isEmpty(state.apply);
    vm.useApply = {
      plan: on.apply.map((a) => stepText(a, env, "self")),
      done: done ? t("chat.applyDone") : null,
      noTargets: !done && on.targets === "selected" && on.apply.some((a) => a.to === "target") && !(use.targets?.length) ? t("checks.noTargets") : null,
      canApply: canAct && !done && env.mode("effect") === "button"
    };
  }

  // распознанные шаги (low): режим вида off скрывает кнопку
  const applied = state.derived?.applied ?? [];
  for (const key of state.derived?.pending ?? []) {
    if (applied.includes(key)) continue;
    if (env.mode(key === "zone" ? "zone" : /^c\d/.test(key) ? "apply" : "effect") === "off") continue;
    const text = describeStep(rule, key, env);
    vm.derived.push({ key, text, title: t("chat.applyDerivedTitle", { text }), canApply: canAct });
  }

  if (isGM) vm.macroErrors = (state.macros?.errors ?? []).map((e) => `${e.key}: ${e.msg}`);

  vm.empty = !(vm.warnings.length || vm.waiting || vm.awaitingRegion || vm.zone || vm.challenge || vm.useApply || vm.derived.length || vm.macroErrors.length);
  return vm;
}

/** Подсказка реакции (шёпот K5, §3.D'): flags[MOD].reaction = {attack, actor, item, before, after, used}. */
export function buildReactionViewModel(message, user, env = null) {
  const r = message?.flags?.[MOD]?.reaction;
  if (!r) return null;
  env ??= defaultEnv();
  const t = env.t;
  return {
    text: t("chat.reaction.hint", {
      item: env.uuidName(r.item) ?? r.item ?? "",
      before: t(`chat.degree.${DEGREES[r.before]}`), after: t(`chat.degree.${DEGREES[r.after]}`)
    }),
    used: r.used ? t("chat.reaction.used") : null,
    canUse: !r.used && (!!user.isGM || (!!r.actor && env.isActorOwner(r.actor, user)))
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
  block.addEventListener("click", (ev) => onClick(ev, message.id));   // новый элемент на каждый рендер -> слушатели не копятся
  root.append(block);
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
        window: { title: L("chat.setDCTitle") },
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
