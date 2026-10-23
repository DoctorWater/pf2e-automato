// Перенос pf2e-automations (PA) в нашу схему: механически переводимое -> rules/drafts/pa-port.json,
// остальное — rule:null с причиной (список причин = будущие примитивы схемы). Выход: tools/out/pa-port.json (сводка и «долги переноса»).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, ACCEPTED, AUTOMATIONS_CONFIG, cmp, readJson, readOut, writeJson, writeText, outPath, isMain, arg, stripHtml } from "./lib.mjs";
import { makeContext, BATCHES } from "./triage.mjs";
import { buildAutomationsIndex } from "../scripts/compat.mjs";
import { deriveFromMarkup, validateRule, parseCheck } from "../scripts/rules.mjs";
import { DEGREES } from "../scripts/util.mjs";
import { roundTrip } from "./validate.mjs";

// причины, где нужна ручная работа, а не новый примитив схемы
export const MANUAL_REASONS = new Set(["pa-own-effect", "effect-missing", "no-roll-def", "no-save-def", "invalid", "unknown", "unmatched", "cond-unknown", "slug-mismatch", "low"]);
// feat:/feature:/spell: — условие «у актёра есть чужой фит/заклинание», безвредно только если это сам предмет (OWN)
const IDENT = /^(?:origin:)?(?:item|action|consumable)(?::slug)?:[a-z0-9-]+$|^outcome:/;
const OWN = /^(?:origin:)?(feat|feature|spell):(?:slug:)?([a-z0-9-]+)$/;
const TIER = /-(minor|lesser|moderate|greater|major|true)$/;
// обработчик PA повторяет selfEffect самого предмета (Hunt Prey у PC-действия); у копий NPC selfEffect нет — это долг 0.5e
const NATIVE_HANDLERS = new Set(["huntPrey"]);
const slugify = (s) => String(s).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const SAVES = ["fortitude", "reflex", "will"];
const UNITS = { rounds: "rounds", minutes: "minutes", hours: "hours", days: "days" };

const tokensOf = (p, out = []) => {
  if (typeof p === "string") out.push(p);
  else if (Array.isArray(p)) p.forEach((x) => tokensOf(x, out));
  else if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) if (["or", "and", "not", "nor"].includes(k)) out.push(...(k === "not" ? ["not"] : []), ...tokensOf(v));   // операнды сравнений — числа и roll option, слугов в них нет
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
  const act = ["action", "feat", "campaignFeature"].includes(it.type), live = act && it.actionType !== "passive";   // у пассива правило на использование мёртвое
  if (tr === "spell-cast") return it.type === "spell" || live;   // заклинание-подобная способность NPC — действие
  if (tr === "use") return live || (!act && it.type !== "spell");
  if (tr === "postInfo") return live;
  return !(act && it.actionType === "passive");
};
/** Чужие условия feat:/feature:/spell: предиката с полярностью (not переворачивает): [{tok, pol}]. */
export const foreignConds = (p, slug, pol = true, out = []) => {
  if (typeof p === "string") { const m = OWN.exec(p); if (m && m[2] !== slug) out.push({ tok: p, pol }); }
  else if (Array.isArray(p)) p.forEach((x) => foreignConds(x, slug, pol, out));
  else if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) if (k === "not") foreignConds(v, slug, !pol, out); else if (["or", "and", "nor"].includes(k)) foreignConds(v, slug, pol, out);
  return out;
};
const strongSlugs = (toks) => toks.map((t) => /^(?:origin:)?(?:item(?::slug)?|consumable|action):([a-z0-9-]+)$/.exec(t)?.[1]).filter(Boolean);

