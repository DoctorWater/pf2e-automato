// Макросы правил (plan.md §1.1 «Контракт макросов»). Исполняет только активный ГМ.
import { MOD, L, DEGREES, flagPath, queue, socket, isActiveGM, sceneOfUuid } from "./util.mjs";
import { modeOf } from "./settings.mjs";
import { inRange } from "./range.mjs";
import { BUILTIN, initBuiltinHooks } from "./builtin/index.mjs";

const TIMEOUT_MS = 30000;
const NO_DEDUP = new Set(["zoneEnter", "zoneExit"]);   // дедуп зон — на стороне hold/release
const inflight = new Set();

const safeUuid = async (uuid) => { try { return uuid ? await fromUuid(uuid) : null; } catch { return null; } };
const safeSync = (uuid) => { try { return uuid ? fromUuidSync(uuid) : null; } catch { return null; } };

/** Цели из снимка (область -> токены сцены региона, иначе use.targets), когда ctx.targets не передан. */
function targetsOf(use) {
  const area = use?.state?.area;
  if (area?.keys?.length) {
    const scene = safeSync(area.regionUuid)?.parent ?? sceneOfUuid(area.regionUuid);
    if (scene) return area.keys.map((k) => scene.tokens.get(k)).filter(Boolean);
  }
  return inRange(use?.targets).map((t) => safeSync(t.uuid)).filter(Boolean);
}

/** id встроенного обработчика: {builtin:"id"} или (форма, проходящая validateRule до его правки) {uuid:"builtin:id"}. */
export const builtinId = (ref) => ref.builtin ?? (ref.uuid?.startsWith("builtin:") ? ref.uuid.slice(8) : null);
const refKey = (ref) => { const b = builtinId(ref); return b ? `builtin:${b}` : ref.uuid; };

export async function runMacroRef(ref, scope) {
  const bid = builtinId(ref);
  const handler = bid ? BUILTIN[bid] : null;
  const macro = bid ? null : await safeUuid(ref.uuid);
  const name = bid ? `builtin:${bid}` : macro?.name ?? ref.uuid;
  const fail = (error) => {
    console.error(`${MOD} | макрос ${name}: ${error}`);
    ui.notifications.warn(L("saves.macroError", { name, error }));
    return { ok: false, error };
  };
  if (bid ? !handler : !macro) return fail(L(bid ? "builtin.unknown" : "saves.macroNotFound"));
  if (macro?.type === "script" && !game.user.can("MACRO_SCRIPT")) return fail(L("saves.macroNoPerm"));
  const player = handler?.player ? playerOf(scope) : null;
  const run = Promise.resolve().then(() => (player ? socket.executeAsUser("runPlayerBuiltin", player.id, bid, packScope(scope))
    : handler ? handler.run(scope) : macro.execute(scope)));
  run.catch(() => {});   // позднее отклонение после таймаута не должно стать unhandled
  let timer;
  const ms = handler?.timeoutMs ?? TIMEOUT_MS;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(L("saves.macroTimeout"))), ms); });
  try {
    const result = await Promise.race([run, timeout]);
    if (handler?.finish) await handler.finish(result, scope);
    return { ok: true };
  }
  catch (e) { return fail(String(e?.message ?? e)); }
  finally { clearTimeout(timer); }
}

/** Автор сообщения — игрок онлайн и владелец актёра: броски обработчика с player:true идут у него (его кубы, его диалог). */
export function playerOf(scope) {
  const u = scope.message?.author;
  return u && !u.isGM && u.active && u.id !== game.user.id && scope.actor?.testUserPermission?.(u, "OWNER") ? u : null;
}

const packScope = (s) => ({ phase: s.phase, actor: s.actor?.uuid ?? null, token: s.token?.uuid ?? null, item: s.item?.uuid ?? null,
  message: s.message?.id ?? null, targets: (s.targets ?? []).map((t) => t.uuid) });

/** Сокет, у игрока: запрос только от ГМа; scope собирается заново по uuid. Результат уходит ГМу (finish). */
export async function runPlayerBuiltin(bid, packed) {
  if (!game.users.get(this?.socketdata?.userId)?.isGM) return null;
  const handler = BUILTIN[bid];
  if (!handler?.player) return null;
  const targets = (await Promise.all((packed.targets ?? []).map(safeUuid))).filter(Boolean);
  return handler.run({ phase: packed.phase, actor: await safeUuid(packed.actor), token: await safeUuid(packed.token), item: await safeUuid(packed.item),
    message: game.messages.get(packed.message) ?? null, targets, target: null, degree: null, outcome: null, results: {}, region: null, dc: null, args: {} });
}

async function buildScope(phase, ctx, use, rule) {
  const degree = ctx.degree ?? null;
  const token = await safeUuid(use?.token);
  return {
    phase,
    actor: ctx.actor ?? (await safeUuid(use?.actor)) ?? token?.actor ?? null,
    token,
    item: ctx.item ?? await safeUuid(use?.item?.uuid),
    message: ctx.message ?? null,
    rule,
    targets: ctx.targets ?? targetsOf(use),
    target: ctx.target ?? null,
    degree,
    outcome: DEGREES[degree] ?? null,
    results: ctx.results ?? use?.state?.challenge?.results ?? {},
    region: ctx.region ?? safeSync(use?.state?.area?.regionUuid ?? use?.state?.zone?.regionUuid) ?? null,
    dc: use?.dc ?? null,
    args: ctx.args ?? {}
  };
}

/** ctx: {message?, rule?, region?, target?, targets?, degree?, results?, args?}. Возвращает [{key, ok, error?}]. */
export async function runMacros(phase, ctx = {}) {
  if (!isActiveGM() || modeOf("macro") === "off") return [];
  const { message } = ctx;
  const use = message?.flags?.[MOD]?.use;
  const rule = ctx.rule ?? use?.rule;
  const refs = (rule?.macros ?? []).filter((m) => m.phase === phase
    && (phase !== "onDegree" || !m.degree || m.degree === DEGREES[ctx.degree]));
  if (!refs.length) return [];

  const dedup = !!use && !NO_DEDUP.has(phase);
  const tkey = ctx.target?.id ?? "-";
  const out = [];
  let scope;
  const st = () => message.flags[MOD].use.state?.macros;
  for (const ref of refs) {
    const key = `${message?.id ?? "-"}|${phase}|${tkey}|${refKey(ref)}`;
    if (dedup) {
      // claim синхронный: параллельные вызовы не запустят макрос дважды
      if (inflight.has(key) || st()?.done?.includes(key)) continue;
      inflight.add(key);
    }
    try {
      scope ??= await buildScope(phase, ctx, use, rule);
      if (dedup) await queue(`macros:${message.id}`, () => message.update({ [flagPath("use", "state", "macros", "done")]: [...(st()?.done ?? []), key] }));
      const r = await runMacroRef(ref, scope);
      if (!r.ok && dedup) await queue(`macros:${message.id}`, () => message.update({ [flagPath("use", "state", "macros", "errors")]: [...(st()?.errors ?? []), { key, msg: r.error }] }));
      out.push({ key, ...r });
    } catch (e) {   // сбой подготовки/записи не ломает конвейер
      console.error(`${MOD} | runMacros ${phase}`, e);
      out.push({ key, ok: false, error: String(e?.message ?? e) });
    } finally { inflight.delete(key); }
  }
  return out;
}

// Хуки встроенных обработчиков без правила (кровная магия, Реагирующий удар, статуэтка) — при загрузке модуля.
initBuiltinHooks();
