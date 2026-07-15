import { PitchDetector } from './pitchy.js';
import { DebouncedNoteDetector } from './debounced-note-detector.js';

/**
 * Shared audio engine for bass note detection
 * Consolidates audio setup, pitch detection, and note analysis logic
 */
export class AudioEngine {
    constructor(options = {}) {
        // Audio context components
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.dataArray = null;
        this.pitchDetector = null;
        this.isDetecting = false;
        
        // Configuration options
        this.options = {
            // Audio context options
            sampleRate: 44100,
            fftSize: 4096,
            smoothingTimeConstant: 0.3,
            // Detection thresholds
            volumeThreshold: 0.001,
            clarityThreshold: 0.8,
            lowClarityThreshold: 0.65,
            // Debounced detector options
            consensusThreshold: 10,
            bufferSize: 20,
            interval: 25,
            timingMode: 'interval',
            ...options
        };
        
        // Audio stream reference for cleanup
        this.stream = null;
        
        // Detection callback
        this.onDetection = null;
        
        // Debounced note detector for robust consensus-based detection
        this.debouncedDetector = new DebouncedNoteDetector({
            volumeThreshold: this.options.volumeThreshold,
            clarityThreshold: this.options.lowClarityThreshold, // Use lower threshold to capture uncertain notes
            timingMode: this.options.timingMode,
            interval: this.options.interval,
            bufferSize: this.options.bufferSize,
            consensusThreshold: this.options.consensusThreshold
        });

        // Bass synthesizer components (initialized when needed)
        this.bassSynth = null;
        this.bassFilter = null;
        this.bassInitialized = false;
    }
    
    /**
     * Initialize audio context and microphone access
     * @returns {Promise<boolean>} Success status
     */
    async startDetection() {
        try {
            // Get microphone access with optimized settings for bass detection
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: this.options.sampleRate,
                    channelCount: 1,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            
            // Set up audio context
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            await this.audioContext.resume();
            
            // Create analyzer with bass-optimized settings
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = this.options.fftSize;
            this.analyser.smoothingTimeConstant = this.options.smoothingTimeConstant;
            
            // Connect microphone to analyzer
            this.microphone = this.audioContext.createMediaStreamSource(this.stream);
            this.microphone.connect(this.analyser);
            
            // Set up data array for time domain analysis
            this.dataArray = new Float32Array(this.analyser.fftSize);
            
            // Initialize pitch detector optimized for bass frequencies
            this.pitchDetector = PitchDetector.forFloat32Array(this.analyser.fftSize);
            
            // Start detection loop
            this.isDetecting = true;
            this.detectPitch();

            return true;
            
        } catch (error) {
            console.error('AudioEngine: Failed to start detection:', error);
            this.stopDetection();
            return false;
        }
    }
    
    /**
     * Stop audio detection and cleanup resources
     */
    stopDetection() {
        this.isDetecting = false;

        // Reset debounced detector buffer
        this.debouncedDetector.resetBuffer();
        this.debouncedDetector.lastConfirmedNote = null;

        // Clear any confirmed note
        if (this.debouncedDetector.onNoteCleared) {
            this.debouncedDetector.onNoteCleared();
        }

        // Stop microphone stream
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        // Disconnect audio nodes
        if (this.microphone) {
            this.microphone.disconnect();
            this.microphone = null;
        }
        
        if (this.analyser) {
            this.analyser.disconnect();
            this.analyser = null;
        }
        
        // Close audio context
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        
        // Clear data references
        this.dataArray = null;
        this.pitchDetector = null;

        // Clean up bass synthesizer
        this.cleanupBassSynth();
    }
    
