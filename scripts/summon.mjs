// Призыв существ (черта summon, docs/plan-summon.md v2). Кнопка «Призвать» на карточке с onUse.summon, окно выбора и размещение — на клиенте автора;
// актёр, токен, эффект, бой, жизненный цикл — у активного ГМа (callGM). Срок — якорь Поддержания сотворения (sustain.attach); конец якоря — токены уходят.
// Флаг токена flags[MOD].summoned (не `summon` Ониксовой собаки: её expire/dismiss смотрят тот ключ).
import { MOD, L, flagPath, queue, guardActiveGM, callGM } from "./util.mjs";
import { summonEntry, itemDuration } from "./rules.mjs";
import { itemRange } from "./range.mjs";
import { effectSource, whisper, esc, combatOf, cardButton } from "./builtin/lib.mjs";
import { findSpot } from "./builtin/onyx-dog.mjs";
import * as sustain from "./sustain.mjs";

/* ---------- чистая часть ---------- */

export const LIMIT = 4;   // приспешников у призывателя
const ACTIONS = 2;
const SECONDS = { rounds: 6, minutes: 60, hours: 3600, days: 86400 };

export const idemKey = (messageId, n) => `${messageId}:summon:${n}`;
export const summonSpec = (item) => (item ? summonEntry(item) ?? null : null);   // правило или оверлей rules/summons.json (у заклинаний призыва правила обычно нет)
export const countOf = (spec) => Math.max(1, spec?.count ?? 1);
export const durSeconds = (d) => (d ? d.value * (SECONDS[d.unit] ?? 0) : 0);

/** Карточка использования: сотворение заклинания или способность (бросков атаки/урона/проверки с context.type — нет). */
export const isUseCard = (message) => { const pf = message?.flags?.pf2e; return !!pf?.origin && (!pf.context || pf.context.type === "spell-cast"); };

/** Ограничения черты summon: призванное не призывает; не больше LIMIT приспешников у призывателя. force (Alt ГМа) обходит. -> null | "nested" | "cap" */
export function limitProblem({ nested, minions, add = 1, force = false }) {
  if (force) return null;
  if (nested) return "nested";
  return minions + add > LIMIT ? "cap" : null;
}

/** Выбор из списка candidates (S1: npc, common, уровень ≤ L) — повторная проверка у ГМа. */
export const pickAllowed = (list, uuid) => (list ?? []).find((c) => c.uuid === uuid) ?? null;

/** Инициатива приспешника: то же значение, приоритет ничьей сразу после призывателя (i-й приспешник — ещё позже). priority — у призывателя (overridePriority ?? tiebreak ?? 3). */

/** Какие 2 действия: "cast" — сразу по сотворению; "fresh" — Поддержание засчитано; иное (повтор в раунде, нет приспешников) — ничего. */
export function actionPack(trigger, names) {
  if (!names?.length || (trigger !== "cast" && trigger !== "fresh")) return null;
  return { key: trigger === "cast" ? "actionsCast" : "actionsSustain", actions: ACTIONS, list: names.join(", ") };
}

const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rectCell = (t, g) => ({ x: Math.round(t.x / g), y: Math.round(t.y / g), w: Math.max(1, Math.round(t.width)), h: Math.max(1, Math.round(t.height)) });

/** Расстояние в футах между прямоугольниками клеток (от края до края, диагональ 1-2-1 pf2e). */
export function distanceFt(a, b, ftPerCell = 5) {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)) + 1, dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)) + 1;
  const lo = Math.min(dx, dy), hi = Math.max(dx, dy);
  return (hi + Math.floor(lo / 2)) * ftPerCell;
}

/** Место: клетка щелчка, если свободна, иначе ближайшая свободная вплотную к ней (findSpot). null — нет места. */
export function placeAt(want, size, occupied) {
  const r = { ...want, ...size };
  return occupied.some((o) => hit(r, o)) ? findSpot(r, size, occupied) : r;
}

const ownersOf = (actor) => Object.fromEntries(Object.entries(actor.ownership ?? {}).filter(([id, lvl]) => id !== "default" && lvl >= 3));

/* ---------- состояние ---------- */

