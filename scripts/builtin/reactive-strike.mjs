// X4. Реакции-Удары: Реагирующий удар (и «Возможность для атаки» NPC — то же правило), «Старая выучка» (Курмул). Триггер ловится
// по сообщениям чата — владельцу и ГМу шёпот с кнопкой «Ударить»: тратить ли реакцию, решает он; кнопка бросает Удар ближнего боя
// по спровоцировавшему (Удар входит в реакцию по правилам). Перемещение ловится хуком moveToken (v14): путь прошёл через досягаемость.
import { L, MOD, callGM } from "../util.mjs";
import { esc, whisper, cardButton } from "./lib.mjs";
import { isHit, meleeCandidates, askStrikes, rollStrike, rollDamage } from "./strikes.mjs";

export const SLUG = "reactive-strike";
const STRIKE_SLUGS = new Set([SLUG, "attack-of-opportunity"]);
const OLD_TRAINING = "Старая выучка";   // ponytail: у способности Курмул нет slug и источника — узнаём по имени (или флагу builtin)

/** Чистая: что сработало — "manipulate" | "move" | "ranged" | null. options — origin-опции и опции контекста сообщения. */
export function reactiveTrigger(options = []) {
  const has = (...k) => k.some((x) => options.includes(x));
  if (has("origin:item:trait:manipulate", "item:trait:manipulate")) return "manipulate";
  if (has("origin:item:trait:move", "item:trait:move")) return "move";
  if (has("origin:item:ranged", "item:ranged")) return "ranged";
  return null;
}

/** Чистая: враждебность по disposition токенов (дружелюбный против враждебного/секретного; нейтральные не в счёт). */
export const opposed = (a, b) => !!a && !!b && (a > 0) !== (b > 0);

/** Чистая: реакция предмета — "strike" (Реагирующий удар/Возможность для атаки) | "oldTraining" | null. */
export function reactionOf(item) {
  if (!item || item.type === "effect") return null;
  if (STRIKE_SLUGS.has(item.slug)) return "strike";
  if (item.name === OLD_TRAINING || item.flags?.[MOD]?.builtin === "old-training") return "oldTraining";
  return null;
}

const canReact = (holder, src) => holder !== src && holder.actor?.hitPoints?.value > 0 && opposed(holder.document.disposition, src.document.disposition)
  && holder.distanceTo(src) <= (holder.actor.getReach?.({ action: "attack" }) ?? 5);

const hint = (holder, src, item, trigger) => whisper(holder.actor,
  L("builtin.reactive.hint", { holder: esc(holder.actor.name), source: esc(src.name), trigger: esc(trigger), item: item.uuid }),
  "reactive-strike", { strike: { actor: holder.actor.uuid, target: src.document.uuid, item: item.name } },
  cardButton("data-af-react-strike", L("builtin.reactive.strike")));

/** Чистая: расстояние в футах между прямоугольниками токенов (в клетках) по правилу pf2e — каждая 2-я диагональ 10 фт; соседние — 5. */
export function gapFeet(a, b, unit = 5) {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return (Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2) + 1) * unit;
}

/** Чистая: клетки, которые существо покинуло за перемещение (начало и промежуточные точки; конечная — нет). */
export const leftSquares = (origin, waypoints) => [origin, ...waypoints.slice(0, -1)].filter(Boolean);

const MOVE_METHODS = new Set(["dragging", "keyboard", "api"]);   // config/paste/undo — правка ГМа, не перемещение существа
const seenMoves = new Set();

