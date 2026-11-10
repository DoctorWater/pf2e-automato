// Анимации Атаки исподтишка и камней вечных при переводе: pf2e-jb2a-macros узнаёт их по английскому тексту
// («Sneak Attack» во flavor, «Aeon Stone» в имени), и с переводом pf2ru они молчат. Здесь распознавание от языка
// не зависит: кубики урона в броске и slug предмета. Нужны Sequencer и база JB2A; выключаются вместе с mode.macro.
// Если jb2a-macros включён и его условие сработало (непереведённый предмет), уступаем ему: двойной анимации нет.
//  - Атака исподтишка: разовый эффект, запускает автор сообщения (у ГМа — лидер вкладок), Sequencer рассылает всем.
//  - Камень вечных: каждый клиент сам сверяет состояние по item.isInvested (надет, не в рюкзаке) и играет у себя
//    (.locally()): без постоянных эффектов во флагах токена/прототипа, повторная сверка ничего не дублирует.
import { MOD } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { isLeader } from "../leader.mjs";

const SNEAK_SLUG = "sneak-attack", SNEAK_FILE = "jb2a.sneak_attack.dark_red";
const AEON_PREFIX = "aeon-stone-";
const JB2A_MACROS = "pf2e-jb2a-macros";

// Камни вечных: файл JB2A и цветовой фильтр по slug (таблица из макроса «Aeon Stone» pf2e-jb2a-macros; часть slug —
// легаси до ремастера, у старых предметов мира они остаются).
const AEON = {
  "clear-spindle": { file: "jb2a.ioun_stones.01.white.regeneration" },
  "dull-grey": { colors: { brightness: 0.9, saturate: -1 } },
  "agate-ellipsoid": { file: "jb2a.ioun_stones.02.purple.absorption", colors: { hue: 200 } },
  "azure-briolette": { file: "jb2a.ioun_stones.02.purple.absorption", colors: { hue: 670 } },
  "black-pearl": { file: "jb2a.ioun_stones.01.blue.insight", colors: { brightness: 0.2 } },
  "orange-prism": { file: "jb2a.ioun_stones.02.pink.fortitude", colors: { hue: 95 } },
  "gold-nodule": { file: "jb2a.ioun_stones.01.blue.awareness", colors: { hue: 525 } },
  "clear-quartz-octagon": { file: "jb2a.ioun_stones.01.pink.protection", colors: { brightness: 1, saturate: -1 } },
  "pearlescent-pyramid": { file: "jb2a.ioun_stones.02.pink.fortitude", colors: { brightness: 1, saturate: -1 } },
  "dusty-rose-prism": { file: "jb2a.ioun_stones.01.pink.fortitude", colors: { saturate: -0.2 } },
  "lavender-and-green-ellipsoid": { file: "jb2a.ioun_stones.02.purple.absorption", colors: { hue: 200 } },
  "pale-orange-rhomboid": { file: "jb2a.ioun_stones.01.blue.strength", colors: { saturate: -0.2, hue: 200 } },
  "pink-rhomboid": { file: "jb2a.ioun_stones.01.blue.strength", colors: { hue: 490 } },
  "tourmaline-sphere": { file: "jb2a.ioun_stones.02.red.intellect", colors: { brightness: 1.6, hue: -60 } },
  "western-star": { file: "jb2a.twinkling_stars.points04.orange", scale: 0.6 },
  "pale-lavender-ellipsoid": { file: "jb2a.ioun_stones.01.purple.absorption", colors: { brightness: 1.3 } },
  "pearly-white-spindle": { file: "jb2a.ioun_stones.02.white.sustenance" }
};

/**
 * Чистая: в броске урона сработали кубики Атаки исподтишка (rolls[0].options.damage.modifiers).
 * slug кубиков pf2e строит из подписи, а подпись — имя предмета: без моста pf2ru это «атака-исподтишка». Поэтому
 * кубики узнаются и по подписи, равной имени предмета Атаки исподтишка у самого актёра (names).
 */
export function hasSneakDice(rollOptions, names = []) {
  return (rollOptions?.damage?.modifiers ?? []).some((m) => (m?.slug === SNEAK_SLUG || names.includes(m?.label)) && m.enabled !== false && !m.ignored);
}

