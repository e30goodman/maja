# Macro Manual (Parent Progressive)

Этот макрос автоматизирует цикл отладки и сохраняет 5 логов в папку `logs`.

## Что делает макрос

Для каждого прогона:

1. Выполняет эквивалент нажатия `Eraser` (сброс паттерна).
2. Переключает Random mode на `parent`.
3. Выбирает preset `progressive`.
4. Запускает `Random` (prefill).
5. Забирает текст lesson-log из приложения и пишет файл в `logs`.

По умолчанию делает 5 прогонов подряд.

## Быстрый запуск

1. Запустите приложение:

```powershell
npm run dev
```

2. В другом терминале запустите макрос:

```powershell
npm run macro:progressive-logs
```

После завершения в папке `logs` появятся файлы вида:

- `lesson-log-xxxxxxxx__macro-YYYYMMDD-HHMMSS-01.txt`
- ...
- `lesson-log-xxxxxxxx__macro-YYYYMMDD-HHMMSS-05.txt`

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
$env:MACRO_COUNT="5"
$env:MACRO_HEADLESS="false"
$env:MACRO_PRESET="progressive"
npm run macro:progressive-logs
```

## Закрытие 3 отладочных кейсов

### 1) Фиксированный набор seed (воспроизводимость)

Снять seeds из текущего batch:

```powershell
$env:MACRO_PRESET="progressive"
$env:MACRO_COUNT="10"
$env:MACRO_SAVE_SEEDS_FILE="regression/seeds.parent-progressive.local.json"
npm run macro:progressive-logs
```

Повторить тот же набор:

```powershell
$env:MACRO_PRESET="progressive"
$env:MACRO_REPLAY_SEEDS_FILE="regression/seeds.parent-progressive.local.json"
npm run macro:progressive-logs
```

Шаблон файла: `regression/seeds.parent-progressive.sample.json`.

### 2) Авто-парсер verdict (`Музыка/Расчет`)

После макро-прогона:

```powershell
npm run macro:evaluate
```

Выход:

- `logs/macro-eval-<runId>.json`
- `logs/macro-eval-<runId>.md`

Правило verdict:

- `Расчет`, если есть любой критический код (`TIHAI_MORPH_ERROR`, `TIHAI_GEOMETRY_FAIL`, `WEAK_ENDING`, `PRASA_PARENT_BREAK`);
- иначе `Музыка`.

### 3) Отдельный odd jati regression suite

Файл ожиданий: `regression/odd-jati.expected.json`.

Запуск:

```powershell
$env:MACRO_HEADLESS="false"
npm run regression:odd-jati
```

Скрипт сохраняет `logs/odd-jati-regression-<timestamp>.json` и возвращает `exit code 1`, если фактические verdict/ошибки не совпали с expected.

## Для агента/отладки

В приложении доступен debug API:

- `window.__konnakolDebug.getLessonLogText()`
- `window.__konnakolDebug.runParentProgressiveMacroBatch(count)`
- `window.__konnakolDebug.runParentProgressiveMacroSeedBatch(seeds, preset?)`

CLI-скрипт использует именно этот API, поэтому шаги в приложении и в автоматизации совпадают.