const flagOf = (token) => token?.flags?.[MOD]?.summoned ?? null;
const allTokens = () => (globalThis.game?.scenes?.contents ?? []).flatMap((s) => s.tokens?.contents ?? []);
/** Приспешники призывателя (по uuid автора) на всех сценах. */
export const minionsOf = (authorUuid) => allTokens().filter((t) => flagOf(t)?.by === authorUuid);
const isSummoned = (actor) => !!actor?.token?.flags?.[MOD]?.summoned || !!actor?.system?.traits?.value?.includes?.("summoned") || !!actor?.getActiveTokens?.(true, true)?.some?.((t) => flagOf(t));
const doneOf = (message) => message?.flags?.[MOD]?.summoned?.done ?? 0;
const anchorSummoned = (anchor) => anchor?.flags?.[MOD]?.sustain?.summoned ?? [];
const warn = (key, data) => globalThis.ui?.notifications?.warn(L(`summon.${key}`, data));

/* ---------- ГМ: список, создание ---------- */

function ctxOf(messageId) {
  const message = game.messages.get(messageId), item = message?.item, spec = summonSpec(item);
  if (!message || !item || !spec || !message.actor) throw new Error("summon: нет сообщения/предмета/правила");
  const rank = message.flags?.pf2e?.origin?.castRank ?? item.rank ?? Math.ceil((message.actor.level ?? 1) / 2);
  return { message, item, spec, author: message.actor, rank };
}
async function candidatesFor({ spec, rank }) {
  const { candidates, levelFor } = await import("./summon-index.mjs");
  const maxLevel = spec.uuid ? null : levelFor(rank, spec.levels);
  return { list: await candidates({ traits: spec.traits, uuid: spec.uuid, maxLevel }), maxLevel };
}

/** Окно выбора: что можно призвать и сколько осталось. */
const nexusArtFor = async (list) => {
  try { const { nexusArt } = await import("./nexus-tokens.mjs"); return await nexusArt(list.map((x) => ({ names: [x.original, x.name].filter(Boolean) }))); }
  catch { return list.map(() => null); }
};
export async function listFor(messageId) {
  const c = ctxOf(messageId), { list, maxLevel } = await candidatesFor(c);
  // портрет в окне = то, что встанет на сцену: картинка Nexus (уже скачанная), иначе картинка бестиария
  const art = await nexusArtFor(list);
  return { list: list.map((x, i) => (art[i] ? { ...x, img: art[i], token: { ...(x.token ?? {}), src: art[i] } } : x)), maxLevel, left: countOf(c.spec) - doneOf(c.message) };
}

const actorFolder = () => queue("summon:folder", async () => {
  const name = L("summon.folder");
  return (game.folders.find((f) => f.type === "Actor" && f.name === name) ?? await Folder.create({ name, type: "Actor" })).id;
});
/** Мировой актёр-источник: один раз на uuid; владелец — только ГМ (права игрока — через delta.ownership токена). */
const importActor = (uuid) => queue("summon:import", async () => {
  const have = game.actors.find((a) => a.flags?.[MOD]?.summonSource === uuid);
  if (have) return have;
  const src = await fromUuid(uuid);
  if (!src) throw new Error(`нет актёра ${uuid}`);
  const data = src.toObject();
  delete data._id;
  data.folder = await actorFolder();
  data.ownership = { default: 0 };
  data._stats = { ...data._stats, compendiumSource: uuid };
  data.flags = { ...data.flags, [MOD]: { ...data.flags?.[MOD], summonSource: uuid } };
  return Actor.implementation.create(data);
});

const durationOf = (item) => (item?.system?.duration?.sustained ? null : itemDuration(item?.system?.duration));

