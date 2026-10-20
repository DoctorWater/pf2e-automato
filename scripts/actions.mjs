// Бросок действия pf2e без карточки предмета (лист, game.pf2e.actions.*, Token Action HUD): check-сообщение с roll options `action:<slug>`
// само становится носителем снимка use (kind "roll"); результат берётся из броска — повторного броска нет. plan.md §1.1a.
import { MOD, DEGREES, degreeFromTotal, flagPath, guardActiveGM } from "./util.mjs";
import { modeOf } from "./settings.mjs";
import * as compat from "./compat.mjs";
import * as rules from "./rules.mjs";
import { useOf, parseMarker, recordResult, safeUuid } from "./saves.mjs";
import { defenseDc } from "./checks.mjs";
import { buildSnapshot } from "./use.mjs";

const ROLL_TYPES = new Set(["skill-check", "perception-check", "attack-roll", "flat-check"]);
const ACTION_OPT = /^action:([a-z0-9-]+)$/;   // `action:cost:1`, `action:escape:variant` не подходят: в них больше одного сегмента
const REROLL_TTL = 60000;

/* ---------- чистые функции ---------- */

/**
 * Разбор check-сообщения pf2e (flags.pf2e.context). null — не бросок действия (не тот тип, нет `action:`, наш маркер).
 * Степень: бросок (`roll.options.degreeOfSuccess`) -> `context.outcome` -> null (нет СЛ).
 */
export function parseActionRoll(message) {
  const ctx = message?.flags?.pf2e?.context;
  if (!ctx || !ROLL_TYPES.has(ctx.type) || parseMarker(ctx.options)) return null;
  // атака заклинанием с карточки (Оплетающая лоза): slug заклинания — для правил с check.roll:"system"
  const spell = ctx.type === "attack-roll" && message.flags.pf2e.origin?.type === "spell"
    ? (message.flags.pf2e.origin.rollOptions ?? []).find((o) => o.startsWith("origin:item:slug:"))?.slice(17) : null;
  const slugs = [...new Set([ctx.action, ...(ctx.options ?? []).map((o) => ACTION_OPT.exec(o)?.[1]), spell].filter(Boolean))];
  if (!slugs.length) return null;
  const roll = message.rolls?.[0];
  const idx = DEGREES.indexOf(ctx.outcome);
  return {
    slugs, type: ctx.type,
    actor: ctx.origin?.actor ?? null, token: ctx.origin?.token ?? null,
    target: ctx.target?.actor || ctx.target?.token ? { actor: ctx.target.actor ?? null, token: ctx.target.token ?? null } : null,
    degree: roll?.degreeOfSuccess ?? (idx >= 0 ? idx : null),
    total: roll?.total ?? null,
    die: roll?.dice?.[0]?.results?.find((r) => r.active && !r.discarded)?.result ?? null,
    dc: Number.isFinite(ctx.dc?.value) ? ctx.dc.value : null,
    isReroll: !!ctx.isReroll,
    by: message.author?.id ?? message.user?.id ?? null
  };
}

/** Первое правило с onUse.check среди slug-ов (каталоги/мировой/без предмета). */
export function ruleFor(slugs, resolve = rules.resolveRule) {
  for (const slug of slugs) {
    const r = resolve({ origin: { slug } });
    if (r?.rule?.onUse?.check) return { ...r, slug };
  }
  return null;
}

/**
 * Workbench («Treat Wounds and Battle Medicine») бросает и Боевую медицину с `action:treat-wounds`. Лечение ранений в бою невозможно
 * (10 минут; Workbench его в бою запрещает) — в бою у владельца черты это Боевая медицина.
 */
export function aliasSlugs(slugs, { inCombat, hasBattleMedicine }) {
  return inCombat && hasBattleMedicine ? slugs.map((s) => (s === "treat-wounds" ? "battle-medicine" : s)) : slugs;
}

const rerollKey = (actor, targetKey, slug) => `${actor}|${targetKey ?? "-"}|${slug}`;
const stash = new Map();   // ponytail: только в памяти активного ГМа; перезагрузка между удалением и новым сообщением переброса (доли секунды) не бывает
const prune = (now) => { for (const [k, v] of stash) if (now - v.at > REROLL_TTL) stash.delete(k); };

