export const MOD = "pf2e-automato";
export const L = (key, data) => data ? game.i18n.format(`PF2E_AUTOMATO.${key}`, data) : game.i18n.localize(`PF2E_AUTOMATO.${key}`);
export const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];   // индекс = pf2e degreeOfSuccess 0..3

// Как pf2e sluggify (pf2e.mjs:209-213, camel=null, юникодные классы — кириллица сохраняется); своя копия — чтобы чистые модули работали под node.
const WORD = String.raw`[\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Join_Control}]`;
const NON_WORD = new RegExp(String.raw`[^\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Join_Control}]`, "gu");
const CAMEL = new RegExp(String.raw`(\p{Lowercase_Letter})(\p{Uppercase_Letter}(?=^|$|${WORD}))`, "gu");
export const sluggify = (s) => {
  s = String(s ?? "");
  const f = globalThis.game?.pf2e?.system?.sluggify;
  if (f) return f(s);
  if (s === "-") return s;
  return s.replace(CAMEL, "$1-$2").toLowerCase().replace(/['’]/g, "").replace(NON_WORD, " ").trim().replace(/[-\s]+/g, "-");
};
export const isActiveGM = () => game.user.isActiveGM;
export const flagPath = (...p) => ["flags", MOD, ...p].join(".");
export const tokenKey = (tokenDoc) => tokenDoc.id;

export function debug(...a) {
  try { if (game.settings.get(MOD, "debug")) console.log(`${MOD} |`, ...a); } catch { /* настройки ещё не зарегистрированы */ }
}

/** Степень 0..3 по итогу и СЛ; die = натуральный d20 (или null). Логика DegreeOfSuccess pf2e (pf2e.mjs:340-379). */
export function degreeFromTotal(total, dc, die = null) {
  let d = total - dc >= 10 ? 3 : dc - total >= 10 ? 0 : total >= dc ? 2 : 1;
  if (die === 20) d += 1; else if (die === 1) d -= 1;
  return Math.min(3, Math.max(0, d));
}

// Сокет живёт здесь (нет цикла main <-> модули).
export let socket = null;
export function setSocket(s) { socket = s; }

/** Все мутации — только активному ГМу (не executeAsGM: он исполнил бы на любом ГМе). */
export async function callGM(name, ...args) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const gm = game.users.activeGM;
    if (!gm) {
      ui.notifications.warn(L("noGM"));
      return { ok: false, reason: "no-gm" };
    }
    let res;
    try { res = await socket.executeAsUser(name, gm.id, ...args); }
    catch (e) { console.error(`${MOD} | callGM ${name}`, e); return { ok: false, reason: "error", error: String(e?.message ?? e) }; }
    if (res?.reason === "not-active-gm" && attempt === 0) continue;   // активный ГМ сменился — один повтор
    return res;
  }
  return { ok: false, reason: "not-active-gm" };
}

/** Для обработчиков сокета: false — этот клиент не активный ГМ, вернуть { ok:false, reason:"not-active-gm" }. */
export const guardActiveGM = () => !!game.user?.isActiveGM;

// Сериализатор на ОДНОМ клиенте: следующая задача по ключу стартует после завершения предыдущей (в т.ч. упавшей).
// НЕ реентерабелен: queue(k, () => ... queue(k, ...)) повиснет — не вкладывать один ключ в себя.
const tails = new Map();
export function queue(key, fn) {
  const run = (tails.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

/* ---------- K7 ---------- */

/** Удаление ключа в update(): ForcedDeletion (v14), иначе устаревшее `-=`. path — точечный. */
export function forcedDelete(path) {
  const Op = globalThis.foundry?.data?.operators?.ForcedDeletion;
  if (Op) return { [path]: new Op() };
  const i = path.lastIndexOf(".");
  return { [`${path.slice(0, i)}.-=${path.slice(i + 1)}`]: null };
}

/** Замена значения целиком в update(): ForcedReplacement (v14), иначе устаревшее `==`. */
export function forcedReplace(path, value) {
  const Op = globalThis.foundry?.data?.operators?.ForcedReplacement;
  if (Op) return { [path]: Op.create(value) };
  const i = path.lastIndexOf(".");
  return { [`${path.slice(0, i)}.==${path.slice(i + 1)}`]: value };
}

/**
 * Права отправителя сокета (K7 п.1). need: "gm" | "author" (ГМ или автор сообщения) | "owner" (ГМ или владелец).
 * ctx: { authorId?, owns? } — authorId автора сообщения, owns — отправитель владеет актёром.
 */
export function allowed(user, need, ctx = {}) {
  if (!user) return false;
  if (user.isGM) return true;
  if (need === "author") return !!ctx.authorId && ctx.authorId === user.id;
  if (need === "owner") return !!ctx.owns;
  return false;
}
