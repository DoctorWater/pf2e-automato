// 0.5g4: правила-носители на ЭФФЕКТАХ (bySource в rules/catalog.pa.json). Эффект, который ставит заклинание или расходник на владельца, держит правило onEvent:
// спасбросок другого участника события (того, кто нападает) против СЛ автора эффекта. Документа предмета у такого правила нет, поэтому pa-port.mjs не выводит его из групп PA.
// События и стороны — scripts/events.mjs: side:"target" — у владельца эффекта (цели броска) срабатывает запись на бросок нападающего.
const MARKUP_DC = { statistic: "will", dc: { expr: "markup" }, basic: false, rollerRole: "target" };
const afraid = (value) => ({ to: "target", condition: { slug: "frightened", value, policy: "max" } });

/** Репеллент от паразитов (Vermin Repellent Agent): членистоногое, нападающее на носителя в ближнем бою, спасает Волю; тиры отличаются СЛ — она берётся из текста расходника-автора. */
const VERMIN = {
  v: 1, label: "Vermin Repellent Agent",
  onEvent: [{ on: "attack-roll", side: "target", when: ["self:trait:arthropod", "item:melee"], challenge: {
    ...MARKUP_DC, immunity: { slug: "vermin-repellent-agent", duration: { value: 1, unit: "minutes" } },
    byDegree: { success: [afraid(1)], failure: [afraid(2)], criticalFailure: [afraid(2), { to: "target", condition: { slug: "fleeing", policy: "max" } }] } } }]
};

/** Маска ужаса: бросок атаки по носителю — Воля нападающего против СЛ заклинания. Состояние «действие пропадает» и иммунитет «до конца следующего хода» схема не выражает (см. отчёт 0.5g4). */
const MASK = {
  v: 1, label: "Mask of Terror",
  onEvent: [{ on: "attack-roll", side: "target", challenge: {
    statistic: "will", dc: { source: "spell" }, basic: false, rollerRole: "target",
    byDegree: { failure: [afraid(2)], criticalFailure: [afraid(2)] } } }]
};

export const CARRIERS = {
  "Compendium.pf2e.equipment-effects.Item.UhV9TLdFjtSOppog": VERMIN,
  "Compendium.pf2e-automato.effects.Item.Pdq3C29GY18nbVg9": MASK
};
