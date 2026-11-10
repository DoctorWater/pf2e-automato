// Чистые куски лимитов «перезарядка» и «требования к автору» (без foundry; юнит-тесты — tests/limit-text.test.mjs).
// Читает builtin/impulse-gate.mjs (таблица LIMITS) и tools/use-limits.mjs (разбор требований при сборке оверлея).

/* ---------- M1: перезарядка ---------- */

// Встроенный бросок описания: [[/gmr 1d4 #Recharge Name]]{1d4 rounds}; у pf2ru «#Recharge» сохраняется, срок — «раундов» после броска или в подписи.
// Формы без «again» («once every 1d4 rounds», «can't use X for 1d4 rounds») тоже берутся: якорь — сам бросок, а не оборот.
const ROLL = /\[\[\/(?:gm|b)?r(?:oll)?\s+\{?(\d+d\d+(?:\s*[+-]\s*\d+)?)\}?\s*#[^\]]*?(?:recharge|перезаряд)[^\]]*\]\](\{[^}]*\})?(?=([^]{0,24}))/gi;   // хвост — просмотр вперёд: не съедает следующий бросок
const ROUNDS = /^(?:\s|<[^>]*>)*(?:rounds?|раунд)/i, ROUNDS_IN = /round|раунд/i;

/** Чистая: описание (HTML/markup) -> {dice} | null. Только срок в раундах (минуты, «в начале каждого хода бросает» — null); два разных броска — null. */
export function rechargeOf(text) {
  const found = new Set();
  for (const m of String(text ?? "").matchAll(ROLL)) {
    if (ROUNDS_IN.test(m[2] ?? "") || ROUNDS.test(m[3] ?? "")) found.add(m[1].replace(/\s+/g, ""));
  }
  const [dice] = found;
  return found.size === 1 && parseDice(dice) ? { dice } : null;
}

/** Чистая: "1d4+1" -> {count, faces, mod} | null (не больше 10 кубов, граней до 100). */
export function parseDice(s) {
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(String(s ?? ""));
  if (!m) return null;
  const count = Number(m[1]), faces = Number(m[2]);
  return count >= 1 && count <= 10 && faces >= 2 && faces <= 100 ? { count, faces, mod: Number(m[3] ?? 0) } : null;
}

/** Чистая: бросок по rnd() ∈ [0,1) (CONFIG.Dice.randomUniform: синхронно, v14 синхронного Roll не даёт) -> {n, r, mod}. n — итог, не меньше 1. */
export function rollDice(dice, rnd) {
  const d = parseDice(dice);
  const r = Array.from({ length: d.count }, () => Math.floor(rnd() * d.faces) + 1);
  return { n: Math.max(1, r.reduce((a, b) => a + b, 0) + d.mod), r, mod: d.mod };
}

/** Чистая: данные готового Roll (Roll.fromData) из уже выпавших граней — чтобы показать тот же бросок в чате, не бросая второй раз. */
export function rollData(dice, r, mod) {
  const { faces } = parseDice(dice), total = r.reduce((a, b) => a + b, 0) + mod;
  const terms = [{ class: "Die", options: {}, evaluated: true, number: r.length, faces, modifiers: [], results: r.map((result) => ({ result, active: true })) }];
  if (mod) terms.push({ class: "OperatorTerm", operator: mod > 0 ? "+" : "-", evaluated: true, options: {} }, { class: "NumericTerm", number: Math.abs(mod), evaluated: true, options: {} });
  return { class: "Roll", options: {}, dice: [], formula: dice, terms, total, evaluated: true };
}

/** Чистая: перезарядка ещё идёт (замок rc_* с флага; тот же бой, раунд меньше срока). */
export const rechargeLeft = (lock, combatId, round) => (lock && lock.c === combatId && Number.isFinite(round) && round < lock.until ? lock.until - round : 0);

/** Дыхание: черта breath или slug/имя с breath (у NPC черта есть не везде). */
export const isBreath = (traits, slug) => (traits ?? []).includes("breath") || /breath/i.test(slug ?? "");

// Перезарядка Дыхания критическим Ударом: Draconic Momentum (60 способностей NPC в items.json), Kobold Momentum; текстом — «Shape of the Dragon» и подобные.
// Draconic Frenzy (42, действие эйдолона) и «Scream in Agony» сюда не входят: у первого крит именно в его собственных Ударах, у второго не Дыхание.
const CRIT_RC = /(?:recharges?\b[^.]{0,60}\bbreath\b[^.]{0,80}critical hit|critical hit[^.]{0,80}recharges?\b[^.]{0,60}\bbreath\b|перезаряж[^.]{0,60}дыхани[^.]{0,80}критическ|критическ[^.]{0,80}перезаряж[^.]{0,60}дыхани)/i;
/** Чистая: способность перезаряжает Дыхание при критическом Ударе владельца. */
export const critRecharges = (slug, text) => /^(?:draconic|kobold)-momentum$/.test(slug ?? "") || CRIT_RC.test(String(text ?? "").replace(/<[^>]+>/g, " ").replace(/[ \t\r\n]+/g, " "));

/* ---------- M2: требования к автору ---------- */

/** Чистая: итог Удара по исходу pf2e: true / false / null (цели нет — исхода нет: блок только по явному провалу). */
export const hitOf = (outcome) => (outcome === "success" || outcome === "criticalSuccess" ? true : outcome === "failure" || outcome === "criticalFailure" ? false : null);

/** Чистая: последний штамп действия этого актёра (flags[MOD].act); сообщения — старые первыми. Нет штампа — null. */
export function lastAct(messages, who, mod) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const a = messages[i]?.flags?.[mod]?.act;
    if (a?.who === who) return a;
  }
  return null;
}