/** Один шаг PA -> наш шаг apply. Возвращает {steps[]} | {fail}. */
function stepsOf(r, who, ctx) {
  const sub = (u) => ctx.subst?.[u] ?? u;   // пропавший id эффекта -> единственная ссылка на эффект в тексте предмета
  const effOk = (u) => (u.startsWith("Compendium.pf2e-automations.") ? "pa-own-effect" : ctx.effects[sub(u)] || /\.conditionitems\./.test(u) ? null : "effect-missing");
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
      const hasVal = dur && dur.value != null && dur.value !== "";   // без value PA берёт длительность из самого эффекта и лишь переопределяет юнит: переносить нечего
      if (hasVal && !Number.isInteger(+dur.value)) return { fail: "dice-duration" };
      const d = hasVal && UNITS[dur.unit] ? { value: +dur.value, unit: dur.unit, expiry: ["turn-start", "turn-end"].includes(dur.expiry) ? dur.expiry : null, of: "origin" } : null;
      for (const c of v.conditions ?? []) { const s = cond(c); if (!s) return { fail: "cond-unknown" }; out.push(mk({ ...s, ...(d && d.value >= 1 && { duration: d }) })); }
      for (const e of v.effects ?? []) { const bad = effOk(e); if (bad) return { fail: bad }; out.push(mk({ effect: { uuid: sub(e) } })); }
    }
    return out.length ? { steps: out } : { fail: "unknown" };
  }
  if (kind === "Effect") { const bad = effOk(r.value ?? ""); return bad ? { fail: bad } : r.choiceSetSelection ? { fail: "choice-set" } : { steps: [mk({ effect: { uuid: sub(r.value) } })] }; }
  if (kind === "AddCondition") { const s = cond(r.value); return s ? { steps: [mk(s)] } : { fail: "cond-unknown" }; }
  if (kind === "RemoveCondition") return { fail: "remove-condition" };
  if (/IncreaseBadgeEffect/.test(r.target)) return { fail: "increase-badge" };
  if (kind === "Damage") return { fail: "damage-step" };
  if (r.target === "TurnOnOption") return { fail: "turn-on-option" };
  return { fail: `target-${r.target}` };
}