/** Создание существа n (идемпотентно по ключу «сообщение + номер»). Исполняет активный ГМ. -> { token, dup } */
export function create(messageId, uuid, n, { sceneId, x, y, force = false } = {}) {
  return queue(`summon:${messageId}`, async () => {
    const { message, item, spec, author, rank } = ctxOf(messageId), key = idemKey(messageId, n);
    const scene = game.scenes.get(sceneId);
    if (!scene) throw new Error("summon: нет сцены");
    let token = scene.tokens.find((t) => flagOf(t)?.key === key), fresh = false;
    if (!token) {
      if (n !== doneOf(message) || n >= countOf(spec)) return { ok: false, reason: "order" };
      const bad = limitProblem({ nested: isSummoned(author), minions: minionsOf(author.uuid).length, force });
      if (bad) return { ok: false, reason: bad };
      if (!pickAllowed((await candidatesFor({ spec, rank })).list, uuid)) return { ok: false, reason: "pick" };
      const authorToken = scene.tokens.find((t) => t.actorId === author.id || t.actor?.uuid === author.uuid);
      if (!authorToken) return { ok: false, reason: "noToken" };
      const actor = await importActor(uuid), g = scene.grid.size;
      const td = await actor.getTokenDocument({ disposition: authorToken.disposition, actorLink: false });
      const size = { w: Math.max(1, Math.round(td.width)), h: Math.max(1, Math.round(td.height)) };
      const spot = placeAt({ x: Math.round(x / g), y: Math.round(y / g) }, size, scene.tokens.map((t) => rectCell(t, g)));
      if (!spot) return { ok: false, reason: "noSpot" };
      const ftMax = force ? null : itemRange(item, []);   // дальность — и у ГМа: проверка только на клиенте обходится
      if (ftMax && distanceFt(rectCell(authorToken, g), spot, scene.grid.distance || 5) > ftMax) return { ok: false, reason: "far", ft: ftMax };
      const data = td.toObject(), d = durationOf(item);
      delete data._id;
      Object.assign(data, { x: spot.x * g, y: spot.y * g, delta: { ...data.delta, ownership: { default: 0, ...ownersOf(author) } } });
      data.flags = { ...data.flags, [MOD]: { summoned: { key, by: author.uuid, msg: messageId, anchor: sustain.anchorKey(messageId), sustained: !!item.system?.duration?.sustained, until: d ? game.time.worldTime + durSeconds(d) : null } } };
      [token] = await scene.createEmbeddedDocuments("Token", [data]);
      fresh = true;
    }
    await settle(token, { message, item, author, n, fresh });
    return { ok: true, token: token.uuid, dup: !fresh };
  });
}

/** Шаги после токена — все идемпотентны (повтор после сбоя доделывает недоделанное). */
async function settle(token, { message, item, author, n, fresh }) {
  const actor = token.actor;
  const effKey = `summoned:${token.id}`;
  if (!actor.items.some((i) => i.flags?.[MOD]?.meta?.key === effKey)) {
    const e = effectSource({
      name: L("summon.effect"), img: item.img, description: `<p>${esc(L("summon.effectDesc"))}</p><p>@UUID[${item.uuid}]</p>`,
      rules: [{ key: "ActorTraits", add: ["summoned", "minion"] }],
      duration: { value: -1, unit: "unlimited", expiry: null }, origin: { actor: author.uuid, item: item.uuid }, target: { actor: actor.uuid }
    });
    e.flags = { [MOD]: { meta: { key: effKey, source: "summon", message: message.id } } };
    await actor.createEmbeddedDocuments("Item", [e]);
  }
  // в бой не добавляем: приспешник ходит в ход хозяина по Поддержанию (черта minion), а с признаком minion участник боя и не создаётся
  if (!token.flags?.[MOD]?.summoned?.nexus) {
    await nexusSwap(token, actor);
  }
  if (doneOf(message) <= n) await message.update({ [flagPath("summoned", "done")]: n + 1 });
  if (!anchorSummoned(await anchorOf(author, message, item)).includes(token.uuid)) await bindAnchor(author, message, item, token);
  if (fresh) {
    const pack = actionPack("cast", [token.name]);
    if (pack) await whisper(author, L(`summon.${pack.key}`, { list: esc(pack.list), n: pack.actions }), "summon", {});
  }
}

async function nexusSwap(token, actor) {
  try {
    const { nexusToken } = await import("./nexus-tokens.mjs");
    const src = await nexusToken(actor);
    if (src) await token.update({ "texture.src": src, [flagPath("summoned", "nexus")]: true });
  } catch (e) { console.warn(`${MOD} | summon nexus`, e); }   // сбой — штатный токен
}

