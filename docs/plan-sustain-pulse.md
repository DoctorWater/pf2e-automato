# План P1: импульс при сотворении и первом Поддержании каждого раунда

Статус: **проект v2 по Критику, код не писан.** Опора: `docs/plan-animist.md` §5/§9, `docs/plan-sustain.md` §4, `docs/plan-familiar.md` §1, `scripts/sustain.mjs` (`count`, `attach`, `prune`, `onDeleteItem`, `check`), `scripts/events.mjs` (`onSustain`), `scripts/use.mjs` (`buildSnapshot`, `activationUse`, `onCreateMessage` 207-216, `execUse` 346-374, `runRegion`, `stepTargets` 276), `scripts/apply.mjs` (`applyOps`, `hasEffect`). pf2e 8.6.1, снимок `tools/out/items.json`.

## 1. Форма записи — выбор: `onUse.pulse`

**Выбрано: `onUse.pulse: "same" | "new"`** (повторить `challenge` и шаги `to:"target"` при Поддержании). `spell-sustain` у `side:"self"` отклонён:
- `onEvent` исполняется через `execEntry`: один `other` на запись, `hostChallenge` — карточка на цель, областей нет. Импульс по области = второй движок рядом с `onUse`.
- Шаги A23/A25 уже лежат в `onUse`; текст заклинаний говорит «тот же эффект» — копия шагов в `onEvent` расходилась бы с сотворением.

