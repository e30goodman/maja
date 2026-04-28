# Aesthetic Debug Handbook — parent progressive (Konnakol)

Краткий мануал для слуха **и** для CI: каждая глава заканчивается блоком **Техспека** (измеримые критерии). Операционная таблица ассертов: [`DEBUG_CHECKLIST.md`](./DEBUG_CHECKLIST.md).

---

## 1. Две оси: время `t` и интенсивность `i`

**Сутра:** слушатель воспринимает дугу урока (введение → напряжение → разрешение) и отдельно — «насколько плотно/остро сейчас звучит материал». Смешивать эти шкалы в одном предложении без подписи нельзя.

**Техспека**

| Ось | Диапазон | Где в коде / логе |
|-----|----------|-------------------|
| **t** — нормализованное время сегмента | ≈ индекс такта в логе / (число тактов − 1) | `aestheticDiagnostics.progressT`, строка лога `t≈…` |
| **i** — интенсивность пресета | `intensityTarget` ∈ [0,1], для progressive старт около **i₀≈0.5**, рост к хвосту | `progressiveIntensityTarget` в `parentMode.ts`, в логе `Intensity(i):` |

Начальное **i₀≈0.5** трактуется как нейтральный фонетический профиль; кульминация по **t** подтягивает «металлический» хвост и плотность.

---

## 2. Prasa: PrasaMaxEdit и потолок 50% anchor

**Сутра:** вариации должны удерживать узнаваемость «родительской фразы» внутри блока; иначе progressive превращается в шум.

**Техспека**

- **PrasaMaxEdit:** для пресета `progressive` верхняя граница намеренных расхождений по классу токена — **2** (профиль yati: **1**). Задаётся в `buildPhraseSchedule` → `role.prasaMaxEditDistance`.
- **50% rule:** пусть **N** — число живых слогов опорного такта фразы (anchor = первый такт с данным `phraseId`). Тогда допустимое число позиций, отличающихся от anchor, ≤ **⌊N/2⌋**. В рантайме: `applyPrasaContinuity` (сравнение с `barIdx - phraseStep`).
- **Лог / CI:** `prasaAnchor` в `aestheticDiagnostics`, флаг `prasaContinuity` (anchor + мягкий лимит от темы parent по фазе).

---

## 3. Thom, Guru/Laghu, финал Sam

**Сутра:** `Thom` — гравитация к кадансу и к Sam; не должен «текать» по слабым долям как бас-гитара в поп-аранжировке.

**Техспека**

- `enforceThomRule` + `scrubInternalThom`: только landing tihai, Arudi-закрытие, акцентированные контексты по правилам в коде.
- **Muktayi / Sam:** последний значимый слог: `globalPulse % 8 === 7`, акцент, Ta или Thom; tihai landing пишет **Thom** на расчётном индексе. См. `computeMuktayiCheck`.

---

## 4. Karvai, Pulse Shift, Jati

**Сутра:** смена размера цикла (4→5/7/9) требует слышимого вдоха.

**Техспека**

- Перед de-sync: роль `resync_bridge` с `bridgeKind: 'de_sync_prep'`, физически **≥ 4** пульса тишины (`Math.max(4, curSyl)` при применении). См. `ASSERT_KARVAI_JATI` в чеклисте.
- В логе: маркер `[Pulse Shift]` на первом такте contiguous-группы с `deSyncJati`.

---

## 5. Arudi и пакеты `subdivs > 1`

**Сутра:** локальная мини-фраза в одной клетке — один жест; ударная входная точка должна совпадать с метрическим входом пакета.

**Техспека**

- `ensureSubdivPackStrongEntrance`: для каждой клетки с `subdivisions[c] > 1` в множество акцентов добавляется индекс **c** (первая поддоля).
- Маркер `[Arudi]` в логе связан с `arudiReason` (каданс фразы / симметрия).

---

## 6. SCS (Syllable Continuity Score)

**Сутра:** «грязь» сетки — не субъективный вкус, а нарушение обхода индекса.

**Техспека**

- `evaluateSequenceContinuity` → в JSON дублируется как `syllableContinuity` (тот же объект, что `sequenceCheck`).
- Маркеры в тексте: `[SEQ_OK]` / `[SEQ_FAIL: Jump Detected]`.

---

## 7. Varna / Laya (рантайм + пост-аудит)

**Сутра:** перекат согласных и «походка» нечётного jati — дыхание, не стена.

**Техспека**

- **Varna (рантайм):** `softenPhoneticHardJunctions` после сильных долей / палитры — снижает пары hard-hard при умеренном **i** (не трогает зону кульминации **i ≥ 0.86**).
- **Varna (лог):** `phoneticJunctions`, флаг `varnaPhoneticFlow`.
- **Laya:** `layaWalk`, флаг `layaGatiCharacter` (odd jati + плотность + `subdivAir`).

---

## 8. Eduppu, Shadowing, Poetry-index

