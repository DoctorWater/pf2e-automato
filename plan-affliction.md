# affliction: стадии недугов — яды, болезни, проклятия (план v2 после Критика, код не написан)

Решение: **pf2e стадий не ведёт — ведёт модуль.** Определение недуга лежит **в самом шаге** `affliction:{stage, def}` (работает в `byDegree`, `onUse.apply`, `afterUse`, карточках `hostRule` без проброса: `hostRule` копирует только `challenge`, `events.mjs:91`). Носитель — pf2e `effect`; стадия — только `system.badge.value`; эффекты стадии применяет хук `updateItem` на активном ГМе; часы — одно поле `nextAt` в мировом времени. Решения Руководителя: интервал раундов — по концу хода цели; живая проверка сначала на ядах; штрафы стадий — через `effect.mods`.

## 1. Что встречается (счёт по `tools/out/items.json` + `triage.json`, копии NPC схлопнуты)

Признак: `Stage 1`+`Stage 2` в `descEn` и (`Saving Throw`|`Maximum Duration`|`Onset`|трейт poison/disease/curse). Открыто (не pf2e/catalog/pa-port) **~560 уникальных**: пачка 8 — 135 ядов-consumable; пачка 9 — 375 NPC-способностей; пачка 1 — 41 (с меткой в `drafts-accepted` — 26: заклинания Purple Worm Sting, Goblin Pox, глоссарий семейств); `b06` 4, `b04` 3, прочее 4. Трейты: poison 381, disease 123, curse 41, virulent 30; `Onset` 110, `Maximum Duration` 398.
Структура: `Saving Throw @Check[fortitude|dc:22]` (у NPC `dc:` иногда пуст), `Onset 1 hour`, `Maximum Duration 6 rounds`, `Stage N <урон/состояния/текст> (<срок>)`; «as stage 2», «carrier with no ill effect», конечные «dies»/«dead». «Чистых» строк (только `@Damage` + `@UUID` состояния) 72% (1280/1780), документов целиком 54%; остальное — штрафы («–10-foot status penalty to Speeds» → `effect.mods`, если разбираются) и сюжетное (не автоматизируем, остаётся текстом стадии).

