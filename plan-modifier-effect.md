# План: числовой модификатор / запрет без готового эффекта pf2e

Статус: РЕАЛИЗОВАНО (feat: inline modifier effect). Уточнения по ревью Критика, перекрывающие текст ниже: `effect.name` нет (имя «Эффект: <предмет>» из локали); `forbid` только `"reactions"` и = RollOption `af:no-reactions` (читают `reactionAvailable` и Внеочередная атака); скорость всегда `all-speeds`; срок обязателен и конечный, `of` допустим; проверки знака penalty/bonus нет; цели расширены спасбросками и навыками; slug `af-<slug предмета>`; в Мастерскую (палитра) `weak`/`forbid` не добавлены. Код: `scripts/inline-effect.mjs`, `applyInlineEffect` в `scripts/apply.mjs`, тесты `tests/inline-effect.test.mjs`, живой `tests/live/inline-effect.js`. Ниже — исходный план (номера строк устарели).

Прежний статус: план, код не тронут. База — master 84aaeb8 (ветка pack-1 ушла вперёд, правок в затронутых файлах это не меняет).

## 1. Проблема и масштаб

Схема умеет только `effect: {uuid}` (`scripts/rules.mjs:170-178`, выдача — `applyEffect`, `scripts/apply.mjs:~270-345`, диспетчер шага — `apply.mjs:538`). Нет ссылки на эффект — механика уходит в долг: «цель получает −2 статусный штраф к спасброскам на 1 раунд», «−10 футов к Скоростям», «слабость 5 к огню на 1 минуту», «не может использовать реакции».

Счёт (регуляркой, скрипты в scratchpad, не в репозитории):
- Долг пачки 1 (`rules/drafts-accepted/b01-save-conditions.json`, `confidence: needs-primitive`, 666 из 1246). Метки про модификатор/скорость/слабость/запрет: штраф/бонус ~50 строк, скорость 14, слабость/сопротивление 9, реакции/действия 18; объединение 76 (часть метки — составные, где модификатор лишь одна из причин). Чистых «только модификатор» ≈ 47 (цифра Руководителя) — реально закроются те, где причина одна.
- Весь компендиум (`tools/out/items.json`, `descEn`; не считая предметов со ссылкой на эффект `@UUID[...effects...]`, с `selfEffect`, с RE той же семьи в `ruleKeys`, без копий NPC `dupTop`; типы action/spell/feat/equipment/consumable): FlatModifier-подобные ~1500, скорость ~180, слабость/сопротивление ~290, запрет реакций/действий ~150; объединение ~2070. Это верхняя граница: большинство — пассивные способности и условные тексты. С фразой срока («for N rounds/minutes», «until the start/end…», «next turn») — ~376 / ~97 / ~79 / ~64, объединение ≈ 550-600. Реалистичный охват примитива — 300-600 предметов, из них в пачке 1 — десятки.
- Подвиды: (1) FlatModifier к статистике (AC, спасброски, Perception, навыки, атака/урон) — ≈ 60-65 %; (2) скорость — ≈ 8 %; (3) слабость/сопротивление — ≈ 12 %; (4) запрет реакций/действий — ≈ 7 %; (5) бонус «к одной атаке/проверке» (`ephemeral`) — остаток, в этот примитив НЕ входит.

## 2. Выбор: путь (а), но на кубиках Мастерской, а не на сыром RE

Сравнение:

| | (а) inline-эффект в шаге | (б) готовые эффекты в паке |
|---|---|---|
| Цена нового текста | 0 — данные в правиле | новый документ в паке + сборка + локализация, на каждую формулировку (~сотни) |
| Срок | уже есть у шага (`step.duration`, `apply.mjs:538`) | то же, но срок зашит в эффект или переопределяется |
| ru/en | автотекст из локали модуля (как Мастерская) | двуязычные документы руками |
| Откат | ops `created` — как у любого эффекта | то же |
| Риск | RE из данных модели | нулевой (куратор) |

Вывод: (а). (б) оставить для повторяющихся и сложных эффектов (ChoiceSet, Aura, GrantItem) — они и так идут через pack/uuid; не множить.

Ключевое решение по безопасности: **модель не пишет сырые Rule Elements.** В шаге лежат типизированные кубики того же словаря, что в Мастерской (`scripts/workshop/effect.mjs`: `bonus`, `speed`, `resist`; добавить `weak` и `forbid`), и RE строит код из них (`rulesOf`, `effect.mjs:57`). Белый список ключей получается конструктивно: FlatModifier / Resistance / Weakness. Кубик `raw` в шаге запрещён (он остаётся только в ручной Мастерской). Ядро `effect.mjs` чистое (без Foundry при импорте, импортирует только `util.mjs`), поэтому годится для валидатора `rules.mjs` и node-тестов без дублирования словарей.