    /**
     * Main pitch detection loop - runs continuously while detecting
     * Feeds detections to DebouncedNoteDetector for consensus and provides immediate callbacks
     * @private
     */
    detectPitch() {
        if (!this.isDetecting) return;

        // Get time domain data from analyzer
        this.analyser.getFloatTimeDomainData(this.dataArray);

        // Calculate RMS volume level for noise gate
        const rms = this.calculateRMS(this.dataArray);

        let noteForConsensus = null;
        let clarity = 0;
        let pitch = null;

        if (rms > this.options.volumeThreshold) {
            // Analyze pitch only when sufficient audio is present
            [pitch, clarity] = this.pitchDetector.findPitch(
                this.dataArray,
                this.audioContext.sampleRate
            );

            if (pitch && clarity > this.options.clarityThreshold) {
                // High clarity detection - trigger callback with note info
                const noteInfo = this.getNoteFromFrequency(pitch);
                if (noteInfo) {
                    noteForConsensus = noteInfo;
                    if (this.onDetection) {
                        const now = Date.now();
                        this.onDetection({
                            type: 'clear',
                            frequency: pitch,
                            clarity: clarity,
                            note: noteInfo,
                            rms: rms,
                            timestamp: now,
                            originalTimestamp: now,
                            detectionDelay: 0
                        });
                    }
                }
            } else if (pitch && clarity > this.options.lowClarityThreshold) {
                // Lower clarity detection - send to consensus but mark as uncertain
                const noteInfo = this.getNoteFromFrequency(pitch);
                if (noteInfo) {
                    noteForConsensus = noteInfo;
                }
                if (this.onDetection) {
                    const now = Date.now();
                    this.onDetection({
                        type: 'uncertain',
                        frequency: pitch,
                        clarity: clarity,
                        note: noteInfo,
                        rms: rms,
                        timestamp: now,
                        originalTimestamp: now,
                        detectionDelay: 0
                    });
                }
            } else {
                // No clear pitch detected but sound is present
                if (this.onDetection) {
                    const now = Date.now();
                    this.onDetection({
                        type: 'noise',
                        frequency: null,
                        clarity: clarity || 0,
                        note: null,
                        rms: rms,
                        timestamp: now,
                        originalTimestamp: now,
                        detectionDelay: 0
                    });
                }
            }
        } else {
            // No sound detected - silence
            if (this.onDetection) {
                const now = Date.now();
                this.onDetection({
                    type: 'silence',
                    frequency: null,
                    clarity: 0,
                    note: null,
                    rms: rms,
                    timestamp: now,
                    originalTimestamp: now,
                    detectionDelay: 0
                });
            }
        }

        // Feed detection to DebouncedNoteDetector for consensus
        this.debouncedDetector.addDetection(noteForConsensus, rms, clarity || 0);
        
        // Continue detection loop
        requestAnimationFrame(() => this.detectPitch());
    }
    
