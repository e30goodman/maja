import { EVENTS } from './constants.js';
import { dispatchCustomEvent } from './ui-helpers.js';
import { 
    createEmptyStats, 
    resetStats, 
    calculateSessionStats,
    createSessionSummary,
    generateSessionId
} from './practice-utils.js';

/**
 * Base class for all practice sessions
 * Contains common functionality shared between different session types
 */
export class BasePracticeSession {
    constructor(options = {}) {
        // Configuration
        this.options = {
            sessionType: 'base',
            ...options
        };
        
        // Session state
        this.isActive = false;
        this.sessionId = null;
        this.currentTargetTimestamp = null;
        
        // Session type
        this.sessionType = this.options.sessionType;
        
        // Statistics
        this.stats = createEmptyStats();
        
        // Event callbacks
        this.callbacks = {
            onCorrect: null,
            onIncorrect: null,
            onTargetChange: null,
            onSessionStart: null,
            onSessionEnd: null
        };
        
        // DOM element reference for events
        this.eventTarget = null;
    }
    
    /**
     * Set event target element for dispatching custom events
     * @param {HTMLElement} element - Element to dispatch events from
     */
    setEventTarget(element) {
        this.eventTarget = element;
    }
    
    /**
     * Set callback functions for session events
     * @param {Object} callbacks - Object with callback functions
     */
    setCallbacks(callbacks) {
        this.callbacks = { ...this.callbacks, ...callbacks };
    }
    
    /**
     * Initialize session state
     * @param {Object} sessionData - Session-specific initialization data
     * @protected
     */
    initializeSessionState(sessionData = {}) {
        this.isActive = true;
        this.sessionId = generateSessionId();
        this.stats = {
            ...createEmptyStats(),
            startTime: Date.now()
        };
        this.currentTargetTimestamp = Date.now();
        
        // Store session metadata
        this.sessionData = sessionData;
        
        console.log(`Session ${this.sessionId} initialized:`, sessionData);
    }
    
    /**
     * Stop the current practice session
     */
    stopSession() {
        if (!this.isActive) return;
        
        this.isActive = false;
        this.currentTargetTimestamp = null;
        
        // Get session summary before cleanup
        const sessionSummary = this.getSessionSummary();
        
        // Trigger callbacks and events
        if (this.callbacks.onSessionEnd) {
            this.callbacks.onSessionEnd(sessionSummary);
        }
        
        if (this.eventTarget) {
            dispatchCustomEvent(this.eventTarget, EVENTS.PRACTICE_STOPPED, {
                summary: sessionSummary
            });
        }
        
        console.log(`Session ${this.sessionId} stopped`);
    }
    
    /**
     * Update session statistics
     * @param {boolean} isCorrect - Whether the attempt was correct
     * @param {string} detectedNote - The detected note
     * @param {string} currentTarget - The current target
     * @protected
     */
    updateStats(isCorrect, detectedNote, currentTarget) {
        if (isCorrect) {
            this.stats.correct++;
            if (this.callbacks.onCorrect) {
                this.callbacks.onCorrect(detectedNote, currentTarget);
            }
        } else {
            this.stats.incorrect++;
            if (this.callbacks.onIncorrect) {
                this.callbacks.onIncorrect(detectedNote, currentTarget);
            }
        }
    }
    
    /**
     * Set new target timestamp (called when target changes)
     * @protected
     */
    setNewTargetTimestamp() {
        this.currentTargetTimestamp = Date.now();
    }
    
    /**
     * Trigger target change callbacks and events
     * @param {string} newTarget - The new target
     * @param {Object} additionalData - Additional event data
     * @protected
     */
    triggerTargetChange(newTarget, additionalData = {}) {
        // Trigger target change callbacks
        if (this.callbacks.onTargetChange) {
            this.callbacks.onTargetChange(newTarget);
        }
        
        if (this.eventTarget) {
            dispatchCustomEvent(this.eventTarget, EVENTS.TARGET_CHANGED, {
                newTarget: newTarget,
                sessionType: this.sessionType,
                ...additionalData
            });
        }
    }
    
    /**
     * Trigger session start callbacks and events
     * @param {string} firstTarget - The first target
     * @param {Object} additionalData - Additional event data
     * @protected
     */
    triggerSessionStart(firstTarget, additionalData = {}) {
        if (this.callbacks.onSessionStart) {
            this.callbacks.onSessionStart(firstTarget);
        }
        
        if (this.eventTarget) {
            dispatchCustomEvent(this.eventTarget, EVENTS.PRACTICE_STARTED, {
                sessionType: this.sessionType,
                firstTarget: firstTarget,
                ...additionalData
            });
        }
    }
    
    /**
     * Get current session statistics
     * @returns {Object} - Statistics object
     */
    getStats() {
        return calculateSessionStats(this.stats);
    }
    
    /**
     * Get session summary for end-of-session analysis
     * Must be implemented by subclasses to include session-specific data
     * @returns {Object} - Complete session summary
     * @abstract
     */
    getSessionSummary() {
        const summary = createSessionSummary(this.stats, this.sessionType);
        
        // Include session metadata in summary
        if (this.sessionData) {
            summary.metadata = this.sessionData;
        }
        
        return summary;
    }
    
    /**
     * Check if session is currently active
     * @returns {boolean} - Active status
     */
    isSessionActive() {
        return this.isActive;
    }
    
    /**
     * Reset session statistics without stopping the session
     */
    resetStats() {
        resetStats(this.stats);
        
        // Update displays if there's a helper function for it
        if (typeof updateStatsDisplay === 'function') {
            updateStatsDisplay(this.stats.correct, this.stats.incorrect);
        }
    }
    
    /**
     * Force advance to next target (for testing or manual control)
     * Must be implemented by subclasses
     * @param {boolean} markAsCorrect - Whether to mark current as correct
     * @abstract
     */
    forceAdvance(markAsCorrect = false) {
        throw new Error('forceAdvance() must be implemented by subclasses');
    }
    
    /**
     * Handle detected note - main entry point for note detection
     * Must be implemented by subclasses
     * @param {Object} detectionResult - The detection result object from AudioEngine
     * @abstract
     */
    handleDetectedNote(detectionResult) {
        throw new Error('handleDetectedNote() must be implemented by subclasses');
    }
    
    /**
     * Start a practice session
     * Must be implemented by subclasses  
     * @param {any} config - Session-specific configuration
     * @returns {boolean} - Success status
     * @abstract
     */
    startSession(config) {
        throw new Error('startSession() must be implemented by subclasses');
    }
}