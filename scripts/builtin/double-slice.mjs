// Двойной взмах: два Удара по одной цели (одно MAP на оба, у второго включён double-slice-second), при двух попаданиях — один
// общий бросок урона (сумма по типам, урон за точность один раз). Урон модуль не применяет — только карточка pf2e с кнопками.
import { L } from "../util.mjs";
import { esc, whisper } from "./lib.mjs";
import { isHit, twoWeaponCandidates, askStrikes, rollStrike, rollDamage, mapLabel } from "./strikes.mjs";

export { isHit, twoWeaponCandidates as candidates };

const OPTION = "double-slice-second";

/** Чистая: индекс следующего варианта MAP после двух атак с текущим i (0..2). */
export const nextMap = (i) => Math.min(2, i + 2);

/** Чистая: что делать с уроном по степеням двух Ударов. */
export function damagePlan(d1, d2) {
  const hits = [d1, d2].map((d, idx) => ({ idx, crit: d === 3 })).filter((h) => isHit([d1, d2][h.idx]));
  return { mode: ["none", "single", "both"][hits.length], hits };
}

/** Чистая: копия данных терма, где узлы с флавором flavor заменены нулём (урон за точность у слабейшего удара). */
export function stripFlavor(data, flavor) {
  if (Array.isArray(data)) return data.map((d) => stripFlavor(d, flavor));
  if (!data || typeof data !== "object") return data;
  if (data.class && String(data.options?.flavor ?? "").split(",").includes(flavor)) return { class: "NumericTerm", number: 0, evaluated: true, options: {} };
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, stripFlavor(v, flavor)]));
}

/** Чистая: сумма голов экземпляров в одно дерево данных (бинарные «+», каждый операнд в Grouping). */
export function sumHeads(heads) {
  const grp = (t) => ({ class: "Grouping", term: t, evaluated: true, options: {} });
  return heads.reduce((acc, h) => ({ class: "ArithmeticExpression", operator: "+", operands: [grp(acc), grp(h)], evaluated: true, options: {} }));
}

const precision = (roll) => roll.instances.reduce((s, i) => s + i.componentTotal("precision"), 0);
const keyOf = (i) => [i.type, i.persistent, [...i.materials].sort().join(",")].join("|");

/** Объединить два вычисленных DamageRoll: экземпляры одного типа суммируются (IWR применится к сумме один раз). */
export function mergeDamage(r1, r2) {
  const Roll = r1.constructor, Inst = r1.instances[0].constructor, Pool = r1.pool.constructor;
  const weaker = precision(r1) >= precision(r2) ? r2 : r1;
  const groups = new Map();
  for (const r of [r1, r2]) for (const inst of r.instances) {
    const g = groups.get(keyOf(inst)) ?? groups.set(keyOf(inst), { inst, heads: [] }).get(keyOf(inst));
    const json = inst.head.toJSON();
    g.heads.push(r === weaker ? stripFlavor(json, "precision") : json);
  }
  const rolls = [...groups.values()].map(({ inst, heads }) => {
    const data = heads.length === 1 ? heads[0] : sumHeads(heads);
    const merged = Inst.fromTerms([CONFIG.Dice.termTypes[data.class ?? "NumericTerm"].fromData(data)], foundry.utils.deepClone(inst.options));
    merged.critRule = inst.critRule;
    return merged;
  });
  const degree = Math.max(r1.options.degreeOfSuccess ?? 2, r2.options.degreeOfSuccess ?? 2);
  return Roll.fromTerms([Pool.fromRolls(rolls)], { ...r1.options, degreeOfSuccess: degree });
}

export async function run(scope) {
  const actor = scope.actor, target = scope.targets?.length === 1 ? scope.targets[0] : null;
  const name = scope.item?.name ?? L("builtin.double.title");
  if (!target?.actor) return void ui.notifications.warn(L("builtin.needOneTarget", { name }));
  const cands = twoWeaponCandidates(actor?.system?.actions ?? []);
  if (cands.length < 2) return void ui.notifications.warn(L("builtin.double.noWeapons", { name }));
  const setup = await askStrikes(cands, 2, { title: name, picks: [L("builtin.double.first"), L("builtin.double.second")], map: L("builtin.double.map"), ok: L("builtin.double.ok") });
  if (!setup) return;
  const [w1, w2] = setup.picks;
  if (w1 === w2) return void ui.notifications.warn(L("builtin.double.sameWeapon", { name }));
  const [a, b] = [cands[w1], cands[w2]];
  const mapIdx = setup.map;

  const first = await rollStrike(actor, a, mapIdx, target);
  const rule = actor.rules.find((r) => r.key === "RollOption" && r.option === OPTION);
  const prev = rule?.resolveValue?.();
  if (rule && !prev) await rule.toggle(true);
  let second;
  try { second = await rollStrike(actor, b, mapIdx, target, [OPTION]); }
  finally { if (rule && !prev) await rule.toggle(false); }
  if (first.degree == null || second.degree == null) return;

  const plan = damagePlan(first.degree, second.degree);
  const items = [a, b];
  if (plan.mode === "single") {
    const h = plan.hits[0];
    await rollDamage(actor, items[h.idx], mapIdx, target, h.crit, true);
  } else if (plan.mode === "both") {
    const [r1, r2] = await Promise.all(plan.hits.map((h) => rollDamage(actor, items[h.idx], mapIdx, target, h.crit, false)));
    if (r1 && r2) await postCombined(scope, [a, b], [r1, r2], plan, target, mapIdx, name);
  }
  await whisper(actor, L("builtin.double.next", { name, map: mapLabel(a, nextMap(mapIdx)) }), "double-slice");
}

async function postCombined(scope, [a, b], [r1, r2], plan, target, mapIdx, name) {
  const actor = scope.actor, token = scope.token;
  const flavor = `<h4 class="action"><strong>${esc(name)}</strong></h4><p>${esc(a.item.name)} + ${esc(b.item.name)}</p>`;
  const crit = plan.hits.some((h) => h.crit);
  const speaker = ChatMessage.getSpeaker({ actor, token });
  let roll;
  try { roll = mergeDamage(r1, r2); }
  catch (e) {
    console.error("pf2e-automato | double-slice merge", e);
    ui.notifications.warn(L("builtin.double.mergeFailed"));
    for (const r of [r1, r2]) await r.toMessage({ speaker, flavor });
    return;
  }
  const options = [...new Set([...actor.getSelfRollOptions("self"), ...a.item.getRollOptions("item"), ...b.item.getRollOptions("item")])].sort();
  const tgt = target.actor && target.uuid ? { actor: target.actor.uuid, token: target.uuid } : null;
  await roll.toMessage({
    speaker, flavor,
    flags: { pf2e: {
      context: {
        type: "damage-roll", sourceType: "attack", actor: actor.id, token: token?.id ?? null, target: tgt, domains: ["damage"], options,
        contextualOptions: {}, mapIncreases: mapIdx, notes: [], secret: false, traits: [], skipDialog: true,
        outcome: crit ? "criticalSuccess" : "success", unadjustedOutcome: null
      },
      target: tgt, modifiers: [], dice: [], origin: a.item.getOriginData?.() ?? null, strike: null
    } }
  });
}
