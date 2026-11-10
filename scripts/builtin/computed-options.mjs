// Вычисляемые опции броска (CLAUDE.md §1.5): условие считается из положения на сцене, переключателя нет (он нейтрализован — neutralize-rules.mjs).
// Сейчас одна опция: pack-attack («Стайный» и тёзки: удар по существу в досягаемости союзников). Своего урона модуль не бросает:
// в бросок урона Удара добавляется опция, а кубы, критудвоение и precision считает DamageDice самого pf2e.
// Точка — strike.damage/critical (и altUsages) в system.actions: через них идут лист, кнопка карточки pf2e (pf2e.mjs:29094), «Урон» модуля, TAH.
// Обёртки ставятся на prepareData после wrapped(): BattleForm пересобирает actions в afterPrepareData (42923), вызываемом из prepareData (33062).
// Цель — как pf2e (20568): c.target ?? первая цель пользователя. Опция подставляется, только если у актёра погашен переключатель:
// иначе RollOption.beforeRoll при выключенном переключателе снял бы её (44594), — тогда предупреждение ГМу и подстановки нет.
import { MOD, L } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { sourceOfActor } from "../rules.mjs";
import { clearMarks, isInstalled, neutralizedOf, resetActors, setReady, wrapMethod } from "./neutralize-rules.mjs";

/** Чистая: сколько живых союзников бросавшего (не он сам: по uuid актёра и по id токена; не скрытые) держат цель в досягаемости.
 * tokens — токены сцены (TokenPF2e), targetToken/actorToken — документы. */
export function alliesInReach(actor, actorToken, targetToken, tokens) {
  const tgt = targetToken?.object;
  if (!actor || !tgt) return 0;
  return (tokens ?? []).filter((t) => {
    const a = t.actor;
    if (!a || t.document?.hidden || t.id === actorToken?.id || t.id === tgt.id || (actor.uuid && a.uuid === actor.uuid)) return false;
    if (!a.isAllyOf?.(actor) || (a.hitPoints?.value ?? 1) <= 0) return false;
    const reach = a.getReach?.({ action: "attack" }) ?? 5;
    return t.distanceTo(tgt, { reach }) <= reach;   // reach в distanceTo — исключение pf2e для диагонали при досягаемости 10 фт (как melee-reach.mjs)
  }).length;
}

// «Не менее одного союзника» (иначе двух): текст из паков 8.6.1 — «within reach of at least one of its allies». Slug-и ниже у других тварей — «two».
const ONE_SLUGS = new Set(["superior-pack-attack", "coordinated-assault"]);
// Phantom Wolf (season-of-ghosts-bestiary): slug у предмета тот же pack-attack, отличим по источнику актёра
const ONE_ACTORS = ["Compendium.pf2e.season-of-ghosts-bestiary.Actor.R805QpID53EycZ5E"];

/** Чистая: порог числа союзников для предмета с таким slug у актёра с таким источником. */
export const packNeed = (slug, actorSource) => (ONE_SLUGS.has(slug) || (slug === "pack-attack" && ONE_ACTORS.includes(actorSource)) ? 1 : 2);

/** Чистая: порог для опции — минимум по предметам актёра, у которых она погашена. */
export const needFor = (actor, items) => Math.min(...[...items].map((i) => packNeed(i.slug, sourceOfActor(actor))));

/** Опции, которые нужно добавить в бросок урона: marks — Map(опция -> предметы) погашенных у актёра, count() — число союзников у цели. */
export function computedFor(actor, marks, count) {
  const items = marks?.get("pack-attack");
  return items?.size && count() >= needFor(actor, items) ? ["pack-attack"] : [];
}

const WRAPPED = Symbol("computed-options");

function count(actor, c) {
  const target = c.target ?? game.user?.targets?.first?.();
  const tdoc = target?.document, scene = globalThis.canvas?.scene;
  if (!tdoc || !scene || tdoc.parent !== scene) return 0;   // ponytail: только отрисованная сцена; на гексе и без сетки pf2e distanceTo меряет между углами токенов (27902) — приближённо
  const own = actor.token ?? canvas.tokens.placeables.find((t) => t.actor === actor)?.document ?? null;
  return alliesInReach(actor, own, tdoc, canvas.tokens.placeables);
}

export function decorate(actor) {
  const marks = neutralizedOf(actor);
  if (!marks) return;
  for (const a of actor.system?.actions ?? []) for (const u of [a, ...(a.altUsages ?? [])]) for (const k of ["damage", "critical"]) {
    const f = u[k];
    if (typeof f !== "function" || f[WRAPPED]) continue;
    const w = (c = {}) => {
      let extra = [];
      if (modeOf("computed") !== "off") try { extra = computedFor(actor, neutralizedOf(actor), () => count(actor, c)); } catch (e) { console.warn(`${MOD} | computed-options`, e); }
      return f(extra.length ? { ...c, options: [...(c.options ?? []), ...extra] } : c);
    };
    w[WRAPPED] = true;
    u[k] = w;
  }
}

function prepare(wrapped, ...args) {
  clearMarks(this);   // метки строятся заново при подготовке правил: удалённый предмет порог не держит
  const r = wrapped(...args);
  try { decorate(this); } catch (e) { console.warn(`${MOD} | computed-options`, e); }
  return r;
}

let warned = false;
/** Чистая проверка + одно предупреждение: режим включён, а нейтрализация не встала — опцию не подставляем (её снял бы переключатель). */
export function checkNeutralization({ installed, mode, warn }) {
  if (warned || installed || mode === "off") return false;
  warned = true;
  warn();
  return true;
}
export const resetWarned = () => { warned = false; };

const done = new Set();
function install() {
  const docs = globalThis.CONFIG?.PF2E?.Actor?.documentClasses;
  for (const k of ["npc", "character"]) {
    if (done.has(k) || !docs?.[k]) continue;
    if (wrapMethod(`CONFIG.PF2E.Actor.documentClasses.${k}.prototype.prepareData`, docs[k].prototype, "prepareData", prepare, L("builtin.computedName"))) done.add(k);
  }
  setReady("computed", done.size === 2);   // без обёртки урона переключатель гасить нельзя: опция не придёт
}

/** В init (до подготовки актёров); в ready — повтор, если классов тогда ещё не было, и проверка. */
export function init() {
  install();
  Hooks.once("ready", () => {
    if (done.size < 2) { install(); if (done.size === 2) resetActors(); }
    if (game.user?.isGM) checkNeutralization({ installed: isInstalled() && done.size === 2, mode: modeOf("computed"), warn: () => ui.notifications.warn(L("builtin.computedNoNeutralize")) });
  });
}
