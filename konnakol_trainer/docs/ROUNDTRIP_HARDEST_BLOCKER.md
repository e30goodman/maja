# ROUNDTRIP HARDEST BLOCKER (DETAILED)

## 1) Что именно нужно получить

Цель roundtrip:
- на входе compact snapshot;
- строим MIDI;
- из MIDI восстанавливаем структуры;
- заново собираем snapshot;
- результат должен быть `MATCH`.

Ключевое требование проекта:
- anti-linkage: нельзя восстанавливать структуры копированием из входного `gridToken`;
- восстановимые части (в текущем этапе особенно `DIVS` и `cellStepMasks`) должны быть derived из MIDI-данных.

Проблема в текущем состоянии:
- timing часть стабильна (tempo/bars/syllables сходятся);
- note parity стабильна (`noteTruth` ок);
- mismatch остается в хвосте `gridToken`, где кодируются subdivision/mask секции.

---

## 2) Инварианты, которые уже выполняются

1. MIDI не "разваливается":
   - `strictMismatches = 0`,
   - `mismatches = 0`,
   - `velocityMismatches = 0`.

2. Аналитика по заголовку стабильна:
   - `bpm` корректен,
   - `inferredBars` корректен,
   - `inferredSyllables` корректен.

3. Основной остаточный дефект:
   - reconstruction `DIVS`/`cellStepMasks` не совпадает с ожидаемой структурой.

---

## 3) Почему задача реально сложная (не "просто баг")

### 3.1 Неполная наблюдаемость после экспорта
В MIDI-выводе:
- channel фактически общий (drum channel),
- lane разделяются в основном track/pitch,
- роли частично схлопываются (`taHigh -> accent` в ряде веток),
- canonicalization/merge удаляет часть исходной семантики.

Следствие: обратная задача "MIDI -> точная маска клеток" недоопределена.

### 3.2 Head-less клетки
Есть клетки, где:
- `sub0` не звучит,
- но внутренние sub-step звучат.

Если алгоритм implicitly требует head-hit (`sub0=true`) для признания masked-клетки, то он гарантированно пропускает значимую часть ожидаемых `mask != all-true`.

### 3.3 Lane interference
Если объединять lane слишком рано:
- onset из разных lane начинают "подтверждать" чужие sub-step,
- появляется ложный all-true,
- `maskCount` падает,
- версия секции может деградировать (`p4 -> p3`) или давать неверный p4 payload.

---

## 4) Что уже пробовали (и где ломалось)

1. Глобальный nearest-step по onset:
   - дает много false positive/negative.

2. Role split только по passive:
   - лучше, но недостаточно.

3. Lane-aware квантизация:
   - уменьшает шум, но не закрывает head-less полностью.

4. Asymmetric tolerance (`sub0` строже, inner шире):
   - полезно, но без корректного lane-local lattice не решает проблему.

5. Попытка structural lattice:
   - приблизила некоторые кейсы,
   - но в сложных данных still не восстанавливает нужное множество masked-клеток.

6. Derived DIVS from MIDI:
   - частично работает,
   - но на определенных паттернах восстанавливает не те клетки/не тот объем.

---

## 5) Точный симптом на уровне множеств

Сейчас критичная диагностика:
- `expectedMaskedCells` (из исходной структуры для валидации),
- `reconstructedMaskedCells` (из derived алгоритма),
- `extraMaskedCells`,
- `missingMaskedCells`.

Типичный провал:
- `reconstructedMaskedCells` значительно меньше expected,
- часто пропущены именно head-less позиции,
- иногда есть "левые" клетки, появившиеся от lane cross-talk.

Именно этот diff объясняет, почему roundtrip не может стать `MATCH`, даже если MIDI parity идеальна.

---

## 6) Что нужно добить (практический план для фикса)

### A. Lane-specific lattice как основной объект
- строить кандидаты step отдельно по lane;
- merge lane делать только на финальном этапе;
- при merge использовать устойчивый приоритет (`V1 > V2 > V3`) и не затирать уже валидированные биты.

### B. Локальная квантизация внутри клетки
- assignment onset -> step делать по локальной сетке конкретной клетки;
- не использовать глобальный баровый nearest.

### C. Строгий dedup
- ключ: `(row,col,sub,lane,roleWindow)`;
- roleWindow узкий (чтобы соседние sub-step не схлопывались).

### D. Head-less explicit policy
- разрешить существование masked-клетки без `sub0`;
- если есть внутренние подтвержденные sub-step при пустом `sub0`, клетка должна попадать в mask-set.

### E. Presence criterion for p4/mask
- `maskCount > 0` тогда и только тогда, когда существует клетка с `mask != all-true(divs)`;
- не определять p4 по "есть ли вообще hits".

### F. Tolerance policy
- `sub0`: более строгий порог;
- inner sub-step: более мягкий;
- порог масштабировать по локальному step distance.

---

## 7) Что считать "done"

1. На целевых кейсах:
   - `status = MATCH`.

2. Для `gridToken`:
   - reconstructed секция совпадает побайтно с ожидаемой.

3. Диагностика:
   - `expectedMaskedCells == reconstructedMaskedCells`,
   - `extraMaskedCells` и `missingMaskedCells` пустые.

4. Политика anti-linkage сохраняется:
   - `DIVS`/`cellStepMasks` derived из MIDI,
   - нет прямого копирования из входного token в rebuilt-структуру.

---

## 8) Почему это последний "узкий хвост"

Все крупные системы (тайминг, паритет нот, базовый реконструктор) уже в рабочем состоянии.
Оставшийся дефект — это инженерный дожим обратного вывода структурной дырявости сетки (`mask/div`) при частичной потере информации в MIDI-экспорте.

Именно поэтому задача выглядит "почти готово, но не MATCH": осталось довести mapping onset->local-step+lane так, чтобы set-level диагностика стала пустой.
