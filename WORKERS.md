# Общая постановка для Рабочих K1–K8

Модуль `pf2e-automato` в `D:/ClaudeFun/pf2e-automato/` (Foundry v14.366, pf2e 8.6.1). K0 «Контракт» готов: `module.json`,
`scripts/{main,util,settings,compat,rules,apply}.mjs` рабочие, остальные `scripts/*.mjs` — заглушки с полными сигнатурами,
`node --test` 27/27 зелёные.

**Источник истины:** `plan.md` (§1 схема, §2 файлы и сигнатуры, §3 порядок событий, §4 настройки, §5 сокеты, §7 API, **§8 — твоя строка:
владение файлами и критерий готовности**, §9 харнесс, §10 изменения после ревью, §11 K8). Решения пользователя — `architecture.md`,
`plan-review.md`. Отчёт K0 о контрактах (важно!):
- `applyCondition/applyEffect/removeByKey` сами берут `queue("actor:"+uuid)`; **queue не реентерабелен** — не оборачивай их в тот же ключ.
- `applyOps(message, tokenKey, steps, ctx)`; `ctx = {scope:"challenge"|"apply"|"derived", degree?, stepKey?, target?, originActor?,
  originToken?, originItem?, rollOptions?, region?}`; возвращает ops этого вызова (повтор → `[]`); пишет `state.challenge.applied.<key>`
  или `state.apply.<key>`; ключ идемпотентности `<msgId>:<tokenKey|self>:c<degree>.<i>` / `<msgId>:<tokenKey|self>:<i>`.
- `hasEffect(actor, uuid, byActorUuid, key=null)`.
- `HANDLERS` в `main.mjs`: ответ `{ok:true,result}` | `{ok:false, reason:"not-active-gm"|"error", error}`; `applyUse`, `applyDerived`,
  `createZone` пока не проведены (K7). `socket`/`callGM` — из `util.mjs`.
- `api` ставится в `init` в `game.modules.get("pf2e-automato").api`.
- i18n: несколько файлов на lang склеиваются ядром; свой файл — `lang/{ru,en}/<кусок>.json`, ключи `PF2E_AUTOMATO.<кусок>.*`.
- `node --test` (без аргумента каталога) или `node --test tests/*.test.mjs`.

**Правила для всех:**
- Владеешь ТОЛЬКО файлами своей строки §8 (+ свой `tests/<кусок>.test.mjs` для чистых функций). Чужие файлы НЕ ПРАВИТЬ; нужна правка контракта —
  опиши в отчёте в «Спорных местах», не делай сам.
- API Foundry v14 / pf2e 8.6.1 — сверять по исходникам, не выдумывать: ядро `E:/Foundry VTT v14.366/app/resources/app/` (`common/`, `client/`),
  pf2e `C:/Users/USER/AppData/Local/FoundryVTT/Data/systems/pf2e/pf2e.mjs` (grep), модули `C:/Users/USER/AppData/Local/FoundryVTT/Data/modules/`.
- Foundry у тебя нет: живые проверки опиши в отчёте готовыми сниппетами для консоли ГМа — их выполнит Руководитель.
  **Персонажей игроков в сниппетах не использовать** — только временные актёры (Monster Core, пустой character) и временная сцена, с уборкой.
- `node --check` на свои `.mjs`, валидный JSON, свои юнит-тесты зелёные, весь `node --test` не сломан.
- Без npm/сборщиков. Не трогать `prototypes/`, мир, LevelDB, Data/modules. Комментарии по-русски, кратко; строки UI — только через i18n (ru+en).

**Отчёт:** файлы; тесты (сколько/зелёные); готовые сниппеты живой проверки по критерию §8; решения на догадке с местом в коде;
«Спорные места» (пусто — так и напиши).