/** Участник боя сразу после призывателя: та же инициатива, приоритет ничьей чуть позже. */
const anchorOf = async (author, message, item) => sustain.findAnchor(author, sustain.anchorKey(message.id)) ?? (sustain.isSustained(item) ? (await sustain.attach(author, null, { key: sustain.anchorKey(message.id), msg: message.id, item, quiet: true })).item : null);
async function bindAnchor(author, message, item, token) {
  const anchor = await anchorOf(author, message, item);
  if (!anchor) return;
  await queue(`actor:${author.uuid}`, () => anchor.update({ [flagPath("sustain", "summoned")]: [...new Set([...anchorSummoned(anchor), token.uuid])] }));
}

/* ---------- жизненный цикл (активный ГМ) ---------- */

const authorOfToken = (t) => fromUuidSync(flagOf(t)?.by ?? "");

/** Убрать токены (и участников боя вместе с ними). */
async function dismissTokens(uuids) {
  for (const uuid of uuids) {
    const t = await fromUuid(uuid).catch(() => null);
    if (t?.parent) await t.delete().catch((e) => { if (!/does not exist/i.test(e?.message ?? "")) console.error(`${MOD} | summon dismiss`, e); });
  }
}

/** Хук deleteItem: якорь Поддержания кончился (в т.ч. откат) — призванные уходят. */
export async function onAnchorDeleted(item) {
  if (item?.type !== "effect" || item.flags?.[MOD]?.meta?.source !== "sustain" || !guardActiveGM()) return;
  const list = anchorSummoned(item);
  if (list.length) await dismissTokens(list);
}

/** Хук deleteToken: убран вручную/вместе со сценой/изгнан — подрезать якорь. Пустой список — якорь снимается (sustain.prune). */
export async function onTokenDeleted(token) {
  const f = flagOf(token);
  if (!f || !guardActiveGM()) return;
  const author = authorOfToken(token), anchor = sustain.findAnchor(author, f.anchor);
  if (!anchor) return;
  const left = anchorSummoned(anchor).filter((u) => u !== token.uuid);
  await queue(`actor:${author.uuid}`, () => anchor.update({ [flagPath("sustain", "summoned")]: left }));
  if (!left.length) await sustain.prune(author, f.anchor);
}

/** 0 ОЗ — изгнан. */
export async function maybeBanish(token) {
  if (!flagOf(token) || !guardActiveGM() || !(token.actor?.system?.attributes?.hp?.value <= 0)) return;
  const name = token.name, author = authorOfToken(token);
  await token.delete();
  if (author) await whisper(author, L("summon.banished", { name: esc(name) }), "summon", {});
}

/** ready/переход в лидеры/смена времени: уборка призванных без живого якоря и истёкших по сроку. */
export async function cleanup() {
  if (!guardActiveGM()) return 0;
  const dead = [];
  for (const t of allTokens()) {
    const f = flagOf(t);
    if (!f) continue;
    const author = authorOfToken(t);
    const anchorLive = !!author && !!sustain.findAnchor(author, f.anchor);
    if ((f.sustained && !anchorLive) || (f.until != null && game.time.worldTime >= f.until)) dead.push(t.uuid);
  }
  await dismissTokens(dead);
  return dead.length;
}

/** Слушатель Поддержания (sustain.sustained): засчитано — 2 действия каждому приспешнику этого якоря. */
export async function onSustain({ anchor, actor }) {
  if (!guardActiveGM()) return;
  const names = anchorSummoned(anchor).map((u) => fromUuidSync(u)?.name).filter(Boolean), pack = actionPack("fresh", names);
  if (pack) await whisper(actor, L(`summon.${pack.key}`, { list: esc(pack.list), n: pack.actions }), "summon", {});
}

/** Начало хода приспешника в бою: ходит только по Поддержанию. */
async function onStartTurn(combatant) {
  const t = combatant?.token;
  if (!guardActiveGM() || !flagOf(t)) return;
  await whisper(combatant.actor, L("summon.waits", { name: esc(t.name) }), "summon", {}, "", "players");
}

/* ---------- клиент: кнопка, окно, размещение ---------- */

const gridFt = () => canvas.scene?.grid?.distance ?? 5;

