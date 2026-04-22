// ==============================================================================
// ВНИМАНИЕ ДЛЯ ИИ АГЕНТА: НЕ ВЛЕЗАТЬ - УБЬЁТ НАХУЙ!
// ==============================================================================
// ЭТА СТРУКТУРА ЗВУКОВ ЗАХАРДКОЖЕНА И ОТТЕСТИРОВАНА.
// В НЕЙ РЕАЛИЗОВАН СТРОГИЙ 3-Х ГОЛОСНЫЙ ПАТТЕРН МЕТРОНОМА:
// 
// ЗАПРЕЩЕНО МЕНЯТЬ ПОЛЯ baseFreq, accentFreq И altFreq. ЗАПРЕЩЕНО МЕНЯТЬ ФОРМАТ.
// ==============================================================================

export type SoundConfig = {
  id: string;
  name: string;
  description: string;
  oscType?: OscillatorType;
  baseFreq: number;
  accentFreq: number;
  altFreq: number;
  decay: number;
  decayAccent?: number;
  decayAlt?: number;
  sweep?: boolean;
  noise?: boolean;
  noiseType?: BiquadFilterType;
  noiseFreq?: number;
  noiseFreqAccent?: number;
  altNoiseFreq?: number;
  volume: number;
  volumeAccent?: number;
  volumeAlt?: number;
};

export type LayerToneType = OscillatorType | "noise" | "none";
export type LayerConfig = {
  type: LayerToneType;
  sweep: boolean;
  noiseFilterType: BiquadFilterType;
  params: {
    volume: number;
    decay: number;
    freq: number;
    hpFreq: number;
    lpFreq: number;
  };
  mute?: boolean;
  solo?: boolean;
};

export type LayeredSoundConfig = {
  id: string;
  name: string;
  description: string;
  accent: [LayerConfig, LayerConfig, LayerConfig];
  alt: [LayerConfig, LayerConfig, LayerConfig];
  passive: [LayerConfig, LayerConfig, LayerConfig];
};

