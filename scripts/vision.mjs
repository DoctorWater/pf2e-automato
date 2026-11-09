// Метки видимости в ячейках матрицы PF2e Vision (game.modules.get("pf2e-vision").api.store).
// Реестр — flags.pf2e-automato.vis на сцене: { cells: {"targetId>observerId": {base,last,src}}, meta: {sourceKey: {label,until?,subjectId?,used?,recipe?,inside?}} }.
// Всё пишет только активный ГМ, по сцене — через queue. Чистые функции вынесены и покрыты tests/vision.test.mjs.
import { MOD, L, callGM, isActiveGM, flagPath, forcedReplace, forcedDelete, queue } from "./util.mjs";
import { S } from "./settings.mjs";
import { card, cardButton } from "./card.mjs";
import { headOf } from "./builtin/lib.mjs";

export const LEVELS = ["observed", "concealed", "hidden", "undetected", "unnoticed"];   // индекс = ранг, больше — хуже видно
const rank = (l) => LEVELS.indexOf(l);
export const worst = (...ls) => ls.reduce((a, b) => (rank(b) > rank(a) ? b : a));

// Зрительные чувства pf2e (pf2e.mjs, константа ni: darkvision, greater-darkvision, low-light-vision, see-invisibility) + truesight и infrared-vision.
// Всё остальное с acuity "precise" (echolocation и т.п.) — точное незрительное.
export const VISUAL = new Set(["darkvision", "greater-darkvision", "low-light-vision", "see-invisibility", "truesight", "infrared-vision"]);
const CONDITIONS = new Set(["blinded", "dazzled", "invisible"]);
const ATTACKS = new Set(["attack-roll", "spell-attack-roll"]);   // pf2e.mjs:28889
const cellKey = (targetId, observerId) => `${targetId}>${observerId}`;

/* ---------- чистые функции: политика реестра ---------- */

/** Ячейка с вкладами: base/last/src -> новая запись и уровень к записи (null — писать не надо). */
export function planCell(entry, current) {
  const base = entry.last == null || current !== entry.last ? current : entry.base;   // новая или изменённая снаружи -> base = current
  const desired = worst(base, ...Object.values(entry.src));
  return { entry: { ...entry, base, last: desired }, apply: desired !== current ? desired : null };
}

/** Вкладов не осталось: вернуть base, только если ячейку не трогали (current === last). */
export function planRelease(entry, current) {
  return { apply: current === entry.last && entry.base !== current ? entry.base : null };
}

/** Прогнать ячейки keys: -> { cells (новый объект), changes: [{observerId,targetId,level}] }. */
export function settleCells(cells, keys, getLevel) {
  const out = { ...cells }, changes = [];
  for (const key of new Set(keys)) {
    const entry = out[key];
    if (!entry) continue;
    const [targetId, observerId] = key.split(">");
    const current = getLevel(targetId, observerId);
    let apply;
    if (Object.keys(entry.src).length) { const p = planCell(entry, current); out[key] = p.entry; apply = p.apply; }
    else { apply = planRelease(entry, current).apply; delete out[key]; }
    if (apply) changes.push({ observerId, targetId, level: apply });
  }
  return { cells: out, changes };
}

/** Убрать вклад источника (на месте). -> затронутые ключи ячеек. */
export function removeSource(vis, sourceKey) {
  const touched = [];
  for (const [k, e] of Object.entries(vis.cells)) if (sourceKey in e.src) { delete e.src[sourceKey]; touched.push(k); }
  delete vis.meta[sourceKey];
  return touched;
}

/** Заменить вклад источника целиком (на месте). meta — любые непустые поля. -> затронутые ключи. */
export function withSource(vis, sourceKey, cells, meta = {}) {
  const touched = removeSource(vis, sourceKey);
  for (const c of cells) {
    if (c.observerId === c.targetId || !(rank(c.level) > 0)) continue;
    const k = cellKey(c.targetId, c.observerId);
    const e = (vis.cells[k] ??= { base: null, last: null, src: {} });
    e.src[sourceKey] = e.src[sourceKey] ? worst(e.src[sourceKey], c.level) : c.level;
    touched.push(k);
  }
  vis.meta[sourceKey] = Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
  return touched;
}