// «melee trident Strike» и slug «trident», «claw» и «claw-2»: имя в тексте и slug — по вхождению (ложный блок хуже пропуска)
const sameName = (a, b) => a === b || a.includes(b) || b.includes(a);

/**
 * Чистая: состояние клаузы true / false / null (не знаем — не блокируем). ctx: act (последний штамп или null), turn, handsFree, holds.
 * strike: нет штампа вовсе — null (журнал мог не дойти); штамп прошлого хода или не-Удар — false; промах — false, цели нет — null;
 * fx — список эффектов Удара не пуст и не содержит нужный — false; name — известное имя Удара другое — false.
 */
export function clauseState(cl, c) {
  if (cl.k === "hand") return c.handsFree === undefined || c.handsFree === null ? null : c.handsFree !== 0;   // у NPC нет system.hands — handsFree undefined
  if (cl.k === "holds") return c.holds;
  if (cl.k !== "strike") return null;
  if (!c.turn || !c.act) return null;
  if (c.act.turn !== c.turn || c.act.kind !== "strike") return false;
  if (c.act.hit === false) return false;
  if (cl.fx && c.act.fx?.length && !c.act.fx.includes(cl.fx)) return false;
  if (cl.name && c.act.slug && !sameName(cl.name, c.act.slug)) return false;
  return c.act.hit === true ? true : null;
}

/** Чистая: требование нарушено — все клаузы «любое из» заведомо не выполнены. */
export const reqFails = (req, c) => !!req?.any?.length && req.any.every((cl) => clauseState(cl, c) === false);

/**
 * Чистая: держит ли автор существо. holders — [{uuid, origin}]: у каждого состояния grabbed/restrained у ДРУГОГО актёра — кто его выдал
 * (origin.actor эффекта-источника; null — не известно). Модуль при of:"target" пишет origin = получатель, поэтому «держатель» —
 * автор или сам получатель; исключаем только третьего актёра. Нет таких состояний — false; неизвестный автор — считаем (пропуск, не блок).
 */
export const holdsFrom = (holders, authorUuid) => holders.some((h) => !h.origin || h.origin === authorUuid || h.origin === h.uuid);

/**
 * Чистая: «подпись» строки требований описания, не зависящая от языка: описание начинается с абзаца-заголовка «<strong>Requirements|Trigger|Требования</strong> …»,
 * подпись — id состояний (@UUID[…conditionitems…]) этого абзаца. null — абзаца-требования нет (одноимённая способность другого вида, «When the wolf succeeds at…»).
 * Запись оверлея по slug применяется, только если подпись предмета совпала с подписью документа, с которого её собрали.
 */
export function reqSig(html) {
  const loc = /^\s*(?:<p>\s*)*@Localize\[PF2E\.NPC\.Abilities\.Glossary\.(\w+)\]/.exec(html ?? "");   // глоссарий бестиария: описание — ссылка на строку pf2e, текст канонический
  if (loc) return `loc:${loc[1]}`;
  const m = /^\s*(?:<p>\s*)+<strong>[^<]*<\/strong>([^]*?)(?:<\/p>|$)/i.exec(String(html ?? ""));
  return m ? [...m[1].matchAll(/@UUID\[[^\]]*conditionitems\.Item\.(\w+)\]/g)].map((x) => x[1]).join(",") : null;
}