/** ГМ, в бою: существо в досягаемости совершает перемещение / выходит из клетки в досягаемости — подсказка держателю. */
export async function onMove(doc, movement) {
  const mover = doc.object;
  if (!mover || !game.combat?.started || doc.parent !== canvas.scene || !MOVE_METHODS.has(movement?.method)) return;
  const g = canvas.grid.size, unit = canvas.grid.distance;
  const rect = (p) => ({ x: p.x / g, y: p.y / g, w: p.width ?? doc.width, h: p.height ?? doc.height });
  const squares = leftSquares(movement.origin, movement.passed?.waypoints ?? []).map(rect);
  const step = (movement.passed?.distance ?? 99) <= unit;   // Шаг реакций не вызывает — по одному сдвигу его не отличить
  for (const holder of canvas.tokens.placeables) {
    const item = holder.actor?.items.find((i) => reactionOf(i) === "strike");
    if (!item || holder === mover || !(holder.actor?.hitPoints?.value > 0) || !opposed(holder.document.disposition, doc.disposition)) continue;
    const reach = holder.actor.getReach?.({ action: "attack" }) ?? unit;
    const h = { x: holder.document.x / g, y: holder.document.y / g, w: holder.document.width, h: holder.document.height };
    if (!squares.some((s) => gapFeet(h, s, unit) <= reach)) continue;
    const key = `${movement.id}:${holder.id}`;
    if (seenMoves.has(key)) continue;
    seenMoves.add(key); setTimeout(() => seenMoves.delete(key), 60000);
    await hint(holder, mover, item, L(step ? "builtin.reactive.moveStep" : "builtin.reactive.move"));
  }
}

export async function onMessage(message) {
  const pf = message.flags?.pf2e, ctx = pf?.context?.type;
  if (!canvas?.ready || !pf) return;
  const sp = message.speaker ?? {};
  const src = sp.scene === canvas.scene?.id && sp.token ? canvas.tokens.get(sp.token) : null;
  if (!src) return;

  // Старая выучка: враг в досягаемости наносит урон союзнику держателя (бросок урона по цели-союзнику)
  if (ctx === "damage-roll") {
    const victim = pf.context?.target?.token ? canvas.tokens.get(pf.context.target.token.split(".").pop()) : null;
    if (!victim) return;
    for (const holder of canvas.tokens.placeables) {
      const item = holder.actor?.items.find((i) => reactionOf(i) === "oldTraining");
      if (!item || victim === holder || opposed(holder.document.disposition, victim.document.disposition) || !canReact(holder, src)) continue;
      await hint(holder, src, item, L("builtin.reactive.damage", { ally: victim.name }));
    }
    return;
  }

  if (!pf.origin || (ctx && !["spell-cast", "attack-roll"].includes(ctx))) return;
  const trigger = reactiveTrigger([...(pf.origin.rollOptions ?? []), ...(pf.context?.options ?? [])]);
  // бросок атаки заклинания несёт те же manipulate-опции, что и его каст: по атаке — только «дальняя атака»
  if (!trigger || (ctx === "attack-roll" && trigger !== "ranged")) return;
  for (const holder of canvas.tokens.placeables) {
    const item = holder.actor?.items.find((i) => reactionOf(i) === "strike");
    if (!item || !canReact(holder, src)) continue;
    await hint(holder, src, item, L(`builtin.reactive.${trigger}`));
  }
}

/** Кнопка «Ударить» (у владельца актёра): Удар ближнего боя по спровоцировавшему, при попадании — урон. */
export function bindStrike(message, html) {
  const data = message.flags?.[MOD]?.strike;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const btn = root?.querySelector?.("[data-af-react-strike]");
  if (!data || !btn) return;
  if (data.used) { btn.disabled = true; return; }   // реакция уже потрачена (ГМ или владелец)
  btn.addEventListener("click", async () => {
    const actor = await fromUuid(data.actor), target = await fromUuid(data.target);
    if (!actor?.isOwner || !target?.actor) return void ui.notifications.warn(L("builtin.reactive.cannot"));
    const cands = meleeCandidates(actor.system?.actions ?? []);
    if (!cands.length) return void ui.notifications.warn(L("builtin.strike.noMelee", { name: data.item }));
    btn.disabled = true;
    const setup = await askStrikes(cands, 1, { title: data.item, picks: [L("builtin.strike.weapon")], map: L("builtin.strike.map") });
    if (!setup) { btn.disabled = false; return; }
    await (game.user.isGM ? message.setFlag(MOD, "strike.used", true) : callGM("markStrikeUsed", message.id));
    const s = cands[setup.picks[0]];
    const { degree } = await rollStrike(actor, s, setup.map, target);
    if (degree != null && isHit(degree)) await rollDamage(actor, s, setup.map, target, degree === 3);
  });
}
