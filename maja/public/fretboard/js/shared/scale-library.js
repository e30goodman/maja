/**
 * Scale Library Module - Minimal Essential Functions
 * Provides scale support using Tonal.js for custom exercise creation
 */

import { getSimpleNotation, areEnharmonicEquivalents } from './music-theory-utils.js';

/**
 * Scale categories for UI organization
 */
export const SCALE_CATEGORIES = {
    'basic': {
        name: 'Basic Scales',
        scales: ['major', 'minor', 'harmonic minor', 'melodic minor'],
        icon: 'fas fa-graduation-cap'
    },
    'pentatonic': {
        name: 'Pentatonic',
        scales: ['major pentatonic', 'minor pentatonic'],
        icon: 'fas fa-star'
    },
    'modes': {
        name: 'Modes',
        scales: ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian'],
        icon: 'fas fa-church'
    },
    'blues': {
        name: 'Blues',
        scales: ['major blues', 'minor blues'],
        icon: 'fas fa-music'
    }
};

/**
 * All available root notes
 */
export const ROOT_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Get the notes of a scale in a given root
 * @param {string} root - Root note (e.g., 'C', 'F#')
 * @param {string} scaleType - Scale type (e.g., 'major', 'minor')
 * @returns {string[]|null} Array of note names or null if invalid
 */
export function getScaleNotes(root, scaleType) {
    console.log('DEBUG: getScaleNotes called with root:', root, 'scaleType:', scaleType);

    if (!root || !scaleType) {
        console.warn('DEBUG: Missing root or scaleType');
        return null;
    }

    const scaleQuery = `${root} ${scaleType}`;
    console.log('DEBUG: Tonal.Scale.get query:', scaleQuery);

    const scale = Tonal.Scale.get(scaleQuery);
    console.log('DEBUG: Tonal.Scale.get result:', scale);

    if (!scale || !scale.notes || scale.notes.length === 0) {
        console.warn('DEBUG: Invalid or empty scale result');
        return null;
    }

    // Remove octave numbers and get just note names
    const notes = scale.notes.map(note => note.replace(/\d+$/, ''));
    console.log('DEBUG: Final scale notes (no octaves):', notes);
    return notes;
}

/**
 * Get scale-context appropriate notation for a note
 * @param {string} noteString - Note with octave (e.g., 'C#2')
 * @param {string} scaleRoot - Root of the scale context
 * @param {string} scaleType - Type of scale for context
 * @returns {string} Note with appropriate enharmonic spelling
 */
export function getScaleContextNotation(noteString, scaleRoot, scaleType) {
    if (!noteString || !scaleRoot || !scaleType) {
        return noteString;
    }

    const scaleNotes = getScaleNotes(scaleRoot, scaleType);
    if (!scaleNotes) {
        return getSimpleNotation(noteString);
    }

    const noteName = noteString.replace(/\d+$/, '');

    // If note is already in scale with correct spelling, use it
    if (scaleNotes.includes(noteName)) {
        return noteString;
    }

    // Find enharmonic equivalent in the scale
    for (const scaleNote of scaleNotes) {
        if (areEnharmonicEquivalents(noteName, scaleNote)) {
            return noteString.replace(noteName, scaleNote);
        }
    }

    return getSimpleNotation(noteString);
}