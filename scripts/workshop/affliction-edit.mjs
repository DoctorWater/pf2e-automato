// Мастерская: редактор недуга (шаг `affliction`, чистое ядро без Foundry). Определение — JSON `{stage, def}` в row.text строки формы (sheet.mjs).
// Копия определения лежит в каждом шаге правила; правка в одном шаге переписывает все шаги его ГРУППЫ, свой у шага только `stage`.
// Группа — сессионная (WeakMap по строке формы, в JSON формы, правило и вкладку листа не попадает, «грязным» форму не делает): при открытии строки
// с равными определениями образуют группу, новый шаг-недуг присоединяется к группе первого недуга правила, «Отделить» даёт шагу свою группу.
// Переименование группу не меняет. Допустимое — как у валидатора vAffliction (rules.mjs): те же списки и пределы.
import { AFFLICTION_KINDS, AFFLICTION_SAVES, APPLY_UNITS, MAX_STAGES } from "../rules.mjs";
import { COLS, modAdd, modRemove, modSet } from "./automation.mjs";

export { AFFLICTION_KINDS, AFFLICTION_SAVES, APPLY_UNITS, MAX_STAGES };
export const DMG_MAX = 4;     // как vAfflStage: урона до 4, состояний до 6, значение состояния 1..10
export const COND_MAX = 6;
export const COND_VALUE_MAX = 10;

const clone = (x) => JSON.parse(JSON.stringify(x));
const intOrRaw = (v) => { const s = String(v ?? "").trim(); return /^-?\d+$/.test(s) ? Number(s) : s; };   // нечисло уйдёт в валидатор ошибкой

export const blankStage = () => ({ duration: null, damage: [], persistent: null, conditions: [], mods: null, text: "" });
export const blankDef = () => ({ name: "", kind: "poison", save: { statistic: "fortitude" }, maxDuration: null, onset: null, virulent: false, stages: [blankStage()] });

/** {stage, def} из строки формы; null — не недуг или битый JSON. */
export function afflOf(row) {
  try {
    const x = JSON.parse(row?.text);
    return x && typeof x === "object" && x.def && typeof x.def === "object" && Array.isArray(x.def.stages) ? x : null;
  } catch { return null; }
}
const put = (row, x) => { row.text = JSON.stringify(x); };

/**
 * Строки шагов правила с путями от корня формы: [[путь, строка]] — только те, что попадут в правило
 * (apply/испытание/проверка/зона — у onUse; испытание и проверка по своим флажкам; события всегда, их испытание по флажку; триггеры — у зоны области).
 */
export function stepRows(f) {
  const out = [], add = (path, rows) => (rows ?? []).forEach((r, i) => { out.push([`${path}.${i}`, r]); if (r.kind === "coat" && r.coat) degs(`${path}.${i}.coat.ch`, r.coat.ch); });   // шаг coat несёт своё испытание: его степени — тоже шаги правила
  const degs = (path, o) => { for (const d of COLS) add(`${path}.deg.${d}`, o?.deg?.[d]); };
  if (f.kind === "onUse" || f.kind === "onDamaged" || f.kind === "onFailed") {
    add("apply", f.apply);
    if (f.ch?.on) degs("ch", f.ch);
    if (f.ck?.on) degs("ck", f.ck);
    if (f.targets === "area" && f.zone?.on) (f.zone.trig ?? []).forEach((e, i) => { add(`zone.trig.${i}.apply`, e.apply); if (e.ch?.on) degs(`zone.trig.${i}.ch`, e.ch); });
  }
  (f.ev ?? []).forEach((e, i) => { add(`ev.${i}.apply`, e.apply); if (e.ch?.on) degs(`ev.${i}.ch`, e.ch); });
  return out;
}
const afflRows = (f) => stepRows(f).filter(([, r]) => r.kind === "affliction");

/* ---------- группы (сессионные) ---------- */

