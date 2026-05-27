# Rhythm Canonical Separation

## Purpose
This document defines stable musical terms and their strict mapping to runtime logic.
All progressive/dramaturgy changes must follow this contract.

## Canonical Terms

- Jati (cycle skeleton)
  - Meaning: number of anchor pulses in the bar.
  - Program mapping: `curSyl` (row bar size / pulse count).
  - Rule: changing Jati changes cycle size, not intra-cell gait.

- Gati (intra-pulse gait)
  - Meaning: subdivision pattern inside each pulse.
  - Program mapping: `subdivisions[cell]`.
  - Rule: Gati escalation must increase intra-cell density without rewriting the cycle skeleton.

- De-sync (autonomous Jati contour)
  - Meaning: temporary local cycle independent from global ADI-8 lock.
  - Program mapping: `PhraseRole.deSyncJati=true` plus `localCycleLength`.
  - Rule: de-sync is rhythmic autonomy, not random truncation.

- Long Press Tempo
  - Meaning: Gati Prana (density drive).
  - Program mapping: progressive gati trajectory, higher subdivision pressure.
  - Rule: must not force cycle-size rewrite by itself.

- Long Press Pulse
  - Meaning: Jati Bhedam (size contour switch).
  - Program mapping: de-sync local cycle activation.
  - Rule: must produce complete local-cycle phrases.

- Karvai (`-`)
  - Meaning: musical pause with pulse ownership.
  - Program mapping: explicit pause syllable token used for timing/re-sync/bridge.
  - Rule: Karvai is valid for sam alignment and transition breathing.

- Dead-cells (`.`)
  - Meaning: structural note suppression (Chhanda truncation tool).
  - Program mapping: `deadStart` tail region.
  - Rule: dead-cells are not a substitute for sam balancing logic.

- Tihai 3x formula
  - Meaning: final formula must remain intact: `P G P G P Landing`.
  - Program mapping: tihai operator phrase content.
  - Rule: onset of first `P` is sacred and cannot be consumed by re-sync compensation.

## Separation Rules

1. Pulses vs dead-cells are different axes:
   - pulses define timing math,
   - dead-cells define structural silence inside a bar.
2. Re-sync to ADI-8 must be done by Karvai bridge before tihai onset.
3. De-sync phrases must be complete in local Jati (e.g., 5/8, 7/8), not amputated leftovers.
4. Progressive density must show phase growth (early < mid < late), not flat static behavior.
5. Logger must expose mode state and transition mechanics (gati/jati/re-sync).
# RHYTHM CANONICAL SEPARATION

## Манифест
**Приоритет системы:** `Эстетика > Математика`.

Логика должна служить музыке: драматургия, дыхание, целостность фразы и музыкальная выразительность важнее сухого «попадания в сетку», если оба условия нельзя соблюсти одновременно.

## Канон терминов и соответствий
- **Jati (скелет цикла)** -> локальный размер цикла (`curSyl`, пульсы такта).
- **Gati (внутридолевая походка)** -> плотность внутри доли (`subdivisions`, `Sub`).
- **De-sync / Jati Mode** -> временно автономный локальный Jati-контур относительно глобального ADI-8.
- **dead-cells `.`** -> инструмент Chhanda/структурной формы, не инструмент Jati Bhedam.
- **Karvai `-`** -> музыкальная пауза (дыхание, подготовка перехода, re-sync буфер).
- **Tihai / Muktayi 3x** -> священный блок `P G P G P Landing`, onset первого `P` неприкосновенен.

## Обязательные инварианты Progressive

### 1) Живой Gati Flow (обязательный рост плотности)
- Запрещено держать `Sub` статичным весь урок.
- Целевая траектория эскалации: `4 -> 6 -> 8` (фазово, к поздним тактам).
- К 24-му такту система обязана выйти минимум в `Sub: 6`; при устойчивом темпе и NPS допускается `Sub: 8`.
- Если рост не достигнут к late-phase, scheduler обязан форсировать density-операторы до достижения порога.

### 2) Смена Kalam при высокой скорости
- При `NPS > 8.0` автоматически переключать словарь на fast-слоги (`Ju Nu` как приоритетный набор).
- Медленные наборы (`Dhi Mi`) при этих значениях NPS не должны оставаться доминирующим словарем.

### 3) Jati Bhedam без ампутаций
- В `Jati Mode (De-sync)` запрещено обрезать фразы dead-cells `.`.
- При смене размера (например, `8 -> 5`) выбирать новый **цельный** Jati-паттерн из словаря (например, `Ta Ka Ta Ki Ta`).
- Для De-sync допустимы только завершенные музыкальные формы (включая Khanda, Mishra), а не «хвосты» старого паттерна.

### 4) Священная зона Tihai
- Ввести отдельную роль `resync_bridge` строго **до** блока `3x`.
- `resync_bridge` не имеет права модифицировать начало первой фразы Tihai.
- Весь pulse-offset должен быть погашен до старта Tihai.
- Если требуется, вставлять внешний буфер полного `Karvai`-такта перед `3x`, чтобы вход происходил «с единицы».

### 5) Дыхание и подготовка переходов
- За 1 такт до смены `Gati` или `Jati` принудительно ставить акценты на сильных долях (transition signal).
- Перед входом/выходом De-sync и перед Tihai разрешена микро-подготовка (`micro_pause`, accent pickup), если она не разрушает базовый пульс.
- Финальный акцентированный `Thom` обязателен как завершающая печать формы.

## Правила для реализации
- Нельзя «чинить математику» ценой разрушения музыкальной фразы.
- Нельзя менять Tihai onset для компенсации offset.
- Нельзя использовать dead-cells как основной способ Jati Bhedam.
- Разрешается добавлять Karvai-буфер и prep-акценты для музыкальной ясности переходов.

## Минимальные критерии приемки
- В логе фиксируется фазовый рост `Sub` без полной стагнации.
- При `NPS > 8.0` отражается переход в fast-словарь (`Ju Nu`).
- В De-sync используются цельные паттерны (Khanda/Mishra), без ампутации `.`.
- Роль `resync_bridge` существует отдельно и выравнивает offset до Tihai.
- Первый слог первой фразы Tihai всегда сохранен.
- Перед крупными переключениями есть акцентная подготовка; финальный `Thom` присутствует.
