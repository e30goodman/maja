/**
 * Custom Exercise Management - Service Locator Pattern
 * Handles creation, storage, and retrieval of custom exercises
 * Uses Service Locator to access dependencies without circular imports
 */

import { Services, SERVICE_NAMES } from './services.js';

const STORAGE_KEY = 'lyafb_custom_exercises';

/**
 * Generate an exercise name based on configuration values
 * @param {Object} config - Exercise configuration
 * @returns {string} Generated exercise name
 */
function generateExerciseName(config) {
    const { fretMin, fretMax, notePoolMethod, notationStyle } = config;
    const fretRange = `F${fretMin}-${fretMax}`;

    // Map notation style to shorter form
    const notationMap = {
        'simple': 'Simple',
        'enharmonic': 'Mixed',
        'scale': 'Scale Context'
    };
    const notationText = notationMap[notationStyle] || 'Simple';

    switch (notePoolMethod) {
        case 'chromatic':
            return `Chromatic ${fretRange} ${notationText}`;

        case 'scale':
            const scaleRoot = config.scaleRoot || 'C';
            const scaleType = config.scaleType || 'major';
            // Capitalize first letter of scale type
            const formattedScaleType = scaleType.charAt(0).toUpperCase() + scaleType.slice(1);
            return `${scaleRoot} ${formattedScaleType} ${fretRange} ${notationText}`;

        case 'custom':
            if (config.customNotes && config.customNotes.length > 0) {
                // Show first 4 notes, add ... if more
                const noteList = config.customNotes.length <= 4
                    ? config.customNotes.join('-')
                    : config.customNotes.slice(0, 4).join('-') + '...';
                return `${noteList} ${fretRange} ${notationText}`;
            } else {
                return `Custom Notes ${fretRange} ${notationText}`;
            }

        default:
            return `Custom Exercise ${fretRange} ${notationText}`;
    }
}

/**
 * Create a custom exercise configuration
 * @param {Object} config - Exercise configuration
 * @returns {Object} Validated exercise object
 */
export function createCustomExercise(config) {
    const exercise = {
        id: `custom_${Date.now()}`,
        name: config.name || generateExerciseName(config),
        difficulty: 'custom',
        fretMin: Math.max(0, config.fretMin || 0),
        fretMax: Math.min(24, config.fretMax || 12),
        notePoolMethod: config.notePoolMethod || 'chromatic',
        notationStyle: config.notationStyle || 'simple',
        icon: 'fas fa-user-edit',
        isCustom: true,
        createdAt: new Date().toISOString()
    };

    // Add method-specific properties
    if (config.notePoolMethod === 'scale') {
        exercise.scaleRoot = config.scaleRoot || 'C';
        exercise.scaleType = config.scaleType || 'major';
    } else if (config.notePoolMethod === 'custom') {
        exercise.customNotes = config.customNotes || ['C'];
    }

    return exercise;
}

/**
 * Save custom exercise to localStorage
 * @param {Object} exercise - Exercise object to save
 * @returns {boolean} True if saved successfully
 */
export function saveCustomExercise(exercise) {
    try {
        const exercises = loadCustomExercises();

        // Update existing or add new
        const existingIndex = exercises.findIndex(ex => ex.id === exercise.id);
        if (existingIndex >= 0) {
            exercises[existingIndex] = { ...exercise, lastModified: new Date().toISOString() };
        } else {
            exercises.push(exercise);
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(exercises));
        return true;
    } catch (error) {
        console.error('Error saving custom exercise:', error);
        return false;
    }
}

/**
 * Load all custom exercises from localStorage
 * @returns {Array} Array of custom exercise objects
 */
export function loadCustomExercises() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (error) {
        console.error('Error loading custom exercises:', error);
        return [];
    }
}

/**
 * Delete a custom exercise
 * @param {string} exerciseId - ID of exercise to delete
 * @returns {boolean} True if deleted successfully
 */
export function deleteCustomExercise(exerciseId) {
    try {
        const exercises = loadCustomExercises();
        const filtered = exercises.filter(ex => ex.id !== exerciseId);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
        return true;
    } catch (error) {
        console.error('Error deleting custom exercise:', error);
        return false;
    }
}

/**
 * Generate notes for a custom exercise using Service Locator pattern
 * @param {Object} exercise - Custom exercise object
 * @param {Object} bassConfig - Bass configuration
 * @returns {string[]} Array of note strings with octaves
 */
export function generateCustomExerciseNotes(exercise, bassConfig) {
    const { fretMin, fretMax, notePoolMethod } = exercise;

    console.log('DEBUG: generateCustomExerciseNotes called with:', {
        notePoolMethod,
        fretMin,
        fretMax,
        scaleRoot: exercise.scaleRoot,
        scaleType: exercise.scaleType
    });

    try {
        // Get bass configurations service
        const bassConfigService = Services.get(SERVICE_NAMES.BASS_CONFIGURATIONS);

        switch (notePoolMethod) {
            case 'chromatic':
                console.log('DEBUG: Using chromatic note pool');
                return bassConfigService.getAllNotesInRange(bassConfig, fretMin, fretMax);

            case 'scale':
                console.log('DEBUG: Using scale-based note pool');
                // Get scale library service for scale-based note generation
                const scaleLibrary = Services.get(SERVICE_NAMES.SCALE_LIBRARY);
                const scaleNotes = scaleLibrary.getScaleNotes(exercise.scaleRoot, exercise.scaleType);
                console.log('DEBUG: Scale notes from library:', scaleNotes);
                if (!scaleNotes) {
                    console.warn('DEBUG: No scale notes returned, returning empty array');
                    return [];
                }
                const result = bassConfigService.getGivenNotesInRange(bassConfig, fretMin, fretMax, scaleNotes);
                console.log('DEBUG: Final scale-based notes:', result);
                return result;

            case 'custom':
                if (!exercise.customNotes) return [];
                return bassConfigService.getGivenNotesInRange(bassConfig, fretMin, fretMax, exercise.customNotes);

            default:
                console.warn(`Unknown note pool method: ${notePoolMethod}`);
                return [];
        }
    } catch (error) {
        console.error('Error generating custom exercise notes:', error);
        return [];
    }
}