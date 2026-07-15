import { PRACTICE_CONFIG } from './constants.js';
import { BasePracticeSession } from './base-practice-session.js';
import { generateNoteQueue, generateRandomNote, isCorrectNote } from './note-utils.js';
import { updateNoteQueue, updateStatsDisplay } from './ui-helpers.js';
import { createSessionRecord, validateSessionConfig } from './practice-utils.js';

/**
 * Chromatic practice session manager - handles traditional note-by-note practice
 * Uses a note queue system where students practice notes sequentially
 */
export class ChromaticPracticeSession extends BasePracticeSession {
    constructor(options = {}) {
        super({
            sessionType: 'chromatic',
            queueSize: PRACTICE_CONFIG.NOTE_QUEUE_SIZE,
            currentIndex: PRACTICE_CONFIG.CURRENT_NOTE_INDEX,
            ...options
        });
        
        // Chromatic-specific state
        this.notePool = [];
        this.noteQueue = [];
        this.currentIndex = this.options.currentIndex;
        this.notationStyle = 'simple'; // Default notation style
        this.scaleContext = null; // Scale context for scale notation

        // Audio engine for note playback
        this.audioEngine = null;
        this.autoPlayEnabled = true; // Enable auto-play by default
    }

    /**
     * Set the audio engine reference for note playback
     * @param {AudioEngine} audioEngine - The audio engine instance
     */
    setAudioEngine(audioEngine) {
        this.audioEngine = audioEngine;
    }

    /**
     * Enable or disable auto-play of current notes
     * @param {boolean} enabled - Whether to enable auto-play
     */
    setAutoPlayEnabled(enabled) {
        this.autoPlayEnabled = enabled;
    }
    
    /**
     * Start a chromatic practice session
     * @param {Array<string>} notePool - Array of note strings to practice
     * @param {Object} sessionMetadata - Additional session metadata
     * @returns {boolean} - Success status
     */
    startSession(notePool, sessionMetadata = {}) {
        if (!validateSessionConfig({ notePool }, ['notePool'])) {
            console.warn('ChromaticPracticeSession: Cannot start session with empty note pool');
            return false;
        }
        
        // Initialize session state
        this.initializeSessionState({
            notePool: [...notePool],
            ...sessionMetadata
        });

        // Set chromatic-specific state
        this.notePool = [...notePool];

        // Set notation style from session metadata
        this.notationStyle = sessionMetadata.notationStyle || 'simple';

        // Set scale context for scale notation
        this.scaleContext = sessionMetadata.scaleContext || null;

        // Generate initial note queue with notation style and scale context
        this.noteQueue = generateNoteQueue(this.notePool, this.options.queueSize, this.notationStyle, this.scaleContext);
        
        // Update displays
        this.updateDisplay();
        updateStatsDisplay(this.stats.correct, this.stats.incorrect);

        // Trigger session start
        const firstTarget = this.getCurrentTarget();
        this.triggerSessionStart(firstTarget, {
            notePool: this.notePool,
            firstTarget: firstTarget
        });

        // Auto-play the first note if enabled
        if (this.autoPlayEnabled && this.audioEngine && firstTarget) {
            this.playCurrentNote();
        }

        return true;
    }
    
    /**
     * Stop the chromatic practice session
     */
    stopSession() {
        // Clear chromatic-specific state
        this.noteQueue = [];
        this.notePool = [];
        this.notationStyle = 'simple';
        this.scaleContext = null;
        
        // Update display
        this.updateDisplay();
        
        // Call parent stop method
        super.stopSession();
    }
    
    /**
     * Handle a detected note - trusts AudioEngine's clear detection quality
     * @param {Object} detectionResult - The detection result object from AudioEngine
     */
    handleDetectedNote(detectionResult) {
        if (!this.isActive || !this.noteQueue.length) return;
        
        const currentTarget = this.getCurrentTarget();
        if (!currentTarget) return;
        
        // Extract note name and timing information
        const detectedNote = detectionResult.note.fullName;
        
        // AudioEngine already filtered for 'clear' detections, process immediately
        this.processDetectedNote(detectedNote, currentTarget, detectionResult);
    }
    
    /**
     * Process a validated detected note
     * @param {string} detectedNote - The detected note
     * @param {string} currentTarget - The current target note
     * @param {Object} detectionResult - The full detection result with timing info
     * @private
     */
    processDetectedNote(detectedNote, currentTarget, detectionResult) {
        const isCorrect = isCorrectNote(detectedNote, currentTarget);
        
        // Record the attempt with original timestamp for accurate timing
        this.recordAttempt(currentTarget, detectedNote, isCorrect, detectionResult);
        
        // Update statistics
        this.updateStats(isCorrect, detectedNote, currentTarget);
        
        // Advance to next note
        this.advanceToNextNote(isCorrect);
        
        // Update displays
        updateStatsDisplay(this.stats.correct, this.stats.incorrect);
    }
    
    /**
     * Record an attempt in session records
     * @param {string} targetNote - The target note
     * @param {string} playedNote - The played note
     * @param {boolean} isCorrect - Whether the attempt was correct
     * @param {Object} detectionResult - The detection result with timing info
     * @private
     */
    recordAttempt(targetNote, playedNote, isCorrect, detectionResult) {
        const record = createSessionRecord(
            targetNote, 
            playedNote, 
            isCorrect, 
            this.currentTargetTimestamp,
            { sessionType: 'chromatic' },
            detectionResult.originalTimestamp
        );
        
        if (record) {
            this.stats.sessionRecords.push(record);
        }
    }
    
