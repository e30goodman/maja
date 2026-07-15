import { BasePracticeSession } from './base-practice-session.js';
import { isValidChordTone, generateRandomChord, getBassRangeChordNotes } from './chord-utils.js';
import { updateStatsDisplay } from './ui-helpers.js';
import { 
    createSessionRecord, 
    validateSessionConfig, 
    noteToMidi 
} from './practice-utils.js';

/**
 * Chord practice session manager - handles chord tone recognition practice
 * Students must play all chord tones of a given chord before advancing
 */
export class ChordPracticeSession extends BasePracticeSession {
    constructor(options = {}) {
        super({
            sessionType: 'chord',
            ...options
        });
        
        // Chord training specific state
        this.chordTraining = {
            selectedChordTypes: [],
            fretLimit: 12,
            rootNotes: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
            currentChord: null,
            currentChordNotes: [],
            playedMidiTones: new Set(), // Track MIDI numbers of played chord tones
            requiredMidiTones: new Set(), // Required MIDI numbers for comparison
            originalChordTones: [] // Original chord tone names for display
        };
    }
    
    /**
     * Start a chord practice session
     * @param {Object} config - Chord training configuration
     * @param {Array<string>} config.chordTypes - Selected chord type suffixes
     * @param {number} config.fretLimit - Maximum fret limit
     * @param {Array<string>} config.rootNotes - Available root notes
     * @returns {boolean} - Success status
     */
    startSession(config) {
        if (!validateSessionConfig(config, ['chordTypes'])) {
            console.warn('ChordPracticeSession: Cannot start chord session without chord types');
            return false;
        }
        
        // Initialize session state
        this.initializeSessionState({ chordConfig: { ...config } });
        
        // Set chord training configuration
        this.setChordTrainingConfig(config);
        
        // Generate first chord
        this.generateNewChord();
        
        if (!this.chordTraining.currentChord || !this.chordTraining.currentChordNotes.length) {
            console.warn('ChordPracticeSession: Failed to generate valid chord');
            return false;
        }
        
        // Update displays 
        updateStatsDisplay(this.stats.correct, this.stats.incorrect);
        
        // Trigger session start
        const firstChord = this.chordTraining.currentChord;
        this.triggerSessionStart(firstChord, {
            sessionType: 'chord',
            currentChord: firstChord,
            chordNotes: this.chordTraining.currentChordNotes
        });
        
        return true;
    }
    
    /**
     * Configure chord training settings
     * @param {Object} config - Chord training configuration
     * @param {Array<string>} config.chordTypes - Selected chord type suffixes
     * @param {number} config.fretLimit - Maximum fret limit
     * @param {Array<string>} config.rootNotes - Available root notes
     */
    setChordTrainingConfig(config) {
        this.chordTraining = {
            ...this.chordTraining,
            ...config
        };
    }
    
    /**
     * Generate a new random chord for practice
     * @private
     */
    generateNewChord() {
        const { chordTypes, fretLimit, rootNotes } = this.chordTraining;
        
        // Generate random chord name
        const randomRoot = rootNotes[Math.floor(Math.random() * rootNotes.length)];
        const randomType = chordTypes[Math.floor(Math.random() * chordTypes.length)];
        const chordName = randomRoot + randomType;
        
        // Get bass range chord notes
        const chordNotes = getBassRangeChordNotes(chordName, fretLimit);
        
        if (chordNotes.length > 0) {
            this.chordTraining.currentChord = chordName;
            this.chordTraining.currentChordNotes = chordNotes;
            
            // Reset tracking for new chord
            this.chordTraining.playedMidiTones.clear();
            this.chordTraining.requiredMidiTones.clear();
            
            // Get original chord definition from Tonal.js for display names
            if (typeof Tonal !== 'undefined') {
                const chord = Tonal.Chord.get(chordName);
                this.chordTraining.originalChordTones = chord.notes || [];
                
                // Convert original chord tones to MIDI numbers for comparison
                this.chordTraining.originalChordTones.forEach(tone => {
                    const midiNumber = noteToMidi(tone);
                    if (midiNumber !== null) {
                        this.chordTraining.requiredMidiTones.add(midiNumber);
                    }
                });
            }
            
            console.log(`Generated chord: ${chordName}`);
            console.log(`Original chord tones: ${this.chordTraining.originalChordTones.join(', ')}`);
            console.log(`Required MIDI numbers: ${Array.from(this.chordTraining.requiredMidiTones).join(', ')}`);
        } else {
            console.warn(`Failed to generate valid chord notes for ${chordName}`);
        }
    }
    
