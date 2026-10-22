// Подсказки распознавания разметки (rules.mjs deriveFromMarkup -> hints.possible/excluded "степень:slug") для показа ГМу. Без Foundry.
import { DEGREES } from "./util.mjs";
import { DURATION_ONLY } from "./rules.mjs";

const TIMED = DURATION_ONLY;   // состояния «на срок без числа» — список в разборе разметки

/** -> { possible:[{deg,slug,label}], excluded:[{deg,slug,label,degLabel}], isEmpty }. degLabel(deg) и condLabel(slug) — локализация вызывающего. */
export function hintsView(hints, { condLabel = (s) => s, degLabel = (d) => d } = {}) {
  const parse = (list) => (list ?? []).map((s) => String(s).split(":")).filter(([d, slug]) => DEGREES.includes(d) && slug)
    .map(([deg, slug]) => ({ deg, slug, label: condLabel(slug), degLabel: degLabel(deg), timed: TIMED.has(slug) }));
  const possible = parse(hints?.possible), excluded = parse(hints?.excluded);
  return { possible, excluded, isEmpty: !possible.length && !excluded.length };
}

/** "Слепота (провал), Спрятан (успех)" */
export const hintList = (items) => items.map((x) => `${x.label} (${x.degLabel})`).join(", ");
