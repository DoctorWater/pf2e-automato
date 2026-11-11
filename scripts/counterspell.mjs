// Контрзаклинание (M4, docs/plan-counterspell-tkmaneuver-hplink.md). Пока — чистая таблица исхода; диспетчер реакции — следующий шаг.

/**
 * Исход противодействия по pf2e rollCounteract: степень 0..3 (крит. провал..крит. успех), counterRank — ранг контр-эффекта, targetRank — ранг заклинания.
 * крит. провал — не сорвано; провал — ранг заклинания ниже контр-ранга; успех — не выше контр-ранга +1; крит. успех — не выше +3.
 * -> { counteracted, maxRank } maxRank — наибольший ранг, который этот исход ещё срывает (null — никакого).
 */
export function counteractOutcome({ degree, counterRank, targetRank }) {
  const maxRank = [null, counterRank - 1, counterRank + 1, counterRank + 3][degree] ?? null;
  return { counteracted: maxRank !== null && targetRank <= maxRank, maxRank };
}
