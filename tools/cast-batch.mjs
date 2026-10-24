// Активации «You cast X» массово: deriveCast (scripts/rules.mjs) + проверка по тексту -> rules/drafts-accepted/<batch>.json. Чистые правила — как ответ модели (confidence "model");
// расхождения — долг `needs-primitive: missing: cast: <причина>` без правила. Расходники (pf2e кастует сам), skip, pf2e/catalog/pa-port и документы с готовым правилом не трогаются.
// node tools/cast-batch.mjs            — отчёт (ничего не пишет); --write — записать принятые и долг; --sample [--seed 20261025] --out <file> — выборка 50 для Критика
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOut, readJson, writeText, serializeDrafts, stripHtml, ACCEPTED, arg, cmp, isMain } from "./lib.mjs";
import { deriveCast, frequencyOf, validateRule, RULE_VERSION } from "../scripts/rules.mjs";
import { roundTrip, semanticErrors, mergeAccepted } from "./validate.mjs";
import { readModelAccepted } from "./drafts.mjs";
import { pick } from "./sample.mjs";

const CONV = "model: cast converter";
const SPELL = /@UUID\[(Compendium\.pf2e\.spells-srd\.Item\.[^\]]+)\]/g;
const OPEN = new Set(["manual", "markup-high", "markup-low", "markup-head"]);
const OLD_DEBT = /missing: cast a spell activation|missing: cast spell, armor\/weapon effect choice/;   // прочий долг — ещё и другая механика: не затираем
const bare = (s) => stripHtml(s).replace(/\s+/g, " ");

/** Блоки «Activate» текста -> [{block, eff, links, para}] (те же границы, что у deriveCast). */
function activations(html) {
  const starts = [...html.matchAll(/<strong>\s*Activate\b/gi)].map((m) => m.index);
  return starts.map((a) => {
    const stop = html.slice(a + 1).search(/<strong>\s*(?:Activate|Craft Requirements)\b|<h2/i), block = html.slice(a, stop < 0 ? html.length : a + 1 + stop);
    const eff = /<strong>\s*Effect\s*<\/strong>([\s\S]*)/i.exec(block)?.[1] ?? "";
    return { block, eff, links: [...eff.matchAll(SPELL)].map((m) => m[1]), para: eff.split(/<\/p>/i)[0] };
  });
}

