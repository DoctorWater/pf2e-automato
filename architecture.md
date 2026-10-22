# pf2e-automato — итоговая схема (синтез прототипов)

Основа: аналитика Opus + Fable по `test-results.md`, сверено Руководителем вживую. Бриф — `brief.md`.

## Что берём / отбрасываем
- **Берём из proto-3:** свой тип RegionBehavior `pf2e-automato.zone`; состояние в документах (флаги `meta` на созданных
  состояниях/эффектах: источник, кто, откуда, до когда); блок в чате рендерится из флагов сообщения в `renderChatMessageHTML`;
  режимы по видам автоматизации.
- **Берём из proto-1:** конвейер `save → byDegree → apply`; вывод правил из разметки (`@Check`, `@UUID` на эффекты/состояния,
  `@Template`, traits; `inflicts:` — только подсказка); дедуп по `_stats.compendiumSource`.
- **Берём из proto-2:** определение целей в области через `token.testInsideRegion(region)`; страховочная очистка в `deleteRegion`.
- **Отбрасываем:** собственные Rule Elements (нет события «использован», живут только на предметах актёра, инжект невидим редактору),
  обёртку `RegionDocument#_handleEvent` (@internal), свипы через `sleep`, пересоздание удалённых регионов.
  **lib-wrapper не нужен** — зависимость убрать; остаётся socketlib.

## Факты API (проверены вживую / по исходникам)
- `getOriginData()` = `{uuid, type, rollOptions}` без `slug`. Регион от inline `@Template` (`InlineRollLinks`, pf2e.mjs ~28790) кладёт
  именно это; регион от `placeRegionFromItem` (pf2e.mjs ~3379, кнопка области заклинания) кладёт ещё `name/slug/traits`.
  → slug резолвить каскадом: `origin.slug` → `fromUuid(origin.uuid).system.slug` → rollOption `origin:item:slug:*` →
  `flags.babele.originalName` (sluggify).
- Для токенов, уже стоящих в регионе, ядро само шлёт `tokenEnter`, если поведение **есть в регионе при создании**
  (`_onCreateDescendantDocuments`, `#updateTokens`). → поведение вкладывать в **`preCreateRegion`** (`updateSource({behaviors:[…]})`)
  на клиенте создающего. Страховка — публичный `scene.updateTokenRegions()`, не таймеры.
- `NumberField({min:0})` молча зажимает отрицательный `worldTime` (в мире он отрицательный, Simple Calendar) → `expiresAt`
  делать `nullable` без `min`, проверка `worldTime >= expiresAt`; плюс счётчик раундов в бою (`pf2e.startTurn`).
- pf2e-toolbelt Template Helper пропускает регион при `flags["pf2e-toolbelt"].targetHelper.skip = true` (код `#l`).
- Расходник исчезает сразу после использования → правило, DC и цели **снимком** класть во флаг сообщения в момент создания.
- Несвязанные токены (NPC из бестиария, `actorLink:false`): состояния живут на `token.actor`, не на мировом актёре.
- `canvas.tokens.setTargets(ids)` (нет `game.user.updateTokenTargets`); броски удара игнорируют `skipDialog` — пропуск диалога shift-событием.
- **«Бравая брага» и Frightful Presence уже автоматизирует pf2e-automations** (`game.settings.get("pf2e-automations","rulesV3")`,
  предикаты `consumable:bravos-brew-*`, `item:slug:frightful-presence`). Модуль обязан **уступать** (реестр «кто уже автоматизировал»).
- Ошибки `TokenMagic is not defined` — от анимаций AA, не от модуля.

## Хранение правил (порядок поиска)
1. флаг предмета `flags.pf2e-automato.rule` (вкладка «Автоматизация» в листе предмета; переезжает с предметом на актёра);
2. мировой каталог по slug (world setting; кнопка «Для всех с этим slug» во вкладке; для предметов заблокированных компендиумов);
3. встроенный `rules/catalog.json` по slug;
4. вывод из разметки.
Единая JSON-схема правила — общий контракт для всех частей.