**Сутра:** Eduppu — отрицательное пространство и «лифт» входа; shadowing — закон тени после тяжёлого destabilization.

**Техспека**

- **Eduppu:** `eduppu` в диагностиках, флаг `eduppuEntry`, сводка `summary.poetry.eduppuLesson`.
- **Shadowing:** флаг `shadowingBreath`, счётчик `stackedComplexDestabilPairs` в `poetry`.
- **Poetry-index:** `summary.poetry.poetryIndex` (0..1) и русский `poetryVerdict`.

---

## 9. Быстрый обзор файлов

| Файл | Назначение |
|------|------------|
| `src/parentMode.ts` | Расписание, Prasa/Thom/subdiv/Varna-runtime, de-sync prep |
| `src/lessonLogger.ts` | Сборка лога, диагностики, poetry, экспорт `evaluateAestheticDiagnostics` |
| `logs/DEBUG_CHECKLIST.md` | Таблица Check ID ↔ условия |

---

## 10. Syllable Assembly контракт (строгая трассировка)

**Сутра:** эстетические флаги недостаточны, если не видно, как именно собиралась слоговая сетка. Для строгой верификации нужны трассы нормализации `subdivs`, dead-tail и phraseLen-политики.

**Техспека**

- `bars[].syllableAssembly.subdivNormalization`:
  - `normalizedValues` всегда в диапазоне `1..9`;
  - `criteria.normalizationContractOk === true`.
- `bars[].syllableAssembly.deadTail`:
  - `clampedDeadStart` в `0..rowSyllCount`;
  - `tailSilentByDot === true`;
  - `criteria.deadTailContractOk === true`.
- `bars[].syllableAssembly.phraseLenPolicy`:
  - `segmentRanges` фиксирует contiguous-блоки `subdivs==1`;
  - `longSegments` фиксирует сегменты `>9` (composeLongBar-кандидаты).
- `bars[].syllableAssembly.npsKalamBootstrap.cells[]`:
  - для каждой живой клетки есть `phraseLen`, `source` (`local_subdiv` / `sarva_segment`), `nps`, `kalam`;
  - `criteria.segmentContractOk === true` означает полное покрытие живой зоны.

---

## 11. Aesthetic Criteria for Tihai (закон формы и удара)

**Сутра:** Tihai в хвосте (обычно такты 27-32 в 32-тактовой progressive форме) обязан звучать как музыкальная триада, а не как сухая математика.

**Техспека**

### 11.1 Triple Identity (Закон Трех)

- Проверяется блок `tihai`-фразы в хвостовом окне (для формы 32 такта: 27-32).
- Первый, второй и третий повтор формулы должны быть идентичны по слоговой последовательности после нормализации пауз.
- Любая внутренняя мутация формулы между повторами = критическая ошибка `TIHAI_MORPH_ERROR`.

### 11.2 Equidistant Gaps (Равные паузы)

- Если между тремя повторами есть gap-окна (`-`, `—`, `.`), их длины должны быть строго равны.
- Проверка выполняется по `pulseOffsetBeforeBar` и/или по фактической длине пауз в слоговом массиве.
- Любая разница длины gap-окон = `TIHAI_GEOMETRY_FAIL`.

### 11.3 The Final Impact (Сила приземления)

- Последний значимый слог финального повтора обязан быть `Thom` или `Ta` и иметь `accent: true`.
- `Muktayi-check` обязан вернуть `PASS`.
- Финальное попадание: `globalPulse % 8 == 7`.
- Нарушение любого пункта = `WEAK_ENDING` (критичность повышается до fail при одновременном падении muktayi).

### 11.4 Varna Integrity (Фонетическая чистота)

- Избегать "пулеметного" потока (`ta-ta-ta-ta`) в tihai-хвосте.
- Использовать диагностику `VARNA_HARSH_FLOW` из этого handbook/lesson diagnostics.
- Если число жестких согласных стыков > 3, понижается эстетическая оценка (штраф по score, даже при формально корректной геометрии).

### 11.5 Parental Link (Связь с корнями)

- Tihai-фраза не должна рвать связь с parent-темой.
- Ограничение: `PrasaMaxEdit <= 2` относительно родительского anchor-паттерна даже при высокой интенсивности.
- Превышение лимита = `PRASA_PARENT_BREAK`.

### 11.6 Output Contract (обязательный формат отчета)

- В каждом tihai-аудите выводить:
  - `Aesthetic Score: <0..100>`
  - `Critical Errors: <список кодов/причин>` (например: `TIHAI_MORPH_ERROR`, `TIHAI_GEOMETRY_FAIL`, `WEAK_ENDING`, `PRASA_PARENT_BREAK`)
  - `Verdict: Музыка | Расчет`
- Правило вердикта:
  - `Музыка` допускается только если нет критических ошибок формы/посадки и muktayi = `PASS`.
  - Иначе вердикт = `Расчет`.
