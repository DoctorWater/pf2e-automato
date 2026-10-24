// K6: вкладка «Автоматизация» в листе предмета (AppV1, plan.md §6). Только ГМ.
import { MOD, L, errText, DEGREES, callGM, forcedReplace, sluggify, damageLabel } from "./util.mjs";
import { S } from "./settings.mjs";
import { validateRule, resolveRule, slugOf, sourceOf, DAMAGE_TYPES } from "./rules.mjs";
import { automationsGroups } from "./compat.mjs";
import { hintsView, hintList } from "./hints.mjs";
import { resolveDC, safeUuid } from "./saves.mjs";
import { defenseDc, pickStatistic, hasImmunity } from "./checks.mjs";
import { stepText } from "./chat.mjs";
import { parseWhen, whenText } from "./predicate.mjs";

export const DENY = new Set(["condition", "effect", "ancestry", "heritage", "background", "class", "deity", "kit", "lore", "campaignFeature", "affliction", "melee"]);
const TEMPLATE = `modules/${MOD}/templates/sheet-tab.hbs`;
const TAB = "automato";

/* ---------- Чистая часть: правило <-> модель формы (node-тесты) ---------- */

const tri = (v) => (v === true ? "yes" : v === false ? "no" : "auto");
const untri = (s) => (s === "yes" ? true : s === "no" ? false : null);
const num = (s) => {
  const t = String(s ?? "").trim().replace(",", ".");
  return t !== "" && Number.isFinite(Number(t)) ? Number(t) : undefined;
};
const csv = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const DUR_BLANK = { durValue: "", durUnit: "rounds", durExpiry: "turn-start", durOf: "origin" };
const VIS_BLANK = { visLevel: "hidden", visOf: "self", visUntil: "" };
const PERS_BLANK = { pType: "fire" };   // продолжительный урон: формула — text, СЛ очистки — value
const STEP_BLANK = { rankMin: "", rankMax: "", stack: false, stackBy: "", stackStart: "", unstack: false, replace: false, range: "", when: "", domain: "all", optOff: false, ofOrigin: false, dmgBasic: false };
// у любого шага: круг от/до, условие when (строка опций через запятую или JSON), радиус союзников range; у эффекта: повтор увеличивает/уменьшает значок; rollOption — domain и «выключить»; removeEffect — ofOrigin
export const blankRow = () => ({ to: "target", kind: "condition", text: "", value: "", policy: "max", keep: "", ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK, ...STEP_BLANK });

// поля шага, которых нет в форме (who/mark/choice/unlessEffect): едут в строке JSON-ом и разворачиваются обратно в applyOf
const KEEP = ["who", "mark", "choice", "unlessEffect", "escape", "repeat"];
const keepOf = (a) => { const k = Object.fromEntries(KEEP.filter((n) => a[n] != null).map((n) => [n, a[n]])); return Object.keys(k).length ? JSON.stringify(k) : ""; };   // dmgBasic — «обычное» испытание у шага damage

function rowOf(a) {
  return { ...rowCore(a), rankMin: a.rank?.min ?? "", rankMax: a.rank?.max ?? "", stack: a.effect?.badge === "increment", stackBy: a.effect?.by ?? "", stackStart: a.effect?.start ?? "", unstack: a.effect?.badge === "decrement", replace: !!a.effect?.replace,
    range: a.range ?? "", when: whenText(a.when), domain: a.rollOption?.domain ?? "all", optOff: a.rollOption?.value === false, ofOrigin: a.removeEffect?.of === "origin", dmgBasic: !!a.damage?.basic };
}

