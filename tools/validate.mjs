// Ответ агента (JSON-массив {uuid, rule|null, unsure, note}) -> валидация -> принятые в rules/drafts-accepted, очереди повтора и Sonnet.
// Запуск: node tools/validate.mjs <ответ.json> <batch> [--input tools/out/haiku/<batch>-NN.md] [--final]
// <batch> = activate (tools/haiku-input.mjs activate): черновики — из всех пачек по uuid пула (tools/out/activate-pool.json), принятые ложатся в файл исходной пачки.
// <batch> = mdebt (tools/debt-pool.mjs): то же по пулам долга debt-pool.json и mdebt-pool.json; ответ возвращается в файл пачки записи (правило или новая причина).
// --final — ответы последней ступени (Sonnet): unsure не уходит дальше, а принимается долгом needs-primitive с правилом-догадкой.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ROOT, ACCEPTED, DRAFTS, serializeDrafts, readJson, readOut, writeJson, writeText, outPath, arg, cmp, isMain } from "./lib.mjs";
import { validateRule, activateOf, activateSpells, activateUses, withActivation, dupActivate, frequencyOf, enemiesOnly, strikeGate, strikeHitEffect, setWho, afflictionStages } from "../scripts/rules.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { BUILTIN } from "../scripts/builtin/index.mjs";
import { stepCount } from "./triage.mjs";
import { gateToEvent, hasCard, multiStrike } from "./strike-gate.mjs";
import { afflictionRule } from "./affliction.mjs";
import { isCoverBypass } from "./cover-bypass.mjs";

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

const stepsOf = (rule) => [...activateUses(rule).flatMap((o) => stepsOf({ onUse: o })), ...(rule.onUse?.apply ?? []), ...(rule.onUse?.apply ?? []).flatMap((a) => Object.values(a.coat?.challenge?.byDegree ?? {}).flat()), ...Object.values(rule.onUse?.challenge?.byDegree ?? {}).flat(), ...Object.values(rule.onUse?.check?.byDegree ?? {}).flat(),
  ...(rule.onEvent ?? []).flatMap((e) => [...(e.apply ?? []), ...Object.values(e.challenge?.byDegree ?? {}).flat()]),
  ...(rule.onUse?.zone?.triggers ?? []).flatMap((e) => [...(e.apply ?? []), ...Object.values(e.challenge?.byDegree ?? {}).flat()])];

/** Одни заметки ведущему (без иммунитета, зоны, событий): либо сюжет (автоматизировать нечего), либо механика без примитива (толчок, штраф без эффекта). Не skip: очередь «нужен примитив», в рантайм не идёт (решение пользователя 2026-10-24). */
export const notesOnly = (rule) => {
  const u = rule.onUse, s = stepsOf(rule);
  return s.length > 0 && s.every((x) => x.note) && !activateOf(rule)?.length && !u?.challenge?.immunity && !u?.check?.immunity && !u?.zone && !(rule.onEvent ?? []).some((e) => e.challenge?.immunity) && !rule.onAttacked && !rule.macros?.length;
};

