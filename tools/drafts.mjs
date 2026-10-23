// triage.json -> rules/drafts/<batch>.json. Контракт: { meta:{batch,generatedAt,pf2eVersion,seed?}, items:[{uuid,slug,type,name,nameRu,layer,status,confidence,reason,rule|null}] }
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTED, DRAFTS, readJson, readOut, writeText, serializeDrafts, cmp, isMain } from "./lib.mjs";
import { roundTrip } from "./validate.mjs";

const DRAFT_STATUSES = new Set(["markup-high", "markup-low", "manual"]);

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
  console.log("drafts:", Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])));
}

if (isMain(import.meta.url)) main();