/** Щелчок по сцене → { x, y } (левый верхний угол клетки) в пределах ft от токена; Alt обходит дальность; ПКМ/Esc — отмена. */
/** Клетки (в клетках сетки) в пределах ft от прямоугольника токена — подсветка зоны призыва. */
export function rangeCells(rect, ft, ftPerCell = 5) {
  const r = Math.ceil(ft / ftPerCell) + 1, out = [];
  for (let x = rect.x - r; x < rect.x + rect.w + r; x++) for (let y = rect.y - r; y < rect.y + rect.h + r; y++) {
    const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
    if (!inside && distanceFt(rect, { x, y, w: 1, h: 1 }, ftPerCell) <= ft) out.push({ x, y });
  }
  return out;
}

const HL = "paf-summon-range";
/** Подсказка размещения на холсте: зона дальности (клетки) и полупрозрачный токен существа за курсором; вне дальности — красный. */
async function placementPreview(token, ft, ghost) {
  token = token?.document ?? token;   // ширина в клетках — у документа (у Token на холсте она в пикселях)
  const g = canvas.grid, s = g.size, grid = canvas.interface?.grid;
  if (grid && ft != null && token) {
    grid.addHighlightLayer(HL);
    for (const c of rangeCells(rectCell(token, s), ft, gridFt())) grid.highlightPosition(HL, { x: c.x * s, y: c.y * s, color: 0xd8c384, border: 0x786452, alpha: 0.22 });
  }
  let spr = null;
  try {
    const tex = ghost?.src ? await foundry.canvas.loadTexture(ghost.src) : null;
    if (tex) {
      spr = new PIXI.Sprite(tex);
      spr.width = (ghost.w ?? 1) * s; spr.height = (ghost.h ?? 1) * s; spr.alpha = 0.7; spr.eventMode = "none"; spr.visible = false;
      canvas.interface.addChild(spr);
    }
  } catch { spr = null; }
  return {
    move(pt, far) { if (!spr) return; spr.visible = true; spr.position.set(pt.x, pt.y); spr.tint = far ? 0xff7a6e : 0xffffff; spr.alpha = far ? 0.45 : 0.7; },
    clear() { try { grid?.destroyHighlightLayer(HL); } catch { /* слой не создан */ } try { spr?.destroy(); } catch { /* уже снят */ } }
  };
}

function pickPoint(token, ft, ghost = null) {
  token = token?.document ?? token;   // rectCell ждёт ширину в клетках (TokenDocument), у Token на холсте она в пикселях
  return new Promise((resolve) => {
    const view = canvas.app.view, note = ui.notifications.info(L("summon.place"), { permanent: true });
    const s = canvas.grid.size, cell = (ev) => canvas.grid.getTopLeftPoint(canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY }));
    const tooFar = (pt, alt) => ft != null && token && !alt && distanceFt(rectCell(token, s), { x: Math.round(pt.x / s), y: Math.round(pt.y / s), w: ghost?.w ?? 1, h: ghost?.h ?? 1 }, gridFt()) > ft;
    let preview = null;
    placementPreview(token, ft, ghost).then((p) => { preview = p; }).catch(() => {});
    const onMove = (ev) => { const pt = cell(ev); preview?.move(pt, tooFar(pt, ev.altKey)); };
    const done = (v) => { view.removeEventListener("pointerdown", onDown, true); view.removeEventListener("pointermove", onMove); document.removeEventListener("keydown", onKey, true); ui.notifications.remove?.(note); preview?.clear(); resolve(v); };
    const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); done(null); } };
    const onDown = (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      if (ev.button !== 0) return done(null);
      const pt = cell(ev);
      if (tooFar(pt, ev.altKey)) return warn("far", { ft });
      done({ x: pt.x, y: pt.y, force: ev.altKey });
    };
    view.addEventListener("pointerdown", onDown, true);
    view.addEventListener("pointermove", onMove);
    document.addEventListener("keydown", onKey, true);
  });
}

/** Окно выбора: существо (поиск по имени, уровень) и количество. -> { uuid, qty } | null */
/* Окно в стиле модуля (DESIGN.md: .paf-dialog, пергамент, одна бордовая кнопка): поиск, уровень сегментами, строки-плитки с портретом и признаками. */
const traitName = (t) => game.i18n.localize(CONFIG.PF2E?.creatureTraits?.[t] ?? CONFIG.PF2E?.monsterTraits?.[t] ?? t);
const LEGACY = new Set(["common", "good", "evil", "lawful", "chaotic"]);   // мировоззрение убрано ремастером, перевода нет
const signed = (n) => (n < 0 ? `−${-n}` : String(n));   // типографский минус: «−1», не «-1»

