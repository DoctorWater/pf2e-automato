// Повторный спасбросок цели на границе её хода (поле шага `repeat`). Чистая часть: снимок в meta носителя и карточка испытания;
// исполнение — apply.mjs (создание/снятие носителя) и events.mjs (хуки хода). Носитель — свой документ с meta.repeat; чужой не трогаем.
import { REPEAT_END } from "./rules.mjs";

/** Снимок для meta.repeat: statistic/traits/options — у шага, иначе из испытания; dc — числом (источник может пропасть, как turn-conditions.sourceDC). */
export function repeatMeta(rep, challenge, dc) {
  const pick = (k) => rep[k] ?? challenge?.[k];
  return {
    on: rep.on, statistic: pick("statistic"), dc,
    ...(pick("traits")?.length && { traits: [...pick("traits")] }), ...(pick("options")?.length && { options: [...pick("options")] }),
    end: rep.end ?? REPEAT_END
  };
}

/** Испытание карточки повтора: степени из end снимают носитель (внутренний шаг removeKey -> applyOps), остальные степени ничего не делают. */
export function repeatChallenge(r, key) {
  const step = { to: "target", removeKey: key };
  return {
    statistic: r.statistic, dc: { value: r.dc }, basic: false, rollerRole: "target",
    ...(r.traits && { traits: r.traits }), ...(r.options && { options: r.options }),
    byDegree: Object.fromEntries((r.end ?? REPEAT_END).map((d) => [d, [step]]))
  };
}

const tail = (k) => String(k).split(":").slice(-2).join(":");   // tokenKey:stepKey; id сообщения и префиксы двойника (ev:…) отбрасываем

/** Состояние/эффект цели от такого же шага того же автора и предмета (ключ шага без id сообщения совпал) — повторно не вешаем. */
export const sameCarrier = (meta, other) => !!other?.repeat && other.origin === meta.origin && other.by === meta.by
  && tail(other.key) === tail(meta.key);