/** Число ячеек реестра с вкладом источника. */
export const countSourceCells = (vis, sourceKey) => Object.values(vis?.cells ?? {}).filter((e) => sourceKey in e.src).length;

/** Снять метки источника, но оставить его в meta с dismissed — rebuild такой источник не пересчитывает (на месте). -> затронутые ключи. */
export function dismissInPlace(vis, sourceKey) {
  const m = vis.meta[sourceKey];
  if (!m) return [];
  const touched = removeSource(vis, sourceKey);
  vis.meta[sourceKey] = { label: m.label, recipe: m.recipe, dismissed: true };
  return touched;
}

/** Источники для пересчёта: с рецептом и не снятые ГМом. */
export const rebuildEntries = (meta) => Object.entries(meta).filter(([, m]) => m.recipe && !m.dismissed);

/** Состояние интеграции для строки в настройках: mod — game.modules.get("pf2e-vision"). -> { key: "off"|"on"|"missing", version? }. */
export function integrationStatus(mod, settingOn) {
  if (!settingOn) return { key: "off" };
  const st = mod?.active ? mod.api?.store : null;
  return st?.getLevel && st?.applyChanges ? { key: "on", version: mod.version } : { key: "missing" };
}

/** Убрать ячейки, где нет цели или наблюдателя на сцене (на месте). */
export function dropDead(vis, hasToken) {
  for (const k of Object.keys(vis.cells)) {
    const [t, o] = k.split(">");
    if (!hasToken(t) || !hasToken(o)) delete vis.cells[k];
  }
}

/** next-turn-end у субъекта вне его хода — это его ближайший ход, т.е. обычный turn-end. */
export function normalizeUntil(until, subjectId, currentTokenId) {
  return until.map((u) => (u === "next-turn-end" && subjectId !== currentTokenId ? "turn-end" : u));
}

/**
 * Шаг срока по событию субъекта: "turn-end" | "attack" | "damage". -> { until, used, expired }.
 * attack: первая атака помечает источник использованным (урон ещё впереди), снимается на damage, следующей атаке или в конце хода.
 */
export function stepUntil(until, event, used = false) {
  const has = (u) => until.includes(u);
  if (event === "turn-end") {
    if (has("turn-end") || (has("attack") && used)) return { until, used, expired: true };
    return { until: until.map((u) => (u === "next-turn-end" ? "turn-end" : u)), used, expired: false };
  }
  if (event === "attack" && has("attack")) return used ? { until, used, expired: true } : { until, used: true, expired: false };
  if (event === "damage" && has("attack") && used) return { until, used, expired: true };
  return { until, used, expired: false };
}

/** Событие субъекта (на месте): истёкшие источники снимаются. -> затронутые ключи. */
export function expireByEvent(vis, subjectId, event) {
  const touched = [];
  for (const [key, m] of Object.entries(vis.meta)) {
    if (m.subjectId !== subjectId || !m.until?.length) continue;
    const s = stepUntil(m.until, event, !!m.used);
    if (s.expired) touched.push(...removeSource(vis, key));
    else { m.until = s.until; if (s.used) m.used = true; }
  }
  return touched;
}

/** Ход пошёл вперёд (не откат)? prior/current — { round, turn }. */
export const turnForward = (prior, current) =>
  current.round > prior.round || (current.round === prior.round && current.turn > prior.turn);

/** Смена множества внутри зоны: -> { entered, exited } (id токенов). */
export function insideDiff(prev, now) {
  return { entered: now.filter((id) => !prev.includes(id)), exited: prev.filter((id) => !now.includes(id)) };
}

/* ---------- чистые функции: расчёт ячеек. tokens: [{id, senses:[{type,acuity,range}]}], dist(aId,bId) -> число | null ---------- */

const hasSense = (senses, type) => senses.some((s) => s.type === type);
/** Точное незрительное чувство в пределах дальности (расстояние неизвестно — только бесконечная дальность). */
export function preciseNonVisual(senses, d) {
  return senses.some((s) => {
    if (s.acuity !== "precise" || VISUAL.has(s.type)) return false;
    const r = s.range ?? Infinity;
    return d == null ? r === Infinity : r >= d;
  });
}
const cell = (observerId, targetId, level) => ({ observerId, targetId, level });
const pairs = (tokens) => tokens.flatMap((o) => tokens.filter((t) => t.id !== o.id).map((t) => [o, t]));

