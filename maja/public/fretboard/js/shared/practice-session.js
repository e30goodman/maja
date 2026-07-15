import { ChromaticPracticeSession } from './chromatic-practice-session.js';
import { ChordPracticeSession } from './chord-practice-session.js';

/**
 * Factory class for practice sessions - maintains backward compatibility
 * Automatically creates the appropriate session type based on configuration
 */
export class PracticeSession {
    constructor(options = {}) {
        // Determine session type from options
        const sessionType = options.sessionType || 'chromatic';
        
        // Create the appropriate session instance
        if (sessionType === 'chord') {
            this.session = new ChordPracticeSession(options);
        } else {
            this.session = new ChromaticPracticeSession(options);
        }
        
        // Store session type for easy access
        this.sessionType = sessionType;
    }
    
    // Delegate all methods to the underlying session instance
    
    /**
     * Set event target element for dispatching custom events
     * @param {HTMLElement} element - Element to dispatch events from
     */
    setEventTarget(element) {
        return this.session.setEventTarget(element);
    }
    
    /**
     * Set callback functions for session events
     * @param {Object} callbacks - Object with callback functions
     */
    setCallbacks(callbacks) {
        return this.session.setCallbacks(callbacks);
    }
    
    /**
     * Start a new practice session
     * @param {Array<string>} notePool - Array of note strings to practice (chromatic mode)
     * @param {Object} sessionMetadata - Additional session metadata (e.g., fretboardVisible)
     * @returns {boolean} - Success status
     */
    startSession(notePool, sessionMetadata = {}) {
        return this.session.startSession(notePool, sessionMetadata);
    }
    
    /**
     * Stop the current practice session
     */
    stopSession() {
        return this.session.stopSession();
    }
    
    /**
     * Handle a detected note - trusts AudioEngine's clear detection quality
     * @param {Object} detectionResult - The detection result object from AudioEngine
     */
    handleDetectedNote(detectionResult) {
        return this.session.handleDetectedNote(detectionResult);
    }
    
    /**
     * Get the current target note/chord
     * @returns {string|null} - Current target or null
     */
    getCurrentTarget() {
        return this.session.getCurrentTarget();
    }
    
    /**
     * Get current session statistics
     * @returns {Object} - Statistics object
     */
    getStats() {
        return this.session.getStats();
    }
    
    /**
     * Get session summary for end-of-session analysis
     * @returns {Object} - Complete session summary
     */
    getSessionSummary() {
        return this.session.getSessionSummary();
    }
    
    /**
     * Check if session is currently active
     * @returns {boolean} - Active status
     */
    isSessionActive() {
        return this.session.isSessionActive();
    }
    
    /**
     * Force advance to next target (for testing or manual control)
     * @param {boolean} markAsCorrect - Whether to mark current as correct
     */
    forceAdvance(markAsCorrect = false) {
        return this.session.forceAdvance(markAsCorrect);
    }
    
    /**
     * Reset session statistics without stopping the session
     */
    resetStats() {
        return this.session.resetStats();
    }

    /**
     * Set the audio engine reference for note playback (if supported by session type)
     * @param {AudioEngine} audioEngine - The audio engine instance
     */
    setAudioEngine(audioEngine) {
        if (this.session.setAudioEngine) {
            return this.session.setAudioEngine(audioEngine);
        }
    }

    /**
     * Enable or disable auto-play of current notes (if supported by session type)
     * @param {boolean} enabled - Whether to enable auto-play
     */
    setAutoPlayEnabled(enabled) {
        if (this.session.setAutoPlayEnabled) {
            return this.session.setAutoPlayEnabled(enabled);
        }
    }
    
    // ===== CHORD TRAINING METHODS (delegated) =====
    
    /**
     * Start a chord training session
     * @param {Object} config - Chord training configuration
     * @returns {boolean} - Success status
     */
    startChordSession(config) {
        // This method is specific to chord sessions
        if (this.sessionType !== 'chord') {
            console.warn('PracticeSession: startChordSession called on non-chord session');
            return false;
        }
        return this.session.startSession(config);
    }
    
    /**
     * Get current chord information
     * @returns {Object|null} - Current chord info or null
     */
    getCurrentChord() {
        if (this.sessionType !== 'chord') return null;
        return this.session.getCurrentChord();
    }
    
    /**
     * Get chord progress information for UI display
     * @returns {Object|null} - Progress info or null
     */
    getChordProgress() {
        if (this.sessionType !== 'chord') return null;
        return this.session.getChordProgress();
    }
    
    /**
     * Get chord tones with their status for UI display
     * @returns {Array<Object>|null} - Array of tone objects with status
     */
    getChordTonesWithStatus() {
        if (this.sessionType !== 'chord') return null;
        return this.session.getChordTonesWithStatus();
    }
    
    // ===== CHROMATIC TRAINING METHODS (delegated) =====
    
    /**
     * Get note pool for current session (chromatic mode only)
     * @returns {Array<string>} - Current note pool
     */
    getNotePool() {
        if (this.sessionType !== 'chromatic') return [];
        return this.session.getNotePool();
    }
    
    /**
     * Get current note queue (chromatic mode only)
     * @returns {Array<Object>} - Current note queue
     */
    getNoteQueue() {
        if (this.sessionType !== 'chromatic') return [];
        return this.session.getNoteQueue();
    }
    
    /**
     * Update note pool during active session (chromatic mode only)
     * @param {Array<string>} newNotePool - New note pool
     * @returns {boolean} - Success status
     */
    updateNotePool(newNotePool) {
        if (this.sessionType !== 'chromatic') return false;
        return this.session.updateNotePool(newNotePool);
    }
}