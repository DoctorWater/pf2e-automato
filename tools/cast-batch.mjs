// Активации «You cast X» массово: deriveCast (scripts/rules.mjs) + проверка по тексту -> rules/drafts-accepted/<batch>.json. Чистые правила — как ответ модели (confidence "model");
// расхождения — долг `needs-primitive: missing: cast: <причина>` без правила. Расходники (pf2e кастует сам), skip, pf2e/catalog/pa-port и документы с готовым правилом не трогаются.
// node tools/cast-batch.mjs            — отчёт (ничего не пишет); --write — записать принятые и долг; --sample [--seed 20261025] --out <file> — выборка 50 для Критика
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOut, readJson, writeText, serializeDrafts, stripHtml, ACCEPTED, arg, cmp, isMain } from "./lib.mjs";
import { deriveCast, frequencyOf, castProse, validateRule, RULE_VERSION } from "../scripts/rules.mjs";
import { roundTrip, semanticErrors, mergeAccepted } from "./validate.mjs";
import { readModelAccepted } from "./drafts.mjs";
import { pick } from "./sample.mjs";

const CONV = "model: cast converter";
const SPELL = /@UUID\[(Compendium\.pf2e\.spells-srd\.Item\.[^\]]+)\]/g;
const OPEN = new Set(["manual", "markup-high", "markup-low", "markup-head"]);
const OLD_DEBT = /missing: cast a spell activation|missing: cast spell, armor\/weapon effect choice/;   // прочий долг — ещё и другая механика: не затираем

/** Блоки «Activate» текста -> [{block, eff, links, para}] (те же границы, что у deriveCast). */
function activations(html) {
  const starts = [...html.matchAll(/<strong>\s*Activate\b/gi)].map((m) => m.index);
  return starts.map((a) => {
    const stop = html.slice(a + 1).search(/<strong>\s*(?:Activate|Craft Requirements)\b|<h2/i), block = html.slice(a, stop < 0 ? html.length : a + 1 + stop);
    const eff = /<strong>\s*Effect\s*<\/strong>([\s\S]*)/i.exec(block)?.[1] ?? "";
    return { block, eff, links: [...eff.matchAll(SPELL)].map((m) => m[1]), para: eff.split(/<\/p>/i)[0] };
  });
}

/**
 * Собранное правило против текста -> [расхождения]. Проверка ширше вывода: ВСЕ активации предмета (без cast-а — долг), весь текст блока (лишнее после сотворения — долг),
 * все числа СЛ/атаки/противодействия текста (чужих и не взятых не должно быть). spellDefs: {uuid: {cantrip}}.
 */