/** Дым/туман: цель внутри или наблюдатель внутри -> concealed, если нет точного незрительного чувства. */
export function smokeCells(tokens, insideIds, dist) {
  return pairs(tokens)
    .filter(([o, t]) => (insideIds.has(t.id) || insideIds.has(o.id)) && !preciseNonVisual(o.senses, dist(o.id, t.id)))
    .map(([o, t]) => cell(o.id, t.id, "concealed"));
}

export function blindedCells(subject, tokens, dist) {
  return tokens.filter((t) => t.id !== subject.id && !preciseNonVisual(subject.senses, dist(subject.id, t.id))).map((t) => cell(subject.id, t.id, "hidden"));
}

/** Ослеплён светом: только если нет ни одного точного незрительного чувства. */
export function dazzledCells(subject, tokens) {
  if (subject.senses.some((s) => s.acuity === "precise" && !VISUAL.has(s.type))) return [];
  return tokens.filter((t) => t.id !== subject.id).map((t) => cell(subject.id, t.id, "concealed"));
}

/**
 * Невидим. marks (постоянный вклад): hidden, у see-invisibility — concealed; truesight — не трогаем.
 * once (разово, вне реестра, чтобы не отменять Seek): undetected тем, кто цель не видел (getLevel > concealed).
 */
export function invisibleCells(subject, tokens, getLevel) {
  const marks = [], once = [];
  for (const o of tokens) {
    if (o.id === subject.id || hasSense(o.senses, "truesight")) continue;
    if (hasSense(o.senses, "see-invisibility")) marks.push(cell(o.id, subject.id, "concealed"));
    else if (rank(getLevel(subject.id, o.id)) <= 1) marks.push(cell(o.id, subject.id, "hidden"));
    else once.push(cell(o.id, subject.id, "undetected"));
  }
  return { marks, once };
}

/* ---------- Foundry ---------- */

/** api store PF2e Vision или null. Не кэшируем: api появляется в ready. */
export function visionApi() {
  const m = game.modules.get("pf2e-vision");
  const store = m?.active ? m.api?.store : null;
  return store?.getLevel && store?.applyChanges ? store : null;
}
export const visionActive = () => !!visionApi() && S.get("vision.marks");
export const visionStatus = () => integrationStatus(game.modules.get("pf2e-vision"), S.get("vision.marks"));
/** Число ячеек дыма региона в реестре сцены; null — интеграция не активна. */
export function zoneCells(regionUuid) {
  if (!visionActive()) return null;
  const scene = fromUuidSync(regionUuid)?.parent;
  return countSourceCells(readVis(scene), `zone:${regionUuid}`);
}

// Ключи источников содержат точки (uuid, «c2.0»), а Foundry при update разворачивает точки в ключах во вложенные
// объекты — в флаге храним их закодированными, наружу отдаём как есть.
const mapKeys = (o, f) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [f(k), v]));
const enc = (k) => k.replaceAll(".", "%2E"), dec = (k) => k.replaceAll("%2E", ".");
const codeVis = (v, f) => ({
  cells: Object.fromEntries(Object.entries(v?.cells ?? {}).map(([k, c]) => [k, { ...c, src: mapKeys(c.src, f) }])),
  meta: mapKeys(v?.meta, f)
});
/** Реестр сцены с раскодированными ключами (копия). */
export const readVis = (scene) => codeVis(structuredClone(scene?.flags?.[MOD]?.vis ?? {}), dec);
const loadVis = readVis;

/**
 * Под очередью сцены: fn(vis) правит реестр и возвращает ключи ячеек; затем сверка с Vision и сохранение.
 * Реестр правится всегда; applyChanges — только если Vision есть и метки включены (force — только Vision).
 * once — разовые записи вне реестра.
 */
