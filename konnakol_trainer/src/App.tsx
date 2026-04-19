import React, { useState, useRef, useEffect } from 'react';
import { Settings, AudioLines, Minus, Plus, Dices, Play, Snowflake, ChevronUp, ChevronDown, Eraser } from 'lucide-react';

const KONNAKOL_PYRAMID: Record<number, string[]> = {
  1: ["Ta"],
  2: ["Ta", "Ka"],
  3: ["Ta", "Ki", "Ta"],
  4: ["Ta", "Ka", "Dhi", "Mi"],
  5: ["Ta", "Ka", "Ta", "Ki", "Ta"],
  6: ["Ta", "Ka", "Dhi", "Mi", "Ta", "Ka"],
  7: ["Ta", "Ka", "Dhi", "Mi", "Ta", "Ki", "Ta"],
  8: ["Ta", "Ka", "Dhi", "Mi", "Ta", "Ka", "Dju", "Na"],
  9: ["Ta", "Ka", "Dhi", "Mi", "Ta", "Ka", "Ta", "Ki", "Ta"]
};

const playSharpClick = (ctx: AudioContext, time: number, isChecked: boolean, soundType: 'modern' | 'oldschool' = 'modern') => {
  // Old school = same as legacy maja `konnakol_metronome` (triangle + pitch sweep).
  if (soundType === 'oldschool') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isChecked ? 500 : 250, time);
    osc.frequency.exponentialRampToValueAtTime(isChecked ? 120 : 80, time + (isChecked ? 0.04 : 0.02));
    const peak = isChecked ? 0.9 : 0.4;
    const decay = isChecked ? 0.04 : 0.02;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + Math.max(0.05, decay + 0.01));
    return;
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(isChecked ? 920 : 800, time);
  const peak = isChecked ? 0.34 : 0.28;
  const decay = 0.04;
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(peak, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + decay + 0.01);
};

const playBarFirstHighClick = (ctx: AudioContext, time: number, soundType: 'modern' | 'oldschool' = 'modern') => {
  if (soundType === 'oldschool') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(920, time);
    osc.frequency.exponentialRampToValueAtTime(210, time + 0.03);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.78, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
    return;
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1550, time);
  osc.frequency.exponentialRampToValueAtTime(520, time + 0.035);
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(0.30, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.042);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.06);
};

