import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Play, Pause } from 'lucide-react';

// --- Types & Constants ---
type Speed = 1 | 2 | 3 | 4;

interface Note {
  id: string;
  group: 1 | 2 | 3;
  syllable: string;
  beatOffset: number;
  isFirstOfGroup: boolean;
  isFirstOfSubdivision: boolean;
}

const SCHEDULE_AHEAD_TIME = 0.1; // seconds

/** Неактивный слог: почти чёрный фон, едва заметная рамка и приглушённый текст (не «кричит» при счёте). */
const CELL_IDLE = 'bg-[#090a0c] text-[#4e525c] border-[#101218] hover:border-[rgba(148,122,39,0.22)]';

/**
 * Ведущая «Ta» без акцента: на чуть-чуть светлее неактивных — лёгкий холодный оттенок, без яркого голубого.
 */
const LEAD_IDLE_SUBTLE: { color: string; borderColor: string; backgroundColor: string } = {
  color: '#5a616c',
  borderColor: 'rgba(130, 142, 158, 0.16)',
  backgroundColor: 'rgba(255, 255, 255, 0.035)',
};

function getLeadIdleStyle(
  note: Note,
  isActive: boolean,
  hasAccent: boolean,
): React.CSSProperties | undefined {
  if (!note.isFirstOfSubdivision || isActive || hasAccent) return undefined;
  return {
    color: LEAD_IDLE_SUBTLE.color,
    borderColor: LEAD_IDLE_SUBTLE.borderColor,
    backgroundColor: LEAD_IDLE_SUBTLE.backgroundColor,
  };
}

// --- Helper Functions ---
const generateSequence = (speed1: Speed, speed2: Speed, speed3: Speed): Note[] => {
  const seq: Note[] = [];
  let offset = 0;

  // Group 1 (3 beats)
  const g1Syllables = ["Ta", "ki", "ta"];
  for (let i = 0; i < speed1; i++) {
    for (let j = 0; j < 3; j++) {
      seq.push({
        id: `g1-${i}-${j}`,
        group: 1,
        syllable: g1Syllables[j],
        beatOffset: offset,
        isFirstOfGroup: i === 0 && j === 0,
        isFirstOfSubdivision: j === 0
      });
      offset += 3 / (3 * speed1); // 1 / speed1
    }
  }

  // Group 2 (3 beats)
  const g2Syllables = ["Ta", "ki", "ta"];
  for (let i = 0; i < speed2; i++) {
    for (let j = 0; j < 3; j++) {
      seq.push({
        id: `g2-${i}-${j}`,
        group: 2,
        syllable: g2Syllables[j],
        beatOffset: offset,
        isFirstOfGroup: i === 0 && j === 0,
        isFirstOfSubdivision: j === 0
      });
      offset += 3 / (3 * speed2); // 1 / speed2
    }
  }

  // Group 3 (2 beats)
  const g3Syllables = ["Ta", "ka"];
  for (let i = 0; i < speed3; i++) {
    for (let j = 0; j < 2; j++) {
      seq.push({
        id: `g3-${i}-${j}`,
        group: 3,
        syllable: g3Syllables[j],
        beatOffset: offset,
        isFirstOfGroup: i === 0 && j === 0,
        isFirstOfSubdivision: j === 0
      });
      offset += 2 / (2 * speed3); // 1 / speed3
    }
  }

  return seq;
};

