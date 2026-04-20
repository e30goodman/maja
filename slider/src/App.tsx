/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, useMotionValue, useSpring, PanInfo, AnimatePresence, useAnimationFrame } from 'motion/react';
import { 
  Settings,
  Activity,
  Play,
  Pause,
  Dices,
  Info
} from 'lucide-react';

// --- Constants ---
const MIN_BPM = 20;
const MAX_BPM = 480;

const SYLLABLES: Record<number, string[]> = {
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

export default function App() {
  const [bpm, setBpm] = useState(100);
  const [isDragging, setIsDragging] = useState(false);
  const [forceLabel, setForceLabel] = useState("");

  // Tactile Slider Physics - Softened for a smoother feel
  const x = useMotionValue(0);
  const springX = useSpring(x, { damping: 30, stiffness: 700, mass: 0.8 });
  const lastPulseRef = useRef(0);

  // Handle tempo logic
  useAnimationFrame(() => {
    const currentX = x.get();
    const absX = Math.abs(currentX);
    const sign = currentX > 0 ? 1 : -1;

    if (absX > 12) {
      let interval = 0, amount = 0, label = sign > 0 ? "+" : "-";
      if (absX <= 40) { interval = 400; amount = 1; label += "1"; }
      else if (absX <= 75) { interval = 220; amount = 5; label += "5"; }
      else { interval = 40; amount = 2; label = sign > 0 ? ">>>" : "<<<"; }
      
      if (forceLabel !== label) setForceLabel(label);

      const now = Date.now();
      if (now - lastPulseRef.current > interval) {
        setBpm(prev => Math.min(MAX_BPM, Math.max(MIN_BPM, prev + (amount * sign))));
        lastPulseRef.current = now;
      }
    } else {
      if (lastPulseRef.current !== 0) lastPulseRef.current = 0;
      if (forceLabel !== "") setForceLabel("");
    }
  });

  const handlePan = useCallback((_: any, info: PanInfo) => {
    const rawX = info.offset.x;
    const sign = rawX > 0 ? 1 : -1;
    const resistantX = sign * Math.min(Math.pow(Math.abs(rawX), 0.75) * 4, 110);
    x.set(resistantX);
  }, [x]);

  const handlePanEnd = useCallback(() => {
    setIsDragging(false);
    x.set(0);
  }, [x]);

  return (
    <div className="min-h-screen bg-[#0a0b14] text-[#e2e8f0] font-sans selection:bg-violet-500/30 flex items-center justify-center p-4">
      
      {/* --- Main Application Frame --- */}
      <div className="w-full max-w-[420px] bg-[#121320] border border-[#232435] rounded-[2.5rem] p-6 shadow-[0_32px_64px_rgba(0,0,0,0.6)] space-y-6 relative overflow-hidden">
        
        {/* Subtle background glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-48 bg-violet-600/5 blur-[80px] rounded-full pointer-events-none" />

        {/* --- Top Control Row --- */}
        <div className="grid grid-cols-[1fr_1.5fr_1fr] gap-3">
          <button className="h-16 rounded-2xl border border-[#232435] bg-[#1a1b2e] flex items-center justify-center text-slate-400 hover:text-white hover:bg-[#23243a] transition-all active:scale-95 shadow-lg">
            <Settings className="w-5 h-5" />
          </button>
          
          {/* Dynamic Switch: Tap button or BPM display */}
          <div className="h-16 rounded-2xl border border-[#232435] bg-[#1a1b2e] flex items-center justify-center overflow-hidden shadow-lg relative">
            {!isDragging ? (
              <button
                key="tap-button"
                className="w-full h-full bg-[#23243a] flex items-center justify-center group active:scale-95 transition-all outline-none"
              >
                <span className="text-slate-400 font-bold uppercase tracking-widest text-sm group-active:text-violet-400">Tap</span>
              </button>
            ) : (
              <div
                key="bpm-display"
                className="w-full h-full flex flex-col items-center justify-center bg-[#23243a]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-black text-white tabular-nums tracking-tighter">{Math.round(bpm)}</span>
                  <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest mt-1">bpm</span>
                </div>
                {forceLabel && (
                  <span 
                    key={forceLabel}
                    className="text-[9px] font-bold text-violet-400 uppercase tracking-tighter"
                  >
                    {forceLabel}
                  </span>
                )}
              </div>
            )}
          </div>
          
          <button 
            className="h-16 rounded-2xl border border-[#232435] bg-[#1a1b2e] flex items-center justify-center text-slate-400 hover:bg-[#23243a] transition-all active:scale-95 shadow-lg"
          >
            <div className="w-5 h-5 border-b-2 border-r-2 border-orange-500 rotate-45 transform -translate-y-1" />
          </button>
        </div>

        {/* --- Tempo Controller (The Force Engine) --- */}
        <div id="tempoControl" className="py-4">
          <div className="tempo-slider-row relative h-12 flex items-center px-1">
            
            {/* The Track */}
            <div className="absolute inset-x-0 h-2 bg-white/10 rounded-full" />

            {/* Tactile Handle Mechanism - Softened Pan */}
            <motion.div
              onPanStart={() => setIsDragging(true)}
              onPan={handlePan}
              onPanEnd={handlePanEnd}
              style={{ x: springX }}
              className="absolute left-1/2 -ml-6 z-10 cursor-grab active:cursor-grabbing"
            >
              <div className="w-12 h-6 bg-violet-500 rounded-full shadow-[0_0_20px_rgba(139,92,246,0.6)] border-2 border-white/20 flex items-center justify-center">
                <div className="w-1 h-2 bg-white/40 rounded-full" />
              </div>
            </motion.div>
          </div>
        </div>

      </div>

    </div>
  );
}
