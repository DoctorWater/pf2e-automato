// Проверка черновика rules/drafts-accepted/b10-on-damaged.json (схема onDamaged из docs/plan-on-damaged.md).
// Запуск: node tools/check-on-damaged-draft.mjs   Выход 1 при ошибках.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPredicate } from "../scripts/predicate.mjs";
import { resolveFormula } from "../scripts/rules.mjs";
import { knownOption, knownRequire, tokensOf } from "../scripts/builtin/damaged.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const load = (p) => JSON.parse(readFileSync(root + p, "utf8"));
let stanceSlugs = null;
/** slug'и стоек: заклинания и черты с чертой stance (tools/out/items.json). */
const stances = () => (stanceSlugs ??= new Set(load("tools/out/items.json").items.filter((i) => (i.traits ?? []).includes("stance")).map((i) => i.slug)));

const trigOf = (i) => /Trigger\b([^\n]*?)(?:---|\n|$)/i.exec(i.descEn ?? "")?.[1] ?? "";
// Phase Familiar делает механик, в черновик не входит; Martyr's Intervention — «сводит к 0 ОЗ», но реакция на урон
const EXTRA = new Set(["Compendium.pf2e.spells-srd.Item.M9TiCE1vlG1j2faM"]);
export const inGroup = (i) => EXTRA.has(i.uuid)
  || (/would take[^.]*damage/i.test(trigOf(i)) && !/(to|reduces? [\w ]*to) (0|zero)|0 Hit Points|dying|unconscious|killed/i.test(trigOf(i)));
export const EXCLUDED_SLUGS = new Set(["phase-familiar"]);

const WHO = ["self", "familiar", "ally"], NOTIFY = ["owner", "gm"];

/** Список ошибок ветки onDamaged. */
export function checkOnDamaged(o) {
  const e = [];
  if (!o || typeof o !== "object") return ["onDamaged не объект"];
  if (!WHO.includes(o.who)) e.push(`who: ${o.who}`);
  if (o.who === "ally" && !(Number.isFinite(o.range) && o.range > 0)) e.push("ally без range");
  if (typeof o.withSelf !== "boolean") e.push("withSelf не boolean");
  if (o.when != null && !isPredicate(o.when)) e.push("when не предикат");
  if (o.requires != null && typeof o.requires !== "string") e.push("requires не строка");
  // ни одно when/requires не должно быть мёртвым: токены — из словаря опций, которые damageOptions/pf2e реально выдают
  for (const t of tokensOf(o.when)) if (t !== "or" && t !== "and" && t !== "not" && !knownOption(t)) e.push(`when: неизвестная опция «${t}»`);
  if (typeof o.requires === "string" && o.requires.includes(":") && !knownRequire(o.requires, stances())) e.push(`requires: неизвестная опция «${o.requires}»`);
  const d = o.damage;
  if (d != null) {
    const k = Object.keys(d);
    if (k.length === 1 && k[0] === "reduce") { if (resolveFormula(d.reduce) == null) e.push(`reduce не считается: ${d.reduce}`); }
    else if (k.length === 1 && k[0] === "halve") { if (d.halve !== true) e.push("halve != true"); }
    else if (k.length === 1 && k[0] === "resist") {
      if (!Array.isArray(d.resist) || !d.resist.length || d.resist.some((x) => !/^[a-z-]+$/.test(String(x?.type)) || resolveFormula(x?.value) == null)) e.push(`resist: ${JSON.stringify(d.resist)}`);
    }
    else if (k.length === 2 && d.redirect === "self" && ["all", "half"].includes(d.part)) { /* ok */ }
    else e.push(`damage: ${JSON.stringify(d)}`);
  }
  if (typeof o.triggerOnly !== "boolean") e.push("triggerOnly не boolean");
  if (o.cost != null && !(typeof o.cost.hp === "string" && resolveFormula(o.cost.hp) != null)) e.push("cost.hp");
  if (!Array.isArray(o.notify) || !o.notify.length || o.notify.some((n) => !NOTIFY.includes(n))) e.push("notify");
  return e;
}

export function checkDraft() {
  const items = load("tools/out/items.json").items;
  const effects = load("tools/out/refs.json").effects;
  const rows = load("rules/drafts-accepted/b10-on-damaged.json").items;
  const err = [];
  const seen = new Map();
  for (const r of rows) seen.set(r.uuid, (seen.get(r.uuid) ?? 0) + 1);
  const group = items.filter((i) => inGroup(i) && !EXCLUDED_SLUGS.has(i.slug));
  for (const i of group) if (seen.get(i.uuid) !== 1) err.push(`${i.slug} ${i.uuid}: строк ${seen.get(i.uuid) ?? 0}`);
  const gset = new Set(group.map((i) => i.uuid));
  for (const r of rows) {
    if (!gset.has(r.uuid)) err.push(`${r.slug}: не из группы (или Phase Familiar)`);
    if (!["manual", "skip"].includes(r.status)) err.push(`${r.slug}: status ${r.status}`);
    if (r.status === "skip") { if (r.rule !== null || !r.reason) err.push(`${r.slug}: skip без причины или с правилом`); continue; }
    if (!r.rule) { err.push(`${r.slug}: нет rule`); continue; }
    for (const m of checkOnDamaged(r.rule.onDamaged)) err.push(`${r.slug}: ${m}`);
    if (r.rule.onAttacked) err.push(`${r.slug}: onDamaged несовместим с onAttacked`);
    for (const a of r.rule.onUse?.apply ?? []) {
      const u = a.effect?.uuid;
      if (u && !Object.hasOwn(effects, u)) err.push(`${r.slug}: эффект ${u} не найден в tools/out/refs.json`);
    }
  }
  return { err, total: rows.length, rules: rows.filter((r) => r.rule).length, skip: rows.filter((r) => r.status === "skip").length, group: group.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { err, ...n } = checkDraft();
  console.log(JSON.stringify(n), err.length ? "\n" + err.join("\n") : "OK");
  process.exit(err.length ? 1 : 0);
}