    /**
     * Advance to the next note in the queue
     * @param {boolean} wasCorrect - Whether the last attempt was correct
     * @private
     */
    advanceToNextNote(wasCorrect) {
        if (!this.noteQueue.length) return;
        
        // Mark current note result
        if (this.noteQueue[this.currentIndex]) {
            this.noteQueue[this.currentIndex].result = wasCorrect ? 'correct' : 'incorrect';
        }
        
        // Remove first note and add new note at end
        this.noteQueue.shift();
        const lastNoteObj = this.noteQueue[this.noteQueue.length - 1];
        const newNote = generateRandomNote(this.notePool, lastNoteObj ? lastNoteObj.note : null, this.notationStyle, this.scaleContext);
        this.noteQueue.push({
            note: newNote,
            result: null
        });
        
        // Update display and set new target timestamp
        this.updateDisplay();
        this.setNewTargetTimestamp();
        
        // Trigger target change
        const newTarget = this.getCurrentTarget();
        this.triggerTargetChange(newTarget, { wasCorrect });

        // Auto-play the new target note if enabled (regardless of correctness)
        if (this.autoPlayEnabled && this.audioEngine && newTarget) {
            this.playCurrentNote();
        }
    }
    
    /**
     * Get the current target note
     * @returns {string|null} - Current target note or null
     */
    getCurrentTarget() {
        return this.noteQueue && this.noteQueue.length > this.currentIndex ?
            this.noteQueue[this.currentIndex].note : null;
    }

    /**
     * Play the current target note using the audio engine
     * @private
     */
    playCurrentNote() {
        if (!this.audioEngine || !this.autoPlayEnabled) return;

        const currentTarget = this.getCurrentTarget();
        if (!currentTarget) return;

        // Convert note to appropriate bass octave if needed
        const bassNote = this.convertNoteToBassRange(currentTarget);

        try {
            // Play note with short duration and moderate velocity
            this.audioEngine.playNote(bassNote, 0.8, 0.6);
            console.log(`Auto-playing current target note: ${bassNote}`);
        } catch (error) {
            console.warn('Failed to auto-play current note:', error);
        }
    }

    /**
     * Convert a note to an appropriate bass range (octaves 1-3)
     * @param {string} note - The note to convert (e.g., 'E4', 'A', 'G#2')
     * @returns {string} - Note in bass range (e.g., 'E2', 'A1', 'G#2')
     * @private
     */
    convertNoteToBassRange(note) {
        if (!note) return note;

        // Extract note name and octave
        const match = note.match(/^([A-G][#b]?)(\d*)$/);
        if (!match) return note;

        const [, noteName, octaveStr] = match;
        const octave = octaveStr ? parseInt(octaveStr, 10) : null;

        // If no octave specified, default to octave 2 for bass
        if (octave === null) {
            return `${noteName}2`;
        }

        // If octave is too high, bring it down to bass range
        if (octave > 3) {
            return `${noteName}2`;
        }

        // If octave is already in bass range (0-3), keep it
        return note;
    }
    
    /**
     * Update the note queue display
     * @private
     */
    updateDisplay() {
        // Get display options and bass config from session data
        const displayOptions = this.sessionData?.displayOptions || null;
        const bassConfig = this.sessionData?.bassConfig || null;

        updateNoteQueue(this.noteQueue, this.currentIndex, displayOptions, bassConfig);
    }
    
    /**
     * Get session summary with chromatic-specific data
     * @returns {Object} - Complete session summary
     */
    getSessionSummary() {
        // Get base session summary with metadata
        const summary = super.getSessionSummary();
        
        // Add chromatic-specific data
        summary.notePool = [...this.notePool];
        
        return summary;
    }
    
    /**
     * Get note pool for current session
     * @returns {Array<string>} - Current note pool
     */
    getNotePool() {
        return [...this.notePool];
    }
    
    /**
     * Get current note queue
     * @returns {Array<Object>} - Current note queue
     */
    getNoteQueue() {
        return [...this.noteQueue];
    }
    
    /**
     * Update note pool during active session (regenerates queue)
     * @param {Array<string>} newNotePool - New note pool
     * @returns {boolean} - Success status
     */
    updateNotePool(newNotePool) {
        if (!validateSessionConfig({ notePool: newNotePool }, ['notePool'])) {
            return false;
        }
        
        this.notePool = [...newNotePool];
        
        // If session is active, regenerate queue with new pool
        if (this.isActive) {
            // Preserve current note if it's in the new pool
            const currentTarget = this.getCurrentTarget();
            this.noteQueue = generateNoteQueue(this.notePool, this.options.queueSize, this.notationStyle, this.scaleContext);

            // If current target is still valid, try to keep it
            if (currentTarget && this.notePool.includes(currentTarget)) {
                this.noteQueue[this.currentIndex].note = currentTarget;
            }

            this.updateDisplay();
            this.setNewTargetTimestamp();
        }
        
        return true;
    }
    
    /**
     * Force advance to next note (for testing or manual control)
     * @param {boolean} markAsCorrect - Whether to mark current as correct
     */
    forceAdvance(markAsCorrect = false) {
        if (!this.isActive) return;
        
        this.advanceToNextNote(markAsCorrect);
        
        if (markAsCorrect) {
            this.stats.correct++;
        } else {
            this.stats.incorrect++;
        }
        
        updateStatsDisplay(this.stats.correct, this.stats.incorrect);
    }
}