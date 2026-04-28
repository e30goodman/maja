# Macro Manual (Tihai Debug)

Этот мануал описывает макро-цикл для целевой отладки **Tihai-хвоста** в parent progressive и сохраняет серию логов в папку `logs`.

## Что делает макрос

Для каждого прогона:

1. Выполняет эквивалент нажатия `Eraser` (сброс паттерна).
2. Переключает Random mode на `parent`.
3. Выбирает preset `progressive`.
4. Запускает `Random` (prefill).
5. Сохраняет `lesson-log` в `.txt` и `.json`.
6. Дальше используется пост-проверка Tihai-окна (обычно такты 27-32).

По умолчанию макрос делает 5 прогонов подряд.

## Быстрый запуск

1. Запустите приложение:

```powershell
npm run dev
```

2. В другом терминале запустите макро-логгер:

```powershell
npm run macro:progressive-logs
```

После завершения в папке `logs` появятся файлы вида:

- `lesson-log-xxxxxxxx__macro-YYYYMMDD-HHMMSS-01.txt`
- `lesson-log-xxxxxxxx__macro-YYYYMMDD-HHMMSS-01.json`
- ...

## Параметры

- `APP_URL` — URL приложения (по умолчанию `http://127.0.0.1:3000`)
- `MACRO_COUNT` — число прогонов (по умолчанию `5`, максимум `50`)
- `MACRO_HEADLESS` — `false`, чтобы видеть браузер во время макро-прогона
- `MACRO_PRESET` — preset формы (`random`, `tihai_heavy`, `progressive`, `call_fill`)
- `MACRO_SAVE_SEEDS_FILE` — путь (от корня `konnakol_trainer`) куда сохранить seeds текущего batch
- `MACRO_REPLAY_SEEDS_FILE` — путь к JSON-файлу с фиксированными seeds для детерминированного replay

Пример:

```powershell
$env:APP_URL="http://127.0.0.1:3000"
$env:MACRO_COUNT="10"
$env:MACRO_HEADLESS="false"
$env:MACRO_PRESET="progressive"
npm run macro:progressive-logs
```

## Закрытие 3 отладочных кейсов

### 1) Фиксированный набор seed (replay без рандома)

Снять seeds с текущего batch:

```powershell
$env:MACRO_PRESET="progressive"
$env:MACRO_COUNT="10"
$env:MACRO_SAVE_SEEDS_FILE="regression/seeds.parent-progressive.local.json"
npm run macro:progressive-logs
```

Повторить точно те же seeds:

```powershell
$env:MACRO_PRESET="progressive"
$env:MACRO_REPLAY_SEEDS_FILE="regression/seeds.parent-progressive.local.json"
npm run macro:progressive-logs
```

Формат seed-файла: см. `regression/seeds.parent-progressive.sample.json`.

### 2) Авто-вердикт по JSON (`Музыка/Расчет`)

После batch:

```powershell
npm run macro:evaluate
```

Скрипт берёт последний `__macro-<runId>-*.json` и сохраняет:

- `logs/macro-eval-<runId>.json`
- `logs/macro-eval-<runId>.md`

Логика вердикта:

- `Расчет` при наличии хотя бы одного критического кода:
  `TIHAI_MORPH_ERROR`, `TIHAI_GEOMETRY_FAIL`, `WEAK_ENDING`, `PRASA_PARENT_BREAK`.
- иначе `Музыка`.

### 3) Odd jati регресс-набор

Базовый expected-файл: `regression/odd-jati.expected.json`.

Запуск:

```powershell
$env:MACRO_HEADLESS="false"
npm run regression:odd-jati
```

Результат: `logs/odd-jati-regression-<timestamp>.json`.
При несоответствии expected скрипт завершается с `exit code 1`.

## Tihai Debug Protocol (что проверять в каждом .json)

Целевой диапазон: хвост формы, обычно такты `27-32` (для 32-тактового progressive).

### 1) Triple Identity (Закон Трех)

- Найдите финальный `tihai`-блок (`type: "tihai"` с `phraseStep` от 0 до `phraseLength - 1`).
- Сравните 1-й, 2-й и 3-й повторы формулы: последовательность слогов должна быть идентичной.
- Любая внутренняя мутация формулы между повторениями = `TIHAI_MORPH_ERROR`.

### 2) Equidistant Gaps (Равные паузы)

- Если между повторами присутствуют gap-участки (`-`, `—`, `.`), длины gap должны совпадать.
- Проверяйте геометрию по `pulseOffsetBeforeBar` и фактической длине пауз.
- Разные длины gap = `TIHAI_GEOMETRY_FAIL`.

### 3) The Final Impact (Сила приземления)

- Последний значимый слог должен быть `Thom` или `Ta` с акцентом.
- `Muktayi-check` обязан быть `PASS`.
- Финальное попадание: `globalPulse % 8 == 7`.
- Иначе фиксируйте `WEAK_ENDING`.

### 4) Varna Integrity (Фонетическая чистота)

- Используйте диагностику `VARNA_HARSH_FLOW`.
- Если жестких стыков согласных > 3, снижайте эстетическую оценку.

### 5) Parental Link (Связь с родителем)

- Контроль `PrasaMaxEdit <= 2` относительно parent anchor.
- Превышение лимита = `PRASA_PARENT_BREAK`.

## Шаблон отчета по прогону

Для каждого файла (`.json`) фиксируйте:

- `Aesthetic Score: <0-100>`
- `Critical Errors: <коды ошибок или none>`
- `Verdict: Музыка | Расчет`

Рекомендуемый критерий вердикта:

- `Музыка` — нет критических ошибок формы/геометрии/посадки, `Muktayi = PASS`.
- `Расчет` — есть хотя бы одна критическая ошибка или нарушено финальное приземление.

## Для агента/отладки

В приложении доступен debug API:

- `window.__konnakolDebug.getLessonLogText()`
- `window.__konnakolDebug.runParentProgressiveMacroBatch(count)`
- `window.__konnakolDebug.runParentProgressiveMacroSeedBatch(seeds, preset?)`

CLI-скрипт использует именно этот API, поэтому ручные шаги и автоматизация совпадают.

