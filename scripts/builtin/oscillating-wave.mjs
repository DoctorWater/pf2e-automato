// «Колебание волны» психика (The Oscillating Wave, Conservation of Energy): заклинания чередуют огонь и холод. pf2e даёт переключатель
// `conservation-of-energy` (fire/cold), но сам не переключает. Признак — этот переключатель на черте актёра; набор заклинаний — из её же
// DamageAlteration (item:slug:…), а не списком имён. Когда бросили урон такого заклинания, берём противоположное значение — один раз на сотворение
// (не при касте: урон со страницы заклинания бросают позже, и тип уже был бы чужим). Действие черты с дескриптором «mindshift» переключает,
// если включена опция mindshift:add-remove-energy (третье правило pf2e-automations, по его карточке).
// Фокусировка, как у PA: выбранное значение сбрасывается ("none" — pf2e не находит такого варианта и возвращает первый, fire). Выключить
// переключатель нельзя: у RollOption `alwaysActive`, он включён всегда, меняется только выбор.
import { MOD } from "../util.mjs";
import { paHas } from "./lib.mjs";
import { isHeldReroll } from "../hold.mjs";

export const OPTION = "conservation-of-energy";
const SLUG = /^item:slug:([a-z0-9-]+)$/;
// «уже переключили» — флаг на карточке сотворения (или на самом броске урона без карточки): переживает перезагрузку и смену ведущего
const flipped = (id) => game.messages?.get(id)?.getFlag(MOD, "waveFlipped");
const mark = (id) => game.messages?.get(id)?.setFlag(MOD, "waveFlipped", true);

/** Чистая: черта с переключателем чередования. */
export const waveFeat = (actor) => actor?.items?.find((i) => i.system?.rules?.some((r) => r.key === "RollOption" && r.option === OPTION && r.toggleable)) ?? null;

/** Чистая: slug-и заклинаний, чей тип урона задаёт переключатель (предикаты DamageAlteration черты). */
export function affectedSlugs(rules, out = new Set()) {
  const walk = (p) => {
    if (typeof p === "string") { const m = SLUG.exec(p); if (m) out.add(m[1]); }
    else if (Array.isArray(p)) p.forEach(walk);
    else if (p && typeof p === "object") Object.values(p).forEach(walk);
  };
  for (const r of rules ?? []) if (r.key === "DamageAlteration" && JSON.stringify(r.value ?? "").includes("conservationOfEnergy")) walk(r.predicate);
  return out;
}

/** Чистая: противоположное значение; не задано — null. */
export const flip = (state) => (state === "fire" ? "cold" : state === "cold" ? "fire" : null);

/** Чистая: значение, с которым брошен урон (из roll options броска), если оно ещё текущее у актёра. */
export const stateOf = (options, current) => {
  const used = ["fire", "cold"].find((s) => options?.includes(`${OPTION}:${s}`));
  return used && current?.[`${OPTION}:${used}`] ? used : null;
};

/** Чистая: ключ сотворения для броска урона — id последней карточки того же предмета без контекста броска (или spell-cast) до него; иначе id самого урона. messages — по порядку создания. */
export function castKey(messages, damage) {
  const uuid = damage.flags?.pf2e?.origin?.uuid, at = messages.indexOf(damage);
  for (let i = (at < 0 ? messages.length : at) - 1; i >= 0; i--) {
    const m = messages[i], pf = m.flags?.pf2e;
    if (pf?.origin?.uuid === uuid && (!pf.context?.type || pf.context.type === "spell-cast")) return m.id;
  }
  return damage.id;
}

export async function onMessage(message) {
  const pf = message.flags?.pf2e, actor = message.actor, feat = waveFeat(actor);
  if (!feat || !pf?.origin || (pf.context?.isReroll && !isHeldReroll(message)) || paHas("the-oscillating-wave")) return;
  const opts = pf.origin.rollOptions ?? [];
  const slug = opts.find((o) => o.startsWith("origin:item:slug:"))?.slice(17) ?? message.item?.slug;
  const set = (value) => actor.toggleRollOption("all", OPTION, feat.id, true, value);
  if (pf.context?.type === "damage-roll" && slug && affectedSlugs(feat.system.rules).has(slug)) {
    const key = castKey(game.messages?.contents ?? [], message);
    const next = flip(stateOf(pf.context.options, actor.rollOptions?.all));
    if (!next || flipped(key)) return;
    await mark(key);
    await set(next);
  } else if (pf.origin.type === "feat" && !pf.context?.type && opts.includes("origin:item:trait:mindshift") && actor.rollOptions?.all?.["mindshift:add-remove-energy"]) {
    const state = ["fire", "cold"].find((s) => actor.rollOptions?.all?.[`${OPTION}:${s}`]);
    if (flip(state) && !flipped(message.id)) { await mark(message.id); await set(flip(state)); }
  } else if (pf.origin.type === "action" && slug === "refocus") await set("none");
}