async function chooseDialog(item, { list, maxLevel, left }) {
  const levels = [...new Set(list.map((c) => c.level))].sort((a, b) => a - b);
  const lvlLabel = L("summon.lvl");
  const rows = list.map((c, i) => `<label class="paf-summon-row" data-level="${c.level}" data-name="${esc(c.name.toLowerCase())}">
      <input type="radio" name="uuid" value="${esc(c.uuid)}"${i === 0 ? " checked" : ""}>
      <img class="paf-summon-img" src="${esc(c.img)}" alt="">
      <span class="paf-summon-text"><span class="paf-summon-name">${esc(c.name)}</span>
        <span class="paf-summon-tags">${(c.traits ?? []).filter((t) => !LEGACY.has(t)).slice(0, 4).map((t) => `<span class="paf-tag">${esc(traitName(t))}</span>`).join("")}</span></span>
      <span class="paf-summon-lvl"><span>${esc(lvlLabel)}</span>${signed(c.level)}</span>
      <i class="fa-solid fa-circle-check paf-summon-check" inert></i>
    </label>`).join("");
  const segs = levels.length > 1 ? `<div class="paf-seg" role="radiogroup">${[["", L("summon.anyLevel")], ...levels.map((l) => [String(l), signed(l)])].map(([v, t], i) => `<label><input type="radio" name="lvl" value="${v}"${i === 0 ? " checked" : ""}><span>${esc(t)}</span></label>`).join("")}</div>` : "";
  const qty = left > 1 ? `<label class="paf-summon-qty"><span>${esc(L("summon.qty"))}</span><input type="number" name="qty" min="1" max="${left}" value="${left}"></label>` : `<input type="hidden" name="qty" value="1">`;
  const content = `<div class="paf-summon">
    <div class="paf-summon-bar"><span class="paf-summon-search"><i class="fa-solid fa-magnifying-glass" inert></i><input type="search" name="q" placeholder="${esc(L("summon.search"))}" autocomplete="off"></span>${qty}</div>
    ${segs}
    <div class="paf-summon-list" role="radiogroup">${rows}</div>
    <p class="paf-summon-empty" ${list.length ? "hidden" : ""}><i class="fa-solid fa-ghost" inert></i> ${esc(L(list.length ? "summon.noMatch" : "summon.empty"))}</p>
    <p class="hint paf-summon-meta">${esc(L("summon.meta", { n: list.length, max: signed(maxLevel) }))}</p>
  </div>`;
  return foundry.applications.api.DialogV2.wait({
    window: { title: L("summon.title", { name: item.name }), icon: "fa-solid fa-ghost" }, classes: ["paf-dialog", "paf-summon-dialog"],
    position: { width: 520 }, content, rejectClose: false,
    render: (_e, dialog) => {
      const root = dialog.element, go = root.querySelector("[data-action=ok]");
      const filter = () => {
        const q = root.querySelector("[name=q]").value.trim().toLowerCase(), l = root.querySelector("[name=lvl]:checked")?.value ?? "";
        let shown = 0;
        for (const r of root.querySelectorAll(".paf-summon-row")) { r.hidden = (q && !r.dataset.name.includes(q)) || (l !== "" && r.dataset.level !== l); if (!r.hidden) shown++; }
        const empty = root.querySelector(".paf-summon-empty");
        empty.hidden = shown > 0;
        const pick = root.querySelector(".paf-summon-row:not([hidden]) input:checked");
        if (go) go.disabled = !pick;
      };
      root.querySelector("[name=q]").addEventListener("input", filter);
      for (const r of root.querySelectorAll("[name=lvl], [name=uuid]")) r.addEventListener("change", filter);
      root.querySelector(".paf-summon-list").addEventListener("dblclick", (ev) => { if (ev.target.closest(".paf-summon-row") && go && !go.disabled) go.click(); });
      filter();
      root.querySelector("[name=q]").focus();
    },
    buttons: [{ action: "ok", label: L("summon.go"), icon: "fa-solid fa-ghost", class: "paf-primary", default: true, callback: (_e, btn) => {
      const f = btn.form.elements, uuid = btn.form.querySelector(".paf-summon-row:not([hidden]) input[name=uuid]:checked")?.value;
      return uuid ? { uuid, qty: Math.min(left, Math.max(1, +f.qty.value || 1)) } : null;
    } }, { action: "no", label: L("summon.cancel"), class: "paf-ghost" }]
  });
}

