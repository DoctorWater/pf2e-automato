// Активации «You cast X» массово: deriveCast (scripts/rules.mjs) + проверка по тексту -> rules/drafts-accepted/<batch>.json. Чистые правила — как ответ модели (confidence "model");
// расхождения — долг `needs-primitive: missing: cast: <причина>` без правила. Расходники (pf2e кастует сам), skip, pf2e/catalog/pa-port и документы с готовым правилом не трогаются.
// node tools/cast-batch.mjs            — отчёт (ничего не пишет); --write — записать принятые и долг; --sample [--seed 20261025] --out <file> — выборка 50 для Критика
import { writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readOut, readJson, writeText, serializeDrafts, stripHtml, ACCEPTED, arg, cmp, isMain } from "./lib.mjs";
import { deriveCast, activateOf, frequencyOf, castProse, validateRule, RULE_VERSION } from "../scripts/rules.mjs";
import { roundTrip, semanticErrors, mergeAccepted } from "./validate.mjs";
import { readModelAccepted } from "./drafts.mjs";
import { pick } from "./sample.mjs";

const CONV = "model: cast converter";   // префикс: «(partial)» — каст + ручные активации; «(low)» — вспомогательный текст в note, ждёт выборки Критика (в каталог не идёт)
const CONV_PARTIAL = `${CONV} (partial)`, CONV_LOW = `${CONV} (low)`;
const SPELL = /@UUID\[(Compendium\.pf2e\.spells-srd\.Item\.[^\]]+)\]/g;
const OPEN = new Set(["manual", "markup-high", "markup-low", "markup-head"]);
const OLD_DEBT = /missing: cast a spell activation|missing: cast spell, armor\/weapon effect choice/;   // метка устарела: пересчитывается в честную причину
const CAST_WORD = /\bcast(?:s|ing)?\b|\beffects? of\b/;   // как у deriveCast
// после сотворения: разметка/числа — долг; слова «also/instead/except/unlike» без разметки — только note (low)
const HARD = /@(?:Damage|Template)\[|@UUID\[Compendium\.pf2e\.[\w-]*effects\b|\bimmun|\bIf your next action\b|@UUID\[Compendium\.pf2e\.conditionitems|\b(?:bonus|penalty|resistance|reroll|degree of success)\b/i;
const SOFT = /\balso\b|\binstead\b|\bexcept\b|\bunlike\b/i;
// «gain the effects of X» — срок даёт сам текст, а не заклинание: каст «как есть» был бы с чужим сроком
const OWN_DURATION = /\bfor (?:\d+|an?|one|the next|up to)\b|\buntil\b|\blasts?\b|\bduration\b|\b\d+ (?:rounds?|minutes?|hours?|days?)\b|\bwhichever\b/i;
const CHOICE = /\beither\b|\bor (?:an? )?(?:\d+\w\w-rank )?@UUID\[Compendium\.pf2e\.spells-srd/i;   // выбор между заклинаниями; «or @UUID» — только спеллы, «one of them» не в счёт

/** Блоки «Activate» текста -> [{block, eff, links, para}] (те же границы, что у deriveCast). */
function activations(html) {
  const starts = [...html.matchAll(/<strong>\s*Activate\b/gi)].map((m) => m.index);
  return starts.map((a) => {
    const stop = html.slice(a + 1).search(/<strong>\s*(?:Activate|Craft Requirements|Destruction)\b|<h2/i), block = html.slice(a, stop < 0 ? html.length : a + 1 + stop);
    const eff = /<strong>\s*Effect\s*<\/strong>([\s\S]*?)(?=<hr|$)/i.exec(block)?.[1] ?? "";
    return { block, eff, links: [...eff.matchAll(SPELL)].map((m) => m[1]), para: eff.split(/<\/p>/i)[0] };
  });
}
/** Активации, из которых deriveCast делает записи cast (одна ссылка на заклинание и слово cast/effects of); остальные — ручные. */
const castActs = (acts) => acts.filter((a) => a.links.length === 1 && CAST_WORD.test(castProse(a.eff)));
const sentencesOf = (t) => t.split(/(?<=[.!?])\s+/);

/** Разметка Foundry -> читаемый текст (для note): @Check -> «DC 43 reflex (basic)», @Damage -> «2d8 healing», @Template -> «30-foot cone»; ссылки и броски — как у castProse. */
export function readable(html) {
  const out = String(html ?? "")
    .replace(/@Check\[([^\]]*)\](?:\{([^}]*)\})?/g, (_, p, l) => l ?? `${/dc:(\d+)/.test(p) ? `DC ${/dc:(\d+)/.exec(p)[1]} ` : ""}${p.split("|")[0].replace(/^type:/, "")}${/\bbasic\b/.test(p) ? " (basic)" : ""}`)
    .replace(/@Damage\[((?:[^\[\]]|\[[^\]]*\])*)\](?:\{([^}]*)\})?/g, (_, p, l) => l ?? p.split("|")[0].replace(/\[([^\]]*)\]/g, " $1"))
    .replace(/@Template\[([^\]]*)\](?:\{([^}]*)\})?/g, (_, p, l) => l ?? `${/distance:(\d+)/.exec(p)?.[1] ?? "?"}-foot ${/(cone|burst|emanation|line|cube)/.exec(p)?.[1] ?? "area"}`);
  return castProse(out.replace(/\[\[\/r\s+([^\]#]*?)\s*(?:#[^\]]*)?\]\](?!\{)/g, "$1")).replace(/\s+/g, " ").trim();   // бросок без подписи — формулой
}
// хвост после ссылки на заклинание: то, что код уже извлёк (СЛ, «на вас», «по вашим указаниям»), хвостом не считается
const TRIVIAL = [/@Check\[[^\]]*\](?:\{[^}]*\})?/g, /\(?\bDC (?:of )?\d+\)?/g, /\bwith a spell attack roll of \+?\d+/g, /\bat \d+(?:st|nd|rd|th)[- ]rank\b/g, /\bas an? \d+(?:st|nd|rd|th)-rank (?:\w+ )?spell\b/g, /\bspell\b/g, /\bto your specifications?\b/g, /\bon (?:you(?:rself)?|its partner|the target|the triggering \w+|the lock you're trying to pick)\b/g, /\baffecting you\b/g, /^\s*to summon\b[^.]*/, /\band an? counteract modifier of \+?\d+/g, /\bagainst the triggering \w+/g, /\b(?:with|an?|and|save|saving|throw|basic|reflex|will|fortitude|dc)\b/gi];
const SPELL_NATIVE = /\bSustain\b|\bAs normal with the spell\b|\bwhen the (?:activation|spell) ends\b/i;
// срок хвоста — долг только явный («It lasts 24 hours», «for 10 minutes»); «up to …» без lasts/for N — note
const TAIL_DURATION = /\blasts?\b[^.]*\d|\bfor \d+ (?:rounds?|minutes?|hours?|days?)\b/i;
const TAIL_HARD = /\b(?:melee|ranged|weapon) attack\b|\bclass DC\b|\bheighten|\bbut\b[^.]*\bdamage\b/i;
/** Хвост активации (всё после ссылки на заклинание) -> {tail: читаемый текст, trivial, hard}. */
function tailOf(a) {
  const m = /@UUID\[Compendium\.pf2e\.spells-srd\.Item\.[^\]]+\](?:\{[^}]*\})?/.exec(a.eff), post = m ? a.eff.slice(m.index + m[0].length) : "";
  // предложения про то, что и так делает само заклинание (Sustain, «as normal with the spell», «when the activation ends»), хвостом не считаются
  const kept = sentencesOf(post).filter((x) => !SPELL_NATIVE.test(castProse(x))).join(" ");
  let rest = kept;
  for (const re of TRIVIAL) rest = rest.replace(re, "");
  const tail = readable(post), keptTail = readable(kept);
  const cut = m && [...a.eff.slice(0, m.index).matchAll(/[.!?]\s+|<\/p>\s*/g)].pop(), full = readable(a.eff.slice(cut ? cut.index + cut[0].length : 0));   // предложение со сотворением и всё после него — для note
  return { tail, full, trivial: !/[A-Za-z0-9]/.test(castProse(rest)), hard: TAIL_HARD.test(keptTail) || TAIL_DURATION.test(keptTail) };
}
// механика вне блоков Activate: пассивка, общая частота нескольких предметов — правило закрывает только активации
// ponytail: узкий признак (частота «once per» + ссылка на состояние); бонусы/сопротивления вне блоков закрывает pf2e (rules предмета), их не считаем
const PASSIVE = /@UUID\[Compendium\.pf2e\.equipment-effects|\bAfter (?:you )?cast(?:ing)?\b[^.]*\bActivat|\bonce per\b[^.]*@UUID\[Compendium\.pf2e\.conditionitems|@UUID\[Compendium\.pf2e\.conditionitems[^.]*\bonce per\b/i;
const SHARED_FREQ = /\bcounts? against the frequency\b|\bfrequency for (?:both|each|all)\b/i;
/** Куски текста вне блоков Activate. */
const outsideOf = (html, acts) => acts.reduce((r, a) => r.replace(a.block, ""), html).split(/<\/p>|<hr|<h\d/i);

/** Заклинание названо, но без ссылки («You cast enfeeble.») -> ссылка на единственное заклинание spells-srd с таким именем. Только в Effect активации без ссылок на заклинания. */
export function linkSpells(html, byName) {
  const re = /\b(casts?|casting|effects? of)\s+(?:an?\s+|the\s+)?((?:\d+\w\w-rank\s+)?)([A-Za-z' ]+?)(?=(?:\s+spell)?(?:[.;<]|$|\s+(?:on|with|at|to|for)\b))/;
  return html.replace(/(<strong>\s*Effect\s*<\/strong>)([\s\S]*?)(?=<hr|$)/gi, (all, head, eff) => {
    if (eff.includes(".spells-srd.Item.") || sentencesOf(castProse(eff)).filter(Boolean).length > 1) return all;   // имя без ссылки доверяем только когда в Effect одно предложение: хвост не проверить
    const m = re.exec(eff), uuids = m && byName.get(m[3].toLowerCase());
    return uuids?.length === 1 ? head + eff.slice(0, m.index) + `${m[1]} ${m[2]}@UUID[${uuids[0]}]{${m[3]}}` + eff.slice(m.index + m[0].length) : all;
  });
}

/**
 * Собранное правило против текста -> [расхождения]. Проверка ширше вывода: ВСЕ активации предмета (без cast-а — долг), весь текст блока (лишнее после сотворения — долг),
 * все числа СЛ/атаки/противодействия текста (чужих и не взятых не должно быть). spellDefs: {uuid: {cantrip}}.
 */
export function checkCast(rule, html, refs, spellDefs = {}, { partial = false } = {}) {
  const v = validateRule(rule);
  if (!v.ok) return [`validateRule: ${v.errors.map(String).join("; ").slice(0, 100)}`];
  if (!roundTrip(v.rule)) return ["roundTrip"];
  const bad = semanticErrors(rule, refs, html).map((e) => `semantic: ${String(e).slice(0, 80)}`);
  const all = castProse(html), own = (s) => /\b(?:you|those)\b[^.]*\bmust\b/i.test(s);   // «You … must succeed at a …» — испытание самого владельца, не СЛ заклинания
  const sents = (t) => t.split(/(?<=[.!?])\s+/).filter((s) => !own(s));
  const nums = (re, t) => new Set(sents(t).flatMap((s) => [...s.matchAll(re)].map((m) => +(m[1] ?? m[2]))));
  const all_ = activations(html), els = activateOf(rule) ?? [], acts = partial ? castActs(all_) : all_;   // partial: остальные активации — ручные, правило их не касается
  if (acts.length !== els.length) return [...bad, `activations ${partial ? acts.length : all_.length} != cast ${els.length}`];
  // «ручной» — только текст без заклинания; активация с другим заклинанием — вторая кастовая или долг
  if (partial) all_.filter((a) => !acts.includes(a) && a.links.length).forEach((a) => bad.push(`activation ${all_.indexOf(a) + 1}: another activation names ${a.links.length} spell(s), cast not derived`));
  const itemSpellDc = nums(/\bspell DC\b[^.]{0,80}?(\d+)|\bDC of (?:any|all|each) spells?[^.]{0,80}?(\d+)/gi, all), attacks = nums(/\bspell attack\b[^.]{0,80}?\+(\d+)/gi, all);
  const held = /\bmust be held\b/i.test(all) ? "held" : undefined;
  acts.forEach((a, i) => {
    const c = els[i], n = `activation ${i + 1}`, text = castProse(a.eff);
    if (a.links.length !== 1 || a.links[0] !== c.spell) return bad.push(`${n}: ${a.links.length ? "spell differs" : "no spell link"}`);
    // «gain the effects of X» — каст, только если срока в тексте нет (решение 6 plan-activate.md)
    if (!/\bcast(?:s|ing)?\b/.test(text)) {
      if (!/\beffects? of\b/.test(text)) bad.push(`${n}: no cast word`);
      else if (OWN_DURATION.test(text)) bad.push(`${n}: effects of a spell with its own duration`);
    }
    if (CHOICE.test(a.eff)) bad.push(`${n}: choice between spells`);
    const ranks = [...text.matchAll(/(\d+)(?:st|nd|rd|th)[- ]rank/gi)].map((m) => +m[1]), rank = ranks[0] || undefined, half = /\b(?:one-)?half (?:of )?(?:its|your|the)\b/i.test(text);
    if (ranks.length > 1) bad.push(`${n}: several ranks in text`);
    if (half ? !spellDefs[c.spell]?.cantrip || c.rank != null : rank !== c.rank) bad.push(`${n}: rank ${c.rank} != text ${half ? "half level" : rank}`);
    if (HARD.test(a.eff)) bad.push(`${n}: extra effect after the cast`);
    else if (SOFT.test(a.eff)) bad.push(`${n}: aux text (also/instead/except/unlike)`);
    // хвост после ссылки: непустой — минимум low (полный текст в note); смена урона/атаки/срока — долг
    const tl = tailOf(a);
    if (tl.hard && !HARD.test(a.eff)) bad.push(`${n}: extra effect after the cast (tail: ${tl.tail.slice(0, 60)})`);
    else if (!tl.trivial && !SOFT.test(a.eff) && !HARD.test(a.eff)) bad.push(`${n}: aux text (tail after the cast)`);
    // @Check вне предложения с заклинанием и не владельца: допустим один — с СЛ правила (повтор СЛ приписью); остальное — лишнее после сотворения
    const foreign = a.eff.split(/(?<=[.!?])\s+|<\/p>/).filter((x) => !own(castProse(x)) && !x.includes(c.spell)).flatMap((x) => [...x.matchAll(/@Check\[[^\]]*\]/g)].map((m) => m[0]));
    if (foreign.length > (c.dc != null && foreign.some((x) => new RegExp(`\\bdc:${c.dc}\\b`).test(x)) ? 1 : 0)) bad.push(`${n}: extra check/damage after the cast`);
    const dcs = new Set([...nums(/\bdc:(\d+)/g, a.eff), ...nums(/\bDC (?:of )?(\d+)/gi, text), ...itemSpellDc]);
    if (c.dc == null ? dcs.size : !dcs.has(c.dc) || dcs.size > 1) bad.push(`${n}: dc ${c.dc} != text ${[...dcs]}`);
    if (c.attack == null ? attacks.size : !attacks.has(c.attack) || attacks.size > 1) bad.push(`${n}: attack ${c.attack} != text ${[...attacks]}`);
    const cs = nums(/\bcounteract (?:check|modifier)\b[^.]{0,30}?\+(\d+)/gi, all);
    if (c.counteract == null ? cs.size : !cs.has(c.counteract)) bad.push(`${n}: counteract ${c.counteract} != text ${[...cs]}`);
    const f = frequencyOf(/<strong>\s*Frequency\s*<\/strong>([^<]*)/i.exec(a.block)?.[1]) ?? frequencyOf(castProse(a.block));
    const ft = /<strong>\s*Frequency\s*<\/strong>([^<]*)/i.exec(a.block)?.[1]?.trim();   // текст частоты есть, а разобрать не вышло («once per month») — лимит потерян
    if (ft && !f && !/any number/i.test(ft)) bad.push(`${n}: unparsed frequency "${ft.slice(0, 40)}"`);
    if (JSON.stringify(f) !== JSON.stringify(c.per ?? null)) bad.push(`${n}: per ${JSON.stringify(c.per)} != text ${JSON.stringify(f)}`);
    if (c.requires !== held) bad.push(`${n}: requires ${c.requires} != text ${held}`);
  });
  return bad;
}

/**
 * NPC-способность без «Activate»: «can cast X at will» / «has the effects of X» -> {cast:[…], aux} | null. Имя -> единственный uuid spells-srd; СЛ — @Check с числом или «high spell DC» ({level:"high"});
 * aux — остальные предложения текста (ложатся в note, правило low).
 */
export function deriveAction(html, byName) {
  const text = castProse(html);
  const m = /\bcasts? ([A-Z][A-Za-z' ]+?)(?: spell)? at will(?: as an? [a-z]+ innate spell)?(?=[.,;])/.exec(text) ?? /\bhas the effects? of (?:an? |the )?(?:(\d+)(?:st|nd|rd|th)-rank )?([A-Z][A-Za-z' ]+?) spell(?=\s*(?:\(|\.|$))/.exec(text);
  if (!m) return null;
  const name = m[2] ?? m[1], rank = m[2] ? +m[1] || undefined : undefined, uuids = byName.get(name.toLowerCase());
  if (uuids?.length !== 1) return null;
  const dc = +/@Check\[[^\]]*\bdc:(\d+)/.exec(text)?.[1] || (/\bhigh (?:spell )?DC\b/i.test(text) ? { level: "high" } : undefined), slug = sluggify(name);
  const aux = sentencesOf(text).filter((s) => !s.includes(m[0])).join(" ").trim();
  return { cast: [{ id: slug, spell: uuids[0], ...(rank && { rank }), ...(dc && { dc }) }], aux };
}
const sluggify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Правило действия NPC -> [расхождения]: validateRule, roundTrip, семантика, СЛ из текста; вспомогательные предложения -> «aux text» (note, low). html — исходный (uuid в тексте не нужен: имя уже привязано). */
export function checkAction(rule, refs, html, aux) {
  const v = validateRule(rule);
  if (!v.ok) return [`validateRule: ${v.errors.map(String).join("; ").slice(0, 100)}`];
  if (!roundTrip(v.rule)) return ["roundTrip"];
  const c = activateOf(rule)[0], linked = html.replace(/\b(casts?|effects? of)\b/, `$& @UUID[${c.spell}]{x} `);   // semanticErrors: uuid заклинания должен быть в тексте
  const bad = semanticErrors(rule, refs, linked).map((e) => `semantic: ${String(e).slice(0, 80)}`);
  const text = castProse(html), dcs = [...text.matchAll(/@Check\[[^\]]*\bdc:(\d+)/g)].map((m) => +m[1]);
  if (c.dc != null && typeof c.dc === "number" && dcs.some((x) => x !== c.dc)) bad.push(`dc ${c.dc} != text ${dcs}`);
  // остаток текста: побочная механика (иммунитет, урон, бонус) — долг «extra effect» (каст + добавка), прочее — note, low
  if (aux) bad.push(HARD.test(aux) ? "extra effect after the cast (rest of the ability text)" : "aux text (rest of the ability text)");
  return bad;
}

const CAST_A_SPELL = /\bActivate\b[^.]{0,40}\bCast a Spell\b/;   // заголовок активации, а не «when the creature attempts to Cast a Spell»
/** Честная причина, почему текст без вывода cast: вместо устаревшей метки «cast a spell activation». */
export function whyNoCast(html) {
  const t = castProse(html);
  if (CAST_A_SPELL.test(t) && /\bcharges?\b/i.test(t)) return "spell list with charges (staff)";
  if (/\bcasts?\b[^.]*\bor\b|\byour choice\b|\binstead\b[^.]*\bcast\b/.test(t)) return "choice between spells";
  if (CAST_A_SPELL.test(t)) return "spell chosen from a list";
  if (/\b(?:functions as|effects? of)\b/.test(t) && /\bexcept\b|\binstead\b/.test(t)) return "effects of a spell with changes";
  return "activation without a spell (own mechanic)";
}

const capNote = (parts) => {   // только по границе предложения: хвост не теряем, но и note не бесконечный
  const out = [];
  for (const s of parts.flatMap(sentencesOf).filter(Boolean)) { if (out.join(" ").length + s.length > 600 && out.length) break; out.push(s); }
  return out.join(" ");
};

/**
 * Один документ -> {kind, entry}: ok (чисто), partial (правило закрывает не всё: перечень в `partial`), low (хвост/вспомогательный текст в note, ждёт Критика), debt, stale (наше правило, вывод пуст) | null (не трогаем).
 * it — документ items.json, tr — триаж, a — принятая запись, h0 — html. ctx: {spellDefs, byName, refs}.
 */
export function route(it, tr, a, h0, { spellDefs, byName, refs }) {
  if (!h0 || it.type === "consumable" || !OPEN.has(tr.status) || tr.rule) return null;
  const h = linkSpells(h0, byName), act = it.type === "action" && !/<strong>\s*Activate\b/i.test(h);
  const dc = act ? deriveAction(h, byName) : deriveCast(h, { spellDefs });
  const ours = a?.reason?.startsWith(CONV) || a?.reason?.includes("missing: cast:"), oldDebt = a?.confidence === "needs-primitive" && !ours && OLD_DEBT.test(a.reason);
  const nullCast = a && !a.rule && a.reason?.startsWith("model-null") && /cast/i.test(a.reason);
  if (a && !ours && !oldDebt && !nullCast) return null;   // готовое правило и прочий долг не трогаем
  const d = { uuid: it.uuid, slug: it.slug, type: it.type, name: it.name, nameRu: it.nameRu, layer: tr.layer, batch: tr.batchName, dupCount: it.dupCount };
  const manual = (why) => ({ kind: "debt", entry: { ...d, status: "manual", confidence: "needs-primitive", reason: `needs-primitive: missing: cast: ${why}`, rule: null } });
  if (!dc) {
    if (a?.reason?.startsWith(CONV)) return { kind: "stale", entry: d };
    return oldDebt || a?.reason?.includes("missing: cast:") ? manual(whyNoCast(h)) : null;   // устаревшая метка «cast a spell activation» и причина прежней версии вывода -> честная причина
  }
  const rule = { v: RULE_VERSION, ...(it.name && { label: it.name }), activate: dc.cast };
  const acts = act ? [] : activations(h), cs = castActs(acts), outside = act ? [] : outsideOf(h0, acts);
  const bad = act ? checkAction(rule, refs, h0, dc.aux) : checkCast(rule, h, refs, spellDefs, { partial: true });
  if (outside.some((s) => SHARED_FREQ.test(s))) bad.unshift("frequency is shared with other items (text outside the activations)");
  const hard = bad.filter((x) => !/aux text/.test(x));
  if (hard.length) return nullCast ? null : manual(hard[0]);   // model-null — прежнее решение остаётся
  if (nullCast && bad.length) return null;
  // что правило не закрывает: текстовые активации без заклинания и пассивная механика вне блоков Activate
  const gaps = [...acts.flatMap((x, i) => (cs.includes(x) ? [] : [`activation ${i + 1}: ${whyNoCast(x.block)}`])),
    ...outside.filter((s) => PASSIVE.test(s)).map((s) => `text outside the activations: ${readable(s).slice(0, 80)}`)];
  const part = gaps.length ? { partial: gaps } : {};
  if (bad.length) {   // вспомогательный текст/хвост: note у записи, правило ждёт выборки Критика
    const withNote = { ...rule, activate: rule.activate.map((c, i) => {
      if (act) return dc.aux ? { ...c, note: capNote([readable(dc.aux)]) } : c;
      const { full, trivial } = tailOf(cs[i]), soft = sentencesOf(readable(cs[i].eff)).filter((x) => SOFT.test(x) && !full.includes(x));
      const note = capNote([...soft, ...(trivial && !SOFT.test(full) ? [] : [full])]);
      return note ? { ...c, note } : c;
    }) };
    const v = validateRule(withNote);
    if (!v.ok) return manual(`validateRule: ${v.errors.map(String).join("; ").slice(0, 100)}`);
    return { kind: "low", entry: { ...d, status: "manual", confidence: "low", ...part, reason: CONV_LOW, rule: v.rule } };
  }
  return gaps.length ? { kind: "partial", entry: { ...d, status: "manual", confidence: "model", ...part, reason: CONV_PARTIAL, rule: validateRule(rule).rule } }
    : { kind: "ok", entry: { ...d, status: "manual", confidence: "model", reason: CONV, rule: validateRule(rule).rule } };
}

export function buildBatch() {
  const html = readOut("html.json"), { items } = readOut("items.json"), refs = readOut("refs.json"), tri = new Map(readOut("triage.json").items.map((t) => [t.uuid, t]));
  const acc = new Map(readModelAccepted().map((d) => [d.uuid, d]));
  const spellDefs = Object.fromEntries(items.filter((i) => i.pack === "spells-srd").map((i) => [i.uuid, { slug: i.slug, save: !!i.defense?.save, attack: /\bspell attack\b/i.test(i.descEn ?? ""), cantrip: (i.traits ?? []).includes("cantrip") }]));
  const byName = new Map();
  for (const i of items) if (i.pack === "spells-srd") byName.set(i.name.toLowerCase(), [...(byName.get(i.name.toLowerCase()) ?? []), i.uuid]);
  const out = { ok: [], partial: [], low: [], debt: [] }, stale = new Set();   // stale: наше правило, а вывод теперь пуст (активация кончилась на <hr>) — снимается
  for (const it of items) {
    const r = route(it, tri.get(it.uuid), acc.get(it.uuid), html[it.uuid], { spellDefs, byName, refs });
    if (r?.kind === "stale") stale.add(it.uuid);
    else if (r) out[r.kind].push(r.entry);
  }
  return { ...out, stale, html, items };
}

function main() {
  const { ok, partial, low, debt, stale, html } = buildBatch();
  const cat = {};
  for (const d of debt) {
    const k = d.reason.replace(/^needs-primitive: missing: cast: /, "").replace(/activation \d+: /, "").replace(/(\d+|\{[^}]*\}|undefined|null)/g, "#").slice(0, 45);
    cat[k] = (cat[k] ?? 0) + 1;
  }
  const weight = (l) => l.reduce((s, d) => s + d.dupCount, 0);
  console.log(`catalog ${ok.length + partial.length} (clean ${ok.length}, partial ${partial.length}; copies ${weight(ok) + weight(partial)}); low (not in catalog) ${low.length}; debt ${debt.length} (copies ${weight(debt)}); by reason`, cat);
  const strip = ({ batch, dupCount, ...d }) => d;
  if (process.argv.includes("--write")) {
    for (const p of readdirSync(ACCEPTED).filter((n) => n.endsWith(".json"))) {   // снять устаревшие правила
      const path = join(ACCEPTED, p), ex = readJson(path), items = (ex.items ?? []).filter((d) => !stale.has(d.uuid));
      if (ex.items && items.length !== ex.items.length) writeText(path, serializeDrafts(ex.meta, items));
    }
    const by = {};
    for (const d of [...ok, ...partial, ...low, ...debt]) (by[d.batch] ??= []).push(strip(d));
    for (const [batch, list] of Object.entries(by)) {
      const p = join(ACCEPTED, `${batch}.json`);
      let ex = null; try { ex = readJson(p); } catch {}
      const meta = { batch, pf2eVersion: readOut("items.json").meta.pf2eVersion };
      writeText(p, serializeDrafts(meta, mergeAccepted(ex, list, meta).items));
    }
    console.log("written:", Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])));
  }
  if (process.argv.includes("--sample")) {
    const seed = +arg("seed", 20261025), n = 50, top = [...ok, ...partial].sort((a, b) => b.dupCount - a.dupCount || cmp(a.uuid, b.uuid)).slice(0, 25);
    const rest = pick([...ok, ...partial].filter((d) => !top.includes(d)), n - top.length, seed);
    const out = { seed, note: `first ${top.length} by dupCount desc, then ${rest.length} random (mulberry32 seed ${seed}) of ${ok.length}`, items: [...top, ...rest].map((d) => ({ uuid: d.uuid, name: d.name, dupCount: d.dupCount, textEn: stripHtml(html[d.uuid]), rule: d.rule })) };
    writeFileSync(arg("out"), JSON.stringify(out, null, 1));
    console.log("sample ->", arg("out"));
  }
}
if (isMain(import.meta.url)) main();