function mutate(scene, fn, { once = [], force = false } = {}) {
  if (!scene || !isActiveGM()) return Promise.resolve();
  return queue(`vis:${scene.id}`, async () => {
    const api = visionApi(), live = !!api && (force || S.get("vision.marks"));
    const vis = loadVis(scene), before = JSON.stringify(vis);
    const alive = (id) => scene.tokens.has(id);
    dropDead(vis, alive);
    const level = (t, o) => (live ? api.getLevel(t, o, scene) : "observed");
    const keys = fn(vis);
    const { cells, changes } = settleCells(vis.cells, keys, level);
    vis.cells = cells;
    const extra = live ? once.filter((c) => alive(c.targetId) && alive(c.observerId) && rank(c.level) > rank(level(c.targetId, c.observerId))) : [];
    const all = [...extra, ...changes].filter((c) => alive(c.targetId) && alive(c.observerId));
    if (live && all.length) await api.applyChanges(all, scene);
    if (JSON.stringify(vis) === before) return;
    await scene.update(Object.keys(cells).length || Object.keys(vis.meta).length ? forcedReplace(flagPath("vis"), codeVis(vis, enc)) : forcedDelete(flagPath("vis")));
  });
}

const inCombat = (scene) => !!game.combats?.active?.combatants.some((c) => c.sceneId === scene.id);

/**
 * Заменить вклад источника. meta: { label, until, subjectId, recipe, inside, once }; once — [{observerId,targetId,level}] разово.
 * -> "ok" | "inactive" (нет Vision или метки выключены) | "no-combat" (until задан, а боя на сцене нет — источник не ставится).
 */
export async function setSource(scene, sourceKey, cells, { once, ...meta } = {}) {
  if (!visionActive()) return "inactive";
  if (meta.until?.length && !inCombat(scene)) return "no-combat";
  if (meta.until?.length) meta.until = normalizeUntil(meta.until, meta.subjectId, game.combats.active.combatant?.tokenId);
  await mutate(scene, (vis) => withSource(vis, sourceKey, cells, meta), { once });
  return "ok";
}
export const dismissSource = (scene, sourceKey) => mutate(scene, (vis) => dismissInPlace(vis, sourceKey));
export const dropSource = (scene, sourceKey) => mutate(scene, (vis) => removeSource(vis, sourceKey));
export const reconcile = (scene) => (visionActive() ? mutate(scene, (vis) => Object.keys(vis.cells)) : Promise.resolve());

const isCreature = (t) => t.actor?.isOfType?.("creature");
const sensesOf = (actor) => [...(actor.perception?.senses?.values?.() ?? actor.perception?.senses ?? [])].map((s) => ({ type: s.type, acuity: s.acuity, range: s.range }));
const viewsOf = (scene) => scene.tokens.filter(isCreature).map((t) => ({ id: t.id, senses: sensesOf(t.actor) }));
// Центр-центр по документам (без холста); не от края до края — для 5-фт чувств возможна погрешность в клетку.
function distOf(scene) {
  const g = scene.grid, center = (t) => ({ x: t.x + (t.width * g.sizeX) / 2, y: t.y + (t.height * g.sizeY) / 2 });
  return (a, b) => {
    const A = scene.tokens.get(a), B = scene.tokens.get(b);
    try { return A && B ? g.measurePath([center(A), center(B)]).distance : null; } catch { return null; }
  };
}

const ZONE_TYPE = `${MOD}.zone`;
/**
 * Дым/туман: пересчитать источник zone:<uuid>. Зона выключена (скрыта, истекла, регион удалён) — источник снимается.
 * -> { entered, exited } — id токенов, сменивших «внутри» с прошлого пересчёта (для макросов zoneEnter/zoneExit).
 */
export async function refreshZone(region) {
  const scene = region.parent, key = `zone:${region.uuid}`;
  const prev = readVis(scene).meta[key]?.inside ?? [];
  const sys = region.behaviors?.find((b) => b.type === ZONE_TYPE)?.system;
  const off = !scene?.regions.has(region.id) || region.hidden || !sys || sys.expired;
  const inside = off ? [] : scene.tokens.filter((t) => isCreature(t) && t.testInsideRegion(region)).map((t) => t.id);
  const diff = insideDiff(prev, inside);
  if (off) await dropSource(scene, key);
  else {
    const res = await setSource(scene, key, smokeCells(viewsOf(scene), new Set(inside), distOf(scene)), { label: L("vision.zone"), recipe: { kind: "zone", regionUuid: region.uuid }, inside });
    if (res !== "ok") return { entered: [], exited: [] };
  }
  return diff;
}

