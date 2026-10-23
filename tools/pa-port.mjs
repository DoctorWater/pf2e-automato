// Перенос pf2e-automations (PA) в нашу схему: механически переводимое -> rules/drafts/pa-port.json,
// остальное — rule:null с причиной (список причин = будущие примитивы схемы). Выход: tools/out/pa-port.json (сводка и «долги переноса»).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ACCEPTED, AUTOMATIONS_CONFIG, cmp, readJson, readOut, writeJson, writeText, outPath, isMain } from "./lib.mjs";
import { makeContext, BATCHES } from "./triage.mjs";
import { buildAutomationsIndex } from "../scripts/compat.mjs";
import { deriveFromMarkup, validateRule, parseCheck } from "../scripts/rules.mjs";
import { DEGREES } from "../scripts/util.mjs";
import { roundTrip } from "./validate.mjs";

// причины, где нужна ручная работа, а не новый примитив схемы
export const MANUAL_REASONS = new Set(["pa-own-effect", "effect-missing", "no-roll-def", "no-save-def", "invalid", "unknown", "unmatched", "cond-unknown", "slug-mismatch"]);
const IDENT = /^(?:origin:)?(?:item|action|feat|feature|spell|consumable)(?::slug)?:[a-z0-9-]+$|^outcome:/;
const SAVES = ["fortitude", "reflex", "will"];
const UNITS = { rounds: "rounds", minutes: "minutes", hours: "hours", days: "days" };

const tokensOf = (p, out = []) => {
  if (typeof p === "string") out.push(p);
  else if (Array.isArray(p)) p.forEach((x) => tokensOf(x, out));
  else if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) out.push(...(k === "not" ? ["not"] : []), ...tokensOf(v));
  return out;
};
/** Ключи предиката кроме or/and/not (gte, lt, eq…): сравнения мы не переносим, значит, правило может быть шире, чем у PA. */
export const predicateOps = (p, out = new Set()) => {
  if (Array.isArray(p)) p.forEach((x) => predicateOps(x, out));
  else if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) { if (!["or", "and", "not"].includes(k)) out.add(k); predicateOps(v, out); }
  return out;
};
/** Совместим ли триггер PA с типом документа. */
export const triggerFits = (tr, it) => {
  if (tr === "spell-cast") return it.type === "spell";
  if (tr === "use") return it.type === "consumable" || it.type === "equipment" || it.type === "weapon" || it.type === "armor" || it.type === "shield";
  if (tr === "postInfo") return ["action", "feat", "campaignFeature"].includes(it.type) && it.actionType !== "passive";
  return !(["action", "feat", "campaignFeature"].includes(it.type) && it.actionType === "passive");
};
const strongSlugs = (toks) => toks.map((t) => /^(?:origin:)?(?:item(?::slug)?|consumable|action):([a-z0-9-]+)$/.exec(t)?.[1]).filter(Boolean);