/** Чистая: вид камня вечных по slug -> {file, colors, scale}; не камень -> null. Неизвестный камень — обычный ioun stone. */
export function aeonLook(slug) {
  if (typeof slug !== "string" || !slug.startsWith(AEON_PREFIX)) return null;
  const look = AEON[slug.slice(AEON_PREFIX.length)] ?? {};
  return { file: look.file ?? "jb2a.ioun_stones.01", colors: look.colors ?? {}, scale: look.scale ?? 0.15 };
}

const on = () => modeOf("macro") !== "off";
const has = (file) => !!globalThis.Sequencer && !!game.modules.get("sequencer")?.active && !!Sequencer.Database?.entryExists?.(file);
const jb2aMacros = () => !!game.modules.get(JB2A_MACROS)?.active;

async function onSneak(message) {
  if (!on() || message.author?.id !== game.user.id || (game.user.isGM && !isLeader())) return;
  if (message.flags?.pf2e?.context?.type !== "damage-roll" || !has(SNEAK_FILE)) return;
  const names = (message.actor?.items ?? []).filter((i) => i.system?.slug === SNEAK_SLUG).map((i) => i.name);
  if (!hasSneakDice(message.rolls?.[0]?.options, names)) return;
  if (jb2aMacros() && /Sneak Attack/.test(message.flavor ?? "")) return;   // jb2a-macros сыграет сам
  const target = fromUuidSync(message.flags.pf2e.context.target?.token ?? "")?.object ?? null;
  const at = target ?? message.token?.object;
  if (!at) return;
  new Sequence({ moduleName: MOD, softFail: true }).effect().file(SNEAK_FILE).atLocation(at).scaleToObject(1.4).fadeIn(150).fadeOut(400).play();
}

const stoneName = (token, item) => `${MOD}-aeon-${token.id}-${item.id}`;

function playStone(token, item, look, name) {
  new Sequence({ moduleName: MOD, softFail: true })
    .effect().file(look.file).attachTo(token, { followRotation: false }).scale(look.scale)
    .spriteOffset({ y: 0.5 }, { gridUnits: true }).filter("ColorMatrix", look.colors).zeroSpriteRotation()
    .animateProperty("sprite", "position.y", { from: 0, to: 0.5, duration: 3000, gridUnits: true })
    .animateProperty("sprite", "position.y", { from: 0.5, to: 0, duration: 3000, gridUnits: true, fromEnd: true })
    .loopProperty("spriteContainer", "rotation", { from: 0, to: 360, duration: 6000 })
    .loopProperty("sprite", "rotation", { values: [0, -30, 0, 30], duration: 1500, pingPong: true })
    .scaleIn(0, 800).scaleOut(0, 800)
    .tieToDocuments(item).persist().locally().name(name)
    .play();
}

/** Камни вечных токена: настроенному — эффект, ненастроенному — нет. Идемпотентно. */
function syncToken(token) {
  if (!token?.actor || !on() || !has("jb2a.ioun_stones")) return;
  for (const item of token.actor.items) {
    const look = aeonLook(item.system?.slug);
    if (!look) continue;
    const name = stoneName(token, item), shown = Sequencer.EffectManager.getEffects({ name, object: token }).length > 0;
    const want = !!item.isInvested && has(look.file) && !(jb2aMacros() && item.name.includes("Aeon Stone"));   // jb2a-macros сыграет сам
    if (want && !shown) playStone(token, item, look, name);
    else if (!want && shown) Sequencer.EffectManager.endEffects({ name, object: token });
  }
}

const syncActor = (actor) => { for (const token of actor?.getActiveTokens?.() ?? []) syncToken(token); };
const isStone = (item) => !!aeonLook(item?.system?.slug);

export function init() {
  if (!globalThis.Hooks) return;
  const safe = (id, fn) => (...a) => { try { fn(...a); } catch (e) { console.error(`${MOD} | animation ${id}`, e); } };
  Hooks.on("createChatMessage", (m) => { onSneak(m).catch((e) => console.error(`${MOD} | animation sneak attack`, e)); });
  Hooks.on("drawToken", safe("aeon draw", (token) => syncToken(token)));   // сцена загружена, токен создан/перерисован
  for (const hook of ["createItem", "updateItem"]) Hooks.on(hook, safe("aeon item", (item) => { if (isStone(item)) syncActor(item.actor); }));
  Hooks.on("deleteItem", safe("aeon delete", (item) => {
    if (!isStone(item) || !globalThis.Sequencer) return;
    for (const token of item.actor?.getActiveTokens?.() ?? []) Sequencer.EffectManager.endEffects({ name: stoneName(token, item), object: token });
  }));
}