const APPLIED = /\bappl(?:ied|y|ies|ying)\b[^.,]{0,40}?\b(?:to|on|onto)\b(?: the skin of)? (?:a|an|another|the) (?:[\w-]+ ){0,2}?(?:creature|undead|ally)\b(?!['’]s)/i;
/** Кому достаётся SelfOrTarget: "data" — у предмета есть цель или дальность; "text" — по тексту «наносится на существо»; null — на себя. */
export const targetKind = (item, html) => {
  const t = String(item.target ?? "").trim(), r = String(item.range ?? "").trim();
  if ((t && !/^(?:you|yourself|self)\.?$/i.test(t)) || (r && !/^self$/i.test(r))) return "data";
  return APPLIED.test(stripHtml(html ?? "")) ? "text" : null;
};

/** Правило PA -> {trigger, degrees:[]|null, steps, low:[причины понижения], foreign, selText} | {fail}. */
export function translatePart(r, item, ctx) {
  if (r.type === "handler") return { fail: `handler:${r.value}` };
  const toks = tokensOf(r.predicate);
  const degrees = toks.map((t) => /^outcome:(\w+)$/.exec(t)?.[1]).filter((d) => DEGREES.includes(d));
  const extra = toks.filter((t) => !IDENT.test(t) && OWN.exec(t)?.[2] !== item.slug && t !== "not" && !/\s|-st$/.test(t));
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
  const tk = sel ? targetKind(item, ctx.html) : null;
  if (sel) who = tk ? "target" : "self";
  const s = stepsOf(r, who, ctx);
  if (s.fail) return s;
  return { trigger: tr, degrees: roll ? degrees : null, steps: s.steps, low, selfOrTarget: sel, selText: tk === "text", foreign: foreignConds(r.predicate, item.slug) };
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

const effName = (s) => String(s ?? "").toLowerCase().replace(/^(?:spell effect|effect|feat effect|stance|aura)\s*:\s*/, "").replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const ruleEffects = (r) => [r.value, ...(r.values ?? []).flatMap((v) => v.effects ?? [])].filter((u) => typeof u === "string" && u.startsWith("Compendium.") && !/\.conditionitems\./.test(u));
const stepsAll = (rule) => (rule ? [...rule.onUse.apply, ...Object.values(rule.onUse.challenge?.byDegree ?? {}).flat(), ...Object.values(rule.onUse.check?.byDegree ?? {}).flat()] : []);

/** Правила группы для предмета, найденного по source, но со старым slug в предикате (предмет переименован): все правила, если slug-токены согласованы; у расходников — по суффиксу тира. */
function renamedRules(rules, item) {
  const strong = rules.map((r) => strongSlugs(tokensOf(r.predicate)));
  const names = new Set(strong.flat());
  if (item.type === "consumable") {
    if (new Set([...names].map((n) => n.replace(TIER, ""))).size > 1) return [];
    const tier = TIER.exec(item.slug)?.[1] ?? "";
    return rules.filter((r, i) => strong[i].some((n) => (TIER.exec(n)?.[1] ?? "") === tier));
  }
  return names.size <= 1 ? rules : [];
}

/** Группа PA + предмет -> {rule|null, confidence, reason, partial?, native?}. viaSource: группа найдена по source предмета, а не по slug. */
export function translateItem(item, html, group, ctx0, { slugOnly = false, viaSource = false } = {}) {
  if (item.selfEffect && group.rules.length && group.rules.every((r) => r.type === "handler" && NATIVE_HANDLERS.has(r.value))) return { rule: null, confidence: null, reason: "native:handler", native: true };
  let rules = group.rules.filter((r) => { const s = strongSlugs(tokensOf(r.predicate)); return !s.length || s.includes(item.slug); });
  if (!rules.length) {
    if (group.rules.length === 1) rules = group.rules;
    else if (viaSource) rules = renamedRules(group.rules, item);
    if (!rules.length) return { rule: null, confidence: null, reason: "slug-mismatch" };
  }
  // пропавший id эффекта (в pf2e 8.6.1 его нет): единственная ссылка на существующий эффект в тексте предмета, не занятая другим шагом
  const eff = rules.flatMap(ruleEffects), missing = [...new Set(eff.filter((u) => !u.startsWith("Compendium.pf2e-automations.") && !ctx0.effects[u]))];
  const links = [...new Set([...html.matchAll(/@UUID\[(Compendium\.pf2e\.[a-z0-9-]*effects\.Item\.\w+)\]/g)].map((m) => m[1]))].filter((u) => ctx0.effects[u]);
  const subst = missing.length === 1 && links.length === 1 && !eff.includes(links[0]) ? { [missing[0]]: links[0] } : null;
  const ctx = { ...ctx0, html, subst };
  const parts = [], fails = [];
  for (const r of rules) { const p = translatePart(r, item, ctx); (p.fail ? fails : parts).push(p.fail ?? p); }
  // условие и его отрицание дают один и тот же результат (Taunt: feat:long-distance-taunt меняет лишь дальность) -> условие безвредно
  const sig = (p) => JSON.stringify([p.trigger, p.degrees, p.steps]);
  for (const p of parts) p.low = p.low.filter((l) => !p.foreign.some((f) => `predicate:${f.tok}` === l && parts.some((q) => q !== p && sig(q) === sig(p) && q.foreign.some((g) => g.tok === f.tok && g.pol !== f.pol))));
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
  // группа назвала свои предметы по uuid, а этот документ из компендия найден лишь по slug и другого типа, чем предметы группы, — скорее всего, другой предмет с тем же именем (армейская «Taunt» из Kingmaker)
  if (!viaSource && !item.embedded && group.srcTypes?.size && !group.srcTypes.has(item.type)) low.push("slug-only-other-item");
  const steps = stepsAll(built.rule);
  // каждая ссылка правила должна быть в тексте предмета: иначе PA сработал по соседнему предмету или ошибся. Эффект с именем самого предмета («Effect: Fly» у Fly) — его собственный
  for (const a of steps) {
    if (a.effect && !html.includes(a.effect.uuid) && (effName(ctx.effects[a.effect.uuid]) !== effName(item.name) || ctx.effectRisk?.[a.effect.uuid] || ctx.tierSiblings?.(item))) low.push("effect-not-in-text");
    if (a.condition && !html.includes(`conditionitems.Item.${ctx.condIds?.[a.condition.slug]}`)) low.push(`condition-not-in-text:${a.condition.slug}`);
  }
  // цель PA перенесена как есть: у расходника/снаряжения без «target» эффект, скорее всего, для владельца (Stormbreaker/Ghostbane Fulu); SelfOrTarget по тексту «наносится на существо» — исключение
  if (["consumable", "equipment"].includes(item.type) && !item.target && parts.some((p) => !p.selText && p.steps.some((a) => a.to === "target"))) low.push("to-target-no-item-target");
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
  if (!allFails.length && built.rule) {
    // pf2e делает это сам: единственный эффект правила — selfEffect самого документа (у копии NPC свой system.selfEffect, источник не в счёт)
    const se = item.selfEffect;
    const native = !!se && steps.length > 0 && steps.every((a) => a.to === "self" && a.effect?.uuid === se);
    return { rule: built.rule, confidence: low.length ? "low" : "high", reason: `translated: ${parts.length} part(s)${low.length ? "; " + [...new Set(low)].join(",") : ""}`, ...(native && { native: true }), ...(slugOnly && { slugOnly: true }) };
  }
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
 * Ручные каталоги (manual) главнее: запись, чей источник или slug там уже есть, отбрасывается. Черновики со статусом paStatus (covered/native/false-coverage) не переносятся.
 * bySlug — если все предметы с этим slug (в т.ч. NPC-копии без source) — одна способность: у всех одно и то же правило или правила нет вовсе.
 * Чужой предмет с тем же slug, копия со статусом native/false-coverage или сомнительное (low) правило закрывают slug: ложное совпадение хуже пропуска.
 * Возвращает outcome: uuid -> "ported" | причина, по которой черновик не попал в каталог.
 */
export function buildPaCatalog(drafts, accepted, items, manual) {
  const acc = new Map(accepted.map((d) => [d.uuid, d]));
  const all = drafts.map((d) => acc.get(d.uuid) ?? d);
  const itemBy = new Map(items.map((i) => [i.uuid, i])), draftBy = new Map(all.map((d) => [d.uuid, d]));
  const mSrc = new Set(manual.flatMap((c) => Object.keys(c.bySource ?? {}))), mSlug = new Set(manual.flatMap((c) => Object.keys(c.bySlug ?? {})));
  const sig = (r) => JSON.stringify({ ...r, label: null });   // имя у копий одной способности может отличаться
  const keyOf = (i) => (i.embedded ? i.source ?? i.uuid : i.uuid);   // NPC-копии одного заклинания — один предмет
  const byItemSlug = {}, drafted = new Set();
  for (const i of items) { if (i.slug) (byItemSlug[i.slug] ??= []).push(i); if (draftBy.has(i.uuid)) drafted.add(keyOf(i)); }
  const slugVerdict = (slug) => {
    const sigs = new Set();
    let bad = false;
    for (const i of byItemSlug[slug] ?? []) {
      const d = draftBy.get(i.uuid);
      if (!d) { bad ||= !mSrc.has(keyOf(i)) && !drafted.has(keyOf(i)); continue; }   // чужой предмет; копия предмета, у которого черновик есть, — тот же предмет
      if (d.paStatus === "covered") continue;
      if (d.paStatus && d.paStatus !== "port") { bad = true; continue; }
      if (d.rule) { bad ||= d.confidence !== "high" && !acc.has(d.uuid); sigs.add(sig(d.rule)); }
    }
    return sigs.size > 1 ? "source-conflict" : bad || !sigs.size ? "slug-ambiguous" : null;
  };
  const verdicts = {}, skipped = {}, cand = [], bySource = {}, bySlug = {}, included = [], outcome = new Map();
  const skip = (k, d) => { skipped[k] = (skipped[k] ?? 0) + 1; outcome.set(d.uuid, k); };
  for (const d of all.sort((a, b) => cmp(a.uuid, b.uuid))) {
    if (d.paStatus && d.paStatus !== "port") { skip(d.paStatus, d); continue; }
    if (!d.rule) { skip(acc.has(d.uuid) ? "excluded-manually" : "no-rule", d); continue; }   // rule:null в drafts-accepted — явное исключение
    if (d.confidence !== "high" && !acc.has(d.uuid)) { skip("low", d); continue; }
    const v = validateRule(d.rule);
    if (!v.ok) { skip("invalid", d); continue; }
    if (!roundTrip(v.rule)) { skip("roundtrip", d); continue; }
    const it = itemBy.get(d.uuid);
    // копия NPC, найденная лишь по slug: её source — другой предмет, правило на него не вешаем
    const src = it?.embedded ? (d.slugOnly ? null : it.source) : d.uuid;
    if ((src && mSrc.has(src)) || mSlug.has(d.slug)) { skip("manual-wins", d); continue; }
    const verdict = (verdicts[d.slug] ??= slugVerdict(d.slug));
    if (!src && verdict) { skip(verdict, d); continue; }
    cand.push({ d, src, slug: verdict ? null : d.slug, rule: v.rule });
  }
  // один источник у нескольких предметов (копии в NPC) с разными правилами — не берём ни одно
  const rules = {}, inSrc = new Set(), inSlug = new Set();
  for (const c of cand) if (c.src) (rules[c.src] ??= new Set()).add(sig(c.rule));
  for (const c of cand) {
    if (c.src && rules[c.src].size > 1) { skip("source-conflict", c.d); continue; }
    if (c.src) bySource[c.src] ??= c.rule;
    if (c.slug) bySlug[c.slug] ??= c.rule;
    outcome.set(c.d.uuid, "ported");
    if (c.src ? !inSrc.has(c.src) : !inSlug.has(c.slug)) included.push({ ...c.d, catSource: c.src, catSlug: c.slug });   // для выборки — без дублей NPC-копий
    if (c.src) inSrc.add(c.src); else inSlug.add(c.slug);
  }
  return { cat: { v: 1, bySource, bySlug }, skipped, included, outcome };
}

/** Каталог: одна запись на строку (читаемые диффы). */
const serializeCatalog = (c) => `{"v":1,\n"bySource":{\n${Object.entries(c.bySource).map(([k, r]) => `${JSON.stringify(k)}:${JSON.stringify(r)}`).join(",\n")}\n},\n"bySlug":{\n${Object.entries(c.bySlug).map(([k, r]) => `${JSON.stringify(k)}:${JSON.stringify(r)}`).join(",\n")}\n}}\n`;

/** Группа PA найдена по slug лишь потому, что он упомянут в предикате чужого фита (Oscillating Wave: заклинания в `or` рядом с feature:): предмет — условие, а не предмет группы. */
export function falseCoverage(group, it, viaSource) {
  if (viaSource || group.ownSlugs?.has(it.slug)) return false;
  const hit = group.rules.filter((r) => { const t = tokensOf(r.predicate); return strongSlugs(t).includes(it.slug) || t.some((x) => OWN.exec(x)?.[2] === it.slug); });
  // триггер — slug в самом предикате (action:sense-motive, origin:item:quick-tempered); внутри or/and он лишь одно из условий фита
  const trigger = (r) => strongSlugs((Array.isArray(r.predicate) ? r.predicate : [r.predicate]).filter((x) => typeof x === "string")).includes(it.slug);
  return hit.length > 0 && hit.every((r) => !trigger(r) && foreignConds(r.predicate, it.slug).some((f) => /^(?:origin:)?(?:feat|feature):/.test(f.tok)));
}

/** Сигнатура правила для сверки ручного и переведённого: механика, шаги по степеням, СЛ. */
const stepKey = (list) => (list ?? []).filter((a) => a.condition || a.effect).map((a) => `${a.to ?? "target"}:${a.condition ? a.condition.slug + (a.condition.value ?? "") : a.effect.uuid}`).sort().join(",");
export function sigOf(r) {
  const u = r?.onUse;
  if (!u) return { mech: r?.onAttacked ? "reaction" : "other", steps: {} };
  const k = u.challenge ? "challenge" : u.check ? "check" : null, c = k && u[k];
  const mech = k ? `${k}:${c.statistic}${c.vs?.defense ? ":" + c.vs.defense : ""}` : r.macros?.length ? "macro" : u.zone ? "zone" : "apply";
  const steps = { apply: stepKey(u.apply), ...Object.fromEntries(Object.entries(c?.byDegree ?? {}).map(([d, l]) => [d, stepKey(l)])) };
  return { mech, steps, dc: c?.dc };
}
/**
 * Ручное правило по slug покрывает документ только если описывает ту же способность так же, как PA/текст:
 * covered | slug-collision (другая способность: другой тип или механика) | manual-gap (та же способность, правило расходится; immunity-after-save — нет иммунитета).
 * other — переведённое PA правило, иначе выведенное из текста; paFail — причина провала перевода PA.
 */
export const markersOf = (html) => [...new Set([...(html ?? "").matchAll(/@UUID\[([^\]]+)\]|@Check\[(\w+)|\[\[\/act (\w+)/g)].map((m) => m[1] ?? m[2] ?? m[3]))].sort().join("|");
const IMMUNITY = /immune\b[^.]{0,100}\b(?:for|until)\b/i;   // в схеме иммунитета после испытания нет (0.5c): ручное правило его не даёт
export function manualVerdict(manual, item, other, paFail, canon, html = "", sameMarkers = null) {
  if (!item.embedded && canon && canon.type !== item.type) return { status: "slug-collision", reasons: ["slug-collision", "type-differs"] };
  const imm = paFail?.includes("immunity-after-save") || IMMUNITY.test(stripHtml(html));
  if (!other) {
    if (sameMarkers === false) return { status: "slug-collision", reasons: ["slug-collision", "text"] };
    if (sameMarkers == null) return { status: "manual-gap", reasons: ["manual-gap", imm ? "immunity-after-save" : "unverified"] };
    return imm ? { status: "manual-gap", reasons: ["manual-gap", "immunity-after-save"] } : { status: "covered" };
  }
  const a = sigOf(manual), b = sigOf(other);
  if (a.mech !== b.mech) return { status: "slug-collision", reasons: ["slug-collision", "mech-differs"] };
  const dcBad = a.dc?.value != null ? b.dc?.value != null && a.dc.value !== b.dc.value : a.dc?.source === "spell" ? item.type !== "spell" && b.dc?.value != null : false;
  const degs = [...new Set([...Object.keys(a.steps), ...Object.keys(b.steps)])];
  const stepBad = a.mech !== "macro" && degs.some((d) => (a.steps[d] ?? "") !== (b.steps[d] ?? ""));
  if (dcBad || stepBad) return { status: "manual-gap", reasons: ["manual-gap", dcBad ? "dc" : "steps", ...(imm ? ["immunity-after-save"] : [])] };
  return imm ? { status: "manual-gap", reasons: ["manual-gap", "immunity-after-save"] } : { status: "covered" };
}

// подпачки ROADMAP §5.1: причина долга -> куда она относится
const E_HANDLERS = new Set(["huntPrey", "deleteHoldingBreath", "suffocatingEndTurn", "grab", "grabImproved", "grapple", "rageImmunity", "theOscillatingWave", "theOscillatingWaveRefocus"]);
const SUBPACK_REASONS = {
  "0.5c": ["immunity-after-save", "roll-trigger"],
  "0.5d": ["pa-own-effect", "dice-duration"],
  "0.5f": ["increase-badge", "no-roll-def", "no-save-def", "remove-condition", "turn-on-option"],
  "0.5g": ["on-damage-roll", "damage-step", "outcome-on-use", "party-effect", "choice-set", "target-OnlyAllyWithinRange", "both-roll-kinds"]
};
const SUBPACK_ORDER = ["0.5e", "0.5g", "0.5d", "0.5c", "0.5f"];
/** Подпачка долга по причинам [«handler:x», «pa-own-effect»…]; первая по порядку SUBPACK_ORDER, всё прочее — остаток 0.5b (ручной разбор). */
export function subpackOf(reasons) {
  const has = new Set();
  for (const r of reasons) {
    const [k, v] = r.split(":");
    if (k === "handler") has.add(E_HANDLERS.has(v) ? "0.5e" : "0.5g");
    else for (const [sp, l] of Object.entries(SUBPACK_REASONS)) if (l.includes(k) || (k === "target" && l.some((x) => r.startsWith(x)))) has.add(sp);
  }
  return SUBPACK_ORDER.find((sp) => has.has(sp)) ?? "0.5b";
}

/** Итоговый статус черновика: ported | covered | native | false-coverage | debt (+ причины долга). */
export function statusOf(d, outcome) {
  if (["covered", "native", "false-coverage"].includes(d.paStatus)) return { status: d.paStatus };
  if (d.debtReasons) return { status: "debt", reasons: d.debtReasons };
  const o = outcome.get(d.uuid);
  if (o === "ported") return { status: "ported" };
  if (o === "manual-wins") return { status: "covered" };
  if (d.rule && o === "low") return { status: "debt", reasons: d.reason.split("; ")[1]?.split(",") ?? ["low"], low: true };
  if (d.rule) return { status: "debt", reasons: [o ?? "unknown"] };
  return { status: "debt", reasons: d.reason.split("; ") };
}

function main() {
  const { meta, items } = readOut("items.json");
  const html = readOut("html.json"), refs = readOut("refs.json"), tri = readOut("triage.json").items;
  const triBy = new Map(tri.map((t) => [t.uuid, t])), itBy = new Map(items.map((i) => [i.uuid, i]));
  const config = readJson(AUTOMATIONS_CONFIG);
  const catalogJsons = ["catalog.json", "catalog.campaign.json"].map((f) => readJson(join(ROOT, "rules", f)));
  const mSrc = new Set(catalogJsons.flatMap((c) => Object.keys(c.bySource ?? {}))), mSlug = new Set(catalogJsons.flatMap((c) => Object.keys(c.bySlug ?? {})));
  const canonOf = (slug) => { const k = ctx.slugKind?.get(slug); return k ? items.find((i) => !i.embedded && i.slug === slug && i.type === k.type && i.pack === k.pack) : null; };
  const tierN = {};
  for (const i of new Set(items.filter((x) => !x.embedded).map((x) => x.slug))) tierN[i.replace(TIER, "")] = (tierN[i.replace(TIER, "")] ?? 0) + 1;
  const tierSiblings = (it) => tierN[it.slug.replace(TIER, "")] > 1;
  const ctx = { ...makeContext({ refs, catalogJsons, items, labels: readJson(join(ROOT, "rules/labels.json")) }), grants: refs.grants, condIds: Object.fromEntries(Object.entries(refs.conditions).map(([k, c]) => [k, c.id])), effects: refs.effects, condSlugs: new Set(Object.keys(refs.conditions)), effectRisk: refs.effectRisk ?? {}, tierSiblings };

  const groups = [];
  for (const g of config.groups) {
    const idx = buildAutomationsIndex([g])[0];
    if (idx) groups.push({ name: g.name, kind: g.group, rules: [...(g.baseRules ?? []), ...(g.complexRules ?? []), ...(g.handlerRules ?? [])], slugs: idx.slugs, uuids: idx.uuids, srcTypes: new Set([...idx.uuids].map((u) => itBy.get(u)?.type).filter(Boolean)), ownSlugs: new Set([...(g.source ?? []).filter((s) => !String(s).startsWith("Compendium.")), slugify(g.name)]), docs: [] });
  }
  const bySlug = new Map(), byUuid = new Map();
  for (const g of groups) { for (const s of g.slugs) (bySlug.get(s) ?? bySlug.set(s, []).get(s)).push(g); for (const u of g.uuids) (byUuid.get(u) ?? byUuid.set(u, []).get(u)).push(g); }

  const drafts = [], triCatalog = [];
  for (const it of items) {
    const t = triBy.get(it.uuid);
    if (!t || !["pa-port", "catalog"].includes(t.status)) continue;
    const src = it.embedded ? it.source : it.uuid;
    const gsAll = [...new Set([...(bySlug.get(it.slug) ?? []), ...(byUuid.get(src) ?? [])])];
    const viaSource = (g) => !!byUuid.get(src)?.includes(g);
    for (const g of gsAll) g.docs.push({ it, status: t.status, res: null });
    if (t.status === "catalog") { triCatalog.push(it.uuid); continue; }
    const gs = gsAll.filter((g) => !falseCoverage(g, it, viaSource(g)));
    const base = { uuid: it.uuid, slug: it.slug, type: it.type, name: it.name, nameRu: it.nameRu, layer: 3, status: "pa-port", groups: gsAll.map((g) => g.name), batch: t.batchName };
    if (src && mSrc.has(src)) { drafts.push({ ...base, paStatus: "covered", confidence: null, reason: "covered: ручной каталог по источнику", rule: null }); continue; }
    if (!gs.length) { drafts.push({ ...base, paStatus: "false-coverage", confidence: null, reason: `false-coverage: slug лишь в предикате группы ${gsAll.map((g) => g.name).join(", ")}`, rule: null }); continue; }
    // у предмета несколько групп — берём группу с правилами; результаты склеиваются только по первой переводимой
    let best = null;
    for (const g of gs) {
      const r = translateItem(it, html[it.uuid] ?? "", g, ctx, { viaSource: viaSource(g), slugOnly: !viaSource(g) });
      g.docs.find((d) => d.it === it).res = r;
      if (!best || (r.rule && !best.rule)) best = { ...r, group: g.name };
    }
    const { native, slugOnly, group, ...res } = best;
    // ручное правило по тому же slug: покрывает, только если описывает этот же предмет так же (иначе долг manual-gap / slug-collision)
    if (mSlug.has(it.slug)) {
      const manual = ctx.catalog.bySlug.get(it.slug);
      const html0 = html[it.uuid] ?? "";
      const derived = res.rule ?? (() => { const d = deriveFromMarkup({ type: it.type, slug: it.slug, name: it.name, system: { description: { value: html0 }, defense: it.defense ? { save: { statistic: it.defense.save, basic: it.defense.basic } } : undefined, area: it.area ? {} : undefined, target: it.target ?? undefined, actionType: { value: it.actionType }, traits: { value: it.traits } } }, ctx.labels, ctx.condSlugByUuid, ctx.condNames); return d?.rule ?? null; })();
      const canon = canonOf(it.slug);
      const v = manualVerdict(manual, it, derived, res.rule ? null : res.reason, ctx.slugKind?.get(it.slug), html0, canon ? markersOf(html[canon.uuid]) === markersOf(html0) : null);
      if (v.status === "covered") drafts.push({ ...base, paStatus: "covered", confidence: null, reason: "covered: ручной каталог по slug", rule: null });
      else drafts.push({ ...base, paStatus: v.status, debtReasons: v.reasons, confidence: null, reason: v.reasons.join(","), rule: null });
      continue;
    }
    drafts.push({ ...base, ...(native && { paStatus: "native" }), ...(slugOnly && it.embedded && { slugOnly: true }), confidence: res.confidence, reason: res.reason, rule: res.rule, ...(res.partial && { partial: res.partial }) });
  }
  drafts.forEach((d) => { d.paStatus ??= "port"; });

  // шипуемый каталог; included — для выборки Критика (tools/sample.mjs pa-port)
  const ap = join(ACCEPTED, "pa-port.json");
  const { cat, skipped, included, outcome } = buildPaCatalog(drafts, existsSync(ap) ? readJson(ap).items : [], items, catalogJsons);
  writeText(join(ROOT, "rules/catalog.pa.json"), serializeCatalog(cat));

  // сводка: у каждого документа ровно один статус
  const docs = { total: drafts.length + triCatalog.length, ported: 0, covered: triCatalog.length, native: 0, falseCoverage: 0, debt: 0 };
  const debt = { bySubpack: {}, byReason: {}, lowByReason: {}, handlers: {} };
  const fin = new Map(triCatalog.map((u) => [u, "covered"]));
  for (const d of drafts) {
    const s = statusOf(d, outcome);
    fin.set(d.uuid, s.status);
    d.finalStatus = s.status;
    if (s.status !== "debt") { docs[{ ported: "ported", covered: "covered", native: "native", "false-coverage": "falseCoverage" }[s.status]]++; continue; }
    docs.debt++;
    const keys = [...new Set(s.reasons.map((x) => x.split(":")[0]))];
    const sp = s.low ? "0.5b" : subpackOf(s.reasons);
    d.debt = { subpack: sp, reasons: s.reasons };
    debt.bySubpack[sp] = (debt.bySubpack[sp] ?? 0) + 1;
    for (const k of keys) { const b = s.low ? debt.lowByReason : debt.byReason; b[k] = (b[k] ?? 0) + 1; }
    for (const m of d.reason.matchAll(/handler:([A-Za-z0-9_]+)/g)) debt.handlers[m[1]] = (debt.handlers[m[1]] ?? 0) + 1;
  }
  // сводка по группам PA
  const gs = { total: groups.length, ported: 0, script: 0, primitive: 0, manual: 0 }, gmanual = {};
  for (const g of groups) {
    const rs = g.docs.map((d) => (fin.get(d.it.uuid) !== "debt" ? "ok" : d.res?.rule ? "low" : d.res?.reason ?? "unmatched"));
    if (!rs.length) { gs.manual++; gmanual.unmatched = (gmanual.unmatched ?? 0) + 1; continue; }
    if (g.docs.every((d) => d.status === "catalog")) { gs.ported++; continue; }
    const fails = rs.filter((x) => x !== "ok").flatMap((x) => x.split("; ").map((y) => y.split(":")[0]));
    if (!fails.length) gs.script++;
    else if (fails.some((f) => MANUAL_REASONS.has(f))) { gs.manual++; for (const f of new Set(fails)) gmanual[f] = (gmanual[f] ?? 0) + 1; }
    else gs.primitive++;
  }
  const debts = existsSync(join(ROOT, "pa-port-report.md")) ? parseDebts(readFileSync(join(ROOT, "pa-port-report.md"), "utf8")) : [];
  const summary = { paVersion: config.version, docs: { ...docs, applicable: docs.total - docs.falseCoverage, done: docs.ported + docs.covered + docs.native, percent: +((100 * (docs.ported + docs.covered + docs.native)) / (docs.total - docs.falseCoverage)).toFixed(1) }, debt: { total: docs.debt, ...debt }, groups: gs, manualReasonsByGroup: gmanual, catalog: { bySource: Object.keys(cat.bySource).length, bySlug: Object.keys(cat.bySlug).length, skipped }, debts };
  writeJson(outPath("pa-port.json"), summary);
  const head = `{"meta":${JSON.stringify({ batch: "pa-port", generatedAt: new Date().toISOString(), pf2eVersion: meta.pf2eVersion, paVersion: config.version, counts: docs })},\n"items":[\n`;
  writeText(join(ROOT, "rules/drafts/pa-port.json"), head + drafts.map((d) => JSON.stringify(d)).join(",\n") + "\n]}\n");

  // выборка Критика: только правила, которых не было в каталоге на ревизии --since (по умолчанию HEAD) или у которых правило изменилось
  const since = arg("since", "HEAD");
  let prev = { bySource: {}, bySlug: {} };
  try { prev = JSON.parse(execFileSync("git", ["show", `${since}:rules/catalog.pa.json`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 })); } catch { console.warn(`pa-port: нет rules/catalog.pa.json на ${since}, все правила считаются новыми`); }
  // ключ предмета — источник; по slug судим лишь копии без источника (slug-запись у предмета с источником — то же уже виденное правило)
  const differs = (c) => (c.catSource ? JSON.stringify(prev.bySource[c.catSource]) !== JSON.stringify(cat.bySource[c.catSource]) : JSON.stringify(prev.bySlug[c.catSlug]) !== JSON.stringify(cat.bySlug[c.catSlug]));
  const fresh = included.filter(differs);
  writeJson(outPath("pa-catalog.json"), { since, items: fresh, all: included.length });
  console.log("pa-port:", JSON.stringify({ docs: summary.docs, debt: summary.debt.bySubpack, catalog: summary.catalog, newRules: fresh.length }));
}

if (isMain(import.meta.url)) main();
