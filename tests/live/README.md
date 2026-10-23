# Живые сценарии и инвентаризатор (вкладка ведущего)

Файлы в `tests/live/` — выражения `async () => {...}` для консоли/`evaluate_script` ведущего. Из node не запускаются (`node --check` — только синтаксис, см. ниже).

## Требования
- Вкладка Gamemaster, она же лидер вкладок ГМа и активный ГМ (иначе обработчики модуля не сработают). Вторую вкладку ГМа закрыть или держать на `about:blank`.
- Игроки могут быть в сети, но лучше нет: окна и шёпоты уходят и им, а чат-сообщения тестов удаляются.
- Модуль `pf2e-automato` активен, pf2e 8.6.x, Foundry v14. Сайдбар чата виден (кнопки в шёпотах ищутся в DOM `#chat`; сценарии сами переключают вкладку).
- Токен-действия HUD (`tah-*`) идут только при активном `token-action-hud-core`, иначе `SKIP`.
- Тесты не пишут в мировые данные кроме временных `AF тест: …` (актёры, сцены, бои, сообщения). Настройки пользователя (`showCheckDialogs`, `showDamageDialogs`) и `useToolbeltTargetHelper` на время прогона меняются и возвращаются в конце. Просматриваемые сцена и бой восстанавливаются.

## Как запустить
Через chrome-devtools: прочитать файл и передать его содержимое как `function` в `evaluate_script` (оно уже `async () => {...}`).
Либо макрос-скрипт мира: `const f = <вставить содержимое файла>; return f();`.

Инвентаризатор мира (ничего не пишет, скачивает `inventory-world.json`):
```
tests/live/inventory.js
window.__afInv = { save: true, full: false }   // необязательно: до запуска. full — вернуть весь JSON; types — свой список типов
```
Статусы предмета (как `tools/triage.mjs`): `pf2e` (только `selfEffect` у action/feat или Aura RE с непустыми `effects`) > `automations` (покрывает pf2e-automations) > `builtin` (обработчик из `scripts/builtin/`) > `module-high` (правило из флага/каталога или разметка с высокой уверенностью) > `markup-low` (выводится из разметки, уверенность ниже) > `manual` (активный предмет со следом в тексте, правила нет) > `none`. Все слои — в `layers`. Предметы без источника (NPC) дедуплицируются по type + slug + нормализованному тексту. Формат записи: `uuid` (`_stats.compendiumSource`, иначе `flags.core.sourceId`), `slug`, `type`, `name` (английское, из `flags.babele.originalName`), `nameRu`, `status`, `layers`, `pf2e`, `automations`, `module`, `builtin`, `actors`, `count`. Сводка: по статусам, по типам, по актёрам. Полный результат всегда в `window.__afInventory`.

Регрессионный набор:
```
tests/live/suite.js
window.__afSuite = { only: ["flanking", "range"], skip: [], cleanOnly: false }   // необязательно, до запуска
```
Результат: `{summary, table, rows}` (`ok / fail / skip`, строка на сценарий), то же в `console.table` и `window.__afSuiteResult`.

Сценарии (id): `power-volley`, `phantom-pain`, `tangle-vine`, `grapple-escape`, `flanking`, `surprise-attack`, `metamagic`, `range`, `range-reach`, `tentacles`, `reaction-hint`, `shield-block`, `frightened`, `sickened`, `tah-reload`, `tah-cover`.
Каждый создаёт свою сцену «AF тест: сцена <id>», актёров из компендиума (Варрис берётся копией из мира, если есть и у него есть Силовой залп), расставляет токены, действует и убирает всё за собой.

## Если упало посередине
Аварийная чистка (удаляет всё с префиксом `AF тест`: бои, сцены, актёров, сообщения; возвращает число оставшегося):
```
window.__afSuite = { cleanOnly: true }  // и запустить suite.js
```
Затем вручную: вернуть просматриваемый бой (`ui.combat.initialize({combat})`), снять цели (`game.user.targets.forEach(t => t.setTarget(false))`), проверить `game.user.flags.pf2e.settings.showCheckDialogs` (нужно `true`, если было так) и настройку модуля `useToolbeltTargetHelper`.

## Хрупкие места
- d20 фиксируется подменой `CONFIG.Dice.randomUniform`; если Foundry поменяет формулу, сценарии с фиксацией помечаются `SKIP` (проверка `1d20` после подмены).
- Окна `.paf-dialog` без ответа сценария закрываются (отмена); legacy-окно урона и ChoiceSet pf2e обрабатываются по имени класса/заголовка.
- `power-volley` отвечает в окна по `[data-action='2']`, `[name=t0]`, `[data-action=ok]`; `tah-*` — по `[data-paf-reload]` и `button[value^=pafCover]`; `metamagic` читает конус из текста кнопки `[data-action=spell-template]`.
- `frightened` ломается, если активен Workbench/pf2e-automations с уменьшением испуга (модуль уступает им).
- Сценарии зависят от слагов пака: `force-barrage`, `phantom-pain`, `tangle-vine`, `runic-weapon`, `burning-hands`, `shield`, `tentacular-limbs`, `widen-spell`, `reach-spell`, `nimble-dodge`, `surprise-attack`, `crossbow`, `crossbow-bolts`.
- Таймаут сценария 150 с.
