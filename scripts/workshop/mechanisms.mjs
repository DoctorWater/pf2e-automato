// «Работает само»: встроенные механизмы без правила (M1 перезарядка, M2 требование, M3 Удар → способность, M5 манёвры, M6 постоянное состояние,
// M7 перенос ПЗ, M8 метамагия) — строки Мастерской и вкладки листа. Признак берётся теми же чистыми функциями, что решают в рантайме (второго
// разбора нет: строка не разойдётся с работой); состояния — те же проверки режимов и уступки, что в рантайме, и только они.
// Без Foundry при импорте: env (подписи, режимы, уступка) передаётся снаружи (liveEnv — для окна и листа).
import { L } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { shouldYield } from "../compat.mjs";
import { mechOf, formToMech, pruneMech, rechargePending, rechargeBase, rechargeTextOf, isUseItem, MANEUVERS } from "../mech.mjs";
import { limitEntry, slugOf } from "../rules.mjs";
import { critRecharges, isBreath } from "../builtin/limit-text.mjs";
import { needText } from "../builtin/impulse-gate.mjs";
import { maneuversAuto, SPELLS, TITLE } from "../builtin/maneuver.mjs";
import { strikeLinkState, modesRun } from "../strike-link.mjs";
import { permanentBase, hasCondDoc, grantsCond } from "../builtin/neutralize-rules.mjs";
import { SLUG as SPIRIT, plan as spiritPlan } from "../builtin/spirit-link.mjs";
import { optionOf } from "../builtin/spellshape.mjs";
import { itemSlug } from "../builtin/lib.mjs";
import { F } from "./fields.mjs";

export const MECH_IDS = ["recharge", "req", "strike", "maneuvers", "permanent", "spirit", "shape"];

/** Дыхание у актёра с «Драконьим импульсом» и подобным: критический Удар перезаряжает его (limit-text.critRecharges). */
const critOf = (item) => isBreath(item.system?.traits?.value, slugOf(null, item))
  && [...(item.actor?.items ?? [])].some((i) => ["action", "feat", "effect"].includes(i.type) && critRecharges(slugOf(null, i), i.system?.description?.value));

/** Признак механизма у предмета (без переопределения предмета): данные для строки или null. */
const DETECT = {
  recharge: (item) => {
    const r = rechargeTextOf(item), items = [...(item.actor?.items ?? [])], nameOf = (id) => items.find((i) => i.id === id)?.name;
    if (r?.ids.length) return { dice: r.dice, conditional: r.conditional, crit: critOf(item), self: r.ids.includes(item.id), targets: r.ids.filter((id) => id !== item.id).map(nameOf).filter(Boolean) };
    // замок на этом предмете ставит другая способность актёра (Feed on Fear → Consume Light): своего броска нет, строка — пометка
    const src = items.filter((i) => i.id !== item.id && rechargeBase(i)?.ids.includes(item.id));
    return src.length ? { dice: rechargeBase(src[0]).dice, foreign: true, from: src.map((i) => i.name) } : null;
  },
  req: (item) => { const e = isUseItem(item) ? limitEntry(item)?.req : null; return e?.any?.length ? { any: e.any } : null; },
  strike: (item, env) => (env.strikeState ?? strikeLinkState)(item),
  maneuvers: (item) => { const auto = maneuversAuto(item); return auto.length ? { auto, all: SPELLS[itemSlug(item)] ?? auto } : null; },
  permanent: (item) => { const p = permanentBase(item, item?.actor?.type); return p ? { p, own: grantsCond(item.system?.rules, p) || hasCondDoc(item.actor, p.cond) } : null; },
  spirit: (item) => (item?.type === "spell" && itemSlug(item) === SPIRIT ? {} : null),
  shape: (item) => (optionOf(item) ? {} : null)
};

/** Найденные механизмы предмета: [{id, data}]. Тяжёлое (M3 читает правила актёра) — вызывать один раз на загрузку предмета. */
export function detectMechs(item, env = {}) {
  const out = [];
  for (const id of MECH_IDS) { const data = item ? DETECT[id](item, env) : null; if (data) out.push({ id, data }); }
  return out;
}