/** Собранное правило против текста -> [расхождения]. */
export function checkCast(rule, html, refs, traits = []) {
  const v = validateRule(rule);
  if (!v.ok) return [`validateRule: ${v.errors.map(String).join("; ").slice(0, 100)}`];
  if (!roundTrip(v.rule)) return ["roundTrip"];
  const bad = semanticErrors(rule, refs, html).map((e) => `semantic: ${String(e).slice(0, 80)}`);
  const all = bare(html), itemDc = /spell DC\b[^.]{0,80}?\bis (\d+)/i.exec(all)?.[1];
  const hearts = /once per day for each spell/i.test(all) || traits.includes("spellheart");
  const isCast = (a) => /\bcasts?\b/i.test(bare(a.eff));
  for (const a of activations(html)) if (isCast(a) && a.links.length > 1) bad.push(`activation with ${a.links.length} spell links`);
  const acts = activations(html).filter((a) => isCast(a) && a.links.length);   // активация «cast» + @UUID заклинания
  const els = rule.cast ?? [];
  if (acts.length !== els.length) return [...bad, `activations ${acts.length} != cast ${els.length}`];
  acts.forEach((a, i) => {
    const c = els[i];
    if (a.links.length !== 1 || a.links[0] !== c.spell) return bad.push(`activation ${i + 1}: spell differs`);
    const rank = +/(\d+)(?:st|nd|rd|th)[- ]rank/i.exec(a.eff)?.[1] || undefined;
    if (rank !== c.rank) bad.push(`activation ${i + 1}: rank ${c.rank} != text ${rank}`);
    const chk = +/@Check\[[^\]]*\bdc:(\d+)/.exec(a.para)?.[1] || +itemDc || undefined;
    if (chk !== c.dc) bad.push(`activation ${i + 1}: dc ${c.dc} != text ${chk}`);
    if (!chk && /\bDC\s*\d+/.test(bare(a.block))) bad.push(`activation ${i + 1}: dc in text not taken`);
    if (/@(?:Check|Damage)\[/.test(a.eff.slice(a.para.length))) bad.push(`activation ${i + 1}: extra check/damage after the cast`);
    const f = frequencyOf(/<strong>\s*Frequency\s*<\/strong>([^<]*)/i.exec(a.block)?.[1]) ?? (hearts ? { value: 1, unit: "days" } : null) ?? frequencyOf(bare(a.block));
    if (JSON.stringify(f) !== JSON.stringify(c.per ?? null)) bad.push(`activation ${i + 1}: per ${JSON.stringify(c.per)} != text ${JSON.stringify(f)}`);
    if (c.requires) bad.push(`activation ${i + 1}: requires set`);
  });
  return bad;
}

export function buildBatch() {
  const html = readOut("html.json"), { items } = readOut("items.json"), refs = readOut("refs.json"), tri = new Map(readOut("triage.json").items.map((t) => [t.uuid, t]));
  const acc = new Map(readModelAccepted().map((d) => [d.uuid, d]));
  const spellDefs = Object.fromEntries(items.filter((i) => i.pack === "spells-srd").map((i) => [i.uuid, { slug: i.slug, save: !!i.defense?.save }]));
  const ok = [], debt = [];
  for (const it of items) {
    const h = html[it.uuid], t = tri.get(it.uuid), a = acc.get(it.uuid);
    if (!h || it.type === "consumable" || !OPEN.has(t.status) || t.rule) continue;
    const dc = deriveCast(h, { spellDefs, traits: it.traits ?? [] });
    if (!dc) continue;
    const ours = a?.reason === CONV || a?.reason?.includes("missing: cast:"), oldDebt = a?.confidence === "needs-primitive" && !ours && OLD_DEBT.test(a.reason);
    const nullCast = a && !a.rule && a.reason?.startsWith("model-null") && /cast/i.test(a.reason);
    if (a && !ours && !oldDebt && !nullCast) continue;   // готовое правило и прочий долг не трогаем
    const d = { uuid: it.uuid, slug: it.slug, type: it.type, name: it.name, nameRu: it.nameRu, layer: t.layer, batch: t.batchName, dupCount: it.dupCount };
    const rule = { v: RULE_VERSION, ...(it.name && { label: it.name }), cast: dc.cast };
    const why = checkCast(rule, h, refs, it.traits ?? [])[0] ?? null;
    if (why && (oldDebt || nullCast)) continue;   // прежнее решение остаётся
    if (why) debt.push({ ...d, status: "manual", confidence: "needs-primitive", reason: `needs-primitive: missing: cast: ${why}`, rule: null });
    else ok.push({ ...d, status: "manual", confidence: "model", reason: CONV, rule: validateRule(rule).rule });
  }
  return { ok, debt, html, items };
}

function main() {
  const { ok, debt, html } = buildBatch();
  const cat = {};
  for (const d of debt) {
    const k = d.reason.replace(/^needs-primitive: missing: cast: /, "").replace(/activation \d+: /, "").replace(/(\d+|\{[^}]*\}|undefined|null)/g, "#").slice(0, 45);
    cat[k] = (cat[k] ?? 0) + 1;
  }
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
    const out = { seed, note: `first ${top.length} by dupCount desc, then ${rest.length} random (mulberry32 seed ${seed}) of ${ok.length}`, items: [...top, ...rest].map((d) => ({ uuid: d.uuid, name: d.name, dupCount: d.dupCount, textEn: stripHtml(html[d.uuid]), rule: d.rule })) };
    writeFileSync(arg("out"), JSON.stringify(out, null, 1));
    console.log("sample ->", arg("out"));
  }
}
if (isMain(import.meta.url)) main();
