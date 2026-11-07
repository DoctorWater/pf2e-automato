// Единственная обёртка Actor#applyDamage на модуль (libWrapper не даёт регистрировать одну цель дважды).
// Подписчик: async (actor, opts, ctx) => ({ opts?, actor?, after?(res) }) | undefined. «До» — может заменить opts и актёра (свежий клон после реакции); after — после применения урона.
// first — подписчик идёт первым (удержание урона до решения о реакции, builtin/damaged.mjs): остальные видят уже изменённый opts.
import { MOD } from "../util.mjs";

const APPLY = "CONFIG.Actor.documentClass.prototype.applyDamage";
const subs = [];
let installed = false;

export function subscribe(fn, { first = false } = {}) {
  if (subs.includes(fn)) return;
  if (first) subs.unshift(fn); else subs.push(fn);
}

let clickSource = () => null;
/** Откуда пришёл клик по кнопке урона pf2e: fn() -> {id} | null. Снимок берётся в начале нанесения, до ожиданий подписчиков (удержание длиннее жизни метки клика). */
export const setClickSource = (fn) => { clickSource = fn; };

// Повторный вход с подменённым актёром (см. ниже): подписчики уже отработали — сразу к pf2e.
const PASS = Symbol("af-apply-pass");

async function wrap(orig, opts, ...rest) {
  if (opts?.[PASS]) { const { [PASS]: _pass, ...o } = opts; return orig.call(this, o, ...rest); }
  const afters = [];
  let self = this;
  const ctx = { click: clickSource() };   // подписчикам третьим аргументом
  for (const s of [...subs]) {
    const r = await s(self, opts, ctx);
    if (r?.opts) opts = r.opts;
    if (r?.actor) self = r.actor;
    if (r?.after) afters.push(r.after);
  }
  // libWrapper отдаёт orig, уже привязанный к исходному актёру: orig.call(self) подмену игнорирует (временное сопротивление клона терялось).
  // Подменённый актёр наносит урон своим методом — с меткой прохода, чтобы подписчики не сработали второй раз.
  // Внешние обёртки других модулей (WRAPPER поверх нашей MIXED) при этом проходят дважды: на исходном актёре и на клоне.
  // Сейчас безвредно (pf2e-auto-action-tracker лишь помечает источник, метка ко второму проходу снята); новая такая обёртка с побочным эффектом — проверить.
  const res = self === this ? await orig.call(this, opts, ...rest) : await self.applyDamage({ ...opts, [PASS]: true }, ...rest);
  for (const a of afters) await a(res, opts);
  return res;
}

/** Идемпотентно: можно звать из любого подписчика. */
export function install() {
  if (installed) return;
  if (globalThis.game?.modules?.get("lib-wrapper")?.active && globalThis.libWrapper) {
    // MIXED: с подменённым актёром wrapped не вызывается (урон наносит актёр-клон) — WRAPPER счёл бы это ошибкой и вызвал оригинал сам (двойной урон)
    libWrapper.register(MOD, APPLY, wrap, "MIXED");
    installed = true;
    return;
  }
  const proto = CONFIG.Actor.documentClass?.prototype;
  if (!proto?.applyDamage || proto.applyDamage.__afApply) { installed = !!proto?.applyDamage; return; }
  const orig = proto.applyDamage;
  proto.applyDamage = function (...a) { return wrap.call(this, orig, ...a); };
  proto.applyDamage.__afApply = true;
  installed = true;
}
