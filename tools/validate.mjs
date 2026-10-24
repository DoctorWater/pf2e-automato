// Ответ агента (JSON-массив {uuid, rule|null, unsure, note}) -> валидация -> принятые в rules/drafts-accepted, очереди повтора и Sonnet.
// Запуск: node tools/validate.mjs <ответ.json> <batch> [--input tools/out/haiku/<batch>-NN.md] [--final]
// --final — ответы последней ступени (Sonnet): unsure не уходит дальше, а принимается долгом needs-primitive с правилом-догадкой.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ROOT, ACCEPTED, serializeDrafts, readJson, readOut, writeJson, writeText, outPath, arg, cmp, isMain } from "./lib.mjs";
import { validateRule, enemiesOnly, strikeGate, setWho } from "../scripts/rules.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { BUILTIN } from "../scripts/builtin/index.mjs";
import { stepCount } from "./triage.mjs";
import { gateToEvent, hasCard, multiStrike } from "./strike-gate.mjs";

const en = { ...readJson(join(ROOT, "lang/en/rules.json")).PF2E_AUTOMATO.rules.err, ...readJson(join(ROOT, "lang/en/events.json")).PF2E_AUTOMATO.rules.err };   // ошибки onEvent (ev.*) и cast — в events.json
const fmtErr = (e) => {
  const tpl = e.key.split(".").reduce((o, k) => o?.[k], en);
  return typeof tpl === "string" ? tpl.replace(/\{(\w+)\}/g, (_, k) => e.data?.[k] ?? "") : String(e);
};

export const SAVES = ["fortitude", "reflex", "will"];
export const SKILLS = ["acrobatics", "arcana", "athletics", "crafting", "deception", "diplomacy", "intimidation", "medicine", "nature", "occultism", "performance", "religion", "society", "stealth", "survival", "thievery"];
const CHECK_STATS = new Set([...SKILLS, "perception", "spell-attack", "attack"]);
// автор: СЛ «заклинания» / «класса» / навыка (saves.mjs resolveDC); цель: любая её статистика (checks.mjs)
// слаг класса (kineticist, commander…) — СЛ этого класса: getStatistic(slug) у pf2e отдаёт classDCs (архетип — не основной класс)
export const CLASSES = ["alchemist", "animist", "barbarian", "bard", "champion", "cleric", "commander", "druid", "exemplar", "fighter", "guardian", "gunslinger", "inventor", "investigator", "kineticist", "magus", "monk", "oracle", "psychic", "ranger", "rogue", "runesmith", "sorcerer", "summoner", "swashbuckler", "thaumaturge", "witch", "wizard"];
const DC_AGAINST = new Set(["spell", "class", "class-spell", "perception", ...SKILLS, ...CLASSES]);
const VS_AGAINST = new Set([...SAVES, "perception", ...SKILLS]);
const isLore = (s) => /^[a-z0-9-]+-lore$/.test(s) || s === "lore";

/** Правило -> форма -> правило без потерь. */
export function roundTrip(rule) {
  const back = validateRule(formToRule(ruleToForm(rule)));
  return back.ok && isDeepStrictEqual(back.rule, rule);
}

/** Ключи сырого ответа, которых нет в нормализованном правиле (validateRule молча выбрасывает лишнее). Пустое/null — как значение по умолчанию. */
export function extraKeys(raw, norm, path = "") {
  const out = [];
  if (Array.isArray(raw)) { raw.forEach((x, i) => out.push(...extraKeys(x, norm?.[i], `${path}[${i}]`))); return out; }
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (v == null || (Array.isArray(v) && !v.length)) continue;
      if (!norm || typeof norm !== "object" || !(k in norm)) out.push(`${path}.${k}`);
      else out.push(...extraKeys(v, norm[k], `${path}.${k}`));
    }
  }
  return out;
}

const stepsOf = (rule) => [...(rule.onUse?.apply ?? []), ...Object.values(rule.onUse?.challenge?.byDegree ?? {}).flat(), ...Object.values(rule.onUse?.check?.byDegree ?? {}).flat(),
  ...(rule.onEvent ?? []).flatMap((e) => [...(e.apply ?? []), ...Object.values(e.challenge?.byDegree ?? {}).flat()]),
  ...(rule.onUse?.zone?.triggers ?? []).flatMap((e) => [...(e.apply ?? []), ...Object.values(e.challenge?.byDegree ?? {}).flat()])];

