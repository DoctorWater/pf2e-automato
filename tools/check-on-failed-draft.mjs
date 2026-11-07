// Проверка черновика rules/drafts-accepted/b11-on-failed.json (схема onFailed из docs/plan-reroll.md).
// Запуск: node tools/check-on-failed-draft.mjs   Выход 1 при ошибках.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPredicate } from "../scripts/predicate.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const load = (p) => JSON.parse(readFileSync(root + p, "utf8"));

const trigOf = (i) => /Trigger\b([^\n]*?)(?:---|\n|$)/i.exec(i.descEn ?? "")?.[1] ?? "";
// Удачу полурослика делает механик, в черновик не входит
export const EXCLUDED = new Set(["Compendium.pf2e.feats-srd.Item.ZbRVqf14RTJJIZXG"]);
export const inGroup = (i) => /\bfail/i.test(trigOf(i)) && /reroll/i.test(i.descEn ?? "") && !EXCLUDED.has(i.uuid);

const WHO = ["self", "ally", "any"], CHECK = ["save", "skill", "perception", "attack"], DEGREE = ["fail", "critFail", "failNotCrit"], KEEP = ["new", "higher"], NOTIFY = ["owner", "gm"];

// TODO: заменить на knownOption из scripts/builtin/failed.mjs, когда механик его экспортирует. Пока словарь — по docs/plan-reroll.md.
// item:trait / origin:trait — только настоящие черты pf2e: enchantment (школа), control, petrification чертами не являются.
const NOT_TRAITS = new Set(["enchantment", "control", "petrification"]);
const OPTION_VOCAB = [
  /^check:statistic:[a-z-]+$/, /^check:type:(saving-throw|skill|perception|attack-roll)$/,
  /^(item|origin):trait:([a-z-]+)$/, /^action:[a-z-]+$/, /^damaging-effect$/,
];
export const knownOption = (t) => OPTION_VOCAB.some((re) => re.test(t)) && !NOT_TRAITS.has(/:trait:(.+)$/.exec(t)?.[1]);

export function tokensOf(pred) {
  const out = [];
  const walk = (x) => { if (typeof x === "string") out.push(x); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
  walk(pred);
  return out;
}

/** Список ошибок ветки onFailed. */
export function checkOnFailed(o) {
  const e = [];
  if (!o || typeof o !== "object") return ["onFailed не объект"];
  if (!WHO.includes(o.who)) e.push(`who: ${o.who}`);
  if (o.who !== "self" && !(Number.isFinite(o.range) && o.range > 0)) e.push(`${o.who} без range`);
  if (typeof o.withSelf !== "boolean") e.push("withSelf не boolean");
  if (!Array.isArray(o.check) || !o.check.length || o.check.some((c) => !CHECK.includes(c)) || new Set(o.check).size !== o.check.length) e.push(`check: ${JSON.stringify(o.check)}`);
  if (!DEGREE.includes(o.degree)) e.push(`degree: ${o.degree}`);
  if (!KEEP.includes(o.keep)) e.push(`keep: ${o.keep}`);
  if (o.when != null && !isPredicate(o.when)) e.push("when не предикат");
  if (o.requires != null && typeof o.requires !== "string") e.push("requires не строка");
  const ops = new Set(["or", "and", "not", "nor", "nand", "xor", "iff"]);
  for (const t of tokensOf(o.when)) if (!ops.has(t) && !knownOption(t)) e.push(`when: неизвестная опция «${t}»`);
  if (!Array.isArray(o.notify) || !o.notify.length || o.notify.some((n) => !NOTIFY.includes(n))) e.push("notify");
  return e;
}

export function checkDraft() {
  const items = load("tools/out/items.json").items;
  const effects = load("tools/out/refs.json").effects;
  const rows = load("rules/drafts-accepted/b11-on-failed.json").items;
  const err = [];
  const seen = new Map();
  for (const r of rows) seen.set(r.uuid, (seen.get(r.uuid) ?? 0) + 1);
  const group = items.filter(inGroup);
  for (const i of group) if (seen.get(i.uuid) !== 1) err.push(`${i.slug} ${i.uuid}: строк ${seen.get(i.uuid) ?? 0}`);
  const byUuid = new Map(group.map((i) => [i.uuid, i]));
  for (const r of rows) {
    const src = byUuid.get(r.uuid);
    if (!src) { err.push(`${r.slug}: не из группы (или Удача полурослика)`); continue; }
    if (r.nameRu !== (src.nameRu ?? null)) err.push(`${r.slug}: nameRu не совпадает с items.json`);
    if (!["manual", "skip"].includes(r.status)) err.push(`${r.slug}: status ${r.status}`);
    if (r.status === "skip") { if (r.rule !== null || !r.reason) err.push(`${r.slug}: skip без причины или с правилом`); continue; }
    if (!r.rule) { err.push(`${r.slug}: нет rule`); continue; }
    for (const m of checkOnFailed(r.rule.onFailed)) err.push(`${r.slug}: ${m}`);
    if (r.rule.onAttacked || r.rule.onDamaged) err.push(`${r.slug}: onFailed несовместим с onAttacked/onDamaged`);
    for (const a of r.rule.onUse?.apply ?? []) {
      const u = a.effect?.uuid;
      if (u && !Object.hasOwn(effects, u)) err.push(`${r.slug}: эффект ${u} не найден в tools/out/refs.json`);
      // эффект должен быть из @UUID[...] описания предмета
      if (u && !(src.descEn ?? "").includes(u)) err.push(`${r.slug}: эффект ${u} не упомянут в описании`);
    }
  }
  return { err, total: rows.length, rules: rows.filter((r) => r.rule).length, skip: rows.filter((r) => r.status === "skip").length, group: group.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { err, ...n } = checkDraft();
  console.log(JSON.stringify(n), err.length ? "\n" + err.join("\n") : "OK");
  process.exit(err.length ? 1 : 0);
}
