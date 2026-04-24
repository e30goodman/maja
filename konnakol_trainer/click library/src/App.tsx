import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import { ChevronDown, ChevronLeft, Activity, Settings, Eraser, Play, Square, Dice1, Volume2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { engine } from './audio/engine';
import { MOVEMENT_SOUNDS, SoundConfig } from './audio/sounds';

// ==========================================
// 1. CONSTANTS & TYPES
// ==========================================
const STORAGE_KEY_SOUND = 'APP_CLICK_SOUND_ID';
const DEBUG_SOUND_OVERRIDES = 'DEBUG_SOUND_OVERRIDES_1';

// ==========================================
// 2. CHILD COMPONENT: BOTTOM SHEET SELECTOR
// ==========================================
// Mapped as React.memo for performance (as requested in architecture rules)
const SoundSelectorGrid = memo(({ 
  onClose, 
  selectedId, 
  onSelect 
}: { 
  onClose: () => void;
  selectedId: string;
  onSelect: (id: string) => void;
}) => {
  return (
    <motion.div
      key="selector"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2 }}
      className="bg-[#101421] border border-[#1f2438] rounded-2xl p-4 flex flex-col w-full h-full"
    >
      {/* Header */}
      <header className="flex items-center justify-between mb-4 shrink-0">
        <button 
          onClick={onClose}
          className="w-8 h-8 rounded-lg bg-[#131722] border border-[#1f2438] flex items-center justify-center text-[#5b6385] hover:text-[#c0c5db] hover:bg-[#1a2030] transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="font-bold text-[11px] uppercase tracking-wider text-[#a4abc5]">Select Click</span>
        <div className="w-8 h-8" /> {/* Spacer for symmetry */}
      </header>

      {/* Grid Container */}
      <div className="flex-1 overflow-y-auto no-scrollbar pb-2">
        <div className="grid grid-cols-3 gap-2.5">
          {MOVEMENT_SOUNDS.map((sound) => {
            const isSelected = sound.id === selectedId;
            return (
              <button
                key={sound.id}
                onClick={() => onSelect(sound.id)}
                className={`relative flex flex-col items-center justify-center p-3 min-h-[64px] rounded-xl border transition-all duration-200 ${
                  isSelected 
                    ? 'bg-[#181d2e] border-[#8a2be2] text-[#d6d9e6] shadow-[0_0_10px_-2px_rgba(138,43,226,0.25)]' 
                    : 'bg-[#111520] border-transparent hover:bg-[#151a28] hover:border-[#2a3048] text-[#7e87a2]'
                }`}
              >
                <span className={`text-[10px] font-semibold truncate w-full text-center leading-tight`}>
                  {sound.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}, (prev, next) => prev.selectedId === next.selectedId);


// ==========================================
// 3. MAIN APP (Orchestrator Mock)
// ==========================================
export default function App() {
  // --- Persistent State ---
  const [selectedSoundId, setSelectedSoundId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY_SOUND) || MOVEMENT_SOUNDS[0].id
  );
  
  // --- Local UI State ---
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(120);
  
  // Debug overrides
  const [overrides, setOverrides] = useState<Record<string, Partial<SoundConfig>>>(() => {
    try {
      const saved = localStorage.getItem(DEBUG_SOUND_OVERRIDES);
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  });

  const previewTimeoutRef = useRef<number | null>(null);

  const clearPreview = useCallback(() => {
    if (previewTimeoutRef.current) {
      window.clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  }, []);

  // Sync to local storage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_SOUND, selectedSoundId);
    engine.setBpm(bpm);
  }, [selectedSoundId, bpm]);

  // Derived state
  const activeBaseSound = MOVEMENT_SOUNDS.find(s => s.id === selectedSoundId) || MOVEMENT_SOUNDS[0];
  const rawOverrides = overrides[activeBaseSound.id] || {};
  const activeSound: SoundConfig = { 
    ...activeBaseSound, 
    ...rawOverrides,
    volumeAccent: rawOverrides.volumeAccent ?? activeBaseSound.volumeAccent ?? activeBaseSound.volume,
    volumeAlt: rawOverrides.volumeAlt ?? activeBaseSound.volumeAlt ?? activeBaseSound.volume,
    decayAccent: rawOverrides.decayAccent ?? activeBaseSound.decayAccent ?? activeBaseSound.decay,
    decayAlt: rawOverrides.decayAlt ?? activeBaseSound.decayAlt ?? activeBaseSound.decay,
    noiseFreqAccent: rawOverrides.noiseFreqAccent ?? activeBaseSound.noiseFreqAccent ?? activeBaseSound.noiseFreq,
    altNoiseFreq: rawOverrides.altNoiseFreq ?? activeBaseSound.altNoiseFreq ?? activeBaseSound.noiseFreq,
  };
  const activeIndex = MOVEMENT_SOUNDS.findIndex(s => s.id === selectedSoundId);

  // Apply override to engine if it changes while playing
  useEffect(() => {
    engine.updateConfig(activeSound);
  }, [activeSound]);

  const handleOverrideChange = (key: keyof SoundConfig, value: number) => {
    setOverrides(prev => {
      const newOverrides = {
        ...prev,
        [activeBaseSound.id]: {
          ...(prev[activeBaseSound.id] || {}),
          [key]: value
        }
      };
      localStorage.setItem(DEBUG_SOUND_OVERRIDES, JSON.stringify(newOverrides));
      return newOverrides;
    });
  };

  // Playback control
  const togglePlay = useCallback(() => {
    clearPreview();
    if (isPlaying) {
      engine.stop();
      setIsPlaying(false);
    } else {
      engine.play(activeSound);
      setIsPlaying(true);
    }
  }, [isPlaying, activeSound, clearPreview]);

  const handleCloseMenu = useCallback(() => {
    setIsSelectorOpen(false);
    // Останавливаем тестовый звук если основной не был запущен
    if (!isPlaying) {
      clearPreview();
      engine.stop();
    }
  }, [isPlaying, clearPreview]);

  // Handle sound selection (preview + set)
  const handleSelectSound = useCallback((id: string) => {
    setSelectedSoundId(id);
    const sound = MOVEMENT_SOUNDS.find(s => s.id === id);
    if (sound) {
      // Immediately fetch overrides for the newly selected sound to play it correctly
      let overridesData: Record<string, Partial<SoundConfig>> = {};
      try {
        const saved = localStorage.getItem(DEBUG_SOUND_OVERRIDES);
        if (saved) overridesData = JSON.parse(saved);
      } catch (e) {}
      
      const soundToPlay = { ...sound, ...(overridesData[id] || {}) };
      engine.play(soundToPlay); 
      
      if (!isPlaying) {
        clearPreview();
        // Временно убрали авто-стоп, теперь предпросмотр зациклен бесконечно
      }
    }
  }, [isPlaying, bpm, clearPreview]);

  // Mock stopping cleanup
  useEffect(() => {
    return () => {
      clearPreview();
      engine.stop();
    }
  }, [clearPreview]);

  return (
    // Outer container mapping to your app's dark style
    <div className="min-h-screen bg-[#07090e] text-slate-200 font-sans flex items-center justify-center p-4 selection:bg-[#8a2be2]/30">
      
      {/* Mobile-sized Mock Device Frame */}
      <div className="w-full max-w-[400px] h-full sm:h-[820px] bg-[#0c101a] rounded-[2rem] border border-[#1a1f33] shadow-2xl flex flex-col relative overflow-hidden">
        
        {/* ... */}
        {/* Mock Header and Randomizer mapping ... */}
        <header className="px-6 pt-8 pb-4 flex items-center justify-between z-10 bg-[#0c101a]">
          <button className="w-10 h-10 rounded-xl bg-[#131722] border border-[#1f2438] flex items-center justify-center text-[#5b6385] hover:text-[#c0c5db]">
            <Settings className="w-5 h-5" />
          </button>
          <div className="flex-1 mx-4 bg-[#131722] border border-[#1f2438] rounded-xl py-2 flex items-center justify-center">
             <span className="font-semibold text-[#d6d9e6]">Tap</span>
          </div>
          <button className="w-10 h-10 rounded-xl bg-[#131722] border border-[#1f2438] flex items-center justify-center text-[#5b6385] hover:text-[#c0c5db]">
            <Eraser className="w-5 h-5" />
          </button>
        </header>

        {/* Main Area */}
        <main className="flex-1 overflow-hidden px-5 pb-24 z-0 flex flex-col relative w-full h-full">
          <AnimatePresence mode="wait">
            {!isSelectorOpen ? (
              <motion.div 
                key="controls"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.2 }}
                className="w-full h-full flex flex-col space-y-4 overflow-y-auto no-scrollbar"
              >
                {/* Randomizer Panel */}
                <div className="bg-[#101421] border border-[#1f2438] rounded-2xl p-4 shrink-0">
                  <div className="flex justify-between items-center mb-4">
                     <div className="flex items-center gap-2">
                       <Dice1 className="w-4 h-4 text-[#a78bfa]" />
                       <h2 className="text-xs font-bold uppercase tracking-wider text-[#a4abc5]">Randomizer</h2>
                     </div>
                     <span className="text-[10px] text-[#5b6385] font-mono">3edf7e3</span>
                  </div>

                  <div className="space-y-4 mt-8">
                    {/* === THE INTEGRATION POINT === */}
                    <div className="flex items-center justify-between">
                       <h3 className="text-[11px] font-bold uppercase tracking-wider text-[#a4abc5] flex-shrink-0">Click Sound</h3>
                       
                       <button 
                        onClick={() => setIsSelectorOpen(true)}
                        className="bg-[#131722] border border-[#1f2438] hover:bg-[#1a2030] hover:border-[#2a3048] px-3 py-1.5 rounded-lg flex items-center transition-all group"
                       >
                          <span className="text-[#a4abc5] text-xs font-medium group-hover:text-[#d6d9e6] transition-colors line-clamp-1 text-center">
                            {activeSound.name}
                          </span>
                       </button>
                    </div>
                    {/* =========================================== */}
                    
                    {/* Extra mock row just for visual balance */}
                    <div className="w-full h-px bg-[#1f2438]/50 my-6" />
                    <button className="w-full py-2.5 rounded-lg bg-[#0e1721] border border-[#122822] text-[#2db281] text-xs font-bold">
                      Potato Mode
                    </button>
                  </div>
                </div>

                {/* Mock Sequencer Area */}
                <div className="bg-[#101421] border border-[#1f2438] rounded-2xl p-4 h-64 shrink-0 flex items-center justify-center text-[#2a3048] font-mono text-xs mb-4">
                  [ Grid / Sequencer Area ]
                </div>
              </motion.div>
            ) : (
              <SoundSelectorGrid 
                key="selector"
                onClose={handleCloseMenu}
                selectedId={selectedSoundId}
                onSelect={handleSelectSound}
              />
            )}
          </AnimatePresence>
        </main>

        {/* Global Bottom Play Bar */}
        <div className="absolute bottom-6 left-5 right-5">
           <button 
            onClick={togglePlay}
             className={`w-full py-4 rounded-xl font-black tracking-widest text-[#070a0e] text-sm uppercase flex items-center justify-center gap-2 transition-transform active:scale-95 ${
               isPlaying ? 'bg-[#ff4e65] shadow-[0_0_20px_rgba(255,78,101,0.3)]' : 'bg-[#1bc68b] shadow-[0_0_20px_rgba(27,198,139,0.2)]'
             }`}
           >
             {isPlaying ? <Square className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
             {isPlaying ? 'Stop' : 'Play'}
           </button>
        </div>
      </div>

      {/* DEBUG TUNER (OUTSIDE DEVICE) */}
      <div className="hidden sm:flex flex-col ml-8 w-[350px] bg-[#0c101a] border border-[#ffaa00]/30 rounded-[2rem] p-6 shadow-2xl h-[820px] overflow-y-auto no-scrollbar">
        <div className="flex items-center justify-between mb-8">
          <h3 className="text-[#ffaa00] font-bold text-sm uppercase tracking-wider">Debug Tuner</h3>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                setOverrides(prev => {
                  const newOverrides = { ...prev };
                  delete newOverrides[activeBaseSound.id];
                  localStorage.setItem(DEBUG_SOUND_OVERRIDES, JSON.stringify(newOverrides));
                  return newOverrides;
                });
              }}
              className="text-[#ff4e65] hover:text-[#ff7a8a] text-[10px] font-bold uppercase tracking-widest px-2 py-1 border border-[#ff4e65]/30 hover:bg-[#ff4e65]/10 rounded transition-colors cursor-pointer"
            >
              Reset
            </button>
            <span className="text-[#a4abc5] text-xs bg-[#1a2030] px-3 py-1 rounded-md font-mono">{activeSound.id}</span>
          </div>
        </div>
        
        <div className="space-y-6">
          {(() => {
             const renderSlider = (label: string, key: keyof SoundConfig, min: number, max: number, step: number) => {
               const val = (activeSound as any)[key] ?? 0;
               const isVolDecay = key.startsWith('volume') || key.startsWith('decay');
               
               return (
                 <div key={key} className="flex flex-col space-y-2 mb-4">
                   <div className="flex justify-between text-[11px] text-[#7e87a2] font-mono">
                     <span>{label}</span>
                     <span className="text-[#d6d9e6] font-bold">{Number(val).toFixed(isVolDecay ? 3 : 0)}</span>
                   </div>
                   <input 
                     type="range" 
                     min={min} max={max} step={step} 
                     value={val || 0}
                     onChange={e => handleOverrideChange(key, parseFloat(e.target.value))}
                     className="w-full accent-[#ffaa00] h-1.5 bg-[#1a2030] rounded-full appearance-none outline-none cursor-pointer"
                   />
                 </div>
               );
             };

             const showTone = activeBaseSound.baseFreq > 0;
             const showNoise = !!activeBaseSound.noise;

             return (
               <>
                 {/* VOICE 1: ACCENT */}
                 <div>
                   <h4 className="text-[10px] font-bold text-[#a4abc5] uppercase tracking-widest border-b border-[#1f2438] pb-1.5 mb-3">Accent</h4>
                   {renderSlider('Volume', 'volumeAccent', 0, 3, 0.1)}
                   {renderSlider('Decay', 'decayAccent', 0.001, 0.3, 0.001)}
                   {showTone && renderSlider('Tone Freq', 'accentFreq', 50, 16000, 10)}
                   {showNoise && renderSlider('Noise Freq', 'noiseFreqAccent', 500, 16000, 100)}
                 </div>

                 {/* VOICE 2: SECOND ACCENT (Alt) */}
                 <div>
                   <h4 className="text-[10px] font-bold text-[#a4abc5] uppercase tracking-widest border-b border-[#1f2438] pb-1.5 mb-3">Second Accent</h4>
                   {renderSlider('Volume', 'volumeAlt', 0, 3, 0.1)}
                   {renderSlider('Decay', 'decayAlt', 0.001, 0.3, 0.001)}
                   {showTone && renderSlider('Tone Freq', 'altFreq', 50, 16000, 10)}
                   {showNoise && renderSlider('Noise Freq', 'altNoiseFreq', 500, 16000, 100)}
                 </div>

                 {/* VOICE 3: PASSIVE (Base) */}
                 <div>
                   <h4 className="text-[10px] font-bold text-[#a4abc5] uppercase tracking-widest border-b border-[#1f2438] pb-1.5 mb-3">Passive</h4>
                   {renderSlider('Volume', 'volume', 0, 3, 0.1)}
                   {renderSlider('Decay', 'decay', 0.001, 0.3, 0.001)}
                   {showTone && renderSlider('Tone Freq', 'baseFreq', 50, 16000, 10)}
                   {showNoise && renderSlider('Noise Freq', 'noiseFreq', 500, 16000, 100)}
                 </div>
               </>
             )
          })()}
        </div>
        
        <div className="mt-8 pt-6 border-t border-[#1f2438] text-xs text-[#5b6385] leading-relaxed">
          * Changes are auto-saved to localStorage. When you are done configuring the sounds, click the button below to save them directly to <br/><br/><strong className="text-[#a4abc5] font-mono bg-[#1a2030] px-1 py-0.5 rounded">src/audio/tuned-sounds.json</strong>.
        </div>
        
        <button 
          onClick={async () => {
            try {
              const res = await fetch('/api/save-tuning', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(overrides, null, 2)
              });
              const json = await res.json();
              if (res.ok) {
                alert(`Успешно сохранено!\nФайл: src/audio/tuned-sounds.json`);
              } else {
                alert('Ошибка сервера: ' + json.message);
              }
            } catch (err) {
              alert('Ошибка сети при вызове /api/save-tuning. Сервер запущен?');
            }
          }}
          className="mt-6 w-full py-3 rounded-xl bg-[#ffaa00] text-[#070a0e] font-bold text-xs uppercase tracking-widest hover:bg-[#ffb732] transition-colors shadow-[0_0_15px_rgba(255,170,0,0.3)]"
        >
          Save to Source Files
        </button>
      </div>
    </div>
  );
}