const GROUP = new WeakMap();   // строка формы -> { units }: общая запись группы; равенство записей = одна группа

/** Строки без группы (открытие окна, правка вне ядра): равные определения — одна группа. */
function ensure(f) {
  const batch = new Map();
  for (const [, r] of afflRows(f)) {
    const x = !GROUP.has(r) && afflOf(r);
    if (!x) continue;
    const k = JSON.stringify(x.def);
    if (!batch.has(k)) batch.set(k, { units: {} });
    GROUP.set(r, batch.get(k));
  }
}
const members = (f, row) => { ensure(f); const g = GROUP.get(row); return [...new Set([...afflRows(f).map(([, r]) => r).filter((r) => g && GROUP.get(r) === g), row])]; };

/** Шаги правила в одной группе с row: [путь от корня формы]. Включает саму строку. */
export function sharedPaths(f, row) {
  ensure(f);
  const g = GROUP.get(row);
  return g ? afflRows(f).filter(([, r]) => GROUP.get(r) === g).map(([p]) => p) : [];
}

/** Подпись шага для шапки «общее для шагов»: степень испытания/проверки, «сразу», событие, триггер. t — L(). */
export function stepLabel(path, t) {
  const deg = /(?:^|\.)(?:ch|ck)\.deg\.(\w+)\.\d+$/.exec(path)?.[1];
  const ev = /^ev\.(\d+)\./.exec(path)?.[1], trg = /^zone\.trig\.(\d+)\./.exec(path)?.[1];
  const where = /\.coat\./.test(path) ? t("workshop.au.coat.inCoat") : ev !== undefined ? t("workshop.au.affl.inEvent", { n: Number(ev) + 1 }) : trg !== undefined ? t("workshop.au.affl.inTrigger", { n: Number(trg) + 1 }) : "";
  const what = deg ? t(`sheet.degree.${deg}`) : t("workshop.au.immediate");
  return where ? `${what} (${where})` : what;
}

/** Начальная стадия шага — в пределах числа стадий. */
const clampStage = (s, n) => Math.min(n, Math.max(1, Number.isInteger(s) ? s : 1));

/** Определение лежит копией в каждом шаге группы: переписываем все; стадия каждого шага остаётся в пределах новых стадий. */
function mutate(f, row, fn) {
  const x = afflOf(row);
  if (!x) return undefined;
  const group = members(f, row), def = clone(x.def), units = GROUP.get(row)?.units ?? {};
  for (const s of def.stages) { s.damage ??= []; s.conditions ??= []; }   // каталог мог опустить пустые списки
  const res = fn(def, units);
  for (const r of group) {
    const y = afflOf(r);
    if (!y) continue;
    y.def = clone(def);
    if (y.stage != null) y.stage = clampStage(y.stage, def.stages.length);
    put(r, y);
  }
  return res;
}

/** Новая строка-недуг: вид, цель target и определение. Если в правиле уже есть недуг — присоединяется к его группе (то же определение), иначе пустое с одной стадией. */
export function afflInit(row, f) {
  ensure(f);
  const [, first] = afflRows(f).find(([, r]) => afflOf(r) && r !== row) ?? [];
  Object.assign(row, { kind: "affliction", to: "target", value: "", text: JSON.stringify({ stage: 1, def: first ? clone(afflOf(first).def) : blankDef() }) });
  GROUP.set(row, (first && GROUP.get(first)) || { units: {} });
}

/** «Отделить»: шаг получает независимую копию определения (свою группу); подсказки единиц копируются. */
function split(f, row) {
  ensure(f);
  GROUP.set(row, { units: { ...(GROUP.get(row)?.units ?? {}) } });
}

