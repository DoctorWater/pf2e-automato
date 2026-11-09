// Общее для конвейера: пути, ввод-вывод, текст без HTML. Только stdlib.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(ROOT, "tools", "out");
export const DATA = process.env.PF2E_DATA ?? join(homedir(), "AppData/Local/FoundryVTT/Data");   // Windows: данные Foundry в профиле пользователя
export const PF2RU = join(DATA, "modules/pf2ru-translation");
// запасной источник (json 8.4.1), если LevelDB 8.6.1 не открылся (tools/packs.mjs). Другой каталог: PF2E_PACKS=...
export const PACKS = process.env.PF2E_PACKS ?? join(PF2RU, "sources/pf2e-8.4.1/packs");
export const RU_PACKS = join(PF2RU, "generated/data/community/pf2e/packs");
export const AUTOMATIONS_CONFIG = join(DATA, "modules/pf2e-automations/rules/config.json");
export const DRAFTS = join(ROOT, "rules", "drafts");
export const ACCEPTED = join(ROOT, "rules", "drafts-accepted");

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const writeJson = (p, obj, indent) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, indent)); };
export const writeText = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
export const outPath = (...p) => join(OUT, ...p);
export const readOut = (name) => {
  const p = outPath(name);
  if (!existsSync(p)) throw new Error(`нет ${p}: сначала запустите предыдущий шаг (node tools/run.mjs)`);
  return readJson(p);
};
/** Запущен ли модуль как скрипт (а не импортирован тестом). */
export const isMain = (url) => !!process.argv[1] && pathToFileURL(process.argv[1]).href === url;
export const arg = (name, def = null) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : process.argv[i + 1] ?? true;
};
/** Сравнение строк без локали (детерминированно на любой машине). */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ENT = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&rsquo;": "'" };

/** HTML -> текст: теги долой, @UUID/@Check/@Template/@Damage остаются, абзацы — переносы. */
export function stripHtml(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<\/(p|li|tr|h\d|div)>|<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|rsquo);/g, (m) => ENT[m])
    .replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

// Строки с механикой: блоки степеней, Trigger/Requirements/Frequency/Effect/Heightened, разметка @Check/@Template/@Damage/@UUID. Их не режем.
const MECH = /@(?:Check|Template|Damage|UUID|Localize)\[|^(?:Critical Success|Success|Failure|Critical Failure|Critical Fail|Критический успех|Успех|Провал|Критический провал|Trigger|Requirements?|Frequency|Effect|Heightened|Условие|Требования|Частота|Эффект|Усиление|Усиленн)/i;
const sentenceCut = (s, n) => {
  const h = s.slice(0, n), k = Math.max(h.lastIndexOf(". "), h.lastIndexOf(".\n"));
  return (k > n * 0.5 ? h.slice(0, k + 1) : h).trimEnd();
};

/**
 * Сжатие описания до ~max знаков: строки с механикой остаются целиком, режется «вода» (flavor).
 * Пропуск flavor помечается «[flavor cut]»; «…» ставится только если сама механика не влезла в 4*max (тогда ответ — unsure).
 */
export function cut(text, max = 1500) {
  if (!text || text.length <= max) return text ?? "";
  const lines = text.split("\n"), mech = lines.map((l) => MECH.test(l) || l === "---");
  let room = max - lines.reduce((n, l, i) => n + (mech[i] ? l.length + 1 : 0), 0);
  const out = [];
  let hard = 0;
  lines.forEach((l, i) => {
    if (mech[i]) {
      const cap = 4 * max - hard;
      if (l.length > cap) { out.push(sentenceCut(l, Math.max(cap, 0)) + " …"); hard = 4 * max; return; }
      hard += l.length + 1; out.push(l); return;
    }
    if (room >= l.length) { out.push(l); room -= l.length + 1; return; }
    if (room > 80) { out.push(sentenceCut(l, room) + " [flavor cut]"); room = 0; }
    else if (!out.at(-1)?.endsWith("[flavor cut]")) out.push("[flavor cut]");
  });
  return out.join("\n");
}

/** Файл черновиков: один предмет на строку (читаемые диффы). */
export const serializeDrafts = (meta, items) => `{"meta":${JSON.stringify(meta)},\n"items":[\n${items.map((d) => JSON.stringify(d)).join(",\n")}\n]}\n`;
