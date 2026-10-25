// triage.json -> rules/drafts/<batch>.json. Контракт: { meta:{batch,generatedAt,pf2eVersion,seed?}, items:[{uuid,slug,type,name,nameRu,layer,status,confidence,reason,rule|null}] }
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ACCEPTED, DRAFTS, readJson, readOut, writeText, serializeDrafts, cmp, isMain } from "./lib.mjs";
import { roundTrip, activationWarnings } from "./validate.mjs";
import { buildCatalog, bySlugOf } from "../scripts/rules.mjs";

const DRAFT_STATUSES = new Set(["markup-high", "markup-head", "markup-low", "manual"]);

/** Запись триажа + предмет -> элемент черновика (ровно поля контракта). */
export function makeDraft(it, t) {
  let { status, confidence, reason } = t;
  if (t.rule && !roundTrip(t.rule)) { status = "markup-low"; confidence = "low"; reason += "; roundtrip-fail"; }
  return { uuid: it.uuid, slug: it.slug, type: it.type, name: it.name, nameRu: it.nameRu, layer: t.layer, status, confidence, reason, rule: t.rule ?? null };
}

/** Раскладка по пачкам: { batchName: [draft...] }, порядок — приоритет, затем уровень, затем имя (детерминированно). */
export function groupDrafts(items, tri) {
  const triBy = new Map(tri.map((t) => [t.uuid, t]));
  const out = {};
  const sorted = items.filter((i) => DRAFT_STATUSES.has(triBy.get(i.uuid)?.status))
    .sort((a, b) => triBy.get(a.uuid).priority - triBy.get(b.uuid).priority || (a.level ?? 0) - (b.level ?? 0) || cmp(a.uuid, b.uuid));
  for (const it of sorted) { const t = triBy.get(it.uuid); (out[t.batchName] ??= []).push({ ...makeDraft(it, t), _p: t.priority }); }
  return out;
}

/** Принятые ответы моделей (все drafts-accepted, кроме переноса PA — у него свой rules/catalog.pa.json) -> каталог рантайма по uuid. */
export function modelCatalog(acceptedItems) {
  const rows = acceptedItems.filter((d) => d.rule && d.confidence === "model").sort((a, b) => cmp(a.uuid, b.uuid));
  return `{"v":1,\n"bySource":{\n${rows.map((d) => `${JSON.stringify(d.uuid)}:${JSON.stringify(d.rule)}`).join(",\n")}\n}}\n`;
}

/** Элементы всех rules/drafts-accepted/<batch>.json пачек (без pa-port* и _samples). */
export function readModelAccepted() {
  return readdirSync(ACCEPTED).filter((f) => /^b\d+-.*\.json$/.test(f)).flatMap((f) => readJson(join(ACCEPTED, f)).items);
}

/** Предупреждения activationWarnings по принятым записям активации; правило заклинания — как resolveRule: источник, затем slug (порядок каталогов — loadCatalog). Печать без отказа. */
export function printActivationWarnings(items, accepted) {
  const cat = buildCatalog(["catalog.pa", "catalog.model", "catalog.onhit", "catalog", "catalog.campaign"].map((n) => readJson(join(ROOT, "rules", `${n}.json`))));
  const slugOf = new Map(items.map((i) => [i.uuid, i.slug]));
  const spellRule = (u) => cat.bySource.get(u) ?? bySlugOf(cat.bySlug, slugOf.get(u), "spell");
  const out = accepted.filter((d) => d.rule?.activate && d.confidence === "model").flatMap((d) => activationWarnings(d.rule, spellRule).map((w) => `${d.name}: ${w}`));
  for (const w of out) console.warn("activation:", w);
  return out;
}

function main() {
  const { meta, items } = readOut("items.json");
  const tri = readOut("triage.json").items;
  const groups = groupDrafts(items, tri);
  for (const [batch, list] of Object.entries(groups)) {
    // принятые ответы моделей (rules/drafts-accepted, в git) подмешиваются поверх сгенерированного
    const ap = join(ACCEPTED, `${batch}.json`);
    const acc = new Map(existsSync(ap) ? readJson(ap).items.map((d) => [d.uuid, d]) : []);
    const finalItems = list.map(({ _p, ...d }) => acc.get(d.uuid) ?? d);
    writeText(join(DRAFTS, `${batch}.json`), serializeDrafts({ batch, generatedAt: new Date().toISOString(), pf2eVersion: meta.pf2eVersion }, finalItems));
  }
  writeText(join(ROOT, "rules/catalog.model.json"), modelCatalog(readModelAccepted()));
  printActivationWarnings(items, readModelAccepted());
  console.log("drafts:", Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])));
}

if (isMain(import.meta.url)) main();