/** Один шаг PA -> наш шаг apply. Возвращает {steps[]} | {fail}. */
function stepsOf(r, who, ctx) {
  const effOk = (u) => (u.startsWith("Compendium.pf2e-automations.") ? "pa-own-effect" : ctx.effects[u] || /\.conditionitems\./.test(u) ? null : "effect-missing");
  const cond = (s) => {
    const m = /^([a-z-]+?)(?:\s+(\d+))?$/.exec(String(s).trim());
    return m && ctx.condSlugs.has(m[1]) ? { condition: { slug: m[1], ...(m[2] && { value: +m[2] }), policy: "max" } } : null;
  };
  const kind = r.target.replace(/^(?:SelfOrTargets?|Self|Targets?|Party)/, "") || r.target;
  const mk = (x) => ({ to: who, ...x });
  if (r.values) {   // complex
    const out = [];
    for (const v of r.values) {
      if (v.immunities?.length) return { fail: "immunity-after-save" };
      const dur = v.duration && Object.keys(v.duration).length ? v.duration : null;
      if (dur && !Number.isInteger(+dur.value)) return { fail: "dice-duration" };
      const d = dur && UNITS[dur.unit] ? { value: +dur.value, unit: dur.unit, expiry: ["turn-start", "turn-end"].includes(dur.expiry) ? dur.expiry : null, of: "origin" } : null;
      for (const c of v.conditions ?? []) { const s = cond(c); if (!s) return { fail: "cond-unknown" }; out.push(mk({ ...s, ...(d && d.value >= 1 && { duration: d }) })); }
      for (const e of v.effects ?? []) { const bad = effOk(e); if (bad) return { fail: bad }; out.push(mk({ effect: { uuid: e } })); }
    }
    return out.length ? { steps: out } : { fail: "unknown" };
  }
  if (kind === "Effect") { const bad = effOk(r.value ?? ""); return bad ? { fail: bad } : r.choiceSetSelection ? { fail: "choice-set" } : { steps: [mk({ effect: { uuid: r.value } })] }; }
  if (kind === "AddCondition") { const s = cond(r.value); return s ? { steps: [mk(s)] } : { fail: "cond-unknown" }; }
  if (kind === "RemoveCondition") return { fail: "remove-condition" };
  if (/IncreaseBadgeEffect/.test(r.target)) return { fail: "increase-badge" };
  if (kind === "Damage") return { fail: "damage-step" };
  if (r.target === "TurnOnOption") return { fail: "turn-on-option" };
  return { fail: `target-${r.target}` };
}

/** Правило PA -> {trigger, degrees:[]|null, steps, low:[причины понижения]} | {fail}. */
export function translatePart(r, item, ctx) {
  if (r.type === "handler") return { fail: `handler:${r.value}` };
  const toks = tokensOf(r.predicate);
  const degrees = toks.map((t) => /^outcome:(\w+)$/.exec(t)?.[1]).filter((d) => DEGREES.includes(d));
  const extra = toks.filter((t) => !IDENT.test(t) && t !== "not" && !/\s|-st$/.test(t));
  const low = [...extra.map((t) => `predicate:${t}`), ...[...predicateOps(r.predicate)].map((k) => `predicate-op:${k}`)];
  if (!triggerFits(r.triggerType, item)) low.push(`trigger-type:${r.triggerType}/${item.type}`);
  if (item.actionType === "reaction" && r.target.startsWith("Self") && !r.target.startsWith("SelfOr")) low.push("reaction-self");
  const tr = r.triggerType;
  const sel = r.target.startsWith("SelfOr");
  const self = r.target.startsWith("Self") && !sel, party = r.target.startsWith("Party");
  if (party) return { fail: "party-effect" };
  if (tr === "damage-roll") return { fail: "on-damage-roll" };
  const author = ["skill-check", "attack-roll", "perception-check"].includes(tr);
  const roll = author || tr === "saving-throw";
  if (roll && !degrees.length) return { fail: `roll-trigger:${tr}` };
  if (!roll && !["use", "spell-cast", "postInfo", "self-effect"].includes(tr)) return { fail: `trigger:${tr}` };
  if (!roll && degrees.length) return { fail: "outcome-on-use" };
  let who = tr === "saving-throw" ? "target" : self ? "self" : "target";
  if (sel) { who = item.type === "consumable" ? "self" : "target"; if (item.type !== "consumable") low.push("self-or-target"); }
  const s = stepsOf(r, who, ctx);
  if (s.fail) return s;
  return { trigger: tr, degrees: roll ? degrees : null, steps: s.steps, low, selfOrTarget: sel };
}

