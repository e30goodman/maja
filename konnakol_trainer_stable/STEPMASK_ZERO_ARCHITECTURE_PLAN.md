# STEPMASK ZERO: строгий Execution Pipeline (Dependency-First Roadmap)

Цель: внедрить "0" как паузу через `stepMask`, не ломая контракт `subdivs`, snapshot-совместимость, audio/MIDI-паритет и текущую архитектурную математику.

---

## PHASE 1: THE BEDROCK (State, Migration & Persistence)

**Приоритет:** максимальный.  
**Статус зависимости:** **блокирует все остальные фазы**.

### 1.1 Базовая идея (source of truth)

- `subdivs` остается плотностью шага (`>= 1`), как и сейчас.
- Пауза хранится отдельно: `stepMask: boolean[]` в `cellStepMasks`.
- `"0"` в UI — только визуальное представление паузы, не доменное значение `subdivs`.
- Единственный источник истины для пауз — `cellStepMasks`.

Это снимает конфликт с текущей архитектурой, где `subdivs` нормализуется и сериализуется как `1..9`.

### 1.2 Инварианты (зафиксировать до любых изменений)

1. `subdivs` никогда не хранит `0` (ни в state, ни в snapshot wire-format).
2. Пауза живет только в `cellStepMasks`; legacy-пауза через `customCellSyllables['-']` запрещена.
3. Для `computeNps(bpm, phraseLen)` всегда `phraseLen = stepMask.length`, не `count(true)`.
4. `dead tail` (`cIdx >= deadStart`) приоритетнее масок и не меняется.
5. В рендере текста шага нет fallback на числа (`subdivs`, `i`, `length`).
6. Legacy `subdivs===10` (tail-pause hack) удаляется; пауза кодируется только через `cellStepMasks`.

### 1.3 Data model и нормализация

Добавить в домен:

- `cellStepMasks: Record<string, boolean[]>`.
- Ключи lane-aware (например `l${lane}-r${row}-c${cell}`), чтобы избежать коллизий в poly и поддержать независимые паузы по дорожкам.

Правила нормализации масок:

- если маски нет -> считать "все `true`";
- если длина маски не равна `subdivs` -> расширить/обрезать до `subdivs` (новые элементы `true`);
- если маска целиком `true` -> ключ допустимо удалять (компактность);
- нормализация выполняется лениво при чтении (селектор/label-engine), не синхронно в setter; в state допускается хранение "полной" маски длиной до 9.

### 1.4 Legacy migration

- если в `customCellSyllables` встретился `'-'` (или эквивалент паузы), конвертировать в `cellStepMasks` и удалить override-слог;
- все legacy-кейсы `subdivs===10` конвертировать в `subdivs=1` + `stepMask=[false]`.

### 1.5 Snapshot / persistence

Включить `cellStepMasks` в:

- `createEmptySnapshot`;
- `snapshotToJSON`;
- `parseSnapshotRow`;
- runtime snapshot clone/load точки;
- compact clipboard token encoder/decoder.

Совместимость и wire-format:

- отсутствие `cellStepMasks` в старом snapshot трактуется как "все шаги активны";
- для compact token ввести новую версию формата (например `p4` / `v2_...`), при этом `p1/p2/p3` остаются декодируемыми;
- маски в token кодировать плотным битовым видом (hex/base64), без распухания строки.

---

## PHASE 2: HIGH-RISK PARITY & CORE ENGINE (Audio, MIDI & Logic)

**Приоритет:** высокий риск, второй после Bedrock.  
**Статус зависимости:** **делать строго после Phase 1, но до любых изменений в UI**.

### 2.1 Audio/MIDI parity (core behavior)

И live scheduler (`App.tsx`), и `midiExport.ts` обязаны применять одну и ту же маску:

- muted-step не эмитит ничего: `passive`, `alt`, `accent`, `taHigh` подавляются полностью;
- временная сетка не сжимается;
- правила first-beat/Ta/accent сохраняются, но `mute` имеет приоритет над ними;
- если замьючен шаг сильной доли (`c0`/first beat), звук отсутствует полностью и не переносится на следующий sub-step;
- в MIDI muted-step — это rest (смещение времени), не `velocity=0` note.