/** Режим выключен; button — «По кнопке» тоже не даёт срабатывать само (только применение шагов M3): подпись режима — из настроек. */
const modeOff = (env, kind, button = false) => {
  const v = env.mode(kind);
  return v === "off" || (button && v === "button") ? { text: env.t(v === "button" ? "workshop.mech.state.modeButton" : "workshop.mech.state.mode", { mode: env.t(`settings.mode.${kind}.name`) }) } : null;
};
const flagOff = (env, key = "flag") => ({ text: env.t(`workshop.mech.state.${key}`) });
const yields = (env, o) => (env.yields(o) ? { text: env.t("workshop.mech.state.yield"), warn: true } : null);

/** Состояние строки: причины по порядку рантайма (предмет → режим → уступка); null — работает. m — переопределения (черновик окна или сохранённые). */
function stateOf(id, data, item, env, m) {
  switch (id) {
    case "recharge": return data.foreign ? modeOff(env, "limits") : m.recharge === false ? flagOff(env) : modeOff(env, "limits");
    case "req": return m.req === false ? flagOff(env) : modeOff(env, "limits");
    case "strike": {
      if (m.strike === false) return flagOff(env);
      if (data.needRule) return { text: env.t(data.noOutcome ? "workshop.mech.state.needOutcome" : "workshop.mech.state.needRule"), warn: true };
      const ev = data.rule.onEvent[0];   // режим и уступка — по текущим настройкам на каждый рендер, в data кэшируется только признак связи
      if ((env.mode("effect") === "off" && env.mode("challenge") === "off") || !modesRun(ev, env.mode)) {   // шаги записи не исполняются: испытание выключено или применение не «авто» (effect = по кнопке тоже)
        const kind = ev.challenge && env.mode("challenge") === "off" ? "challenge" : "effect";
        return modeOff(env, kind, kind === "effect") ?? { text: env.t("workshop.mech.state.mode", { mode: env.t(`settings.mode.${kind}.name`) }) };
      }
      return env.yields(data.ids ?? {}, data.rule) ? { text: env.t("workshop.mech.state.yield"), warn: true } : null;
    }
    case "maneuvers": case "shape": return modeOff(env, "macro");
    case "permanent": return m.permanent === false ? flagOff(env, data.own ? "flagReact" : "flag") : modeOff(env, "effect");
    case "spirit": return modeOff(env, "macro") ?? yields(env, { slug: SPIRIT });
    default: return null;
  }
}

function sumOf(id, data, item, env, m) {
  const t = env.t;
  switch (id) {
    case "recharge": {
      if (data.foreign) return t("workshop.mech.sum.rechargeFrom", { from: data.from.map((n) => `«${n}»`).join(", "), dice: data.dice });
      const rc = m.recharge;
      if (rc && typeof rc === "object") return rc.dice || data.dice ? t("workshop.mech.sum.rechargeButton", { dice: rc.dice || data.dice }) : t("workshop.mech.sum.rechargeNone");
      if (data.none) return typeof rc === "string" ? t("workshop.mech.sum.recharge", { dice: rc }) : t("workshop.mech.sum.rechargeNone");
      if (data.conditional && rc === undefined) return data.dice ? t("workshop.mech.sum.rechargeCond", { dice: data.dice }) : t("workshop.mech.sum.rechargeCondNo");
      return `${t(data.self ? (data.targets.length ? "workshop.mech.sum.rechargeShared" : "workshop.mech.sum.recharge") : "workshop.mech.sum.rechargeOther", { dice: m.recharge || data.dice, names: data.targets.map((n) => `«${n}»`).join(", ") })}${data.crit ? ` ${t("workshop.mech.sum.rechargeCrit", { name: item.name })}` : ""}`;
    }
    case "req": return t("workshop.mech.sum.req", { need: data.any.map((cl) => env.needText(cl)).join(t("builtin.limit.or")) });
    case "strike": {
      const strike = data.strikes.map((s) => s.name).join(", "), p = env.evParts?.(data.rule);
      if (p?.save && p.fail) return t("workshop.mech.sum.strike", { strike, stat: p.save.stat, dc: p.save.dc, fail: p.fail });
      return p?.steps ? t("workshop.mech.sum.strikeSteps", { strike, steps: p.steps }) : t("workshop.mech.sum.strikeShort", { strike });
    }
    case "maneuvers": {
      const own = m.maneuvers?.filter((k) => data.all.includes(k)), list = own?.length ? own : data.auto;
      return t(list.length === 1 ? "workshop.mech.sum.maneuversOne" : "workshop.mech.sum.maneuvers", { list: list.map((k) => env.loc(TITLE[k])).join(", ") });
    }
    case "permanent": return t(data.own ? "workshop.mech.sum.permanentOwn" : "workshop.mech.sum.permanent", { cond: env.condLabel(data.p.cond) });
    case "spirit": { const rank = item.rank ?? 1; return t("workshop.mech.sum.spirit", { n: spiritPlan({ rank, casterHp: 1e9, targetHp: 0, targetMax: 1e9 }).n, rank }); }
    case "shape": return t("workshop.mech.sum.shape", { name: item.name });
    default: return "";
  }
}