/** Источник состояния (blinded|dazzled|invisible) по предмету-состоянию; onlyScene — пересчёт одной сцены (в т.ч. с пустым набором токенов). */
async function applyCond(item, onlyScene = null) {
  const slug = item.system?.slug ?? item.slug, key = `cond:${item.uuid}`;
  const byScene = new Map(onlyScene ? [[onlyScene, []]] : []);
  for (const t of item.actor.getActiveTokens(false, true)) if (t.parent && (!onlyScene || t.parent === onlyScene)) (byScene.get(t.parent) ?? byScene.set(t.parent, []).get(t.parent)).push(t.id);
  for (const [scene, ids] of byScene) {
    const api = visionApi(), tokens = viewsOf(scene), dist = distOf(scene), mine = readVis(scene).cells;
    // уже стоящие наши метки считаем «видел» (иначе пересчёт принял бы свою hidden за «не видел»)
    const seen = (t, o) => (mine[cellKey(t, o)]?.src?.[key] ? "observed" : api.getLevel(t, o, scene));
    const subjects = tokens.filter((t) => ids.includes(t.id));
    let cells = [], once = [];
    for (const s of subjects) {
      if (slug === "blinded") cells.push(...blindedCells(s, tokens, dist));
      else if (slug === "dazzled") cells.push(...dazzledCells(s, tokens));
      else { const r = invisibleCells(s, tokens, seen); cells.push(...r.marks); once.push(...r.once); }
    }
    await setSource(scene, key, cells, { label: L(`vision.${slug}`), recipe: { kind: slug, itemUuid: item.uuid }, once });
  }
}

async function onCondition(item, on) {
  const slug = item.system?.slug ?? item.slug;
  if (!isActiveGM() || item.type !== "condition" || !CONDITIONS.has(slug) || !item.actor) return;
  if (on) { if (visionActive()) { await applyCond(item); await notifyCond(item, slug); } return; }
  const key = `cond:${item.uuid}`;
  for (const scene of game.scenes) if (readVis(scene).meta[key]) await dropSource(scene, key);
}

const gmIds = () => ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
/** Шёпот ГМу: метки состояния поставлены (один раз на источник). */
async function notifyCond(item, slug) {
  const key = `cond:${item.uuid}`;
  if (game.messages.some((m) => m.flags?.[MOD]?.visCard?.key === key)) return;
  for (const scene of game.scenes) {
    if (!readVis(scene).meta[key]) continue;
    const n = countSourceCells(readVis(scene), key), name = foundry.utils.escapeHTML(item.actor.name);
    await ChatMessage.create({
      whisper: gmIds(), speaker: { alias: "pf2e-automato" }, flags: { [MOD]: { visCard: { key, scene: scene.id } } },
      content: card(L("vision.card", { name, state: L(`vision.${slug}`), n }), cardButton("data-automato-vis-dismiss", L("vision.dismiss")), headOf("vision"))
    });
    return;
  }
}

/** Пересчитать источники с рецептом (cond:*, zone:*) и сверить все ячейки: новые токены получают метки. */
export async function rebuild(scene) {
  if (!isActiveGM() || !scene || !visionActive()) return;
  const meta = readVis(scene).meta;
  for (const [key, m] of rebuildEntries(meta)) {
    const r = m.recipe;
    if (r.kind === "zone") {
      const region = fromUuidSync(r.regionUuid);
      if (region) await refreshZone(region); else await dropSource(scene, key);
    } else {
      const item = fromUuidSync(r.itemUuid);
      if (item?.actor) await applyCond(item, scene); else await dropSource(scene, key);
    }
  }
  await reconcile(scene);
}

/** Откатить все метки сцены (где ячейку не трогали) и очистить реестр. */
const clearAll = (scene) => mutate(scene, (vis) => {
  for (const e of Object.values(vis.cells)) e.src = {};
  vis.meta = {};
  return Object.keys(vis.cells);
}, { force: true });

