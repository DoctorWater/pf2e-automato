// Токены из FA Nexus (необязательно, у ГМа): ступень 1 — уже скачанные файлы в папке Nexus, ступень 2 (настройка) — бесплатный каталог Nexus.
// Публичного API у Nexus нет — внутренние модули импортируются динамически, под проверенную версию (compat.EXTERNAL.verified["fa-nexus"]).
import { MOD, debug } from "./util.mjs";
import { EXTERNAL } from "./compat.mjs";

const IMG = /\.(webp|png|jpe?g|avif|gif)$/i;
// слова-варианты Nexus (цвет рамки, номер, служебные) — при сравнении имени отбрасываются
const VARIANT = new Set(["token", "tokens", "top", "base", "red", "blue", "green", "yellow", "purple", "orange", "pink", "black", "white", "grey", "gray", "brown", "cyan", "teal", "gold", "silver"]);

const words = (s) => String(s ?? "").normalize("NFKD").replace(/\.[a-z0-9]{3,4}$/i, "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
const seqAt = (hay, needle, from) => { for (let i = from; i + needle.length <= hay.length; i++) if (needle.every((w, j) => hay[i + j] === w)) return i; return -1; };

/** Чистая: очки файла/записи каталога для одного имени: 4 — имя целиком (варианты не в счёт), 3 — с начала, 2 — как слова внутри, 1 — подстрока, 0 — нет. */
export function scoreName(file, name) {
  if (/[Ѐ-ӿ]/.test(String(name ?? ""))) return 0;   // русское имя: после отбрасывания кириллицы остаются обрывки («Cкелет» с латинской C → «c» = «C1» у гоблина)
  const n = words(name).filter((w) => w.length >= 3), f = words(file);
  if (!n.length || !f.length) return 0;
  const core = f.filter((w) => !VARIANT.has(w));
  if (core.length === n.length && n.every((w, i) => core[i] === w)) return 4;
  const at = seqAt(f, n, 0);
  if (at === 0) return 3;
  if (at > 0) return 2;
  return f.join("").includes(n.join("")) ? 1 : 0;
}

/** Чистая: лучший файл из списка по списку имён (первое имя важнее; при равенстве — короче имя файла). null — если ничего не совпало. */
export function bestMatch(files, names, key = (x) => x) {
  let best = null;
  for (const f of files) {
    const base = String(key(f)).split("/").pop();
    for (let i = 0; i < names.length; i++) {
      const s = scoreName(base, names[i]);
      if (s < 2) continue;   // подстрока внутри слова — не совпадение («imp» в «simple»)
      const cand = { f, s, i, len: base.length };
      if (!best || s > best.s || (s === best.s && (i < best.i || (i === best.i && cand.len < best.len)))) best = cand;
      break;
    }
  }
  return best?.f ?? null;
}

/** Имена существа для поиска: английское оригинальное (babele), имя прототипа токена, slug (дефисы -> пробелы), без повторов. */
export function creatureNames(actor) {
  const raw = [actor?.flags?.babele?.originalName, actor?.prototypeToken?.name, String(actor?.slug ?? actor?.system?.slug ?? "").replace(/-/g, " "), actor?._source?.name];
  return [...new Set(raw.map((s) => String(s ?? "").trim()).filter((s) => words(s).length))];
}

const verified = () => { const m = game.modules.get("fa-nexus"); return !!m?.active && String(m.version).split(".").slice(0, 2).join(".") === EXTERNAL.verified["fa-nexus"]; };
const dirOf = () => { try { return game.settings.get("fa-nexus", EXTERNAL.nexus.dirSetting) || EXTERNAL.nexus.dirDefault; } catch { return EXTERNAL.nexus.dirDefault; } };

async function browseAll(dir, depth = 3) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  const out = [];
  const walk = async (d, left) => {
    const res = await FP.browse("data", d);
    out.push(...(res.files ?? []).filter((p) => IMG.test(p)));
    if (left > 0) for (const sub of res.dirs ?? []) await walk(sub, left - 1);
  };
  await walk(dir, depth);
  return out;
}

async function fromCatalog(names, dir) {
  const base = `modules/fa-nexus/scripts/content`;
  const { NexusContentService } = await import(foundry.utils.getRoute(`${base}/nexus-content-service.js`));
  const { NexusDownloadManager } = await import(foundry.utils.getRoute(`${base}/nexus-download-manager.js`));
  const svc = new NexusContentService();
  try {
    // каталог синхронизируется самим Nexus (его окно); пустой — молча null
    const { items } = await svc.list("tokens", { text: words(names[0]).sort((a, b) => b.length - a.length)[0], tier: "free" });
    const item = bestMatch(items ?? [], names, (x) => x.filename ?? x.file_path ?? "");
    if (!item) return null;
    // ponytail: только free — премиум требует OAuth-state Nexus (приватный), добавить, если у Nexus появится публичный API
    const url = await svc.getFullURL("tokens", item);
    return (await new NexusDownloadManager().ensureLocal("tokens", item, url, { forceDownload: true })) || null;
  } finally { try { svc.destroy(); } catch { /* noop */ } }
}

let files = null;   // скачанные файлы Nexus за сессию (окно выбора зовёт подбор на каждое существо списка)
const localFiles = async () => (files ??= await browseAll(dirOf()).catch(() => []));

/** Портреты для окна выбора: [{ names }] -> [путь|null] — только уже скачанные файлы Nexus (без сети); тот же подбор, что у токена на сцене. */
export async function nexusArt(entries) {
  try {
    if (!game.user?.isGM || !verified()) return entries.map(() => null);
    const have = await localFiles();
    return entries.map((e) => (e.names?.length ? bestMatch(have, e.names) : null));
  } catch (e) { debug("nexusArt", e); return entries.map(() => null); }
}

/** Путь к файлу токена из Nexus для существа или null (любой сбой — null). Зовёт активный ГМ. */
export async function nexusToken(actor) {
  try {
    if (!game.user?.isGM || !verified()) return null;
    const names = creatureNames(actor);
    if (!names.length) return null;
    const dir = dirOf();
    const have = await localFiles();
    const hit = bestMatch(have, names);
    if (hit) return hit;
    if (!game.settings.get(MOD, "nexusTokens")) return null;
    const got = await fromCatalog(names, dir);
    if (got) files = null;   // скачан новый файл — список заново при следующем подборе
    return got;
  } catch (e) { debug("nexusToken", e); return null; }
}

export function init() {
  game.settings.register(MOD, "nexusTokens", { name: "PF2E_AUTOMATO.nexus.name", hint: "PF2E_AUTOMATO.nexus.hint", scope: "world", config: true, type: Boolean, default: false });
}
