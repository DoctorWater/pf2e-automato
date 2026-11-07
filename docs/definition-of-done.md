# Definition of Done — пачка / волна

Пункты сверху вниз. «Готово» — все галочки. Приём ответов — самое хрупкое место (handoff «Важно»): идти строго по порядку.

## Подготовка (реже, чем волна)

- [ ] `node tools/run.mjs` — снимок `tools/out/{items,triage,refs,html}.json` актуален (или подтверждено, что менялся только код рантайма).

## Волна

- [ ] Вход сгенерирован (`haiku-input.mjs` / `debt-pool.mjs` / `--review`, команды в `docs/junior-task.md` §«Руководитель»).
- [ ] Джун вернул ответ в `tools/out/answers/<волна>.json`.
- [ ] `node tools/check-answer.mjs tools/out/answers/<волна>.json` — нет `error` (иначе разобраны все).

## Приём

- [ ] Выборка Критика прогнана, **seed зафиксирован в отчёте**; дефекты выборки отражены в промпте `draft-rule.md` и сторожах `check-answer.mjs` / `validate.mjs`.
- [ ] Приём: `node tools/validate.mjs tools/out/answers/<волна>.json <batch> [--input <вход.md>] [--final]`.
  - `--final` — только последняя ступень (Sonnet): `unsure` уходит в долг `needs-primitive` с правилом-догадкой.
  - `rules/drafts-accepted/<batch>.json` пишет сам `validate.mjs` через `serializeDrafts` — руками **НЕ** `JSON.stringify`.
- [ ] Очереди разобраны: `tools/out/validate/<batch>.retry.md` (повтор Джуну), `…/<batch>.sonnet.json` (на Sonnet).

## Каталог и покрытие

- [ ] `node tools/drafts.mjs` — пересбор `rules/drafts/*` и `rules/catalog.model.json`.
- [ ] `node tools/coverage.mjs` — раздел в `coverage.md` обновлён, цифры сверены с ожиданием.

## Закрытие

- [ ] Живой прогон — обязателен для нового примитива/ветки `onEvent`; для остального — по готовому сценарию `tests/live/`.
- [ ] Критик (Opus) по диффу — перед коммитом.
- [ ] Коммит — только по указанию пользователя; Conventional Commits, коротко.
- [ ] Итоговый `node tools/run.mjs` и обновление статуса в `ROADMAP.md` §5.

## Напоминания

- «Примеры промпта = документы пачки»: правку промпта сверяй с текстом документов — модель копирует их дефекты.
- `check-answer.mjs` не пишет состояние — можно гонять параллельно.
- `--final` не звать до выборки Критика.
- Волна одного батча не стирает входы других: так себя ведёт `haiku-input.mjs` после И1 (стирает только файлы этого прогона).