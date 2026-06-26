# Логика саунд-движка (актуально)

Док описывает фактический аудио-путь в `konnakol_trainer` по состоянию текущего кода:

- `src/App.tsx` (оркестрация, scheduler, запуск хитов)
- `src/metroLayerGraph.ts` (DSP слоя)
- `src/metroSoundBus.ts` (per-voice bus)
- `src/metraAudioBus.ts` (master path + scheduler profiles)

## 1) Где стартует звук

- Основной рендер клика: `playSharpClick(...)` в `src/App.tsx`.
- Спец-ветка сильной первой доли: `playBarFirstHighClick(...)` в `src/App.tsx`.
- Низкоуровневая отрисовка одного слоя: `scheduleLayerToBus(...)` в `src/metroLayerGraph.ts`.

Принцип: scheduler решает "когда и какой голос", `playSharpClick` решает "какие слои и с какими gain", `scheduleLayerToBus` строит WebAudio-граф.

## 2) Источник пресетов и роль слоёв

- База звуков: `CLICK_SOUND_LIBRARY` в `App.tsx`.
- Источник слоев на голос:
  - либо `cfg.layers` (если у пресета есть новый формат),
  - либо `buildLegacyVoiceLayers(cfg)` (legacy-совместимость).
- Голоса: `accent`, `alt`, `passive`.
- На каждый слой перед рендером:
  - `mute/solo` фильтрация,
  - volume gate `CLICK_LAYER_VOLUME_GATE`,
  - clamp decay в диапазон `CLICK_DECAY_MIN_SEC..CLICK_DECAY_MAX_SEC`,
  - итоговый множитель громкости (`voiceGainMul` + режимная поправка `accentOnlyPlayback`).

## 3) Layer DSP (реальный граф)

Реализовано в `scheduleLayerToBus(...)`.

### 3.1 Tone-слой (`OscillatorType`)

Граф:

`osc -> gain(AD envelope) -> layerHp -> layerLp -> summingInput`

Детали:

- старт осциллятора: `scheduleTime + jitter`, где `jitter <= 0.002s`;
- при `sweep=true` частота уходит экспоненциально к `max(10, freq*0.1)`;
- envelope:
  - attack `METRO_LAYER_ATTACK_SEC = 0.002`,
  - decay экспоненциально до `metroEnvelopeEndFromPeak(peak) = max(1e-5, peak*0.001)`.
- lifecycle cleanup:
  - `osc.onended` выполняет teardown (`disconnect`) для `osc/gain/layerHp/layerLp`;
  - cleanup idempotent (локальный `cleaned` флаг), чтобы исключить double-disconnect.

### 3.2 Noise-слой (`type === 'noise'`)

Граф:

`bufferSource(shared deterministic noise) -> noiseFilter -> noiseGain(AD) -> layerHp -> layerLp -> summingInput`

Детали:

- шум берется из `WeakMap<AudioContext, AudioBuffer>` (общий буфер на контекст);
- буфер заполняется детерминированно (`fillChannelDeterministicWhiteNoise`);
- peak для noise: `nVol = peakLinear * 0.5`.
- lifecycle cleanup:
  - `noiseSrc.onended` выполняет teardown (`disconnect`) для `noiseSrc/noiseFilter/noiseGain/layerHp/layerLp`;
  - cleanup idempotent (локальный `cleaned` флаг).

## 4) Voice buses (групповая обработка по голосам)

Реализовано в `src/metroSoundBus.ts`.

Цепь на каждый голос:

`layerSum -> groupHp -> groupLp -> groupDelay -> groupMaster -> metronome summing input`

Параметры:

- HP clamp снизу до `20 Hz`;
- LP задается напрямую (по текущему коду с нижним clamp `20 Hz`);
- `groupMaster.gain` clamp `0..4`;
- micro-delay:
  - `accent = 0`,
  - `alt = 0.00045`,
  - `passive = 0.0009`.

