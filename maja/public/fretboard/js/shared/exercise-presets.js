/**
 * Exercise Presets for Chromatic Trainer
 * Defines different practice exercises with their note filtering and fret range settings
 */

import { NOTE_NAMES } from './constants.js';
import { getNotesInRangeForString } from './bass-configurations.js';

export const EXERCISE_PRESETS = {
  'open-strings': {
    name: 'Open Strings',
    description: 'Practice the four open string notes',
    difficulty: 'beginner',
    fretMin: 0,
    fretMax: 0,
    noteFilter: 'open-strings', // Special case - uses getOpenStringNotes()
    notationStyle: 'simple', // Keep simple notation for beginners
    icon: 'fas fa-hand-point-up'
  },

  'first-position': {
    name: 'First Position',
    description: 'Natural Notes within the first 5 frets',
    difficulty: 'beginner',
    fretMin: 0,
    fretMax: 5,
    noteFilter: 'natural', // Natural notes only
    notationStyle: 'simple', // Keep simple notation for beginners
    icon: 'fas fa-baby'
  },

  'first-string': {
    name: 'First String',
    description: 'All notes on the first string (frets 0-12)',
    difficulty: 'beginner',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'first-string', // Special case - uses getNotesInRangeForString()
    notationStyle: 'simple', // Keep simple notation for beginners
    icon: 'fas fa-guitar'
  },

  'natural-notes': {
    name: 'Natural Notes',
    description: 'All natural notes (no sharps/flats) across the fretboard',
    difficulty: 'beginner',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'natural',
    notationStyle: 'simple', // Keep simple notation for beginners
    icon: 'fas fa-leaf'
  },

  'chromatic-lower': {
    name: 'Chromatic (Lower)',
    description: 'All notes in lower register (frets 0-5) with mixed notation',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 5,
    noteFilter: 'all',
    notationStyle: 'enharmonic', // Use random enharmonic equivalents
    icon: 'fas fa-arrow-down'
  },

  'chromatic-upper': {
    name: 'Chromatic (Upper)',
    description: 'All notes in upper register (frets 6-11) with mixed notation',
    difficulty: 'intermediate',
    fretMin: 6,
    fretMax: 11,
    noteFilter: 'all',
    notationStyle: 'enharmonic', // Use random enharmonic equivalents
    icon: 'fas fa-arrow-up'
  },

  'full-chromatic': {
    name: 'Full Chromatic',
    description: 'All notes across the entire fretboard with mixed notation',
    difficulty: 'advanced',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'all',
    notationStyle: 'enharmonic', // Use random enharmonic equivalents
    icon: 'fas fa-expand-arrows-alt'
  },

  'extended-range': {
    name: 'Extended Range',
    description: 'All notes across extended fretboard (up to 20th fret) with mixed notation',
    difficulty: 'advanced',
    fretMin: 0,
    fretMax: 20,
    noteFilter: 'all',
    notationStyle: 'enharmonic', // Use random enharmonic equivalents
    icon: 'fas fa-arrows-alt-h'
  },

  'pentatonic-major': {
    name: 'Major Pentatonic',
    description: 'Major pentatonic scale notes (C, D, E, G, A)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D', 'E', 'G', 'A'],
    notationStyle: 'simple', // Keep scale notes in simple notation
    icon: 'fas fa-star'
  },

  'pentatonic-minor': {
    name: 'Minor Pentatonic',
    description: 'Minor pentatonic scale notes (C, D#, F, G, A#)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D#', 'F', 'G', 'A#'],
    notationStyle: 'simple', // Keep scale notes in simple notation
    icon: 'fas fa-star-half-alt'
  },

  'blues-scale': {
    name: 'Blues Scale',
    description: 'Blues scale notes (C, D#, F, F#, G, A#)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D#', 'F', 'F#', 'G', 'A#'],
    notationStyle: 'simple', // Keep scale notes in simple notation
    icon: 'fas fa-music'
  },

  'major-scale': {
    name: 'Major Scale',
    description: 'Major scale notes (C, D, E, F, G, A, B)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    notationStyle: 'simple', // Keep scale notes in simple notation
    icon: 'fas fa-smile'
  },

  'minor-scale': {
    name: 'Natural Minor Scale',
    description: 'Natural minor scale notes (C, D, D#, F, G, G#, A#)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D', 'D#', 'F', 'G', 'G#', 'A#'],
    notationStyle: 'simple', // Keep scale notes in simple notation
    icon: 'fas fa-frown'
  },

  // Seven church modes (C root) — same note-pool pattern as Major / Minor presets
  'mode-ionian': {
    name: 'Ionian (Major Mode)',
    description: '1st mode — C Ionian (C, D, E, F, G, A, B)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    notationStyle: 'simple',
    scaleRoot: 'C',
    scaleType: 'ionian',
    icon: 'fas fa-church'
  },

  'mode-dorian': {
    name: 'Dorian',
    description: '2nd mode — C Dorian (C, D, D#, F, G, A, A#)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D', 'D#', 'F', 'G', 'A', 'A#'],
    notationStyle: 'simple',
    scaleRoot: 'C',
    scaleType: 'dorian',
    icon: 'fas fa-church'
  },

  'mode-phrygian': {
    name: 'Phrygian',
    description: '3rd mode — C Phrygian (C, C#, D#, F, G, G#, A#)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'C#', 'D#', 'F', 'G', 'G#', 'A#'],
    notationStyle: 'simple',
    scaleRoot: 'C',
    scaleType: 'phrygian',
    icon: 'fas fa-church'
  },

  'mode-lydian': {
    name: 'Lydian',
    description: '4th mode — C Lydian (C, D, E, F#, G, A, B)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D', 'E', 'F#', 'G', 'A', 'B'],
    notationStyle: 'simple',
    scaleRoot: 'C',
    scaleType: 'lydian',
    icon: 'fas fa-church'
  },

  'mode-mixolydian': {
    name: 'Mixolydian',
    description: '5th mode — C Mixolydian (C, D, E, F, G, A, A#)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D', 'E', 'F', 'G', 'A', 'A#'],
    notationStyle: 'simple',
    scaleRoot: 'C',
    scaleType: 'mixolydian',
    icon: 'fas fa-church'
  },

  'mode-aeolian': {
    name: 'Aeolian (Natural Minor Mode)',
    description: '6th mode — C Aeolian (C, D, D#, F, G, G#, A#)',
    difficulty: 'intermediate',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'D', 'D#', 'F', 'G', 'G#', 'A#'],
    notationStyle: 'simple',
    scaleRoot: 'C',
    scaleType: 'aeolian',
    icon: 'fas fa-church'
  },

  'mode-locrian': {
    name: 'Locrian',
    description: '7th mode — C Locrian (C, C#, D#, F, F#, G#, A#)',
    difficulty: 'advanced',
    fretMin: 0,
    fretMax: 12,
    noteFilter: 'custom',
    customNotes: ['C', 'C#', 'D#', 'F', 'F#', 'G#', 'A#'],
    notationStyle: 'simple',
    scaleRoot: 'C',
    scaleType: 'locrian',
    icon: 'fas fa-church'
  }
};

