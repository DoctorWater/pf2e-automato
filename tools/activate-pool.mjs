// Пул модельного прохода по активациям (plan-activate.md §9, шаг 7): долг `cast` (tools/cast-batch.mjs) + долг `mode choice` по снаряжению/оружию.
// Не берём: посохи с зарядами, Briar (once per month), корневые режимы заклинаний/умений.
import { readOut, cmp } from "./lib.mjs";
import { buildBatch } from "./cast-batch.mjs";
import { readModelAccepted } from "./drafts.mjs";

const SKIP_CAST = /charges \(staff\)|once per month/;
const GEAR = new Set(["equipment", "weapon", "armor", "shield"]);

/** -> [{it, batch, kind: "cast"|"mode", why, current}] — по одному на предмет, порядок: вид, уровень, uuid. */
export function activatePool() {
  const { debt, items } = buildBatch(), tri = new Map(readOut("triage.json").items.map((t) => [t.uuid, t]));
  const by = new Map(items.map((i) => [i.uuid, i])), pool = new Map();
  const add = (uuid, kind, why, current) => { if (!pool.has(uuid)) pool.set(uuid, { it: by.get(uuid), batch: tri.get(uuid).batchName, kind, why, current }); };
  for (const d of debt) if (!SKIP_CAST.test(d.reason)) add(d.uuid, "cast", d.reason.replace(/^needs-primitive: missing: cast: /, ""), null);
  for (const d of readModelAccepted()) if (/missing: .*mode choice/.test(d.reason ?? "") && GEAR.has(d.type)) add(d.uuid, "mode", d.reason.replace(/^needs-primitive: /, ""), d.rule);
  return [...pool.values()].sort((a, b) => cmp(a.kind, b.kind) || (a.it.level ?? 0) - (b.it.level ?? 0) || cmp(a.it.uuid, b.it.uuid));
}

/** Пул, записанный haiku-input (tools/out/activate-pool.json): [{uuid, batch, kind, why}] — для validate/sample с пачкой `activate`. */
export const readPool = () => readOut("activate-pool.json");
