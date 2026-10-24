// Отчёт ограждения копий NPC (plan-copy-guard.md §4): какие встроенные копии с правилом каталога теряют его из-за расхождения состояний.
// Тот же resolveRule/guardCopy из scripts/rules.mjs, что в рантайме. Запуск: node tools/copy-guard-report.mjs [--top 40] [--check]
// --check: фикстуры §3 (Shield Mother Venom, Haste, Read Aura, Nimble Dodge, Tongue Grab, Stench, все Grab не отключены; Evil Eye Kepgeda отключена) — иначе код выхода 1.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT, readJson, readOut, outPath, arg, cmp, isMain } from "./lib.mjs";
import { initCatalog, resolveRule, divergedOf, guardVerdict } from "../scripts/rules.mjs";

const KEEP = [["Shield", "Mother Venom"], ["Haste"], ["Read Aura"], ["Nimble Dodge"], ["Tongue Grab"], ["Stench"], ["Grab"]];

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
  // §4.1 плана: правило несёт состояние, которого нет в тексте самого источника — баг каталога (копию с тем же текстом отключило бы)
  const bySource = new Map(cats.flatMap((c) => Object.entries(c.bySource ?? {})));
  const catalogBugs = items.filter((i) => !i.embedded && bySource.has(i.uuid)).flatMap((i) => {
    const v = guardVerdict(bySource.get(i.uuid), html[i.uuid] ?? "", (u) => slugOfUuid.get(u)?.slug ?? null);
    return v && html[i.uuid] && !/@Localize/.test(html[i.uuid]) ? [{ name: i.name, uuid: i.uuid, states: v.states.join(",") }] : [];
  });
  return { rows, total, catalogBugs };
}

function check(rows) {
  const bad = [];
  for (const [name, actor] of KEEP) for (const r of rows) if (r.name === name && (!actor || r.actor.includes(actor))) bad.push(`отключена ${name} (${r.actor})`);
  if (!rows.some((r) => r.name === "Evil Eye" && r.actor.startsWith("Kepgeda"))) bad.push("Evil Eye (Kepgeda) не отключена");
  return bad;
}

if (isMain(import.meta.url)) {
  if (!existsSync(outPath("items.json"))) { console.log("copy-guard-report: нет tools/out/items.json (запустите tools/extract.mjs) — пропуск"); process.exit(0); }
  const { rows, total, catalogBugs } = report();
  console.log(`копий с правилом каталога: ${total.copies} (${total.weight} экз.); отключено: ${total.off} (${total.offWeight} экз.): other ${rows.filter((r) => r.kind === "other").length}, lost ${rows.filter((r) => r.kind === "lost").length}`);
  for (const r of rows.slice(0, +arg("top", 40))) console.log(`${String(r.n).padStart(4)}  ${r.kind.padEnd(5)} ${r.name} (${r.actor}) [${r.states}]`);
  console.log(`правил каталога, чьё состояние не названо в тексте источника (баг каталога): ${catalogBugs.length}`);
  for (const b of catalogBugs.slice(0, +arg("top", 40))) console.log(`      ${b.name} [${b.states}] ${b.uuid}`);
  if (process.argv.includes("--check")) {
    const bad = check(rows);
    console.log(bad.length ? `ФИКСТУРЫ: ${bad.join("; ")}` : "фикстуры: ok");
    process.exitCode = bad.length ? 1 : 0;
  }
}
