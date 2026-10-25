# activate-ext: свой срок у записи и иммунитет после спасброска заклинания (план v2, кода нет)

Продолжение `plan-activate.md` (решения §0/§3 не пересматриваются; схема, рантайм сообщения активации, Мастерская и модельный проход — сделаны). База: `feat/workshop-editors` (`96b2f19`). Числа — скриптом по `rules/drafts-accepted/b*.json` ∩ `tools/out/activate-pool.json` (150 в пуле, 133 `needs-primitive`). Живые допущения — **[J]**. Принцип: механизм под всю группу; сюжетное не автоматизируем. v2 учитывает разбор Критика.

## 0. Решения пользователя (2026-10-25, окончательные)

1. Правило заклинания **Dominate писать в этой работе** (шаг 4, до данных).
2. Срок «до события» — **долг**: Gamtu Hat и Hydration Cloak. Причина — не «срок до события», а то, что **своего срока у записи нет**: у Gamtu Hat это обычный срок Invisibility плюс события «шляпа снята / срок шляпы», у Hydration Cloak «10 минут» — обычный срок Water Walk. Это обычный каст + `note`, а не `duration`.
3. Заклинания **без правила** (Water Walk, Ethereal Jaunt, Telepathy) — **оформлять** со `duration` заранее. Оговорка: Hydration Cloak (Water Walk) по п.2 в долге, поэтому из «Water Walk ×2» оформляется один — Energy Robe of Cold.

## 1. Общая идея: чистое наложение на правило заклинания

`castItem` (`cast.mjs:~226-231`) уже держит **слитую запись `c`** (после `entryOf`) и кладёт `dc`/`rank` в метку `flags.pf2e-automato.activation`; `use.mjs:~118` читает их оттуда. Новые поля `duration` и `immunity` кладутся **в ту же метку**, а `onPreCreateMessage` вызывает чистую `withActivation(rule, flag)` (`rules.mjs`) над правилом, которое дал `resolveRule`. Записи не ищем (`fromUuidSync`, `parentItem`, несвязанные токены NPC, импорт `entryOf` — не нужны; допущения [J] про поиск нет): всё нужное уже в сообщении, оно создаётся клиентом автора.
`withActivation` **не мутирует вход** и возвращает копию: `resolveRule` отдаёт объект каталога по ссылке (`rules.mjs:1798-1826`). Вариант `choices[j]` получает поля через `entryOf` бесплатно. Нет `duration`/`immunity` в метке — функция возвращает то же правило.
**Накладывается ли на правило из `markup`?** Да, функция работает над любым объектом правила, не смотрит на источник. Но Dominate-правилом из `markup`/`low` пользоваться нельзя (кнопки `low` — только ведущему, `rules.mjs:1831`) — поэтому правило поднимается в каталог (§3), а валидатор данных (§2, §3) предупреждает, если у `spell` записи нет каталожного правила.

## 2. Механизм 1: свой срок записи (`duration`)

