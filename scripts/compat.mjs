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
export function ready() { index = null; getIndex(); }

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