/* Срок: пусто — срока нет. Единица живёт отдельно от значения (units[key], пока значения нет): перенабор «6 часов» не сбрасывает её в раунды. */
function durSet(o, key, field, v, units, uk = key) {
  const cur = o[key] ?? null;
  if (field === "value") {
    const n = intOrRaw(v);
    if (n === "") { if (cur) units[uk] = cur.unit; o[key] = null; }
    else o[key] = { value: n, unit: cur?.unit ?? units[uk] ?? "rounds" };
  } else { units[uk] = v; if (cur) o[key] = { value: cur.value, unit: v }; }
}
const opt = (o, key, v) => { const n = intOrRaw(v); if (n === "") delete o[key]; else o[key] = n; };

/** Мини-строка для редактора свойств стадии: тот же код, что у «своего» эффекта (modAdd/modSet/modRemove правят JSON в text). */
function modsEdit(stage, fn) {
  const row = { text: JSON.stringify(stage.mods ?? []) };
  fn(row);
  const list = JSON.parse(row.text);
  stage.mods = list.length ? list : null;   // пустой список валидатор отвергает: «нет штрафов» — null
}
export const stageModsRow = (stage) => ({ text: JSON.stringify(stage?.mods ?? []) });

/**
 * Правка поля. name: stage (только этот шаг); name, kind, save.statistic, save.dc, maxDuration.value|unit, onset.value|unit, virulent;
 * s.<i>.duration.value|unit, s.<i>.text, s.<i>.damage.<j>.formula|damageType, s.<i>.persistent.formula|damageType|dc,
 * s.<i>.cond.add (v — slug состояния), s.<i>.mods.<k>.<поле>. opts.valued(slug) — значимое ли состояние (новое получает значение 1).
 */
export function afflSet(f, row, name, v, opts = {}) {
  if (name === "stage") {
    const x = afflOf(row);
    if (x) { x.stage = clampStage(intOrRaw(v), x.def.stages.length); put(row, x); }
    return;
  }
  mutate(f, row, (def, units) => {
    const [a, b, c, d, e] = name.split(".");
    if (a === "name") def.name = String(v ?? "");
    else if (a === "kind") def.kind = v;
    else if (a === "virulent") def.virulent = !!v;
    else if (a === "note") { const s = String(v ?? "").trim(); if (s) def.note = s; else delete def.note; }
    else if (a === "save") { def.save = { ...def.save }; if (b === "dc") opt(def.save, "dc", v); else def.save[b] = v; }
    else if (a === "maxDuration" || a === "onset") durSet(def, a, b, v, units);
    else if (a === "s" && def.stages[Number(b)]) {
      const s = def.stages[Number(b)];
      if (c === "duration") durSet(s, "duration", d, v, units, `s.${b}`);
      else if (c === "text") s.text = String(v ?? "");
      else if (c === "damage" && s.damage[Number(d)]) s.damage[Number(d)][e] = e === "formula" ? String(v ?? "") : v;
      else if (c === "persistent" && s.persistent) { if (d === "dc") opt(s.persistent, "dc", v); else s.persistent[d] = d === "formula" ? String(v ?? "") : v; }
      else if (c === "cond" && d === "add") {
        if (v && s.conditions.length < COND_MAX && !s.conditions.some((x) => x.slug === v)) s.conditions.push({ slug: v, ...(opts.valued?.(v) && { value: 1 }) });
      } else if (c === "mods") modsEdit(s, (r) => modSet(r, Number(d), e, v));
    }
  });
}

/**
 * Кнопки. op: split | stageAdd | stageRm:<i> | dmgAdd:<i> | dmgRm:<i>:<j> | persOn:<i> | persOff:<i> | condRm:<i>:<j> | condStep:<i>:<j>:<±1> | modAdd:<i>:<вид> | modRm:<i>:<k>.
 * -> индекс стадии, которую раскрыть (после добавления/удаления стадии), иначе undefined.
 */