/** Одни заметки ведущему (без иммунитета, зоны, событий): либо сюжет (автоматизировать нечего), либо механика без примитива (толчок, штраф без эффекта). Не skip: очередь «нужен примитив», в рантайм не идёт (решение пользователя 2026-10-24). */
export const notesOnly = (rule) => {
  const u = rule.onUse, s = stepsOf(rule);
  return s.length > 0 && s.every((x) => x.note) && !rule.cast?.length && !u?.challenge?.immunity && !u?.check?.immunity && !u?.zone && !(rule.onEvent ?? []).some((e) => e.challenge?.immunity) && !rule.onAttacked && !rule.macros?.length;
};

/** Содержательные проверки: ссылки существуют (и есть в тексте предмета), статистики из известных списков, builtin есть в реестре. html === null — не проверять текст. */
export function semanticErrors(rule, refs, html = null) {
  const bad = [];
  const u = rule.onUse;
  if (!stepCount(rule)) bad.push("the rule has no steps: it does nothing; answer null if there is nothing to automate");
  for (const s of stepsOf(rule)) {
    if (s.condition && !refs.conditions[s.condition.slug]) bad.push(`condition "${s.condition.slug}" does not exist in pf2e`);
    if (s.removeCondition && !refs.conditions[s.removeCondition.slug]) bad.push(`condition "${s.removeCondition.slug}" does not exist in pf2e`);
    if (s.repeat?.statistic && !SAVES.includes(s.repeat.statistic)) bad.push(`repeat.statistic must be fortitude, reflex or will (got "${s.repeat.statistic}")`);
    for (const x of [s.effect?.uuid, s.unlessEffect]) if (x && !refs.effects[x]) bad.push(`effect ${x} not found: copy the UUID exactly from the item text`);
    for (const x of [s.effect?.uuid, s.unlessEffect]) if (x && html !== null && !html.includes(x)) bad.push(`effect ${x} is not mentioned in this item's text: use only effects linked in the text`);
  }
  for (const c of rule.cast ?? []) if (html !== null && !html.includes(c.spell)) bad.push(`cast spell ${c.spell} is not mentioned in this item's text: copy the spell UUID from the \`You cast\` link`);
  for (const e of rule.onEvent ?? []) if (e.aura && !/^[a-z0-9-]+$/.test(e.aura)) bad.push(`onEvent aura "${e.aura}" must be the slug of a pf2e Aura rule element (lowercase, dashes); if you do not know it use "range" in feet`);
  const z = u?.zone;
  if (z?.condition && !refs.conditions[z.condition.slug]) bad.push(`zone condition "${z.condition.slug}" does not exist in pf2e`);
  if (z?.effect && !refs.effects[z.effect.uuid]) bad.push(`zone effect ${z.effect.uuid} not found`);
  if (z?.effect && html !== null && !html.includes(z.effect.uuid)) bad.push(`zone effect ${z.effect.uuid} is not mentioned in this item's text`);
  for (const c of [u?.challenge, ...(rule.onEvent ?? []).map((e) => e.challenge), ...(u?.zone?.triggers ?? []).map((t) => t.challenge)]) {
    if (!c) continue;
    if (!SAVES.includes(c.statistic)) bad.push(`challenge.statistic must be fortitude, reflex or will (got "${c.statistic}")`);
    if (c.dc.against && !DC_AGAINST.has(c.dc.against)) bad.push(`dc.against "${c.dc.against}" is unknown: use spell, class, class-spell, a class slug (kineticist…), perception or a skill`);
  }
  const k = u?.check;
  if (k) {
    for (const s of [k.statistic].flat()) if (!CHECK_STATS.has(s) && !isLore(s)) bad.push(`check.statistic "${s}" must be a skill, perception or spell-attack`);
    if (k.vs?.against && !VS_AGAINST.has(k.vs.against)) bad.push(`vs.against "${k.vs.against}" is unknown`);
  }
  for (const m of rule.macros ?? []) if (!m.builtin || !BUILTIN[m.builtin]) bad.push(`macro ${m.builtin ?? m.uuid} is not available: do not use macros`);
  return bad;
}

/**
 * Общие дефекты ответов моделей по тексту: «только враги» -> who:"enemy" шагам к цели; «испытание после Удара» -> gate
 * (испытание при использовании бросилось бы и при промахе: правило сохраняем, но в каталог рантайма оно не идёт). html пуст — не трогать.
 */
export function normalizeRule(rule, html, kind = null) {
  if (!html) return { rule, gate: false };
  let r = structuredClone(rule);
  if (enemiesOnly(html)) setWho(r.onUse, "enemy");
  r = gateToEvent(r, html, kind).rule;   // feat/action: испытание после Удара -> onEvent afterUse (tools/strike-gate.mjs); остальное (боеприпасы, бомбы) — долг
  return { rule: r, gate: !!r.onUse?.challenge && strikeGate(html) };
}

