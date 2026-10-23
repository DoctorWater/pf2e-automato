// Предикат pf2e (как у pf2e-automations, шаг `when`): чистая проверка структуры и вычислитель без Foundry (node-тесты).
// В игре проверку делает game.pf2e.Predicate.test; здесь та же семантика (pf2e.mjs Predicate#e/#t/#n) — для тестов и валидатора.

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const BINARY = ["eq", "gt", "gte", "lt", "lte"];
const LISTS = ["and", "or", "nor", "nand", "xor", "iff"];
const MAX_DEPTH = 6, MAX_TERMS = 40;

/** Структура предиката: массив (И) утверждений. Утверждение — непустая строка, {gt|gte|lt|lte|eq: [a, b]} (строка|число), {and|or|nor|nand|xor|iff: [...]}, {not: s}, {if: s, then: s}. */
export function isPredicate(p) {
  let n = 0;
  const stmt = (s, depth) => {
    if (++n > MAX_TERMS || depth > MAX_DEPTH) return false;
    if (typeof s === "string") return s.length > 0;
    if (!isObj(s)) return false;
    const keys = Object.keys(s);
    if (keys.length === 2 && "if" in s && "then" in s) return stmt(s.if, depth + 1) && stmt(s.then, depth + 1);
    if (keys.length !== 1) return false;
    const [k, v] = Object.entries(s)[0];
    if (BINARY.includes(k)) return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && v[0].length > 0 && ((typeof v[1] === "string" && v[1].length > 0) || Number.isFinite(v[1]));   // pf2e: первый операнд — строка
    if (LISTS.includes(k)) return Array.isArray(v) && v.length > 0 && v.every((x) => stmt(x, depth + 1));
    return k === "not" && stmt(v, depth + 1);
  };
  return Array.isArray(p) && p.length > 0 && p.every((s) => stmt(s, 0));
}

// значения операнда сравнения: число как есть, иначе числа из опций «operand:N»
function values(x, opts) {
  const n = Number(x);
  if (typeof x === "number" || !Number.isNaN(n)) return [n];
  const found = [...opts].filter((o) => o.startsWith(`${x}:`) && !o.slice(x.length + 1).includes(":")).map((o) => Number(o.slice(x.length + 1))).filter((v) => !Number.isNaN(v));
  return found.length ? found : [NaN];
}
const OPS = { gt: (x, y) => x > y, gte: (x, y) => x >= y, lt: (x, y) => x < y, lte: (x, y) => x <= y };

/** Вычислитель: p — предикат, opts — Set (или массив) roll options. Семантика pf2e. */
export function testPredicate(p, opts) {
  const set = opts instanceof Set ? opts : new Set(opts ?? []);
  const t = (s) => {
    if (typeof s === "string") return set.has(s);
    if ("if" in s) return !(t(s.if) && !t(s.then));
    const [k, v] = Object.entries(s)[0];
    if (k === "eq") return typeof v[1] === "string" ? v[0] === v[1] : set.has(`${v[0]}:${v[1]}`);
    if (k in OPS) { const a = values(v[0], set), b = values(v[1], set); return a.some((x) => b.every((y) => OPS[k](x, y))); }
    if (k === "and") return v.every(t);
    if (k === "or") return v.some(t);
    if (k === "nor") return !v.some(t);
    if (k === "nand") return !v.every(t);
    if (k === "xor") return v.filter(t).length === 1;
    if (k === "not") return !t(v);
    return v.every(t) || v.every((x) => !t(x));   // iff
  };
  return (p ?? []).every(t);
}

/** Строка формы -> предикат: «feat:x, spellcasting:innate» (запятые — И) либо JSON-массив. Не разобралось — исходная строка (валидатор отвергнет). */
export function parseWhen(text) {
  const s = String(text ?? "").trim();
  if (!s) return undefined;
  if (s.startsWith("[") || s.startsWith("{")) { try { return JSON.parse(s); } catch { return s; } }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/** Предикат -> читаемая строка для чата и плашек (язык-нейтральная): «feat:x, !target:trait:undead, (a | b), self:level ≥ 5». */
export function whenHuman(p) {
  const OPS = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" }, JOIN = { and: " & ", or: " | ", nor: " nor ", nand: " nand ", xor: " xor ", iff: " ⇔ " };
  const h = (s) => {
    if (typeof s === "string") return s;
    if ("if" in s) return `${h(s.if)} → ${h(s.then)}`;
    const [k, v] = Object.entries(s)[0];
    if (k in OPS) return `${v[0]} ${OPS[k]} ${v[1]}`;
    if (k === "not") return `!${typeof v === "string" ? v : `(${h(v)})`}`;
    return `(${v.map(h).join(JOIN[k])})`;
  };
  return Array.isArray(p) ? p.map(h).join(", ") : "";
}

/** Предикат -> строка формы: только строки — через запятую, иначе JSON. */
export const whenText = (p) => (!Array.isArray(p) ? "" : p.every((x) => typeof x === "string" && !x.includes(",")) ? p.join(", ") : JSON.stringify(p));