// --- Main Component ---
export default function App() {
  const [bpm, setBpm] = useState<number>(120);
  const [speed1, setSpeed1] = useState<Speed>(1);
  const [speed2, setSpeed2] = useState<Speed>(1);
  const [speed3, setSpeed3] = useState<Speed>(1);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [accents, setAccents] = useState<Record<string, boolean>>({
    'g1-0-0': true,
    'g2-0-0': true,
    'g3-0-0': true
  });
  /** Временный масштаб всего UI (1 = 100%). */
  const [uiScale, setUiScale] = useState(1);

  // Refs for audio and timing
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const bpmRef = useRef(bpm);
  const sequenceRef = useRef<Note[]>([]);
  const currentNoteIndexRef = useRef(0);
  const nextNoteTimeRef = useRef(0);
  const visualQueueRef = useRef<{ id: string; time: number }[]>([]);
  const animationFrameRef = useRef<number | null>(null);

  const accentsRef = useRef(accents);

  // Update refs when state changes to avoid stale closures in the worker/scheduler
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { accentsRef.current = accents; }, [accents]);

  const toggleAccent = (id: string) => {
    setAccents(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const sequence = useMemo(() => generateSequence(speed1, speed2, speed3), [speed1, speed2, speed3]);

  // Handle sequence changes smoothly while playing
  useEffect(() => {
    if (sequenceRef.current.length > 0) {
      const oldOffset = sequenceRef.current[currentNoteIndexRef.current]?.beatOffset || 0;
      let newIdx = sequence.findIndex(n => n.beatOffset >= oldOffset);
      if (newIdx === -1) newIdx = 0;
      currentNoteIndexRef.current = newIdx;
    }
    sequenceRef.current = sequence;
  }, [sequence]);

  // Initialize Web Worker for robust timing (runs even in background tabs)
  useEffect(() => {
    const workerCode = `
      let timerID = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          timerID = setInterval(() => postMessage('tick'), 25);
        } else if (e.data === 'stop') {
          clearInterval(timerID);
          timerID = null;
        }
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    workerRef.current = new Worker(URL.createObjectURL(blob));

    workerRef.current.onmessage = (e) => {
      if (e.data === 'tick') {
        scheduler();
      }
    };

    return () => {
      workerRef.current?.terminate();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  // --- Audio Engine ---
  const scheduleNote = useCallback((index: number, time: number) => {
    const note = sequenceRef.current[index];
    visualQueueRef.current.push({ id: note.id, time: time });

    const ctx = audioCtxRef.current;
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    // Synthesize old-school dark metronome clicks
    let decay = 0.03; // Very short click
    let type: OscillatorType = 'triangle'; // Triangle gives a nice dull click

    let startFreq = 300;
    let endFreq = 100;
    let volume = 0.5;

    // Differentiate by accent
    const isAccented = accentsRef.current[note.id];
    if (isAccented) {
      startFreq = 500;
      endFreq = 120;
      volume = 0.9;
      decay = 0.04;
    } else {
      startFreq = 250;
      endFreq = 80;
      volume = 0.4;
      decay = 0.02;
    }

    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume, time + 0.002); // very fast attack
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);

    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + decay);

    osc.start(time);
    osc.stop(time + decay);
  }, []);

  const advanceNote = useCallback(() => {
    const seq = sequenceRef.current;
    const currentNote = seq[currentNoteIndexRef.current];
    const nextIndex = (currentNoteIndexRef.current + 1) % seq.length;
    const nextNote = seq[nextIndex];

    let durationInBeats = nextNote.beatOffset - currentNote.beatOffset;
    if (durationInBeats <= 0) {
      durationInBeats += 8; // Total cycle is 8 beats (3 + 3 + 2)
    }

    const secondsPerBeat = 60.0 / bpmRef.current;
    nextNoteTimeRef.current += durationInBeats * secondsPerBeat;
    currentNoteIndexRef.current = nextIndex;
  }, []);

  const scheduler = useCallback(() => {
    if (!audioCtxRef.current) return;
    while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + SCHEDULE_AHEAD_TIME) {
      scheduleNote(currentNoteIndexRef.current, nextNoteTimeRef.current);
      advanceNote();
    }
  }, [scheduleNote, advanceNote]);

  // --- Visual Sync ---
  const drawLoop = useCallback(() => {
    if (!audioCtxRef.current) return;
    const currentTime = audioCtxRef.current.currentTime;
    let lastPlayed: { id: string; time: number } | null = null;

    while (visualQueueRef.current.length > 0 && visualQueueRef.current[0].time <= currentTime) {
      lastPlayed = visualQueueRef.current.shift() || null;
    }

    if (lastPlayed) {
      setActiveNoteId(lastPlayed.id);
    }

    animationFrameRef.current = requestAnimationFrame(drawLoop);
  }, []);

  // --- Controls ---
  const togglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      workerRef.current?.postMessage('stop');
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      setActiveNoteId(null);
    } else {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      setIsPlaying(true);
      currentNoteIndexRef.current = 0;
      nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.05;
      visualQueueRef.current = [];
      workerRef.current?.postMessage('start');
      drawLoop();
    }
  };

  // --- UI Render Helpers ---
  const renderSpeedSelector = (group: 1 | 2 | 3, currentSpeed: Speed, setter: (s: Speed) => void) => (
    <div className="flex gap-1 bg-[#0C0D10] p-1 rounded-md">
      {([1, 2, 3, 4] as Speed[]).map((s) => (
        <button
          key={s}
          onClick={() => setter(s)}
          className={`flex-1 bg-transparent border-none py-1.5 px-2 text-[10px] font-mono cursor-pointer rounded transition-colors ${
            currentSpeed === s
              ? 'bg-[#252830] text-[#D4AF37]'
              : 'text-[#888B94] hover:bg-[#252830]/50'
          }`}
        >
          {s}X
        </button>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0C0D10] text-[#E0E0E0] font-sans flex flex-col items-center overflow-y-auto">
      <div
        className="w-full max-w-[360px] min-h-screen flex flex-col gap-3 p-3 pb-4"
        style={{ transform: `scale(${uiScale})`, transformOrigin: 'top center' }}
      >
        <nav className="text-center">
          <a
            href="../index.html"
            className="text-[10px] font-mono text-[#888B94] hover:text-[#D4AF37] transition-colors underline-offset-2 hover:underline"
          >
            ← Multi-bar metronome
          </a>
        </nav>

        {/* Header */}
        <header className="text-center border-b border-[#252830] pb-3 pt-1">
          <h1 className="text-[14px] uppercase tracking-[0.3em] text-[#D4AF37] mb-1 font-bold">
            Konnakol
          </h1>
          <p className="text-[10px] text-[#888B94] font-mono">
            3-3-2 ADI TALAM
          </p>
        </header>

        {/* 3-3-2 Grid Visualization */}
        <main className="flex flex-col gap-3 flex-1 justify-center">
          
          {/* Group 1 (3 Beats) */}
          <section className="bg-[#1A1C22] rounded-xl p-3.5 border border-[#252830] flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <h2 className="font-mono text-[10px] text-[#888B94] uppercase">Group 1</h2>
              <span className="text-[20px] font-light text-[#D4AF37] leading-none">3</span>
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {sequence.filter(n => n.group === 1).map((note) => (
                <div
                  key={note.id}
                  onClick={() => toggleAccent(note.id)}
                  style={getLeadIdleStyle(note, activeNoteId === note.id, Boolean(accents[note.id]))}
                  className={`flex items-center justify-center min-w-[2.2rem] py-1.5 px-1 rounded text-[11px] font-mono font-medium transition-all duration-150 cursor-pointer select-none border ${
                    activeNoteId === note.id
                      ? 'bg-[#D4AF37] text-[#0C0D10] shadow-[0_0_15px_#D4AF37] border-transparent'
                      : accents[note.id]
                        ? 'bg-[#252830] text-[#E0E0E0] border-[#947A27]'
                        : CELL_IDLE
                  }`}
                >
                  {note.syllable}
                </div>
              ))}
            </div>
            {renderSpeedSelector(1, speed1, setSpeed1)}
          </section>

          {/* Group 2 (3 Beats) */}
          <section className="bg-[#1A1C22] rounded-xl p-3.5 border border-[#252830] flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <h2 className="font-mono text-[10px] text-[#888B94] uppercase">Group 2</h2>
              <span className="text-[20px] font-light text-[#D4AF37] leading-none">3</span>
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {sequence.filter(n => n.group === 2).map((note) => (
                <div
                  key={note.id}
                  onClick={() => toggleAccent(note.id)}
                  style={getLeadIdleStyle(note, activeNoteId === note.id, Boolean(accents[note.id]))}
                  className={`flex items-center justify-center min-w-[2.2rem] py-1.5 px-1 rounded text-[11px] font-mono font-medium transition-all duration-150 cursor-pointer select-none border ${
                    activeNoteId === note.id
                      ? 'bg-[#D4AF37] text-[#0C0D10] shadow-[0_0_15px_#D4AF37] border-transparent'
                      : accents[note.id]
                        ? 'bg-[#252830] text-[#E0E0E0] border-[#947A27]'
                        : CELL_IDLE
                  }`}
                >
                  {note.syllable}
                </div>
              ))}
            </div>
            {renderSpeedSelector(2, speed2, setSpeed2)}
          </section>

          {/* Group 3 (2 Beats) */}
          <section className="bg-[#1A1C22] rounded-xl p-3.5 border border-[#252830] flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <h2 className="font-mono text-[10px] text-[#888B94] uppercase">Group 3</h2>
              <span className="text-[20px] font-light text-[#D4AF37] leading-none">2</span>
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {sequence.filter(n => n.group === 3).map((note) => (
                <div
                  key={note.id}
                  onClick={() => toggleAccent(note.id)}
                  style={getLeadIdleStyle(note, activeNoteId === note.id, Boolean(accents[note.id]))}
                  className={`flex items-center justify-center min-w-[2.2rem] py-1.5 px-1 rounded text-[11px] font-mono font-medium transition-all duration-150 cursor-pointer select-none border ${
                    activeNoteId === note.id
                      ? 'bg-[#D4AF37] text-[#0C0D10] shadow-[0_0_15px_#D4AF37] border-transparent'
                      : accents[note.id]
                        ? 'bg-[#252830] text-[#E0E0E0] border-[#947A27]'
                        : CELL_IDLE
                  }`}
                >
                  {note.syllable}
                </div>
              ))}
            </div>
            {renderSpeedSelector(3, speed3, setSpeed3)}
          </section>

        </main>

        {/* Global Controls */}
        <footer className="flex flex-col gap-4 pt-4 border-t border-[#252830] mt-auto">
          <div className="flex justify-between items-center w-full px-2">
            <div className="flex flex-col items-start gap-1">
              <span className="text-[10px] uppercase text-[#888B94] tracking-[0.1em]">Tempo</span>
              <span className="text-[36px] font-extralight font-mono text-[#E0E0E0] leading-none">{bpm}</span>
            </div>
            
            <button
              onClick={togglePlay}
              className="w-[60px] h-[60px] shrink-0 rounded-full bg-[#D4AF37] border-none flex items-center justify-center cursor-pointer shadow-[0_0_30px_rgba(212,175,55,0.2)] hover:scale-105 transition-transform"
            >
              {isPlaying ? (
                <Pause className="w-7 h-7 text-[#0C0D10] fill-current" />
              ) : (
                <Play className="w-7 h-7 text-[#0C0D10] fill-current ml-1" />
              )}
            </button>
          </div>

          <div className="w-full px-2 pb-2">
            <input
              type="range"
              min="40"
              max="240"
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
              className="w-full h-1 bg-[#252830] rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
            />
          </div>

          <div className="w-full px-2 pb-1 flex flex-col gap-1">
            <div className="flex justify-between text-[10px] uppercase text-[#888B94] tracking-[0.1em]">
              <span>UI scale</span>
              <span className="font-mono tabular-nums">{Math.round(uiScale * 100)}%</span>
            </div>
            <input
              type="range"
              min="75"
              max="125"
              step="5"
              value={Math.round(uiScale * 100)}
              onChange={(e) => setUiScale(Number(e.target.value) / 100)}
              className="w-full h-1 bg-[#252830] rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
            />
          </div>
        </footer>

      </div>
    </div>
  );
}