const CHECK_SKIP = new Set(["flat", "lore"]);
/** Оболочка проверки по тексту предмета: challenge (спасбросок цели) либо check (бросок автора). */
function shell(kind, item, html, ctx) {
  if (kind === "challenge") {
    const d = deriveFromMarkup({ type: item.type, slug: item.slug, name: item.name, system: { description: { value: html }, defense: item.defense ? { save: { statistic: item.defense.save, basic: item.defense.basic } } : undefined, area: item.area ? {} : undefined, target: item.target ?? undefined, actionType: { value: item.actionType }, traits: { value: item.traits } } }, ctx.labels, ctx.condSlugByUuid, ctx.condNames);
    const c = d?.rule.onUse?.challenge;
    if (c) return { ...c, byDegree: {} };
    return item.defense ? { statistic: item.defense.save, dc: { source: "spell" }, basic: item.defense.basic, rollerRole: "target", byDegree: {} } : null;
  }
  let stat = null;
  for (const m of html.matchAll(/@Check\[([^\]]*)\]/g)) { const t = (parseCheck(m[1]).type ?? "").split(",")[0]; if (t && !SAVES.includes(t) && !CHECK_SKIP.has(t)) { stat = t; break; } }
  const vs = (/\b(Perception|Will|Reflex|Fortitude)\s+DC/i.exec(html)?.[1] ?? (/\bAC\b/.test(html) ? "ac" : null))?.toLowerCase();
  const opts = item.type === "action" ? [`action:${item.slug}`] : undefined;
  if (stat && vs) return { statistic: stat, vs: { defense: vs }, ...(opts && { options: opts }), byDegree: {} };
  if (item.type === "spell" && item.traits.includes("attack")) return { statistic: "spell-attack", vs: { defense: "ac" }, roll: "system", byDegree: {} };
  return null;
}

