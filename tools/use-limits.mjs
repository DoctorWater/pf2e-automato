// Группа «требования к автору»: у действий нет данных о требованиях, они живут только в тексте «Requirements» (tools/out/items.json).
// Пишем rules/use-limits.json: {bySource: uuid -> {req}, bySlug: "slug@тип" -> {req}}; рантайм — rules.mjs (limitEntry) и builtin/impulse-gate.mjs (строка LIMITS «req»).
// Запись выпускается, только если разобраны ВСЕ клаузы текста: любое неизвестное условие — записи нет, предмет работает как раньше (ложный блок хуже пропуска).
// Почему оверлей, а не разбор в рантайме (в отличие от перезарядки): у перезарядки есть языконезависимый якорь — встроенный бросок «#Recharge»,
// у требований его нет, а русский текст pf2ru (описания Хватки и др. — @Localize) английской регулярке недоступен; uuid источника и slug от перевода не зависят.
// Клаузы: {k:"strike", name?, fx?} — последним действием был успешный Удар [с именем / с эффектом fx]; {k:"holds"} — держит существо; {k:"hand"} — свободная рука.
// «Любое из» — клаузы через «, or ». Запуск: node tools/use-limits.mjs
import { join } from "node:path";
import { ROOT, readOut, stripHtml, writeJson, isMain } from "./lib.mjs";
import { sluggify } from "../scripts/util.mjs";
import { reqSig } from "../scripts/builtin/limit-text.mjs";

// Подлежащее: «the monster», «your lash», «You», имя собственное («Sorvuth-ka's», «Nils Kelveken»). Союз/глагол — не подлежащее: «the assassin is wielding … and has a free hand» не разбирается.
const W = String.raw`(?!(?:and|or|is|are|has|have|must|with|wielding|holding|was|that|hit|hits|damaged|damages|does|do|doesn['’]t|don['’]t|not|never|cannot|can['’]t)(?![\p{L}\p{N}'’_-]))[\p{L}\p{N}'’_-]+`;
const SUBJ = String.raw`(?:you|(?:the |your )?${W}(?: ${W}){0,5}?)`;
// Уточнения, которых клаузы выразить не могут (размер, «with its jaws», «in its jaws», тип оружия, «living»), в разбор не входят: записи нет, а не запись мягче текста.
const STRIKE = new RegExp(String.raw`^${SUBJ} (?:last|previous|most recent) action(?: this turn)? (?:was|is) (?:(?:an? )?(?:successful|success with an?)|an?(?= (?:(?:melee|ranged) )?(?:[\w -]+? )?strike that hit)) (?:(melee|ranged) )?(?:([\w -]+?) )?strike(?: that lists ([\w -]+?) in its damage entry| that hit(?: an? (?:opponent|creature|enemy))?| (?:with|using) (?:its|his|her|their) ([\w'’ -]+?))?\.?$`, "iu");
const STRIKE_DMG = new RegExp(String.raw`^${SUBJ} (?:hit|damaged)(?: an? creature)? with an? (?:(melee|ranged) )?(?:([\w -]+?) )?strike (?:on|with|during) (?:its|his|her|their|your) (?:last|previous|most recent) action(?: this turn)?\.?$`, "iu");
const HOLDS = new RegExp(String.raw`^${SUBJ} (?:must )?(?:has|have) (?:an? )?creature grabbed(?: or restrained)?\.?$`, "iu");
const HAND = new RegExp(String.raw`^${SUBJ} (?:must )?(?:has|have) a free hand\.?$`, "iu");
const NAME_NOISE = /\b(?:a|an|the|or|and|weapon|with|against|another|any|unarmed|non)\b/i;   // «piercing or slashing weapon Strike» — не имя Удара

const plain = (s) => stripHtml(s ?? "").replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1").replace(/@\w+\[[^\]]*\](?:\{[^}]*\})?/g, "").replace(/\s+/g, " ").trim();

/** Чистая: одна клауза -> {k,...} | null. */
export function clauseOf(s) {
  const m = STRIKE.exec(s), d = m ? null : STRIKE_DMG.exec(s);   // «damaged/hit … with a jaws Strike on its last action» — Удар попал (hit), имя — jaws
  if (m || d) {
    const [, kind, name1, fx, name2] = m ?? [d[0], d[1], d[2]], name = name1 ?? name2;
    if (name && NAME_NOISE.test(name)) return null;
    return { k: "strike", ...(name && { name: sluggify(name) }), ...(fx && { fx: sluggify(fx) }), ...(kind && { melee: /^melee$/i.test(kind) }) };   // melee/ranged — тип Удара (item.isMelee)
  }
  if (HOLDS.test(s)) return { k: "holds" };
  if (HAND.test(s)) return { k: "hand" };
  return null;
}

