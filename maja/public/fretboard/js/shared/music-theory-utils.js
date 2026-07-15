/**
 * Music Theory Utilities using Tonal.js
 * Provides enharmonic note manipulation and music theory operations
 */

import { parseNote } from './note-utils.js';

/**
 * Get a random enharmonic equivalent of a note using Tonal.js
 * @param {string} noteString - Note with octave (e.g., "C#2", "Bb1")
 * @returns {string} - Random enharmonic equivalent with same octave
 */
export function getRandomEnharmonic(noteString) {
    if (Math.random()>0.5) {
        return noteString;
    } else {
        return Tonal.Note.enharmonic(noteString);
    }
}

/**
 * Check if two notes are enharmonic equivalents using Tonal.js
 * @param {string} note1 - First note (with or without octave)
 * @param {string} note2 - Second note (with or without octave)
 * @returns {boolean} - True if they are enharmonic equivalents
 */
export function areEnharmonicEquivalents(note1, note2) {
    if (!note1 || !note2) return false;

    try {
        // Add default octave if missing for proper MIDI comparison
        const noteWithOctave1 = /\d$/.test(note1) ? note1 : note1 + '4';
        const noteWithOctave2 = /\d$/.test(note2) ? note2 : note2 + '4';

        const midi1 = Tonal.Note.midi(noteWithOctave1);
        const midi2 = Tonal.Note.midi(noteWithOctave2);

        return midi1 !== null && midi2 !== null && midi1 === midi2;
    } catch (error) {
        console.warn('Error checking enharmonic equivalence', error);
        return false;
    }
}

/**
 * Get the most common/simple notation for a note using Tonal.js
 * @param {string} noteString - Note with octave
 * @returns {string} - Simplified note notation
 */
export function getSimpleNotation(noteString) {
    const parsed = parseNote(noteString);
    if (!parsed) return noteString;

    try {
        // Use Tonal.js simplify function if available
        if (typeof Tonal !== 'undefined' && Tonal.Note && Tonal.Note.simplify) {
            const simplified = Tonal.Note.simplify(parsed.name);
            if (simplified) {
                return simplified + parsed.octave;
            }
        }

        // Fallback: prefer sharps over flats, naturals over accidentals
        const note = parsed.name;
        if (note.includes('b') && !note.includes('bb')) {
            // Convert common flats to sharps
            const sharpEquivalents = {
                'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'
            };
            const sharpEquiv = sharpEquivalents[note];
            if (sharpEquiv) {
                return sharpEquiv + parsed.octave;
            }
        }

        return noteString;
    } catch (error) {
        console.warn('Error simplifying notation for', noteString, error);
        return noteString;
    }
}