function rowCore(a) {
  const keep = keepOf(a), d = a.duration;
  const dur = d ? { durValue: d.value, durUnit: d.unit, durExpiry: d.expiry ?? "", durOf: d.of ?? "origin" } : DUR_BLANK;
  if (a.condition) return { to: a.to, kind: "condition", text: a.condition.slug, value: a.condition.value ?? "", policy: a.condition.policy ?? "max", keep, ...dur, ...VIS_BLANK, ...PERS_BLANK };
  // срок эффекта (переопределение): значение — число или кубик, единица и конец хода; «чей ход» у эффекта не бывает
  if (a.effect) return { to: a.to, kind: "effect", text: a.effect.uuid, value: "", policy: "max", keep, ...(d ? { ...dur, durOf: "origin" } : DUR_BLANK), ...VIS_BLANK, ...PERS_BLANK };
  // damage: формула — text, тип (или «healing») — pType; choose — JSON {from, options?, prompt?, range?} в text
  if (a.damage) return { to: a.to, kind: "damage", text: a.damage.formula, value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, pType: a.damage.damageType };
  if (a.choose) return { to: "self", kind: "choose", text: JSON.stringify(a.choose), value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK };
  if (a.removeCondition) return { to: a.to, kind: "remove", text: a.removeCondition.slug, value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK };
  const plain = (kind, text, value = "") => ({ to: a.to, kind, text, value, policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK });
  if (a.removeEffect) return plain("removeEffect", a.removeEffect.slug ?? a.removeEffect.uuid);
  if (a.extendEffect) return plain("extendEffect", a.extendEffect.slug, a.extendEffect.rounds);
  if (a.rollOption) return plain("rollOption", a.rollOption.option);
  if (a.visibility) return { to: a.to, kind: "visibility", text: "", value: "", policy: "max", keep, ...DUR_BLANK, visLevel: a.visibility.level, visOf: a.visibility.of, visUntil: (a.visibility.until ?? []).join(", "), ...PERS_BLANK };
  if (a.persistent) return { to: a.to, kind: "persistent", text: a.persistent.formula, value: a.persistent.dc ?? "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, pType: a.persistent.damageType };
  return { to: a.to, kind: "note", text: a.note ?? "", value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK };
}

export function applyOf(r) {
  const out = applyCore(r);
  if (!out) return null;
  let keep = {};
  try { keep = r.keep ? JSON.parse(r.keep) : {}; } catch { /* битая строка: прочие поля не восстанавливаем */ }
  for (const n of KEEP) if (keep[n] != null && !((n === "mark" || n === "choice") && !out.effect)) out[n] = keep[n];   // mark/choice валидны только у effect
  if ((r.dmgBasic === true || r.dmgBasic === "true") && out.damage) out.damage.basic = true;   // «обычное» испытание: ×0 / ×½ / ×1 / ×2 по степени (допустимо только в byDegree испытания)
  const lo = num(r.rankMin), hi = num(r.rankMax);
  if (lo !== undefined || hi !== undefined) out.rank = { ...(lo !== undefined && { min: lo }), ...(hi !== undefined && { max: hi }) };
  const when = parseWhen(r.when);
  if (when !== undefined) out.when = when;
  if (out.to === "allies" && num(r.range) !== undefined) out.range = num(r.range);
  return out;
}

function applyCore(r) {
  const text = String(r.text ?? "").trim();
  const to = ["self", "party", "allies", "chosen"].includes(r.to) ? r.to : "target";
  if (r.kind === "choose") {
    let choose = null;
    try { choose = JSON.parse(text); } catch { /* битый JSON уйдёт в валидатор как пустой выбор */ }
    return { to: "self", choose: choose ?? {} };
  }
  if (r.kind === "damage") return text ? { to, damage: { formula: text, damageType: r.pType } } : null;
  if (r.kind === "visibility") {
    const until = csv(r.visUntil);
    return { to, visibility: { level: r.visLevel, of: r.visOf === "target" ? "target" : "self", ...(until.length && { until }) } };
  }
  if (!text) return null;
  if (r.kind === "effect") {
    const dt = String(r.durValue ?? "").trim(), dice = /^\d+d\d+$/i.test(dt) ? dt.toLowerCase() : num(dt);
    return { to, effect: { uuid: text, ...(r.stack ? { badge: "increment", ...(num(r.stackBy) > 1 && { by: num(r.stackBy) }), ...(num(r.stackStart) > 1 && { start: num(r.stackStart) }) } : r.unstack && { badge: "decrement" }), ...(r.replace && { replace: true }) },
      ...(dice !== undefined && { duration: { value: dice, unit: r.durUnit, expiry: r.durExpiry || null } }) };
  }
  if (r.kind === "removeEffect") return { to, removeEffect: { ...(/^[a-z0-9-]+$/.test(text) ? { slug: text } : { uuid: text }), ...(r.ofOrigin && { of: "origin" }) } };
  if (r.kind === "extendEffect") return { to, extendEffect: { slug: text, rounds: num(r.value) } };
  if (r.kind === "rollOption") return { to, rollOption: { domain: String(r.domain ?? "").trim() || "all", option: text, ...(r.optOff && { value: false }) } };
  if (r.kind === "remove") return { to, removeCondition: { slug: text } };
  if (r.kind === "persistent") { const dc = num(r.value); return { to, persistent: { formula: text, damageType: r.pType, ...(dc !== undefined && { dc }) } }; }
  if (r.kind === "note") return { to, note: text };
  const value = num(r.value);
  const dt = String(r.durValue ?? "").trim(), dv = /^\d+d\d+$/i.test(dt) ? dt.toLowerCase() : num(dt);
  return {
    to, condition: { slug: text, ...(value !== undefined && { value }), policy: ["add", "reduce"].includes(r.policy) ? r.policy : "max" },
    ...(dv !== undefined && { duration: { value: dv, unit: r.durUnit, expiry: r.durExpiry || null, of: r.durOf === "target" ? "target" : "origin" } })
  };
}

// иммунитет после действия: общий для испытания и проверки; нет degrees = при любой степени (все четыре отмечены)
const immForm = (im) => ({ on: !!im, slug: im?.slug ?? "", label: im?.label ?? "", uuid: im?.uuid ?? "", value: im?.duration?.value ?? "", unit: im?.duration?.unit ?? "minutes", any: im?.scope === "slug", deg: Object.fromEntries(DEGREES.map((d) => [d, !im?.degrees || im.degrees.includes(d)])) });
function immRule(im) {
  if (!im?.on) return null;
  const iv = num(im.value), on = DEGREES.filter((d) => im.deg?.[d] ?? true);
  return {
    slug: String(im.slug ?? "").trim(),
    ...(im.label?.trim() && { label: im.label.trim() }), ...(im.uuid?.trim() && { uuid: im.uuid.trim() }),
    ...(iv !== undefined && { duration: { value: iv, unit: im.unit } }),
    ...(im.any && { scope: "slug" }),
    ...(on.length < DEGREES.length && { degrees: on })
  };
}

const degRows = (byDegree) => Object.fromEntries(DEGREES.map((d) => [d, (byDegree?.[d] ?? []).map(rowOf)]));
const degSteps = (deg) => {
  const byDegree = {};
  for (const d of DEGREES) { const l = (deg?.[d] ?? []).map(applyOf).filter(Boolean); if (l.length) byDegree[d] = l; }
  return byDegree;
};

// onEvent (0.5g3): запись события <-> форма. Испытание записи переиспользует форму ch правила onUse (через временное правило), шаги — те же строки.
const chForm = (c) => ruleToForm(c ? { v: 1, onUse: { targets: "selected", challenge: c, apply: [] } } : null).ch;
const chRule = (ch) => formToRule({ kind: "onUse", targets: "selected", ch: { ...ch, on: true }, apply: [], macros: [] }).onUse.challenge;
/** Пустая запись для кнопки «добавить событие». */
export const blankEvent = () => ({ on: "attack-roll", side: "self", when: "", once: false, afterUse: false, apply: [], ch: chForm(null) });
const evForm = (e) => ({ on: e.on, side: e.side ?? "self", when: whenText(e.when), once: !!e.once, afterUse: !!e.afterUse, apply: (e.apply ?? []).map(rowOf), ch: { ...chForm(e.challenge), on: !!e.challenge } });
function evRule(e) {
  const when = parseWhen(e.when);
  return { on: e.on, side: e.side, ...(when !== undefined && { when }), ...(e.once && { once: true }), ...(e.afterUse && { afterUse: true }), apply: (e.apply ?? []).map(applyOf).filter(Boolean), ...(e.ch?.on && { challenge: chRule(e.ch) }) };
}

export function ruleToForm(rule) {
  const u = rule?.onUse, c = u?.challenge, k = u?.check, z = u?.zone, r = rule?.onAttacked;
  const vs = k?.vs ?? {};
  const dc = c?.dc ?? {};
  return {
    label: rule?.label ?? "", yield: tri(rule?.yield),
    kind: u ? "onUse" : r ? "onAttacked" : rule?.onEvent?.length ? "onEvent" : "none",
    ev: (rule?.onEvent ?? []).map(evForm),
    targets: u?.targets ?? "self", excludeSelf: tri(u?.excludeSelf),
    zone: { on: !!z, cond: z?.condition?.slug ?? "", condValue: z?.condition?.value ?? "", effect: z?.effect?.uuid ?? "", seconds: z?.duration?.seconds ?? "", rounds: z?.duration?.rounds ?? "" },
    ch: {
      on: !!c, statistic: c?.statistic ?? "reflex",
      dcType: dc.expr === "markup" ? "markup" : dc.source ? "source" : dc.against != null ? "against" : dc.expr != null ? "expr" : "value",
      dcText: dc.value ?? (dc.expr === "markup" ? "" : dc.expr ?? dc.against ?? ""),
      basic: !!c?.basic, traits: (c?.traits ?? []).join(", "), options: (c?.options ?? []).join(", "), when: whenText(c?.when),
      imm: immForm(c?.immunity),
      deg: degRows(c?.byDegree)
    },
    ck: {
      on: !!k, statistic: [k?.statistic ?? "athletics"].flat().join(", "),
      vsType: !k ? "defense" : vs.dc != null ? "dc" : vs.against != null ? "against" : vs.defense != null ? "defense" : "none", vsText: vs.defense ?? vs.dc ?? vs.against ?? "will",
      traits: (k?.traits ?? []).join(", "), options: (k?.options ?? []).join(", "), map: String(k?.mapIncreases ?? ""), roll: k?.roll ?? "",
      imm: immForm(k?.immunity),
      deg: degRows(k?.byDegree)
    },
    apply: (u?.apply ?? []).map(rowOf),
    react: { type: r?.bonus?.type ?? "circumstance", value: r?.bonus?.value ?? 2, owner: r ? r.notify.includes("owner") : true, gm: r ? r.notify.includes("gm") : true },
    macros: (rule?.macros ?? []).map((m) => ({ uuid: m.uuid ?? `builtin:${m.builtin}`, phase: m.phase, degree: m.degree ?? "", form: m.builtin ? "builtin" : "" }))
  };
}

/** Модель формы -> сырое правило (дальше validateRule). */
export function formToRule(f) {
  const rule = { v: 1, yield: untri(f.yield), onUse: null, onAttacked: null, macros: [], onTurn: null };
  if (f.label?.trim()) rule.label = f.label.trim();
  if (f.kind === "onUse") {
    const u = { targets: f.targets, excludeSelf: untri(f.excludeSelf), zone: null, challenge: null, apply: (f.apply ?? []).map(applyOf).filter(Boolean) };
    const z = f.zone ?? {};
    if (f.targets === "area" && z.on) {
      const cv = num(z.condValue), s = num(z.seconds), r = num(z.rounds);
      u.zone = {
        condition: z.cond?.trim() ? { slug: z.cond.trim(), ...(cv !== undefined && { value: cv }) } : null,
        effect: z.effect?.trim() ? { uuid: z.effect.trim() } : null,
        duration: s !== undefined || r !== undefined ? { ...(s !== undefined && { seconds: s }), ...(r !== undefined && { rounds: r }) } : null,
        events: null
      };
    }
    const c = f.ch;
    if (c?.on) {
      const t = String(c.dcText ?? "").trim();
      const dc = { value: () => ({ value: num(t) }), expr: () => ({ expr: t }), against: () => ({ against: t }), markup: () => ({ expr: "markup" }), source: () => ({ source: "spell" }) }[c.dcType]?.() ?? {};
      u.challenge = {
        statistic: c.statistic, dc, basic: !!c.basic, rollerRole: "target", byDegree: degSteps(c.deg),
        ...(csv(c.traits).length && { traits: csv(c.traits) }), ...(csv(c.options).length && { options: csv(c.options) }),
        ...(parseWhen(c.when) !== undefined && { when: parseWhen(c.when) }),
        ...(c.imm?.on && { immunity: immRule(c.imm) })
      };
    }
    const k = f.ck;
    if (k?.on) {
      const stats = csv(k.statistic), t = String(k.vsText ?? "").trim(), map = num(k.map);
      const vs = { defense: () => ({ defense: t }), dc: () => ({ dc: num(t) }), against: () => ({ against: t }) }[k.vsType]?.() ?? {};
      const none = k.vsType === "none";   // бросок без цели: СЛ задаёт система
      u.check = {
        statistic: stats.length > 1 ? stats : stats[0] ?? "", ...(!none && { vs }), byDegree: degSteps(k.deg),
        ...(csv(k.traits).length && { traits: csv(k.traits) }), ...(csv(k.options).length && { options: csv(k.options) }),
        ...(map !== undefined && { mapIncreases: map }), ...((none || k.roll === "system") && { roll: "system" }),
        ...(k.imm?.on && { immunity: immRule(k.imm) })
      };
    }
    rule.onUse = u;
  } else if (f.kind === "onAttacked") {
    rule.onAttacked = {
      trigger: "attack-on-self", bonus: { stat: "ac", type: f.react.type, value: num(f.react.value) }, cost: "reaction",
      notify: [f.react.owner && "owner", f.react.gm && "gm"].filter(Boolean)
    };
  }
  if (f.ev?.length) rule.onEvent = f.ev.map(evRule);   // события живут рядом с любым видом правила
  rule.macros = (f.macros ?? []).filter((m) => String(m.uuid ?? "").trim())
    .map((m) => ({ ...(m.form === "builtin" && m.uuid.trim().startsWith("builtin:") ? { builtin: m.uuid.trim().slice(8) } : { uuid: m.uuid.trim() }), phase: m.phase, ...(m.phase === "onDegree" && m.degree && { degree: m.degree }) }));
  return rule;
}

/* ---------- Чистая часть: бросок на форму, пробный запуск ---------- */

/** Что значит брошенное: data — drag-данные Foundry, doc — документ по uuid (для Item). -> {kind,text} | {macro} | null. */
export function dropSpec(data, doc) {
  if (data?.type === "Macro" && data.uuid) return { macro: data.uuid };
  if (data?.type !== "Item" || !data.uuid || !doc) return null;
  if (doc.type === "condition") return { kind: "condition", text: doc.system?.slug ?? sluggify(doc.name) };
  if (doc.type === "effect") {
    if (!doc.parent) return { kind: "effect", text: data.uuid };
    // вложенный эффект: его UUID временный, берём источник (компендиум)
    const src = doc._stats?.compendiumSource ?? doc.sourceId;
    return src ? { kind: "effect", text: src } : { temp: true };
  }
  return null;
}

/** Все UUID правила (эффекты, иммунитет, зона, макросы) — для предварительного разрешения имён. */
export function ruleUuids(rule) {
  const u = rule.onUse, ch = u?.challenge, ck = u?.check, z = u?.zone;
  const evs = (rule.onEvent ?? []).flatMap((e) => [...(e.apply ?? []), ...DEGREES.flatMap((d) => e.challenge?.byDegree?.[d] ?? [])]);
  const steps = [...(u?.apply ?? []), ...DEGREES.flatMap((d) => [...(ch?.byDegree?.[d] ?? []), ...(ck?.byDegree?.[d] ?? [])]), ...evs];
  return [...new Set([...steps.flatMap((a) => [a.effect?.uuid, a.removeEffect?.uuid]), z?.effect?.uuid, ch?.immunity?.uuid, ck?.immunity?.uuid, ...(rule.onEvent ?? []).map((e) => e.challenge?.immunity?.uuid), ...(rule.macros ?? []).map((m) => m.uuid)].filter((u) => u && !u.startsWith("builtin:")))];
}

const signed = (n) => (n >= 0 ? `+${n}` : String(n));
export const modOf = (st) => st?.check?.mod ?? st?.mod ?? 0;

/**
 * Отчёт пробного запуска, без записи в документы. rule — валидное правило, tokens — [{name, actor}].
 * env: {t, dc (СЛ испытания|null), author (Actor|null), statLabel, conditionLabel, conditionKnown(slug), uuidName(uuid) — по готовой карте}.
 * -> {problems: [], apply: [], tokens: [{name, lines: [], problems: []}]}
 */
export function buildReport(rule, tokens, env) {
  const { t } = env, u = rule.onUse, ch = u?.challenge, ck = u?.check;
  const problems = new Set();
  const step = (a) => stepText(a, env, "target");
  const slugCheck = (slug) => { if (!env.conditionKnown(slug)) problems.add(t("sheet.test.badSlug", { slug })); };
  const uuidCheck = (uuid) => { if (!env.uuidName(uuid)) problems.add(t("sheet.test.badUuid", { uuid })); };
  const byDeg = (bd) => DEGREES.slice().reverse().filter((d) => bd?.[d]?.length).map((d) => `${t(`sheet.degree.${d}`)}: ${bd[d].map(step).join("; ")}`);
  const steps = [...(u?.apply ?? []), ...DEGREES.flatMap((d) => [...(ch?.byDegree?.[d] ?? []), ...(ck?.byDegree?.[d] ?? [])])];
  for (const a of steps) { if (a.condition) slugCheck(a.condition.slug); if (a.removeCondition) slugCheck(a.removeCondition.slug); if (a.effect) uuidCheck(a.effect.uuid); if (a.removeEffect?.uuid) uuidCheck(a.removeEffect.uuid); }
  const z = u?.zone;
  if (z?.condition) slugCheck(z.condition.slug);
  if (z?.effect) uuidCheck(z.effect.uuid);
  if (ch?.immunity?.uuid) uuidCheck(ch.immunity.uuid);
  if (ck?.immunity?.uuid) uuidCheck(ck.immunity.uuid);
  for (const m of rule.macros ?? []) if (m.uuid && !m.uuid.startsWith("builtin:")) uuidCheck(m.uuid);   // builtin:<id> — встроенный обработчик, не UUID

  const authorStat = ck && env.author ? pickStatistic(env.author, ck.statistic) : null;
  if (ck && !env.author) problems.add(t("sheet.test.noOwner"));
  else if (ck && !authorStat) problems.add(t("sheet.test.noAuthorStat", { stat: [ck.statistic].flat().join("/") }));
  if (ch && env.dc == null) problems.add(t("sheet.test.dcUnknown"));

  const out = (tokens ?? []).map(({ name, actor }) => {
    const lines = [], tp = [];
    if (ch) {
      const st = pickStatistic(actor, ch.statistic);
      if (!st) tp.push(t("saves.noStatistic", { name, stat: ch.statistic }));
      else lines.push(t("sheet.test.challenge", { stat: env.statLabel(ch.statistic), mod: signed(modOf(st)), dc: env.dc ?? "?" }));
      if (hasImmunity(actor, ch.immunity, env.author?.uuid)) lines.push(t("sheet.test.immune"));
      lines.push(...byDeg(ch.byDegree));
    }
    if (ck) {
      const dc = ck.vs ? defenseDc(actor, ck.vs) : null;
      if (ck.vs && dc == null) tp.push(t("checks.dcUnknown", { name }));
      if (authorStat) lines.push(t(ck.vs ? "sheet.test.check" : "sheet.test.checkSelf", { stat: env.statLabel(authorStat.slug ?? ck.statistic), mod: signed(modOf(authorStat)), dc: dc ?? "?" }));
      if (hasImmunity(actor, ck.immunity, env.author?.uuid)) lines.push(t("sheet.test.immune"));
      lines.push(...byDeg(ck.byDegree));
    }
    return { name, lines, problems: tp };
  });
  return { problems: [...problems], apply: (u?.apply ?? []).map(step), tokens: out };
}

/* ---------- DOM ---------- */

const getPath = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
const val = (el) => (el.type === "checkbox" ? el.checked : el.value);

function readForm(root) {
  const f = {};
  // <template> с прототипами строк не попадает в querySelectorAll (inert fragment)
  for (const el of root.querySelectorAll("[data-f]")) foundry.utils.setProperty(f, el.dataset.f, val(el));
  for (const list of root.querySelectorAll(".af-rows[data-list]")) {
    const rows = [...list.querySelectorAll(":scope > .af-row")].map((r) => {
      const o = {};
      for (const el of r.querySelectorAll("[data-r]")) o[el.dataset.r] = val(el);
      return o;
    });
    foundry.utils.setProperty(f, list.dataset.list, rows);
  }
  return f;
}

/** data-showif="path=a|b" — видимость блоков по состоянию формы; предупреждение о двойном применении. */
function syncUi(root) {
  const f = readForm(root);
  for (const el of root.querySelectorAll("[data-showif]")) {
    const [path, vals] = el.dataset.showif.split("=");
    el.hidden = !vals.split("|").includes(String(getPath(f, path)));
  }
  const warn = root.querySelector(".af-warn");
  if (warn) warn.hidden = !(warn.dataset.covered === "1" && (f.yield === "no" || (f.yield === "auto" && warn.dataset.setting !== "1")));
}

/** Цели пробного запуска: целевые токены, иначе выделенные. */
export function pickedTokens() {
  const picked = game.user.targets.size ? [...game.user.targets] : canvas.tokens?.controlled ?? [];
  return picked.filter((t) => t.actor).map((t) => ({ name: t.name, actor: t.actor }));
}

/** Окружение для buildReport/stepText по живому миру. names — карта uuid -> имя, если уже разрешена (иначе разрешаем здесь). */
export async function reportEnv(item, rule, names = null) {
  const author = item.actor ?? null;
  const dc = rule.onUse?.challenge ? await resolveDC({ rule }, { item, actor: author }).catch(() => null) : null;
  const known = (slug) => !!CONFIG.PF2E.conditionTypes?.[slug];
  // fromUuidSync бросает на вложенных UUID компендиев — разрешаем заранее асинхронно
  names ??= Object.fromEntries(await Promise.all(ruleUuids(rule).map(async (u) => [u, (await safeUuid(u))?.name ?? null])));
  return {
    t: L, dc, author,
    statLabel: (s) => { const k = CONFIG.PF2E.saves?.[s] ?? CONFIG.PF2E.skills?.[s]?.label ?? CONFIG.PF2E.attributes?.[s]; return k ? game.i18n.localize(k) : s; },
    conditionLabel: (slug) => (known(slug) ? game.i18n.localize(CONFIG.PF2E.conditionTypes[slug]) : slug),
    damageLabel, conditionKnown: known, uuidName: (uuid) => names[uuid] ?? null
  };
}

/** Пробный запуск формы на целях/выделенных токенах: только чтение, диалог с отчётом. */
async function testRun(item, rule) {
  const tokens = pickedTokens();
  if (!tokens.length) return ui.notifications.warn(L("sheet.test.noTokens"));
  const rep = buildReport(rule, tokens, await reportEnv(item, rule));
  const esc = foundry.utils.escapeHTML, ul = (a) => `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const content = [
    rep.problems.length && `<p><b>${L("sheet.test.problems")}</b></p>${ul(rep.problems)}`,
    rep.apply.length && `<p><b>${L("sheet.apply")}</b></p>${ul(rep.apply)}`,
    ...rep.tokens.map((t) => `<h4>${esc(t.name)}</h4>${ul([...t.problems, ...t.lines])}`)
  ].filter(Boolean).join("");
  await foundry.applications.api.DialogV2.prompt({ window: { title: L("sheet.test.title") }, classes: ["paf-dialog"], content: `<div class="af-test">${content}</div>`, rejectClose: false,
    ok: { label: L("sheet.test.close"), icon: "fa-solid fa-xmark" } });   // пробный запуск ничего не применяет — не «Применить»
}

const choices = (o) => Object.entries(o).map(([value, label]) => ({ value, label }));

function hintLines(hints) {
  const v = hintsView(hints, { condLabel: (s) => game.i18n.localize(CONFIG.PF2E.conditionTypes?.[s] ?? s), degLabel: (d) => L(`sheet.degree.${d}`).toLowerCase() });
  return v.isEmpty ? null : { possible: v.possible.length ? L("sheet.hintPossible", { list: hintList(v.possible) }) : null, excluded: v.excluded.length ? L("sheet.hintExcluded", { list: hintList(v.excluded) }) : null };
}

function buildContext(item, draft) {
  const res = resolveRule(item);
  const slug = res?.slug ?? slugOf(null, item), sourceUuid = res?.sourceUuid ?? sourceOf(null, item);
  const groups = automationsGroups({ slug, sourceUuid });
  const f = draft ?? ruleToForm(res?.rule ?? null);
  const T = (k) => L(`sheet.${k}`);
  const keys = (prefix, list) => Object.fromEntries(list.map((k) => [k, T(`${prefix}.${k}`)]));
  return {
    f, slug, sourceUuid, groups, covered: groups.length > 0, settingYield: S.get("yieldToAutomations"),
    res: res && {
      source: T(`src.${res.source}`), src: res.source, low: res.confidence === "low", json: JSON.stringify(res.rule, null, 1),
      canAccept: res.source !== "flag", ruleAttr: JSON.stringify(res.rule),
      hints: res.source === "markup" && game.user.isGM ? hintLines(res.hints) : null
    },
    isWorld: res?.source === "world",
    lockedFlag: !item.isOwner || !!item.compendium?.locked,
    noSource: !sourceUuid, noSlug: !slug,
    ch: {
      kind: choices(keys("kind", ["onUse", "onAttacked", "onEvent", "none"])),
      yield: choices(keys("yield", ["auto", "yes", "no"])),
      targets: choices(keys("targets", ["self", "selected", "area"])),
      tri: choices({ auto: T("yield.auto"), yes: T("yes"), no: T("no") }),
      dcType: choices(keys("dc", ["value", "expr", "markup", "source", "against"])),
      vsType: choices(keys("vs", ["defense", "dc", "against", "none"])),
      defense: ["ac", "fortitude", "reflex", "will", "perception"],
      durUnit: choices(keys("unit", ["rounds", "minutes", "hours", "days"])),
      immUnit: choices(keys("unit", ["minutes", "hours", "days"])),
      expiry: choices({ "": T("expiry.none"), "turn-start": T("expiry.start"), "turn-end": T("expiry.end") }),
      durOf: choices(keys("of", ["origin", "target"])),
      map: ["", "0", "1", "2"].map((v) => ({ value: v, label: v || "-" })),
      stat: choices(keys("stat", ["reflex", "fortitude", "will", "perception", "flat"])),
      to: choices(keys("to", ["self", "target", "party", "allies", "chosen"])),
      rowKind: choices(keys("row", ["condition", "effect", "note", "visibility", "persistent", "remove", "removeEffect", "extendEffect", "rollOption", "damage", "choose"])),
      dmgType: [{ value: "healing", label: L("workshop.au.healing") }, ...DAMAGE_TYPES.map((v) => ({ value: v, label: damageLabel(v) }))],   // «лечение» — только у шага damage
      visLevel: choices(keys("vis.level", ["concealed", "hidden", "undetected", "unnoticed"])),
      visOf: choices(keys("vis.of", ["self", "target"])),
      policy: choices(keys("policy", ["max", "add", "reduce"])),
      phase: choices(keys("phase", ["onUse", "afterChallenge", "onDegree", "zoneEnter", "zoneExit", "onReaction"])),
      degree: choices({ "": T("anyDegree"), ...keys("degree", DEGREES) })
    },
    degrees: [...DEGREES].reverse().map((d) => ({ key: d, label: T(`degree.${d}`), rows: f.ch.deg[d] ?? [], immOn: f.ch.imm.deg[d] })),
    ckDegrees: [...DEGREES].reverse().map((d) => ({ key: d, label: T(`degree.${d}`), rows: f.ck.deg[d] ?? [], immOn: f.ck.imm.deg[d] })),
    blankRow: blankRow(), blankMacro: { uuid: "", phase: "onUse", degree: "" }
  };
}

async function inject(app, $html) {
  const item = app.item ?? app.document;
  const root = $html[0] ?? $html;
  if (!game.user.isGM || !item || DENY.has(item.type)) return;
  const nav = root.querySelector("nav.sheet-tabs .tabs"), body = root.querySelector(".sheet-body");
  if (!nav || !body || body.querySelector(`.tab.${TAB}`)) return;

  const wasActive = !!app._afTab;
  nav.addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) app._afTab = t.dataset.tab === TAB; });
  nav.insertAdjacentHTML("beforeend", `<a class="list-row" data-tab="${TAB}">${L("sheet.tab")}</a>`);
  const bc = buildContext(item, app._afDraft);
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE, bc);
  if (!root.isConnected || body.querySelector(`.tab.${TAB}`)) return;   // лист успел перерисоваться
  body.insertAdjacentHTML("beforeend", html);
  // bind() Tabs отработал до нас и сбросил активную вкладку на первую — вернуть нашу
  if (wasActive) app._tabs?.[0]?.activate(TAB);

  const sec = body.querySelector(`.tab.${TAB}`);
  const errBox = sec.querySelector(".af-errors");
  const read = () => ({ ...readForm(sec), ev: bc.f.ev });   // события на вкладке не правятся (Мастерская) — едут как были, иначе сохранение их потеряет
  const draft = () => { app._afDraft = read(); syncUi(sec); };
  const build = () => {
    const v = validateRule(formToRule(read()));
    errBox.replaceChildren(...v.errors.map((e) => Object.assign(document.createElement("li"), { textContent: errText(e) })));
    return v.ok ? v.rule : null;
  };
  const toast = (res) => (res?.ok ? ui.notifications.info(L("sheet.saved")) : ui.notifications.error(`${L("sheet.failed")}: ${res?.error ?? res?.reason ?? "?"}`));
  const worldKey = (scope) => (scope === "source" ? { source: sourceOf(null, item) } : { slug: slugOf(null, item) });

  // Бросок в нашу вкладку: глотаем событие, чтобы не дошло до drop-обработчиков листа pf2e (они навешены через ondrop на предков)
  sec.addEventListener("dragover", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
  sec.addEventListener("drop", async (ev) => {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(ev);
    if (!data?.type) return;   // обычный текст — штатное поведение полей
    ev.preventDefault(); ev.stopPropagation();
    const spec = dropSpec(data, data?.type === "Item" ? await safeUuid(data.uuid) : null);
    const field = ev.target.closest("[data-drop]");
    const list = ev.target.closest(".af-rows") ?? ev.target.closest(".af-degree, .af-block")?.querySelector(":scope > .af-rows");
    if (spec?.temp) return ui.notifications.warn(L("sheet.dropTemp"));
    if (spec && field && spec.kind === (field.dataset.drop === "slug" ? "condition" : "effect")) field.value = spec.text;
    else if (spec && !field && list && !spec.macro === (list.dataset.list !== "macros")) {
      let row = ev.target.closest(".af-row");
      if (!row || !list.contains(row)) {
        list.append(sec.querySelector(`template[data-proto="${spec.macro ? "macro" : "row"}"]`).content.cloneNode(true));
        row = list.lastElementChild;
      }
      if (spec.macro) row.querySelector('[data-r="uuid"]').value = spec.macro;
      else { row.querySelector('[data-r="kind"]').value = spec.kind; row.querySelector('[data-r="text"]').value = spec.text; }
    } else return ui.notifications.warn(L("sheet.dropBad"));
    draft();
  });
  sec.addEventListener("input", draft);
  sec.addEventListener("change", draft);
  sec.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-action]");
    if (!b || b.disabled) return;
    const act = b.dataset.action;
    if (act === "add-row") {
      sec.querySelector(`.af-rows[data-list="${b.dataset.list}"]`).append(sec.querySelector(`template[data-proto="${b.dataset.proto}"]`).content.cloneNode(true));
      return draft();
    }
    if (act === "remove-row") { b.closest(".af-row").remove(); return draft(); }
    try {
      if (act === "test") { const r = build(); if (r) await testRun(item, r); }
      else if (act === "save-flag") { const r = build(); if (r) { app._afDraft = null; await item.update(forcedReplace(`flags.${MOD}.rule`, r)); ui.notifications.info(L("sheet.saved")); } }
      else if (act === "reset-flag") { app._afDraft = null; await item.unsetFlag(MOD, "rule"); }
      else if (act === "accept") { app._afDraft = null; await item.update(forcedReplace(`flags.${MOD}.rule`, JSON.parse(b.dataset.rule))); }
      else if (act === "save-world") { const r = build(); if (r) toast(await callGM("saveCatalogRule", worldKey(b.dataset.scope), r)); }
      else if (act === "open-workshop") await game.modules.get(MOD).api.openWorkshop({ item, mode: "automation" });
      else if (act === "delete-world") { toast(await callGM("saveCatalogRule", worldKey(b.dataset.scope), null)); app._afDraft = null; app.render(); }
    } catch (e) { console.error(`${MOD} | sheet`, e); ui.notifications.error(String(e?.message ?? e)); }
  });
  syncUi(sec);
}

export function init() {
  Hooks.on("renderItemSheetPF2e", (app, $html) => { inject(app, $html).catch((e) => console.error(`${MOD} | sheet`, e)); });
}