Значения: `same` — область/цели как при сотворении (Garden, Whirlpool, Shroud of Flame); `new` — область выбирают заново (Earth's Bile «choose an area within range»; также `same`, когда региона сотворения уже нет). `selected` — только `same`, отдельного прохода нет (штатный `execUse`).
Валидатор: `pulse` только при `targets` `area`/`selected` и при `challenge` либо шаге `to:"target"`; новый ключ ошибки `use.pulse` в `lang/*/rules.json`. **Поле в `sheet.mjs` и Мастерской в P1 не делаем** (валидатор + lang + каталог).

**Метод подсчёта (скрипт Критика `count.mjs`).** `items.json`, заклинания верхнего уровня (2017), `descEn` без тегов; триггер «first time (each) round you Sustain / each time you Sustain / when you Cast this Spell and … Sustain» — 97; из них с эффектом в 400 знаках после триггера (damage|save|heal|temporary Hit Points|spell attack|again) — 71. Берём **спасбросок + цель/область, без «на себя», без переноса/расширения области при Поддержании** — 28; плюс лечение (Garden of Healing, Hymn of Healing) — 30; минус Awaken Entropy (зона «растёт») — 29; после перепроверки по тексту ещё минус шесть (см. «Не берём») — **23, ниже порога ~30; решение пользователя — делать ниже порога**, механизм малый.

**Покрываемые (23):**
- область/эманация:
  - Whirlpool, Sanguine Mist, Unravel Existence, Tear the Veil
  - Earth's Bile, Shroud of Flame (emanation), Animated Assault, Circle of Weakness
  - Vacuum (emanation), Fiendish Rift
  - **Garden of Healing** (emanation, лечение)
- цель(и) `selected`:
  - Overload Connection, Steal Shadow, Mind Games, Bound in Death
  - Mirror Malefactors, Seize Identity, Unfathomable Song, Metal Reverberation
  - Interstellar Void, Tenebrous Freedom, Grasping Vine, **Hymn of Healing** (временные ОЗ).

**Не берём (при Поддержании область двигают/расширяют или нужен выбор):**
- Rose's Thorns, Wildfire (радиус растёт), Impaling Briars (выбор варианта), Lightning Storm (новый удар в новой точке), Grasping Earth (без спасброска на Поддержании), Ember Doppelgänger (перенос).
- Floating Flame, Whirlwind, Hungry Depths, Living Terrain, Shifting Sand, Flame Vortex, Rouse Skeletons, Phantom Orchestra, Freezing Rain, Invoke Spirits, Pyrotechnics, Ancestral Winds, Conjured Clockwork, Distortion Lens, Awaken Entropy, Puppet Strings, Poltergeist's Fury, Pernicious Poltergeist, Storm of Vengeance/Wrathful Storm (выбор варианта).
- Атаки заклинанием (Doom Mark, Spectral Blade, Crystallized Vapors и др.) — `onUse.check` автора, `use.both` с `challenge`: не P1.

**Сосуды анимиста вне P1 (с причиной):**
- A20 Crown of Prophets — выбор ветки при cast/Sustain (`choose options`) и Toxic Prophecy; база — `sustain:true` копией.
- A22 Trickster's Mirrors — счёт зеркал и шансы, не повтор эффекта: (г)/долг.
- A26 Darkened Forest Form — смена формы (выбор варианта) при Sustain.
- A27 — «на себя»/местность, не спасбросок по целям (хвост местности — долг).
- A28 Devouring Dark Form — Grapple штатным действием игрока, подсказка; эффект на себя.
- A29, A30 — «на себя»/выбор, долг (`plan-animist.md` §8).
- A31 Gift of the Anemos — выбор Step/Shove/Прыжок при Sustain.
P1 берут только **A23 и A25**; остальные ждут примитивов «выбор варианта при Sustain» и «перенос области».

## 2. Откуда берётся что при Поддержании

Якорь хранит `msg` (сообщение сотворения), `src` (uuid заклинания), `last`. Слушатель `pulse(anchor, actor, pos)` в `sustain.sustained` (рядом с `onSustain`):

1. **Правило**: `use.rule` из снимка `msg` (как `runRegion`); нет сообщения — `resolveRule` по `src`. Нет `onUse.pulse` — выход. Ветка `state.yielded` (pf2e-automations): **без импульса**.
2. **Круг**: `flags.pf2e.origin.castRank` из `msg`, иначе `spell.rank`. **В `flags.pf2e.origin` карточки импульса — только `castRank`** (больше ничего: иначе `useKindOf`/`eventOfMessage` сочтут её сотворением -> `spell-cast`, автоякорь фамильяра).
3. **СЛ**: `use.dc` снимка `msg`; нет — `spellDcOf(spell)` (`familiar.mjs`, запись колдовства самого заклинания).
4. **Roll options**: `flags.pf2e.origin.rollOptions` сотворения копируются в `rollOptions` снимка (поле `use.rollOptions`) + `sustain:pulse` (на cast её нет: шаги с `when:["sustain:pulse"]` различают импульс). Опции автора идут штатно (`applyOps` берёт их сам).
5. **Цели и область** — только через существующий `runRegion`, без собственного расчёта:
   - `same`: регион сотворения (`use.state.area.regionUuid`) жив -> `runRegion(castRegion, pulseMsg)`; эманация привязана к токену и движется сама, цели по `testInsideRegion` в момент импульса. `zone` из копии правила убирается (чужую зону не пересоздаём).
   - региона нет (burst снят/бой кончился) и `new`: карточка **ждёт шаблон**, как карточка сотворения — `@Template[burst|distance:N]` в `content` (как `effectText` в `cast.mjs`), игрок ставит из неё, регион получает `flags.pf2e.messageId`, далее штатный `runRegion`.
   - `selected`: `use.targets` снимка сотворения, штатный `execUse` (живые токены).
   - Нет токена автора на сцене — шёпот ГМу раз за сессию (`noTokenWarned`).

## 3. Карточка: новая на каждый импульс

**Новое сообщение на импульс.** Переиспользовать карточку сотворения нельзя: `state.challenge`, `state.area`, `state.done`, `meta.key = <id сообщения>:<цель>:<шаг>` одноразовые.

Построение (образец `activationUse`): снимок `buildSnapshot({kind:"use", resolved:{rule: урезанная копия}, dc, targets, rollOptions, actor, token, item})` + `state.pulse = {key, anchor}` + `state.sustainKey`. **Урезанная копия правила**: только `onUse.challenge` и шаги `to:"target"`; без `pulse`, `zone`, `macros`, шагов `self/party/allies`. `ChatMessage.create` -> `onCreateMessage` -> **`execUse` сама** (`use.mjs:207-216, 346-374`): `mode.effect=auto` — шаги по целям, `button` — кнопка «Применить», `mode.challenge=auto` — `saves.runChallenge`; `off`+`off` — карточки нет (как `onSustain`). Для области `execUse` цели не берёт — ждёт регион (`runRegion`, §2.5), как у сотворения.

**Якорь не создаётся при `state.pulse`** (карточка импульса сама якорей не ставит). Якорь заклинания — одно условие: `execUse` на карточке сотворения при `onUse.pulse` и `duration.sustained` -> `sustain.attach(author, null, {key: anchorKey(msg), msg, item, token, at: use.at, pulse:true})` (идемпотентно по ключу; Garden создаёт его и шагом `sustain:true` — тот же ключ). Флаг `pulse:true`: `offer` — полным шёпотом автору и ГМу, «пропущено» шлётся; **`prune` якорь с `pulse` не удаляет** (откат последней привязки не должен снимать якорь заклинания).

**Привязка (`sustain:true` на карточке импульса)**: `apply.mjs:601` берёт `meta.sustainOf = state.sustainKey ?? anchorKey(message.id)`, но **только если живой якорь с этим ключом есть** (`findAnchor`); после «Прекратить» не воскрешаем.

**Правило повтора эффектов на цели** (ключ `meta.key` на новой карточке новый):
- эффект из компендия — на импульсе пропуск по `hasEffect(actor, uuid, автор)` (метка Garden не дублируется);
- inline-эффект (`effect:{mods}`) — складывается: ключ новый, `hasEffect` по `compendiumSource` его не видит. Гасим в P1 просто: **шаг с inline-эффектом на импульсе не повторяется** (копия правила его отбрасывает). Состояния (`condition`) — обычный путь `applyCondition` (дедуп по слагу/значению pf2e).

**Правки чужих файлов:** только `apply.mjs:601` (привязка по `state.sustainKey`). `stepTargets` не трогаем: при регионе сцена берётся из него, без региона область не исполняется (ждёт шаблон), `challengeTargetsAll` тоже не меняем.

## 4. Дедуп

- **Раз в раунд**: `count()` -> `fresh` один раз на `(combat, round)`; слушатель только на `fresh`. Сотворение пишет `last` = раунд сотворения -> Sustain того же раунда `again`, импульса нет (cast и Sustain не удваиваются; тест).
- **Два клиента**: `guardActiveGM()`; второй рубеж — карточка с `state.pulse.key === "<anchorKey>:<combat>:<round>"` уже есть в `game.messages`. Очередь `pulse:<anchorKey>`, не `sustain:<key>` (слушатели `sustained` зовутся без ожидания).
- **Повтор кнопки / сообщения Sustain**: `again` + `sustainSeen`. **Переброс**: у Sustain броска нет; перебросы в карточке — штатный `saves.mjs`.
- **Вне боя** (`pos.round == null`): окно 6 с (`sustainSeen`-карта `onSustain` выносится в общий помощник), ключ `…:t<ts>`.
- **Cackle / лист pf2e**: Sustain с листа/SimpleAction ловит `onMessage` -> `count()` -> тот же слушатель; Cackle — карточка заклинания, `isSustainMessage` исключает её: только кнопка шёпота якоря (`audit-builds-l1.md` §2.1); при двух якорях на лист-Sustain — «выберите» (`sustain.pick`), импульса нет.
- **Кнопку «потерянный импульс» в P1 не делаем** (сбой создания карточки — лог в консоль; повтор — Sustain следующего раунда).

## 5. Конец

Конец — только якорь (`end`/`check`/«Прекратить») -> `onDeleteItem` -> `removeBound(actor, anchorKey)`: снимается всё с `meta.sustainOf === key`, включая привязанное с карточек импульсов. Не снимается: сами карточки и применённый урон/лечение, эффекты без `sustain:true`, регион сотворения (его закрывает `zone`), пост-эффект Garden (`onEvent effect-deleted`, не трогаем). Пропуск (`check`: `missedAt/missedBefore`) = конец: импульса нет, «пропущено» ГМу/владельцу.

## 6. Тесты

**Юнит (`tests/sustain-pulse.test.mjs`, `node --test`):**
1. Валидатор:
   - `pulse` при `area`+`challenge` — да
   - при `self`, без `challenge`/шагов `to:"target"`, `new`+`selected` — ошибка
   - `ev.familiar` на `spell-sustain` у `side:"self"` по-прежнему ошибка.
2. Урезанная копия правила: остаются `challenge` и `to:"target"`, нет `pulse/zone/macros`/self-шагов/inline-эффекта.
3. `pulseKey` + `sameTurn`: cast R1 и Sustain R1 — нет импульса; Sustain R2 — один; второй клик — нет.
4. Опции и круг:
   - `sustain:pulse` есть у импульса
   - `rollOptions` сотворения скопированы
   - в `flags.pf2e.origin` карточки только `castRank`
   - нет `spell-cast`-признаков.
5. Привязка:
   - живой якорь — `sustainOf` по `state.sustainKey`
   - якоря нет — привязка не создаётся
   - `prune` якоря с `pulse` не удаляет.
6. `state.yielded` — импульса нет; `state.pulse` — якорь не создаётся.
7. Регрессия: `sustain.test.mjs`, `sustain-rule.test.mjs`, `level1-catalog.test.mjs`; каталог A23/A25 с `pulse` проходит валидатор.

**Живой (`tests/live/level1-pulse.js`, образец `level1-sustain.js`, «AF тест»-актёры, вкладка ГМа):**
- **A23 Garden**: R1 cast (эманация 10 фт, `1d4`, метка, якорь); Sustain R1 — карточки нет; R2 Sustain — карточка, лечение внутри эманации; токен автора сдвинут — состав другой; повтор кнопки в R2 — второй карточки нет.
- **A25 Earth's Bile**: R1 cast (Reflex basic, огонь+дробящий, постоянный огонь, `ceil(rank/2)d4`); R2 Sustain — карточка ждёт шаблон -> спасброски и кнопки урона; без шаблона целей нет.
- **Пропуск**: конец хода R2 без Sustain -> якорь снят, привязанное снято, в R3 импульса нет.
- **Прекратить**: якорь удалён, карточки целы, привязка с поздней карточки не воскрешает якорь.
- **Два якоря** (A23+A25): Sustain с листа -> «выберите»; кнопки — по импульсу на якорь; конец одного не трогает другой.
- **Режимы**: `off/off` — карточки нет; `effect=button` — «Применить»; вне боя — два клика подряд = один импульс; вторая вкладка ГМа — одна карточка.

## 7. Риски и открытые вопросы

1. `@Template` из нашей карточки даёт регион с `flags.pf2e.messageId`? Проверить живьём (как добавка `cast.mjs`); иначе `new` — шаблон вручную.
2. Эманация сотворения «движется сама» — проверить, что регион жив между раундами и `testInsideRegion` работает без холста на клиенте ГМа.
3. «Each time you Sustain» в раунд сотворения -> `again`: расхождение принимаем.
4. Покрытие 23 — ниже порога ~30: решение пользователя — делать ниже порога; оправдано малостью механизма. `same` без живого региона ведёт себя как `new`.
5. Inline-эффекты на импульсе не повторяются (§3) — для заклинаний, где импульс должен продлить такой эффект, нужен отдельный шаг (долг).
6. Нагрузка чата: до 10 карточек на заклинание.
7. Три слоя схемы: валидатор, `lang`, каталог (+ `tools/pa-effects.json` для генерации); `sheet.mjs`/Мастерская — позже.

## Статус

2026-11-05: реализовано (`scripts/use.mjs` `pulseRule`/`onPulse`/`pulseAnchor`, `sustain.attach` с `pulse`/`create`, валидатор, lang). Критик по коду (P1 — потеря `pulse` при сохранении листа; P2 ×9) + перепроверка. Вживую: an-a23-pulse 10/10, an-a25-pulse 8/8 (регион из `@Template` карточки получает `flags.pf2e.messageId`; эманация живёт между раундами). Покрытие каталога — только A23/A25; остальные ~21 заклинание из списка — по мере записей.