// ==============================================================================
// ДАЛЕЕ ИДЕТ СПИСОК ИЗ 20 ЗВУКОВ. НЕ ТРОГАТЬ ИХ ПАРАМЕТРЫ! НЕ УДАЛЯТЬ НИ ОДИН!
// ==============================================================================
export const MOVEMENT_SOUNDS: SoundConfig[] = [
  {
    id: "classic-digital",
    name: "Standard",
    description: "Classic steady digital beep (Sine)",
    oscType: "sine",
    baseFreq: 1000,
    accentFreq: 1500,
    altFreq: 1250,
    decay: 0.03,
    decayAccent: 0.03,
    decayAlt: 0.03,
    volume: 0.35,
    volumeAccent: 1.5,
    volumeAlt: 1.2,
  },
  {
    id: "ableton-style",
    name: "Modern DAW",
    description: "Short impulse in the style of modern sequencers",
    oscType: "sine",
    baseFreq: 1500,
    accentFreq: 3840,
    altFreq: 2840,
    decay: 0.015,
    sweep: true,
    volume: 0.9,
    volumeAccent: 1.2,
    volumeAlt: 1.1,
  },
  {
    id: "woodblock",
    name: "Woodblock",
    description: "Soft, percussive wooden sound",
    oscType: "triangle",
    baseFreq: 600,
    accentFreq: 800,
    altFreq: 700,
    decay: 0.05,
    volume: 1.5,
  },
  {
    id: "fl-tick",
    name: "Punchy",
    description: "Tight, punchy click with sharp attack",
    oscType: "sine",
    baseFreq: 500,
    accentFreq: 1000,
    altFreq: 750,
    decay: 0.05,
    sweep: true,
    volume: 1.5,
  },
  {
    id: "sharp-digital",
    name: "Sharp Digital",
    description: "Noticeable square impulse in any mix",
    oscType: "square",
    baseFreq: 800,
    accentFreq: 1200,
    altFreq: 1000,
    decay: 0.02,
    volume: 0.6,
  },
  {
    id: "deep-ping",
    name: "Deep Sub",
    description: "Low-frequency dull hit, easy on the ears",
    oscType: "sine",
    baseFreq: 300,
    accentFreq: 400,
    altFreq: 350,
    decay: 0.06,
    volume: 1.5,
  },
  {
    id: "laser-snap",
    name: "Laser Snap",
    description: "Sharp frequency drop creates a 'pew' effect",
    oscType: "sawtooth",
    baseFreq: 1000,
    accentFreq: 2000,
    altFreq: 1500,
    decay: 0.03,
    sweep: true,
    volume: 0.5,
  },
  {
    id: "closed-hat",
    name: "Hi-Hat",
    description: "Short high-frequency noise click",
    baseFreq: 0,
    accentFreq: 0,
    altFreq: 0,
    decay: 0.041,
    decayAlt: 0.065,
    decayAccent: 0.081,
    noise: true,
    noiseType: "highpass",
    noiseFreq: 5600,
    altNoiseFreq: 5200,
    volume: 0.7,
    volumeAccent: 2.5,
    volumeAlt: 1.7,
  },
  {
    id: "glass-drop",
    name: "Glass Drop",
    description: "High, clear and short ring",
    oscType: "sine",
    baseFreq: 2500,
    accentFreq: 3500,
    altFreq: 3000,
    decay: 0.04,
    volume: 0.8,
  },
  {
    id: "plastic-knock",
    name: "Plastic Knock",
    description: "Short knock on hard plastic",
    oscType: "triangle",
    baseFreq: 400,
    accentFreq: 1000,
    altFreq: 880,
    decay: 0.025,
    decayAlt: 0.025,
    sweep: true,
    volume: 0.8,
    volumeAccent: 2.3,
    volumeAlt: 1.7,
  },
  {
    id: "metallic-tick",
    name: "Metallic",
    description: "Mix of short hum and high frequencies",
    oscType: "square",
    baseFreq: 1500,
    accentFreq: 2500,
    altFreq: 2000,
    decay: 0.015,
    noise: true,
    noiseType: "highpass",
    noiseFreq: 4000,
    altNoiseFreq: 5000,
    volume: 0.4,
  },
  // ====================================================================================
  // TODO НИЖЕ: ДВА ПРЕСЕТА ДЛЯ ВАШЕГО МЕТРОНОМА.
  // ЭТО ЗАГЛУШКИ: ИХ НАДО БУДЕТ ЗАМЕНИТЬ НА ВАШИ ЗВУКИ (REPLACE WITH YOUR SOUNDS) ПРИ ИНТЕГРАЦИИ.
  // ====================================================================================
  {
    id: "classic",
    name: "Classic",
    description: "Reserved for your built-in classic metronome",
    oscType: "sine",
    baseFreq: 1000,
    accentFreq: 1500,
    altFreq: 1250,
    decay: 0.05,
    volume: 0, // Muted placeholder
  },
  {
    id: "old-school",
    name: "Old School",
    description: "Reserved for your built-in old school metronome",
    oscType: "sine",
    baseFreq: 800,
    accentFreq: 1200,
    altFreq: 1000,
    decay: 0.05,
    volume: 0, // Muted placeholder
  },
  // ====================================================================================
  {
    id: "clock-tick",
    name: "Clock Tick",
    description: "Dry mechanical second knock",
    baseFreq: 0,
    accentFreq: 0,
    altFreq: 0,
    decay: 0.01,
    decayAlt: 0.017,
    noise: true,
    noiseType: "highpass",
    noiseFreq: 2500,
    noiseFreqAccent: 4800,
    altNoiseFreq: 3700,
    volume: 0.5,
    volumeAccent: 2.2,
    volumeAlt: 1.7,
  },
  {
    id: "cowbell",
    name: "Cowbell",
    description: "Imitation of a cowbell sound",
    oscType: "square",
    baseFreq: 540,
    accentFreq: 800,
    altFreq: 670,
    decay: 0.08,
    volume: 0.3,
  },
  {
    id: "analog-synth",
    name: "Analog Synth",
    description: "Warm sawtooth tone of old synthesizers",
    oscType: "sawtooth",
    baseFreq: 500,
    accentFreq: 800,
    altFreq: 650,
    decay: 0.04,
    volume: 0.5,
  },
  {
    id: "vinyl-crackle",
    name: "Vinyl Crackle",
    description: "Soft mid-frequency noise impulse",
    baseFreq: 0,
    accentFreq: 0,
    altFreq: 0,
    decay: 0.04,
    noise: true,
    noiseType: "bandpass",
    noiseFreq: 3900,
    noiseFreqAccent: 6000,
    altNoiseFreq: 5500,
    volume: 0.4,
    volumeAccent: 2.2,
    volumeAlt: 1.6,
  },
  {
    id: "dry-click",
    name: "Dry Click",
    description: "Extremely short digital signal",
    oscType: "square",
    baseFreq: 1200,
    accentFreq: 1600,
    altFreq: 1400,
    decay: 0.008,
    volume: 0.5,
    volumeAccent: 1.2,
    volumeAlt: 1.1,
  },
  {
    id: "crystal-ping",
    name: "Soft Ping",
    description: "Gentle, harmonic tone pleasant to the ear",
    oscType: "sine",
    baseFreq: 700,
    accentFreq: 900,
    altFreq: 800,
    decay: 0.1,
    volume: 1.2,
  },
  {
    id: "noise-burst",
    name: "Noise Burst",
    description: "Aggressive digital noise for drummers",
    baseFreq: 0,
    accentFreq: 0,
    altFreq: 0,
    decay: 0.05,
    noise: true,
    noiseType: "lowpass",
    noiseFreq: 5000,
    noiseFreqAccent: 7500,
    altNoiseFreq: 6300,
    volume: 0.3,
    volumeAccent: 1.6,
    volumeAlt: 1.1,
  },
  {
    id: "8-bit",
    name: "8-Bit",
    description: "Lo-fi retro arcade sound",
    oscType: "square",
    baseFreq: 440,
    accentFreq: 660,
    altFreq: 550,
    decay: 0.023,
    sweep: true,
    volume: 0.2,
    volumeAccent: 0.9,
    volumeAlt: 0.6,
  },
];