const isOn = (v) => v === true || v === "true";

/** Поля переопределения (только Мастерская: f — черновик mechToForm). Нет полей — строка неразворачиваемая. Переключатель «Работает ⇄ Выключено в предмете» — один на все строки. */
function fieldsOf(id, data, f, env) {
  const t = env.t, locked = !!env.locked;
  const sw = (key, hint) => { const off = isOn(f[key].off); return F.sw(`mech.${key}.off`, t(off ? "workshop.mech.switchOff" : "workshop.mech.switchOn"), !off, { disabled: locked, hint, aria: t("workshop.mech.switchOn") }); };   // aria — постоянное имя переключателя; видимый текст меняется с состоянием, состояние передаёт checked
  switch (id) {
    case "recharge": {
      if (data.foreign) return [];
      // всегда три варианта; режим без переопределения (default) показывается тем из них, что найден в тексте (у добавленной вручную текста нет — «Нет»)
      // условная без срока в тексте (разные броски): рабочего варианта по тексту нет — как «Нет», кнопки не будет, пока срок не задан
      const found = data.none || (data.conditional && data.dice == null) ? "off" : data.conditional ? "button" : "auto", mode = f.recharge.mode === "default" ? found : f.recharge.mode;
      const lbl = (v, key) => t(key) + (v === found && v !== "off" ?` ${t("workshop.mech.f.rcByText")}` : "");
      const seg = [["off", lbl("off", "workshop.mech.f.rcOff")], ["auto", lbl("auto", "workshop.mech.f.rcAuto")], ["button", lbl("button", "workshop.mech.f.rcButton")]];
      return [
        F.seg("mech.recharge.mode", t("workshop.mech.f.rechargeMode"), mode, seg, { disabled: locked }),   // у добавленной «Нет» = убрать строку
        F.text("mech.recharge.dice", t("workshop.mech.f.dice"), f.recharge.dice, { inpCls: "ws-num", placeholder: data.dice ?? "", hint: data.dice ? t("workshop.mech.f.diceHint", { dice: data.dice }) : t("workshop.mech.f.diceHintNone"), disabled: locked || !["auto", "button"].includes(mode) })
      ];
    }
    case "req": return [sw("req")];
    case "strike": return [sw("strike")];
    case "permanent": return [sw("permanent", t(data.own ? "workshop.mech.f.permanentOwn" : "workshop.mech.f.permanent", { cond: env.condLabel(data.p.cond) }))];
    case "maneuvers": {
      if (data.all.length < 2) return [];   // единственный манёвр (Magnetic Attraction): выбирать нечего
      const auto = isOn(f.maneuvers.auto);
      return [
        F.seg("mech.maneuvers.auto", t("workshop.mech.f.maneuvers"), String(auto), [["true", t("workshop.mech.f.auto")], ["false", t("workshop.mech.f.manual")]], { disabled: locked }),
        ...(auto ? [] : [{ path: "mech.maneuvers.list", label: t("workshop.mech.f.maneuversPick"), disabled: locked, seg: MANEUVERS.filter((k) => data.all.includes(k)).map((k) => ({ value: k, label: env.loc(TITLE[k]), on: isOn(f.maneuvers.list[k]), path: `mech.maneuvers.list.${k}` })) }])
      ];
    }
    default: return [];
  }
}

