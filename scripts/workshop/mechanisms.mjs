// «Работает само»: встроенные механизмы без правила (M1 перезарядка, M2 требование, M3 Удар → способность, M5 манёвры, M6 постоянное состояние,
// M7 перенос ПЗ, M8 метамагия) — строки Мастерской и вкладки листа. Признак берётся теми же чистыми функциями, что решают в рантайме (второго
// разбора нет: строка не разойдётся с работой); состояния — те же проверки режимов и уступки, что в рантайме, и только они.
// Без Foundry при импорте: env (подписи, режимы, уступка) передаётся снаружи (liveEnv — для окна и листа).
import { L } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { shouldYield } from "../compat.mjs";
import { mechOf, rechargeBase, isUseItem, MANEUVERS } from "../mech.mjs";
import { limitEntry, slugOf } from "../rules.mjs";
import { critRecharges, isBreath } from "../builtin/limit-text.mjs";
import { needText } from "../builtin/impulse-gate.mjs";
import { maneuversAuto, SPELLS, TITLE } from "../builtin/maneuver.mjs";
import { strikeLinkState } from "../strike-link.mjs";
import { permanentBase, hasCondDoc } from "../builtin/neutralize-rules.mjs";
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
  recharge: (item) => { const r = rechargeBase(item); return r ? { dice: r.dice, crit: critOf(item) } : null; },
  req: (item) => { const e = isUseItem(item) ? limitEntry(item)?.req : null; return e?.any?.length ? { any: e.any } : null; },
  strike: (item, env) => (env.strikeState ?? strikeLinkState)(item),
  maneuvers: (item) => { const auto = maneuversAuto(item); return auto.length ? { auto, all: SPELLS[itemSlug(item)] ?? auto } : null; },
  permanent: (item) => { const p = permanentBase(item, item?.actor?.type); return p ? { p, own: (item.system?.rules ?? []).some((r) => r?.key === "GrantItem") || hasCondDoc(item.actor, p.cond) } : null; },
  spirit: (item) => (item?.type === "spell" && itemSlug(item) === SPIRIT ? {} : null),
  shape: (item) => (optionOf(item) ? {} : null)
};

/** Найденные механизмы предмета: [{id, data}]. Тяжёлое (M3 читает правила актёра) — вызывать один раз на загрузку предмета. */
export function detectMechs(item, env = {}) {
  const out = [];
  for (const id of MECH_IDS) { const data = item ? DETECT[id](item, env) : null; if (data) out.push({ id, data }); }
  return out;
}

const modeOff = (env, kind) => (env.mode(kind) === "off" ? { text: env.t("workshop.mech.state.mode", { mode: env.t(`settings.mode.${kind}.name`) }) } : null);
const flagOff = (env) => ({ text: env.t("workshop.mech.state.flag") });
const yields = (env, o) => (env.yields(o) ? { text: env.t("workshop.mech.state.yield"), warn: true } : null);

/** Состояние строки: причины по порядку рантайма (предмет → режим → уступка); null — работает. */
function stateOf(id, data, item, env, m) {
  switch (id) {
    case "recharge": return m.recharge === false ? flagOff(env) : modeOff(env, "limits");
    case "req": return m.req === false ? flagOff(env) : modeOff(env, "limits");
    case "strike": {
      if (data.off === "flag") return flagOff(env);
      if (data.off === "needRule") return { text: env.t("workshop.mech.state.needRule"), warn: true };
      if (data.off === "mode") {   // шаги записи не исполняются: испытание выключено или применение не «авто» (effect = по кнопке тоже)
        const kind = data.rule.onEvent[0].challenge && env.mode("challenge") === "off" ? "challenge" : "effect";
        return { text: env.t("workshop.mech.state.mode", { mode: env.t(`settings.mode.${kind}.name`) }) };
      }
      return data.off === "yield" ? { text: env.t("workshop.mech.state.yield"), warn: true } : null;
    }
    case "maneuvers": case "shape": return modeOff(env, "macro");
    case "permanent": return m.permanent === false ? flagOff(env) : modeOff(env, "effect");
    case "spirit": return modeOff(env, "macro") ?? yields(env, { slug: SPIRIT });
    default: return null;
  }
}

