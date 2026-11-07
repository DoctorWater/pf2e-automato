# Шаблон постановки задачи Джуну

Бриф агенту `djun` для механического заполнения правил. Поля в `<…>` — под конкретную волну.

Модель Джуна — **Sonnet** (Haiku запрещён). Джун **не читает репозиторий** и не пишет файлы: всё нужное — в этом промпте.

## Задача

Для каждого предмета из входа напиши **одно** правило автоматизации (или `null` — автоматизировать нечего).
Ответ — **только JSON-массив**, без прозы и без code fence, элементы в том же порядке, что вход.

Элемент (строго):
```json
{"uuid": "<uuid из шапки предмета>", "rule": <объект правила или null>, "unsure": false, "note": "<короткая причина, ≤12 слов>"}
```

Полный текст правил схемы и примеры — вставь сюда содержимое одного промпта:
- обычный проход — `tools/prompts/draft-rule.md`;
- ревью разметки — `tools/prompts/review-rule.md`.

## Критерий `unsure`

- `unsure: true` — механика в тексте есть, но схема её **не выражает** либо трактовка неоднозначна. В `note` назови ключ недостающего механизма из `rules/mechanisms.json` (`teleport`, `forced-action`, `healing-modifier`, `strike-gate`, `ammo-bomb`, …).
- `rule: null, unsure: false` — автоматизировать нечего: только урон/лечение, нарратив, пассивная прибавка, чистая информация.

## Стоп-условия / эскалация

- НЕ выдумывай slug состояний и UUID эффектов — бери только из `@UUID[…]/@Cond[…]` в тексте предмета.
- НЕ уверен → `unsure: true` (разберёт старшая модель). НЕ изобретай правило «на глаз».
- НЕ читай файлы, не пиши их; не обращайся к Foundry.
- Только JSON. Ошибки формы ловит `tools/check-answer.mjs` — не модель.

## Команды Руководителя (вне задачи, Джун их не выполняет)

- Вход: `node tools/haiku-input.mjs <batch> [--p N] [--size N]` → `tools/out/haiku/<batch>-NN.md`.
- Долг: `node tools/debt-pool.mjs [--batch all] [--prefix <p>]` → `tools/out/haiku/<p>-NN.md` + `tools/out/<p>-pool.json`.
- Разметка: `node tools/haiku-input.mjs all --review` → `tools/out/review/review-<batch>-NN.md`.
- Ответ Джун кладёт в `tools/out/answers/<волна>.json`.
- Проверка (без записи): `node tools/check-answer.mjs tools/out/answers/<волна>.json`.
- Приём: `node tools/validate.mjs tools/out/answers/<волна>.json <batch> [--input <вход.md>] [--final]`.