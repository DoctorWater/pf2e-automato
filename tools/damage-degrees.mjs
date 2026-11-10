// Урон по степеням у НЕ-basic спасбросков (challenge.damageByDegree): множители начального урона по тексту описания.
// parseDegrees(descEn) -> {criticalSuccess, success, failure, criticalFailure} | null (текст не однозначен — документ не размечаем).
// Запуск: node tools/damage-degrees.mjs [--write]  — без --write только отчёт; --write вставляет поле в записи каталогов (идемпотентно;
// после перегенерации rules/catalog.model.json (tools/drafts.mjs) вставки пропадают, но rules/damage-degrees.json (overlay, всё распознанное) их заменяет). Продолжительный урон — шаги byDegree правила, здесь не учитывается.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, isMain } from "./lib.mjs";

const HEAD = /^(Critical Success|Success|Failure|Critical Failure)\b[:.]?\s*(.*)$/;
const KEY = { "Critical Success": "criticalSuccess", Success: "success", Failure: "failure", "Critical Failure": "criticalFailure" };
const WORD = { half: 0.5, double: 2, twice: 2, full: 1, no: 0 };
const AMOUNT = /\b(half|double|twice|full|no)\b(?:\s+the)?(?:\s+(?:as much|initial and persistent|initial))?((?:\s+[a-z]+){0,2})\s+damage\b/gi;

const clean = (s) => s.replace(/@UUID\[[^\]]*\](?:\{[^}]*\})?/g, " ").replace(/\[\[[^\]]*\]\]/g, " ").replace(/@\w+\[[^\]]*\]/g, " ");

/** Множитель начального урона одной строки степени: число | "ref:<ключ>" (как у названной степени) | "none" (урона в строке нет) | null (неоднозначно). */
export function lineMult(text) {
  if ([...text.matchAll(/@Damage\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]/g)].some((m) => !/persistent/.test(m[0])) || /damaging effect|damage you take|equal to half/i.test(text)) return null;   // кости урона в строке, не множитель
  const t = clean(text);
  for (const m of t.matchAll(AMOUNT)) {
    if (/\bpersistent\b/i.test(m[2]) && !/initial/i.test(m[0])) continue;   // множитель относится к продолжительному урону — он идёт шагами правила
    if (/\b(?:as much|heal|heals)\b/i.test(m[0] + m[2])) return null;
    return WORD[m[1].toLowerCase()];
  }
  const ref = /^As (critical success|success|failure|critical failure)\b/i.exec(t.trim());
  if (ref) return `ref:${KEY[ref[1].replace(/\b\w/g, (c) => c.toUpperCase())]}`;
  if (/\bunaffected\b/i.test(t)) return 0;
  if (/\bdamage\b/i.test(t) && !/\bpersistent\b/i.test(t)) return null;   // «damage» без понятного множителя (число костей, «deals half damage with Strikes»)
  return "none";
}

/** Первый блок степеней описания (степень встречается один раз) -> множители; неоднозначное (нет явного провала/крит. провала, повтор блока) — null. */
export function parseDegrees(desc) {
  const raw = {};
  for (const ln of String(desc ?? "").split("\n")) {
    const m = HEAD.exec(ln.trim());
    if (!m) continue;
    const k = KEY[m[1]];
    if (k in raw) return null;
    raw[k] = lineMult(m[2]);
  }
  const out = {};
  for (const k of ["criticalSuccess", "success", "failure", "criticalFailure"]) {
    let v = raw[k];
    for (let i = 0; typeof v === "string" && v.startsWith("ref:") && i < 3; i++) v = raw[v.slice(4)];
    if (v === null) return null;
    if (v === undefined || v === "none" || (typeof v === "string")) { if (k === "failure" || k === "criticalFailure") return null; v = 0; }   // нет строки / урона в строке нет — урона нет; провал без явного множителя — не угадываем
    out[k] = v;
  }
  const dealt = Object.values(out).some((v) => v > 0) && Object.values(raw).some((v) => typeof v === "number");
  return dealt && out.failure > 0 ? out : null;
}

/** Вставить damageByDegree после "basic":false головы испытания в строке записи каталога; уже есть / нет такой головы — строка как была. */
export function patchLine(line, mults) {
  if (line.includes('"damageByDegree"') || !line.includes('"challenge":{')) return line;
  const at = line.indexOf('"basic":false', line.indexOf('"challenge":{'));
  if (at < 0) return line;
  const end = at + '"basic":false'.length;
  return `${line.slice(0, end)},"damageByDegree":${JSON.stringify(mults)}${line.slice(end)}`;
}

const SAVE_CHECK = /@Check\[(?:fortitude|reflex|will)(?![^\]]*basic)/i;
const lineOf = (txt, uuid) => txt.split(/\r?\n/).find((l) => l.trim().startsWith(`"${uuid}":`));

if (isMain(import.meta.url)) {
  const write = process.argv.includes("--write");
  const items = JSON.parse(readFileSync(join(ROOT, "tools/out/items.json"), "utf8")).items;
  const files = ["catalog.model", "catalog.rusthenge", "catalog"].map((n) => join(ROOT, "rules", `${n}.json`));
  const texts = files.map((f) => { try { return readFileSync(f, "utf8"); } catch { return null; } });
  const stat = { parsed: 0, catalog: 0, overlay: 0 };
  const patches = files.map(() => new Map()), overlay = {};   // patches: файл -> uuid -> множители
  for (const it of items) {
    const mults = parseDegrees(it.descEn);
    if (!mults || it.defense?.basic) continue;
    // не-basic испытание: спасбросок заклинания либо @Check спасбросок без basic в описании не-заклинания
    const nonBasic = it.defense?.save ? it.defense.basic === false : (it.type !== "spell" && SAVE_CHECK.test(it.descEn));
    stat.parsed++;
    let placed = false;
    texts.forEach((txt, i) => {
      const line = txt && lineOf(txt, it.uuid);
      if (line && /"challenge":{[^]*?"basic":false/.test(line)) { placed = true; patches[i].set(it.uuid, mults); }
    });
    if (placed) stat.catalog++;
    else if (nonBasic) stat.overlay++;   // правило выводится из разметки либо лежит в чужом каталоге (pa, campaign): поля нет
    if (placed || nonBasic) overlay[it.uuid] = mults;   // overlay — всё распознанное: вставки в каталоги теряются при перегенерации catalog.model (tools/drafts.mjs), overlay — нет; поле правила главнее
  }
  console.log(JSON.stringify(stat));
  if (write) {
    patches.forEach((m, i) => {
      if (!m.size) return;
      const fresh = readFileSync(files[i], "utf8");   // читаем заново перед записью: файлы правят и соседи
      const out = fresh.split("\n").map((l) => { const u = [...m.keys()].find((k) => l.trim().startsWith(`"${k}":`)); return u ? patchLine(l, m.get(u)) : l; }).join("\n");
      if (out !== fresh) writeFileSync(files[i], out);
      console.log(`${files[i]}: ${m.size} записей`);
    });
    const rows = Object.keys(overlay).sort().map((u) => `${JSON.stringify(u)}:${JSON.stringify(overlay[u])}`);
    writeFileSync(join(ROOT, "rules/damage-degrees.json"), `{\n${rows.join(",\n")}\n}\n`);
  }
}