function sumOf(id, data, item, env) {
  const t = env.t;
  switch (id) {
    case "recharge": return `${t("workshop.mech.sum.recharge", { dice: mechOf(item).recharge || data.dice })}${data.crit ? ` ${t("workshop.mech.sum.rechargeCrit")}` : ""}`;
    case "req": return t("workshop.mech.sum.req", { need: data.any.map((cl) => env.needText(cl)).join(t("builtin.limit.or")) });
    case "strike": {
      const strike = data.strikes.map((s) => s.name).join(", "), line = env.evText?.(data.rule);
      return line ? t("workshop.mech.sum.strike", { strike, line }) : t("workshop.mech.sum.strikeShort", { strike });
    }
    case "maneuvers": return t("workshop.mech.sum.maneuvers", { list: data.auto.map((k) => env.loc(TITLE[k])).join(", ") });
    case "permanent": return t(data.own ? "workshop.mech.sum.permanentOwn" : "workshop.mech.sum.permanent", { cond: env.condLabel(data.p.cond) });
    case "spirit": { const rank = item.rank ?? 1; return t("workshop.mech.sum.spirit", { n: spiritPlan({ rank, casterHp: 1e9, targetHp: 0, targetMax: 1e9 }).n, rank }); }
    case "shape": return t("workshop.mech.sum.shape", { name: item.name });
    default: return "";
  }
}

/** Поля переопределения (только Мастерская: form — черновик mechToForm). Нет полей — строка неразворачиваемая. */
function fieldsOf(id, data, f, env) {
  const t = env.t, dis = { disabled: !!env.locked };
  switch (id) {
    case "recharge": return [
      F.text("mech.recharge.dice", t("workshop.mech.f.dice"), f.recharge.dice, { inpCls: "ws-num", placeholder: data.dice, hint: t("workshop.mech.f.diceHint", { dice: data.dice }) }),
      F.chk("mech.recharge.off", t("workshop.mech.f.rechargeOff"), f.recharge.off, dis)
    ];
    case "req": return [F.chk("mech.req.off", t("workshop.mech.f.reqOff"), f.req.off, dis)];
    case "strike": return [F.chk("mech.strike.off", t("workshop.mech.f.strikeOff"), f.strike.off, dis)];
    case "permanent": return [F.chk("mech.permanent.off", t("workshop.mech.f.permanentOff"), f.permanent.off, dis)];
    case "maneuvers": {
      if (data.all.length < 2) return [];   // единственный манёвр (Magnetic Attraction): выбирать нечего
      const auto = f.maneuvers.auto === true || f.maneuvers.auto === "true";
      return [
        F.seg("mech.maneuvers.auto", t("workshop.mech.f.maneuvers"), String(auto), [["true", t("workshop.mech.f.auto")], ["false", t("workshop.mech.f.manual")]]),
        ...(auto ? [] : [{ path: "mech.maneuvers.list", label: t("workshop.mech.f.maneuversPick"), seg: MANEUVERS.filter((k) => data.all.includes(k)).map((k) => ({ value: k, label: env.loc(TITLE[k]), on: f.maneuvers.list[k] === true || f.maneuvers.list[k] === "true", path: `mech.maneuvers.list.${k}` })) }])
      ];
    }
    default: return [];
  }
}

/** Строки раздела: [{id, chip, tip, sum, state, fields}]. form — черновик mechToForm (null — только показ: вкладка листа). */
export function mechRows(dets, item, env, form = null) {
  const m = mechOf(item);
  return dets.map(({ id, data }) => ({
    id, chip: id === "shape" ? env.loc("PF2E.TraitSpellshape") : env.t(`workshop.mech.chip.${id}`),
    tip: env.t(`workshop.mech.tip.${id}`, id === "strike" ? { strike: data.strikes.map((s) => s.name).join(", ") } : undefined),
    sum: sumOf(id, data, item, env), state: stateOf(id, data, item, env, m), fields: form ? fieldsOf(id, data, form, env) : []
  }));
}

export const mechanismsOf = (item, env, form = null) => mechRows(detectMechs(item, env), item, env, form);

/** Окружение в Foundry: подписи, режимы, уступка. extra — evText (строка записи M3) и locked. */
export const liveEnv = (item, extra = {}) => ({
  t: (k, d) => L(k, d), loc: (k) => game.i18n.localize(k), mode: modeOf, yields: (o) => shouldYield(null, o),
  needText: (cl) => needText(cl, item.actor), condLabel: (s) => { const k = globalThis.CONFIG?.PF2E?.conditionTypes?.[s]; return k ? game.i18n.localize(k) : s; }, ...extra
});
