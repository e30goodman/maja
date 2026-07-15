/**
 * Shared utility functions for practice sessions
 * Used by both chromatic and chord practice sessions
 */

/**
 * Convert note name to MIDI number for reliable enharmonic comparison
 * @param {string} noteString - Note name like "Eb" or "D#2"
 * @returns {number|null} - MIDI number or null if conversion fails
 */
export function noteToMidi(noteString) {
    if (typeof Tonal === 'undefined') {
        console.warn('Tonal.js not available for MIDI conversion');
        return null;
    }
    
    // Remove octave number if present and add standard octave 4 for conversion
    const noteName = noteString.replace(/\d+$/, '');
    return Tonal.Note.midi(noteName + '4');
}

/**
 * Calculate average response time from session records
 * @param {Array<Object>} sessionRecords - Array of session record objects
 * @returns {number} - Average response time in milliseconds
 */
export function calculateAverageResponseTime(sessionRecords) {
    if (!sessionRecords || !sessionRecords.length) return 0;
    
    const totalTime = sessionRecords.reduce(
        (sum, record) => sum + (record.responseTime || 0), 0
    );
    return Math.round(totalTime / sessionRecords.length);
}

/**
 * Live response-time stats for the practice HUD
 * - last: previous attempt (any)
 * - best: fastest correct response in this session (record)
 * - avg: running average of correct responses
 * @param {Array<Object>} sessionRecords
 * @returns {{ last: number|null, best: number|null, avg: number|null }}
 */
export function getLiveResponseTimeStats(sessionRecords) {
    if (!sessionRecords || !sessionRecords.length) {
        return { last: null, best: null, avg: null };
    }

    const lastRaw = sessionRecords[sessionRecords.length - 1]?.responseTime;
    const last = Number.isFinite(lastRaw) && lastRaw > 0 ? lastRaw : null;

    const correctTimes = sessionRecords
        .map((r) => r.responseTime)
        .filter((t, i) => sessionRecords[i].isCorrect && Number.isFinite(t) && t > 0);

    if (!correctTimes.length) {
        return { last, best: null, avg: null };
    }

    const best = Math.min(...correctTimes);
    const avg = Math.round(correctTimes.reduce((sum, t) => sum + t, 0) / correctTimes.length);
    return { last, best, avg };
}

/**
 * Format response time for compact HUD display
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatResponseTime(ms) {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return '--';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Create a session record entry
 * @param {string} targetNote - The target note
 * @param {string} playedNote - The played note  
 * @param {boolean} isCorrect - Whether the attempt was correct
 * @param {number} targetTimestamp - When the target was set
 * @param {Object} extraData - Additional data specific to session type
 * @param {number} detectionTimestamp - When the note was actually detected (optional, defaults to Date.now())
 * @returns {Object} - Session record object
 */
export function createSessionRecord(targetNote, playedNote, isCorrect, targetTimestamp, extraData = {}, detectionTimestamp = null) {
    if (!targetTimestamp) return null;
    
    const actualDetectionTime = detectionTimestamp || Date.now();
    
    return {
        timestamp: targetTimestamp,
        targetNote: targetNote,
        playedNote: playedNote,
        isCorrect: isCorrect,
        responseTime: actualDetectionTime - targetTimestamp,
        detectionTimestamp: actualDetectionTime,
        ...extraData
    };
}

/**
 * Calculate session statistics from current stats object
 * @param {Object} stats - Stats object with correct, incorrect counts and records
 * @returns {Object} - Statistics summary
 */
export function calculateSessionStats(stats) {
    const total = stats.correct + stats.incorrect;
    const accuracy = total > 0 ? Math.round((stats.correct / total) * 100) : 0;
    const sessionDuration = stats.startTime ? Date.now() - stats.startTime : 0;
    
    return {
        correct: stats.correct,
        incorrect: stats.incorrect,
        total: total,
        accuracy: accuracy,
        sessionDuration: sessionDuration,
        averageResponseTime: calculateAverageResponseTime(stats.sessionRecords)
    };
}

/**
 * Initialize session statistics object
 * @returns {Object} - Fresh stats object
 */
export function createEmptyStats() {
    return {
        correct: 0,
        incorrect: 0,
        startTime: null,
        sessionRecords: []
    };
}

/**
 * Reset session statistics while preserving structure
 * @param {Object} stats - Stats object to reset
 * @returns {Object} - Reset stats object
 */
export function resetStats(stats) {
    stats.correct = 0;
    stats.incorrect = 0;
    stats.startTime = Date.now();
    stats.sessionRecords = [];
    return stats;
}

/**
 * Create a complete session summary
 * @param {Object} stats - Current session statistics
 * @param {string} sessionType - Type of session ('chromatic' or 'chord')
 * @param {Object} sessionData - Session-specific data (notePool, chordTraining, etc.)
 * @returns {Object} - Complete session summary
 */
export function createSessionSummary(stats, sessionType, sessionData = {}) {
    const baseSummary = {
        ...calculateSessionStats(stats),
        sessionType: sessionType,
        records: [...stats.sessionRecords],
        endTime: Date.now()
    };
    
    // Add session-specific data
    return { ...baseSummary, ...sessionData };
}

/**
 * Validate session configuration
 * @param {Object} config - Session configuration object
 * @param {Array<string>} requiredFields - Required configuration fields
 * @returns {boolean} - Whether configuration is valid
 */
export function validateSessionConfig(config, requiredFields) {
    if (!config || typeof config !== 'object') return false;
    
    return requiredFields.every(field => {
        const value = config[field];
        if (Array.isArray(value)) {
            return value.length > 0;
        }
        return value !== undefined && value !== null;
    });
}

/**
 * Generate a unique session ID
 * @returns {string} - Unique session identifier
 */
export function generateSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}