export function afflOp(f, row, op) {
  const [name, ...r] = op.split(":"), i = Number(r[0]), j = Number(r[1]);
  if (name === "split") return split(f, row);
  return mutate(f, row, (def, units) => {
    const s = def.stages[i];
    if (name === "stageAdd") { if (def.stages.length < MAX_STAGES) { def.stages.push(blankStage()); return def.stages.length - 1; } return undefined; }
    if (name === "stageRm") {
      if (def.stages.length <= 1) return undefined;
      def.stages.splice(i, 1);
      for (let k = i; k <= def.stages.length; k++) { if (units[`s.${k + 1}`] === undefined) delete units[`s.${k}`]; else units[`s.${k}`] = units[`s.${k + 1}`]; }   // подсказки единиц съезжают вместе со стадиями
      return Math.min(i, def.stages.length - 1);
    }
    if (!s) return undefined;
    if (name === "dmgAdd") { if (s.damage.length < DMG_MAX) s.damage.push({ formula: "1d6", damageType: "poison" }); }
    else if (name === "dmgRm") s.damage.splice(j, 1);
    else if (name === "persOn") s.persistent ??= { formula: "1d6", damageType: "poison" };
    else if (name === "persOff") s.persistent = null;
    else if (name === "condRm") s.conditions.splice(j, 1);
    else if (name === "condStep") { const c = s.conditions[j]; if (c) c.value = Math.min(COND_VALUE_MAX, Math.max(1, (Number(c.value) || 0) + Number(r[2]))); }
    else if (name === "modAdd") modsEdit(s, (m) => modAdd(m, r[1]));
    else if (name === "modRm") modsEdit(s, (m) => modRemove(m, j));
    return undefined;
  });
}

const tightText = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Строка-сводка стадии: «1 р. · 6d6 яд · Тошнота 2». env: {t, damageLabel(тип), conditionLabel(slug)}. */
export function stageLine(s, env) {
  const { t } = env, dur = s.duration;
  const parts = [
    dur && t("workshop.au.dur", { value: dur.value, unit: t(`workshop.unitShort.${dur.unit}`) }),
    ...(s.damage ?? []).map((g) => `${g.formula} ${env.damageLabel(g.damageType)}`),
    s.persistent && `${s.persistent.formula} ${env.damageLabel(s.persistent.damageType)} ${t("workshop.au.affl.persShort")}`,
    ...(s.conditions ?? []).map((c) => `${env.conditionLabel(c.slug)}${c.value ? ` ${c.value}` : ""}`),
    s.mods?.length && t("workshop.au.affl.modsShort", { n: s.mods.length }),
    s.text && tightText(String(s.text))
  ].filter(Boolean);
  return parts.join(" · ") || "—";
}

/** Значение и единица срока для полей: пока значения нет, единица — запомненная. */
const durView = (d, mem) => ({ value: d?.value ?? "", unit: d?.unit ?? mem ?? "rounds" });

/** Значения для полей редактора; null — определение не читается. open — индекс раскрытой стадии (по умолчанию стадия шага). */
export function afflView(f, row, env, open = null) {
  const x = afflOf(row);
  if (!x) return null;
  ensure(f);
  const { def } = x, n = def.stages.length, stage = clampStage(x.stage, n), o = Math.min(n - 1, Math.max(0, open ?? stage - 1)), u = GROUP.get(row)?.units ?? {};
  const view = (s, i) => ({
    duration: durView(s.duration, u[`s.${i}`]), damage: s.damage ?? [], persistent: s.persistent ?? null, conditions: s.conditions ?? [], text: s.text ?? "",
    modsRow: stageModsRow(s)
  });
  return {
    name: def.name ?? "", kind: def.kind, statistic: def.save?.statistic, dc: def.save?.dc ?? "", maxDuration: durView(def.maxDuration, u.maxDuration), onset: durView(def.onset, u.onset), virulent: !!def.virulent, note: def.note ?? "",
    stage, n, shared: sharedPaths(f, row),
    stages: def.stages.map((s, i) => ({ i, line: stageLine(s, env), open: i === o, ...(i === o && { s: view(s, i) }) })),
    canAdd: n < MAX_STAGES, canRm: n > 1
  };
}
