/**
 * Fretboard Utilities
 * Common utilities for fretboard initialization, management, and modal creation
 */

/**
 * Default fretboard configuration
 */
const DEFAULT_CONFIG = {
    width: 1000,
    height: 150,
    numFrets: 12
};

/**
 * Initialize a main fretboard instance
 * @param {string} containerId - ID of the container element
 * @param {Object} config - Optional configuration override
 * @param {Object} bassConfig - Optional bass configuration from bass-configurations.js
 * @returns {Object} - Fretboard instance (when BassFretboard is available)
 */
export function initializeFretboard(containerId, config = {}, bassConfig = null) {
    if (typeof BassFretboard === 'undefined') {
        console.warn('BassFretboard not available. Make sure bass-fretboard.js is loaded.');
        return null;
    }

    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    if (bassConfig) {
        finalConfig.bassConfig = bassConfig;
    }
    return new BassFretboard(containerId, finalConfig);
}

/**
 * Create a modal fretboard instance with responsive sizing
 * @param {string} containerId - ID of the modal container element
 * @param {number} fretLimit - Maximum number of frets to display
 * @param {Object} bassConfig - Optional bass configuration from bass-configurations.js
 * @returns {Object} - Modal fretboard instance
 */
export function createModalFretboard(containerId, fretLimit = 12, bassConfig = null) {
    if (typeof BassFretboard === 'undefined') {
        console.warn('BassFretboard not available for modal creation.');
        return null;
    }

    const modalWidth = Math.min(window.innerWidth * 0.9, 1000);
    const modalHeight = Math.min(window.innerHeight * 0.4, 200);

    const config = {
        width: modalWidth,
        height: modalHeight,
        numFrets: fretLimit
    };

    if (bassConfig) {
        config.bassConfig = bassConfig;
    }

    return new BassFretboard(containerId, config);
}

/**
 * Update fretboard with new fret limit by reinitializing
 * @param {string} containerId - ID of the container element
 * @param {number} fretLimit - New fret limit (capped at 20)
 * @param {Object} additionalConfig - Additional configuration options
 * @param {Object} bassConfig - Optional bass configuration from bass-configurations.js
 * @returns {Object} - New fretboard instance
 */
export function updateFretboardLimit(containerId, fretLimit, additionalConfig = {}, bassConfig = null) {
    if (typeof BassFretboard === 'undefined') {
        console.warn('BassFretboard not available for limit update.');
        return null;
    }

    const numFrets = Math.min(fretLimit, 24); // Cap at 24 frets to match configurations
    const config = {
        ...DEFAULT_CONFIG,
        numFrets: numFrets,
        ...additionalConfig
    };

    if (bassConfig) {
        config.bassConfig = bassConfig;
    }

    return new BassFretboard(containerId, config);
}

/**
 * Clear fretboard selection safely
 * @param {Object} fretboard - Fretboard instance
 */
export function clearFretboardSelection(fretboard) {
    if (fretboard && typeof fretboard.clearSelection === 'function') {
        fretboard.clearSelection();
    }
}

/**
 * Highlight chord notes on fretboard
 * @param {Object} fretboard - Fretboard instance
 * @param {string[]} notes - Array of note names to highlight
 */
export function highlightNotesOnFretboard(fretboard, notes) {
    if (!fretboard || !Array.isArray(notes)) return;
    
    // Clear previous selection
    clearFretboardSelection(fretboard);
    
    // Highlight each note
    notes.forEach(note => {
        try {
            if (typeof fretboard.selectNote === 'function') {
                fretboard.selectNote(note);
            }
        } catch (error) {
            console.warn(`Could not select note ${note}:`, error);
        }
    });
}

/**
 * Highlight a single target note on fretboard
 * @param {Object} fretboard - Fretboard instance
 * @param {string} targetNote - Note name to highlight as target
 */
export function highlightTargetNote(fretboard, targetNote) {
    if (!fretboard || !targetNote) return;
    
    try {
        if (typeof fretboard.highlightTargetNote === 'function') {
            fretboard.highlightTargetNote(targetNote);
        }
    } catch (error) {
        console.warn(`Could not highlight target note ${targetNote}:`, error);
    }
}

/**
 * Get responsive modal dimensions based on screen size
 * @returns {Object} - Width and height for modal fretboard
 */
export function getModalDimensions() {
    return {
        width: Math.min(window.innerWidth * 0.9, 1000),
        height: Math.min(window.innerHeight * 0.4, 200)
    };
}

/**
 * Validate fretboard configuration
 * @param {Object} config - Configuration to validate
 * @returns {Object} - Validated configuration
 */
export function validateFretboardConfig(config) {
    const validated = { ...DEFAULT_CONFIG };
    
    if (config.width && config.width > 0) {
        validated.width = config.width;
    }
    
    if (config.height && config.height > 0) {
        validated.height = config.height;
    }
    
    if (config.numFrets && config.numFrets > 0 && config.numFrets <= 24) {
        validated.numFrets = config.numFrets;
    }
    
    return validated;
}