function toLayeredConfig(flat: SoundConfig): LayeredSoundConfig {
  const baseDecay = flat.decay;
  const accentDecay = flat.decayAccent ?? flat.decay;
  const altDecay = flat.decayAlt ?? flat.decay;
  const baseVolume = flat.volume;
  const accentVolume = flat.volumeAccent ?? flat.volume;
  const altVolume = flat.volumeAlt ?? flat.volume;
  const baseNoiseFreq = flat.noiseFreq ?? 1000;
  const accentNoiseFreq = flat.noiseFreqAccent ?? flat.noiseFreq ?? 1000;
  const altNoiseFreq = flat.altNoiseFreq ?? flat.noiseFreq ?? 1000;
  const toneType: LayerToneType = flat.oscType ?? "none";
  const noiseType: LayerToneType = flat.noise ? "noise" : "none";
  const noiseFilter = flat.noiseType ?? "highpass";

  const mkTone = (freq: number, volume: number, decay: number): LayerConfig => ({
    type: toneType,
    sweep: flat.sweep === true,
    noiseFilterType: "highpass",
    params: { volume, decay, freq, hpFreq: 20, lpFreq: 20000 },
  });
  const mkNoise = (freq: number, volume: number, decay: number): LayerConfig => ({
    type: noiseType,
    sweep: false,
    noiseFilterType: noiseFilter,
    params: { volume: noiseType === "noise" ? volume : 0, decay, freq, hpFreq: 20, lpFreq: 20000 },
  });
  const mkNone = (decay: number): LayerConfig => ({
    type: "none",
    sweep: false,
    noiseFilterType: "highpass",
    params: { volume: 0, decay, freq: 1000, hpFreq: 20, lpFreq: 20000 },
  });

  return {
    id: flat.id,
    name: flat.name,
    description: flat.description,
    accent: [
      mkTone(flat.accentFreq, accentVolume, accentDecay),
      mkNoise(accentNoiseFreq, accentVolume * 0.5, accentDecay),
      mkNone(0.1),
    ],
    alt: [
      mkTone(flat.altFreq, altVolume, altDecay),
      mkNoise(altNoiseFreq, altVolume * 0.5, altDecay),
      mkNone(0.1),
    ],
    passive: [
      mkTone(flat.baseFreq, baseVolume, baseDecay),
      mkNoise(baseNoiseFreq, baseVolume * 0.5, baseDecay),
      mkNone(0.1),
    ],
  };
}

