// Словарь механизмов долга (rules/mechanisms.json): причина долга из rules/drafts-accepted -> ключи, счёт по ключам, статус, годность для пула.
import { join } from "node:path";
import { ROOT, readJson } from "./lib.mjs";

/** Порог группы под новый примитив (решение пользователя 2026-10-26, ROADMAP §7). */
export const THRESHOLD = 30;

export const MECHANISMS = readJson(join(ROOT, "rules/mechanisms.json")).mechanisms;
const KEYS = Object.keys(MECHANISMS);
const RE = Object.fromEntries(KEYS.map((k) => [k, (MECHANISMS[k].aliases ?? []).map((a) => new RegExp(a, "i"))]));
const KEY_RE = Object.fromEntries(KEYS.map((k) => [k, new RegExp(`^${k}([:]|$)`, "i")]));
const RULE_RE = Object.fromEntries(KEYS.filter((k) => MECHANISMS[k].rule).map((k) => [k, new RegExp(MECHANISMS[k].rule, "i")]));

export const isDebt = (d) => /^needs-primitive/.test(d.reason ?? "");
export const plainReason = (reason) => reason.replace(/^needs-primitive:\s*/, "").replace(/^missing:\s*/, "");
/** Подсказка из самого предмета: «@тип/вид-действия/черты» — чтобы метку «strike-gate» разнести по настоящему механизму. */
const hint = (it) => (it ? ` @${it.type}/${it.actionType ?? "null"}/${(it.traits ?? []).join(",")}` : "");
const keyOfPart = (part, it) => KEYS.find((k) => k !== "strike-gate" && KEY_RE[k].test(part)) ?? KEYS.find((k) => RE[k].some((re) => re.test(part + hint(it)))) ?? null;

/** Куски причины: делим по ; и , вне скобок. После `new:` остаток — свободный текст модели, дальше не делится. */
export function partsOf(reason) {
  const r = plainReason(reason ?? ""), out = [];
  for (let rest = r; rest.trim();) {
    if (/^\s*new:/i.test(rest)) { out.push(rest.trim()); break; }
    const m = /(?:[;,]|\s\/\s)(?![^(]*\))/.exec(rest);
    out.push((m ? rest.slice(0, m.index) : rest).trim());
    rest = m ? rest.slice(m.index + 1) : "";
  }
  return out.filter(Boolean);
}

/** { keys: уникальные ключи кусков, free: был ли кусок без ключа } */
export function mechanismsOf(reason, item) {
  const keys = new Set();
  let free = false;
  for (const p of partsOf(reason)) { const k = /^new:/i.test(p) ? null : keyOfPart(p, item); if (k) keys.add(k); else free = true; }
  return { keys: [...keys], free };
}

/** Пачка-владелец долга: owner первого (в порядке причины) ключа, у которого он есть, иначе null. */
export const ownerOf = (keys) => keys.map((k) => MECHANISMS[k].owner).find(Boolean) ?? null;

/** Первый ключ или null (для простых вызовов и тестов). */
export const mechanismOf = (reason, item) => mechanismsOf(reason, item).keys[0] ?? null;

/** «к проходу» — примитив есть и промпт его знает; «к промпту» — примитив есть, промпт нет; «к плану» — примитива нет, записей ≥ порога; «ждёт» — меньше. */
export function statusOf(key, n) {
  const m = MECHANISMS[key];
  return m.primitive ? (m.prompt === false ? "к промпту" : "к проходу") : n >= THRESHOLD ? "к плану" : "ждёт";
}

const ready = (k) => statusOf(k, 0) === "к проходу";
/** В пул модельного прохода: у всех ключей записи есть примитив, о котором знает промпт; кусков без ключа нет; ни один ключ не закрывается другим инструментом. */
export const poolable = ({ keys, free }) => keys.length > 0 && !free && keys.every((k) => ready(k) && !MECHANISMS[k].via);

/** Основа причины для группировки «без метки»: без чисел и скобок, первые три слова. */
export const stemOf = (r) => r.toLowerCase().replace(/\([^)]*\)|[\d/+-]+/g, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" ");

/** accepted — записи rules/drafts-accepted, items — документы items.json.
 * -> { rows: [{key, n, blocked, status, primitive, title}], unlabeled: {n, top: [[основа, n, пример]]}, byUuid: Map uuid -> {keys, free} }
 * Запись считается под каждым своим ключом; blocked — под ключом с примитивом, но с другим ключом/куском без примитива. */
export function debtByMechanism(accepted, items) {
  const by = new Map(items.map((i) => [i.uuid, i])), count = {}, blocked = {}, free = {}, byUuid = new Map();
  for (const d of accepted) {
    let m;
    if (isDebt(d)) m = mechanismsOf(d.reason, by.get(d.uuid));
    else if (d.partial?.length && d.rule) m = { keys: Object.keys(RULE_RE).filter((k) => RULE_RE[k].test(JSON.stringify(d.rule))), free: false };
    if (!m || (!m.keys.length && !isDebt(d))) continue;
    byUuid.set(d.uuid, m);
    for (const k of m.keys) { count[k] = (count[k] ?? 0) + 1; if (MECHANISMS[k].primitive && !poolable(m) && !MECHANISMS[k].via && isDebt(d)) blocked[k] = (blocked[k] ?? 0) + 1; }
    if (!m.keys.length) { const r = plainReason(d.reason), s = stemOf(r); (free[s] ??= { n: 0, ex: r }).n++; }
  }
  const rows = KEYS.map((key) => ({ key, n: count[key] ?? 0, blocked: blocked[key] ?? 0, status: statusOf(key, count[key] ?? 0), primitive: MECHANISMS[key].primitive, title: MECHANISMS[key].title }));
  const top = Object.entries(free).sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([s, v]) => [s, v.n, v.ex]);
  return { rows, unlabeled: { n: Object.values(free).reduce((s, v) => s + v.n, 0), top }, byUuid };
}

export function renderDebtMd({ rows, unlabeled }) {
  const line = (r) => `| \`${r.key}\` | ${r.title} | ${r.n} | ${r.status} | ${r.blocked || ""} | ${r.primitive ?? "—"} |`;
  const body = [...rows].sort((a, b) => b.n - a.n).map(line).join("\n");
  return `### Долг по механизмам (порог под новый примитив — ${THRESHOLD} записей)

Словарь — \`rules/mechanisms.json\`; считаются записи \`needs-primitive\` по всем пачкам, запись — под каждым своим ключом (причина делится по \`;\` и \`,\`). «к проходу» — примитив есть, промпт его знает, записи ждут модельного прохода (\`node tools/debt-pool.mjs\`; в пул идёт запись, у которой примитив есть у всех ключей); «к промпту» — примитив в рантайме есть, промпт ему не учит; «к плану» — примитива нет, записей ≥ ${THRESHOLD}; «ждёт» — меньше. «Заблок.» — записи под ключом с примитивом, но с другим ключом или куском без примитива.

| ключ | механизм | записей | статус | заблок. | примитив |
|---|---|---|---|---|---|
${body}

Без метки: ${unlabeled.n} записей; группы причин (основа, записей, пример):

${unlabeled.top.map(([s, n, ex]) => `- ${s}: ${n} (${ex})`).join("\n") || "—"}
`;
}