/**
 * Get notes for an exercise based on bass configuration
 * @param {string} presetId - Exercise preset ID
 * @param {Object} bassConfig - Bass configuration from BASS_CONFIGURATIONS
 * @param {Function} getGivenNotesInRange - Function to get notes in range
 * @param {Function} getNaturalNotesInRange - Function to get natural notes in range
 * @param {Function} getAllNotesInRange - Function to get all notes in range
 * @returns {string[]} Array of note names with octaves
 */
export function getExerciseNotes(presetId, bassConfig, getGivenNotesInRange, getNaturalNotesInRange, getAllNotesInRange) {
  const preset = EXERCISE_PRESETS[presetId];
  if (!preset || !bassConfig) {
    return [];
  }

  const { fretMin, fretMax, noteFilter, customNotes } = preset;

  switch (noteFilter) {
    case 'open-strings':
      // Special case: return only the open string notes
      return bassConfig.strings.map(string => `${string.note}${string.octave}`);

    case 'first-string':
      // Special case: return notes only from the first string (last index = lowest/thickest string)
      return getNotesInRangeForString(bassConfig, bassConfig.strings.length - 1, fretMin, fretMax);

    case 'natural':
      return getNaturalNotesInRange(bassConfig, fretMin, fretMax);

    case 'all':
      return getAllNotesInRange(bassConfig, fretMin, fretMax);

    case 'custom':
      if (customNotes && Array.isArray(customNotes)) {
        return getGivenNotesInRange(bassConfig, fretMin, fretMax, customNotes);
      }
      return [];

    default:
      return [];
  }
}