/** Содержательные проверки: ссылки существуют (и есть в тексте предмета), статистики из известных списков, builtin есть в реестре. html === null — не проверять текст. */
export function semanticErrors(rule, refs, html = null) {
  const bad = [];
  const u = rule.onUse;
  if (!stepCount(rule)) bad.push("the rule has no steps: it does nothing; answer null if there is nothing to automate");
  for (const s of stepsOf(rule)) {
    if (s.condition && !refs.conditions[s.condition.slug]) bad.push(`condition "${s.condition.slug}" does not exist in pf2e`);
    if (s.removeCondition && !refs.conditions[s.removeCondition.slug]) bad.push(`condition "${s.removeCondition.slug}" does not exist in pf2e`);
    for (const c of s.affliction?.def.stages.flatMap((st) => st.conditions) ?? []) if (!refs.conditions[c.slug]) bad.push(`affliction condition "${c.slug}" does not exist in pf2e`);
    if (s.repeat?.statistic && !SAVES.includes(s.repeat.statistic)) bad.push(`repeat.statistic must be fortitude, reflex or will (got "${s.repeat.statistic}")`);
    // эффекты обхода укрытия — из пака модуля: ни в refs pf2e, ни в тексте предмета их нет
    if (isCoverBypass(s.effect?.uuid) && s.to !== "self") bad.push(`cover-bypass effect ${s.effect.uuid} must be applied with "to": "self" (it sits on the attacker, not on the target)`);
    for (const x of [s.effect?.uuid, s.unlessEffect]) if (x && !isCoverBypass(x) && !refs.effects[x]) bad.push(`effect ${x} not found: copy the UUID exactly from the item text`);
    for (const x of [s.effect?.uuid, s.unlessEffect]) if (x && !isCoverBypass(x) && html !== null && !html.includes(x)) bad.push(`effect ${x} is not mentioned in this item's text: use only effects linked in the text`);
  }
  for (const s of (rule.activate ?? []).flatMap(activateSpells)) if (html !== null && !html.includes(s)) bad.push(`cast spell ${s} is not mentioned in this item's text: copy the spell UUID from the \`You cast\` link`);
  // «Stage 1 … Stage 2 …» без шага affliction: стадии остались бы текстом (яд/болезнь не вели бы счёт)
  if (html && afflictionStages(html) && !stepsOf(rule).some((s) => s.affliction)) bad.push("the text has affliction stages (Stage 1, Stage 2 …): the rule needs an `affliction` step on failure / critical failure (see the affliction example); do not recreate stages with plain condition steps");
  for (const e of rule.onEvent ?? []) if (e.aura && !/^[a-z0-9-]+$/.test(e.aura)) bad.push(`onEvent aura "${e.aura}" must be the slug of a pf2e Aura rule element (lowercase, dashes); if you do not know it use "range" in feet`);
  // верхний уровень `when` — И: два исхода сразу никогда не выполнятся («попадание» = {"or": [success, criticalSuccess]})
  for (const e of rule.onEvent ?? []) if ((Array.isArray(e.when) ? e.when : []).filter((p) => typeof p === "string" && p.startsWith("outcome:")).length > 1) bad.push(`onEvent.when lists several outcome:* at the top level: that is AND and is never true; write {"or": ["outcome:success", "outcome:criticalSuccess"]}`);
  const z = u?.zone;
  if (z?.condition && !refs.conditions[z.condition.slug]) bad.push(`zone condition "${z.condition.slug}" does not exist in pf2e`);
  if (z?.effect && !refs.effects[z.effect.uuid]) bad.push(`zone effect ${z.effect.uuid} not found`);
  if (z?.effect && html !== null && !html.includes(z.effect.uuid)) bad.push(`zone effect ${z.effect.uuid} is not mentioned in this item's text`);
  // coat: яд на оружии без недуга/состояния ни на что не действует; внутренние поля носителя (gate, coatArm) в каталог не идут
  for (const s of (u?.apply ?? []).filter((a) => a.coat)) if (!Object.values(s.coat.challenge.byDegree).flat().some((x) => x.affliction || x.condition)) bad.push("coat.challenge must put an `affliction` or a condition on the target (failure / criticalFailure): a poison that does nothing is not a rule");
  if ((rule.onEvent ?? []).some((e) => e.gate) || stepsOf(rule).some((s) => s.coatArm)) bad.push("`gate` and `coatArm` are internal fields of the weapon-poison carrier: do not use them");
  for (const c of [u?.challenge, ...(u?.apply ?? []).map((a) => a.coat?.challenge), ...(rule.onEvent ?? []).map((e) => e.challenge), ...(u?.zone?.triggers ?? []).map((t) => t.challenge)]) {
    if (!c) continue;
    if (!SAVES.includes(c.statistic)) bad.push(`challenge.statistic must be fortitude, reflex or will (got "${c.statistic}")`);
    if (c.dc?.against && !DC_AGAINST.has(c.dc.against)) bad.push(`dc.against "${c.dc.against}" is unknown: use spell, class, class-spell, a class slug (kineticist…), perception or a skill`);
    // СЛ берётся из @Check[...|against:X] текста: «higher of class/spell DC» = class-spell, а не class
    // только проверки спасброска (навык против защиты цели — не СЛ автора); occult/arcane/divine/primal = СЛ заклинания
    const want = html ? [...String(html).matchAll(/@Check\[(?:type:)?(?:fortitude|reflex|will)\b[^\]]*?\bagainst:([\w-]+)/g)].map((m) => (/^(?:occult|arcane|divine|primal)$/.test(m[1]) ? "spell" : m[1])) : [];
    if (c.dc?.against && want.length && !want.includes(c.dc.against) && !(c.dc.against === "class" && want.some((x) => CLASSES.includes(x)))) bad.push(`dc.against "${c.dc.against}" differs from the text: @Check says against:${want.join(", against:")}; use {"against": "${want[0]}"}`);
  }
  const k = u?.check;
  if (k) {
    for (const s of [k.statistic].flat()) if (!CHECK_STATS.has(s) && !isLore(s)) bad.push(`check.statistic "${s}" must be a skill, perception or spell-attack`);
    if (k.vs?.against && !VS_AGAINST.has(k.vs.against)) bad.push(`vs.against "${k.vs.against}" is unknown`);
  }
  for (const m of rule.macros ?? []) if (!m.builtin || !BUILTIN[m.builtin]) bad.push(`macro ${m.builtin ?? m.uuid} is not available: do not use macros`);
  const seen = new Set(bad);
  for (const o of activateUses(rule)) for (const e of semanticErrors({ v: 1, onUse: o, macros: [] }, refs, html)) if (!seen.has(e) && !e.startsWith("the rule has no steps")) { seen.add(e); bad.push(e); }   // испытание, зона, проверка внутри onUse активации — как у корневого
  return bad;
}

