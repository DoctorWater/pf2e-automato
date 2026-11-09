import { S } from "./settings.mjs";

const AUTOMATIONS = "pf2e-automations";
// Предикат pf2e-automations матчится по roll options сообщения: item:slug:x, origin:item:x, consumable:x, action:x, feat:x ...
const STRONG = /^(?:origin:item:slug|item:slug|origin:item|item|consumable:slug|consumable|action):([a-z0-9-]+)$/;
const WEAK = /^(?:feat|feature|spell):([a-z0-9-]+)$/;   // чаще условия («у актёра есть фит»), берём лишь если в предикате нет STRONG
const SOURCE_ID = /^(?:origin:)?item:sourceId:(Compendium\..+)$/;

/** Строки предиката (массив/or/and); `not` пропускаем. */
function predicateTokens(pred, out = []) {
  if (typeof pred === "string") out.push(pred);
  else if (Array.isArray(pred)) for (const p of pred) predicateTokens(p, out);
  else if (pred && typeof pred === "object") for (const [k, v] of Object.entries(pred)) if (k !== "not") predicateTokens(v, out);
  return out;
}

/**
 * Чистая функция: реестр rulesV3 pf2e-automations ({uuid: группа} либо массив) -> индекс активных групп.
 * source[]: "Compendium.*" -> uuids, остальное -> slugs; плюс slug-и из предикатов и slug имени группы (§2 compat).
 */