const EXTRA_LAYERED_PRESETS: LayeredSoundConfig[] = [
  {
    id: "classic-digital",
    name: "Standard",
    description: "Classic steady digital beep (Sine)",
    accent: [
      {
        type: "sine",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 1.5, decay: 0.03, freq: 1500, hpFreq: 1490, lpFreq: 20000 },
        solo: false,
      },
      {
        type: "none",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 0, decay: 0.03, freq: 1000, hpFreq: 20, lpFreq: 20000 },
        solo: false,
      },
      {
        type: "none",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
        mute: false,
        solo: false,
      },
    ],
    alt: [
      {
        type: "sine",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 1.2, decay: 0.03, freq: 1250, hpFreq: 1370, lpFreq: 20000 },
        solo: false,
      },
      {
        type: "none",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 0, decay: 0.03, freq: 1000, hpFreq: 20, lpFreq: 20000 },
        solo: false,
      },
      {
        type: "none",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
        mute: false,
        solo: false,
      },
    ],
    passive: [
      {
        type: "sine",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 0.35, decay: 0.03, freq: 1000, hpFreq: 1120, lpFreq: 20000 },
        mute: false,
        solo: false,
      },
      {
        type: "none",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 0, decay: 0.03, freq: 1000, hpFreq: 20, lpFreq: 20000 },
        mute: false,
        solo: false,
      },
      {
        type: "none",
        sweep: false,
        noiseFilterType: "highpass",
        params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
        mute: false,
        solo: false,
      },
    ],
  },
  {
    id: "studio-909",
    name: "909 Studio Stack",
    description: "Deep 9-layer composite: Sub, Transient, and Noise tail.",
    accent: [
      { type: "sine", sweep: true, noiseFilterType: "lowpass", params: { volume: 1.5, decay: 0.1, freq: 65, hpFreq: 20, lpFreq: 200 } },
      { type: "square", sweep: true, noiseFilterType: "highpass", params: { volume: 0.8, decay: 0.01, freq: 2800, hpFreq: 800, lpFreq: 15000 } },
      { type: "noise", sweep: false, noiseFilterType: "highpass", params: { volume: 0.4, decay: 0.05, freq: 8000, hpFreq: 4000, lpFreq: 20000 } },
    ],
    alt: [
      { type: "sine", sweep: true, noiseFilterType: "lowpass", params: { volume: 1.2, decay: 0.08, freq: 55, hpFreq: 20, lpFreq: 200 } },
      { type: "square", sweep: false, noiseFilterType: "highpass", params: { volume: 0.6, decay: 0.01, freq: 2400, hpFreq: 800, lpFreq: 12000 } },
      { type: "noise", sweep: false, noiseFilterType: "highpass", params: { volume: 0.3, decay: 0.04, freq: 7000, hpFreq: 4000, lpFreq: 20000 } },
    ],
    passive: [
      { type: "sine", sweep: false, noiseFilterType: "lowpass", params: { volume: 0.8, decay: 0.05, freq: 50, hpFreq: 20, lpFreq: 200 } },
      { type: "none", sweep: false, noiseFilterType: "highpass", params: { volume: 0, decay: 0.01, freq: 2000, hpFreq: 800, lpFreq: 10000 } },
      { type: "noise", sweep: false, noiseFilterType: "highpass", params: { volume: 0.2, decay: 0.02, freq: 6000, hpFreq: 4000, lpFreq: 20000 } },
    ],
  },
  {
    id: "cyber-tick",
    name: "Cyber Tick",
    description: "Multi-layered digital tick with FM-like textures.",
    accent: [
      { type: "square", sweep: true, noiseFilterType: "highpass", params: { volume: 0.7, decay: 0.02, freq: 4800, hpFreq: 2000, lpFreq: 18000 } },
      { type: "sawtooth", sweep: true, noiseFilterType: "highpass", params: { volume: 0.4, decay: 0.005, freq: 800, hpFreq: 100, lpFreq: 5000 } },
      { type: "noise", sweep: false, noiseFilterType: "bandpass", params: { volume: 0.8, decay: 0.015, freq: 12000, hpFreq: 20, lpFreq: 20000 } },
    ],
    alt: [
      { type: "square", sweep: true, noiseFilterType: "highpass", params: { volume: 0.5, decay: 0.015, freq: 3800, hpFreq: 2000, lpFreq: 16000 } },
      { type: "sawtooth", sweep: false, noiseFilterType: "highpass", params: { volume: 0.2, decay: 0.005, freq: 600, hpFreq: 100, lpFreq: 4000 } },
      { type: "noise", sweep: false, noiseFilterType: "bandpass", params: { volume: 0.5, decay: 0.01, freq: 10000, hpFreq: 20, lpFreq: 20000 } },
    ],
    passive: [
      { type: "sine", sweep: false, noiseFilterType: "highpass", params: { volume: 0.4, decay: 0.01, freq: 2800, hpFreq: 2000, lpFreq: 14000 } },
      { type: "none", sweep: false, noiseFilterType: "highpass", params: { volume: 0, decay: 0, freq: 0, hpFreq: 20, lpFreq: 20000 } },
      { type: "noise", sweep: false, noiseFilterType: "bandpass", params: { volume: 0.3, decay: 0.005, freq: 8000, hpFreq: 20, lpFreq: 20000 } },
    ],
  },
];

const EXTRA_LAYERED_IDS = new Set(EXTRA_LAYERED_PRESETS.map((p) => p.id));

export const MOVEMENT_SOUNDS_LAYERED: LayeredSoundConfig[] = [
  ...EXTRA_LAYERED_PRESETS,
  ...MOVEMENT_SOUNDS.map(toLayeredConfig).filter((s) => !EXTRA_LAYERED_IDS.has(s.id)),
];
