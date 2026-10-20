// X6. Обманка: реакция — проверка атаки огнестрельным оружием/арбалетом, чтобы Помочь атаке союзника (СЛ 15, +1 обстоятельства,
// если с начала прошлого хода наносили урон этому врагу этим оружием). Бросает игрок (диалог: оружие, союзник, +1); бонус по степени
// ставит ГМ (finish) эффектом на союзника — pf2e снимает его после броска с этим бонусом (removeAfterRoll) или в конце хода.
import { L } from "../util.mjs";
import { esc, effectSource, UNTIL_TURN_END } from "./lib.mjs";

export const AID_DC = 15;
const SLUG = "af-fake-out-aid";

/** Чистая: бонус обстоятельства по степени «Помочь»; крит. успех — +2, у мастера +3, у легенды +4 (rank 0..4). */
export const aidBonus = (degree, rank = 0) => (degree === 3 ? (rank >= 4 ? 4 : rank === 3 ? 3 : 2) : ({ 2: 1, 1: 0, 0: -1 })[degree] ?? 0);

/** Чистая: огнестрельное оружие или арбалет; один предмет — один раз. */
export function gunCandidates(strikes) {
  const seen = new Set();
  return strikes.filter((s) => {
    const it = s.item;
    if (!it?.isOfType?.("weapon") || seen.has(it.id)) return false;
    const gun = ["firearm", "crossbow"].includes(it.system?.group) || it.system?.traits?.value?.includes("crossbow");
    return gun && seen.add(it.id);
  });
}

/** Чистая: эффект бонуса союзнику на его ближайший бросок атаки. */
export const aidEffect = (name, bonus, origin, target) => {
  const e = effectSource({ name, duration: UNTIL_TURN_END, origin, target,
    rules: [{ key: "FlatModifier", selector: ["strike-attack-roll", "spell-attack-roll"], type: "circumstance", value: bonus, label: name, removeAfterRoll: true }] });
  e.system.slug = SLUG;
  return e;
};

async function ask(cands, allies) {
  const opt = (list, lab) => list.map((x, i) => `<option value="${i}">${esc(lab(x))}</option>`).join("");
  const res = await foundry.applications.api.DialogV2.wait({
    window: { title: L("builtin.fakeOut.title") }, rejectClose: false,
    content: `<div class="form-group"><label>${L("builtin.strike.weapon")}</label><select name="w">${opt(cands, (s) => s.item.name)}</select></div>
      <div class="form-group"><label>${L("builtin.fakeOut.ally")}</label><select name="a">${opt(allies, (t) => t.name)}</select></div>
      <div class="form-group"><label><input type="checkbox" name="hurt"> ${L("builtin.fakeOut.hurt")}</label></div>`,
    buttons: [{ action: "ok", label: L("builtin.fakeOut.roll"), default: true,
      callback: (_e, b) => ({ w: Number(b.form.elements.w.value), a: Number(b.form.elements.a.value), hurt: b.form.elements.hurt.checked }) }]
  });
  return res && typeof res === "object" ? res : null;
}

export async function run(scope) {
  const actor = scope.actor, name = scope.item?.name ?? L("builtin.fakeOut.title");
  const cands = gunCandidates(actor?.system?.actions ?? []);
  if (!cands.length) return void ui.notifications.warn(L("builtin.fakeOut.noGun", { name }));
  const me = scope.token?.object ?? actor.getActiveTokens()[0];
  const allies = canvas.tokens.placeables.filter((t) => t !== me && t.actor && t.document.disposition === (me?.document.disposition ?? 1));
  if (!allies.length) return void ui.notifications.warn(L("builtin.fakeOut.noAlly", { name }));
  const pick = await ask(cands, allies);
  if (!pick) return;
  const strike = cands[pick.w], ally = allies[pick.a];
  const mods = pick.hurt ? [new game.pf2e.Modifier({ label: name, slug: "fake-out", modifier: 1, type: "circumstance" })] : [];
  const roll = await game.pf2e.Check.roll(new game.pf2e.CheckModifier(name, strike, mods), {
    actor, token: me?.document ?? null, type: "check", dc: { value: AID_DC }, skipDialog: true,
    options: new Set([...actor.getRollOptions(["all", "attack-roll"]), ...(strike.options ?? []), ...strike.item.getRollOptions("item")]),
    domains: [], title: `${name}: ${strike.item.name}`
  });
  const degree = roll?.degreeOfSuccess ?? null;
  const bonus = degree == null ? 0 : aidBonus(degree, actor.getProficiencyRank?.(strike.item) ?? 0);
  return bonus ? { ally: ally.document.uuid, bonus } : undefined;
}

/** У ГМа: эффект бонуса на союзника. Результат мог прийти с клиента игрока — бонус и союзник проверяются. */
export async function finish(result, scope) {
  if (![-1, 1, 2, 3, 4].includes(result?.bonus)) return;
  const t = await fromUuid(result.ally), me = scope.token ?? scope.actor?.getActiveTokens(false, true)[0];
  if (!t?.actor || t.parent !== me?.parent || t.disposition !== me?.disposition) return;
  const name = scope.item?.name ?? L("builtin.fakeOut.title");
  const label = `${name}: ${result.bonus > 0 ? "+" : ""}${result.bonus}`;
  const origin = { actor: scope.actor?.uuid ?? null, token: me?.uuid ?? null, item: scope.item?.uuid ?? null };
  await t.actor.createEmbeddedDocuments("Item", [aidEffect(label, result.bonus, origin, { actor: t.actor.uuid, token: t.uuid })]);
}