async function onClick(message, ev) {
  const item = message.item, author = message.actor, scene = canvas.scene;
  const token = message.token?.object ?? author?.getActiveTokens?.()[0];
  const force = ev.altKey && game.user.isGM;
  const bad = limitProblem({ nested: isSummoned(author), minions: minionsOf(author.uuid).length, force });
  if (bad) return warn(bad, { max: LIMIT });
  const info = await callGM("summonList", message.id);
  if (!info?.ok) return globalThis.ui.notifications.warn(L("chat.failed", { reason: info?.reason }));
  const pick = await chooseDialog(item, info.result);
  if (!pick) return;
  const ft = itemRange(item, []);
  const base = doneOf(message);
  for (let i = 0; i < pick.qty; i++) {
    const pt = await pickPoint(token, ft, info.result.list.find((c) => c.uuid === pick.uuid)?.token ?? null);
    if (!pt) return;
    const res = await callGM("summonCreate", message.id, pick.uuid, base + i, { sceneId: scene.id, x: pt.x, y: pt.y, force: pt.force && game.user.isGM });
    const r = res?.result;
    if (!res?.ok || !r?.ok) return void (r?.reason && ["nested", "cap", "noSpot", "noToken", "pick", "order", "far"].includes(r.reason) ? warn(r.reason, { max: LIMIT, ft: r.ft }) : globalThis.ui.notifications.warn(L("chat.failed", { reason: res?.reason ?? r?.reason })));
  }
}

function bind(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root?.querySelector || !message.item || !message.actor?.isOwner || !isUseCard(message)) return;
  const spec = summonSpec(message.item);
  if (!spec || doneOf(message) >= countOf(spec) || root.querySelector("[data-af-summon]")) return;
  const box = document.createElement("div");
  box.className = "message-buttons paf-summon-box";
  box.innerHTML = cardButton(`data-af-summon="1"`, esc(L("summon.button")));
  const btn = box.firstElementChild;
  btn.addEventListener("click", async (ev) => {
    btn.disabled = true;
    try { await onClick(message, ev); } catch (e) { console.error(`${MOD} | summon`, e); } finally { btn.disabled = false; }
  });
  (root.querySelector(".message-buttons") ?? root.querySelector(".chat-card") ?? root.querySelector(".message-content"))?.after(box);
}

/** Обработчики сокета (main.mjs HANDLERS): список и создание. Права — автор карточки (или ГМ). */
export const handlers = {
  list: (messageId) => listFor(messageId),
  create: (messageId, uuid, n, opts) => create(messageId, uuid, n, opts)
};

export function init() {
  Hooks.on("renderChatMessageHTML", bind);
  Hooks.on("deleteItem", (item) => { onAnchorDeleted(item).catch((e) => console.error(`${MOD} | summon.anchor`, e)); });
  Hooks.on("deleteToken", (t) => { onTokenDeleted(t).catch((e) => console.error(`${MOD} | summon.token`, e)); });
  Hooks.on("updateActor", (a, ch) => { if (foundry.utils.hasProperty(ch, "system.attributes.hp") && a.token) maybeBanish(a.token).catch((e) => console.error(`${MOD} | summon.banish`, e)); });
  Hooks.on("updateToken", (t, ch) => { if (foundry.utils.hasProperty(ch, "delta.system.attributes.hp")) maybeBanish(t).catch((e) => console.error(`${MOD} | summon.banish`, e)); });
  Hooks.on("updateWorldTime", () => { cleanup().catch((e) => console.error(`${MOD} | summon.cleanup`, e)); });
  Hooks.on("deleteScene", () => { setTimeout(() => cleanup().catch(() => {}), 0); });
  Hooks.on("pf2e.startTurn", (c) => { onStartTurn(c).catch((e) => console.error(`${MOD} | summon.turn`, e)); });
  sustain.sustained.add(onSustain);
  sustain.sweepers.add(cleanup);
}
