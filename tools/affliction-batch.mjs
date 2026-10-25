// Недуги массово: конвертер (tools/affliction.mjs) -> rules/drafts-accepted/<batch>.json. Чистые правила, прошедшие проверки, — как ответ модели (confidence "model");
// частичные, неразобранные и с расхождениями — долг `needs-primitive: missing: affliction: <причина>` без правила (как у пачки 1).
// node tools/affliction-batch.mjs            — отчёт (ничего не пишет); --write — записать принятые и долг; --sample [--seed 20261025] — выборка 50 для Критика
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOut, readJson, writeText, serializeDrafts, stripHtml, ACCEPTED, arg, cmp, isMain } from "./lib.mjs";
import { afflictionStages, validateRule, AFFLICTION_KINDS } from "../scripts/rules.mjs";
import { afflictionRule, outsideText, coatOf } from "./affliction.mjs";
import { roundTrip, semanticErrors, mergeAccepted } from "./validate.mjs";
import { readModelAccepted } from "./drafts.mjs";
import { pick } from "./sample.mjs";

const CONV = "model: affliction converter";
const MARK = /<strong>\s*Stage\s+(\d+)\s*<\/strong>/gi;

/** Проверка собранного недуга против текста документа -> [строки расхождений]. */
export function checkAffliction(rule, html, item, refs) {
  const bad = [];
  const v = validateRule(rule);
  if (!v.ok) return [`validateRule: ${v.errors.map(String).join("; ").slice(0, 100)}`];
  if (!roundTrip(rule)) bad.push("roundTrip");
  for (const e of semanticErrors(rule, refs, html) ?? []) bad.push(`semantic: ${String(e).slice(0, 80)}`);
  const ch = rule.onUse.challenge, def = ch.byDegree.failure[0].affliction.def;
  const marks = [...html.matchAll(MARK)];
  if (def.stages.length !== marks.length) bad.push(`stages ${def.stages.length} != text ${marks.length}`);
  marks.forEach((m, i) => {
    const t = stripHtml(html.slice(m.index + m[0].length, marks[i + 1]?.index ?? html.length).split(/<\/p>|<hr|<br|<\/li>/)[0]), s = def.stages[i];
    if (!s) return;
    if (/@Damage\[|\d+d\d+\s+[a-z]+/i.test(t) && !s.damage.length && !s.persistent) bad.push(`stage ${i + 1}: damage lost`);
    if (/@UUID\[Compendium\.pf2e\.conditionitems/.test(t) && !s.conditions.length) bad.push(`stage ${i + 1}: condition lost`);
  });
  const dcs = [...html.slice(0, marks[0]?.index ?? 0).matchAll(/@Check\[(?:fortitude|reflex|will)[^\]]*?\|dc:(\d+)/g)].map((m) => +m[1]);
  if (dcs.length && (def.save.dc !== dcs[0] || ch.dc?.value !== dcs[0])) bad.push(`dc ${def.save.dc}/${ch.dc?.value} != text ${dcs[0]}`);
  const last = def.stages.length - 1;
  def.stages.forEach((s, i) => { if (!s.duration && (def.maxDuration || i < last || def.kind === "poison")) bad.push(`stage ${i + 1}: duration null`); });
  const head = html.slice(0, marks[0]?.index ?? 0);
  if (/<strong>\s*Onset/i.test(head) && def.onset == null) bad.push("onset lost");
  if ([...head.matchAll(/@Check\[(?:fortitude|reflex|will)/g)].length > 1) bad.push("second save check in head");
  const outside = outsideText(html);
  if (outside) bad.push(`text outside stages: ${outside.slice(0, 60)}`);
  const kinds = AFFLICTION_KINDS.filter((k) => item.traits.includes(k));
  if (kinds.length && !kinds.includes(def.kind)) bad.push(`kind ${def.kind} not in traits ${kinds}`);
  if (item.traits.includes("virulent") !== def.virulent && item.traits.includes("virulent")) bad.push("virulent lost");
  return bad;
}

/** Недуг расходника-яда injury -> правило `coat` для каталога: {rule} либо {why}. */
export function coatEntry(rule, html, refs) {
  const c = coatOf(rule), bad = c ? semanticErrors(c, refs, html) ?? [] : ["coatOf: not convertible"];
  return bad.length ? { why: `coat: ${String(bad[0]).slice(0, 80)}` } : { rule: c };
}

const short = (u) => /^dc$/.test(u) ? "dc not in text" : /^stage \d+: /.test(u) ? `stage text: ${u.replace(/^stage \d+: /, "").slice(0, 70)}` : u;

export function buildBatch() {
  const html = readOut("html.json"), { items } = readOut("items.json"), refs = readOut("refs.json"), tri = new Map(readOut("triage.json").items.map((t) => [t.uuid, t]));
  const acc = new Map(readModelAccepted().map((d) => [d.uuid, d]));
  const byId = new Map(Object.entries(refs.conditions).map(([slug, c]) => [c.id, slug]));
  const condSlug = (u) => (u.includes(".conditionitems.") ? byId.get(u.split(".").pop()) ?? null : null);
  const ok = [], debt = [];
  for (const it of items) {
    const h = html[it.uuid], t = tri.get(it.uuid), a = acc.get(it.uuid);
    if (!afflictionStages(h) || !["manual", "markup-high", "markup-low", "markup-head"].includes(t.status)) continue;
    const ours = a?.reason === CONV || a?.reason?.includes("missing: affliction:"), oldDebt = a?.confidence === "needs-primitive" && !ours;
    if (a && !ours && !oldDebt) continue;   // принятое руками/моделью не трогаем; прежний долг перезаписывается только чистым правилом
    const d = { uuid: it.uuid, slug: it.slug, type: it.type, name: it.name, nameRu: it.nameRu, layer: t.layer, batch: t.batchName, dupCount: it.dupCount };
    const r = afflictionRule(h, { name: it.name, traits: it.traits ?? [], condSlug, save: it.defense ? { statistic: it.defense.save } : null });
    let why = null, diffs = [];
    const injury = it.type === "weapon" || (it.traits ?? []).includes("injury") || /@Check\[[^\]]*traits:[^\]|]*\binjury\b/.test(h);
    if (injury && it.type !== "consumable") why = it.type === "weapon" ? "weapon activation" : /^(envenom|vishkanyan venom)$/i.test(it.name) ? "envenom" : "npc injury action, not coat";   // в `coat` идут только расходники
    else if (!r) why = "no save/kind or stage marks";
    else if (!r.rule) why = `invalid rule: ${r.unsure.at(-1)?.slice(0, 80)}`;
    else if (r.unsure.length) why = r.unsure.map(short)[0];
    else if ((diffs = checkAffliction(r.rule, h, it, refs)).length) why = `check: ${diffs[0]}`;
    let rule = r?.rule;
    if (!why && injury) {   // расходник-яд injury: недуг переносится в нанесение на оружие
      ({ rule, why } = coatEntry(r.rule, h, refs));
    }
    if (why && oldDebt) continue;
    if (why) debt.push({ ...d, status: "manual", confidence: "needs-primitive", reason: `needs-primitive: missing: affliction: ${why}`, rule: null });
    else ok.push({ ...d, status: "manual", confidence: "model", reason: CONV, rule });
  }
  return { ok, debt, html, items };
}

function main() {
  const { ok, debt, html, items } = buildBatch();
  const cat = {};
  for (const d of debt) { const k = d.reason.replace(/^needs-primitive: missing: affliction: /, "").replace(/^(stage text|check|coat|invalid rule|duration|text outside stages|onset): .*/, "$1"); cat[k] = (cat[k] ?? 0) + 1; }
  const weight = (l) => l.reduce((s, d) => s + d.dupCount, 0);
  console.log(`catalog ${ok.length} (copies ${weight(ok)}); debt ${debt.length} (copies ${weight(debt)}); by reason`, cat);
  const strip = ({ batch, dupCount, ...d }) => d;
  if (process.argv.includes("--write")) {
    const by = {};
    for (const d of [...ok, ...debt]) (by[d.batch] ??= []).push(strip(d));
    for (const [batch, list] of Object.entries(by)) {
      const p = join(ACCEPTED, `${batch}.json`);
      let ex = null; try { ex = readJson(p); } catch {}
      const meta = { batch, pf2eVersion: readOut("items.json").meta.pf2eVersion };
      writeText(p, serializeDrafts(meta, mergeAccepted(ex, list, meta).items));
    }
    console.log("written:", Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])));
  }
  if (process.argv.includes("--sample")) {
    const seed = +arg("seed", 20261025), n = 50, top = [...ok].sort((a, b) => b.dupCount - a.dupCount || cmp(a.uuid, b.uuid)).slice(0, 25);
    const rest = pick(ok.filter((d) => !top.includes(d)), n - top.length, seed);
    const itemBy = new Map(items.map((i) => [i.uuid, i]));
    const out = { seed, note: `first ${top.length} by dupCount desc, then ${rest.length} random (mulberry32 seed ${seed}) of ${ok.length}`, items: [...top, ...rest].map((d) => ({ uuid: d.uuid, name: d.name, dupCount: d.dupCount, textEn: stripHtml(html[d.uuid]), rule: d.rule })) };
    const f = arg("out");
    writeFileSync(f, JSON.stringify(out, null, 1));
    console.log("sample ->", f);
  }
}
if (isMain(import.meta.url)) main();