/* ---------- ГМ ---------- */

/** pf2e при перебросе удаляет старое сообщение и создаёт новое без наших флагов: снимок откладываем под ключом (актёр, цель, действие). */
export function onDeleteMessage(message) {
  const use = useOf(message);
  if (!guardActiveGM() || use?.kind !== "roll") return;
  const now = Date.now();
  prune(now);
  stash.set(rerollKey(use.actor, use.targets?.[0]?.key, use.slug), { use: foundry.utils.deepClone(use), at: now });
}

async function targetOf(t) {
  if (!t) return null;
  let doc = await safeUuid(t.token);
  if (!doc && t.actor) doc = (await safeUuid(t.actor))?.getActiveTokens?.(false, true)?.[0] ?? null;
  return doc?.actor ? doc : null;
}

/** Макросы (Workbench «Лечение ранений») бросают без цели в контексте: берём единственную цель автора (цели игроков синхронизируются). */
function authorTarget(message) {
  const t = message.author?.targets;
  return t?.size === 1 ? ([...t][0].document ?? null) : null;
}

/**
 * ГМ: сообщение-бросок -> снимок + результат + применение по режимам. null — не наш случай (вызывается после acceptSavingThrow:
 * бросок с карточки предмета/нашего маркера уже принят там и сюда не доходит).
 */
export async function onRollMessage(message) {
  if (!guardActiveGM() || useOf(message) || modeOf("challenge") === "off") return null;
  const p = parseActionRoll(message);
  if (!p) return null;
  const a = message.actor;
  const found = ruleFor(aliasSlugs(p.slugs, { inCombat: !!game.combats?.active?.started, hasBattleMedicine: !!a?.itemTypes?.feat?.some((f) => f.slug === "battle-medicine") }));
  if (!found || compat.shouldYield(found.rule, { slug: found.slug, sourceUuid: null })) return null;
  const actor = p.actor ?? message.actor?.uuid, token = p.token ?? message.token?.uuid ?? null;
  if (!actor) return null;

  const ck = found.rule.onUse.check;
  const tdoc = await targetOf(p.target) ?? authorTarget(message);
  let { degree, dc } = p;
  if (tdoc && degree == null && p.total != null) {   // система не дала исход (нет СЛ в контексте): считаем по защите из правила
    dc ??= defenseDc(tdoc.actor, ck.vs);
    if (dc != null) degree = degreeFromTotal(p.total, dc, p.die);
  }

  const prev = p.isReroll ? stash.get(rerollKey(actor, tdoc?.id, found.slug)) : null;
  stash.delete(rerollKey(actor, tdoc?.id, found.slug));
  const snapshot = prev?.use ?? buildSnapshot({
    kind: "roll", resolved: { rule: found.rule, source: found.source, slug: found.slug, sourceUuid: null, confidence: found.confidence },
    item: message.flags.pf2e.origin?.type === "spell"
      ? { uuid: message.flags.pf2e.origin.uuid ?? null, name: found.rule.label ?? found.slug, type: "spell", sourceId: null }
      : { uuid: null, name: found.rule.label ?? found.slug, type: "action", sourceId: null },
    actor, token, dc, now: Date.now(),
    targets: tdoc ? [{ key: tdoc.id, uuid: tdoc.uuid, name: tdoc.name, pc: !!tdoc.actor?.hasPlayerOwner }] : []
  });
  snapshot.state.done = true;   // дозапуск (resumePending) такому снимку не нужен: бросок уже состоялся
  await message.update({ [flagPath("use")]: snapshot });
  if (!tdoc || degree == null || p.total == null) return { ok: true, noTarget: !tdoc };

  const old = snapshot.state.challenge?.results?.[tdoc.id];
  if (old && old.degree === degree && old.total === p.total) return { ok: true, same: true };   // «оставить прежний» бросок при перебросе
  return recordResult(message.id, tdoc.id, { degree, total: p.total, dc, by: p.by, rollMessageId: message.id, src: "action", isReroll: p.isReroll });
}

export function init() {
  Hooks.on("deleteChatMessage", (message) => { try { onDeleteMessage(message); } catch (e) { console.error(`${MOD} | actions.onDelete`, e); } });
}