/**
 * Get exercise presets filtered by difficulty level
 * @param {string} difficulty - 'beginner', 'intermediate', 'advanced', or 'all'
 * @returns {Object[]} Array of preset objects with IDs
 */
export function getExercisesByDifficulty(difficulty = 'all') {
  return Object.entries(EXERCISE_PRESETS)
    .filter(([id, preset]) => difficulty === 'all' || preset.difficulty === difficulty)
    .map(([id, preset]) => ({ id, ...preset }));
}

/**
 * Get exercise preset by ID
 * @param {string} presetId - Exercise preset ID
 * @returns {Object|null} Exercise preset object or null if not found
 */
export function getExercisePreset(presetId) {
  return EXERCISE_PRESETS[presetId] || null;
}

/**
 * Get all available exercise preset IDs
 * @returns {string[]} Array of all exercise preset IDs
 */
export function getAllExerciseIds() {
  return Object.keys(EXERCISE_PRESETS);
}

/**
 * Get exercise presets grouped by difficulty
 * @returns {Object} Object with difficulty levels as keys and preset arrays as values
 */
export function getExercisesGroupedByDifficulty() {
  const grouped = {
    beginner: [],
    intermediate: [],
    advanced: []
  };

  Object.entries(EXERCISE_PRESETS).forEach(([id, preset]) => {
    if (grouped[preset.difficulty]) {
      grouped[preset.difficulty].push({ id, ...preset });
    }
  });

  return grouped;
}

/**
 * Get exercise notes including custom exercise support
 * Enhanced version that supports new note pool methods
 * @param {Object} exercise - Exercise object (preset or custom)
 * @param {Object} bassConfig - Bass configuration
 * @param {Function} getGivenNotesInRange - Function to get notes in range
 * @param {Function} getNaturalNotesInRange - Function to get natural notes in range
 * @param {Function} getAllNotesInRange - Function to get all notes in range
 * @returns {string[]} Array of note names with octaves
 */
export function getEnhancedExerciseNotes(exercise, bassConfig, getGivenNotesInRange, getNaturalNotesInRange, getAllNotesInRange) {
  if (!exercise || !bassConfig) {
    return [];
  }

  const { fretMin, fretMax } = exercise;

  // Handle custom exercises with new note pool methods
  if (exercise.isCustom && exercise.notePoolMethod) {
    switch (exercise.notePoolMethod) {
      case 'chromatic':
        return getAllNotesInRange(bassConfig, fretMin, fretMax);

      case 'scale':
        // Scale-based notes will be handled by the custom exercise module
        // This is a placeholder - actual implementation uses generateCustomExerciseNotes
        return [];

      case 'custom':
        if (exercise.customNotes) {
          return getGivenNotesInRange(bassConfig, fretMin, fretMax, exercise.customNotes);
        }
        return [];
    }
  }

  // Fall back to legacy exercise handling
  const { noteFilter, customNotes } = exercise;

  switch (noteFilter) {
    case 'open-strings':
      return bassConfig.strings.map(string => `${string.note}${string.octave}`);

    case 'first-string':
      // Special case: return notes only from the first string (last index = lowest/thickest string)
      return getNotesInRangeForString(bassConfig, bassConfig.strings.length - 1, fretMin, fretMax);

    case 'natural':
      return getNaturalNotesInRange(bassConfig, fretMin, fretMax);

    case 'all':
      return getAllNotesInRange(bassConfig, fretMin, fretMax);

    case 'custom':
      if (customNotes && Array.isArray(customNotes)) {
        return getGivenNotesInRange(bassConfig, fretMin, fretMax, customNotes);
      }
      return [];

    default:
      return [];
  }
}