## 3. Форма в схеме

```
{ to: "target", effect: { name?: "…", mods: [ <кубик>… ] }, duration: { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" } }
```
`effect.mods` взаимоисключимо с `effect.uuid` (ровно одно из двух). Кубики:
- `{ bonus: { target: "saving-throw"|"ac"|"attack-roll"|"damage"|"perception"|"skill-check", type: "status"|"circumstance"|"item"|"untyped", value: -2 } }` (value со знаком; в Мастерской это `sign`+`value`, `effect.mjs:23-24`, `signedValue`);
- `{ speed: { value: -10, type: "status" } }` — селектор `all-speeds` (в pf2e 8.6.1 фильтр `all-speeds`/`<тип>-speed`, pf2e.mjs); у Мастерской сейчас `land-speed` (`effect.mjs:59`) — для «all Speeds» поправить, «its Speed» оставить land;
- `{ weak: { dmg: "fire", value: 5 } }` и существующий `resist` (`{dmg, value, except}`, `effect.mjs:32`);
- `{ forbid: "reactions" | "actions" }` — pf2e не имеет Rule Element, запрещающего реакции, поэтому это информационный эффект: без RE, иконка на токене + текст в описании; ГМ соблюдает вручную. Честно называть это в README (то же, что многие pf2e-эффекты-памятки).

Имя: `effect.name` необязательно; по умолчанию `«Эффект: <имя предмета>»` из локали (en/ru, `lang/`), чтобы эффекты разных предметов различались и работал `removeEffect` по slug. Описание — `descriptionOf` (автотекст по кубикам, `effect.mjs:122`) + ссылка на источник, как у `createTimed` (`apply.mjs:46`).

## 4. Поток в рантайме

1. `vApply` (`rules.mjs:170`): ветка `effect.mods` → `validateMods` (см. §5), `out.effect = { mods, name? }`. Для `to:"target"`/`duration` остаются правила `rules.mjs:156-161`.
2. `apply.mjs:538`: если у `step.effect` есть `mods` — новый `applyInlineEffect` рядом с `applyEffect`, в той же очереди актёра (`queue("actor:"+uuid)`): `buildEffect`-подобный source (`effect.mjs:155`) через `effectSource` (`scripts/builtin/lib.mjs:22`); срок шага подставляется как в `applyEffect` (кубик «1d4» — `apply.mjs:~325`), контекст origin/target — как у `createTimed` (`apply.mjs:42-49`, нужен `of:"target"`-обход для turn-start/turn-end); `withMeta`; `slug = af-<предмет>-<n>`.
3. Дедуп: `hasEffect` по `compendiumSource` для inline не работает — идемпотентность по `meta.key` (`findByKey`, `apply.mjs:15`) и повторное применение того же шага того же автора не стакуется (в pf2e стакуются только разные типы бонуса, одинаковый тип берёт лучший — естественно).
4. Откат: ops `{op:"created", item}` — общий путь отката/«Отменить» (`apply.mjs` ops), код отката не меняется.
5. Иммунитет: у `forbid`/`weak` не действует (нет trait); у `bonus/speed` — нет; чек `immuneToTraits` (`apply.mjs:452`) применять только к `condition/effect/persistent` как сейчас — для inline считать `effect`.

## 5. Валидация

- `validateMods(list)`: массив 1-4 кубика, каждый — ровно один известный ключ; числа — целые в разумных пределах (|value| ≤ 50, weak/resist ≤ 100), `target`, `type`, `dmg` — из констант `effect.mjs` (`TARGETS`, `BONUS_TYPES`, `DAMAGE_TYPES`, `RESIST_TYPES`); `except` — slug-и. Любой лишний ключ — ошибка `E("effect.mods", path)`; сырых `key`/`predicate`/`selector`/`value`-строк (формул) модель не передаёт.
- Знак: штраф всегда отрицательный в данных; «penalty» с плюсом и «bonus» с минусом — ошибка (частая ошибка модели).
- `forbid` — только `reactions|actions`.
- Срок обязателен или явно «unlimited» (текст без срока → долг `unclear duration`, как сейчас).
- Промпты (`tools/prompts/`) — добавить словарь кубиков и 4 примера ниже; валидатор тот же, что в рантайме (`tools/validate.mjs`).

