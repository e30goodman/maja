# Логика саунд-движка (генерация -> mix bus -> output)

Этот файл фиксирует реальный путь сигнала в `konnakol_trainer` от генерации клика до выхода в `AudioContext.destination`.

## 1) Точки входа генерации

- Основной рендер клика: `playSharpClick(...)` в `src/App.tsx`.
- Дополнительный акцент первой доли: `playBarFirstHighClick(...)` в `src/App.tsx`.
- Низкоуровневый рендер одного слоя: `scheduleLayerToBus(...)` в `src/metroLayerGraph.ts`.

## 2) Источник пресета и слоев

- Пресет берется из `CLICK_SOUND_LIBRARY` (в т.ч. через legacy-конверсию в слои).
- Для каждой роли голоса используется отдельный слой-набор:
  - `accent`
  - `alt`
  - `passive`
- Для каждого слоя применяются:
  - `mute/solo` логика
  - volume gate (`CLICK_LAYER_VOLUME_GATE`)
  - clamp decay (`CLICK_DECAY_MIN_SEC..CLICK_DECAY_MAX_SEC`)
  - роль/режимный gain-множитель (`voiceGainMul`, `accentOnlyPlayback` поправка)

## 3) Генерация слоя (Layer DSP)

Реализовано в `scheduleLayerToBus(...)`:

### Tone-слой (`OscillatorType`)

1. `OscillatorNode` создается с `type` и `frequency`.
2. Опционально sweep: экспоненциальный спуск частоты к `freq * 0.1`.
3. Envelope на `GainNode`:
   - `0 -> peak` линейно за `METRO_LAYER_ATTACK_SEC` (0.002s)
   - `peak -> end` экспоненциально до `max(1e-5, peak*0.001)`
4. Пост-фильтры слоя:
   - `Highpass (hpFreq)`
   - `Lowpass (lpFreq)`
5. Выход слоя идет в вход voice bus (`summingInput`).

### Noise-слой (`type === "noise"`)

1. `AudioBufferSourceNode` получает детерминированный белый шум из shared buffer (`WeakMap` на контекст).
2. Character filter (`noiseFilterType`, freq = `params.freq`).
3. Envelope на `noiseGain`:
   - `0 -> nVol` (`peakLinear * 0.5`)
   - `nVol -> nEndVol` экспоненциально
4. Далее тот же слойный post-chain:
   - `HP -> LP -> summingInput`.

## 4) Voice bus (per-voice group chain)

Реализовано в `src/metroSoundBus.ts`. Для каждой роли (`accent/alt/passive`) создается отдельная шина:

`layerSum -> groupHp -> groupLp -> groupDelay -> groupMaster -> metronome summing input`

Параметры:

- `groupHp.frequency` (снизу clamp до 20 Hz).
- `groupLp.frequency` (снизу clamp до 20 Hz).
- `groupDelay.delayTime`:
  - `accent = 0`
  - `alt = 0.00045`
  - `passive = 0.0009`
- `groupMaster.gain` clamp `0..4`.

Назначение micro-delay: снизить риск моно-канселляции между голосами при сохранении тайминга.

## 5) Metronome mix bus (master path)

Реализовано в `src/metraAudioBus.ts`.

Master chain на контекст:

`summing (Gain=0.85) -> masterLimiter (DynamicsCompressor) -> ctx.destination`

Лимитер (peak-limiter поведение через `DynamicsCompressor`):

- `threshold = -0.1 dB`
- `knee = 0`
- `ratio = 10`
- `attack = 0.003 s`
- `release = 0.05 s`

Итог: все voice buses линейно суммируются в `summing`, затем проходят мастер-лимитер и выходят в `destination`.

## 6) Где это подключается в рантайме

В `App.tsx` при старте/preview:

1. Создается/резюмится `AudioContext`.
2. Для каждого voice (`accent/alt/passive`) дергается `getVoiceLayerSumInput(ctx, v)`.
3. На те же voice шины накатываются group-параметры через `applyVoiceGroupChain(...)`.
4. Планировщик вызывает `scheduleGridCellAtTime(...)`, оттуда идет вызов `playSharpClick(...)`.
5. `playSharpClick(...)` раскладывает hit на слои и каждый слой отправляет в `scheduleLayerToBus(...)`.

## 7) Отдельная ветка первой доли

`playBarFirstHighClick(...)`:

- Для `classic` и `oldschool` строит локальный граф напрямую:
  - `osc -> gain -> hp -> lp -> masterIn`
- `masterIn` берется из `getMetronomeSummingInput(ctx)`, то есть все равно попадает в общий metronome mix bus и limiter.
- Для остальных пресетов делегирует в `playSharpClick(..., voiceRole="accent")`.

## 8) Анти-артефакты и устойчивость

- Start guard: `t0 >= ctx.currentTime + AUDIO_START_GUARD_SEC`.
- Anti-burst spacing per voice в `playSharpClick`: предотвращает совпадение множества late events в один timestamp.
- Anti-phase jitter для tone-слоев: `osc.start(scheduleTime + random(0..0.002s))`, чтобы осцилляторы не складывались в одинаковую фазу каждый hit.
- Shared deterministic noise buffer: стабильный шум без случайного дрейфа от вызова к вызову.
- `WeakMap` по `AudioContext` во всех шинах/буферах: корректная изоляция инстансов и cleanup через GC после закрытия контекста.
