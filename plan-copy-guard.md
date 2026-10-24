# План: ограждение копий NPC по состояниям правила (copy-guard)

Проблема (`ROADMAP.md` §5, «Известная проблема для всех пачек»): копия способности NPC с `source`, но с другим текстом, получает правило источника. Evil Eye у Kepgeda: источник (заклинание `f45JpY7Ph2cAJGW2`) — Sickened, текст копии — frightened, правило вешает Sickened. Механизм общий, под все пачки. Код не пишется. Версия 2 — после Критика: ограждение **относительно правила**, без хранилища отпечатков (`fingerprints.json` и `tools/fingerprint.mjs` отменены).

## 1. Как копия получает правило сейчас

`resolveRule` (`scripts/rules.mjs:1466`): флаг -> world.bySource -> world.bySlug -> builtin.bySource -> builtin.bySlug -> builtin.byName -> разметка.
- По источнику (`sourceOf` = `_stats.compendiumSource ?? flags.core.sourceId ?? origin.sourceId`): uuid совпал -> правило, текст не смотрится. **Здесь дыра**, ограждений нет.
- По slug (`bySlugOf`, ключ `slug@type`, затем общий): ограждения есть (`isSelfEffectOnly`, `slugCollides`, `lacksOwnRoll`, «СЛ из текста без спасброска»), но не текстовые и только при `!sourceUuid`.
- `byName` — копии без slug и source, вне задачи.
- Сборка: `tools/pa-port.mjs` (`bySlug`: все предметы со slug — одна способность; `bySource[c.src]` — одно правило из копий). Каталоги: `catalog.json`, `catalog.pa.json`, `catalog.model.json`, `catalog.campaign.json`, `catalog.onhit.json`.
- Обходы `resolveRule`: `scripts/reactions.mjs:102` (`ruleOfItem` через `onAttackedIndex`, который сливает мировой и встроенный каталоги); без предмета — `scripts/use.mjs:151` и `:329` (`resolveRule({origin})`), `scripts/actions.mjs:46` (`ruleFor`).

## 2. Механизм

**Состояния правила.** Обход правила (`onUse`, `onEvent`, `onAttacked`, `cast`, шаги всех степеней) собирает slug из каждого `condition.slug`; карта «подразумевает» (`IMPL`): grabbed/restrained -> off-guard, immobilized; paralyzed, prone, blinded -> off-guard; unconscious -> off-guard, blinded; dying -> unconscious… Состояние текста покрывает всё, что оно подразумевает (Tongue Grab: «grabbed» покрывает off-guard правила). Алиасы старых имён до сравнения: flat-footed -> off-guard.
**Состояния текста.** Слово-состояние из описания (в т.ч. в строках степеней, рядом с `@Check`), `@UUID` на conditionitems и `inflicts:` в options `@Check`; плюс метка ссылки на заклинание/действие по основе (`{Slow}` покрывает slowed: Control Water, 69 экз., иначе ложное срабатывание).
**Расхождение:**
- «другое состояние» — в тексте есть состояние, которого нет ни в правиле, ни в подразумеваемом им (Evil Eye: sickened в правиле, frightened в тексте) -> отключаем всегда;
- «потеря состояния» — состояние правила отсутствует в тексте (с учётом `IMPL`) -> тоже отключаем (решение пользователя).
**Не расхождение никогда:** потеря ссылки на эффект (Haste 108 экз., Read Aura 164, Stoneskin — старый текст без ссылки на эффект, правило корректно). Это поправка к ответу пользователя на «копия потеряла токен»: его решение относится к состояниям; на эффекты не распространяем, иначе отключим сотни верных правил. Не сравниваем: ссылки на чужие действия/заклинания, эффекты, спасброски и СЛ (голову испытания берёт `withMarkupHead`), числа, длительности, прозу.
**При расхождении:** builtin-правило пропускается, берётся `derive()` -> `found(d.rule,"markup", low)` + `diverged:{kind:"other"|"lost", states}`; исполнение только кнопкой ГМа. Нет `derive()` -> `null`, `diverged` остаётся для бейджа/Мастерской («текст копии отличается от правила каталога»). Решение пользователя.
**Где:** одна функция `guardCopy(rule, item)` в `scripts/rules.mjs` (тот же код читает отчёт и тесты, не копии). Огораживаем только builtin-правила (`bySrc`/`bySlug`) и только предметы на актёрах `npc`/`hazard`. Не огораживаем: флаг на предмете, мировой каталог ГМа, предметы персонажей и компендия, пути без предмета (`use.mjs:151`/`:329`, `actions.mjs:46`) — fail-open явно и с тестом.
**`reactions.mjs`:** `ruleOfItem` переводим на `resolveRule(item)?.rule` с кэшем; путь один, второй каталожный поиск убирается (`onAttackedIndex` остаётся только если нужен для выборки предметов актёра).
**`@Localize`:** в рантайме не раскрыт (Grab, Knockdown, Attack of Opportunity). Раскрывать через английский (`game.i18n._fallback`); если не вышло — при `@Localize` не огораживать.
**ru (pf2ru/babele).** Слов-состояний на английском в переводе нет. Оригинал брать из `flags.babele.originalPayload.description` [J — проверить живьём на встроенном предмете NPC в мире, а не на компендии: ключ и наличие]. Есть оригинал — сравниваем его; нет оригинала и текст кириллический -> не огораживать (fail-open). Сравнение по `@UUID` conditionitems для ru допустимо как дополнительное, но без оригинала не расхождение.
**Кэш:** по `uuid` + `_stats.modifiedTime` + `rev.n`, как `ruleCache` в `events.mjs:135`; без WeakMap. Предметы без состояний в правиле не считаются вообще.