/**
 * Предупреждения (не ошибки) по полям записи активации duration/immunity: накладывать не на что. spellRule(uuid) -> правило заклинания из каталога | null.
 * Рантайм при этом ничего не ломает (наложение — то же правило), но запись бесполезна, пока правило заклинания не появится или не изменится.
 */
export function activationWarnings(rule, spellRule) {
  const out = [];
  for (const c of activateOf(rule) ?? []) for (const e of [c, ...(c.choices ?? [])]) {
    if (!e.spell || (!e.duration && !e.immunity)) continue;
    const sr = spellRule(e.spell), at = `${c.id}${e === c ? "" : `.${e.id}`}`;
    if (!sr) { out.push(`${at}: no catalog rule for spell ${e.spell}: duration/immunity have nothing to apply to`); continue; }
    const carriers = stepsOf(sr).filter((s) => s.condition || s.effect);
    if (e.duration && isDeepStrictEqual(withActivation(sr, { duration: e.duration }), sr)) out.push(`${at}: the spell rule has no condition/effect step that takes a duration`);
    else if (e.duration && carriers.some((s) => s.repeat)) out.push(`${at}: a spell step with repeat does not take the entry duration (the spell duration stays on it)`);
    if (e.immunity && sr.onUse?.challenge?.immunity) out.push(`${at}: the entry immunity replaces the spell rule's own challenge.immunity`);
    if (e.immunity && !sr.onUse?.challenge) out.push(`${at}: the spell rule has no onUse.challenge: immunity does nothing`);
  }
  return out;
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

/** Текст со стадиями, а в ответе недуга нет: определение собирает код (tools/affliction.mjs), испытание и остальные степени остаются от модели. Не собралось — правило как есть (semanticErrors скажет почему). */
function withAffliction(rule, html, refs, kind) {
  if (!html || !afflictionStages(html) || stepsOf(rule).some((s) => s.affliction)) return { rule };
  const byId = new Map(Object.entries(refs.conditions ?? {}).map(([slug, c]) => [c.id, slug]));
  const r = afflictionRule(html, { name: rule.label, traits: kind?.traits ?? [], base: rule, condSlug: (u) => (u.includes(".conditionitems.") ? byId.get(u.split(".").pop()) ?? null : null) });
  // часть стадий не разобрана (кроме СЛ, её берёт испытание): неполный недуг теряет эффекты молча — на Sonnet
  if (r?.unsure.some((u) => u !== "dc")) return { rule: r.rule ?? rule, unsure: r.unsure };
  return { rule: r?.rule ?? rule };
}

/** Блоки «Activate» с «Frequency» -> [{name, per}]; per — null, если частоту не разобрать. */
export function frequentActivations(html) {
  return html.split(/(?=<strong>\s*Activate\b)/i).slice(1).map((b) => b.split(/<strong>\s*(?:Craft Requirements|Destruction)\b|<h2/i)[0])
    .filter((b) => /<strong>\s*Frequency\b/i.test(b))
    .map((b) => ({ name: /<strong>\s*Activate\s*[—–-]?\s*([^<]*?)\s*<\/strong>/i.exec(b)?.[1] || /<strong>\s*Activate\s*([^<]*?)\s*<\/strong>/i.exec(b)?.[1] || null, per: frequencyOf(/<strong>\s*Frequency\s*<\/strong>([^<]*)/i.exec(b)?.[1]) }));
}

/** Один ответ агента -> { kind: "accepted"|"notes-only"|"null"|"unsure"|"error", rule?, errors? }. */
export function checkAnswer(ans, refs, html = null, kind = null) {
  if (!ans || typeof ans.uuid !== "string" || !("rule" in ans)) return { kind: "error", errors: ["answer must be {uuid, rule|null, unsure:bool, note}"] };
  if (ans.unsure === true) return { kind: "unsure", guess: ans.rule ?? null };
  if (ans.rule === null && html && afflictionStages(html)) return { kind: "error", errors: ["the text has affliction stages (Stage 1, Stage 2 …): never answer null, write the `affliction` step (or unsure: true with \"missing: affliction\")"] };
  if (ans.rule === null) return { kind: "null", note: ans.note ?? "" };
  const dup = dupActivate(ans.rule);
  if (dup) return { kind: "error", errors: [fmtErr(dup)] };
  const v = validateRule(ans.rule);
  if (!v.ok) return { kind: "error", errors: v.errors.map(fmtErr) };
  if (ans.rule.cast != null) return { kind: "error", errors: ["use `activate`, not `cast` (the key was renamed)"] };
  const noId = (ans.rule.activate ?? []).flatMap((c, i) => [...(c.spell == null && c.id == null ? [`activate[${i}]`] : []), ...(c.choices ?? []).flatMap((x, j) => (x.spell == null && x.id == null ? [`activate[${i}].choices[${j}]`] : []))]);
  if (noId.length) return { kind: "error", errors: [`an explicit latin slug \`id\` is required on an activation or choice without a \`spell\` (counters are keyed by it): ${noId.join(", ")}`] };
  const extra = extraKeys(ans.rule, v.rule);
  if (extra.length) return { kind: "error", errors: [`unknown fields (not in the schema): ${extra.join(", ")}`] };
  const w = withAffliction(v.rule, html, refs, kind);
  if (w.unsure) return { kind: "unsure", guess: w.rule };
  v.rule = w.rule;
  const sem = semanticErrors(v.rule, refs, html);
  if (sem.length) return { kind: "error", errors: sem };
  // область берётся из шапки предмета или @Template (use.mjs: регион карточки, cast.mjs: @Template блока Activate); иначе целей-области нет
  if (html && kind?.area === null && !/@Template\[/.test(html) && [v.rule.onUse, ...activateUses(v.rule)].some((o) => o?.targets === "area")) return { kind: "error", errors: [`targets "area" needs an area: the item has no "area" in its header and no @Template in the text; ${[v.rule.onUse, ...activateUses(v.rule)].some((o) => o?.zone) ? "a zone needs a real area: for an aura of the owner write onEvent side:\"near\" with range (forms 1a/1c)" : "use \"selected\" (a push then has no \"from\": it goes away from the user)"}`] };
  // атаку заклинанием бросает pf2e (карточка), по ней считается урон; без roll:"system" модуль бросил бы вторую, свою
  if ([v.rule.onUse, ...activateUses(v.rule)].some((o) => o?.check && [o.check.statistic].flat().includes("spell-attack") && o.check.roll !== "system")) return { kind: "error", errors: ['check.statistic "spell-attack" needs "roll":"system": pf2e rolls the spell attack itself (its card), the module takes the degree from it'] };
  // постоянный урон из system.damage pf2e превращает в состояние сам: второй шаг дал бы второе состояние
  const dupPers = stepsOf(v.rule).filter((s) => s.persistent && kind?.persistentDmg?.includes(s.persistent.damageType));
  if (dupPers.length) return { kind: "error", errors: [`the item's own damage already has persistent ${dupPers[0].persistent.damageType}: pf2e applies that condition itself when the damage is applied, so a \`persistent\` step of that type would add a second condition: remove the step (a \`note\` if the GM must act)`] };
  if (!roundTrip(v.rule)) return { kind: "error", errors: ["rule does not survive the form round-trip: remove fields that are not in the schema"] };
  // шаги активации в корневом onUse: счётчик частоты живёт в записи activate, без неё «раз в день» не считается
  // расходник (корневой onUse — сам глоток/применение), действие и черта (своя system.frequency) — исключения
  if (html && !["consumable", "action", "feat"].includes(kind?.type) && v.rule.onUse && !v.rule.activate?.length && frequentActivations(html).length) return { kind: "error", errors: ["the text has an `Activate … Frequency …` block, so its steps belong in `activate: [{id, label, per, onUse}]` and the root onUse stays null (the frequency counter is keyed by the activation entry); unsure: true if the rule also has passive parts"] };
  // событие «бросок атаки» на тексте «Make a Strike. If it hits…» без afterUse сработало бы на каждом попадании владельца
  if (html && hasCard(kind) && strikeGate(html) && !multiStrike(html) && v.rule.onEvent?.some((e) => ["attack-roll", "damage-roll"].includes(e.on) && !e.afterUse)) return { kind: "error", errors: ["the text is \"Make a Strike, then …\": an onEvent entry on attack-roll/damage-roll needs afterUse:true (or write a plain onUse.challenge and the tool will convert it)"] };
  // то же для «Удар; при попадании эффект без спасброска» (strikeGate такой текст не ловит: нет save)
  if (html && hasCard(kind) && strikeHitEffect(html) && !multiStrike(html) && v.rule.onEvent?.some((e) => ["attack-roll", "damage-roll"].includes(e.on) && (e.side ?? "self") === "self" && !e.afterUse)) return { kind: "error", errors: ["the text is \"Make a Strike; if it hits, <effect>\": an onEvent entry (side self) on attack-roll/damage-roll needs afterUse:true (Exception 2b), otherwise it fires on every hit of the owner"] };
  const { rule, gate } = normalizeRule(v.rule, html, kind);
  if (notesOnly(rule)) return { kind: "notes-only", rule };
  // испытание остаётся при использовании, а текст — «Удар, затем испытание»: оно бросилось бы и при промахе
  if (gate) return { kind: "unsure", guess: rule, key: multiStrike(html) ? "multi-strike" : "strike-gate" };
  return { kind: "accepted", rule };
}


export const emptyState = () => ({ attempts: {}, retry: {}, sonnet: {} });

/**
 * Чистая часть. draftItems — черновики пачки (для имён и поиска), state копит попытки и очереди между вызовами,
 * opts: { htmlOf(uuid), expected: [uuid], final } — ожидаемые ответы (из файла-запроса) для поиска пропущенных; final — последняя ступень (unsure -> needs-primitive).
 * -> { accepted: [черновик с правилом], errors, sonnet, unknown, missing }
 */
export function processAnswers(answers, draftItems, refs, state = emptyState(), { htmlOf = () => null, expected = [], final = false, actionTypeOf = () => null, traitsOf = () => [], areaOf = () => undefined, persistentOf = () => [] } = {}) {
  const kindOf = (uuid, d) => ({ type: d.type, actionType: actionTypeOf(uuid), traits: traitsOf(uuid), area: areaOf(uuid), persistentDmg: persistentOf(uuid) });
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
    else if (c.kind === "null") res.accepted.push({ ...d, status: "skip", confidence: null, reason: `model-null: ${c.note}`, rule: null });
    else if (c.kind === "unsure" && final) {
      // догадка проходит те же проверки, что и обычный ответ; негодная -> rule:null (правило по ней писать нечем)
      const g = checkAnswer({ uuid: a.uuid, rule: c.guess, unsure: false }, refs, htmlOf(a.uuid), kindOf(a.uuid, d));
      // механизм назван кодом (c.key — unsure с ключом; g.key — догадка сама оказалась strike-gate/multi-strike): правило-догадка остаётся как есть
      const key = c.key ?? (g.kind === "unsure" ? g.key : null);
      const keep = c.key ? c.guess : g.kind === "unsure" && g.key ? g.guess : ["accepted", "notes-only"].includes(g.kind) ? g.rule : null;
      res.accepted.push({ ...d, status: "manual", confidence: "needs-primitive", reason: `needs-primitive: ${key ? `${key}; ` : ""}${a.note ?? ""}`.replace(/;\s*$/, "").trim(), rule: keep });
    }
    else if (c.kind === "unsure") { state.sonnet[a.uuid] = { uuid: a.uuid, why: "unsure", note: c.key ?? a.note ?? "", guess: c.guess }; res.sonnet.push(a.uuid); }
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
  // mdebt: пул долга по механизмам (tools/debt-pool.mjs) и прежний пул debt-pool.json; ответ — правило или новая причина needs-primitive с ключами словаря
  const poolFiles = batch === "activate" ? ["activate-pool.json"] : /^mdebt\d*$/.test(batch) ? ["debt-pool.json", "mdebt-pool.json", ...(batch === "mdebt" ? [] : [`${batch}-pool.json`])].filter((f) => existsSync(outPath(f))) : null;
  const poolBatch = poolFiles ? new Map(poolFiles.flatMap((f) => readJson(outPath(f)).map((p) => [p.uuid, p.batch ?? "b01-save-conditions"]))) : null;
  const drafts = poolBatch ? readdirSync(DRAFTS).flatMap((f) => readJson(join(DRAFTS, f)).items).filter((d) => poolBatch.has(d.uuid)) : readJson(dPath).items;
  const stPath = outPath("validate", `${batch}.state.json`);
  const state = existsSync(stPath) ? readJson(stPath) : emptyState();
  const inFile = arg("input");
  const expected = inFile ? [...readFileSync(inFile, "utf8").matchAll(/^### \d+ (\S+)/gm)].map((m) => m[1]) : [];
  const raw = readFileSync(file, "utf8").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const res = processAnswers(JSON.parse(raw), drafts, refs, state, { htmlOf: (u) => html[u] ?? "", actionTypeOf: (u) => items.get(u)?.actionType ?? null, traitsOf: (u) => items.get(u)?.traits ?? [], areaOf: (u) => items.get(u)?.area ?? null, persistentOf: (u) => items.get(u)?.persistentDmg ?? [], expected, final: process.argv.includes("--final") });
  for (const [b, acc] of Object.entries(Object.groupBy(res.accepted, (d) => poolBatch?.get(d.uuid) ?? batch))) {
    const p = poolBatch ? join(ACCEPTED, `${b}.json`) : aPath;
    writeText(p, serializeDrafts({ batch: b, pf2eVersion: meta.pf2eVersion }, mergeAccepted(existsSync(p) ? readJson(p) : null, acc, { batch: b, pf2eVersion: meta.pf2eVersion }).items));
  }
  writeJson(stPath, state);
  const retry = Object.values(state.retry).filter((r) => r.errors);
  writeText(outPath("validate", `${batch}.retry.md`), retry.length ? retryText(retry, blocksIndex(outPath("haiku"))) : "");
  writeJson(outPath("validate", `${batch}.sonnet.json`), Object.values(state.sonnet), 1);
  console.log(`validate ${batch}: принято ${res.accepted.length}, на повтор ${res.errors.length + res.missing.length} (пропущено ${res.missing.length}), на Sonnet ${res.sonnet.length}, чужих uuid ${res.unknown.length}; в очередях: повтор ${retry.length}, Sonnet ${Object.keys(state.sonnet).length}`);
}

if (isMain(import.meta.url)) main();
