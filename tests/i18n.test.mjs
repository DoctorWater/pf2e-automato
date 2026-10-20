// Сверка i18n: наборы ключей ru/en одинаковы, все ключи из кода/шаблонов существуют. Запуск: node --test (или node tests/i18n.test.mjs для отчёта).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const mod = JSON.parse(readFileSync(root("module.json"), "utf8"));

function flatten(o, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object") flatten(v, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = v;
  }
  return out;
}
const load = (lang) => {
  const files = mod.languages.filter((l) => l.lang === lang).map((l) => l.path);
  const keys = {};
  for (const f of files) {
    assert.ok(existsSync(root(f)), `нет файла ${f}`);
    Object.assign(keys, flatten(JSON.parse(readFileSync(root(f), "utf8"))));
  }
  return { files, keys };
};
const ru = load("ru"), en = load("en");

// ключи, используемые кодом: L("x")/t("x") (префикс PF2E_AUTOMATO.), литералы PF2E_AUTOMATO.*, шаблоны hbs, настройки
function used() {
  const src = [];
  for (const d of ["scripts", "scripts/builtin", "templates"]) for (const f of readdirSync(root(d)).filter((f) => /.w+$/.test(f))) src.push([`${d}/${f}`, readFileSync(root(`${d}/${f}`), "utf8")]);
  const exact = new Map(), prefixes = new Map();
  const add = (k, where) => {
    const m = k.includes("${") ? prefixes : exact;
    const key = k.includes("${") ? k.slice(0, k.indexOf("${")) : k;
    if (!m.has(key)) m.set(key, where);
  };
  for (const [where, text] of src) {
    for (const m of text.matchAll(/(?<![\w$])(?:L|t)\(\s*(["'`])((?:(?!\1)[^\\])+?)\1/g)) {
      if (/^[a-zA-Z]+(\.[\w${}\[\]().]+)*$/.test(m[2]) && !/^(beforeend|afterbegin)$/.test(m[2])) add(`PF2E_AUTOMATO.${m[2]}`, where);
    }
    for (const m of text.matchAll(/PF2E_AUTOMATO\.[\w.${}\[\]]+/g)) add(m[0].replace(/\.$/, ""), where);
  }
  // настройки: name/hint для каждого reg("x") и MODES-ключа
  const settings = readFileSync(root("scripts/settings.mjs"), "utf8");
  const regs = [...settings.matchAll(/reg\("([\w.]+)"/g)].map((m) => m[1]);
  const modes = [...settings.matchAll(/"(mode\.\w+)":/g)].map((m) => m[1]);
  for (const k of [...regs, ...modes, "debug"]) for (const p of ["name", "hint"]) add(`PF2E_AUTOMATO.settings.${k}.${p}`, "settings.mjs");
  return { exact, prefixes };
}

test("i18n: ru и en — одинаковые наборы ключей", () => {
  const a = Object.keys(ru.keys), b = new Set(Object.keys(en.keys));
  assert.deepEqual(a.filter((k) => !b.has(k)), [], "есть в ru, нет в en");
  const aa = new Set(a);
  assert.deepEqual([...b].filter((k) => !aa.has(k)), [], "есть в en, нет в ru");
  assert.ok(a.length > 100, `ключей ${a.length}`);
});

test("i18n: module.json — одинаковые файлы для ru и en", () => {
  const base = (f) => f.split("/").pop();
  assert.deepEqual(ru.files.map(base), en.files.map(base));
  for (const lang of ["ru", "en"]) for (const f of readdirSync(root(`lang/${lang}`))) assert.ok(mod.languages.some((l) => l.path === `lang/${lang}/${f}`), `${lang}/${f} не подключён`);
});

test("i18n: все используемые ключи существуют (ru и en), значения не пустые", () => {
  const { exact, prefixes } = used();
  const miss = [];
  for (const [k, where] of exact) for (const [lang, d] of [["ru", ru.keys], ["en", en.keys]]) if (!(k in d) && !Object.keys(d).some((x) => x.startsWith(`${k}.`))) miss.push(`${lang}: ${k} (${where})`);
  for (const [p, where] of prefixes) for (const [lang, d] of [["ru", ru.keys], ["en", en.keys]]) if (!Object.keys(d).some((k) => k.startsWith(p))) miss.push(`${lang}: ${p}* (${where})`);
  assert.deepEqual(miss, []);
  for (const [lang, d] of [["ru", ru.keys], ["en", en.keys]]) assert.deepEqual(Object.entries(d).filter(([, v]) => !String(v).trim()).map(([k]) => `${lang}:${k}`), []);
  if (process.env.I18N_REPORT) console.log(`ru=${Object.keys(ru.keys).length} en=${Object.keys(en.keys).length} exact=${exact.size} prefixes=${prefixes.size}`);
});