## 3. Замер (прототип в scratchpad `crit3.mjs`, `tools/out/items.json`, `html.json`; экземпляры = Σ `dupCount`)

Баг прошлой версии: `"\b"` в строке был backspace — цифры §2 v1 неверны и сняты. Скрипт Критика (без `IMPL`) даёт те же порядки.
- Копии NPC с правилом каталога (source или slug): 1 132 уник. (13 068 экз.). У 325 правило несёт состояние.
- **Без карты `IMPL`: 47 срабатываний (64 экз.), из них 31 «другое состояние»** — почти всё Tongue Grab/Grab (ложные).
- **С картой `IMPL` и основами меток ссылок: 19 срабатываний (30 экз.): 3 «другое состояние» (9 экз.) + 16 «потеря» (21 экз.).**
- «Другое состояние»: Evil Eye (Kepgeda, 7 экз.), Dirty Trick (Bandit Disciple 1-2, 3-4; в тексте blinded).
- «Потеря»: Grab (11 копий BB: в тексте только Grabbed, правило ждёт grabbed/restrained), Touch of Obedience (5), Disarm/Sly Disarm (off-guard), Shove у ловушки Death Drop (чужой slug — отключение верно), Debilitating Strike, Dirty Trick (Hallod).
- Фикстуры: **не отключаются** — Shield (Mother Venom), Haste, Read Aura, Nimble Dodge, Tongue Grab, Stench (0 срабатываний); **отключается** — Evil Eye Kepgeda.
- Итоговые числа считает `guardCopy` из `rules.mjs` (см. §4), прототип — только оценка.

## 4. Проверка до релиза

`node tools/copy-guard-report.mjs` (импортирует `guardCopy` из `scripts/rules.mjs`): по всем встроенным копиям с правилом каталога — список отключаемых с причиной (`other`/`lost`, состояния), сортировка по весу экземпляров; ожидание — порядок 20, а не сотни.
1. Инвариант: копия с тем же `normText`, что у источника, не отключается, кроме случая «правило несёт состояние, которого нет в тексте источника» (такие правила в каталоге — баг каталога; список отдельно).
2. Выборка проверки — **по весу экземпляров** (по возрастанию «веса» не брать мелочь: топ по `dupCount`, затем случайные до 50 по правилу §10 `ROADMAP.md`); ложные срабатывания ≤ 5%, исправляются картой `IMPL`, а не исключениями.
3. Те же копии из ru-пакета: расхождение en против ru без оригинала не должно давать срабатываний (fail-open).
4. Гейт в `tools/validate.mjs`: фикстуры §3 не отключены, Kepgeda отключена.

## 5. Тесты

Юнит `tests/copy-guard.test.mjs` (по образцу `tests/core.test.mjs`): состояния правила по всем веткам обхода; `IMPL` и алиас flat-footed; «другое» и «потеря» отключают; потеря ссылки на эффект (Haste, Read Aura, Stoneskin) не отключает; метка `{Slow}` покрывает slowed; `@Localize` без раскрытия не огораживает; предмет не на npc/hazard, флаг, мировой каталог — не огораживаются; `resolveRule({origin})` и `ruleFor` без предмета — fail-open; нет оригинала + кириллица — fail-open; кэш сбрасывается по `modifiedTime` и `rev.n`; `reactions.mjs` даёт то же решение, что `resolveRule`; Evil Eye Kepgeda -> `source:"markup"`, low, `diverged`.
Живой `tests/live/copy-guard.js` (в `suite.js`, строго по одному, вкладка ГМа на `about:blank`): NPC с Evil Eye из Kepgeda и из Irrokcis; у первого нет автоприменения Sickened, в Мастерской пометка, кнопка ГМа выполняет `derive()` (frightened); у второго Sickened как раньше; плюс Tongue Grab/Haste не отключены. ru-мир: проверка [J] ключа `flags.babele.originalPayload`.

## Открытые вопросы

Развилок нет: «потеря состояния» отключает (решено), эффекты не сравниваются (поправка выше), при расхождении low-вывод (решено). Остаётся только [J]-проверка ключа babele в живом мире.

**[J] снят (2026-10-24, живая проба):** у встроенного предмета NPC мирового актёра («Копыто») `flags.babele.originalPayload = {name, description}` есть.
