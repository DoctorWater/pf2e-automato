// K6: вкладка «Автоматизация» в листе предмета (AppV1, plan.md §6). Только ГМ.
import { MOD, L, errText, DEGREES, callGM, forcedReplace, sluggify, damageLabel } from "./util.mjs";
import { S } from "./settings.mjs";
import { validateRule, activateSpells, activateUses, resolveRule, divergedOf, slugOf, sourceOf, DAMAGE_TYPES, FAILED_CHECK, FAILED_DEGREE } from "./rules.mjs";
import { automationsGroups } from "./compat.mjs";
import { hintsView, hintList } from "./hints.mjs";
import { resolveDC, safeUuid, uuidLabel } from "./saves.mjs";
import { defenseDc, pickStatistic, hasImmunity } from "./checks.mjs";
import { stepText } from "./chat.mjs";
import { castInfo } from "./cast.mjs";
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
const STEP_BLANK = { rankMin: "", rankMax: "", stack: false, stackBy: "", stackStart: "", unstack: false, replace: false, range: "", when: "", domain: "all", optOff: false, ofOrigin: false, dmgBasic: false, moveMode: "push", moveFrom: "origin" };
// у любого шага: круг от/до, условие when (строка опций через запятую или JSON), радиус союзников range; у эффекта: повтор увеличивает/уменьшает значок; rollOption — domain и «выключить»; removeEffect — ofOrigin
export const blankRow = () => ({ to: "target", kind: "condition", text: "", value: "", policy: "max", keep: "", ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK, ...STEP_BLANK });

// поля шага, которых нет в форме (who/mark/choice/unlessEffect): едут в строке JSON-ом и разворачиваются обратно в applyOf
const KEEP = ["who", "mark", "choice", "unlessEffect", "escape", "repeat", "sustain"];
const keepOf = (a) => { const k = Object.fromEntries(KEEP.filter((n) => a[n] != null).map((n) => [n, a[n]])); return Object.keys(k).length ? JSON.stringify(k) : ""; };   // dmgBasic — «обычное» испытание у шага damage

/** Строка keep <-> объект. Мастерская правит эти поля через keepGet/keepSet (automation.mjs), вкладка листа несёт строку скрытым полем data-r="keep". */
export function keepGet(row) {
  try { const k = row?.keep ? JSON.parse(row.keep) : {}; return k && typeof k === "object" && !Array.isArray(k) ? k : {}; } catch { return {}; }
}
export function keepSet(row, name, v) {
  const k = keepGet(row);
  if (v == null) delete k[name]; else k[name] = v;
  row.keep = Object.keys(k).length ? JSON.stringify(k) : "";
}

function rowOf(a) {
  return { ...rowCore(a), rankMin: a.rank?.min ?? "", rankMax: a.rank?.max ?? "", stack: a.effect?.badge === "increment", stackBy: a.effect?.by ?? "", stackStart: a.effect?.start ?? "", unstack: a.effect?.badge === "decrement", replace: !!a.effect?.replace,
    range: a.range ?? "", when: whenText(a.when), domain: a.rollOption?.domain ?? "all", optOff: a.rollOption?.value === false, ofOrigin: a.removeEffect?.of === "origin", dmgBasic: !!a.damage?.basic };
}