/** Группа PA + предмет -> {rule|null, confidence, reason, partial?}. */
export function translateItem(item, html, group, ctx, { slugOnly = false } = {}) {
  let rules = group.rules.filter((r) => { const s = strongSlugs(tokensOf(r.predicate)); return !s.length || s.includes(item.slug); });
  if (!rules.length) { if (group.rules.length !== 1) return { rule: null, confidence: null, reason: "slug-mismatch" }; rules = group.rules; }
  const parts = [], fails = [];
  for (const r of rules) { const p = translatePart(r, item, ctx); (p.fail ? fails : parts).push(p.fail ?? p); }
  const build = () => {
    const apply = [], byDegree = {}, kinds = new Set();
    for (const p of parts) {
      if (!p.degrees) apply.push(...p.steps);
      else { kinds.add(p.trigger === "saving-throw" ? "challenge" : "check"); for (const d of p.degrees) (byDegree[d] ??= []).push(...p.steps); }
    }
    if (kinds.size > 1) return { fail: "both-roll-kinds" };
    const u = { targets: apply.length && apply.every((a) => a.to === "self") && !kinds.size ? "self" : item.area ? "area" : "selected", excludeSelf: null, zone: null, challenge: null, apply };
    if (kinds.size) {
      const k = [...kinds][0], sh = shell(k, item, html, ctx);
      if (!sh) return { fail: k === "challenge" ? "no-save-def" : "no-roll-def" };
      u[k] = { ...sh, byDegree };
    }
    const seen = new Set();
    u.apply = apply.filter((a) => { const k = JSON.stringify(a); return !seen.has(k) && seen.add(k); });
    for (const [d, l] of Object.entries(byDegree)) { const sd = new Set(); byDegree[d] = l.filter((a) => { const k = JSON.stringify(a); return !sd.has(k) && sd.add(k); }); }
    const v = validateRule({ v: 1, label: item.name, onUse: u });
    return v.ok ? { rule: v.rule } : { fail: "invalid", detail: v.errors.map(String).join("; ") };
  };
  const built = parts.length ? build() : { fail: null };
  const allFails = [...fails, ...(built.fail ? [built.fail] : [])];
  const low = parts.flatMap((p) => p.low);
  // каждая ссылка правила должна быть в тексте предмета: иначе PA сработал по соседнему предмету или ошибся
  for (const a of built.rule ? [...built.rule.onUse.apply, ...Object.values(built.rule.onUse.challenge?.byDegree ?? {}).flat(), ...Object.values(built.rule.onUse.check?.byDegree ?? {}).flat()] : []) {
    if (a.effect && !html.includes(a.effect.uuid)) low.push("effect-not-in-text");
    if (a.condition && !html.includes(`conditionitems.Item.${ctx.condIds?.[a.condition.slug]}`)) low.push(`condition-not-in-text:${a.condition.slug}`);
  }
  if (slugOnly && item.embedded) low.push("npc-slug-only");
  // цель PA перенесена как есть: у расходника/снаряжения без «target» эффект, скорее всего, для владельца (Stormbreaker/Ghostbane Fulu)
  const steps = built.rule ? [...built.rule.onUse.apply, ...Object.values(built.rule.onUse.challenge?.byDegree ?? {}).flat(), ...Object.values(built.rule.onUse.check?.byDegree ?? {}).flat()] : [];
  if (["consumable", "equipment"].includes(item.type) && !item.target && steps.some((a) => a.to === "target")) low.push("to-target-no-item-target");
  // текст -> правило (узко): «you become/gain the @UUID[состояние]» без такого состояния ни в правиле, ни в GrantItem выданного эффекта
  if (built.rule) {
    const have = new Set(steps.flatMap((a) => [a.condition && ctx.condIds?.[a.condition.slug], ...(a.effect ? ctx.grants?.[a.effect.uuid] ?? [] : [])]).filter(Boolean));
    const slugById = Object.fromEntries(Object.entries(ctx.condIds ?? {}).map(([k, v]) => [v, k]));
    for (const m of html.matchAll(/\b(?:you|it|they|target|creature)\s+(?:become|becomes|are|is|gain|gains|have|has)\s+(?:the\s+)?@UUID\[Compendium\.pf2e\.conditionitems\.Item\.(\w+)\]|\bbecoming\s+@UUID\[Compendium\.pf2e\.conditionitems\.Item\.(\w+)\]/gi)) {
      const id = m[1] ?? m[2];
      if (!have.has(id)) low.push(`text-condition-missing:${slugById[id] ?? id}`);
    }
  }
  // правило слабее текста: в тексте спасбросок или шаблон области, а перенос — только «на себя» без испытания (Blight Breath, Thawing Candle)
  const u = built.rule?.onUse;
  if (u && !u.challenge && u.targets === "self" && /@Check\[(?:fortitude|reflex|will)\b|@Template\[/.test(html)) low.push("text-has-save-or-area");
  if (!allFails.length && built.rule) return { rule: built.rule, confidence: low.length ? "low" : "high", reason: `translated: ${parts.length} part(s)${low.length ? "; " + [...new Set(low)].join(",") : ""}` };
  return { rule: null, confidence: null, reason: allFails.length ? [...new Set(allFails)].join("; ") : "unknown", ...(built.rule && { partial: built.rule }) };
}

/** «Долги переноса» из pa-port-report.md: строки таблиц, где колонка расхождений не «—». */
export function parseDebts(md) {
  const out = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length < 4 || /^-+$/.test(c[0].replace(/\s/g, "")) || ["Сущность", "Действие"].includes(c[0])) continue;
    const gap = c[c.length - 1];
    if (gap && gap !== "—") out.push({ entity: c[0], slug: /\(([a-z-]+)/.exec(c[0])?.[1] ?? null, gap });
  }
  return out;
}


/**
 * Черновики PA -> шипуемый каталог { v, bySource, bySlug }. Идут только high и принятые вручную (rules/drafts-accepted/pa-port.json, перекрывает по uuid).
 * Ручные каталоги (manual) главнее: запись, чей источник или slug там уже есть, отбрасывается.
 * bySlug — только если slug у ровно одного предмета во всём наборе (в т.ч. среди встроенных в NPC): ложное совпадение хуже пропуска.
 */
export function buildPaCatalog(drafts, accepted, items, manual) {
  const acc = new Map(accepted.map((d) => [d.uuid, d]));
  const all = drafts.map((d) => acc.get(d.uuid) ?? d);
  const slugN = {}, itemBy = new Map(items.map((i) => [i.uuid, i]));
  const keyOf = (i) => (i.embedded ? i.source ?? i.uuid : i.uuid);   // NPC-копии одного заклинания — один предмет
  const seenKey = new Set();
  for (const i of items) if (i.slug && !seenKey.has(keyOf(i))) { seenKey.add(keyOf(i)); slugN[i.slug] = (slugN[i.slug] ?? 0) + 1; }
  const mSrc = new Set(manual.flatMap((c) => Object.keys(c.bySource ?? {}))), mSlug = new Set(manual.flatMap((c) => Object.keys(c.bySlug ?? {})));
  const skipped = {}, cand = [], bySource = {}, bySlug = {}, included = [];
  const skip = (k) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  for (const d of all.sort((a, b) => cmp(a.uuid, b.uuid))) {
    if (!d.rule) { skip(acc.has(d.uuid) ? "excluded-manually" : "no-rule"); continue; }   // rule:null в drafts-accepted — явное исключение
    if (d.confidence !== "high" && !acc.has(d.uuid)) { skip("low"); continue; }
    const v = validateRule(d.rule);
    if (!v.ok) { skip("invalid"); continue; }
    if (!roundTrip(v.rule)) { skip("roundtrip"); continue; }
    const it = itemBy.get(d.uuid), src = it?.embedded ? it.source : d.uuid;
    const slug = slugN[d.slug] === 1 ? d.slug : null;
    if ((src && mSrc.has(src)) || mSlug.has(d.slug)) { skip("manual-wins"); continue; }
    if (!src && !slug) { skip("no-key"); continue; }
    cand.push({ d, src, slug, rule: v.rule });
  }
  // один источник у нескольких предметов (копии в NPC) с разными правилами — не берём ни одно
  const rules = {}, inSrc = new Set();
  for (const c of cand) if (c.src) (rules[c.src] ??= new Set()).add(JSON.stringify(c.rule));
  for (const c of cand) {
    if (c.src && rules[c.src].size > 1) { skip("source-conflict"); continue; }
    if (c.src) bySource[c.src] = c.rule;
    if (c.slug) bySlug[c.slug] = c.rule;
    if (!c.src || !inSrc.has(c.src)) included.push(c.d);   // для выборки — без дублей NPC-копий
    inSrc.add(c.src);
  }
  return { cat: { v: 1, bySource, bySlug }, skipped, included };
}

/** Каталог: одна запись на строку (читаемые диффы). */
const serializeCatalog = (c) => `{"v":1,\n"bySource":{\n${Object.entries(c.bySource).map(([k, r]) => `${JSON.stringify(k)}:${JSON.stringify(r)}`).join(",\n")}\n},\n"bySlug":{\n${Object.entries(c.bySlug).map(([k, r]) => `${JSON.stringify(k)}:${JSON.stringify(r)}`).join(",\n")}\n}}\n`;

function main() {
  const { meta, items } = readOut("items.json");
  const html = readOut("html.json"), refs = readOut("refs.json"), tri = readOut("triage.json").items;
  const triBy = new Map(tri.map((t) => [t.uuid, t]));
  const config = readJson(AUTOMATIONS_CONFIG);
  const catalogJsons = ["catalog.json", "catalog.campaign.json"].map((f) => readJson(join(ROOT, "rules", f)));
  const ctx = { ...makeContext({ refs, catalogJsons, labels: readJson(join(ROOT, "rules/labels.json")) }), grants: refs.grants, condIds: Object.fromEntries(Object.entries(refs.conditions).map(([k, c]) => [k, c.id])), effects: refs.effects, condSlugs: new Set(Object.keys(refs.conditions)) };

  const groups = [];
  for (const g of config.groups) {
    const idx = buildAutomationsIndex([g])[0];
    if (idx) groups.push({ name: g.name, kind: g.group, rules: [...(g.baseRules ?? []), ...(g.complexRules ?? []), ...(g.handlerRules ?? [])], slugs: idx.slugs, uuids: idx.uuids, docs: [] });
  }
  const bySlug = new Map(), byUuid = new Map();
  for (const g of groups) { for (const s of g.slugs) (bySlug.get(s) ?? bySlug.set(s, []).get(s)).push(g); for (const u of g.uuids) (byUuid.get(u) ?? byUuid.set(u, []).get(u)).push(g); }

  const drafts = [], reasons = {}, perDoc = { catalog: 0, translated: 0, failed: 0 };
  for (const it of items) {
    const t = triBy.get(it.uuid);
    if (!t || !["pa-port", "catalog"].includes(t.status)) continue;
    const gs = [...new Set([...(bySlug.get(it.slug) ?? []), ...(byUuid.get(it.embedded ? it.source : it.uuid) ?? [])])];
    for (const g of gs) g.docs.push({ it, status: t.status, res: null });
    if (t.status === "catalog") { perDoc.catalog++; continue; }
    // у предмета несколько групп — берём группу с правилами; результаты склеиваются только по первой переводимой
    let best = null;
    for (const g of gs) {
      const r = translateItem(it, html[it.uuid] ?? "", g, ctx, { slugOnly: !(it.embedded && byUuid.get(it.source)?.includes(g)) });
      g.docs.find((d) => d.it === it).res = r;
      if (!best || (r.rule && !best.rule)) best = { ...r, group: g.name };
    }
    best ??= { rule: null, confidence: null, reason: "unmatched" };
    best.rule ? perDoc.translated++ : perDoc.failed++;
    if (!best.rule) for (const k of new Set(best.reason.split("; ").map((x) => x.split(":")[0]))) reasons[k] = (reasons[k] ?? 0) + 1;
    drafts.push({ uuid: it.uuid, slug: it.slug, type: it.type, name: it.name, nameRu: it.nameRu, layer: 3, status: "pa-port", confidence: best.confidence, reason: best.reason, rule: best.rule, ...(best.partial && { partial: best.partial }), groups: gs.map((g) => g.name), batch: t.batchName });
  }
  // сводка по группам PA
  const gs = { total: groups.length, ported: 0, script: 0, primitive: 0, manual: 0 }, gmanual = {};
  for (const g of groups) {
    const rs = g.docs.map((d) => (d.status === "catalog" ? "ok" : d.res?.rule ? "ok" : d.res?.reason ?? "unmatched"));
    if (!rs.length) { gs.manual++; gmanual.unmatched = (gmanual.unmatched ?? 0) + 1; continue; }
    if (g.docs.every((d) => d.status === "catalog")) { gs.ported++; continue; }
    const fails = rs.filter((x) => x !== "ok").flatMap((x) => x.split("; ").map((y) => y.split(":")[0]));
    if (!fails.length) gs.script++;
    else if (fails.some((f) => MANUAL_REASONS.has(f))) { gs.manual++; for (const f of new Set(fails)) gmanual[f] = (gmanual[f] ?? 0) + 1; }
    else gs.primitive++;
  }
  const debts = existsSync(join(ROOT, "pa-port-report.md")) ? parseDebts(readFileSync(join(ROOT, "pa-port-report.md"), "utf8")) : [];
  const hv = {};
  for (const d of drafts) for (const m of d.reason.matchAll(/handler:([A-Za-z0-9_]+)/g)) hv[m[1]] = (hv[m[1]] ?? 0) + 1;
  const summary = { paVersion: config.version, groups: gs, docs: { ...perDoc, total: drafts.length + perDoc.catalog }, reasons, handlers: hv, manualReasonsByGroup: gmanual, debts };
  writeJson(outPath("pa-port.json"), summary);
  const head = `{"meta":${JSON.stringify({ batch: "pa-port", generatedAt: new Date().toISOString(), pf2eVersion: meta.pf2eVersion, paVersion: config.version, counts: perDoc })},\n"items":[\n`;
  writeText(join(ROOT, "rules/drafts/pa-port.json"), head + drafts.map((d) => JSON.stringify(d)).join(",\n") + "\n]}\n");
  console.log("pa-port:", JSON.stringify({ groups: gs, docs: summary.docs, reasons }));
  // шипуемый каталог; included (с учётом принятых) — для выборки Критика (tools/sample.mjs pa-port)
  const ap = join(ACCEPTED, "pa-port.json");
  const { cat, skipped, included } = buildPaCatalog(drafts, existsSync(ap) ? readJson(ap).items : [], items, catalogJsons);
  writeText(join(ROOT, "rules/catalog.pa.json"), serializeCatalog(cat));
  writeJson(outPath("pa-catalog.json"), { items: included });
  console.log("pa-catalog:", JSON.stringify({ bySource: Object.keys(cat.bySource).length, bySlug: Object.keys(cat.bySlug).length, skipped }));
}

if (isMain(import.meta.url)) main();