/** Значения по умолчанию найденных механизмов — для pruneMech/formToMech. */
export const mechBase = (dets) => {
  const rc = dets?.find((d) => d.id === "recharge" && !d.data.foreign)?.data;   // режим по умолчанию: распознанная — авто, условная — по кнопке, нераспознанной нет
  return { dice: rc?.dice, rc: rc && !(rc.conditional && rc.dice == null) ? (rc.conditional ? "button" : "auto") : "none", rcCond: !!rc?.conditional, maneuvers: dets?.find((d) => d.id === "maneuvers")?.data.auto };
};

/** Перезарядку можно добавить вручную: способность/заклинание/черта, в тексте которых перезарядки нет и которых не перезаряжает другая способность актёра. */
export const canAddRecharge = (dets, item) => isUseItem(item) && !dets.some((d) => d.id === "recharge");

const KEYED =new Set(["recharge", "req", "strike", "maneuvers", "permanent"]);

/**
 * Строки раздела: [{id, chip, tip, sum, state, custom, draft, fields}]. form — черновик mechToForm (null — только показ: вкладка листа, считается по сохранённому).
 * Сводка и состояние — от черновика; draft — часть строки ещё не сохранена; custom — своё значение (срок, список манёвров).
 */
export function mechRows(dets, item, env, form = null) {
  const base = mechBase(dets), saved = pruneMech(mechOf(item), base), m = form ? formToMech(form, base) : saved;
  const rows = canAddRecharge(dets, item) && (m.recharge || ["auto", "button"].includes(form?.recharge.mode)) ? [{ id: "recharge", data: { none: true } }, ...dets] : dets;   // добавленная вручную: строки в разборе нет
  return rows.map(({ id, data }) => ({
    id, chip: id === "shape" ? env.loc("PF2E.TraitSpellshape") : env.t(`workshop.mech.chip.${id}`),   // термин метамагии — из pf2e (его переводит pf2ru)
    tip: env.t(`workshop.mech.tip.${id === "recharge" && (data.none || data.conditional) ? (data.none ? "rechargeAdded" : "rechargeCond") : id}`, id === "strike" ? { strike: data.strikes.map((s) => s.name).join(", ") } : undefined),
    sum: sumOf(id, data, item, env, m), state: stateOf(id, data, item, env, m),
    custom: (id === "recharge" && !!m.recharge) || (id === "maneuvers" && !!m.maneuvers),
    draft: KEYED.has(id) && (JSON.stringify(m[id]) !== JSON.stringify(saved[id]) || (id === "recharge" && rechargePending(form))),
    removable: !!data.none,   // добавленную вручную перезарядку можно убрать крестиком
    fields: form ? fieldsOf(id, data, form, env) : []
  }));
}

/** Статус подвала: с правками — «несохранённые», без — две части: источник правила и «Работает само». */
export function footStatus(t, { dirty, source, mechs, mechSaved }) {
  if (dirty) return t("workshop.au.dirty");
  const src = source === "flag" ? t("workshop.au.ruleItem") : source ? t(`sheet.src.${source}`) : t("workshop.au.ruleNone");
  return t("workshop.au.statusRule", { src }) + (mechs || mechSaved ? ` · ${t("workshop.au.statusMech", { state: t(mechSaved ? "workshop.au.mechChanged" : "workshop.au.mechDefault") })}` : "");
}

export const mechanismsOf = (item, env, form = null) => mechRows(detectMechs(item, env), item, env, form);

/** Окружение в Foundry: подписи, режимы, уступка. extra — evParts (части фразы записи M3) и locked. */
export const liveEnv = (item, extra = {}) => ({
  t: (k, d) => L(k, d), loc: (k) => game.i18n.localize(k), mode: modeOf, yields: (o, rule = null) => shouldYield(rule, o),
  needText: (cl) => needText(cl, item.actor), condLabel: (s) => { const k = globalThis.CONFIG?.PF2E?.conditionTypes?.[s]; return k ? game.i18n.localize(k) : s; }, ...extra
});
