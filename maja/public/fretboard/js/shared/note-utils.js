import { NOTE_NAMES, BASS_STRINGS, FREQUENCY_CONFIG } from './constants.js';
import { getRandomEnharmonic, areEnharmonicEquivalents } from './music-theory-utils.js';
import { Services, SERVICE_NAMES } from './services.js';

/**
 * Utility functions for note manipulation, validation, and comparison
 * Consolidates note-related logic used across the application
 */

/**
 * Parse a note string into components
 * @param {string} noteString - Note string like "C#2" or "F1"
 * @returns {Object|null} - {name, octave, isSharp, isFlat} or null if invalid
 */
export function parseNote(noteString) {
    if (!noteString || typeof noteString !== 'string') return null;
    
    const match = noteString.match(/^([A-G])(#|b)?(\d+)$/);
    if (!match) return null;
    
    const [, name, accidental, octave] = match;
    
    return {
        name: name + (accidental || ''),
        octave: parseInt(octave),
        isSharp: accidental === '#',
        isFlat: accidental === 'b',
        fullName: noteString
    };
}

/**
 * Compare two notes for equality
 * @param {string} note1 - First note string
 * @param {string} note2 - Second note string
 * @param {boolean} ignoreOctave - Whether to ignore octave differences
 * @returns {boolean} - True if notes match
 */
export function notesEqual(note1, note2, ignoreOctave = false) {
    if (!note1 || !note2) return false;
    
    if (ignoreOctave) {
        const parsed1 = parseNote(note1);
        const parsed2 = parseNote(note2);
        return parsed1 && parsed2 && parsed1.name === parsed2.name;
    }
    
    return note1 === note2;
}

/**
 * Check if a detected note matches the target note exactly (including octave)
 * Used for chromatic training where octave precision is required
 * Now supports enharmonic equivalents (C# = Db)
 * @param {string} detectedNote - The note that was detected
 * @param {string} targetNote - The target note to match
 * @returns {boolean} - True if the notes match exactly or are enharmonic equivalents
 */
export function isCorrectNote(detectedNote, targetNote) {
    if (!detectedNote || !targetNote) return false;

    // First check for exact match (fastest)
    if (detectedNote === targetNote) return true;

    // Then check for enharmonic equivalence
    return areEnharmonicEquivalents(detectedNote, targetNote);
}

/**
 * Check if a detected note matches the target note flexibly (ignoring octave)
 * Used for chord training where chord tones can be played in different octaves
 * @param {string} detectedNote - The note that was detected
 * @param {string} targetNote - The target note to match
 * @returns {boolean} - True if the note names match (ignoring octave)
 */
export function isCorrectNoteFlexible(detectedNote, targetNote) {
    if (!detectedNote || !targetNote) return false;
    
    // Direct match first
    if (detectedNote === targetNote) return true;
    
    // Match without octave (e.g., "C#" matches "C#2")
    const detectedBase = detectedNote.replace(/\d+$/, '');
    const targetBase = targetNote.replace(/\d+$/, '');
    
    return detectedBase === targetBase;
}

/**
 * Get note at specific fret position on a string
 * @param {number} stringIndex - Index of the string (0-based)
 * @param {number} fret - Fret number (0 = open string)
 * @returns {Object|null} - Note information object
 */
export function getNoteAtPosition(stringIndex, fret) {
    if (stringIndex < 0 || stringIndex >= BASS_STRINGS.length || fret < 0) {
        return null;
    }
    
    const string = BASS_STRINGS[stringIndex];
    const baseNoteIndex = NOTE_NAMES.indexOf(string.note);
    
    if (baseNoteIndex === -1) return null;
    
    const totalSemitones = baseNoteIndex + fret;
    const noteIndex = totalSemitones % 12;
    const octaveAdjustment = Math.floor(totalSemitones / 12);
    
    return {
        name: NOTE_NAMES[noteIndex],
        octave: string.octave + octaveAdjustment,
        fullName: NOTE_NAMES[noteIndex] + (string.octave + octaveAdjustment),
        stringIndex: stringIndex,
        fret: fret
    };
}

/**
 * Find all positions on the fretboard where a note can be played
 * @param {string} noteName - Note to find (e.g., "A1" or "C#2")
 * @param {number} maxFrets - Maximum fret to search (default 12)
 * @returns {Array} - Array of {stringIndex, fret, noteInfo} objects
 */
export function findNotePositions(noteName, maxFrets = 12) {
    const positions = [];
    const targetNote = parseNote(noteName);
    
    if (!targetNote) return positions;
    
    for (let stringIndex = 0; stringIndex < BASS_STRINGS.length; stringIndex++) {
        for (let fret = 0; fret <= maxFrets; fret++) {
            const noteInfo = getNoteAtPosition(stringIndex, fret);
            if (noteInfo && noteInfo.fullName === noteName) {
                positions.push({
                    stringIndex,
                    fret,
                    noteInfo
                });
            }
        }
    }
    
    return positions;
}

/**
 * Generate a random note from a pool, avoiding consecutive duplicates
 * @param {Array<string>} notePool - Array of note strings to choose from
 * @param {string} excludeNote - Note to avoid selecting
 * @param {string} notationStyle - Notation style: 'simple', 'enharmonic', or 'scale'
 * @param {Object} scaleContext - Scale context for 'scale' notation style
 * @returns {string|null} - Selected note or null if pool is empty
 */
export function generateRandomNote(notePool, excludeNote = null, notationStyle = 'simple', scaleContext = null) {
    if (!notePool || notePool.length === 0) return null;

    // If pool has only one note, return it regardless of exclusion
    if (notePool.length === 1) {
        const selectedNote = notePool[0];
        return applyNotationStyle(selectedNote, notationStyle, scaleContext);
    }

    // Filter out the excluded note if provided
    const availableNotes = excludeNote ?
        notePool.filter(note => note !== excludeNote) :
        notePool;

    if (availableNotes.length === 0) {
        const selectedNote = notePool[0];
        return applyNotationStyle(selectedNote, notationStyle, scaleContext);
    }

    const randomIndex = Math.floor(Math.random() * availableNotes.length);
    const selectedNote = availableNotes[randomIndex];

    return applyNotationStyle(selectedNote, notationStyle, scaleContext);
}

/**
 * Apply notation style transformation to a note
 * Uses Service Locator pattern to access scale library without circular imports
 *
 * @param {string} noteString - Original note string
 * @param {string} notationStyle - Notation style: 'simple', 'enharmonic', or 'scale'
 * @param {Object} scaleContext - Scale context with root and type properties
 * @returns {string} - Transformed note string
 * @private
 */
function applyNotationStyle(noteString, notationStyle, scaleContext) {
    switch (notationStyle) {
        case 'enharmonic':
            return getRandomEnharmonic(noteString);
        case 'scale':
            if (scaleContext && scaleContext.root && scaleContext.type) {
                try {
                    // Use Service Locator to get scale library - no circular imports!
                    if (Services.has(SERVICE_NAMES.SCALE_LIBRARY)) {
                        const scaleLibrary = Services.get(SERVICE_NAMES.SCALE_LIBRARY);
                        return scaleLibrary.getScaleContextNotation(
                            noteString,
                            scaleContext.root,
                            scaleContext.type
                        );
                    }
                } catch (error) {
                    console.warn('Scale context notation service not available:', error);
                }
            }
            return noteString;
        case 'simple':
        default:
            return noteString;
    }
}

/**
 * Validate a note string format
 * @param {string} noteString - Note string to validate
 * @returns {boolean} - True if valid note format
 */
export function isValidNoteString(noteString) {
    return parseNote(noteString) !== null;
}

/**
 * Convert frequency to the closest note
 * @param {number} frequency - Frequency in Hz
 * @returns {Object|null} - Note information or null
 */
export function frequencyToNote(frequency) {
    if (!frequency || frequency < FREQUENCY_CONFIG.MIN_FREQUENCY) return null;
    
    // Calculate note number using C0 as reference
    const noteNum = 12 * Math.log2(frequency / FREQUENCY_CONFIG.C0_FREQUENCY);
    const roundedNoteNum = Math.round(noteNum);
    const octave = Math.floor(roundedNoteNum / 12);
    const noteIndex = roundedNoteNum % 12;
    
    // Calculate the target frequency for this note
    const targetFrequency = FREQUENCY_CONFIG.C0_FREQUENCY * Math.pow(2, roundedNoteNum / 12);
    
    // Calculate cents deviation
    const centsDeviation = Math.round(1200 * Math.log2(frequency / targetFrequency));
    
    return {
        name: NOTE_NAMES[noteIndex],
        octave: octave,
        fullName: NOTE_NAMES[noteIndex] + octave,
        frequency: frequency,
        targetFrequency: targetFrequency,
        centsDeviation: centsDeviation,
        isSharp: centsDeviation > 5,
        isFlat: centsDeviation < -5,
        isInTune: Math.abs(centsDeviation) <= 5
    };
}

/**
 * Sort notes in musical order (C, C#, D, D#, etc.)
 * @param {Array<string>} notes - Array of note strings
 * @returns {Array<string>} - Sorted array
 */
export function sortNotesMusicallly(notes) {
    return notes.sort((a, b) => {
        const noteA = parseNote(a);
        const noteB = parseNote(b);
        
        if (!noteA || !noteB) return 0;
        
        // Sort by octave first, then by note position in chromatic scale
        if (noteA.octave !== noteB.octave) {
            return noteA.octave - noteB.octave;
        }
        
        const indexA = NOTE_NAMES.indexOf(noteA.name);
        const indexB = NOTE_NAMES.indexOf(noteB.name);
        
        return indexA - indexB;
    });
}

/**
 * Check if a note is in the typical bass range
 * @param {string} noteString - Note to check
 * @returns {string} - 'bass-range', 'upper-bass', or 'out-of-range'
 */
export function getBassRangeCategory(noteString) {
    const note = parseNote(noteString);
    if (!note) return 'out-of-range';
    
    if (note.octave <= 1) {
        return 'bass-range';
    } else if (note.octave <= 2) {
        return 'upper-bass';
    } else {
        return 'out-of-range';
    }
}

/**
 * Get the semitone distance between two notes
 * @param {string} note1 - First note
 * @param {string} note2 - Second note  
 * @returns {number|null} - Distance in semitones, null if invalid
 */
export function getSemitoneDistance(note1, note2) {
    const parsed1 = parseNote(note1);
    const parsed2 = parseNote(note2);
    
    if (!parsed1 || !parsed2) return null;
    
    const index1 = NOTE_NAMES.indexOf(parsed1.name);
    const index2 = NOTE_NAMES.indexOf(parsed2.name);
    
    if (index1 === -1 || index2 === -1) return null;
    
    const totalSemitones1 = (parsed1.octave * 12) + index1;
    const totalSemitones2 = (parsed2.octave * 12) + index2;
    
    return Math.abs(totalSemitones2 - totalSemitones1);
}

/**
 * Generate note sequence for practice queue
 * @param {Array<string>} notePool - Available notes
 * @param {number} queueSize - Size of queue to generate
 * @param {string} notationStyle - Notation style: 'simple', 'enharmonic', or 'scale'
 * @param {Object} scaleContext - Scale context for 'scale' notation style
 * @returns {Array<Object>} - Array of queue items with note and result
 */
export function generateNoteQueue(notePool, queueSize = 7, notationStyle = 'simple', scaleContext = null) {
    if (!notePool || notePool.length === 0) return [];

    const queue = [];
    let lastNote = null;

    for (let i = 0; i < queueSize; i++) {
        const note = generateRandomNote(notePool, lastNote, notationStyle, scaleContext);
        queue.push({
            note: note,
            result: null // Will be set to 'correct', 'incorrect', or null
        });
        lastNote = note;
    }

    return queue;
}