Назначение micro-delay: уменьшить риск моно-канселляции при плотных совпадениях голосов.

## 5) Master bus (финальный путь в output)

Реализовано в `src/metraAudioBus.ts`.

Цепь:

`summing(gain=0.85) -> DynamicsCompressor(masterLimiter) -> ctx.destination`

Лимитер (peak-limiter стиль):

- `threshold = -0.1`
- `knee = 0`
- `ratio = 10`
- `attack = 0.003`
- `release = 0.05`

`getMetronomeSummingInput(ctx)` создает эту цепь лениво и кеширует на `WeakMap` по `AudioContext`.

## 6) Scheduler: актуальные профили и recovery

Профили (`metraAudioBus.ts`):

- `safe`: `lookaheadMs=20`, `scheduleAheadSec=0.5`
- `balanced`: `lookaheadMs=25`, `scheduleAheadSec=0.35`
- `aggressive`: `lookaheadMs=16`, `scheduleAheadSec=0.25`

В `App.tsx` дефолт сейчас: `DEFAULT_SCHEDULER_PROFILE = 'safe'`.

Recovery-поведение scheduler:

- детект long stall по gap тиков;
- hard resync `nextTime`/`nextNoteTime`;
- ограничение catch-up (`maxCatchUpBatchesPerTick`, `maxCatchUpLagSec`);
- post-stall cooldown с форсом `safe` профиля;
- эскалация в `safe`, если подряд несколько recoveries.

## 7) Как это поднимается в рантайме

При play/preview:

1. Создается (или пересоздается) `AudioContext`.
2. Инициализируются voice buses (`getVoiceLayerSumInput`).
3. Применяются group-параметры (`applyVoiceGroupChain`).
4. Scheduler вызывает `scheduleGridCellAtTime(...)`.
5. На событии grid-cell вызывается `playSharpClick(...)` / `playBarFirstHighClick(...)`.

Отдельно: в `playTwoBarsPreviewFromGrid(...)` перед предпрослушкой контекст принудительно пересоздается и шины/параметры заново "бутстрапятся".

## 8) Ветка сильной доли (`playBarFirstHighClick`)

- **Classic / Oldschool**: осциллятор → gain (envelope) → hp → lp → `getTaAccentParallelInput`.
- **Drum machine** (`drum_machine`): предзаписанный accent-буфер → blend envelope → Ta parallel → accent bus.
- Для остальных пресетов без отдельной Ta-ветки: делегирование в `playSharpClick(..., voiceRole='accent')` через Ta parallel input.

## 9) Anti-artifact механики (текущее)

- Start guard (hybrid): `0.001s` в normal, `0.004s` в degraded/cooldown.
- Anti-burst spacing по голосам через `lastScheduledVoiceTimeByContext`.
- Усиленный spacing для `passive` и post-stall cooldown на Chrome desktop.
- Jitter старта tone-осцилляторов до `2 ms` для снижения фазового складывания.
- Shared deterministic noise buffer (без рандом-дрейфа между вызовами).
- Все persistent audio-структуры держатся в `WeakMap<AudioContext,...>` (без ручного глобального singleton-state).

### 9.1) Hybrid guard decision matrix

Назначение: защитить от pop/burst после лагов scheduler, но не ломать фазовую сетку в нормальном режиме.

- `nextNoteTimeRef` остается source-of-truth для ритмической сетки (`60 / BPM`) и guard его не модифицирует.
- Guard применяется только локально к времени старта события перед `start()`/`setValueAtTime()`.
- Режим `normal`:
  - условие: `catchUpBatches === 0` и нет recovery в текущем тике;
  - guard: `+0.001s` (минимальный DC/pop safety floor).
- Режим `degraded`:
  - условие: `recoveredThisTick === true` ИЛИ post-stall cooldown ИЛИ `catchUpBatches > 0`;
  - guard: `+0.004s` (агрессивная защита огибающих от схлопывания и цифрового треска).