/** Чистая: описание (markup) -> {any:[клаузы]} | null. Строка «Requirements»; хоть одна клауза не разобрана — null. */
export function reqOf(descEn) {
  // абзац Requirements бывает вторым-третьим («flavor --- Requirements … --- Effect»): ищем в первых трёх секциях, дальше — Special/варианты
  const text = stripHtml(descEn ?? "").replace(/<[^>]+>/g, "").split(/\n---\n/).slice(0, 3).join("\n");
  const line = /(?:^|\n)\s*Requirements?\s+([^\n]*)/i.exec(text) ?? /(?:^|\n)\s*Trigger\s+([^\n]*)/i.exec(text);   // Trigger — только если Requirements нет: строка Trigger бывает выше Requirements
  if (!line) return null;
  const parts = plain(line[1]).split(/,\s+or\s+/i);
  const any = parts.map(clauseOf);
  return any.every(Boolean) ? { any } : null;
}

/** Чистая: документы + html (tools/out/html.json по uuid) -> {bySource, bySlug, report}.
 *  bySlug: "slug@action" -> [{sig, req}] — только тип action; вариант (подпись reqSig) берётся, если ВСЕ документы с этим slug и этой подписью дают то же требование
 *  (одноимённые способности без абзаца «Requirements» имеют подпись null и вариант не подхватывают). У предметов бестиария uuid — только у представителя группы
 *  одинаковых текстов (extract.mjs: dupCount), поэтому массовые Хватка/Опрокидывание/Толчок/Рывок покрываются только bySlug. bySource — остальные разобранные документы. */
export function buildLimits(items, html = {}) {
  const docs = [], groups = new Map(), report = { parsed: 0, docs: 0, covered: 0, byKind: {} };
  for (const it of items) {
    if (!["action", "feat"].includes(it.type) || !it.actionType || it.actionType === "passive") continue;
    const req = reqOf(it.descEn), slug = it.slug || sluggify(it.name), key = `${slug}@${it.type}`;
    // подписи документа: по тексту; у предметов глоссария бестиария в мире описание — ссылка @Localize[PF2E.NPC.Abilities.Glossary.X] (в паке русского pf2ru так же) — вторая подпись «loc:…»
    const sigs = [reqSig(html[it.uuid]), /^@Localize/.test(it.descRu ?? "") ? reqSig(it.descRu) : null].filter((x) => x !== null);
    for (const sig of sigs) (groups.get(`${key}|${sig}`) ?? groups.set(`${key}|${sig}`, []).get(`${key}|${sig}`)).push({ it, req });
    if (!req) continue;
    docs.push({ it, req, key, sigs });
    report.parsed++; report.docs += it.dupCount || 1;
  }
  const bySlug = {}, bySource = {}, str = JSON.stringify;
  for (const d of docs) {
    const ok = d.it.type === "action" ? d.sigs.filter((sig) => groups.get(`${d.key}|${sig}`).every((x) => x.req && str(x.req) === str(d.req))) : [];
    for (const sig of ok) {
      const list = (bySlug[d.key] ??= []);
      if (!list.some((v) => v.sig === sig)) list.push({ sig, req: d.req });
    }
    if (d.it.uuid) bySource[d.it.uuid] = d.req;   // и при покрытии по slug: источник надёжнее подписи (описание без HTML подпись не даёт)
    else if (!ok.length) continue;
    const n = d.it.dupCount || 1;
    report.covered += n;
    for (const k of new Set(d.req.any.map((c) => c.k))) report.byKind[k] = (report.byKind[k] ?? 0) + n;   // документов, которые оверлей реально покрывает, по видам клауз
  }
  return { bySource, bySlug, report };
}

if (isMain(import.meta.url)) {
  const { report, ...out } = buildLimits(readOut("items.json").items, readOut("html.json"));
  writeJson(join(ROOT, "rules", "use-limits.json"), { v: 1, ...out }, 1);
  console.log(`use-limits: bySource ${Object.keys(out.bySource).length}, bySlug ${Object.keys(out.bySlug).length}; разобрано ${report.parsed} ун. / ${report.docs} док.; покрыто оверлеем ${report.covered} док.; по клаузам (док.)`, report.byKind);
}