/** Один ответ агента -> { kind: "accepted"|"notes-only"|"needs-primitive"|"null"|"unsure"|"error", rule?, errors? }. */
export function checkAnswer(ans, refs, html = null, kind = null) {
  if (!ans || typeof ans.uuid !== "string" || !("rule" in ans)) return { kind: "error", errors: ["answer must be {uuid, rule|null, unsure:bool, note}"] };
  if (ans.unsure === true) return { kind: "unsure", guess: ans.rule ?? null };
  if (ans.rule === null) return { kind: "null", note: ans.note ?? "" };
  const v = validateRule(ans.rule);
  if (!v.ok) return { kind: "error", errors: v.errors.map(fmtErr) };
  const extra = extraKeys(ans.rule, v.rule);
  if (extra.length) return { kind: "error", errors: [`unknown fields (not in the schema): ${extra.join(", ")}`] };
  const sem = semanticErrors(v.rule, refs, html);
  if (sem.length) return { kind: "error", errors: sem };
  if (!roundTrip(v.rule)) return { kind: "error", errors: ["rule does not survive the form round-trip: remove fields that are not in the schema"] };
  // событие «бросок атаки» на тексте «Make a Strike. If it hits…» без afterUse сработало бы на каждом попадании владельца
  if (html && hasCard(kind) && strikeGate(html) && !multiStrike(html) && v.rule.onEvent?.some((e) => ["attack-roll", "damage-roll"].includes(e.on) && !e.afterUse)) return { kind: "error", errors: ["the text is \"Make a Strike, then …\": an onEvent entry on attack-roll/damage-roll needs afterUse:true (or write a plain onUse.challenge and the tool will convert it)"] };
  const { rule, gate } = normalizeRule(v.rule, html, kind);
  if (notesOnly(rule)) return { kind: "notes-only", rule };
  return { kind: gate ? "needs-primitive" : "accepted", rule };
}

export const emptyState = () => ({ attempts: {}, retry: {}, sonnet: {} });

/**
 * Чистая часть. draftItems — черновики пачки (для имён и поиска), state копит попытки и очереди между вызовами,
 * opts: { htmlOf(uuid), expected: [uuid], final } — ожидаемые ответы (из файла-запроса) для поиска пропущенных; final — последняя ступень (unsure -> needs-primitive).
 * -> { accepted: [черновик с правилом], errors, sonnet, unknown, missing }
 */
export function processAnswers(answers, draftItems, refs, state = emptyState(), { htmlOf = () => null, expected = [], final = false, actionTypeOf = () => null } = {}) {
  const kindOf = (uuid, d) => ({ type: d.type, actionType: actionTypeOf(uuid) });
  const byUuid = new Map(draftItems.map((d) => [d.uuid, d]));
  const res = { accepted: [], errors: [], sonnet: [], unknown: [], missing: [] };
  const seen = new Set();
  const fail = (uuid, errors, guess = null) => {
    const n = state.attempts[uuid] = (state.attempts[uuid] ?? 0) + 1;
    if (n >= 2) { state.sonnet[uuid] = { uuid, why: "invalid twice", errors, guess: guess ?? state.retry[uuid]?.guess ?? null }; delete state.retry[uuid]; res.sonnet.push(uuid); }
    else { state.retry[uuid] = { uuid, errors, guess }; res.errors.push(uuid); }
  };
  for (const a of Array.isArray(answers) ? answers : []) {
    const d = byUuid.get(a?.uuid);
    if (!d) { res.unknown.push(a?.uuid ?? null); continue; }
    if (seen.has(a.uuid)) continue;
    seen.add(a.uuid);
    const c = checkAnswer(a, refs, htmlOf(a.uuid), kindOf(a.uuid, d));
    if (c.kind === "accepted") res.accepted.push({ ...d, status: "manual", confidence: "model", reason: `model: ${a.note ?? ""}`.trim(), rule: c.rule });
    else if (c.kind === "notes-only") res.accepted.push({ ...d, status: "manual", confidence: "notes-only", reason: `notes-only: ${a.note ?? ""}`.trim(), rule: c.rule });
    else if (c.kind === "needs-primitive") res.accepted.push({ ...d, status: "manual", confidence: "needs-primitive", reason: `needs-primitive: strike-gate; ${a.note ?? ""}`.trim(), rule: c.rule });
    else if (c.kind === "null") res.accepted.push({ ...d, status: "skip", confidence: null, reason: `model-null: ${c.note}`, rule: null });
    else if (c.kind === "unsure" && final) {
      // догадка проходит те же проверки, что и обычный ответ; негодная -> rule:null (правило по ней писать нечем)
      const g = checkAnswer({ uuid: a.uuid, rule: c.guess, unsure: false }, refs, htmlOf(a.uuid), kindOf(a.uuid, d));
      res.accepted.push({ ...d, status: "manual", confidence: "needs-primitive", reason: `needs-primitive: ${a.note ?? ""}`.trim(), rule: ["accepted", "needs-primitive", "notes-only"].includes(g.kind) ? g.rule : null });
    }
    else if (c.kind === "unsure") { state.sonnet[a.uuid] = { uuid: a.uuid, why: "unsure", note: a.note ?? "", guess: c.guess }; res.sonnet.push(a.uuid); }
    else fail(a.uuid, c.errors, a.rule ?? null);
  }
  for (const u of expected) if (!seen.has(u) && byUuid.has(u)) { res.missing.push(u); fail(u, ["no answer was returned for this item: answer it (rule or null)"]); }
  for (const d of res.accepted) { delete state.retry[d.uuid]; delete state.sonnet[d.uuid]; }
  return res;
}