function rowCore(a) {
  const keep = keepOf(a), d = a.duration;
  const dur = d ? { durValue: d.value, durUnit: d.unit, durExpiry: d.expiry ?? "", durOf: d.of ?? "origin" } : DUR_BLANK;
  if (a.condition) return { to: a.to, kind: "condition", text: a.condition.slug, value: a.condition.value ?? "", policy: a.condition.policy ?? "max", keep, ...dur, ...VIS_BLANK, ...PERS_BLANK };
  // срок эффекта (переопределение): значение — число или кубик, единица и конец хода; «чей ход» у эффекта не бывает
  // inline-эффект (mods): кубики — JSON в text (как у choose), «чей ход» у него есть
  if (a.effect) return { to: a.to, kind: "effect", text: a.effect.mods ? JSON.stringify(a.effect.mods) : a.effect.uuid, value: "", policy: "max", keep, ...(d ? { ...dur, durOf: d.of ?? "origin" } : DUR_BLANK), ...VIS_BLANK, ...PERS_BLANK };
  // damage: формула — text, тип (или «healing») — pType; choose — JSON {from, options?, prompt?, range?} в text
  if (a.damage) return { to: a.to, kind: "damage", text: a.damage.formula, value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, pType: a.damage.damageType };
  if (a.move) return { to: a.to, kind: "move", text: String(a.move.distance), value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK, moveMode: a.move.mode, moveFrom: a.move.from === "point" ? "point" : "origin" };
  if (a.affliction) return { to: a.to, kind: "affliction", text: JSON.stringify(a.affliction), value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK };   // недуг едет JSON-ом `{stage, def}`; Мастерская правит его редактором (workshop/affliction-edit.mjs), вкладка листа — строкой
  if (a.coat) return { to: "self", kind: "coat", text: JSON.stringify(a.coat), coat: coatForm(a.coat), value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK };   // яд на оружие: Мастерская правит row.coat (модель формы), вкладка листа и записи без row.coat — JSON в text
  if (a.choose) return { to: "self", kind: "choose", text: JSON.stringify(a.choose), value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK };
  if (a.removeCondition) return { to: a.to, kind: "remove", text: a.removeCondition.slug, value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK };
  const plain = (kind, text, value = "") => ({ to: a.to, kind, text, value, policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK });
  if (a.removeEffect) return plain("removeEffect", a.removeEffect.slug ?? a.removeEffect.uuid);
  if (a.extendEffect) return plain("extendEffect", a.extendEffect.cast ? "*" : a.extendEffect.chosen ? "~" : a.extendEffect.slug, a.extendEffect.rounds);   // «*» вместо slug — cast:true (эффекты этого же сотворения), «~» — chosen:true (эффект, выбранный шагом выше)
  if (a.refundFocus) return plain("refundFocus", "");
  if (a.hold) return plain("hold", a.hold);
  if (a.rollOption) return plain("rollOption", a.rollOption.option);
  if (a.visibility) return { to: a.to, kind: "visibility", text: "", value: "", policy: "max", keep, ...DUR_BLANK, visLevel: a.visibility.level, visOf: a.visibility.of, visUntil: (a.visibility.until ?? []).join(", "), ...PERS_BLANK };
  if (a.persistent) return { to: a.to, kind: "persistent", text: a.persistent.formula, value: a.persistent.dc ?? "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, pType: a.persistent.damageType };
  return { to: a.to, kind: "note", text: a.note ?? "", value: "", policy: "max", keep, ...DUR_BLANK, ...VIS_BLANK, ...PERS_BLANK };
}

export function applyOf(r) {
  const out = applyCore(r);
  if (!out) return null;
  const keep = keepGet(r);
  // mark/choice валидны только у effect; пустые unlessEffect/choice — плашка включена, значения ещё нет: в правило не идут
  for (const n of KEEP) if (keep[n] != null && keep[n] !== "" && !((n === "mark" || n === "choice") && !out.effect)) out[n] = keep[n];
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
  if (r.kind === "refundFocus") return { to, refundFocus: true };
  if (r.kind === "move") return text ? { to: "target", move: { mode: ["pull", "choose"].includes(r.moveMode) ? r.moveMode : "push", distance: num(text), ...(r.moveFrom === "point" && r.moveMode !== "choose" && { from: "point" }) } } : null;
  if (r.kind === "damage") return text ? { to, damage: { formula: text, damageType: r.pType } } : null;
  if (r.kind === "visibility") {
    const until = csv(r.visUntil);
    return { to, visibility: { level: r.visLevel, of: r.visOf === "target" ? "target" : "self", ...(until.length && { until }) } };
  }
  if (r.kind === "coat" && r.coat) return { to: "self", coat: coatRule(r.coat) };   // модель Мастерской; без неё (вкладка листа) — JSON из text
  if (!text) return null;
  if (r.kind === "coat") {
    let coat = null;
    try { coat = JSON.parse(text); } catch { /* битый JSON уйдёт в валидатор */ }
    return { to: "self", coat: coat ?? {} };
  }
  if (r.kind === "affliction") {
    let affliction = null;
    try { affliction = JSON.parse(text); } catch { /* битый JSON уйдёт в валидатор */ }
    return { to: "target", affliction: affliction ?? {} };
  }
  if (r.kind === "effect") {
    const dt = String(r.durValue ?? "").trim(), dice = /^\d+d\d+$/i.test(dt) ? dt.toLowerCase() : num(dt);
    if (text.startsWith("[")) {   // JSON кубиков inline-эффекта; битый — пустой список, валидатор скажет об ошибке
      let mods = [];
      try { mods = JSON.parse(text); } catch { /* ошибка уйдёт в валидатор */ }
      return { to, effect: { mods }, ...(dice !== undefined && { duration: { value: dice, unit: r.durUnit, expiry: r.durExpiry || null, of: r.durOf === "target" ? "target" : "origin" } }) };
    }
    return { to, effect: { uuid: text, ...(r.stack ? { badge: "increment", ...(num(r.stackBy) > 1 && { by: num(r.stackBy) }), ...(num(r.stackStart) > 1 && { start: num(r.stackStart) }) } : r.unstack && { badge: "decrement" }), ...(r.replace && { replace: true }) },
      ...(dice !== undefined && { duration: { value: dice, unit: r.durUnit, expiry: r.durExpiry || null, ...(r.durOf === "target" && { of: "target" }) } }) };
  }
  if (r.kind === "hold") return { to, hold: text };
  if (r.kind === "removeEffect") return { to, removeEffect: { ...(/^[a-z0-9-]+$/.test(text) ? { slug: text } : { uuid: text }), ...(r.ofOrigin && { of: "origin" }) } };
  if (r.kind === "extendEffect") return { to, extendEffect: { ...(text === "*" ? { cast: true } : text === "~" ? { chosen: true } : { slug: text }), rounds: num(r.value) } };
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
// шаг coat <-> модель формы: срок (пустое значение — срока нет), испытание — та же форма ch, что у onUse; rest — прочие поля шага (валидатор о них скажет, а не промолчит)
const coatForm = (c) => {
  const { duration: d, challenge, ...rest } = c;
  return { durValue: d?.value ?? "", durUnit: d?.unit ?? "rounds", durExpiry: d?.expiry ?? "", ch: { ...chForm(challenge), on: true }, rest };
};
const coatRule = (c) => ({ weapon: "choose", ...c.rest, ...(num(c.durValue) !== undefined && { duration: { value: num(c.durValue), unit: c.durUnit, expiry: c.durExpiry || null } }), challenge: chRule(c.ch) });
/** Пустой шаг coat для Мастерской: испытание Стойкости с чертами «яд, ранение», СЛ вписывает ГМ. */
export const blankCoat = () => ({ durValue: "", durUnit: "rounds", durExpiry: "", rest: {}, ch: { ...chForm(null), on: true, statistic: "fortitude", traits: "poison, injury" } });
/** Пустая запись для кнопки «добавить событие». */
export const blankEvent = () => ({ on: "attack-roll", side: "self", when: "", once: false, afterUse: false, cost: false, free: "", aura: "", range: "", per: "", apply: [], ch: chForm(null) });
// side:"near" (T3): aura / range / per живут в форме всегда, в правило идут только у near
const evForm = (e) => ({ on: e.on, side: e.side ?? "self", when: whenText(e.when), hold: !!e.hold, once: !!e.once, afterUse: !!e.afterUse, cost: e.cost === "reaction", free: whenText(e.free), aura: e.aura ?? "", range: e.range ?? "", per: e.per ?? "", apply: (e.apply ?? []).map(rowOf), ch: { ...chForm(e.challenge), on: !!e.challenge }, check: e.check });   // check (Lingering Composition, Ты следующий) Мастерская не правит: едет в форме как есть
const nearZone = (e) => ({ ...(String(e.aura ?? "").trim() && { aura: String(e.aura).trim() }), ...(num(e.range) !== undefined && { range: num(e.range) }), ...(e.per && { per: e.per }) });
function evRule(e) {
  const when = parseWhen(e.when), free = e.cost ? parseWhen(e.free) : undefined;
  return { on: e.on, side: e.side, ...(when !== undefined && { when }), ...(e.hold && { hold: true }), ...(e.once && { once: true }), ...(e.afterUse && { afterUse: true }), ...(e.cost && { cost: "reaction", ...(free !== undefined && { free }) }), ...(e.side === "near" && nearZone(e)), apply: (e.apply ?? []).map(applyOf).filter(Boolean), ...(e.ch?.on && { challenge: chRule(e.ch) }), ...(e.check && { check: e.check }) };
}

// триггеры зоны (T2): запись onUse.zone.triggers <-> форма; испытание и шаги — как у onEvent
export const blankTrigger = () => ({ on: "turn-end", per: "", apply: [], ch: chForm(null) });
const trgForm = (t) => ({ on: t.on, per: t.per ?? "", apply: (t.apply ?? []).map(rowOf), ch: { ...chForm(t.challenge), on: !!t.challenge } });
const trgRule = (t) => ({ on: t.on, ...(t.per && { per: t.per }), ...((t.apply ?? []).length && { apply: t.apply.map(applyOf).filter(Boolean) }), ...(t.ch?.on && { challenge: chRule(t.ch) }) });

// cast (plan-cast-activation.md, plan-activate.md §8): активации <-> форма; поля строками, пустое — «не задано».
// kind: spell | steps | both (заклинание + шаги) | choice; шаги — модель use (цели, бросок, исход как у onUse правила), choices — варианты той же формы без частоты/требования.
const noNull = (v) => JSON.parse(JSON.stringify(v, (_k, x) => x ?? undefined));   // валидатор достраивает null-ключи — в правило их не несём
const kindOf = (c) => (c.choices ? "choice" : c.spell != null && c.onUse ? "both" : c.onUse ? "steps" : "spell");
// ранг и СЛ — общие у записи и варианта
const rkForm = (c) => ({
  rankMode: typeof c.rank === "object" ? `half-${c.rank.half}` : c.rank != null ? "value" : "base", rank: typeof c.rank === "number" ? c.rank : "", rankMin: c.rank?.min ?? 1,
  dcType: c.dc?.level ? "high" : c.dc?.against ? "class" : typeof c.dc === "number" ? "value" : "auto", dc: typeof c.dc === "number" ? c.dc : "",
  durValue: c.duration?.value ?? "", durUnit: c.duration?.unit ?? "minutes", durExpiry: c.duration?.expiry ?? "", imm: immForm(c.immunity)   // свой срок и иммунитет записи (при spell)
});
function rkRule(c, withSpell) {
  const m = c.rankMode ?? (num(c.rank) !== undefined ? "value" : "base"), rank = num(c.rank), dc = num(c.dc);
  const dt = String(c.durValue ?? "").trim(), dv = /^\d+d\d+$/i.test(dt) ? dt.toLowerCase() : num(dt);
  return {
    ...(withSpell && dv !== undefined && { duration: { value: dv, unit: c.durUnit, ...(c.durExpiry && { expiry: c.durExpiry }) } }), ...(withSpell && c.imm?.on && { immunity: immRule(c.imm) }),
    ...(withSpell && (m === "value" ? rank !== undefined && { rank } : m.startsWith("half-") && { rank: { half: m.slice(5), min: num(c.rankMin) ?? 1 } })),
    ...(c.dcType === "high" ? { dc: { level: "high" } } : c.dcType === "class" ? { dc: { against: "class-spell" } } : c.dcType === "value" && dc !== undefined && { dc })
  };
}
const usesSpell = (c) => c.kind === "spell" || c.kind === "both";
const usesSteps = (c) => c.kind === "steps" || c.kind === "both";
/** Шаги активации (onUse записи/варианта) <-> модель use: выборка из формы основного onUse; зона едет как есть (UI у неё нет). */
const USE_KEYS = ["targets", "excludeSelf", "pulse", "range", "zone", "ch", "ck", "apply"];
export const blankUse = () => ({ ...useForm(null), targets: "selected" });
function useForm(u) {
  const f = ruleToForm(u && typeof u === "object" ? { v: 1, onUse: u } : null);
  return Object.fromEntries(USE_KEYS.map((k) => [k, f[k]]));
}
/** use -> onUse активации; undefined, когда нет ни шагов, ни броска, ни зоны (тогда castRule не пишет onUse и валидатор говорит activate.kind). */
export function useRule(use) {
  if (!use || !(use.apply?.length || use.ch?.on || use.ck?.on || (use.targets === "area" && use.zone?.on))) return undefined;
  const u = noNull(formToRule({ kind: "onUse", ...use, macros: [] }).onUse);
  if (u.challenge?.dc && u.challenge.dc.value === undefined) delete u.challenge.dc;   // пусто: СЛ записи (иначе activate.dcForm)
  return u;
}
export const blankChoice = () => ({ id: "", label: "", kind: "spell", spell: "", use: blankUse(), ...rkForm({}) });
export const blankCast = () => ({ id: "", kind: "spell", spell: "", use: blankUse(), choices: [], ...rkForm({}), attack: "", counteract: "", perValue: "", perUses: "", perUnit: "days", requires: "auto", label: "", note: "" });
const choiceForm = (v) => ({ id: v.id, label: v.label ?? "", kind: kindOf(v), spell: v.spell ?? "", use: useForm(v.onUse), ...rkForm(v) });
const choiceRule = (v) => ({ ...(v.id?.trim() && { id: v.id.trim() }), ...(v.label?.trim() && { label: v.label.trim() }), ...(usesSpell(v) && String(v.spell ?? "").trim() && { spell: String(v.spell).trim() }), ...(usesSteps(v) && useRule(v.use) !== undefined && { onUse: useRule(v.use) }), ...rkRule(v, usesSpell(v)) });
const castForm = (c) => ({ id: c.id, kind: kindOf(c), spell: c.spell ?? "", use: useForm(c.onUse), choices: (c.choices ?? []).map(choiceForm), ...rkForm(c), attack: c.attack ?? "", counteract: c.counteract ?? "", perValue: c.per?.value ?? "", perUses: c.per?.uses ?? "", perUnit: c.per?.unit ?? "days", requires: c.requires ?? "auto", label: c.label ?? "", note: c.note ?? "" });
function castRule(c) {
  const attack = num(c.attack), counteract = num(c.counteract), pv = num(c.perValue), pu = num(c.perUses), kind = c.kind ?? "spell";
  return {
    ...(c.id?.trim() && { id: c.id.trim() }), ...(usesSpell(c) && String(c.spell ?? "").trim() && { spell: String(c.spell).trim() }), ...(usesSteps(c) && useRule(c.use) !== undefined && { onUse: useRule(c.use) }),
    ...(kind === "choice" && { choices: (c.choices ?? []).map(choiceRule) }), ...rkRule(c, usesSpell(c)),
    ...(usesSpell(c) && attack !== undefined && { attack }), ...(usesSpell(c) && counteract !== undefined && { counteract }),
    ...(pv !== undefined && { per: { value: pv, unit: c.perUnit, ...(pu !== undefined && { uses: pu }) } }),
    ...(c.requires && c.requires !== "auto" && { requires: c.requires }), ...(c.label?.trim() && { label: c.label.trim() }), ...(c.note?.trim() && { note: c.note.trim() })
  };
}

/** Форма вкладки листа + то, что на вкладке не правится и едет как было (иначе сохранение потеряет: флаг перекрывает каталог). f — ruleToForm исходного правила. */
export const carryUneditable = (form, f) => ({ ...form, ev: f.ev, cast: f.cast, pulse: f.pulse, range: f.range, dm: form.dm && { ...form.dm, notify: f.dm.notify }, fl: form.fl && { ...form.fl, notify: f.fl.notify } });

/** notify реакции: массив правила <-> флажки {owner, gm}; пустой выбор уходит валидатору (react.notify). */
const notifyForm = (n = ["owner", "gm"]) => ({ owner: n.includes("owner"), gm: n.includes("gm") });
const notifyRule = (n) => (Array.isArray(n) ? n : ["owner", "gm"].filter((k) => n[k] === true || n[k] === "true"));

export const DAMAGED_MODES = ["none", "reduce", "halve", "resist", "redirect"];
const dmForm = (d) => {
  const x = d?.damage ?? {};
  return {
    who: d?.who ?? "self", range: d?.range ?? "", withSelf: !!d?.withSelf, when: whenText(d?.when), requires: d?.requires ?? "",
    mode: x.reduce != null ? "reduce" : x.halve ? "halve" : x.resist ? "resist" : x.redirect ? "redirect" : "none",
    reduce: x.reduce ?? "", resist: x.resist?.length ? x.resist.map((r) => ({ type: r.type, value: r.value })) : [{ type: "triggering", value: "" }], part: x.part ?? "all",
    triggerOnly: !!d?.triggerOnly, hp: d?.cost?.hp ?? "", notify: notifyForm(d?.notify)
  };
};
const flForm = (d) => ({
  who: d?.who ?? "self", range: d?.range ?? "", withSelf: !!d?.withSelf, check: Object.fromEntries([...(d?.check ?? FAILED_CHECK), ...FAILED_CHECK].map((c) => [c, (d?.check ?? FAILED_CHECK).includes(c)])),   // порядок как в правиле
  degree: d?.degree ?? "fail", when: whenText(d?.when), requires: d?.requires ?? "", keep: d?.keep ?? "new", notify: notifyForm(d?.notify)
});
const trim = (s) => String(s ?? "").trim();
function dmRule(d) {
  const ally = d.who === "ally", r = num(d.range);
  const dmg = { reduce: () => ({ reduce: trim(d.reduce) }), halve: () => ({ halve: true }), redirect: () => ({ redirect: "self", part: d.part }),
    resist: () => ({ resist: Object.values(d.resist ?? {}).filter((x) => trim(x.type)).map((x) => ({ type: trim(x.type), value: trim(x.value) })) }) }[d.mode]?.();
  return {
    who: d.who, ...(ally && r !== undefined && { range: r }), ...(ally && d.withSelf && { withSelf: true }),
    ...(parseWhen(d.when) !== undefined && { when: parseWhen(d.when) }), ...(trim(d.requires) && { requires: trim(d.requires) }),
    ...(dmg && { damage: dmg }), ...(d.triggerOnly && { triggerOnly: true }), ...(trim(d.hp) && { cost: { hp: trim(d.hp) } }), ...(d.notify && { notify: notifyRule(d.notify) })
  };
}
function flRule(d) {
  const other = d.who !== "self", r = num(d.range);
  return {
    who: d.who, ...(other && r !== undefined && { range: r }), ...(other && d.withSelf && { withSelf: true }), check: Object.keys(d.check ?? {}).filter((c) => d.check[c] === true || d.check[c] === "true"),
    degree: d.degree, ...(parseWhen(d.when) !== undefined && { when: parseWhen(d.when) }), ...(trim(d.requires) && { requires: trim(d.requires) }), keep: d.keep, ...(d.notify && { notify: notifyRule(d.notify) })
  };
}

export function ruleToForm(rule) {
  const u = rule?.onUse, c = u?.challenge, k = u?.check, z = u?.zone, r = rule?.onAttacked;
  const vs = k?.vs ?? {};
  const dc = c?.dc ?? {};
  return {
    label: rule?.label ?? "", yield: tri(rule?.yield),
    kind: rule?.onDamaged ? "onDamaged" : rule?.onFailed ? "onFailed" : u ? "onUse" : r ? "onAttacked" : rule?.onEvent?.length ? "onEvent" : rule?.activate?.length ? "cast" : "none",
    ev: (rule?.onEvent ?? []).map(evForm), cast: (rule?.activate ?? []).map(castForm),
    dm: dmForm(rule?.onDamaged), fl: flForm(rule?.onFailed),
    useOn: !!u, targets: u?.targets ?? "self", excludeSelf: tri(u?.excludeSelf), pulse: u?.pulse ?? "", range: u?.range ?? null,   // range — дальность (оверлей/правило), в форме не редактируется, правка правила её не теряет
    zone: { on: !!z, cond: z?.condition?.slug ?? "", condValue: z?.condition?.value ?? "", effect: z?.effect?.uuid ?? "", seconds: z?.duration?.seconds ?? "", rounds: z?.duration?.rounds ?? "", until: z?.duration?.until ?? "", sustainMax: z?.duration?.sustainMax ?? "", noFollow: z?.follow === false, enterBy: z?.enterBy ?? "end", gone: z?.onCarrierGone ?? "close", trig: (z?.triggers ?? []).map(trgForm) },
    ch: {
      on: !!c, statistic: c?.statistic ?? "reflex",
      dcType: dc.expr === "markup" ? "markup" : dc.source ? "source" : dc.against != null ? "against" : dc.expr != null ? "expr" : "value",
      dcText: dc.value ?? (dc.expr === "markup" ? "" : dc.expr ?? dc.against ?? ""),
      basic: !!c?.basic, traits: (c?.traits ?? []).join(", "), options: (c?.options ?? []).join(", "), when: whenText(c?.when),
      dmgDeg: c?.damageByDegree ?? null,   // множители урона по степеням (не-basic): в форме не редактируются, но правка правила их не теряет
      imm: immForm(c?.immunity),
      deg: degRows(c?.byDegree)
    },
    ck: {
      on: !!k, statistic: [k?.statistic ?? "athletics"].flat().join(", "),
      vsType: !k ? "defense" : vs.dc != null ? "dc" : vs.against != null ? "against" : vs.defense != null ? "defense" : "none", vsText: vs.defense ?? vs.dc ?? vs.against ?? "will",
      traits: (k?.traits ?? []).join(", "), options: (k?.options ?? []).join(", "), map: String(k?.mapIncreases ?? ""), roll: k?.roll ?? "", when: whenText(k?.when), one: !!k?.oneRoll,
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
  const reacts = f.kind === "onDamaged" || f.kind === "onFailed";   // ответ-эффект реакции — тот же onUse.apply
  if (f.kind === "onUse" || reacts) {
    const u = { targets: f.targets, excludeSelf: untri(f.excludeSelf), zone: null, challenge: null, apply: (f.apply ?? []).map(applyOf).filter(Boolean) };
    if (f.pulse && f.targets !== "self") u.pulse = f.pulse;
    if (f.range) u.range = f.range;
    const z = f.zone ?? {};
    if (f.targets === "area" && z.on) {
      const cv = num(z.condValue), s = num(z.seconds), r = num(z.rounds), sm = num(z.sustainMax), until = z.until?.trim?.() || undefined;   // until/sustainMax — проброс (срок по ходу автора, zone.mjs), в форме не редактируются
      u.zone = {
        condition: z.cond?.trim() ? { slug: z.cond.trim(), ...(cv !== undefined && { value: cv }) } : null,
        effect: z.effect?.trim() ? { uuid: z.effect.trim() } : null,
        duration: s !== undefined || r !== undefined || until ? { ...(until && { until }), ...(s !== undefined && { seconds: s }), ...(r !== undefined && { rounds: r }), ...(until && sm !== undefined && { sustainMax: sm }) } : null,
        events: null
      };
      if (z.noFollow) u.zone.follow = false;
      if (z.enterBy === "path") u.zone.enterBy = "path";
      if (z.gone === "stay") u.zone.onCarrierGone = "stay";
      if (z.trig?.length) u.zone.triggers = z.trig.map(trgRule);
    }
    const c = f.ch;
    if (c?.on) {
      const t = String(c.dcText ?? "").trim();
      const dc = { value: () => ({ value: num(t) }), expr: () => ({ expr: t }), against: () => ({ against: t }), markup: () => ({ expr: "markup" }), source: () => ({ source: "spell" }) }[c.dcType]?.() ?? {};
      u.challenge = {
        statistic: c.statistic, dc, basic: !!c.basic, rollerRole: "target", byDegree: degSteps(c.deg), ...(c.dmgDeg && !c.basic && { damageByDegree: c.dmgDeg }),
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
        ...(parseWhen(k.when) !== undefined && { when: parseWhen(k.when) }), ...(k.one && !none && k.roll !== "system" && { oneRoll: true }),
        ...(k.imm?.on && { immunity: immRule(k.imm) })
      };
    }
    if (!reacts || u.apply.length || u.challenge || u.check || u.zone || u.pulse || u.range || f.useOn) rule.onUse = u;   // у реакции без ответа onUse не пишем
    if (f.kind === "onDamaged") rule.onDamaged = dmRule(f.dm);
    else if (f.kind === "onFailed") rule.onFailed = flRule(f.fl);
  } else if (f.kind === "onAttacked") {
    rule.onAttacked = {
      trigger: "attack-on-self", bonus: { stat: "ac", type: f.react.type, value: num(f.react.value) }, cost: "reaction",
      notify: [f.react.owner && "owner", f.react.gm && "gm"].filter(Boolean)
    };
  }
  if (f.ev?.length) rule.onEvent = f.ev.map(evRule);   // события живут рядом с любым видом правила
  if (f.cast?.length) rule.activate = f.cast.map(castRule);   // и активации тоже
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
  if (doc.type === "spell") return { kind: "spell", text: doc.parent ? doc._stats?.compendiumSource ?? data.uuid : data.uuid };   // активация cast: заклинание — по источнику
  return null;
}

/** Все UUID правила (эффекты, иммунитет, зона, макросы) — для предварительного разрешения имён. */
export function ruleUuids(rule) {
  const u = rule.onUse, ch = u?.challenge, ck = u?.check, z = u?.zone;
  const evs = (rule.onEvent ?? []).flatMap((e) => [...(e.apply ?? []), ...DEGREES.flatMap((d) => e.challenge?.byDegree?.[d] ?? [])]);
  const trgs = (z?.triggers ?? []).flatMap((t) => [...(t.apply ?? []), ...DEGREES.flatMap((d) => t.challenge?.byDegree?.[d] ?? [])]);
  const steps = [...(u?.apply ?? []), ...DEGREES.flatMap((d) => [...(ch?.byDegree?.[d] ?? []), ...(ck?.byDegree?.[d] ?? [])]), ...evs, ...trgs];
  return [...new Set([...steps.flatMap((a) => [a.effect?.uuid, a.removeEffect?.uuid]), ...(rule.activate ?? []).flatMap(activateSpells), ...activateUses(rule).flatMap((o) => ruleUuids({ onUse: o })), z?.effect?.uuid, ch?.immunity?.uuid, ck?.immunity?.uuid, ...(z?.triggers ?? []).map((t) => t.challenge?.immunity?.uuid), ...(rule.onEvent ?? []).map((e) => e.challenge?.immunity?.uuid), ...(rule.macros ?? []).map((m) => m.uuid)].filter((u) => u && !u.startsWith("builtin:")))];
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
  const steps = [...(u?.apply ?? []), ...DEGREES.flatMap((d) => [...(ch?.byDegree?.[d] ?? []), ...(ck?.byDegree?.[d] ?? [])]), ...activateUses(rule).flatMap((o) => [...(o.apply ?? []), ...DEGREES.flatMap((d) => o.challenge?.byDegree?.[d] ?? [])])];
  for (const a of steps) { if (a.condition) slugCheck(a.condition.slug); if (a.removeCondition) slugCheck(a.removeCondition.slug); if (a.effect?.uuid) uuidCheck(a.effect.uuid); if (a.removeEffect?.uuid) uuidCheck(a.removeEffect.uuid); }
  const z = u?.zone;
  if (z?.condition) slugCheck(z.condition.slug);
  if (z?.effect) uuidCheck(z.effect.uuid);
  if (ch?.immunity?.uuid) uuidCheck(ch.immunity.uuid);
  if (ck?.immunity?.uuid) uuidCheck(ck.immunity.uuid);
  for (const m of rule.macros ?? []) if (m.uuid && !m.uuid.startsWith("builtin:")) uuidCheck(m.uuid);   // builtin:<id> — встроенный обработчик, не UUID
  for (const c of rule.activate ?? []) activateSpells(c).forEach(uuidCheck);

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
  const cast = (rule.activate ?? []).map((c, i) => t("sheet.test.cast", { name: c.spell ? env.uuidName(c.spell) ?? c.spell : c.label ?? c.id, rank: typeof c.rank === "object" ? t(`workshop.au.cast.rankHalf.${c.rank.half}`, { min: c.rank.min }) : c.rank ?? "—", dc: env.cast?.[i]?.dc ?? "?" }));   // активации без сотворения: что и с какой СЛ получится
  return { problems: [...problems], apply: (u?.apply ?? []).map(step), cast, tokens: out };
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
  const cast = (rule.activate ?? []).map((c) => { const info = castInfo(item, c); return { dc: info.dc ?? (typeof c.dc === "number" ? c.dc : null) }; });
  // fromUuidSync бросает на вложенных UUID компендиев — разрешаем заранее асинхронно
  names ??= Object.fromEntries(await Promise.all(ruleUuids(rule).map(async (u) => [u, await uuidLabel(u)])));
  return {
    t: L, dc, author, cast,
    statLabel: (s) => { const k = CONFIG.PF2E.saves?.[s] ?? CONFIG.PF2E.skills?.[s]?.label ?? CONFIG.PF2E.attributes?.[s] ?? (s === "lore" ? "PF2E.Lore" : null); return k ? game.i18n.localize(k) : s; },
    conditionLabel: (slug) => (known(slug) ? game.i18n.localize(CONFIG.PF2E.conditionTypes[slug]) : slug),
    damageLabel, conditionKnown: known, uuidName: (uuid) => names[uuid] ?? null
  };
}

/** Пробный запуск формы на целях/выделенных токенах: только чтение, диалог с отчётом. */
async function testRun(item, rule) {
  const tokens = pickedTokens();
  if (!tokens.length && !rule.activate?.length) return ui.notifications.warn(L("sheet.test.noTokens"));
  const rep = buildReport(rule, tokens, await reportEnv(item, rule));
  const esc = foundry.utils.escapeHTML, ul = (a) => `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const content = [
    rep.problems.length && `<p><b>${L("sheet.test.problems")}</b></p>${ul(rep.problems)}`,
    rep.apply.length && `<p><b>${L("sheet.apply")}</b></p>${ul(rep.apply)}`,
    rep.cast.length && `<p><b>${L("sheet.test.castTitle")}</b></p>${ul(rep.cast)}`,
    ...rep.tokens.map((t) => `<h4>${esc(t.name)}</h4>${ul([...t.problems, ...t.lines])}`)
  ].filter(Boolean).join("");
  await foundry.applications.api.DialogV2.prompt({ window: { title: L("sheet.test.title") }, classes: ["paf-dialog"], content: `<div class="af-test">${content}</div>`, rejectClose: false,
    ok: { label: L("sheet.test.close"), icon: "fa-solid fa-xmark" } });   // пробный запуск ничего не применяет — не «Применить»
}

/** Подсказка о расхождении копии NPC с правилом каталога (разная для lost и other) или null. */
export const divergedHint = (dv) => (dv ? L(`sheet.divergedHint.${dv.kind}`, { states: dv.states.join(", ") }) : null);
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
  const dv = res?.diverged ?? divergedOf(item);
  const T = (k) => L(`sheet.${k}`);
  const keys = (prefix, list) => Object.fromEntries(list.map((k) => [k, T(`${prefix}.${k}`)]));
  return {
    f, slug, sourceUuid, groups, covered: groups.length > 0, settingYield: S.get("yieldToAutomations"),
    res: res && {
      source: T(`src.${res.source}`), src: res.source, low: res.confidence === "low", json: JSON.stringify(res.rule, null, 1),
      canAccept: res.source !== "flag", ruleAttr: JSON.stringify(res.rule),
      hints: res.source === "markup" && game.user.isGM ? hintLines(res.hints) : null
    },
    diverged: divergedHint(dv),
    isWorld: res?.source === "world",
    lockedFlag: !item.isOwner || !!item.compendium?.locked,
    noSource: !sourceUuid, noSlug: !slug,
    ch: {
      kind: choices({ ...keys("kind", ["onUse", "onAttacked"]), onDamaged: L("workshop.au.kind.onDamaged"), onFailed: L("workshop.au.kind.onFailed"), ...keys("kind", ["onEvent", "cast", "none"]) }),
      dmWho: choices(Object.fromEntries(["self", "familiar", "ally"].map((k) => [k, L(`workshop.au.react.whoBtn.${k}`)]))),
      flWho: choices(Object.fromEntries(["self", "ally", "any"].map((k) => [k, L(`workshop.au.react.whoBtn.${k}`)]))),
      dmMode: choices(Object.fromEntries(DAMAGED_MODES.map((k) => [k, L(`workshop.au.react.modeBtn.${k}`)]))),
      dmPart: choices({ all: L("workshop.au.react.partAll"), half: L("workshop.au.react.partHalf") }),
      flDegree: choices(Object.fromEntries(FAILED_DEGREE.map((k) => [k, L(`workshop.au.react.degBtn.${k}`)]))),
      flKeep: choices({ new: L("workshop.au.react.keepBtn.new"), higher: L("workshop.au.react.keepBtn.higher") }),
      flChecks: FAILED_CHECK.map((k) => ({ key: k, label: L(`workshop.au.react.chkBtn.${k}`) })),
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
      rowKind: choices(keys("row", ["condition", "effect", "note", "visibility", "persistent", "remove", "removeEffect", "extendEffect", "refundFocus", "rollOption", "damage", "choose", "move", "affliction", "coat", "hold"])),
      moveMode: choices(keys("moveMode", ["push", "pull"])),
      moveFrom: choices(keys("moveFrom", ["origin", "point"])),
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
  const read = () => carryUneditable(readForm(sec), bc.f);   // события, активации и прочее, чего вкладка не правит, — едут как были (carryUneditable)
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
    if (spec?.kind === "spell") return ui.notifications.warn(L("sheet.dropBad"));   // активации правятся в Мастерской
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
