/**
 * Chord utility functions for bass guitar chord trainer
 * Handles chord generation, bass range validation, and note normalization
 */

// Bass guitar range limits (MIDI note numbers)
export const BASS_GUITAR_RANGE = {
    LOW_E1: 28,   // E1 - lowest note on bass guitar
    HIGH_DS4: 63, // D#4 - highest note on 20th fret
    HIGH_G3: 55   // G3 - highest note on 12th fret (G string, 12th fret)
};

/**
 * Check if a note is within bass guitar range
 * @param {string} noteString - Note string like "E1" or "D#4"
 * @param {number} fretLimit - Maximum fret limit (12 or 20)
 * @returns {boolean} - True if note is within bass range
 */
export function isInBassRange(noteString, fretLimit = 20) {
    // Requires Tonal.js to be loaded globally
    if (typeof Tonal === 'undefined') {
        console.warn('Tonal.js not available for MIDI conversion');
        return false;
    }
    
    const midiNote = Tonal.Note.midi(noteString);
    if (midiNote === null) return false;
    
    const upperLimit = fretLimit === 12 ? BASS_GUITAR_RANGE.HIGH_G3 : BASS_GUITAR_RANGE.HIGH_DS4;
    return midiNote >= BASS_GUITAR_RANGE.LOW_E1 && midiNote <= upperLimit;
}

/**
 * Normalize flat notes to sharp notation for fretboard compatibility
 * @param {string} noteString - Note string like "Db2" or "F#1"
 * @returns {string} - Sharp notation equivalent (e.g., "C#2")
 */
export function normalizeToSharps(noteString) {
    // Requires Tonal.js to be loaded globally
    if (typeof Tonal === 'undefined') {
        console.warn('Tonal.js not available for note normalization');
        return noteString;
    }
    
    const midi = Tonal.Note.midi(noteString);
    if (midi === null) return noteString;
    
    // Use fromMidiSharps to ensure sharp notation
    return Tonal.Note.fromMidiSharps(midi);
}

/**
 * Generate bass guitar range chord notes from a chord name
 * @param {string} chordName - Chord name like "Cmaj7" or "Am"
 * @param {number} fretLimit - Maximum fret limit (12 or 20)
 * @returns {Array<string>} - Array of note strings in bass range
 */
export function getBassRangeChordNotes(chordName, fretLimit = 20) {
    // Requires Tonal.js to be loaded globally
    if (typeof Tonal === 'undefined') {
        console.warn('Tonal.js not available for chord generation');
        return [];
    }
    
    const chord = Tonal.Chord.get(chordName);
    if (!chord.notes || chord.notes.length === 0) {
        console.warn(`Invalid chord: ${chordName}`);
        return [];
    }
    
    const bassNotes = [];
    
    // Generate notes from octave 1 to 4, filter by bass range and fret limit
    for (let octave = 1; octave <= 4; octave++) {
        chord.notes.forEach(note => {
            const noteWithOctave = note + octave;
            if (isInBassRange(noteWithOctave, fretLimit)) {
                bassNotes.push(noteWithOctave);
            }
        });
    }
    
    return bassNotes;
}

/**
 * Create note-label pairs for fretboard display (preserves original notation)
 * @param {Array<string>} originalNotes - Array of original note strings
 * @returns {Array<Object>} - Array of {note, displayLabel, originalNote} objects
 */
export function createNoteLabelPairs(originalNotes) {
    return originalNotes.map(originalNote => ({
        note: normalizeToSharps(originalNote),  // For selection (e.g., C#2)
        displayLabel: originalNote,  // Keep full original notation with octave (e.g., Db2)
        originalNote: originalNote  // Keep full original note for reference
    }));
}

/**
 * Validate if a played note matches any chord tone (for arpeggio training)
 * @param {string} playedNote - The note that was played
 * @param {Array<string>} validChordNotes - Array of valid chord note strings
 * @returns {boolean} - True if played note matches any chord tone
 */
export function isValidChordTone(playedNote, validChordNotes) {
    // Normalize played note to sharp notation
    const normalizedPlayed = normalizeToSharps(playedNote);
    
    // Check if any valid chord note matches (ignoring octave)
    return validChordNotes.some(chordNote => {
        const normalizedChord = normalizeToSharps(chordNote);
        // Compare note names without octaves
        const playedName = normalizedPlayed.replace(/\d+$/, '');
        const chordName = normalizedChord.replace(/\d+$/, '');
        return playedName === chordName;
    });
}

/**
 * Get chord information for display
 * @param {string} chordName - Chord name like "Cmaj7"
 * @returns {Object|null} - Chord object with name, notes, intervals, type
 */
export function getChordInfo(chordName) {
    // Requires Tonal.js to be loaded globally
    if (typeof Tonal === 'undefined') {
        console.warn('Tonal.js not available for chord info');
        return null;
    }
    
    const chord = Tonal.Chord.get(chordName);
    if (!chord.notes || chord.notes.length === 0) {
        return null;
    }
    
    return {
        name: chord.name || chordName,
        notes: chord.notes,
        intervals: chord.intervals || [],
        type: chord.type || '',
        root: chordName.replace(/[^A-G#b].*$/, '') // Extract root note
    };
}

/**
 * Generate random chord name from common chord types
 * @param {Array<string>} roots - Array of root notes (default: all 12 chromatic notes)
 * @param {Array<string>} types - Array of chord types (default: common triads and 7ths)
 * @returns {string} - Random chord name
 */
export function generateRandomChord(
    roots = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
    types = ['', 'm', '7', 'maj7', 'm7', 'dim', 'aug']
) {
    const randomRoot = roots[Math.floor(Math.random() * roots.length)];
    const randomType = types[Math.floor(Math.random() * types.length)];
    
    return randomRoot + randomType;
}

/**
 * Group notes by octave for display purposes
 * @param {Array<string>} notes - Array of note strings
 * @returns {Object} - Object with octave numbers as keys and note arrays as values
 */
export function groupNotesByOctave(notes) {
    const grouped = {};
    
    notes.forEach(note => {
        const octaveMatch = note.match(/(\d+)$/);
        if (octaveMatch) {
            const octave = octaveMatch[1];
            if (!grouped[octave]) {
                grouped[octave] = [];
            }
            grouped[octave].push(note);
        }
    });
    
    return grouped;
}