### 2.2 CRITICAL PATH: MIDI-шифратор/дешифратор parity

🔴 **Critical path. Блок высокого риска, завязан на roundtrip и snapshot-контракт.**

- в проекте уже есть snapshot-шифратор/дешифратор с логикой "вычет в ноль / не ноль"; контракт при внедрении `stepMask` ломать нельзя;
- в `midiExport.ts` запрещено "просто пропускать" muted-step через `continue/return`, если это сжимает тайминг и ломает метрику дешифратора;
- каждый `stepMask[i] === false` обязан конвертироваться в тот же семантический "ноль" (тишина/offset), который понимает текущий дешифратор;
- delta-time следующей звучащей ноты обязан впитать длительность muted-step по текущей legacy-математике пауз;
- перед изменением реализации обязательно изучить путь legacy-пауз (`subdivs===10`, `'-'`) и сохранить тайминговую эквивалентность.

### 2.3 Label engine (`buildRowCellSyllableLabels`) и Sarva Laghu

Расширить `buildRowCellSyllableLabels(...)`:

- новый опциональный вход: `cellStepMasks?: Record<string, boolean[]>`.

Для `subdivs > 1`:

1. взять `phraseLen = stepMask.length`;
2. выбрать `Kalam` через `computeNps(bpm, phraseLen)`;
3. построить базовую фразу длины `phraseLen`;
4. наложить маску:
   - `stepMask[i] === true` -> исходный слог;
   - `stepMask[i] === false` -> `'-'`.

Для `subdivs == 1`:

- если `stepMask[0] === false`, закрыть текущий Sarva Laghu сегмент, положить `['-']`, затем начать новый сегмент со следующей клетки;
- правило разрыва Sarva Laghu универсально: работает в начале/середине/конце ряда и перед dead-tail.

### 2.4 Cache + hysteresis (`useStableRowCellLabelsCache`)

Чтобы лейблы пересчитывались при изменении маски:

- добавить mask-сигнатуру (`stepMaskSigByRow` или эквивалент) в `useMemo` deps.

Чтобы не получить hysteresis bleed:

- ключи `kalamMap` не менять (`${rowIdx}-c${cellIdx}` / `${rowIdx}-seg${segStart}`);
- mask-состояние должно влиять только через deps и полный пересчет лейблов.

---

## PHASE 3: THE SHELL (UI, Render & User Input)

**Приоритет:** ниже, чем core engine.  
**Статус зависимости:** выполняется только после завершения Phase 1 и Phase 2.

UI в этой фазе **не содержит доменной логики пауз**: UI только читает подготовленные данные из state/engine (Bedrock + Core Engine) и диспатчит строго определенные действия.

### 3.1 Render contract (`SequencerGrid.tsx`)

Рендер текста шага должен быть жестко числобезопасным:

- брать только `rowCellLabels[cIdx]?.[i]?.syl ?? ''`;
- если `'-'/'–'/''` -> показывать пусто;
- никаких `|| subdivs`, `|| i`, `|| length`;
- при `syl === '-'` выставлять `data-muted="true"` на sub-step элемент (для дебага/тестов/селекторов).

### 3.2 User input: режимы Divs и mute-step

#### Нормальный режим (long-press/drag по клетке)

- текущая механика выбора `subdivs` сохраняется;
- добавить действие `toggleCellStepMute(cellKey, stepIdx)`;
- действие меняет только маску, не `subdivs`; `subdivs` читается из state внутри экшена (без передачи аргументом, чтобы убрать гонки).

#### Режим распущенного слайдера

- слайдер продолжает управлять только `subdivs`;
- при изменении `subdivs` маска ре-нормализуется к новой длине;
- UI может показывать `"0"` как паузу, но в домене остается `subdivs >= 1`.

#### Спецификация UI-маппинга `DIVS slider (0..9)` <-> `subdivs + stepMask` (обязательно)

Цель: визуальный `0` = тотальный Karvai-mute клетки, при этом доменный инвариант не нарушается: `subdivs` в state всегда `>= 1`.

Правила для `onChange` ползунка:

1. Если пользователь выбрал `sliderValue > 0` (например, `5`):
   - записать `subdivs = 5`;
   - записать `stepMask = [true, true, true, true, true]`.
   - при выходе из `0` маска всегда сбрасывается в полностью активную для новой длины.