    /**
     * Calculate RMS (Root Mean Square) volume level
     * @param {Float32Array} dataArray Audio time domain data
     * @returns {number} RMS value
     * @private
     */
    calculateRMS(dataArray) {
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i] * dataArray[i];
        }
        return Math.sqrt(sum / dataArray.length);
    }
    
    /**
     * Convert frequency to musical note information
     * @param {number} frequency Frequency in Hz
     * @returns {Object|null} Note information object or null
     */
    getNoteFromFrequency(frequency) {
        if (!frequency || frequency < 30) return null;
        
        // Standard chromatic scale starting from C
        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        
        // Calculate note number (C0 = 0, C1 = 12, etc.) using A4 = 440Hz reference
        // Formula: note_num = 12 * log2(freq / 16.35) where C0 = 16.35Hz
        const noteNum = 12 * Math.log2(frequency / 16.35);
        const roundedNoteNum = Math.round(noteNum);
        const octave = Math.floor(roundedNoteNum / 12);
        const noteIndex = roundedNoteNum % 12;
        
        // Calculate the exact frequency for this note
        const targetFrequency = 16.35 * Math.pow(2, roundedNoteNum / 12);
        
        // Calculate cents deviation (100 cents = 1 semitone)
        const centsDeviation = Math.round(1200 * Math.log2(frequency / targetFrequency));
        
        return {
            name: notes[noteIndex],
            octave: octave,
            fullName: notes[noteIndex] + octave,
            frequency: frequency,
            targetFrequency: targetFrequency,
            centsDeviation: centsDeviation,
            isSharp: centsDeviation > 5,
            isFlat: centsDeviation < -5,
            isInTune: Math.abs(centsDeviation) <= 5
        };
    }
    
    /**
     * Set callback function for immediate detection results
     * For consensus-based detections, listen to debouncedDetector.onNoteDetected directly
     * @param {Function} callback Function to call with detection results
     */
    setDetectionCallback(callback) {
        this.onDetection = callback;
    }
    
    /**
     * Check if audio detection is currently active
     * @returns {boolean} Detection status
     */
    isActive() {
        return this.isDetecting;
    }
    
    /**
     * Update configuration options
     * @param {Object} newOptions Options to update
     */
    updateOptions(newOptions) {
        this.options = { ...this.options, ...newOptions };
        
        // Update analyzer if it exists
        if (this.analyser) {
            if (newOptions.smoothingTimeConstant !== undefined) {
                this.analyser.smoothingTimeConstant = this.options.smoothingTimeConstant;
            }
        }
    }
    
    /**
     * Get current audio context sample rate
     * @returns {number|null} Sample rate in Hz
     */
    getSampleRate() {
        return this.audioContext ? this.audioContext.sampleRate : null;
    }
    
    /**
     * Get current RMS volume level (last calculated)
     * @returns {number} Current volume level
     */
    getCurrentVolume() {
        if (!this.dataArray) return 0;
        return this.calculateRMS(this.dataArray);
    }

    /**
     * Initialize bass synthesizer components
     * Creates a clean bass guitar sound using triangle wave with AD envelope
     * @private
     */
    initBassSynth() {
        if (this.bassInitialized || typeof Tone === 'undefined') {
            return;
        }

        try {
            // Start Tone.js audio context
            if (Tone.context.state !== 'running') {
                Tone.start();
            }

            // Create bass synthesizer with sawtooth wave
            this.bassSynth = new Tone.Synth({
                oscillator: {
                    type: 'sawtooth'  // Rich harmonic content for bass
                },
                envelope: {
                    attack: 0.001,  // Very fast attack for punchy bass
                    decay: 2.5,     // Longer decay for natural bass sustain
                    sustain: 0,     // No sustain for AD envelope
                    release: 0.1    // Quick release
                },
                volume: 0           // 0dB volume
            });

            // Create low-pass filter for bass character
            this.bassFilter = new Tone.Filter({
                frequency: 300,     // Lower cutoff for deep bass
                type: 'lowpass',
                rolloff: -12        // Gentler rolloff
            });

            // Create EQ without bass boost
            const bassEQ = new Tone.EQ3({
                low: 0,           // Flat low frequencies
                mid: 3,           // Flat mid frequencies
                high: -6.5        // Cut high frequencies
            });

            // Connect the chain: Synth -> Filter -> EQ -> Output (no compressor)
            this.bassSynth
                .chain(this.bassFilter, bassEQ, Tone.Destination);

            this.bassInitialized = true;
            console.log('Bass synthesizer initialized successfully');

        } catch (error) {
            console.error('Failed to initialize bass synthesizer:', error);
        }
    }

    /**
     * Play a bass note with clean bass guitar sound
     * @param {string} note - Note name (e.g., 'E2', 'A1', 'G3')
     * @param {number} duration - Note duration in seconds (default: 1.0)
     * @param {number} velocity - Note velocity 0-1 (default: 0.7)
     * @returns {boolean} Success status
     */
    async playNote(note, duration = 1.0, velocity = 0.7) {
        try {
            // Initialize bass synth if needed
            if (!this.bassInitialized) {
                this.initBassSynth();
                await new Promise(resolve => setTimeout(resolve, 100)); // Brief delay for initialization
            }

            if (!this.bassSynth || !this.bassInitialized) {
                console.warn('Bass synthesizer not available');
                return false;
            }

            // Ensure Tone.js context is running
            if (Tone.context.state !== 'running') {
                await Tone.start();
            }

            // Validate note format (should be like 'E2', 'A1', etc.)
            if (typeof note !== 'string' || !/^[A-G][#b]?[0-9]$/.test(note)) {
                console.warn('Invalid note format:', note);
                return false;
            }

            // Set volume based on velocity
            this.bassSynth.volume.value = Tone.gainToDb(velocity);

            // Trigger the note with AD envelope
            this.bassSynth.triggerAttackRelease(note, duration);

            console.log(`Playing bass note: ${note} for ${duration}s at velocity ${velocity}`);
            return true;

        } catch (error) {
            console.error('Failed to play bass note:', error);
            return false;
        }
    }

    /**
     * Stop all currently playing bass notes
     */
    stopAllNotes() {
        if (this.bassSynth && this.bassInitialized) {
            this.bassSynth.triggerRelease();
        }
    }

    /**
     * Clean up bass synthesizer resources
     * @private
     */
    cleanupBassSynth() {
        if (this.bassSynth) {
            this.bassSynth.dispose();
            this.bassSynth = null;
        }
        if (this.bassFilter) {
            this.bassFilter.dispose();
            this.bassFilter = null;
        }
        this.bassInitialized = false;
    }
}