/** Блоки предметов из файлов-запросов tools/out/haiku/*.md: uuid -> текст блока (для повторного запроса). */
export function blocksIndex(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    for (const b of readFileSync(join(dir, f), "utf8").split(/^### /m).slice(1)) { const u = b.split("\n")[0].split(" ")[1]; if (u) out[u] = `### ${b.trimEnd()}`; }
  }
  return out;
}

/** Текст повторного запроса Джуну: ошибки + тексты предметов (Джун репозиторий не читает). */
export const retryText = (retry, blocks = {}) => `Your previous answers for these items were rejected. Fix ONLY them and answer with a JSON array in the same format ({uuid, rule|null, unsure, note}), following the same rules as before.\n\n${retry.map((e) => `${blocks[e.uuid] ?? `### ${e.uuid}`}\nERRORS:\n${e.errors.map((x) => `  * ${x}`).join("\n")}\n`).join("\n")}`;

/** Принятые ответы -> rules/drafts-accepted/<batch>.json (маленький файл в git; drafts.mjs подмешивает). */
export function mergeAccepted(existing, accepted, meta) {
  const by = new Map((existing?.items ?? []).map((d) => [d.uuid, d]));
  for (const d of accepted) by.set(d.uuid, d);
  return { meta: { batch: meta.batch, pf2eVersion: meta.pf2eVersion }, items: [...by.values()].sort((a, b) => cmp(a.uuid, b.uuid)) };
}

function main() {
  const [file, batch] = process.argv.slice(2);
  if (!file || !batch || batch.startsWith("--")) throw new Error("usage: node tools/validate.mjs <answer.json> <batch> [--input haiku-file.md]");
  const refs = readOut("refs.json"), html = readOut("html.json"), { meta, items: itemList } = readOut("items.json"), items = new Map(itemList.map((i) => [i.uuid, i]));
  const dPath = join(ROOT, "rules/drafts", `${batch}.json`), aPath = join(ACCEPTED, `${batch}.json`);
  const drafts = readJson(dPath).items;
  const stPath = outPath("validate", `${batch}.state.json`);
  const state = existsSync(stPath) ? readJson(stPath) : emptyState();
  const inFile = arg("input");
  const expected = inFile ? [...readFileSync(inFile, "utf8").matchAll(/^### \d+ (\S+)/gm)].map((m) => m[1]) : [];
  const raw = readFileSync(file, "utf8").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const res = processAnswers(JSON.parse(raw), drafts, refs, state, { htmlOf: (u) => html[u] ?? "", actionTypeOf: (u) => items.get(u)?.actionType ?? null, expected, final: process.argv.includes("--final") });
  if (res.accepted.length) writeText(aPath, serializeDrafts({ batch, pf2eVersion: meta.pf2eVersion }, mergeAccepted(existsSync(aPath) ? readJson(aPath) : null, res.accepted, { batch, pf2eVersion: meta.pf2eVersion }).items));
  writeJson(stPath, state);
  const retry = Object.values(state.retry).filter((r) => r.errors);
  writeText(outPath("validate", `${batch}.retry.md`), retry.length ? retryText(retry, blocksIndex(outPath("haiku"))) : "");
  writeJson(outPath("validate", `${batch}.sonnet.json`), Object.values(state.sonnet), 1);
  console.log(`validate ${batch}: принято ${res.accepted.length}, на повтор ${res.errors.length + res.missing.length} (пропущено ${res.missing.length}), на Sonnet ${res.sonnet.length}, чужих uuid ${res.unknown.length}; в очередях: повтор ${retry.length}, Sonnet ${Object.keys(state.sonnet).length}`);
}

if (isMain(import.meta.url)) main();
