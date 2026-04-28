import { fillChannelDeterministicWhiteNoise } from '../../../src/deterministicWhiteNoiseFill';
import { SoundConfig } from './sounds';
import { getMetronomeSummingInput } from 'trainer-src/metraAudioBus';

class AudioEngine {
  private context: AudioContext | null = null;
  private timerID: number | null = null;
  private nextNoteTime: number = 0;
  private currentBeat: number = 0;
  private lookahead: number = 25.0; // ms
  private scheduleAheadTime: number = 0.1; // s
  private activeConfig: SoundConfig | null = null;
  private bpm: number = 120;
  
  // Callback to allow UI to sync visually
  public onBeat: ((beat: number) => void) | null = null;

  public getContext(): AudioContext {
    if (!this.context) {
      this.context = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return this.context;
  }

  public setBpm(newBpm: number) {
    this.bpm = newBpm;
  }

  public play(config: SoundConfig) {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    
    // Stop current sequence if running
    this.stop();
    
    this.activeConfig = config;
    this.currentBeat = 0;
    this.nextNoteTime = ctx.currentTime + 0.05;
    this.scheduler();
  }

  public updateConfig(config: SoundConfig) {
    if (this.activeConfig?.id === config.id || this.activeConfig) {
      this.activeConfig = config;
    }
  }

  public stop() {
    if (this.timerID !== null) {
      window.clearTimeout(this.timerID);
      this.timerID = null;
    }
    this.activeConfig = null;
  }

  private nextNote() {
    const secondsPerBeat = 60.0 / this.bpm;
    this.nextNoteTime += secondsPerBeat;
    this.currentBeat++;
    if (this.currentBeat === 4) {
      this.currentBeat = 0;
    }
  }

  private scheduleNote(beatNumber: number, time: number) {
    if (!this.activeConfig) return;

    // Trigger visual callback with slight delay to mimic actual sound timing 
    // (since we schedule audio slightly in the future)
    const ctx = this.getContext();
    const masterIn = getMetronomeSummingInput(ctx);
    const timeUntilPlay = time - ctx.currentTime;
    if (this.onBeat) {
      setTimeout(() => {
        if (this.onBeat && this.activeConfig) {
          this.onBeat(beatNumber);
        }
      }, Math.max(0, timeUntilPlay * 1000));
    }

    // ==============================================================================
    // ВНИМАНИЕ: ЭТО ДЕМО-ДВИЖОК CLICK LIBRARY.
    // SOURCE OF TRUTH ДЛЯ ПРОД-ЛОГИКИ — ТОЛЬКО ПОЛЬЗОВАТЕЛЬСКАЯ СЕТКА В `src/App.tsx`.
    // ЗАПРЕЩЕНО ВОСПРИНИМАТЬ ЭТУ ЛОГИКУ КАК ПРАВИЛО НАЗНАЧЕНИЯ АКЦЕНТОВ В ТРЕНАЖЕРЕ.
    // ==============================================================================
    const config = this.activeConfig;
    const isAccent = beatNumber === 0;
    const isThirdBeat = beatNumber === 2;

    const currentDecay = isAccent ? (config.decayAccent ?? config.decay) :
                         isThirdBeat ? (config.decayAlt ?? config.decay) :
                         config.decay;

    const currentVolume = isAccent ? (config.volumeAccent ?? config.volume) :
                          isThirdBeat ? (config.volumeAlt ?? config.volume) :
                          config.volume;

    // Synthesize Sound (METRA: skip layers at or below -60 dB gate)
    if (currentVolume > 0.001 && config.oscType) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      let freq = isAccent ? config.accentFreq : config.baseFreq;

      if (isThirdBeat) {
        freq = config.altFreq;
      }

      osc.type = config.oscType;
      osc.frequency.setValueAtTime(freq, time);

      if (config.sweep) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(10, freq * 0.1), time + currentDecay);
      }

      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(currentVolume, time + 0.002);
      const toneEnd = Math.max(0.00001, currentVolume * 0.001);
      gain.gain.exponentialRampToValueAtTime(toneEnd, time + currentDecay);

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 20;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 20000;

      osc.connect(gain);
      gain.connect(hp);
      hp.connect(lp);
      lp.connect(masterIn);

      osc.start(time);
      osc.stop(time + currentDecay + 0.05);
    }

    // Add Noise if requested
    if (config.noise && currentVolume > 0.001) {
      const noiseLen = (ctx.sampleRate * currentDecay) || 1;
      const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
      const output = noiseBuf.getChannelData(0);
      fillChannelDeterministicWhiteNoise(output);

      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuf;

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = config.noiseType || 'highpass';
      
      let currentNoiseFreq = isAccent ? (config.noiseFreqAccent ?? config.noiseFreq ?? 1000) :
                             isThirdBeat ? (config.altNoiseFreq ?? config.noiseFreq ?? 1000) :
                             (config.noiseFreq ?? 1000);
      
      noiseFilter.frequency.value = currentNoiseFreq;

      const noiseGain = ctx.createGain();
      const nVol = currentVolume > 0 ? currentVolume * 0.5 : 0;
      
      noiseGain.gain.setValueAtTime(0, time);
      noiseGain.gain.linearRampToValueAtTime(nVol, time + 0.002);
      const noiseEnd = Math.max(0.00001, nVol * 0.001);
      noiseGain.gain.exponentialRampToValueAtTime(noiseEnd, time + currentDecay);

      const nHp = ctx.createBiquadFilter();
      nHp.type = 'highpass';
      nHp.frequency.value = 20;
      const nLp = ctx.createBiquadFilter();
      nLp.type = 'lowpass';
      nLp.frequency.value = 20000;

      noiseSrc.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(nHp);
      nHp.connect(nLp);
      nLp.connect(masterIn);

      noiseSrc.start(time);
      noiseSrc.stop(time + currentDecay + 0.05);
    }
  }

  private scheduler = () => {
    const ctx = this.getContext();
    while (this.nextNoteTime < ctx.currentTime + this.scheduleAheadTime) {
      this.scheduleNote(this.currentBeat, this.nextNoteTime);
      this.nextNote();
    }
    this.timerID = window.setTimeout(this.scheduler, this.lookahead);
  }
}

export const engine = new AudioEngine();
