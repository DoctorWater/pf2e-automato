// Значок «автоматизировано» у предметов в листах актёров pf2e (AppV1: renderActorSheet, строки li[data-item-id]).
import { MOD, L } from "./util.mjs";
import { resolveRule } from "./rules.mjs";
import { automationsGroups, shouldYield } from "./compat.mjs";
import { DENY } from "./sheet.mjs";
import { rev } from "./settings.mjs";
import { itemUseKind, wantsSnapshot } from "./use.mjs";

/* ---------- Чистая часть: текст подсказки (node-тесты) ---------- */

const hasSteps = (list) => (list ?? []).some((a) => a.condition || a.effect || a.visibility);
const byDegSteps = (c) => Object.values(c?.byDegree ?? {}).some(hasSteps);

/** Короткие части описания правила: «испытание Воли», «состояния», «зона»... t(key, data) = L. */
export function ruleParts(rule, t, statLabel = (s) => s) {
  const u = rule?.onUse, ch = u?.challenge, ck = u?.check, out = [];
  if (ch) out.push(t("sheet.badge.challenge", { stat: statLabel(ch.statistic) }));
  if (ck) out.push(t("sheet.badge.check"));
  if (hasSteps(u?.apply) || byDegSteps(ch) || byDegSteps(ck)) out.push(t("sheet.badge.states"));
  if (u?.zone) out.push(t("sheet.badge.zone"));
  if (rule?.onAttacked) out.push(t("sheet.badge.reaction"));
  if (rule?.macros?.length) out.push(t("sheet.badge.macros"));
  return out;
}

/** res = результат resolveRule; groups — группы pf2e-automations, yielded — правило уступает им. */
export function badgeTip(res, { t, groups = [], yielded = false, statLabel }) {
  if (yielded) return t("sheet.badge.yielded", { groups: groups.join(", ") });
  const parts = [t("sheet.badge.tip", { what: ruleParts(res.rule, t, statLabel).join(", ") || t("sheet.badge.rule") }), t(`sheet.src.${res.source}`)];
  if (res.confidence === "low") parts.push(t("sheet.confLow"));
  return parts.join(" · ");
}

/* ---------- Лист ---------- */

// Разбор (флаг, каталоги, разметка) делаем один раз на версию предмета и каталогов (settings.rev).
// Текст подсказки и compat-группы считаем при каждой отрисовке: они дёшевы и зависят от языка/настроек.
const cache = new Map();   // uuid -> { mt, rv, res }
function resolved(item) {
  const mt = item._stats?.modifiedTime ?? 0, hit = cache.get(item.uuid);
  if (hit && hit.mt === mt && hit.rv === rev.n) return hit.res;
  const res = resolveRule(item);
  cache.set(item.uuid, { mt, rv: rev.n, res });
  return res;
}

const statLabel = (s) => { const k = CONFIG.PF2E.saves?.[s] ?? CONFIG.PF2E.skills?.[s]?.label ?? CONFIG.PF2E.attributes?.[s]; return k ? game.i18n.localize(k) : s; };

function decorate(app, $html) {
  const root = $html?.[0] ?? $html, actor = app.actor;
  if (!root?.querySelectorAll || !actor) return;
  for (const row of root.querySelectorAll("li[data-item-id]")) {
    if (row.querySelector(".paf-mark")) continue;
    const item = actor.items.get(row.dataset.itemId);
    if (!item || DENY.has(item.type) || item.type === "spellcastingEntry") continue;
    if (!game.user.isGM && item.isIdentified === false) continue;
    const kind = itemUseKind(item);   // те же фильтры, что при использовании (use.mjs) и в реакциях (onAttacked)
    if (!kind) continue;
    const res = resolved(item);
    if (!res || !(wantsSnapshot(kind, res.rule) || res.rule.onAttacked)) continue;
    const groups = automationsGroups({ slug: res.slug, sourceUuid: res.sourceUuid });
    const yielded = shouldYield(res.rule, { slug: res.slug, sourceUuid: res.sourceUuid });
    const anchor = row.querySelector('a[data-action="toggle-summary"]') ?? row.querySelector(".name");
    if (!anchor) continue;
    const mark = document.createElement("i");
    mark.className = `fa-solid fa-bolt paf-mark${yielded ? " paf-mark-yield" : ""}`;
    mark.dataset.tooltip = foundry.utils.escapeHTML(badgeTip(res, { t: L, groups, yielded, statLabel }));
    anchor.after(mark);
  }
}

export function init() {
  Hooks.on("renderActorSheet", (app, $html) => { try { decorate(app, $html); } catch (e) { console.error(`${MOD} | badge`, e); } });
}