export function checkCast(rule, html, refs, spellDefs = {}) {
  const v = validateRule(rule);
  if (!v.ok) return [`validateRule: ${v.errors.map(String).join("; ").slice(0, 100)}`];
  if (!roundTrip(v.rule)) return ["roundTrip"];
  const bad = semanticErrors(rule, refs, html).map((e) => `semantic: ${String(e).slice(0, 80)}`);
  const all = castProse(html), own = (s) => /\b(?:you|those)\b[^.]*\bmust\b/i.test(s);   // «You … must succeed at a …» — испытание самого владельца, не СЛ заклинания
  const sents = (t) => t.split(/(?<=[.!?])\s+/).filter((s) => !own(s));
  const nums = (re, t) => new Set(sents(t).flatMap((s) => [...s.matchAll(re)].map((m) => +(m[1] ?? m[2]))));
  const acts = activations(html), els = rule.cast ?? [];
  if (acts.length !== els.length) return [...bad, `activations ${acts.length} != cast ${els.length}`];
  const itemSpellDc = nums(/\bspell DC\b[^.]{0,80}?(\d+)|\bDC of (?:any|all|each) spells?[^.]{0,80}?(\d+)/gi, all), attacks = nums(/\bspell attack\b[^.]{0,80}?\+(\d+)/gi, all);
  const held = /\bmust be held\b/i.test(all) ? "held" : undefined;
  acts.forEach((a, i) => {
    const c = els[i], n = `activation ${i + 1}`, text = castProse(a.eff);
    if (a.links.length !== 1 || a.links[0] !== c.spell) return bad.push(`${n}: ${a.links.length ? "spell differs" : "no spell link"}`);
    if (!/\bcast(?:s|ing)?\b/.test(text)) bad.push(`${n}: no cast word`);
    if (/\beither\b|\bone of\b|\bor (?:an? )?(?:\d+\w\w-rank )?@UUID/i.test(a.eff)) bad.push(`${n}: choice between spells`);
    const ranks = [...text.matchAll(/(\d+)(?:st|nd|rd|th)[- ]rank/gi)].map((m) => +m[1]), rank = ranks[0] || undefined, half = /\bhalf (?:its|your|the)\b/i.test(text);
    if (ranks.length > 1) bad.push(`${n}: several ranks in text`);
    if (half ? !spellDefs[c.spell]?.cantrip || c.rank != null : rank !== c.rank) bad.push(`${n}: rank ${c.rank} != text ${half ? "half level" : rank}`);
    if (/@(?:Damage|Template)\[|\binstead\b|@UUID\[Compendium\.pf2e\.[\w-]*effects\b|\bimmun|\balso\b|\bexcept\b|\bunlike\b|\bIf your next action\b/i.test(a.eff)) bad.push(`${n}: extra effect after the cast`);
    // @Check вне предложения с заклинанием и не владельца: допустим один — с СЛ правила (повтор СЛ приписью); остальное — лишнее после сотворения
    const foreign = a.eff.split(/(?<=[.!?])\s+|<\/p>/).filter((x) => !own(castProse(x)) && !x.includes(c.spell)).flatMap((x) => [...x.matchAll(/@Check\[[^\]]*\]/g)].map((m) => m[0]));
    if (foreign.length > (c.dc != null && foreign.some((x) => new RegExp(`\\bdc:${c.dc}\\b`).test(x)) ? 1 : 0)) bad.push(`${n}: extra check/damage after the cast`);
    const dcs = new Set([...nums(/\bdc:(\d+)/g, a.eff), ...nums(/\bDC (?:of )?(\d+)/gi, text), ...itemSpellDc]);
    if (c.dc == null ? dcs.size : !dcs.has(c.dc) || dcs.size > 1) bad.push(`${n}: dc ${c.dc} != text ${[...dcs]}`);
    if (c.attack == null ? attacks.size : !attacks.has(c.attack) || attacks.size > 1) bad.push(`${n}: attack ${c.attack} != text ${[...attacks]}`);
    const cs = nums(/\bcounteract (?:check|modifier)\b[^.]{0,30}?\+(\d+)/gi, all);
    if (c.counteract == null ? cs.size : !cs.has(c.counteract)) bad.push(`${n}: counteract ${c.counteract} != text ${[...cs]}`);
    const f = frequencyOf(/<strong>\s*Frequency\s*<\/strong>([^<]*)/i.exec(a.block)?.[1]) ?? frequencyOf(castProse(a.block));
    if (JSON.stringify(f) !== JSON.stringify(c.per ?? null)) bad.push(`${n}: per ${JSON.stringify(c.per)} != text ${JSON.stringify(f)}`);
    if (c.requires !== held) bad.push(`${n}: requires ${c.requires} != text ${held}`);
  });
  return bad;
}

export function buildBatch() {
  const html = readOut("html.json"), { items } = readOut("items.json"), refs = readOut("refs.json"), tri = new Map(readOut("triage.json").items.map((t) => [t.uuid, t]));
  const acc = new Map(readModelAccepted().map((d) => [d.uuid, d]));
  const spellDefs = Object.fromEntries(items.filter((i) => i.pack === "spells-srd").map((i) => [i.uuid, { slug: i.slug, save: !!i.defense?.save, attack: /\bspell attack\b/i.test(i.descEn ?? ""), cantrip: (i.traits ?? []).includes("cantrip") }]));
  const ok = [], debt = [];
  for (const it of items) {
    const h = html[it.uuid], t = tri.get(it.uuid), a = acc.get(it.uuid);
    if (!h || it.type === "consumable" || !OPEN.has(t.status) || t.rule) continue;
    const dc = deriveCast(h, { spellDefs });
    if (!dc) continue;
    const ours = a?.reason === CONV || a?.reason?.includes("missing: cast:"), oldDebt = a?.confidence === "needs-primitive" && !ours && OLD_DEBT.test(a.reason);
    const nullCast = a && !a.rule && a.reason?.startsWith("model-null") && /cast/i.test(a.reason);
    if (a && !ours && !oldDebt && !nullCast) continue;   // готовое правило и прочий долг не трогаем
    const d = { uuid: it.uuid, slug: it.slug, type: it.type, name: it.name, nameRu: it.nameRu, layer: t.layer, batch: t.batchName, dupCount: it.dupCount };
    const rule = { v: RULE_VERSION, ...(it.name && { label: it.name }), cast: dc.cast };
    const why = checkCast(rule, h, refs, spellDefs)[0] ?? null;
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