const scenesOfCombat = (combat) => [...new Set(combat.combatants.map((c) => c.sceneId))].map((id) => game.scenes.get(id)).filter(Boolean);
const fire = (scene, subjectId, event) => mutate(scene, (vis) => expireByEvent(vis, subjectId, event));
const hasVis = (scene) => !!scene?.flags?.[MOD]?.vis;

export function init() {
  Hooks.on("createItem", (item) => onCondition(item, true));
  Hooks.on("deleteItem", (item) => onCondition(item, false));
  Hooks.on("combatStart", (combat) => { if (isActiveGM()) scenesOfCombat(combat).forEach(rebuild); });
  Hooks.on("createCombatant", (c) => rebuild(game.scenes.get(c.sceneId)));
  Hooks.on("createToken", (t) => rebuild(t.parent));
  Hooks.on("deleteToken", (t) => {
    const scene = t.parent;
    if (!isActiveGM() || !hasVis(scene)) return;
    // источники, привязанные к токену (срок, состояние несвязанного актёра), и ячейки с его участием
    mutate(scene, (vis) => Object.entries(vis.meta)
      .filter(([, m]) => m.subjectId === t.id || m.recipe?.itemUuid?.includes(`.Token.${t.id}.`))
      .flatMap(([k]) => removeSource(vis, k)));
  });
  Hooks.on("deleteCombat", (combat) => {
    if (!isActiveGM()) return;
    for (const scene of scenesOfCombat(combat))
      mutate(scene, (vis) => Object.entries(vis.meta).filter(([, m]) => m.until?.length).flatMap(([k]) => removeSource(vis, k)));
  });
  Hooks.on("combatTurnChange", (combat, prior, current) => {
    if (isActiveGM() && prior?.tokenId && turnForward(prior, current)) scenesOfCombat(combat).forEach((s) => fire(s, prior.tokenId, "turn-end"));
  });
  Hooks.on("createChatMessage", (m) => {
    const type = m.flags?.pf2e?.context?.type, sp = m.speaker;
    if (!isActiveGM() || !sp?.token || !sp.scene) return;
    const event = ATTACKS.has(type) ? "attack" : type === "damage-roll" ? "damage" : null;
    if (event) fire(game.scenes.get(sp.scene), sp.token, event);
  });
  // Карточка «Снять метки»: снимает источник и не даёт rebuild вернуть его.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const btn = html.querySelector("[data-automato-vis-dismiss]"), c = message.flags?.[MOD]?.visCard;
    if (!btn || !c) return;
    if (c.done) { btn.remove(); return; }
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const res = await callGM("dismissVis", c.scene, c.key);
      if (res?.ok) await message.setFlag(MOD, "visCard.done", true); else btn.disabled = false;
    });
  });
  // Реестр сцены меняется без правки сообщения — перерисовать строку «метки в PF2e Vision» у активных зон этой сцены.
  Hooks.on("updateScene", (scene, changes) => {
    if (!game.user.isGM || !changes.flags?.[MOD]) return;
    for (const m of game.messages) {
      const z = m.flags?.[MOD]?.use?.state?.zone;
      if (z?.status === "active" && z.regionUuid?.startsWith(`Scene.${scene.id}.`)) ui.chat?.updateMessage(m);
    }
  });
  Hooks.once("ready", () => setTimeout(() => {   // api Vision ставится в его ready — ждём такт
    if (game.user.isGM && visionStatus().key === "missing") ui.notifications.info(L("vision.warn"));
  }, 0));
  Hooks.on("renderSettingsConfig", (app, html) => {
    const group = html.querySelector(`[name="${MOD}.vision.marks"]`)?.closest(".form-group");
    if (!group) return;
    const st = visionStatus(), p = document.createElement("p");
    p.className = "hint";
    p.textContent = L(`vision.status.${st.key}`, { version: st.version ?? "" });
    group.append(p);
  });
  // Настройка vision.marks (хук зовёт settings.mjs): выключили — откатить метки и очистить реестр.
  Hooks.on("pf2e-automato.visionMarks", (on) => {
    if (isActiveGM() && !on) for (const scene of game.scenes) if (hasVis(scene)) clearAll(scene);
  });
}
