// Отчёт ограждения копий NPC (plan-copy-guard.md §4): какие встроенные копии с правилом каталога теряют его из-за расхождения состояний.
// Тот же resolveRule/guardCopy из scripts/rules.mjs, что в рантайме. Запуск: node tools/copy-guard-report.mjs [--top 40] [--check]
// --check: фикстуры §3 (Shield Mother Venom, Haste, Read Aura, Nimble Dodge, Tongue Grab, Stench не отключены; Evil Eye Kepgeda отключена) — иначе код выхода 1.
import { join } from "node:path";
import { ROOT, readJson, readOut, arg, cmp, isMain } from "./lib.mjs";
import { initCatalog, resolveRule, divergedOf } from "../scripts/rules.mjs";

const KEEP = [["Shield", "Mother Venom"], ["Haste"], ["Read Aura"], ["Nimble Dodge"], ["Tongue Grab"], ["Stench"]];

export function report() {
  const { items } = readOut("items.json"), html = readOut("html.json"), refs = readOut("refs.json");
  const cats = ["catalog.pa", "catalog.model", "catalog.onhit", "catalog", "catalog.campaign"].map((n) => readJson(join(ROOT, "rules", `${n}.json`)));   // порядок loadCatalog
  initCatalog(cats, readJson(join(ROOT, "rules/labels.json")));
  const slugOfUuid = new Map(Object.entries(refs.conditions).map(([s, c]) => [`Compendium.pf2e.conditionitems.Item.${c.id}`, { slug: s }]));
  globalThis.game = { pf2e: { ConditionManager: { conditions: slugOfUuid } } };
  const rows = [], total = { copies: 0, weight: 0, off: 0, offWeight: 0 };
  for (const i of items) {
    if (!i.embedded) continue;
    const doc = { uuid: i.uuid, type: i.type, name: i.name, slug: i.slug, actor: { type: "npc" }, _stats: { compendiumSource: i.source }, flags: {}, system: { description: { value: html[i.uuid] ?? "" }, traits: { value: [] } } };
    const res = resolveRule(doc), div = res?.diverged ?? divergedOf(doc);
    if (res?.source === "catalog" || div) { total.copies++; total.weight += i.dupCount; }
    if (!div) continue;
    total.off++; total.offWeight += i.dupCount;
    rows.push({ name: i.name, actor: i.embedded.actor, n: i.dupCount, kind: div.kind, states: div.states.join(",") });
  }
  rows.sort((a, b) => b.n - a.n || cmp(a.name, b.name));
  return { rows, total };
}

function check(rows) {
  const bad = [];
  for (const [name, actor] of KEEP) for (const r of rows) if (r.name === name && (!actor || r.actor.includes(actor))) bad.push(`отключена ${name} (${r.actor})`);
  if (!rows.some((r) => r.name === "Evil Eye" && r.actor.startsWith("Kepgeda"))) bad.push("Evil Eye (Kepgeda) не отключена");
  return bad;
}

if (isMain(import.meta.url)) {
  const { rows, total } = report();
  console.log(`копий с правилом каталога: ${total.copies} (${total.weight} экз.); отключено: ${total.off} (${total.offWeight} экз.): other ${rows.filter((r) => r.kind === "other").length}, lost ${rows.filter((r) => r.kind === "lost").length}`);
  for (const r of rows.slice(0, +arg("top", 40))) console.log(`${String(r.n).padStart(4)}  ${r.kind.padEnd(5)} ${r.name} (${r.actor}) [${r.states}]`);
  if (process.argv.includes("--check")) {
    const bad = check(rows);
    console.log(bad.length ? `ФИКСТУРЫ: ${bad.join("; ")}` : "фикстуры: ok");
    process.exitCode = bad.length ? 1 : 0;
  }
}