**Правила** (AoN, Player Core «Afflictions»: https://2e.aonprd.com/Rules.aspx?ID=361; сверено WebFetch):
- спасбросок в конце интервала стадии: успех −1, крит. успех −2, провал +1, крит. провал +2; провал за последней стадией — «повторяет эффекты высшей стадии» (урон снова);
- `Maximum Duration` вышел — недуг кончается; `Onset` — эффекты стадии 1 не действуют, пока не прошёл (стадия при этом уже записана: крит. провал на старте = стадия 2 после onset);
- повторное воздействие: болезнь и проклятие — **не действуют**; яд — новый провал +1 (крит. +2) без смены `maxDuration`, в том числе во время onset (onset не сбрасывается);
- virulent: два успеха подряд для −1, крит. успех лишь −1. Сброс счётчика успехов между ними страница не описывает — **толкование: любая степень, кроме успеха/крит. успеха, обнуляет `streak`; крит. успех сам по себе даёт −1 и `streak` не копит** (отметить в README);
- урон стадии — «сразу при достижении стадии»; продолжительного урона в разделе нет, но стадия может его называть («persistent bleed») → `applyPersistent`;
- «Conditions … last as long as you're at that stage»: правило о взаимодействии с тем же состоянием из других источников не дано — действуем как pf2e (ниже).

## 2. Что уже делает pf2e (`Data/systems/pf2e/pf2e.mjs`, 8.6.1)

Тип `affliction` есть в схеме и lang; `AfflictionPF2e` (`:48920`) — `stage`, `system.status.onset` (`:48941`), `stages[{conditions,damage,duration}]`, `increase/decrease`, `rollRecovery`, `handleStageChange`, `getLinkedItems` (`:49031`). **Конструктор безусловно бросает** «Affliction items are not available in production builds» (`:48922`); в паках 0 `effect`-недугов, яды — текстовые `consumable` (`ruleKeys: []`). `rollRecovery` не знает крит./virulent и не запускается на конце интервала. Вывод: вешать нечего — ведёт модуль; берём модель pf2e (бейдж-счётчик стадии, `grantedBy`, набор `zl` «не линкуем» `:48958`: frightened/sickened/drained/doomed/stunned/unconscious). Проверка при каждом обновлении pf2e: `new Item({type:"affliction"})` не бросает → носитель можно сменить, схема правила та же.

## 3. Форма в схеме (`plan.md` §1.1)

Шаг `{to:"target", affliction:{stage, def}}`; `stage` 1..N (по умолчанию 1), `def` — снимок определения (в носитель кладётся копией, источник может пропасть):
```json
{"to":"target","affliction":{"stage":2,"def":{"name":"Spider Venom","kind":"poison","save":{"statistic":"fortitude","dc":22},
 "maxDuration":{"value":6,"unit":"rounds"},"onset":null,"virulent":false,
 "stages":[{"duration":{"value":1,"unit":"rounds"},"damage":[{"formula":"1d10","damageType":"poison"}],"persistent":null,"conditions":[{"slug":"sickened","value":1}],"mods":null,"text":""}]}}}
```
- `kind` ∈ poison|disease|curse — нужен для повторного воздействия; единицы — `APPLY_UNITS` (`rules.mjs:20`), последняя стадия без `duration` — конечная. `stages[].mods` — как `effect.mods` (`normalizeMods`); `text` — непонятая часть для показа. В карточке `afterUse` и NPC-ядах «по попаданию» определение путешествует в шаге — `hostRule` не трогаем.
- Конвертер `tools/affliction.mjs` (образец `strike-gate.mjs`): разбирает блок «Saving Throw…Stage N» → `challenge.byDegree` (провал → `stage:1`, крит. провал → `stage:2`, одинаковый `def` в обоих шагах) + `unsure`/`text` на нераспознанном. `deriveFromMarkup`: детектор `afflictionStages(html)` → правило `low` «не вешается автоматически» (как `triggerSave`).
- `rules.mjs`: `vAffliction`, `affliction` в `STEP_KINDS` (не вместе с `repeat/escape`), только `to:"target"`; `tools/validate.mjs` (`stepsOf/semanticErrors`, ответ без недуга на тексте со `Stage N` — ошибка); `tools/prompts/draft-rule.md:63` — пример и запрет «простое испытание + condition».
- **Шаг 1 — рантайм и конвертер.** Мастерская (`sheet.mjs`, `workshop/`): стадии **только для чтения** (строка «Недуг: стадия N», сводка стадий); редактор — позже. `DENY` (`sheet.mjs:12`) не трогать.

## 4. Рантайм

- **Опознание:** недуг на актёре — эффект с `flags.<MOD>.meta.affliction.slug` = `slugOf(def.name)` / `sourceId` определения; **не** автор/шаг/токен (`sameCarrier`, `repeat.mjs:28`, не годится: другой NPC того же яда). Иммунитет цели к трейту (`immuneToTraits`) — до создания.
- **Создание:** шаг → `afflictionStart(actor, step, ctx)`: нет носителя → создать `effect` (по образцу `applyInlineEffect`/`effectSource`, свой документ, `system.rules` = `rulesOfMods(stage.mods)` текущей стадии; `inline` с конечным сроком не нужен — срок носителя `unlimited`), `system.badge = {type:"counter", value:stage}`, `meta.affliction = {def, dc, statistic, traits, streak:0, nextAt, endsAt, onsetEnds, pending}`. Есть носитель: `kind` disease/curse — `skipped` (с заметкой в карточке); poison — стадия `+1/+2` по степени шага, `endsAt` и `onsetEnds` не меняются, работает и в onset.
- **Onset ≠ стадия 0:** `onsetEnds` = `worldTime + onset`; стадия записана в бейдже сразу, но пока `worldTime < onsetEnds` эффекты не применяются, `nextAt = onsetEnds + interval(stage)`. Бейдж-подпись «Начало».
- **Стадия — только бейдж:** хук `updateItem` на активном ГМе (`system.badge.value` изменилось у носителя) → `applyStage(carrier, n, {damage})`: состояния стадии, урон, карточка. Это же даёт ручное снятие: клик ГМа по бейджу вниз = Cleanse/Treat; `n ≤ 0` — удалить носитель; выше последней — остаться. `deleteItem` носителя → `removeByKey(actor, "affl:<id>")` (состояния каскадом, как у `escape`).
- **Состояния стадии** (дефект: нельзя снимать «прежние» и нельзя поднимать чужое): набор `zl` (frightened, sickened, drained, doomed, stunned, unconscious) — `applyCondition` `max` **без снятия** при смене стадии (так делает pf2e; чужое не трогаем, в откате — только то, что подняли мы, `prev` в журнале). Остальные («связанные») — своя обёртка GrantItem по пути `createTimed` (unlimited, ключ `affl:<id>:<n>`), на смене стадии старые связанные удаляются, новые создаются. Урон стадии — `dealDamage`, при повторе высшей стадии — снова; `persistent` — `applyPersistent`.
- **Часы: одно `nextAt` в мировом времени** для всех единиц (раунд = 6 с, pf2e `CONFIG.time.roundTime`, в бою время идёт — **проверить живьём**). В бою (цель — участник боя): на `pf2e.endTurn` её хода сравнить `worldTime ≥ nextAt`; вне боя и для не-участников — `updateWorldTime` на активном ГМе и `ready`/смена лидера. В ход наложения броска нет (`nextAt` в будущем). Пропуск времени (8 ч за раз): **одна карточка** — сначала проверка `endsAt` (недуг кончился), иначе один бросок и `nextAt = worldTime + interval` (не догоняем пропущенные интервалы; решение, записать в README).
- **Бросок:** `hostChallenge` + карточка испытания (`rollerRole:"target"`, СЛ из снимка, цель бросает; NPC/несвязанный токен — ГМ автоматом, `owner:null` допустим). Новый внутренний шаг `stageDelta` (как `removeKey`, `rules.mjs:89`) в `byDegree` карточки: −2/−1/+1/+2 по степени, virulent и `streak` — по §1; результат пишется в бейдж.
- **Идемпотентность:** в носитель до `ChatMessage.create` пишется `pending:<id будущей карточки>` и сдвигается `nextAt`; при живом `pending` (карточка есть и без результата) новую не выкладывать; после перезагрузки/смены ГМа — подхват. Ключ `evId:uuid:affliction`, как у `runRepeats`.
- **Откат:** своя операция `afflictionUndo` в журнале (`undoOps`, `apply.mjs:637`): прежние стадия, `streak`, `nextAt`, `pending`; состояния возвращаются без повторного урона (флаг `{damage:false}` для `updateItem`-пути); повторное воздействие на яд — тоже откатываемо. Откат бейджа — готовая операция `badged`.
- Не делаем: лечение внешним эффектом (Neutralize Poison — позже, `removeEffect` по slug уже достаёт носитель; ручное — клик по бейджу), распространение болезни, кумулятивное снижение СЛ, нанесение яда на оружие (пачка 8, `afterUse`).

## 5. Тесты

- node (`tests/affliction.test.mjs`): `stageDelta` (4 степени × virulent × `streak`, сброс по не-успеху); границы стадии (0, высшая, `endsAt`); парсер на 12 реальных текстах (Spider Venom, Giant Centipede Venom, Purple Worm Venom, Ghoul Fever, Graveknight's Curse, Goblin Pox, «as stage 2», «dead»); `vAffliction`; повтор: disease/curse — `skipped`, poison `+1/+2` без сдвига `endsAt`, в onset; опознание по slug от другого автора; `nextAt` (раунды = 6 с, onset, пропуск 8 ч → одна карточка); `pending` не дублирует; откат; `afflictionStages(html)` положительные/отрицательные.
- живое `tests/live/affliction.js` по образцу `repeat-save.js` (`window.__afAffliction={only,skip,cleanOnly}`, d20 подменой, «AF тест»); **сначала яды**: `start` (провал → ст.1, крит. провал → ст.2, урон и состояния), `tick` (конец хода цели, успех → снятие носителя и связанных состояний), `fail-up`/`max-repeat` (повтор урона на высшей), `again-poison` (+1, `endsAt` тот же), `again-disease` (skipped), `onset` (без эффектов до срока), `foreign-sickened` (чужое sickened не поднято и не снято), `badge-click` (ГМ снижает бейдж → эффекты, без урона при откате), `reload-pending` (один бросок после перезагрузки), `unlinked`, `author-gone`; затем болезнь/virulent.

## 6. Открытые вопросы пользователю

Развилок нет: решения (1)–(3) приняты. Остаётся проверка живьём «раунд = 6 с в бою» и толкование virulent (§1) — не вопросы, а пункты теста/README.
