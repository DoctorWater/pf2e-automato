// Один исполнитель среди сессий (вкладок) активного ГМа. Без импортов: чистая часть тестируется под node.
// Лидер стабилен: наименьший sid среди живых и ГОТОВЫХ (ready) сессий; видимость вкладки не влияет.
export const BEAT = 4000, TTL = 15000, TTL_HIDDEN = 75000, SETTLE = 500, DIALOG_MS = 180000, CALL_MS = 200000;
export const newSid = () => Date.now().toString(36).padStart(9, "0") + Math.random().toString(36).slice(2, 8);

/** peers: Map sid -> { t, ready, hidden }. Скрытая (троттлится таймером) вкладка живёт дольше. */
export const alive = (p, now) => !!p && now - p.t <= (p.hidden ? TTL_HIDDEN : TTL);

/** Кандидат — готовая сессия; одна готовая сессия (peers пуст) — лидер сразу. Нет кандидатов — undefined. */
export function pickLeader(self, selfReady, peers, now) {
  const ids = [...peers].filter(([s, p]) => s !== self && p.ready && alive(p, now)).map(([s]) => s);
  if (selfReady) ids.push(self);
  return ids.sort()[0];
}

export const sid = newSid();
const peers = new Map();
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sock = null, handlers = null, leadCb = null, wasLead = false, started = false, ready = false, settling = false, settledP = Promise.resolve(), settle = null;

const me = () => globalThis.game?.user?.id;
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const selfReady = () => ready || !started;   // без start() (не-ГМ, тесты) — как готовая одиночная сессия
export const leaderSid = () => pickLeader(sid, selfReady(), peers, Date.now());
export const isLeader = () => !settling && leaderSid() === sid;
export const whenSettled = () => settledP;

/** fn вызывается при каждом переходе в лидеры (в т.ч. первом, после ready) — подхватить работу ушедшего лидера. */
export const onLead = (fn) => { leadCb = fn; };
function checkLead() {
  const now = isLeader();
  if (now && !wasLead) leadCb?.();
  wasLead = now;
}

const ping = () => sock.executeForOtherGMs("sessionPing", sid, ready, hidden());
const note = (from, r, h) => peers.set(from, { t: Date.now(), ready: r, hidden: h });
const mine = (ctx) => !!me() && ctx.socketdata?.userId === me();
const net = () => started && sock && globalThis.game?.user?.isGM;

/* ---------- общее окно выбора: показывается во всех вкладках этого ГМа, первый ответ побеждает ---------- */
const dialogs = new Map();   // id -> resolve (на запросившей вкладке)
const finished = new Set();
/** Значения полей формы: checkbox — checked, radio — значение отмеченного (нет отмеченного — ключа нет). */
export const formOf = (f) => {
  const out = {};
  for (const e of f?.elements ?? []) {
    if (!e.name) continue;
    if (e.type === "radio") { if (e.checked) out[e.name] = e.value; }
    else out[e.name] = e.type === "checkbox" ? e.checked : e.value;
  }
  return out;
};
const dlgId = (id) => `pf2e-automato-dlg-${id}`;

async function show(id, spec) {
  if (finished.has(id)) return null;
  const res = await foundry.applications.api.DialogV2.wait({
    id: dlgId(id), classes: ["paf-dialog"], window: { title: spec.title }, content: spec.content, rejectClose: false,
    render: (_e, dlg) => { if (finished.has(id)) dlg.close(); },   // «готово» пришло, пока окно открывалось
    buttons: spec.buttons.map((b, i) => ({ action: b.action, label: b.label, default: i === 0, callback: (_e, btn) => ({ action: b.action, form: formOf(btn.form) }) }))
  });
  if (!finished.has(id)) { finished.add(id); if (net()) sock.executeForOtherGMs("sessionDialogDone", { id, res }); }
  return res;
}

/**
 * spec: { title, content (HTML), buttons: [{ action, label }] } -> { action, form: {имя: значение|checked} } | null (закрыто).
 * Закрытие любого окна считается отменой для всех.
 */
export async function sharedDialog(spec) {
  const id = Math.random().toString(36).slice(2);
  if (!net()) return show(id, spec);
  const remote = new Promise((r) => dialogs.set(id, r));
  sock.executeForOtherGMs("sessionDialog", { id, spec });
  try { return await Promise.race([show(id, spec), remote]); }
  finally { dialogs.delete(id); }
}

/** На socketlib.ready. */
export function register(socket, HANDLERS) {
  sock = socket; handlers = HANDLERS;
  socket.register("sessionPing", function (from, r, h) {
    if (from === sid || !mine(this)) return;
    note(from, r, h);
    sock.executeForOtherGMs("sessionPong", sid, ready, hidden());   // pong на каждый ping; на pong не отвечаем
  });
  socket.register("sessionPong", function (from, r, h) { if (from !== sid && mine(this)) note(from, r, h); });
  socket.register("sessionBye", function (from) { if (mine(this)) { peers.delete(from); checkLead(); } });
  socket.register("sessionCall", async function (d) {
    if (!mine(this) || d.to !== sid || !Object.hasOwn(handlers, d.name)) return;
    const res = isLeader() ? await handlers[d.name].call({ socketdata: { userId: this.socketdata.userId } }, ...d.args) : { ok: false, reason: "not-leader" };
    sock.executeForOtherGMs("sessionResult", { to: d.from, id: d.id, res });
  });
  socket.register("sessionResult", function (d) { if (d.to === sid && mine(this)) pending.get(d.id)?.(d.res); });
  socket.register("sessionDialog", function (d) { if (mine(this) && net()) show(d.id, d.spec); });
  socket.register("sessionDialogDone", function (d) {
    if (!mine(this)) return;
    finished.add(d.id);
    dialogs.get(d.id)?.(d.res);
    foundry.applications.instances.get(dlgId(d.id))?.close();
  });
}

/** Как только известен game.user (хук setup); идемпотентно. Кандидатом сессия станет только после markReady(). */
export function start() {
  if (started || !sock || !game.user?.isGM) return;
  started = true;
  settling = true;
  settledP = new Promise((r) => { settle = r; });
  ping();
  setInterval(() => { ping(); checkLead(); }, BEAT);
  document.addEventListener("visibilitychange", ping);
  addEventListener("pagehide", () => sock.executeForOtherGMs("sessionBye", sid));
}

/** Хук ready: объявляем готовность; окно знакомства отсчитывается от неё. */
export function markReady() {
  start();
  if (!started || ready) return;
  ready = true;
  ping();
  sleep(SETTLE).then(() => { settling = false; settle(); checkLead(); });
}

/**
 * Не-лидерская вкладка активного ГМа (кнопка в UI): выполнить обработчик на лидере и вернуть его ответ.
 * Лидер сменился — повтор на новом (запрос свой, старый лидер его не принял); стали лидером сами — исполняем локально.
 */
export async function callLeader(name, args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isLeader()) return handlers[name].call({ socketdata: { userId: me() } }, ...args);
    const res = await new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const done = (r) => { clearTimeout(timer); pending.delete(id); resolve(r); };
      const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), CALL_MS);
      pending.set(id, done);
      sock.executeForOtherGMs("sessionCall", { to: leaderSid(), from: sid, id, name, args });
    });
    if (res?.reason !== "not-leader") return res;
    await sleep(BEAT);
  }
  return { ok: false, reason: "not-active-gm" };
}
