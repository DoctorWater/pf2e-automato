// items.json -> triage.json: слой (ROADMAP §2; pf2e-automations — НЕ слой 1, а очередь переноса pa-port), статус, пачка (§5), приоритет (§4), выведенное правило.
import { stripHtml, readJson, readOut, writeJson, outPath, ROOT, AUTOMATIONS_CONFIG, isMain } from "./lib.mjs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { deriveFromMarkup, buildCatalog, activateOf } from "../scripts/rules.mjs";
import { buildAutomationsIndex, groupsCovering } from "../scripts/compat.mjs";

export const BATCHES = {
  1: "b01-save-conditions", 2: "b02-self-ally-effects", 3: "b03-attack-check", 4: "b04-reactions", 5: "b05-persistent-escape",
  6: "b06-zones-auras", 7: "b07-metamagic-next", 8: "b08-consumables", 9: "b09-npc", 10: "b10-rest"
};

const COND_OR_EFFECT = /@UUID\[Compendium\.pf2e\.(?:conditionitems|[a-z-]*effects)\./;
const DURATION = /\bfor\s+\d+\s*(?:round|minute|hour|day)|\buntil the (?:start|end) of\b|\bsustain/i;
const SAVE_CHECK = /@Check\[(?:fortitude|reflex|will)\b/;
const COND_LINK = /@UUID\[Compendium\.pf2e\.(?:conditionitems|[a-z-]*effects)\./;   // состояние или эффект (Heat Surge, Infernal Wound)
const CAMPAIGN_PACKS = new Set(["kingmaker-features", "adventure-specific-actions", "pathfinder-society-boons", "boons-and-curses", "campaign-effects"]);

/** Какие виды следа (E/S/Z/R, методика coverage.md §0) есть у документа. */
export function traceOf(it, html) {
  const h = html ?? "";
  const E = COND_OR_EFFECT.test(h) || !!it.duration || DURATION.test(h);
  const S = /@Check\[/.test(h) || !!it.defense;
  const Z = /@Template\[/.test(h) || !!it.area;
  const R = it.actionType === "reaction" || /<strong>\s*Trigger/i.test(h);
  return { E, S, Z, R, any: E || S || Z || R };
}

export function isActive(it, html) {
  const t = it.type;
  const h = html ?? "";
  if (t === "melee") return /@UUID\[|@Check\[/.test(h);   // «Захват», «Яд» без разметки — нечего автоматизировать
  if (t === "spell" || t === "consumable") return true;
  if (t === "action" || t === "feat" || t === "campaignFeature") {
    // пассивное с спасброском или (у NPC) состоянием — это «при попадании / при смерти / в ауре», а не пассив
    return ["action", "reaction", "free"].includes(it.actionType) || it.traits.includes("aura") || !!it.frequency
      || SAVE_CHECK.test(h) || (!!it.embedded && COND_LINK.test(h));
  }
  return /\bActivate\b/.test(html ?? "") || it.traits.includes("aura");
}

/** Пачка по механике (первая подходящая). */
export function batchOf(it, html, trace) {
  const h = html ?? "";
  if (it.embedded) return 9;
  if (it.type === "consumable") return 8;
  if (trace.R) return 4;
  if (it.traits.some((x) => x === "spellshape" || x === "metamagic") || /\byour next (?:Strike|spell|Cast|action|attack)/i.test(h)) return 7;
  // мгновенный спасбросок по области (без длительности) — обычное «состояние по испытанию», не зона
  if (trace.Z && !it.traits.includes("aura") && (it.defense || SAVE_CHECK.test(h)) && !it.duration && !DURATION.test(h)) return 1;
  if (trace.Z || it.traits.includes("aura")) return 6;
  if (it.defense || /@Check\[(?:fortitude|reflex|will)\b/.test(h)) return 1;
  if (/@Check\[/.test(h) || /spell attack roll|against (?:the target's |its )?(?:AC|Perception DC|Will DC|Reflex DC|Fortitude DC)/i.test(h)) return 3;
  if (/persistent damage|\bEscape\b|\bgrabbed\b|\brestrained\b/i.test(h)) return 5;
  if (trace.E) return 2;
  return 10;
}

/** Приоритет §4: 1 — частое (базовые действия, заклинания 0–5, расходники, общие/навыковые/классовые черты), 2 — остальной компендий, 3 — NPC, 4 — кампании. */
export function priorityOf(it) {
  if (it.embedded) return 3;
  if (it.type === "campaignFeature" || CAMPAIGN_PACKS.has(it.pack)) return 4;
  if (it.pack === "actionspf2e" || it.type === "consumable") return 1;
  if (it.type === "spell") return it.rank <= 5 ? 1 : 2;
  if (it.type === "feat" && ["general", "skill", "class"].includes(it.category)) return 1;
  return 2;
}

/** Контекст (индексы справочников) для triageItem. */
export function makeContext({ refs, catalogJsons = [], automationsRules = null, labels, items = [] }) {
  const condById = new Map(), condNames = [];
  for (const [slug, c] of Object.entries(refs.conditions)) {
    condById.set(c.id, slug);
    condNames.push([slug.replace(/-/g, " "), slug], [c.name, slug]);
    if (c.nameRu) condNames.push([c.nameRu, slug]);
  }
  const catalog = buildCatalog(catalogJsons);
  // образец slug-записи каталога: документ с этим slug, на который есть bySource, иначе первый в порядке паков
  const slugKind = new Map(), PREF = ["actionspf2e", "feats-srd", "spells-srd", "equipment-srd"];
  for (const it of items) {
    if (it.embedded || !catalog.bySlug.has(it.slug)) continue;
    const cur = slugKind.get(it.slug), rank = (catalog.bySource.has(it.uuid) ? 0 : 10) + (PREF.indexOf(it.pack) < 0 ? 9 : PREF.indexOf(it.pack));
    if (!cur || rank < cur.rank) slugKind.set(it.slug, { type: it.type, pack: it.pack, rank });
  }
  return {
    labels, slugKind,
    condSlugByUuid: (u) => (u.includes(".conditionitems.") ? condById.get(u.split(".").pop()) ?? null : null),
    condNames,
    catalog,
    automations: buildAutomationsIndex(automationsRules)
  };
}

const OTHER_LINKS = /@UUID\[(Compendium\.pf2e\.[a-z0-9-]+\.Item\.\w+)\]/g;
const PART_WORDS = /\b(?:allys?|allies|enem(?:y|ies)|aura|targets?)\b/i;
/** selfEffect закрыл не всё: в тексте есть ссылки кроме самого эффекта либо слова про союзника, врага, ауру, цель. */
export function partOnly(it, html) {
  const h = html ?? "";
  for (const m of h.matchAll(OTHER_LINKS)) if (m[1] !== it.selfEffect) return true;
  return PART_WORDS.test(stripHtml(h));
}

/** Совпадение с каталогом по slug — только для того же типа и пака, что у документа-образца; встроенные NPC по slug не совпадают. */
export function slugMatches(it, ctx) {
  if (it.embedded) return false;
  const k = ctx.slugKind?.get(it.slug);
  return !k || (k.type === it.type && k.pack === it.pack);
}

const sourceUuidOf = (it) => (it.embedded ? it.source : it.uuid);
const asLike = (it, html) => ({
  type: it.type, slug: it.slug, name: it.name,
  system: {
    description: { value: html }, defense: it.defense ? { save: { statistic: it.defense.save, basic: it.defense.basic } } : undefined,
    area: it.area ? { type: it.area } : undefined, target: it.target ?? undefined, selfEffect: it.selfEffect ? { uuid: it.selfEffect } : undefined,
    duration: it.duration ? { value: it.duration.replace(/^sustained\s*/, ""), sustained: it.duration.startsWith("sustained") } : undefined,
    actionType: { value: it.actionType }, traits: { value: it.traits }, category: it.category
  }
});

/** Шагов в правиле: apply + степени challenge/check + зона. 0 = правило ничего не делает (промах вывода). */
export const stepCount = (r) => {
  const u = r?.onUse;
  if (!u) return r?.onAttacked || r?.macros?.length || r?.onEvent?.length || activateOf(r)?.length ? 1 : 0;
  const deg = (c) => Object.values(c?.byDegree ?? {}).reduce((n, l) => n + l.length, 0);
  return (u.apply?.length ?? 0) + deg(u.challenge) + deg(u.check) + (u.zone ? 1 : 0) + (activateOf(r)?.length ?? 0);
};

const ruleKind = (r) => (r.onUse?.challenge ? "challenge" : r.onUse?.zone ? "zone" : r.onUse?.apply?.length ? `apply:${r.onUse.targets}` : r.onAttacked ? "react" : "other");

/** -> { status, layer, confidence, reason, rule, batch, batchName, priority } */
export function triageItem(it, html, ctx) {
  const priority = priorityOf(it);
  const done = (status, layer, reason, extra = {}) => ({ status, layer, confidence: null, reason, rule: null, batch: null, batchName: null, priority, ...extra });
  if (it.dupTop) return done("skip", null, `dup-top:${it.dupTop}`);
  const trace = traceOf(it, html), active = isActive(it, html);
  const batch = batchOf(it, html, trace);
  const withBatch = { batch, batchName: BATCHES[batch] };

  let selfNote = "";
  if (active && trace.any) {
    const onlyE = !trace.S && !trace.Z && !trace.R;
    if (["action", "feat"].includes(it.type) && it.selfEffect && onlyE) {
      // selfEffect закрывает только «эффект на себя»; другие ссылки или слова про союзника/врага/ауру/цель — остальное ещё не закрыто
      if (!partOnly(it, html)) return done("pf2e", 1, "selfEffect", withBatch);
      selfNote = "часть на себя закрыта selfEffect; ";
    } else if (it.auraEffects && !trace.S && !trace.R) return done("pf2e", 1, "Aura RE", withBatch);
  }
  const cat = ctx.catalog;
  const inCat = cat.bySource.get(it.uuid) ?? (it.source && cat.bySource.get(it.source)) ?? (slugMatches(it, ctx) && cat.bySlug.get(it.slug)) ?? cat.byName.get(it.name) ?? (it.nameRu && cat.byName.get(it.nameRu));
  if (inCat) return done("catalog", inCat.macros?.some((m) => m.builtin) ? 4 : 3, "catalog", withBatch);
  const groups = groupsCovering(ctx.automations, { slug: it.slug, sourceUuid: sourceUuidOf(it) });
  if (groups.length) return done("pa-port", 3, groups.slice(0, 3).join("; "), withBatch);
  if (!active) return done("skip", null, "passive");
  if (!trace.any) return done("skip", null, /@Damage|\[\[\/r/.test(html ?? "") ? "damage-only" : "no-trace");
  if (trace.S && !trace.E && !trace.Z && !trace.R && it.defense?.basic && !COND_OR_EFFECT.test(html ?? "")) return done("skip", null, "damage-only");

  const d = deriveFromMarkup(asLike(it, html), ctx.labels, ctx.condSlugByUuid, ctx.condNames);
  // испытание без шагов, но с подсказками (выбор, условие): карточка всё равно показывает спасбросок, состояния — призраками для ГМа
  // испытание после Удара: рантайм его не использует; долг «нужен примитив» (модель правило напишет, validate пометит needs-primitive)
  if (d?.strikeGate) return done("manual", 3, `${selfNote}needs-primitive: strike-gate`, withBatch);
  if (d && !stepCount(d.rule) && !(d.rule.onUse?.challenge && d.hints.possible.length)) return done("manual", 3, `${selfNote}derive-empty:${ruleKind(d.rule)}; hints=${[...d.hints.possible, ...d.hints.unresolved].join(",")}`, withBatch);
  if (d) {
    const h = d.hints;
    const note = ["possible", "unresolved", "excluded", "lowWhy"].filter((k) => h[k].length).map((k) => `${k}=${h[k].join(",")}`).join("; ");
    // испытание без шагов (только голова + подсказки): в рантайме правило работает, но автоматизацией не считается
    const head = !stepCount(d.rule);
    return { status: head ? "markup-head" : `markup-${d.confidence}`, layer: 2, confidence: d.confidence, reason: `${selfNote}${ruleKind(d.rule)}${note ? "; " + note : ""}`, rule: d.rule, ...withBatch, priority };
  }
  return done("manual", 3, `${selfNote}trace=${["E", "S", "Z", "R"].filter((k) => trace[k]).join("")}`, withBatch);
}

function main() {
  const t0 = Date.now();
  const { meta, items } = readOut("items.json");
  const html = readOut("html.json"), refs = readOut("refs.json");
  const catalogJsons = ["catalog.json", "catalog.campaign.json"].map((f) => readJson(join(ROOT, "rules", f)));
  const ar = existsSync(AUTOMATIONS_CONFIG) ? readJson(AUTOMATIONS_CONFIG).groups : null;
  const ctx = makeContext({ refs, catalogJsons, automationsRules: ar, labels: readJson(join(ROOT, "rules/labels.json")), items });
  const out = items.map((it) => ({ uuid: it.uuid, ...triageItem(it, html[it.uuid], ctx) }));
  const counts = {};
  for (const r of out) counts[r.status] = (counts[r.status] ?? 0) + 1;
  writeJson(outPath("triage.json"), { meta: { pf2eVersion: meta.pf2eVersion, triagedAt: new Date().toISOString(), automationsGroups: ctx.automations.length, counts }, items: out });
  console.log(`triage: ${out.length}, ${((Date.now() - t0) / 1000).toFixed(1)} c`, counts);
}

if (isMain(import.meta.url)) main();