**Отбор — по правилу заклинания в каталоге, что реально меняется.** Данные: «effects of X for N» без каста — 12 записей (Aeon Stone (Pearlescent Pyramid), Cloak of Social Graces ×3, Vanishing Wayfinder, Invisibility ×2, Energy Robe of Cold, Hydration Cloak, Ethereal, General's Word, Gamtu Hat). После решений §0 и проверки:
- **7 с правилом заклинания (срок реально меняется):** Heroism ×3 (Cloak of Social Graces ×3, 1 минута), Invisibility ×3 (Invisibility, Invisibility (Greater) — 1 минута; Vanishing Wayfinder — 5), See the Unseen ×1 (Aeon Stone Pearlescent Pyramid, 1 раунд; правило — `See Invisibility` из PA, у ранга ≥5 свой срок, перекрывается).
- **+1 Bewitching Bloom (White Poppy)** — единственный пример `choices[j].duration`: Calm/Sanctuary «до конца вашего следующего хода» = `{value:0, unit:"rounds", expiry:"turn-end"}` (форма `value:0`+`turn-end` валидатором разрешена, `rules.mjs:160`). Правило есть у Calm (PA, `byDegree.success`); у Sanctuary — нет (`partial`). Спасбросок контролирующего «срывает активацию» — `note`.
- **+3 без правила заклинания, оформляются заранее (решение 3):** Energy Robe of Cold (Water Walk, 1 минута), Ethereal (Ethereal Jaunt, 10 минут), General's Word (Telepathy; срок — сверить с текстом при выпуске). Сработают, когда у заклинания появится правило; пока — каст + `note`.
- **В долге, не этот механизм:** Gamtu Hat, Hydration Cloak (§0.2); **(Ghost) Fetch** — Illusory Creature без шагов с эффектом (сотворение двойника), «1d4 hours» срок нечего перекрывать (долг «случайный срок»/сотворение); Light-татуировки ×2 (`rule:null`, лечение каждый ход); Malefic Mirror, Cloak of the False Foe, Soft-Landing, Whispering Spirit Tome, Amaranthine Visage; Horn of Blasting (deafened 2d6 — правка правила, не схемы).
Итого механизм нужен **8 записям с правилом (7 + Bloom)** и оформляет ещё 3 на будущее.

**Альтернатива, от которой отказались:** для Invisibility и See the Unseen записать «`onUse` без каста» с шагом `condition ... duration` (механизм уже есть). Отклонено: теряется карточка заклинания pf2e (ранг, усиление, описание), ранг/СЛ записи, и придётся дублировать правило заклинания в каждой записи (Heroism — 3 копии, Invisibility — 3). Общее поле даёт срок одним полем и подхватывает правило заклинания, когда оно уточняется.

**Схема.** `duration:{value,unit,expiry?}` у записи/варианта, только при `spell` (без `spell` — ошибка: у `onUse` срок пишется в шаге). **Выделить `vDuration`** из `rules.mjs:157-164` (форма, кубик `1d4`, `value:0`+`turn-end`, `expiry`, `of`) и использовать в `vApply` и в `vCast`; вторую копию проверки не заводить (у `coat`, `rules.mjs:257-260`, своя — не трогать).
**Рантайм `withActivation`.** Что получает срок: у шагов `onUse.apply` **и** `onUse.challenge.byDegree[*]` **и** `onUse.check.byDegree[*]` (`check` охвачен) — шаги с `effect` или `condition`, у которых не стоит иное:
- `condition.policy:"reduce"` — **пропуск** (валидатор запрещает срок, `rules.mjs:152`; иначе `applyCondition` ушёл бы в `createTimed`, `apply.mjs:119`, и снижение превратилось бы во врéменное);
- шаг с `repeat` (повторный спасбросок, носитель — созданное состояние) — **пропуск** (срок заклинания остаётся; срок записи с `repeat` не комбинируется — [J] неизвестно, как `repeat` живёт с обёрткой-сроком), валидатор данных предупреждает;
- `of` (чей ход считает срок; у состояния и inline-`mods` — по умолчанию `origin`, у `effect` по uuid поля нет, `rules.mjs:162`): если у шага уже есть `duration.of` — сохраняется, иначе для `condition`/inline-`mods` ставится `origin`, для `effect` не ставится;
- шаги `note`, `removeEffect`, `removeCondition`, зона (`zone.effect`) и `onEvent` — не трогаются.
Дальше работают существующие `apply.mjs:383` (срок шага заменяет срок эффекта) и `undoApplied`.
**Валидатор.** `vCast`: поле — `vDuration`; при неизвестном ключе записи — отказ (§5). `tools/validate.mjs`: **предупреждение, не ошибка**, если у `spell` нет правила в каталогах или в нём нет шагов, к которым срок применим.
**Мастерская.** `workshop/app.mjs:~722` рядом с рангом: блок «Свой срок» (число + единица + expiry); `ruleToForm`/`formToRule` (`sheet.mjs:195-201`) туда-обратно; пустое = поля нет; у варианта `choices` — те же поля.

## 3. Механизм 2: иммунитет после спасброска самого заклинания (`immunity`)

**Данные: 15 записей**, все NPC-действия Dominate (вампиры/носферату: «(Vampire, True) Dominate», «(Vampire, Nosferatu) Dominate» и 13 «Dominate»); срок везде 24 часа, степени «a creature that succeeds». 7 прочих записей из «~22» — не этот механизм (The Fiend — иммунитет заклинателя, Castrovel's Beacon — по трейту `elf`, Ring of Bestial Friendship, Sorshen's Garment, Soulcutter (Heroic), Deck of Destiny, Chain of Command — у Command правило ручное).

**Блокер и его снятие (шаг 4, решение 1).** Правила Dominate в `catalog*.json` нет; в `rules/drafts-accepted` он `manual/needs-primitive/rule:null`, а в `tools/out/triage.json` — **`markup-high`**, `confidence:"high"`: черновик слоя 2 — `challenge` Will, `dc:{source:"spell"}`, success → `stunned 1`, failure/criticalFailure → `controlled`; `resolveRule` в рантайме отдаст его как `markup`/`low` (`rules.mjs:1831`: кнопка только ведущему). Шаг 4 берёт этот черновик за основу, а не пишет с нуля; **доделать и принять:**
- `controlled` — состояние есть в pf2e (`9qGBRpbX9NEwtAAr`, не valued); срок — «до следующих ежедневных приготовлений» → 1 день (`duration`, точный срок — в `note`), если у заклинания не усиление 10 ранга («unlimited» — нет `duration`, `rank:{min:10}`);
- повторный спасбросок в конце хода — **есть примитив `repeat`** (`rules.mjs:226-236`): на `failure` `repeat:{on:"turn-end", end:["success","criticalSuccess"]}`; на `criticalFailure` — без `repeat` + `note` («новый спасбросок только если приказ против природы цели»); значит, правило не `partial` по повтору, остаётся `partial` лишь на «приказы» (сюжетное, не автоматизируем) и `note` про самоубийственный приказ;
- принять как `confidence:"model"`, `status` `manual` (конвенция модельных черновиков `b01`) с ручной сверкой Критика; после `drafts.mjs` оно попадает в `rules/catalog.model.json` (`modelCatalog` берёт только `confidence:"model"`).
Тот же шаг заодно закрывает самое Dominate-заклинание для PC и отдельное «Dominate»-правило, а не только 15 NPC-активаций.

**Переиспользуется (второго механизма нет):** `challenge.immunity` целиком — `vImmunity` (`rules.mjs:452`), `immunityAt`/`hasImmunity`/`isImmune`/`applyImmunity` (`checks.mjs:46-190`), блок плана в чате (`chat.mjs:226`), проверка «цель иммунна — без броска» (`saves.mjs:139/152/373`), откат вместе со степенью; автор берётся из сообщения (`authorOf`, для метки `activation` уже учтено в `applyImmunity`). Вывод из текста — `immunityFromText` + `immunityDuration` (`rules.mjs:1624/1646`), тест `tests/challenge.immunity.test.mjs`.
**Схема.** Поле записи/варианта `immunity` = `vImmunity`, только при `spell`; в метку `activation` кладётся рядом с `dc`/`rank`. `withActivation`: `onUse.challenge.immunity = flag.immunity` (запись сильнее собственного иммунитета правила заклинания). Нет `challenge` у правила — наложение ничего не делает.
**Валидатор данных.** `tools/validate.mjs`: **предупреждение, не ошибка**, если у `spell` записи нет правила или в нём нет `onUse.challenge` (после шага 4 у Dominate оно есть).
**Конвертер (без модели).** Запись с `spell` и `immun` в блоке активации: `immunityFromText` + `immunityDuration` → `immunity:{slug:<slug заклинания>, label, duration, degrees}`; не вывелось однозначно — долг. 15 Dominate закрываются патчем принятых черновиков без повторного модельного прохода. Охват по умолчанию — «этот автор» («that vampire's Dominate»), не «все вампиры».
**Мастерская.** `workshop/app.mjs:69` `immFields(p, m)` **уже параметризован путём** и используется в нескольких местах; в записи — `...immFields(\`${p}.imm\`, e.imm)` (+ `immForm`/`immRule` в `sheet.mjs:142-150` для `ruleToForm`/`formToRule`). Шаблон `templates/sheet-tab.hbs:~130-142` с жёсткими `ch.imm.*` — старая вкладка листа, она секцию `activate` не рисует; **не трогаем**. Если выяснится обратное — вынести блок в inline-partial `afImm` с параметром пути (`{{> afImm p="ch.imm"}}`, как `afRow`, `sheet-tab.hbs:2`).

## 4. Что идёт в правила и кому

- **Без модели:** 15 иммунитетов (`immunityFromText`/`immunityDuration`); сроки 8+3 записей — правкой принятых черновиков по списку §2 (11 правок), срок берётся из текста блока активации, а не из вывода.
- **Правило Dominate (шаг 4):** черновик слоя 2 + ручная доводка (`repeat`, `controlled`, срок) + Критик. Если пользователь захочет шире пачки «каст + свой срок» — **Sonnet**, не Haiku (Haiku отдал дальше ~92%, проверка Haiku 18% ошибок); выборка 50 — на всю пачку (меньше 50 записей — все). Промпты: `activate-memo.md` (две строки: «срок из текста — `duration` записи, шаги заклинания не повторять», «иммунитет от заклинания — `immunity`»), `draft-rule.md` (ключи `duration`, `immunity`; сверка `tests/tools.test.mjs`).
- **Метки долга:** `immunity after the spell's own save` и `effects not cast, N duration` снимаются; `partial` + `note` у Sanctuary, Water Walk/Ethereal Jaunt/Telepathy («правила заклинания нет»).

## 5. Риски

- **Уступка PA (`yieldToAutomations`, `settings.mjs:31`, по умолчанию `true`):** правила Heroism, See Invisibility (See the Unseen) и Calm взяты из `rules/catalog.pa.json`; при активном pf2e-automations `compat.shouldYield` (`compat.mjs:60`) отдаст сообщение PA, и наложение **молча не сработает**. Зафиксировать в живом сценарии состояние PA (вкл/выкл) и прогнать оба; в README — строка. Invisibility и Dominate — не из PA (`catalog.json`/`catalog.model.json`).
- **Белый список схемы:** `vCast` перечисляет ключи записи и варианта (`rules.mjs:~695`, `~700-702`), остальные молча отбрасываются; `cast-batch.mjs:~219` пишет `validateRule(rule).rule`. Если поля не добавить в оба списка (запись и вариант) — они пропадут тихо при записи черновика и из каталога. Лечится тестом §6 (раунд-трип и `extraKeys` на патченных черновиках).
- **Один срок на разные шаги:** срок записи ставится на все подходящие шаги одним значением; для 11 записей эффект один. Заклинание с разными сроками шагов — только через `choices`/долг; валидатор данных предупреждает.
- **Наложение зависит от каталога заклинаний:** запись корректна, пока правило заклинания не изменилось; ловит `tools/validate.mjs`, не рантайм.
- **`repeat` + срок:** шаги с `repeat` срок записи не получают (§2) — Dominate не затрагивается (он без `duration` записи).

## 6. Порядок шагов и тесты

1. **Схема + валидатор + `withActivation`**: `vDuration` (выделен, `vApply` не меняет поведение — прежние тесты зелёные); `duration`/`immunity` в белом списке записи **и** варианта; `withActivation`; метка `activation` получает поля в `castItem`. Юнит `tests/activate-ext.test.mjs`:
   - раунд-трип: `duration` и `immunity` переживают `validateRule` у записи и у варианта; без `spell` — ошибка; `formToRule`/`ruleToForm` без потерь;
   - `withActivation`: срок на `apply`, `challenge.byDegree`, `check.byDegree`; пропуск `reduce`, `repeat`, `note`, `removeEffect`; `of` по умолчанию `origin` для `condition`, нет для `effect`; `rank`-шаги сохраняют гейт;
   - иммунитет кладётся в `challenge`; нет `challenge` — правило прежнее;
   - **исходное правило каталога не изменено** (сравнить глубокую копию до/после; результат — другой объект);
   - на патченных черновиках `extraKeys` пуст (проверка `tools/validate.mjs`);
   - предупреждения валидатора данных (нет правила / нет `challenge` / нет применимых шагов) — предупреждения, не ошибки.
   Критик.
2. **Рантайм:** вызов `withActivation(resolved.rule, flag)` в `onPreCreateMessage` (у `hasSnapshot` ничего не меняется); README (схема/раздел «Активации», строка про PA); `draft-rule.md`, `activate-memo.md`, сверка `tools.test.mjs`.
3. **Мастерская:** блок «Свой срок» и `immFields(\`${p}.imm\`)` в записи/варианте; раунд-трип.
4. **Правило Dominate** (§3): черновик триажа → `repeat`/`controlled`/срок → принять → `catalog.model.json`; юнит на правило (`validateRule`, ступени, `repeat` у failure). Отдельный коммит.
5. **Данные:** патч 15 Dominate (`immunity` скриптом) и 8+3 записей со сроком (правкой черновиков); `drafts.mjs` → `catalog.model.json`; выборка Критика (все записи); при расхождении — Sonnet; `coverage.md` и строка «Долг» в ROADMAP.
6. **Живой прогон** `tests/live/activate-ext.js` (вкладка ГМа, бой, «AF тест», цель — NPC; по одному; **вести и с клиента игрока**, и с ГМа; **фиксировать состояние pf2e-automations**, прогнать вкл и выкл):
   - перед началом сверить **срок эффекта Heroism по паку** `pf2e.spell-effects` (`game.packs`, не по памяти) — в этой среде пака 8.6.1 под рукой нет, срок 1 час в плане **не проверен**;
   - (а) Cloak of Social Graces: эффект Heroism на владельце длится 1 минуту; откат снимает;
   - (б) Invisibility: состояние на 1 минуту (в правиле 10);
   - (в) Bewitching Bloom: вариант `choices` — Calm с `duration` «до конца хода»;
   - (г) **Dominate у несвязанного токена NPC**: спасбросок цели (успех) → иммунитет 24 часа, второй каст — «цель иммунна», без броска; провал — `controlled` + `repeat` в конце хода; метка `activation` не теряется;
   - (д) иммунитет от **двух разных актёров-вампиров**: цель, прошедшая спасбросок против первого, против второго бросает (охват по автору);
   - (е) удаление сообщения возвращает счётчик, иммунитет и эффекты снимает кнопка отмены.
Критик по диффу перед каждым коммитом.

## 7. Открытые вопросы пользователю

Реальных развилок не осталось: три вопроса v1 закрыты решениями §0. Единственное — **General's Word (Telepathy)**: срок в тексте я не вскрывал; если он нестандартный, запись уходит в долг (решается при выпуске, не блокирует).