## Распознавание
- `preCreateChatMessage` на клиенте автора: предмет ещё жив, `game.user.targets` локальны → снимок
  `flags.pf2e-automato.use = {slug, rule, dc, targets, originUuid}`. Пропуск: `context.type === "self-effect"`, предметы с
  `system.selfEffect` (делает система), slug'и, покрытые активным pf2e-automations (переключатель «уступать» на предмете).
- `createChatMessage` у активного ГМа исполняет снимок (испытания/эффекты без области).
- `preCreateRegion` (создающий клиент): если правило — зона, вложить поведение + toolbelt `skip`.
- `createRegion` (активный ГМ): по `flags.pf2e.messageId` найти снимок, сразу собрать цели `testInsideRegion` (до удаления региона)
  и записать во флаг сообщения.

## Решения пользователя (2026-10-20)
- **Спасброски:** за NPC бросает и применяет ГМ-клиент автоматически; PC бросает игрок кнопкой в блоке. Если включён Target Helper
  Toolbelt — используем его броски/результаты, свои не дублируем.
- **Реакции (Ловкое уклонение и т.п.):** подсказка постфактум шёпотом владельцу и ГМу с пересчётом («+2 к КБ превратит попадание в
  промах»), кнопка «Использовать» пересчитывает исход **этой** атаки и помечает реакцию потраченной; висящего бонуса нет.
- **Template Helper на зонах:** не показывать (флаг skip); на обычных областях — как раньше.
- **Режимы по умолчанию:** зоны и эффекты на себя/союзников — сразу; состояния врагам по итогам испытаний — кнопкой «Применить» для ГМа.
  Всё настраивается (сразу / кнопкой / выкл) по видам.
- **«Плохая видимость»** = состояние `concealed`; для pf2e-vision — публичные хуки `pf2e-automato.zoneEnter/zoneExit` (видимость не трогаем).
- **Пересечение с pf2e-automations:** уступать по умолчанию, переключатель на уровне предмета.
- **Время зон:** по worldTime + счётчик раундов в бою + кнопка «Закрыть зону».

## Структура
```
module.json         documentTypes.RegionBehavior.zone, socket:true, requires socketlib, languages ru/en
scripts/main.mjs    init/ready: регистрация типа, настройки, хуки, сокет
scripts/rules.mjs   схема правила, резолв (флаг→мир→каталог→разметка), slug-каскад, реестр «уже автоматизировано»
scripts/use.mjs     preCreateChatMessage / createChatMessage / preCreateRegion / createRegion
scripts/zone.mjs    RegionBehaviorType + истечение
scripts/saves.mjs   испытания (свои / через toolbelt), DC-каскад, byDegree
scripts/reactions.mjs триггеры реакций
scripts/apply.mjs   apply/undo через socketlib (идемпотентно по meta)
scripts/chat.mjs    рендер блока из флагов, кнопки
scripts/sheet.mjs   вкладка «Автоматизация» (ItemSheetPF2e — AppV1, хук renderItemSheetPF2e)
rules/catalog.json  lang/{ru,en}.json  styles/automato.css  templates/*.hbs
```
Порядок: сначала схема правила + rules.mjs + apply.mjs (контракт), затем параллельно A зоны, B испытания+чат, C реакции,
D вкладка, E дедуп/настройки/исправленный тестовый харнесс; в конце интеграция и i18n.

## Тестовый харнесс (исправить)
`C:/Users/USER/AppData/Local/Temp/claude/E--Foundry-VTT-v14-366/46b70f73-cd76-4b9a-a57a-6e1e8d6f2758/scratchpad/af-harness.js`:
читать состояния у `token.actor`; нажимать только кнопки модуля (`.pf2e-automato button`); создавать регионы обоими реальными
путями pf2e (inline @Template и placeRegionFromItem); персонажей игроков не использовать — только временные актёры.
