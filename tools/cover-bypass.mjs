// Эффекты-проводники «следующий Удар игнорирует/ослабляет укрытие цели» из пака модуля (plan-cover-bypass.md).
// Шаг правила {"to":"self","effect":{"uuid":<форма>}}; uuid есть в паке, но в тексте предмета ссылки на них нет — валидатор их пропускает.
const P = "Compendium.pf2e-automato.effects.Item.";
/** форма текста -> uuid: all — любое; L — меньшее; LS — меньшее и обычное; LSG — LS, большое → обычное; step — на ступень ниже. */
export const COVER_FORMS = { all: P + "pAfCoverAll00001", L: P + "pAfCoverL0000001", LS: P + "pAfCoverLS000001", LSG: P + "pAfCoverLSG00001", step: P + "pAfCoverStep0001" };
export const COVER_FIXES = { E0: P + "pAfCoverFixE0001", E1: P + "pAfCoverFixE1001", E2: P + "pAfCoverFixE2001" };
/** форма -> уровень укрытия -> поправка (нет записи — укрытие остаётся). greater-prone считается как greater. */
export const COVER_TABLE = {
  all: { lesser: "E0", standard: "E0", greater: "E0", "greater-prone": "E0" },
  L: { lesser: "E0" },
  LS: { lesser: "E0", standard: "E0" },
  LSG: { lesser: "E0", standard: "E0", greater: "E2", "greater-prone": "E2" },
  step: { lesser: "E0", standard: "E1", greater: "E2", "greater-prone": "E2" }
};
export const isCoverBypass = (uuid) => Object.values(COVER_FORMS).includes(uuid);