    /**
     * Handle detected note in chord training mode
     * @param {Object} detectionResult - The detection result object from AudioEngine
     */
    handleDetectedNote(detectionResult) {
        if (!this.isActive) return;
        
        const currentChord = this.chordTraining.currentChord;
        const validChordNotes = this.chordTraining.currentChordNotes;
        
        if (!currentChord || !validChordNotes.length) return;
        
        // Extract note name from detection result
        const detectedNote = detectionResult.note.fullName;
        
        // Check if detected note is a valid chord tone
        const isCorrect = isValidChordTone(detectedNote, validChordNotes);
        
        // Record the attempt
        this.recordAttemptChord(currentChord, detectedNote, isCorrect, validChordNotes, detectionResult);
        
        // Update statistics and track chord progress
        if (isCorrect) {
            this.stats.correct++;
            
            // Convert played note to MIDI for tracking
            const playedMidi = noteToMidi(detectedNote);
            const wasNewChordTone = playedMidi !== null && !this.chordTraining.playedMidiTones.has(playedMidi);
            
            if (playedMidi !== null) {
                this.chordTraining.playedMidiTones.add(playedMidi);
            }
            
            if (this.callbacks.onCorrect) {
                this.callbacks.onCorrect(detectedNote, currentChord, wasNewChordTone);
            }
            
            // Check if all required chord tones have been played
            const allChordTonesPlayed = Array.from(this.chordTraining.requiredMidiTones)
                .every(midiNumber => this.chordTraining.playedMidiTones.has(midiNumber));
            
            console.log(`Played: ${detectedNote} (MIDI: ${playedMidi}), New: ${wasNewChordTone}`);
            console.log(`Progress: ${this.chordTraining.playedMidiTones.size}/${this.chordTraining.requiredMidiTones.size} chord tones`);
            
            // Only advance when all chord tones have been played
            if (allChordTonesPlayed) {
                console.log(`All chord tones completed! Advancing to next chord.`);
                this.advanceToNextChord();
            }
            
        } else {
            this.stats.incorrect++;
            if (this.callbacks.onIncorrect) {
                this.callbacks.onIncorrect(detectedNote, currentChord);
            }
        }
        
        // Update displays
        updateStatsDisplay(this.stats.correct, this.stats.incorrect);
    }
    
    /**
     * Record a chord training attempt
     * @param {string} targetChord - The target chord
     * @param {string} playedNote - The played note
     * @param {boolean} isCorrect - Whether the attempt was correct
     * @param {Array<string>} validNotes - Valid chord notes
     * @param {Object} detectionResult - The detection result with timing info
     * @private
     */
    recordAttemptChord(targetChord, playedNote, isCorrect, validNotes, detectionResult) {
        const record = createSessionRecord(
            targetChord,
            playedNote,
            isCorrect,
            this.currentTargetTimestamp,
            {
                targetChord: targetChord,
                validNotes: [...validNotes],
                sessionType: 'chord'
            },
            detectionResult.originalTimestamp
        );
        
        if (record) {
            this.stats.sessionRecords.push(record);
        }
    }
    
    /**
     * Advance to the next chord
     * @private
     */
    advanceToNextChord() {
        // Generate new chord
        this.generateNewChord();
        
        // Set new target timestamp
        this.setNewTargetTimestamp();
        
        // Trigger target change
        const newChord = this.chordTraining.currentChord;
        this.triggerTargetChange(newChord, {
            chordNotes: this.chordTraining.currentChordNotes,
            sessionType: 'chord'
        });
    }
    
    /**
     * Get current chord information
     * @returns {Object|null} - Current chord info or null
     */
    getCurrentChord() {
        if (!this.chordTraining.currentChord) {
            return null;
        }
        
        return {
            chord: this.chordTraining.currentChord,
            notes: [...this.chordTraining.currentChordNotes]
        };
    }
    
    /**
     * Get current target (chord name)
     * @returns {string|null} - Current chord name or null
     */
    getCurrentTarget() {
        return this.chordTraining.currentChord;
    }
    
    /**
     * Get chord progress information for UI display
     * @returns {Object|null} - Progress info or null
     */
    getChordProgress() {
        if (!this.chordTraining.currentChord) {
            return null;
        }
        
        // Use original chord tone names for display, but MIDI numbers for played status
        const originalTones = [...this.chordTraining.originalChordTones];
        const playedTones = [];
        const remainingTones = [];
        
        // Check each original chord tone to see if its MIDI equivalent has been played
        originalTones.forEach(tone => {
            const toneMidi = noteToMidi(tone);
            if (toneMidi !== null && this.chordTraining.playedMidiTones.has(toneMidi)) {
                playedTones.push(tone);
            } else {
                remainingTones.push(tone);
            }
        });
        
        return {
            chord: this.chordTraining.currentChord,
            requiredTones: originalTones,
            playedTones: playedTones,
            remainingTones: remainingTones,
            isComplete: remainingTones.length === 0,
            progress: playedTones.length / originalTones.length
        };
    }
    
    /**
     * Get chord tones with their status for UI display
     * @returns {Array<Object>|null} - Array of tone objects with status
     */
    getChordTonesWithStatus() {
        const progress = this.getChordProgress();
        if (!progress) return null;
        
        return progress.requiredTones.map(tone => ({
            tone: tone,
            played: progress.playedTones.includes(tone),
            remaining: progress.remainingTones.includes(tone)
        }));
    }
    
    /**
     * Get session summary with chord training support
     * @returns {Object} - Complete session summary
     */
    getSessionSummary() {
        // Get base session summary with metadata
        const summary = super.getSessionSummary();
        
        // Add chord training specific data
        summary.chordTraining = {
            ...this.chordTraining,
            totalChords: this.stats.sessionRecords.length > 0 ? 
                new Set(this.stats.sessionRecords.map(r => r.targetChord)).size : 0
        };
        
        return summary;
    }
    
    /**
     * Force advance to next chord (for testing or manual control)
     * @param {boolean} markAsCorrect - Whether to mark current as correct
     */
    forceAdvance(markAsCorrect = false) {
        if (!this.isActive) return;
        
        // Mark all remaining chord tones as played if marking as correct
        if (markAsCorrect) {
            this.chordTraining.requiredMidiTones.forEach(midiTone => {
                this.chordTraining.playedMidiTones.add(midiTone);
            });
            this.stats.correct++;
        } else {
            this.stats.incorrect++;
        }
        
        this.advanceToNextChord();
        updateStatsDisplay(this.stats.correct, this.stats.incorrect);
    }
}