- Политика переключения строго бинарная (`1ms`/`4ms`), без пропорционального масштаба по нагрузке CPU.
- `playSharpClick(...)` и `playBarFirstHighClick(...)` должны использовать одинаковую guard-логику `1:1`, иначе первая доля смещается относительно остальной сетки.

Почему это нельзя "упрощать":

- удаление degraded-ветки возвращает артефакты в catch-up/stall сценариях;
- постоянный `4ms` guard без режима ухудшает ритмическую точность в нормальном ходе;
- пропорциональный guard делает тайминг плавающим и субъективно "ломает грув".

## 10) Что считать source-of-truth

- Актуальный runtime-код: `src/App.tsx`, `src/metraAudioBus.ts`, `src/metroSoundBus.ts`, `src/metroLayerGraph.ts`.
- Калибровка пресетов: `src/soundPresetCalibration.ts`, `src/SoundPresetCalibrationPanel.tsx` — см. [SOUND_PRESET_CALIBRATION.md](./SOUND_PRESET_CALIBRATION.md).
- Файлы `src/App_saved.tsx` и `src/app_reserv.txt` не являются runtime source-of-truth.

## 11) Parallel limiter (voice buses + Accent Ta)

Реализовано в `src/parallelBusChain.ts`, `src/metroSoundBus.ts`, `src/taAccentParallel.ts`.

### 11.1 Voice buses (passive / alt)

Цепь на сумматоре каждого голоса:

`layerSum -> [parallel dry/wet limiter] -> groupHp -> groupLp -> ...`

- Общий baked default: `BAKED_VOICE_PARALLEL_LIMITER` (`parallelBusChain.ts`).
- Per-preset override только если слой сохранён в calibration store или baked (classic passive).
- Wet масштабируется fader-ом пресета: `wetMix = settings.volume * busFaderLinear`.

Синхронизация при смене пресета / калибровки: `syncVoiceBusParallelWet()` в `App.tsx`.

### 11.2 Accent Ta (отдельная цепь)

`playBarFirstHighClick` → `getTaAccentParallelInput(ctx, preset)` → parallel chain → accent voice bus.

- **Classic / Oldschool**: осциллятор + envelope.
- **Drum machine** (`drum_machine`): предрендеренный буфер accent-слоёв (`renderTaDrumMachineBuffer`), онсет в буфере 6 ms (`DRUM_MACHINE_TA_SAMPLE_ONSET_SEC`).

Baked Ta parallel: classic — Punch; drum machine — Tight / wet 60%.

## 12) Envelope gate (calibration)

Реализовано в `clickTailEnvelope.ts`, подключается из `playSharpClick` / `playBarFirstHighClick` через `getActiveCalibrationEnvelope()`.

Принципы:

- **Mix 0** — нативный decay слоя (без gate).
- **Mix 1** — полный gate; между 0 и 1 — dry/wet blend (два параллельных пути).
- **Fade in** — длительность подъёма gain до пика (не EQ).
- **Decay** — спад после пика (осцилляторы); для **sample Drum machine Ta** — спад после пика с выравниванием fade-in по онсету сэмпла.
- **Out** — makeup gain на wet-ветке.

Baked без user store:

- classic **passive** — envelope + parallel зашиты;
- classic **ta** — tail envelope + parallel;
- остальные пресеты — нативный звук, пока пользователь не поднимет Mix в calibration.

Подробности UI и включение панели: [SOUND_PRESET_CALIBRATION.md](./SOUND_PRESET_CALIBRATION.md).

## 13) Dev calibration panel (скрыта по умолчанию)

Панель **не удалена**, скрыта флагом в `App.tsx`:

```ts
const SHOW_SOUND_PRESET_CALIBRATION_PANEL = false;
```

Инструкция включения: [SOUND_PRESET_CALIBRATION.md](./SOUND_PRESET_CALIBRATION.md).
