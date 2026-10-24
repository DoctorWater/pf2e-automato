// Недуги со стадиями (шаг `affliction`, plan-affliction.md): pf2e стадий не ведёт (AfflictionPF2e в сборке не создаётся), ведёт модуль.
// Чистая часть: снимок в meta носителя, арифметика стадий, часы, карточка спасброска. Исполнение — affliction-run.mjs.
// Носитель — эффект цели: стадия только в system.badge.value, остальное — meta.affliction. Один носитель на недуг (slug имени) и актёра.
import { sluggify } from "./util.mjs";

export const UNIT_S = { rounds: 6, minutes: 60, hours: 3600, days: 86400 };   // раунд = CONFIG.time.roundTime (pf2e: 6 с)
export const secondsOf = (d) => {
  const s = d?.unit === "rounds" ? globalThis.CONFIG?.time?.roundTime ?? UNIT_S.rounds : UNIT_S[d?.unit];
  return s ? d.value * s : null;
};
/** Состояния, которые pf2e не привязывает к недугу (pf2e.mjs zl): поднимаем по max без снятия при смене стадии, чужое не трогаем. */
export const UNLINKED = new Set(["frightened", "sickened", "drained", "doomed", "stunned", "unconscious"]);

export const slugOfDef = (def) => sluggify(def.name);
export const carrierKey = (slug) => `affl:${slug}`;
/** Ключ документа, созданного стадией: связанное состояние (обёртка) — с `L`, чтобы его снимать при смене стадии отдельно. */
export const stageKey = (slug, n, tail, linked = false) => `affl:${slug}:${n}:${linked ? "L:" : ""}${tail}`;
export const linkedPrefix = (slug, n) => `affl:${slug}:${n}:L:`;

/**
 * Сдвиг стадии по степени спасброска (0 крит. провал … 3 крит. успех, как degreeOfSuccess pf2e).
 * Обычный: крит. успех −2, успех −1, провал +1, крит. провал +2. Virulent: успех снижает стадию лишь после двух успехов подряд, крит. успех — только на 1.
 * Толкование (страница Afflictions сброс счётчика не описывает): любая степень, кроме успеха и крит. успеха, обнуляет streak; крит. успех сам даёт −1 и streak не копит.
 * -> { delta, streak }
 */
export function stageDelta(degree, virulent = false, streak = 0) {
  if (degree === 0) return { delta: 2, streak: 0 };
  if (degree === 1) return { delta: 1, streak: 0 };
  if (!virulent) return { delta: degree === 3 ? -2 : -1, streak: 0 };
  if (degree === 3) return { delta: -1, streak: 0 };
  return streak + 1 >= 2 ? { delta: -1, streak: 0 } : { delta: 0, streak: streak + 1 };
}

/** Новая стадия: ниже первой — недуг снят; выше последней — остаёмся на ней, а при росте её эффекты повторяются (repeated). */
export function advance(stage, delta, def) {
  const n = stage + delta, last = def.stages.length;
  if (n <= 0) return { stage: 0, cleared: true, repeated: false };
  if (n > last) return { stage: last, cleared: false, repeated: delta > 0 };
  return { stage: n, cleared: false, repeated: false };
}

/** Интервал стадии в секундах; у конечной стадии (смерть, «as stage…» без срока) его нет — бросков больше не будет. */
export const intervalOf = (def, stage) => secondsOf(def.stages[stage - 1]?.duration);

/** meta.affliction нового носителя. Onset не стадия 0: стадия записана сразу, но её эффекты ждут onsetEnds. СЛ — числом (источник может пропасть). */
export function startMeta(def, stage, { dc, now, by = null, origin = null, key = null }) {
  const max = secondsOf(def.maxDuration), onset = secondsOf(def.onset), iv = intervalOf(def, stage);
  return {
    slug: slugOfDef(def), def, dc, statistic: def.save.statistic,
    traits: [...new Set([def.kind, ...(def.traits ?? [])])],
    streak: 0, applied: null, pending: null, keys: key ? [key] : [],
    endsAt: max == null ? null : now + max, onsetEnds: onset == null ? null : now + onset,
    nextAt: iv == null ? null : (onset == null ? now : now + onset) + iv,
    by, origin
  };
}

/**
 * Повторное воздействие на носителя. Яд — стадия растёт на delta без смены endsAt и onsetEnds (в onset тоже); болезнь и проклятие — не действуют.
 * -> { skipped: true } | { stage, repeated }
 */
export function reexpose(m, stage, delta) {
  if (m.def.kind !== "poison") return { skipped: true };
  const last = m.def.stages.length, n = Math.min(last, stage + delta);
  return { stage: n, repeated: stage + delta > last };
}

/** Что пора делать с носителем в момент now: "end" — Maximum Duration вышел; "onset" — onset прошёл, эффекты стадии ещё не применялись; "roll" — конец интервала; иначе null. */
export function dueOf(m, now) {
  if (m.endsAt != null && now >= m.endsAt) return "end";
  if (m.applied == null && m.onsetEnds != null && now >= m.onsetEnds) return "onset";
  if (m.nextAt != null && now >= m.nextAt && !(m.onsetEnds != null && now < m.onsetEnds)) return "roll";
  return null;
}

/** Испытание карточки недуга: каждая степень — внутренний шаг stageDelta (сдвиг считает apply по степени и streak носителя). */
export function afflictionChallenge(m) {
  const step = { to: "target", stageDelta: { slug: m.slug } };
  return {
    statistic: m.statistic, dc: { value: m.dc }, basic: false, rollerRole: "target", ...(m.traits?.length && { traits: [...m.traits] }),
    byDegree: { criticalFailure: [step], failure: [step], success: [step], criticalSuccess: [step] }
  };
}

/** Коротко о стадиях для карточки и Мастерской: «1: 1d10 poison, sickened 1 · 2: …». */
export function stagesText(def) {
  return def.stages.map((s, i) => {
    const parts = [...s.damage.map((d) => `${d.formula} ${d.damageType}`), ...(s.persistent ? [`${s.persistent.formula} ${s.persistent.damageType} (persistent)`] : []), ...s.conditions.map((c) => `${c.slug}${c.value ? ` ${c.value}` : ""}`), ...(s.mods ? [`mods ×${s.mods.length}`] : []), ...(s.text ? [s.text] : [])];
    return `${i + 1}: ${parts.join(", ") || "—"}`;
  }).join(" · ");
}