export function buildAutomationsIndex(rules) {
  const groups = [];
  for (const g of Object.values(rules ?? {})) {
    if (!g || g.isActive === false) continue;
    const slugs = new Set(), uuids = new Set();
    for (const s of g.source ?? []) (String(s).startsWith("Compendium.") ? uuids : slugs).add(s);
    for (const r of [...(g.baseRules ?? []), ...(g.complexRules ?? []), ...(g.handlerRules ?? [])]) {
      const toks = predicateTokens(r?.predicate).filter((t) => !t.includes("{"));
      const strong = toks.map((t) => STRONG.exec(t)?.[1]).filter(Boolean);
      for (const t of toks) { const u = SOURCE_ID.exec(t)?.[1]; if (u) uuids.add(u); }
      for (const x of strong.length ? strong : toks.map((t) => WEAK.exec(t)?.[1]).filter(Boolean)) slugs.add(x);
    }
    if (g.name) slugs.add(String(g.name).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
    groups.push({ name: g.name ?? g.uuid ?? "?", slugs, uuids });
  }
  return groups;
}

const matches = (g, slug, sourceUuid) => (!!slug && g.slugs.has(slug)) || (!!sourceUuid && g.uuids.has(sourceUuid));
export const groupsCovering = (index, { slug, sourceUuid } = {}) => index.filter((g) => matches(g, slug, sourceUuid)).map((g) => g.name);

let index = null;   // null = перестроить при следующем обращении

export const resetIndex = () => { index = null; };

function getIndex() {
  if (index) return index;
  const active = globalThis.game?.modules?.get(AUTOMATIONS)?.active;
  let rules = null;
  if (active) try { rules = game.settings.get(AUTOMATIONS, "rulesV3"); } catch (e) { console.warn("pf2e-automato | rulesV3 недоступен", e); }
  return (index = buildAutomationsIndex(rules));
}

export function init() {
  // реестр pf2e-automations меняется их настройкой -> сброс индекса
  Hooks.on("updateSetting", (setting) => { if (setting.key === `${AUTOMATIONS}.rulesV3`) index = null; });
  Hooks.on("createSequencerEffect", teleportGhost);
}

/** Пресет «Телепортация» A-A: у выбирающего — заметный круг дальности (у A-A тонкая линия) и полупрозрачный токен за курсором — там, куда A-A его поставит. */
function teleportGhost(effect) {
  const token = effect.data?.name === "teleportation" && effect.data.creatorUserId === game.user.id ? effect.sourceDocument?.object : null;
  if (!token?.mesh?.texture) return;
  const shape = effect.data.shapes?.[0], color = game.user.color;
  const ring = new PIXI.Graphics();
  if (shape?.type === "circle") {
    const r = shape.radius * (shape.gridUnits ? canvas.grid.size : 1);
    ring.beginFill(color, 0.12).drawCircle(0, 0, r).endFill()
      .lineStyle(14, 0x000000, 0.5).drawCircle(0, 0, r)
      .lineStyle(7, color, 1).drawCircle(0, 0, r);
    ring.position.set(token.center.x, token.center.y);
  }
  const ghost = new PIXI.Sprite(token.mesh.texture);
  Object.assign(ghost, { width: Math.abs(token.mesh.width), height: Math.abs(token.mesh.height), alpha: 0.5 });
  ghost.anchor.set(0.5);
  canvas.controls.addChild(ring, ghost);
  const stop = () => {
    canvas.app.ticker.remove(follow); Hooks.off("endedSequencerEffect", hook);
    for (const g of [ring, ghost]) if (!g.destroyed) g.destroy();
  };
  const follow = () => {
    if (ghost.destroyed) return stop();   // сцену сменили — холст убрал спрайт
    const p = canvas.grid.getTopLeftPoint(canvas.mousePosition);   // A-A ставит левый верхний угол токена в клетку под курсором
    ghost.position.set(p.x + token.w / 2, p.y + token.h / 2);
  };
  const hook = Hooks.on("endedSequencerEffect", (e) => { if (e === effect) stop(); });
  canvas.app.ticker.add(follow);
}

/**
 * Внешние точки: чужие селекторы и приватные флаги, на которые модуль опирается. Промах при обновлении pf2e/Toolbelt/Workbench тихий
 * (двойной путь к урону, §3.5), поэтому все они — здесь, а при ready проверяются (selfCheck). verified — major.minor, под которые проверено.
 */
export const EXTERNAL = {
  verified: { pf2e: "8.7", "pf2e-toolbelt": "3.61", "xdy-pf2e-workbench": "7.7", "pf2e-auto-action-tracker": "0.19", "fa-nexus": "0.5" },
  // FA Nexus (nexus-tokens.mjs): настройка папки скачанных токенов (scripts/settings.js) и её значение по умолчанию
  nexus: { dirSetting: "cloudDownloadDirTokens", dirDefault: "fa-nexus-tokens" },
  selectors: {
    spellDamage: "button[data-action='spell-damage']",
    spellTemplate: "button[data-action='spell-template']",
    effectArea: "a.effect-area[data-effect-area]",
    damageRoll: "a.inline-roll[data-damage-roll]",
    anyDamageButton: "button[data-action$='-damage']",
    revertDamage: "[data-action=revertDamage]",
    statements: "span.statements"
  },
  flags: {   // пути для updateSource/update (с префиксом flags.) и для объекта flags (без него — flagKeys)
    tbSkip: "flags.pf2e-toolbelt.targetHelper.skip",
    tbApplied: (tokenId) => `flags.pf2e-toolbelt.targetHelper.applied.${tokenId}.0`,
    wbNoAutoDamage: { scope: "xdy-pf2e-workbench", key: "noAutoDamageRoll" },
    // pf2e-auto-action-tracker считает действие, только если сам видел «использование» (клик на клиенте игрока) — карточки, которые модуль
    // создаёт у ГМа (Поддержание кнопкой, «Сотворить» активации), помечаем его флагами (main.js: isExplicitUse, isSustainAutomation)
    tracker: { scope: "pf2e-auto-action-tracker", explicitUse: "isExplicitUse", sustain: "isSustainAutomation" }
  },
  // шаблоны pf2e, в которых обязаны быть строки (по ним строятся селекторы выше)
  templates: [{ path: "systems/pf2e/templates/chat/spell-card.hbs", needles: ["data-action=\"spell-damage\"", "data-action=\"spell-template\""] }]
};

const mm = (v) => String(v ?? "").split(".").slice(0, 2).join(".");

/** Чистая: versions {id: "x.y.z"|null (нет/не активен)} + templates {path: text|null} -> список расхождений (строки). Не установленное не считается расхождением. */
export function externalProblems(ext, versions, templates = {}) {
  const out = [];
  for (const [id, want] of Object.entries(ext.verified)) {
    const have = versions[id];
    if (have && mm(have) !== want) out.push(`${id} ${have} (проверено ${want}): ${externalPointsOf(ext, id)}`);
  }
  for (const t of ext.templates) {
    const text = templates[t.path];
    if (text == null) out.push(`${t.path}: шаблон не загрузился`);
    else for (const n of t.needles) if (!text.includes(n)) out.push(`${t.path}: нет ${n}`);
  }
  return out;
}

function externalPointsOf(ext, id) {
  const sel = id === "pf2e" ? Object.values(ext.selectors) : [];
  const fl = id === "pf2e-toolbelt" ? [ext.flags.tbSkip, "flags.pf2e-toolbelt.targetHelper.applied.*"] : id === "xdy-pf2e-workbench" ? [`flags.${ext.flags.wbNoAutoDamage.scope}.${ext.flags.wbNoAutoDamage.key}`] : [];
  return [...sel, ...fl].join(", ");
}

async function selfCheck() {
  if (!game.user.isActiveGM) return;
  const versions = { pf2e: game.system?.version ?? null };
  for (const id of Object.keys(EXTERNAL.verified)) if (id !== "pf2e") { const m = game.modules.get(id); versions[id] = m?.active ? m.version : null; }
  const templates = {};
  for (const t of EXTERNAL.templates) templates[t.path] = await fetch(foundry.utils.getRoute(t.path)).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  const bad = externalProblems(EXTERNAL, versions, templates);
  if (bad.length) console.warn(`pf2e-automato | внешние точки могли разойтись с чужими версиями:\n - ${bad.join("\n - ")}`);
}

export function ready() { index = null; getIndex(); selfCheck().catch((e) => console.warn("pf2e-automato | selfCheck", e)); }

export const automationsCovers = (o) => groupsCovering(getIndex(), o).length > 0;
export const automationsGroups = (o) => groupsCovering(getIndex(), o);
export function shouldYield(rule, o) {
  return !!(rule?.yield ?? S.get("yieldToAutomations")) && automationsCovers(o);
}

export function toolbeltTargetHelper() {
  const off = { enabled: false, checks: false, targets: false, api: null };
  const tb = globalThis.game?.toolbelt;
  if (!game.modules.get("pf2e-toolbelt")?.active || !tb?.getToolSetting) return off;
  const get = (k) => !!tb.getToolSetting("targetHelper", k);
  return { enabled: get("enabled"), checks: get("checks"), targets: get("targets"), api: tb.api?.targetHelper ?? null };
}

export function toolbeltMessageTargets(message) {
  const th = toolbeltTargetHelper();
  if (!th.enabled || !th.api?.getMessageTargets) return null;
  const t = th.api.getMessageTargets(message);
  return t?.length ? t : null;
}

/** Флаги pf2e-auto-action-tracker для карточки, созданной модулем от имени актёра: kind "use" (действие/заклинание) | "sustain" (+ item — что поддержано). {} — трекер выключен. */
export function trackerFlags(kind, item = null) {
  const t = EXTERNAL.flags.tracker;
  if (!globalThis.game?.modules?.get(t.scope)?.active) return {};
  if (kind === "sustain") return { [t.scope]: { [t.sustain]: true, ...(item && { sustainedItemId: item.id, sustainedItemUuid: item.uuid, sustainedItemName: item.name }) } };
  return { [t.scope]: { [t.explicitUse]: true } };
}

/** fn создаёт сообщения актёра (действие pf2e без своих опций сообщения) — им на время fn добавляются флаги трекера. */
export async function withTracker(actor, flags, fn) {
  if (!Object.keys(flags).length) return fn();
  const hook = Hooks.on("preCreateChatMessage", (m) => { if (m.speaker?.actor === actor?.id) m.updateSource({ flags }); });
  try { return await fn(); } finally { Hooks.off("preCreateChatMessage", hook); }
}