2. Если пользователь выбрал `sliderValue = 0`:
   - не переводить домен в `subdivs = 0` (запрещено инвариантом);
   - сохранить текущее валидное `subdivs` (или принудительно `1` для новой/пустой клетки);
   - записать маску полной паузы длиной текущего `subdivs`: `stepMask = [false, false, ...]`.

Правило чтения значения для рендера ползунка:

- использовать селектор:
  - `const sliderValue = stepMask.every(step => step === false) ? 0 : subdivs;`
- если маска целиком `false`, UI показывает позицию `0`; иначе UI показывает реальный `subdivs`.

Следствие для архитектуры:

- `0` существует только в UI-слое;
- домен и snapshot-контракт продолжают работать с валидными длинами (`subdivs >= 1`) + маской.

#### Разделение режимов редактирования

- клики в режимах accent/dead-tail остаются без изменений;
- для mute-step (Karvai) ввести отдельный режим редактирования (рекомендовано) или модификаторный жест (Shift+Click / long-tap по sub-step);
- режимы не конфликтуют: один клик не должен одновременно менять accent и mute.

---

## PHASE 4: GUARDRAILS & ROLLOUT (QA, Tests, DoD)

**Приоритет:** финальный gate перед релизом.  
**Статус зависимости:** запускается после готовности фаз 1-3.

### 4.1 Минимальный тест-план

#### Unit (`sequencerLabels.test.ts`)

- `phraseLen = stepMask.length`, не `count(true)`;
- `subdivs=4` + mask `[true,false,true,true]` -> пауза на втором шаге;
- разрыв `subdivs==1` сегмента при `stepMask[0]=false`;
- приоритет dead-tail над маской.

#### Integration (UI/Logic)

- клик mute -> пересчет `rowCellLabels`;
- пауза рендерится пусто;
- смена `subdivs` корректно ре-нормализует маску;
- `data-muted="true"` выставляется на muted sub-step.

#### Snapshot

- save/load сохраняет `cellStepMasks`;
- старые snapshot без поля грузятся как "все шаги активны";
- compact token новой версии корректно кодирует/декодирует маски;
- старые token-версии продолжают читаться.

#### Audio/MIDI

- muted-step не звучит в real-time;
- muted-step отсутствует в MIDI;
- выбор Kalam не "прыгает" из-за пауз;
- muted-step в MIDI сдвигает таймлайн следующей ноты (rest), не создавая `velocity=0` note;
- first-beat при muted шаге не звучит и не переносится;
- запрещено сжатие сетки из-за пропуска muted-step (`continue/return`) в экспортном цикле;
- поведение "ноль/не ноль" в экспорте совпадает с ожиданиями текущего дешифратора snapshot-контракта.

#### Integration (обязательный DoD gate)

- прогнать scheduler на паттерне с масками и проверить, что для muted шагов не вызываются `play...` функции;
- прогнать `midiExport.ts` на том же паттерне и проверить корректный rest-тайминг;
- parity-test: сравнить delta-time после muted-step с legacy-эталоном (бывшие `subdivs===10` и `'-'`), подтвердить идентичную "нулевую" семантику для дешифратора.

### 4.2 Критерии готовности (Definition of Done)

Фича считается готовой только если одновременно:

- `Divs` работает в обоих режимах без регрессий;
- пауза визуально пустая (без цифр);
- snapshot roundtrip сохраняет маски;
- audio/MIDI/UI согласованы;
- нет регрессий по TA/first-beat/dead-tail/poly lane separation.

---

## Исполнительная последовательность (контроль зависимостей)

1. **Phase 1 (Bedrock)**: data model + snapshot roundtrip + legacy migration.
2. **Phase 2 (Core Engine)**: label engine, cache/hysteresis, audio/MIDI parity, critical MIDI cipher path.
3. **Phase 3 (Shell/UI)**: input и render как thin layer поверх готовых данных/инвариантов.
4. **Phase 4 (Guardrails)**: полный тестовый gate и DoD.

Запрещено переходить к UI-реализации до завершения и стабилизации state/export-слоя (Phase 1) и core parity-логики (Phase 2).