export default function App() {
  const [tempo, setTempo] = useState(100);
  const [bars, setBars] = useState(4);
  const [syllables, setSyllables] = useState(4);

  // Metronome state
  const [isPlaying, setIsPlaying] = useState(false);
  const [accents, setAccents] = useState<Set<string>>(new Set());
  const [activePos, setActivePos] = useState({ r: -1, c: -1, absR: -1 });
  const playAbsBarRef = useRef(0);
  const [listOffset, setListOffset] = useState(0);
  const [customSyllables, setCustomSyllables] = useState<Record<number, number>>({});
  const [customMultipliers, setCustomMultipliers] = useState<Record<number, number>>({});
  const [customSubdivisions, setCustomSubdivisions] = useState<Record<string, number>>({});

  // Metronome Sound Toggles
  const [onlyAccents, setOnlyAccents] = useState(false);
  const [firstBeatAccent, setFirstBeatAccent] = useState(true);

  // Randomizer States
  const [randomModeEnabled, setRandomModeEnabled] = useState(false);
  const [randomPulsation, setRandomPulsation] = useState(false);
  const [randomPattern, setRandomPattern] = useState(true);
  const [randomSpeed, setRandomSpeed] = useState(false);
  const [randomBarSpeed, setRandomBarSpeed] = useState(false);
  const [randomMaxNotes, setRandomMaxNotes] = useState(0);
  const [showRandomSettings, setShowRandomSettings] = useState(false);
  const coldStartRef = useRef(true);

  // Click Sound
  const [clickSound, setClickSound] = useState<'modern' | 'oldschool'>('modern');

  // Preset Snapshot State
  const [activeSnapshot, setActiveSnapshot] = useState(1);
  const [snapshots, setSnapshots] = useState<Record<number, any>>({
    1: { tempo: 100, bars: 4, syllables: 4, accents: new Set(), customSyllables: {}, customMultipliers: {}, customSubdivisions: {} }
  });

  const [activeEditCell, setActiveEditCell] = useState<string | null>(null);
  const [activeEditRow, setActiveEditRow] = useState<number | null>(null);
  const [frozenScale, setFrozenScale] = useState<number | null>(null);
  const [isPanelExpanded, setIsPanelExpanded] = useState(true);
  const holdTimerRef = useRef<number | null>(null);
  const isHoldingRef = useRef(false);
  const tapTimesRef = useRef<number[]>([]);

  const handleTap = () => {
    const now = Date.now();
    const times = tapTimesRef.current;
    
    // Clear times if it's been more than 2 seconds since last tap
    if (times.length > 0 && now - times[times.length - 1] > 2000) {
      tapTimesRef.current = [];
    }
    
    tapTimesRef.current.push(now);
    
    // Keep only the last 4 taps for a moving average
    if (tapTimesRef.current.length > 4) {
      tapTimesRef.current.shift();
    }
    
    if (tapTimesRef.current.length > 1) {
      let totalInterval = 0;
      for (let i = 1; i < tapTimesRef.current.length; i++) {
        totalInterval += (tapTimesRef.current[i] - tapTimesRef.current[i - 1]);
      }
      const averageInterval = totalInterval / (tapTimesRef.current.length - 1);
      const newTempo = Math.round(60000 / averageInterval);
      
      // Clamp between 20 and 400
      setTempo(Math.min(400, Math.max(20, newTempo)));
    }
  };

  const clearSequencer = () => {
    setAccents(new Set());
    setCustomSyllables({});
    setCustomMultipliers({});
    setCustomSubdivisions({});
  };

  const toggleRandomFeature = (feature: 'pulsation' | 'pattern' | 'speed' | 'barSpeed') => {
    let willBeEnabled = false;
    if (feature === 'pulsation') {
      willBeEnabled = !randomPulsation;
      setRandomPulsation(!randomPulsation);
    } else if (feature === 'pattern') {
      willBeEnabled = !randomPattern;
      setRandomPattern(!randomPattern);
    } else if (feature === 'speed') {
      willBeEnabled = !randomSpeed;
      setRandomSpeed(!randomSpeed);
    } else if (feature === 'barSpeed') {
      willBeEnabled = !randomBarSpeed;
      setRandomBarSpeed(!randomBarSpeed);
    }
    
    if (willBeEnabled && !randomModeEnabled) {
      setRandomModeEnabled(true);
    }
  };

  // (Removed Djembe hold timers)

  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledPageRef = useRef<number>(-1);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerIDRef = useRef<number | null>(null);
  const nextNoteTimeRef = useRef(0);
  const currentStepRef = useRef(0);
  const isPlayingRef = useRef(false);

  const barsRef = useRef(bars);
  const syllablesRef = useRef(syllables);
  const tempoRef = useRef(tempo);
  const accentsRef = useRef(accents);
  const customSyllablesRef = useRef(customSyllables);
  const customMultipliersRef = useRef(customMultipliers);
  const customSubdivisionsRef = useRef(customSubdivisions);
  const onlyAccentsRef = useRef(onlyAccents);
  const firstBeatAccentRef = useRef(firstBeatAccent);
  const randomModeEnabledRef = useRef(randomModeEnabled);
  const randomPulsationRef = useRef(randomPulsation);
  const randomPatternRef = useRef(randomPattern);
  const randomSpeedRef = useRef(randomSpeed);
  const randomBarSpeedRef = useRef(randomBarSpeed);
  const randomMaxNotesRef = useRef(randomMaxNotes);
  const clickSoundRef = useRef(clickSound);

  useEffect(() => { barsRef.current = bars; }, [bars]);
  useEffect(() => { syllablesRef.current = syllables; }, [syllables]);
  useEffect(() => { tempoRef.current = tempo; }, [tempo]);
  useEffect(() => { accentsRef.current = new Set(accents); }, [accents]);
  useEffect(() => { customMultipliersRef.current = { ...customMultipliers }; }, [customMultipliers]);
  useEffect(() => { customSubdivisionsRef.current = { ...customSubdivisions }; }, [customSubdivisions]);
  useEffect(() => { customSyllablesRef.current = { ...customSyllables }; }, [customSyllables]);
  useEffect(() => { onlyAccentsRef.current = onlyAccents; }, [onlyAccents]);
  useEffect(() => { firstBeatAccentRef.current = firstBeatAccent; }, [firstBeatAccent]);
  useEffect(() => { randomModeEnabledRef.current = randomModeEnabled; }, [randomModeEnabled]);
  useEffect(() => { randomPulsationRef.current = randomPulsation; }, [randomPulsation]);
  useEffect(() => { randomPatternRef.current = randomPattern; }, [randomPattern]);
  useEffect(() => { randomSpeedRef.current = randomSpeed; }, [randomSpeed]);
  useEffect(() => { randomBarSpeedRef.current = randomBarSpeed; }, [randomBarSpeed]);
  useEffect(() => { randomMaxNotesRef.current = randomMaxNotes; }, [randomMaxNotes]);
  useEffect(() => { clickSoundRef.current = clickSound; }, [clickSound]);

  const sequence = React.useMemo(() => {
    const seq = [];
    for (let r = 0; r < bars; r++) {
      const syls = customSyllables[r] !== undefined ? customSyllables[r] : syllables;
      for (let c = 0; c < syls; c++) {
        seq.push({ r, c, activeSyllables: syls });
      }
    }
    return seq;
  }, [bars, syllables, customSyllables]);

  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence; // Always keep ref atomic with render

  // Auto-save preset whenever parameters change
  useEffect(() => {
    setSnapshots(prev => ({
      ...prev,
      [activeSnapshot]: { tempo, bars, syllables, accents, customSyllables, customMultipliers, customSubdivisions }
    }));
  }, [tempo, bars, syllables, accents, customSyllables, customMultipliers, customSubdivisions, activeSnapshot]);

  const loadSnapshot = (id: number) => {
    const snap = snapshots[id];
    setActiveSnapshot(id);
    if (snap) {
      setTempo(snap.tempo);
      setBars(snap.bars);
      setSyllables(snap.syllables);
      setAccents(new Set(snap.accents));
      setCustomSyllables({ ...snap.customSyllables });
      setCustomMultipliers({ ...(snap.customMultipliers || {}) });
      setCustomSubdivisions({ ...(snap.customSubdivisions || {}) });
    } else {
      // Initialize an empty layout for a completely new snapshot
      setTempo(100);
      setBars(4);
      setSyllables(4);
      setAccents(new Set());
      setCustomSyllables({});
      setCustomMultipliers({});
      setCustomSubdivisions({});
    }
  };

  // Ensure currentStepRef bounds are respected if grid shrinks
  useEffect(() => {
    if (currentStepRef.current >= sequence.length) {
      currentStepRef.current = 0;
    }
  }, [sequence.length]);

  // Determine display metrics that drive auto-scrolling
  const displayScaleBars = frozenScale !== null ? Math.min(frozenScale, 10) : Math.min(bars, 10);
  const useFixedFlex = frozenScale !== null || bars > 10;
  
  // Create a scroll stride that overlaps by 1 row
  const scrollStride = Math.max(1, displayScaleBars - 1);

  // Auto-scroll to active row during playback in pages smoothly
  useEffect(() => {
    if (!isPlaying) {
      lastScrolledPageRef.current = -1; // Reset memory when stopped
      if (gridRef.current) gridRef.current.scrollTop = 0;
    } else if (activePos.absR >= 0 && gridRef.current) {
      let logicalPage = Math.floor(activePos.absR / scrollStride);
      
      // Delay turning the page until halfway through the overlap row
      if (activePos.absR > 0 && activePos.absR % scrollStride === 0) {
        const rIdx = activePos.absR % bars;
        const rowSylls = customSyllables[rIdx] !== undefined ? customSyllables[rIdx] : syllables;
        const isPastHalfway = activePos.c >= Math.floor(rowSylls / 2);
        
        if (!isPastHalfway) {
          logicalPage -= 1; // Stay on previous page
        }
      }

      if (logicalPage !== lastScrolledPageRef.current) {
        lastScrolledPageRef.current = logicalPage;
        const pageStartAbsR = logicalPage * scrollStride;
        const rowEl = rowRefs.current[pageStartAbsR];
        
        if (rowEl) {
           rowEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    }
  }, [activePos.absR, activePos.c, isPlaying, scrollStride, customSyllables, syllables, bars]);

  useEffect(() => {
    return () => {
      if (timerIDRef.current) clearTimeout(timerIDRef.current);
      if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
    };
  }, []);

  const toggleAccent = (r: number, c: number) => {
    setAccents(prev => {
      const next = new Set(prev);
      const key = `${r}-${c}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const nextNote = () => {
    try {
      const seq = sequenceRef.current;
      if (seq.length === 0) {
        nextNoteTimeRef.current += 0.5;
        return;
      }
      
      // Boundary safety net
      if (currentStepRef.current >= seq.length || currentStepRef.current < 0) {
        currentStepRef.current = 0;
      }

      let currentSeqItem = seq[currentStepRef.current];

      // Randomizer Orchestration at bar boundary
      if (currentSeqItem && currentSeqItem.c === 0 && isPlayingRef.current) {
        if (coldStartRef.current) {
          coldStartRef.current = false;
        } else if (randomModeEnabledRef.current) {
          const targetR = currentSeqItem.r;
          const prevBar = (targetR - 1 + barsRef.current) % barsRef.current;
          let didChange = false;

          if (randomPulsationRef.current) {
            const newSyl = Math.floor(Math.random() * 9) + 1;
            customSyllablesRef.current[prevBar] = newSyl;
            didChange = true;
          }

          if (randomPatternRef.current) {
            const curSyl = customSyllablesRef.current[prevBar] ?? syllablesRef.current;
            
            for (let i = 0; i < 9; i++) accentsRef.current.delete(`${prevBar}-${i}`);
            
            const candidates = Array.from({length: curSyl}, (_, i) => i).sort(() => Math.random() - 0.5);
            
            let fillCount;
            if (randomMaxNotesRef.current === 0) {
              // "Auto" mode: Randomly pick 1 or 2 elements maximum to swap
              fillCount = Math.floor(Math.random() * Math.min(2, curSyl)) + 1;
            } else {
              fillCount = Math.min(randomMaxNotesRef.current, curSyl);
            }
            
            for (let i = 0; i < fillCount; i++) {
               accentsRef.current.add(`${prevBar}-${candidates[i]}`);
            }
            didChange = true;
          }

          if (randomSpeedRef.current) {
            const curSyl = customSyllablesRef.current[prevBar] ?? syllablesRef.current;
            const candidates = onlyAccentsRef.current 
              ? Array.from({length: curSyl}, (_, i) => i).filter(i => accentsRef.current.has(`${prevBar}-${i}`))
              : Array.from({length: curSyl}, (_, i) => i);
              
            for (let i = 0; i < 9; i++) delete customSubdivisionsRef.current[`${prevBar}-${i}`];
            
            candidates.forEach(i => {
              if (Math.random() > 0.6) {
                customSubdivisionsRef.current[`${prevBar}-${i}`] = Math.random() > 0.5 ? 2 : 4;
              }
            });
            didChange = true;
          }

          if (randomBarSpeedRef.current) {
            const multOptions = [1, 2, 3];
            customMultipliersRef.current[prevBar] = multOptions[Math.floor(Math.random() * multOptions.length)];
            didChange = true;
          }

          if (didChange) {
            const newSeq = [];
            for (let r = 0; r < barsRef.current; r++) {
              const syls = customSyllablesRef.current[r] !== undefined ? customSyllablesRef.current[r] : syllablesRef.current;
              for (let c = 0; c < syls; c++) {
                newSeq.push({ r, c, activeSyllables: syls });
              }
            }
            sequenceRef.current = newSeq;
            
            const targetStepIndex = sequenceRef.current.findIndex(item => item.r === targetR && item.c === 0);
            if (targetStepIndex !== -1) {
              currentStepRef.current = targetStepIndex;
            } else {
              currentStepRef.current = 0;
            }
            
            currentSeqItem = sequenceRef.current[currentStepRef.current];

            setTimeout(() => {
              if (randomPulsationRef.current) setCustomSyllables({...customSyllablesRef.current});
              if (randomPatternRef.current) setAccents(new Set(accentsRef.current));
              if (randomSpeedRef.current) setCustomSubdivisions({...customSubdivisionsRef.current});
              if (randomBarSpeedRef.current) setCustomMultipliers({...customMultipliersRef.current});
            }, 0);
          }
        }
      }

      if (!currentSeqItem) {
        nextNoteTimeRef.current += 0.5;
        return; 
      }

      const effectiveSyllables = currentSeqItem.activeSyllables || syllablesRef.current;
      const mult = customMultipliersRef.current[currentSeqItem.r] || 1;
      
      const effectiveBpm = tempoRef.current * (effectiveSyllables / 4) * mult;
      if (effectiveBpm > 0) {
        nextNoteTimeRef.current += 60.0 / effectiveBpm;
      } else {
        nextNoteTimeRef.current += 0.5;
      }
      
      const oldR = currentSeqItem.r;
      currentStepRef.current = (currentStepRef.current + 1) % Math.max(1, sequenceRef.current.length);
      const nextSeqItem = sequenceRef.current[currentStepRef.current];
      
      if (nextSeqItem) {
          const newR = nextSeqItem.r;
          if (newR !== oldR) {
              if (newR === 0 && oldR === barsRef.current - 1) {
                  playAbsBarRef.current += 1;
              } else if (newR > oldR) {
                  playAbsBarRef.current += (newR - oldR);
              } else {
                  playAbsBarRef.current = newR;
              }
          }
      }
    } catch (e) {
      console.error("Critical error in nextNote:", e);
      // Emergency fallback to prevent the browser from freezing in an infinite while loop!
      nextNoteTimeRef.current += 0.5; 
      currentStepRef.current = 0; // Wrap around safely
    }
  };

  const scheduleNote = (stepIdx: number, absR: number, time: number) => {
    const seq = sequenceRef.current;
    const currentSeqItem = seq[stepIdx];
    if (!currentSeqItem) return;

    const { r: rIdx, c: cIdx } = currentSeqItem;
    const isAccent = accentsRef.current.has(`${rIdx}-${cIdx}`);

    if (!audioCtxRef.current) return;
    
    const subdivs = customSubdivisionsRef.current[`${rIdx}-${cIdx}`] || 1;
    const mult = customMultipliersRef.current[rIdx] || 1;
    const effectiveBpm = tempoRef.current * (currentSeqItem.activeSyllables / 4) * mult;
    const stepDuration = 60.0 / effectiveBpm;
    const subDuration = stepDuration / subdivs;

    for (let sub = 0; sub < subdivs; sub++) {
      const subTime = time + sub * subDuration;
      const isFirstOfBar = cIdx === 0 && sub === 0;
      
      if (isFirstOfBar && firstBeatAccentRef.current) {
        playBarFirstHighClick(audioCtxRef.current, subTime, clickSoundRef.current);
      }

      const shouldPlayBeat = !onlyAccentsRef.current || isAccent;
      if (shouldPlayBeat) {
        playSharpClick(audioCtxRef.current, subTime, isAccent && sub === 0, clickSoundRef.current);
      }
    }

    const delay = Math.max(0, (time - audioCtxRef.current.currentTime) * 1000);
    setTimeout(() => {
      if (isPlayingRef.current) {
        setActivePos({ r: rIdx, c: cIdx, absR });
      }
    }, delay);
  };

  const scheduler = () => {
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + 0.1) {
      scheduleNote(currentStepRef.current, playAbsBarRef.current, nextNoteTimeRef.current);
      nextNote();
    }
    timerIDRef.current = window.setTimeout(scheduler, 25);
  };

  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      setActivePos({ r: -1, c: -1, absR: -1 });
      currentStepRef.current = 0; // Reset pattern position to start
      if (timerIDRef.current) clearTimeout(timerIDRef.current);
    } else {
      setIsPlaying(true);
      isPlayingRef.current = true;
      coldStartRef.current = true; // Mark cold start
      
      const startSeqItem = sequenceRef.current[currentStepRef.current];
      playAbsBarRef.current = startSeqItem ? startSeqItem.r : 0;
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      // Guarantee loop limits if grid resized
      if (currentStepRef.current >= sequenceRef.current.length) {
        currentStepRef.current = 0;
      }
      nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.05;
      scheduler();
    }
  };

  // Dynamic text sizing based on grid density to keep text readable
  const getSyllableStyles = (rowSylls: number, cellSubdivs: number = 1) => {
    let pseudoSylls = rowSylls;
    if (cellSubdivs === 2) pseudoSylls = rowSylls * 1.5;
    else if (cellSubdivs === 3) pseudoSylls = rowSylls * 2;
    else if (cellSubdivs === 4) pseudoSylls = rowSylls * 2;
    else if (cellSubdivs >= 5 && cellSubdivs <= 6) pseudoSylls = rowSylls * 2.5;
    else if (cellSubdivs >= 7) pseudoSylls = rowSylls * 3;

    if (pseudoSylls >= 20) return 'text-[6px] font-black tracking-tighter leading-none';
    if (pseudoSylls >= 14) return 'text-[7px] font-black tracking-tighter leading-none';
    if (pseudoSylls >= 12) return 'text-[8px] font-black tracking-tighter leading-none';
    if (pseudoSylls >= 9) return 'text-[9px] font-extrabold tracking-tight leading-none';
    if (pseudoSylls >= 7) return 'text-[10px] font-bold tracking-tight leading-none';
    if (pseudoSylls >= 5) return 'text-[11px] font-bold tracking-normal leading-none';
    return 'text-sm font-bold tracking-wide leading-none';
  };

  return (
    <div className="min-h-screen bg-[#0b101e] sm:bg-black/95 text-slate-200 p-0 sm:p-6 font-sans flex flex-col items-center justify-center">
      {/* Phone emulator container */}
      <div className="w-full max-w-[390px] h-[100dvh] sm:h-[844px] sm:rounded-[2.5rem] sm:border-[6px] border-[#1e2a45] shadow-2xl bg-[#0b101e] flex flex-col gap-3 p-3 relative overflow-hidden shrink-0">
        
        {/* Top Header Controls */}
        <div className="flex gap-2 items-center">
          <button 
            onClick={() => {
              if (!showRandomSettings) {
                setShowRandomSettings(true);
                setIsPanelExpanded(true);
              } else {
                setShowRandomSettings(false);
              }
            }}
            className="p-3 bg-[#161f33] rounded-xl border border-[#23314f] text-slate-400 hover:text-slate-200 transition-colors"
          >
            <Settings size={20} />
          </button>
          <button 
            onClick={handleTap}
            className="flex-1 py-3 bg-[#161f33] rounded-xl border border-[#23314f] font-semibold text-slate-300 tracking-wide hover:bg-[#1a253c] active:bg-purple-900/50 active:border-purple-500/50 active:text-purple-100 transition-all active:scale-95 duration-75"
          >
            Tap
          </button>
          <button 
            onClick={clearSequencer}
            className="p-3 bg-[#161f33] rounded-xl border border-[#23314f] text-slate-400 hover:text-red-400 hover:border-red-500/30 active:bg-red-500/20 transition-all duration-200"
            title="Clear Sequencer"
          >
            <Eraser size={20} />
          </button>
        </div>

        {/* Global Settings (Tempo & Row Selectors) */}
        <div className="relative bg-[#161f33] rounded-2xl border border-[#23314f] flex flex-col shrink-0 mb-3">
          <div className={`grid transition-all duration-300 ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
            <div className={`overflow-hidden flex flex-col transition-all duration-300 ${isPanelExpanded ? 'px-2.5 py-4 gap-5' : 'px-2.5 py-0 gap-0'}`}>
              
              {showRandomSettings ? (
                <div className="flex flex-col gap-4 px-1 pb-1">
                  <div className="flex justify-between items-center text-slate-300 font-bold text-[11px] uppercase tracking-wider">
                    <span className="flex items-center gap-2 drop-shadow-[0_0_8px_rgba(59,130,246,0.5)] text-blue-300">
                      <Dices size={14} /> Randomizer
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2">
                     <button 
                       onClick={() => toggleRandomFeature('pulsation')}
                       className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                         randomPulsation 
                           ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.15)]' 
                           : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                       }`}
                     >
                       Pulsation
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('pattern')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomPattern 
                            ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.15)]' 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Accents
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('speed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomSpeed 
                            ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.15)]' 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Cell Speed
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('barSpeed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomBarSpeed 
                            ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.15)]' 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Bar Speed
                     </button>
                  </div>

                  <div className={`flex flex-col gap-2 transition-all duration-300 ${randomPattern ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                     <div className="flex items-center justify-between px-1">
                       <span className="text-[11px] text-slate-400 font-bold tracking-wider uppercase">Max Accents: <span className="text-purple-300 ml-1">{randomMaxNotes === 0 ? 'Auto' : randomMaxNotes}</span></span>
                     </div>
                     <input 
                        type="range" 
                        min="0" 
                        max="9" 
                        value={randomMaxNotes} 
                        onChange={e => setRandomMaxNotes(parseInt(e.target.value))}
                        className="w-full h-2 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110"
                      />
                  </div>

                  <div className="w-full h-px bg-[#1e2a45]/80 my-0.5"></div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-400 font-bold tracking-wider uppercase">Click Sound</span>
                    <div className="flex bg-[#0b101e] p-[3px] rounded-lg border border-[#2f4066]/50">
                       <button onClick={() => setClickSound('modern')} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${clickSound === 'modern' ? 'bg-[#364976] text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>Modern</button>
                       <button onClick={() => setClickSound('oldschool')} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${clickSound === 'oldschool' ? 'bg-[#364976] text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>Oldschool</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 relative h-[74px] justify-between pb-1">
                  {/* Tempo Controls */}
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => setTempo(t => Math.max(20, t - 1))}
                      className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
                    >
                      <Minus size={18} strokeWidth={2.5}/>
                    </button>
                    <div 
                      className="flex-1 relative flex items-center h-8 cursor-pointer touch-none"
                      onPointerDown={(e) => {
                        const el = e.currentTarget;
                        el.setPointerCapture(e.pointerId);
                        const rect = el.getBoundingClientRect();
                        const updateTempo = (clientX: number) => {
                          const thumbHalf = 24; // w-12 / 2
                          const activeWidth = rect.width - (thumbHalf * 2);
                          const x = Math.max(0, Math.min(activeWidth, clientX - rect.left - thumbHalf));
                          const percent = x / Math.max(1, activeWidth);
                          setTempo(Math.round(20 + percent * 380));
                        };
                        updateTempo(e.clientX);
                        
                        const onMove = (moveEvt: PointerEvent) => {
                          updateTempo(moveEvt.clientX);
                        };
                        const onUp = () => {
                          el.removeEventListener('pointermove', onMove);
                          el.removeEventListener('pointerup', onUp);
                          el.releasePointerCapture(e.pointerId);
                        };
                        
                        el.addEventListener('pointermove', onMove);
                        el.addEventListener('pointerup', onUp);
                      }}
                    >
                      {/* Slider track */}
                      <div className="absolute w-full h-1.5 bg-[#0b101e] rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-[#364976]" 
                          style={{ width: `calc(24px + ${((tempo - 20) / 380)} * calc(100% - 48px))` }}
                        ></div>
                      </div>
                      <div 
                        className="absolute z-10 bg-[#23314f] border border-[#2f4066] px-3 w-12 text-center py-1 rounded-full text-sm font-bold shadow-md -translate-x-1/2 flex items-center justify-center select-none"
                        style={{ left: `calc(24px + ${((tempo - 20) / 380)} * calc(100% - 48px))` }}
                      >
                        {tempo}
                      </div>
                    </div>
                    <button 
                      onClick={() => setTempo(t => Math.min(400, t + 1))}
                      className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
                    >
                      <Plus size={18} strokeWidth={2.5}/>
                    </button>
                  </div>

                  {/* Snapshots / Presets 1-7 */}
                  <div className="flex flex-col">
                    <div className="flex justify-between items-center px-1">
                      {[1, 2, 3, 4, 5, 6, 7].map((num) => {
                        const isActive = activeSnapshot === num;
                        const hasData = !!snapshots[num] || isActive;
                        
                        return (
                          <button 
                            key={num} 
                            onClick={() => loadSnapshot(num)}
                            className={`w-8 h-8 flex items-center justify-center rounded-full text-[13px] font-bold transition-all ${
                              isActive
                                ? 'bg-[#1e2a45] text-white shadow-sm ring-1 ring-[#3a5080] scale-110' 
                                : hasData 
                                  ? 'text-slate-300 bg-[#1e2a45]/30 hover:bg-[#1e2a45]/60 hover:text-white'
                                  : 'text-slate-600 hover:text-slate-400'
                            }`}
                          >
                            {num}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Dynamic Scaling Sliders (Always Visible) */}
          <div className={`px-2.5 pt-1 pb-3 flex flex-col mb-2 transition-all duration-300 ${isPanelExpanded ? 'gap-4' : 'gap-0'}`}>
            <div className="flex items-center gap-2">
              <div className="flex items-center w-12 justify-between pr-1 shrink-0">
                <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Bars</span>
                <button 
                  onClick={() => setFrozenScale(frozenScale !== null ? null : bars)}
                  className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-all duration-300 ${
                    frozenScale !== null 
                      ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/50 shadow-[0_0_8px_rgba(59,130,246,0.3)]' 
                      : 'bg-[#1e2a45]/40 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a45] ring-1 ring-[#2f4066]/30'
                  }`}
                  title={frozenScale !== null ? "Unfreeze row height" : "Freeze current row height"}
                >
                  <Snowflake size={12} />
                </button>
              </div>
              <input 
                type="range" 
                min="1" 
                max="32" 
                value={bars} 
                onChange={(e) => setBars(parseInt(e.target.value))} 
                className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-blue-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
              />
              <div className="w-5 shrink-0 flex justify-end">
                <input 
                  type="text"
                  inputMode="numeric"
                  key={`bars-input-${bars}`}
                  defaultValue={bars}
                  onFocus={e => e.target.select()}
                  onBlur={e => {
                    let val = parseInt(e.target.value);
                    if (isNaN(val) || val < 1) val = 1;
                    if (val > 100) val = 100;
                    setBars(val);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  className="w-full text-xs font-bold text-slate-300 text-right bg-transparent hover:bg-[#1e2a45] focus:bg-[#1e2a45] rounded outline-none transition-colors py-1 cursor-text"
                  title="Click to type a number (up to 100)"
                />
              </div>
            </div>

            <div className={`grid transition-all duration-300 ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="relative h-4 w-full">
                  {/* Global Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 transition-all duration-300 ${(activeEditCell !== null || activeEditRow !== null) ? 'opacity-0 pointer-events-none scale-y-50' : 'opacity-100 scale-y-100'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold w-12 shrink-0">Syllbs</span>
                    <input 
                      type="range" 
                      min="1" 
                      max="9" 
                      value={syllables} 
                      onChange={(e) => setSyllables(parseInt(e.target.value))} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex justify-end">
                      <span className="w-full py-1 text-xs font-bold text-slate-300 text-right">{syllables}</span>
                    </div>
                  </div>

                  {/* Specific Bar Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 transition-all duration-300 ${activeEditRow !== null && activeEditCell === null ? 'opacity-100 scale-y-100 z-10' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-purple-400 font-bold w-12 shrink-0 truncate">Bar {activeEditRow !== null ? activeEditRow + 1 : ''}</span>
                    <input 
                      type="range" 
                      min="1" 
                      max="9" 
                      value={activeEditRow !== null ? (customSyllables[activeEditRow] || syllables) : 1} 
                      onChange={(e) => {
                        if (activeEditRow !== null) {
                          setCustomSyllables(prev => ({...prev, [activeEditRow]: parseInt(e.target.value)}));
                        }
                      }} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex items-center justify-end gap-0.5">
                      <span className="text-[11px] font-bold text-purple-300 text-right">{activeEditRow !== null ? (customSyllables[activeEditRow] || syllables) : ''}</span>
                      <button onClick={() => setActiveEditRow(null)} className="w-[14px] h-[14px] flex shrink-0 items-center justify-center rounded-full bg-purple-900/60 text-[8px] text-purple-300 hover:bg-purple-800 transition-colors">✕</button>
                    </div>
                  </div>

                  {/* Specific Cell Subdivisions Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 transition-all duration-300 ${activeEditCell !== null ? 'opacity-100 scale-y-100 z-20' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-purple-400 font-bold w-12 shrink-0 truncate">Divs</span>
                    <input 
                      type="range" 
                      min="1" 
                      max="9" 
                      value={activeEditCell !== null ? (customSubdivisions[activeEditCell] || 1) : 1} 
                      onChange={(e) => {
                        if (activeEditCell !== null) {
                          setCustomSubdivisions(prev => ({...prev, [activeEditCell]: parseInt(e.target.value)}));
                        }
                      }} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex items-center justify-end gap-0.5">
                      <span className="text-[11px] font-bold text-purple-300 text-right">{activeEditCell !== null ? (customSubdivisions[activeEditCell] || 1) : ''}</span>
                      <button onClick={() => setActiveEditCell(null)} className="w-[14px] h-[14px] flex shrink-0 items-center justify-center rounded-full bg-purple-900/60 text-[8px] text-purple-300 hover:bg-purple-800 transition-colors">✕</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          {/* Collapse Arrow Toggle */}
          <button 
            onClick={() => setIsPanelExpanded(!isPanelExpanded)}
            className="absolute bottom-0 left-4 translate-y-1/2 w-8 h-8 bg-[#1e2a45] rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-[#2c3d63] transition-colors shadow-lg border border-[#2f4066] z-30"
          >
            {isPanelExpanded ? <ChevronUp size={16} strokeWidth={3} /> : <ChevronDown size={16} strokeWidth={3} />}
          </button>
        </div>

        {/* Bars Grid: Auto-scrolls when playing, hides scrollbar, pages cleanly at exactly 10 */}
        <div 
          ref={gridRef}
          className={`relative flex flex-col gap-1.5 flex-1 overflow-y-auto overflow-x-hidden ${
          isPlaying 
            ? 'scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]' 
            : '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[#2f4066] [&::-webkit-scrollbar-thumb]:rounded-full'
        }`}>
          {Array.from({ length: isPlaying ? Math.max(bars, activePos.absR + displayScaleBars * 2) : bars }).map((_, absR) => {
            const rIdx = absR % bars;
            const rowSylls = customSyllables[rIdx] !== undefined ? customSyllables[rIdx] : syllables;
            const isCustom = customSyllables[rIdx] !== undefined;
            const rowMult = customMultipliers[rIdx] || 1;
            const effectiveUseFixedFlex = useFixedFlex || isPlaying;
            
            return (
            <div 
              key={absR} 
              ref={el => { rowRefs.current[absR] = el; }}
              className={`flex items-stretch bg-[#161f33] border border-[#23314f] min-h-0 relative ${
                displayScaleBars > 7 ? 'gap-1 p-1 rounded-lg' : 'gap-2 p-1.5 rounded-xl'
              } ${!effectiveUseFixedFlex ? 'flex-1' : ''}`}
              style={{
                flex: effectiveUseFixedFlex ? `0 0 calc((100% - ${(displayScaleBars - 1) * 6}px) / ${displayScaleBars})` : undefined
              }}
            >
              {/* Left Control Column */}
              <div className="flex flex-col gap-1 justify-center w-8 shrink-0">
                <button 
                  onClick={() => {
                    setCustomMultipliers(prev => {
                      const m = prev[rIdx] || 1;
                      const next = m === 1 ? 2 : (m === 2 ? 3 : 1);
                      if (next === 1) {
                        const copy = { ...prev };
                        delete copy[rIdx];
                        return copy;
                      }
                      return { ...prev, [rIdx]: next };
                    });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCustomMultipliers(prev => {
                      const copy = { ...prev };
                      delete copy[rIdx];
                      return copy;
                    });
                  }}
                  className={`relative flex-1 rounded-md border flex items-center justify-center text-[9px] font-bold min-h-[50%] transition-colors ${
                    rowMult === 1 
                      ? 'bg-[#1e2a45] border-[#2f4066] text-slate-300 hover:bg-[#253353] active:bg-[#1a253c]'
                      : rowMult === 2
                        ? 'bg-blue-900/40 border-blue-500/50 text-blue-300 shadow-[inset_0_1px_3px_rgba(59,130,246,0.1)]'
                        : 'bg-rose-900/40 border-rose-500/50 text-rose-300 shadow-[inset_0_1px_3px_rgba(244,63,94,0.1)]'
                  }`}
                >
                  <span className="absolute top-[2px] left-[3px] text-[7.5px] text-slate-500 font-mono pointer-events-none leading-none opacity-80">{rIdx + 1}</span>
                  x{rowMult}
                </button>
                <button 
                  onPointerDown={(e) => {
                    isHoldingRef.current = false;
                    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
                    holdTimerRef.current = window.setTimeout(() => {
                      isHoldingRef.current = true;
                      setActiveEditCell(null); // Clear any other active edits
                      setActiveEditRow(rIdx);
                      setCustomSyllables(prev => ({...prev, [rIdx]: prev[rIdx] ?? syllables}));
                    }, 400); // Trigger hold
                  }}
                  onPointerUp={() => {
                    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
                  }}
                  onPointerLeave={() => {
                    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
                  }}
                  onClick={() => {
                    if (isHoldingRef.current) return;
                    setCustomSyllables(prev => {
                      const current = prev[rIdx] !== undefined ? prev[rIdx] : syllables;
                      const next = current >= 9 ? 1 : current + 1;
                      return { ...prev, [rIdx]: next };
                    });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCustomSyllables(prev => {
                      const copy = { ...prev };
                      delete copy[rIdx];
                      return copy;
                    });
                  }}
                  className={`flex-1 rounded-md border flex items-center justify-center text-[10px] font-extrabold shadow-[inset_0_1px_3px_rgba(0,0,0,0.1)] min-h-[50%] transition-colors ${
                    isCustom
                      ? 'bg-purple-900/40 border-purple-500/50 shadow-[inset_0_1px_4px_rgba(168,85,247,0.2)] hover:bg-purple-900/50 text-purple-100' 
                      : 'bg-[#1e2a45] border-[#2f4066] text-slate-400 hover:bg-[#253353] active:bg-[#1a253c]'
                  } ${activeEditRow === rIdx ? 'ring-2 ring-purple-500 shadow-purple-500/30' : ''}`}
                >
                  {rowSylls}
                </button>
              </div>

              {/* Syllables ROW (Sebellions) */}
              <div className="flex flex-1 gap-1 items-stretch min-w-0">
                {Array.from({ length: rowSylls }).map((_, cIdx) => {
                  const checkKey = `${rIdx}-${cIdx}`;
                  const isAccent = accents.has(checkKey);
                  const isActive = isPlaying 
                      ? activePos.absR === absR && activePos.c === cIdx
                      : activePos.r === rIdx && activePos.c === cIdx;
                      
                  const subdivs = customSubdivisions[checkKey] || 1;
                  
                  let cellClasses = 'bg-[#1e2a45] border-[#2f4066] shadow-[0_2px_4px_rgba(0,0,0,0.2)] hover:bg-[#253353]';
                  if (isAccent) cellClasses = 'bg-purple-900/40 border-purple-500/50 shadow-[inset_0_1px_4px_rgba(168,85,247,0.2)] hover:bg-purple-900/50 text-purple-100';
                  if (isActive) cellClasses = 'bg-emerald-500/20 border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)] z-10 scale-[1.03] text-emerald-100';

                  return (
                    <button 
                      key={cIdx} 
                      onPointerDown={(e) => {
                        isHoldingRef.current = false;
                        if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
                        holdTimerRef.current = window.setTimeout(() => {
                          isHoldingRef.current = true;
                          setActiveEditRow(null); // Clear any other active edits
                          setActiveEditCell(checkKey);
                          setIsPanelExpanded(true); // Auto-expand panel to show slider
                          setCustomSubdivisions(prev => {
                            const current = prev[checkKey] || 1;
                            const next = current >= 9 ? 1 : current + 1;
                            return {...prev, [checkKey]: next};
                          });
                        }, 400); // Trigger hold
                      }}
                      onPointerUp={() => {
                        if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
                      }}
                      onPointerLeave={() => {
                        if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
                      }}
                      onClick={() => {
                        if (isHoldingRef.current) return;
                        toggleAccent(rIdx, cIdx);
                      }}
                      className={`flex-1 flex flex-col items-center justify-center border min-w-0 transition-all duration-75 ${
                        rowSylls > 7 ? 'rounded-md' : 'rounded-xl'
                      } ${cellClasses} ${activeEditCell === checkKey ? 'ring-2 ring-purple-500 z-20 shadow-purple-500/30' : ''}`}
                    >
                      <div className={`w-full h-full rounded-[inherit] overflow-hidden ${
                        subdivs === 1 ? 'flex items-center justify-center' :
                        subdivs === 2 ? 'grid grid-cols-1 grid-rows-2' :
                        subdivs === 3 ? 'grid grid-cols-1 grid-rows-3' :
                        subdivs === 4 ? 'grid grid-cols-2 grid-rows-2' :
                        subdivs <= 6 ? 'grid grid-cols-2 grid-rows-3' :
                        'grid grid-cols-3 grid-rows-3'
                      }`}>
                        {Array.from({length: subdivs}).map((_, i) => (
                          <span 
                            key={i}
                            className={`flex items-center justify-center w-full h-full min-w-0 overflow-hidden text-center px-px font-sans ${getSyllableStyles(rowSylls, subdivs)} ${
                              (isActive || isAccent) ? 'drop-shadow-md' : 'text-slate-300'
                            } ${subdivs > 1 ? 'border-[0.5px] border-[#2f4066]/50' : ''}`}
                          >
                            {subdivs > 1 ? (KONNAKOL_PYRAMID[subdivs]?.[i] || "Ta") : (KONNAKOL_PYRAMID[rowSylls]?.[cIdx] || "Ta")}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )})}
        </div>

        {/* Bottom Actions */}
        <div className="flex gap-3 mt-1 shrink-0 h-[60px]">
          {/* Randomizer */}
          <button 
            onClick={() => setRandomModeEnabled(prev => !prev)}
            className={`flex-1 rounded-xl border flex justify-center items-center transition-colors relative ${
              randomModeEnabled
                ? 'bg-blue-600/30 border-blue-400/60 shadow-[0_0_15px_rgba(59,130,246,0.3)] text-blue-200'
                : 'bg-[#161f33] border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c]'
            }`}
          >
            <Dices size={24} />
          </button>
          
          {/* First Beat Accent ("Ta") */}
          <button 
            onClick={() => setFirstBeatAccent(!firstBeatAccent)}
            className={`flex-1 rounded-xl flex justify-center items-center transition-all bg-[#161f33] ${
              firstBeatAccent 
                ? 'border border-purple-400 shadow-[0_0_15px_rgba(192,132,252,0.4)] text-purple-200' 
                : 'border border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c] active:bg-[#131b2c]'
            }`}
          >
            <span className="font-bold text-[22px] tracking-wide">Ta</span>
          </button>

          {/* Djembe (Syllables / Global Fill) */}
          <button 
            onClick={() => setOnlyAccents(!onlyAccents)}
            onContextMenu={(e) => e.preventDefault()}
            className={`flex-1 rounded-xl flex justify-center items-center transition-all touch-none select-none relative ${
              !onlyAccents 
                ? 'bg-purple-700/30 hover:bg-purple-700/40 active:bg-purple-700/20 text-purple-200 border border-purple-500/40' 
                : 'bg-[#161f33] border border-[#23314f] hover:bg-[#1a253c] active:bg-[#131b2c] text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className={`text-2xl drop-shadow-md transition-all duration-300 ${!onlyAccents ? 'opacity-100 scale-110' : 'opacity-70 grayscale-[30%] scale-100'}`}>🪘</span>
          </button>
        </div>

        {/* Play Button */}
        <div className="shrink-0 mb-2">
          <button 
            onClick={togglePlayback}
            className={`w-full py-4 rounded-xl font-black text-lg tracking-[0.2em] flex items-center justify-center gap-2 shadow-[0_8px_20px_rgba(16,185,129,0.2)] transition-all transform active:scale-[0.98] ${
              isPlaying 
                ? 'bg-rose-500 hover:bg-rose-400 active:bg-rose-600 shadow-rose-500/20 text-white' 
                : 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950'
            }`}
          >
            {isPlaying ? (
              <>■ STOP</>
            ) : (
              <><Play fill="currentColor" size={22} className="-ml-2" /> PLAY</>
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