## 6. Примеры на реальных долгах пачки 1

1. `magical-fetters` («−10 ft speed penalty without effect link»): `{to:"target", effect:{mods:[{speed:{value:-10,type:"status"}}]}, duration:{value:1,unit:"rounds"…}}`.
2. `statement-strut` / `spirit-song` («can't use reactions»): `{to:"target", effect:{mods:[{forbid:"reactions"}]}, duration:{unit:"rounds",expiry:"turn-end"…}}` (+ информация ГМу).
3. `death-drone` («−2 Perception penalty (hearing)»): `{effect:{mods:[{bonus:{target:"perception",type:"status",value:-2}}]}}` — условие «слух» уходит в текст эффекта/описание (предикат не пишем; ограничение §8).
4. `decree-of-execution` не годится целиком (смерть по уровню), но `weak 20` — типовой случай: `{effect:{mods:[{weak:{dmg:"fire",value:5}}]}, duration:{value:1,unit:"minutes"}}` (пример `flame-strike`/`calcification` аналогичен). Составные («+ speed penalty and pull 10 ft», `inevitable-destination`) закрываются частично: модификатор через mods, остальное в долге (метка уточняется).

## 7. Мастерская, форма, пак

- Мастерская (`scripts/workshop/automation.mjs`, `app.mjs`): режим «Эффект» уже есть (`effect.mjs`, 168 строк, кубики `bonus/resist/speed/note/raw`); шаг автоматизации с `effect.mods` показывается как карточка по `textOf` (`effect.mjs:81`) — нужен только вывод в конвейере. Добавить кубики `weak`, `forbid` в `KINDS/BLANKS/rulesOf/textOf/validate` (и локаль `lang/*`). Конструктор шага: «Эффект: из пака / из кубиков».
- Форма `sheet.mjs`: kind `effect` (`sheet.mjs:47, 90`) получает режим «кубики»; в первом приближении — read-only показ и сохранение как есть (редактирование — через Мастерскую).
- Пак не пополняется; существующие эффекты — как были.

## 8. Тесты и живой сценарий

Node-тесты (`tests/`): `validateMods` — валидные/невалидные (знак, неизвестный ключ, `raw`, пустой список, `forbid:"x"`, дубли); `rulesOf`-снимки (FlatModifier selector/type/value, `all-speeds`, Weakness); round-trip схема→нормализация→sheet↔rule без потерь; рантайм на заглушках (`applyInlineEffect`: создаёт один документ, повтор по `meta.key` — skipped, срок и origin заполнены, откат удаляет). Живой сценарий (Foundry 14, pf2e 8.6.1; вкладку ГМа держать на about:blank): актёр-цель, применить `magical-fetters` — в листе Speed −10, эффект исчез через 1 раунд; спасбросок со штрафом −2 виден в брошенной проверке; `weak` — применить урон огнём (+5); `forbid` — иконка на токене и описание на ru/en; «Отменить» удаляет эффект.

## 9. Не делаем

- Сырые RE от модели, `predicate`/`ChoiceSet`/`GrantItem`/`Aura` в inline (идут через пак).
- Условные модификаторы («если цель prone», «против нечисти») — остаются в долге, пока нет `when` на уровне кубика (позже: безопасный предикат из roll options).
- Бонус только в одной атаке/проверке (`twin-feint`, `surprise-attack`; ROADMAP:48, `EphemeralEffect` — `scripts/builtin/lib.mjs:106`) — отдельный примитив `ephemeral`; общий слой `buildEffect` переиспользуем.
- Принудительный запрет реакций (нет API pf2e) — только памятка.
- Правка пака и миграция уже принятых правил.

## 10. Открытые вопросы

1. `forbid` как пустой информационный эффект — достаточно, или хотим RollOption-флаг (`self:cant-react`), чтобы макросы/ГМ-панель могли читать? 
2. Селектор скорости: `all-speeds` для «all Speeds», `land-speed` для «its Speed» — различать ли в тексте автоматически, или кубик `speed` получает поле `which: all|land`.
3. Условие «слух/зрение/против X» (≈ треть штрафов): принимаем потерю условия (эффект без предиката) или откладываем такие предметы в долг? Предложение: откладывать (точность важнее охвата).
4. Имя эффекта: `Эффект: <предмет>` достаточно или нужно авторское `effect.name` в данных от модели (ru/en)?
5. Бонус «до начала вашего следующего хода» у союзника: `expiry: turn-start` по ходу автора (`of:"origin"`) — подтвердить на живой проверке, как у `createTimed`.
