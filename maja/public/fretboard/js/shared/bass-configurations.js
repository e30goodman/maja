/**
 * Bass Guitar Configuration Definitions
 * Comprehensive collection of common bass guitar tunings and configurations
 *
 * Each configuration includes:
 * - name: Human readable description with fret count
 * - strings: Array of string definitions (highest to lowest pitch)
 * - frets: Maximum fret number available on this bass
 *
 * String definitions include:
 * - note: Note name (A, A#, B, C, etc.)
 * - octave: Octave number (scientific pitch notation)
 */

import { NOTE_NAMES } from './constants.js';
import { areEnharmonicEquivalents } from './music-theory-utils.js';

export const BASS_CONFIGURATIONS = {
  // 4-String Standard Tunings
  'bass-4-standard-20': {
    name: '4-String Standard (EADG) - 20 frets',
    strings: [
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'E', octave: 1 }
    ],
    frets: 20
  },

  'bass-4-standard-24': {
    name: '4-String Standard (EADG) - 24 frets',
    strings: [
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'E', octave: 1 }
    ],
    frets: 24
  },

  // 4-String Drop Tunings
  'bass-4-drop-d-20': {
    name: '4-String Drop D (DADG) - 20 frets',
    strings: [
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'D', octave: 1 }
    ],
    frets: 20
  },

  'bass-4-drop-d-24': {
    name: '4-String Drop D (DADG) - 24 frets',
    strings: [
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'D', octave: 1 }
    ],
    frets: 24
  },

  'bass-4-drop-c-24': {
    name: '4-String Drop C (CGCF) - 24 frets',
    strings: [
      { note: 'F', octave: 2 },
      { note: 'C', octave: 2 },
      { note: 'G', octave: 1 },
      { note: 'C', octave: 1 }
    ],
    frets: 24
  },


  'bass-4-d-standard-24': {
    name: '4-String D Standard (DGCF) - 24 frets',
    strings: [
      { note: 'F', octave: 2 },
      { note: 'C', octave: 2 },
      { note: 'G', octave: 1 },
      { note: 'D', octave: 1 }
    ],
    frets: 24
  },

  'bass-4-c-standard-24': {
    name: '4-String C Standard (CFAD) - 24 frets',
    strings: [
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'F', octave: 1 },
      { note: 'C', octave: 1 }
    ],
    frets: 24
  },

  // 5-String Standard
  'bass-5-standard-20': {
    name: '5-String Standard (BEADG) - 20 frets',
    strings: [
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'E', octave: 1 },
      { note: 'B', octave: 0 }
    ],
    frets: 20
  },

  'bass-5-standard-24': {
    name: '5-String Standard (BEADG) - 24 frets',
    strings: [
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'E', octave: 1 },
      { note: 'B', octave: 0 }
    ],
    frets: 24
  },

  // 5-String High C Variant
  'bass-5-high-c-24': {
    name: '5-String High C (EADGC) - 24 frets',
    strings: [
      { note: 'C', octave: 3 },
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'E', octave: 1 }
    ],
    frets: 24
  },

  // 6-String Standard
  'bass-6-standard-24': {
    name: '6-String Standard (BEADGC) - 24 frets',
    strings: [
      { note: 'C', octave: 3 },
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'E', octave: 1 },
      { note: 'B', octave: 0 }
    ],
    frets: 24
  },

  'bass-6-drop-a-24': {
    name: '6-String Drop A (AEADGC) - 24 frets',
    strings: [
      { note: 'C', octave: 3 },
      { note: 'G', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'E', octave: 1 },
      { note: 'A', octave: 0 }
    ],
    frets: 24
  },

  // Piccolo Bass (tuned an octave higher)
  'bass-4-piccolo-24': {
    name: '4-String Piccolo Bass (EADG - octave up) - 24 frets',
    strings: [
      { note: 'G', octave: 3 },
      { note: 'D', octave: 3 },
      { note: 'A', octave: 2 },
      { note: 'E', octave: 2 }
    ],
    frets: 24
  },

  // Baritone Guitar (often used as bass alternative)
  'guitar-baritone-27': {
    name: '6-String Baritone (BEADF#B) - 27 frets',
    strings: [
      { note: 'B', octave: 2 },
      { note: 'F#', octave: 2 },
      { note: 'D', octave: 2 },
      { note: 'A', octave: 1 },
      { note: 'E', octave: 1 },
      { note: 'B', octave: 0 }
    ],
    frets: 27
  }
};

/**
 * Helper function to get configuration by ID
 * @param {string} configId - The configuration ID
 * @returns {Object|null} The bass configuration object or null if not found
 */
export function getBassConfiguration(configId) {
  return BASS_CONFIGURATIONS[configId] || null;
}

/**
 * Helper function to get all configuration IDs
 * @returns {string[]} Array of all configuration IDs
 */
export function getAllConfigurationIds() {
  return Object.keys(BASS_CONFIGURATIONS);
}

/**
 * Helper function to get configurations by string count
 * @param {number} stringCount - Number of strings (4, 5, 6, etc.)
 * @returns {Object[]} Array of matching configurations
 */
export function getConfigurationsByStringCount(stringCount) {
  return Object.entries(BASS_CONFIGURATIONS)
    .filter(([id, config]) => config.strings.length === stringCount)
    .map(([id, config]) => ({ id, ...config }));
}

/**
 * Helper function to get all unique string counts available
 * @returns {number[]} Sorted array of unique string counts
 */
export function getAvailableStringCounts() {
  const counts = new Set(
    Object.values(BASS_CONFIGURATIONS).map(config => config.strings.length)
  );
  return Array.from(counts).sort();
}

/**
 * Get all notes matching the given note names within a fret range on a bass configuration
 * @param {Object} bassConfig - Bass configuration object from BASS_CONFIGURATIONS
 * @param {number} startFret - Starting fret (inclusive, 0 = open string)
 * @param {number} endFret - Ending fret (inclusive)
 * @param {string[]} notes - Array of note names without octave (e.g., ["C", "F#", "A"])
 * @returns {string[]} Array of unique note strings with octaves (e.g., ["C2", "F#1", "A1"])
 */
export function getGivenNotesInRange(bassConfig, startFret, endFret, notes) {
  if (!bassConfig || !bassConfig.strings || !Array.isArray(notes)) {
    return [];
  }

  if (startFret < 0 || endFret < startFret || endFret > (bassConfig.frets || 24)) {
    return [];
  }

  const foundNotes = new Set();

  // Iterate through each string in the bass configuration
  bassConfig.strings.forEach(string => {
    const baseNoteIndex = NOTE_NAMES.indexOf(string.note);
    if (baseNoteIndex === -1) return;

    // Iterate through the fret range for this string
    for (let fret = startFret; fret <= endFret; fret++) {
      const totalSemitones = baseNoteIndex + fret;
      const noteIndex = totalSemitones % 12;
      const octaveAdjustment = Math.floor(totalSemitones / 12);

      const noteName = NOTE_NAMES[noteIndex];
      const octave = string.octave + octaveAdjustment;

      // Check if this note name is in our target notes array (with enharmonic equivalence)
      const isNoteInScale = notes.some(scaleNote =>
        scaleNote === noteName || areEnharmonicEquivalents(scaleNote, noteName)
      );

      if (isNoteInScale) {
        foundNotes.add(noteName + octave);
      }
    }
  });

  // Convert Set to Array and sort
  return Array.from(foundNotes).sort((a, b) => {
    // Parse notes for proper sorting
    const parseNote = (noteStr) => {
      const match = noteStr.match(/^([A-G]#?)(\d+)$/);
      if (!match) return { octave: 0, noteIndex: 0 };
      const [, note, octave] = match;
      return {
        octave: parseInt(octave),
        noteIndex: NOTE_NAMES.indexOf(note)
      };
    };

    const noteA = parseNote(a);
    const noteB = parseNote(b);

    // Sort by octave first, then by note position in chromatic scale
    if (noteA.octave !== noteB.octave) {
      return noteA.octave - noteB.octave;
    }
    return noteA.noteIndex - noteB.noteIndex;
  });
}

/**
 * Get all natural notes (C, D, E, F, G, A, B) within a fret range on a bass configuration
 * @param {Object} bassConfig - Bass configuration object from BASS_CONFIGURATIONS
 * @param {number} startFret - Starting fret (inclusive, 0 = open string)
 * @param {number} endFret - Ending fret (inclusive)
 * @returns {string[]} Array of natural note strings with octaves (e.g., ["E1", "F1", "G1"])
 */
export function getNaturalNotesInRange(bassConfig, startFret, endFret) {
  const naturalNotes = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  return getGivenNotesInRange(bassConfig, startFret, endFret, naturalNotes);
}

/**
 * Get all notes (including sharps/flats) within a fret range on a bass configuration
 * @param {Object} bassConfig - Bass configuration object from BASS_CONFIGURATIONS
 * @param {number} startFret - Starting fret (inclusive, 0 = open string)
 * @param {number} endFret - Ending fret (inclusive)
 * @returns {string[]} Array of all note strings with octaves (e.g., ["E1", "F1", "F#1", "G1"])
 */
export function getAllNotesInRange(bassConfig, startFret, endFret) {
  return getGivenNotesInRange(bassConfig, startFret, endFret, NOTE_NAMES);
}

/**
 * Get all notes on a specific string within a fret range
 * @param {Object} bassConfig - Bass configuration object from BASS_CONFIGURATIONS
 * @param {number} stringIndex - Index of the string (0 = first/highest string)
 * @param {number} startFret - Starting fret (inclusive, 0 = open string)
 * @param {number} endFret - Ending fret (inclusive)
 * @returns {string[]} Array of note strings with octaves on that specific string
 */
export function getNotesInRangeForString(bassConfig, stringIndex, startFret, endFret) {
  if (!bassConfig || !bassConfig.strings || stringIndex < 0 || stringIndex >= bassConfig.strings.length) {
    return [];
  }

  if (startFret < 0 || endFret < startFret || endFret > (bassConfig.frets || 24)) {
    return [];
  }

  const notes = [];
  const string = bassConfig.strings[stringIndex];
  const baseNoteIndex = NOTE_NAMES.indexOf(string.note);

  if (baseNoteIndex === -1) return [];

  // Iterate through the fret range for this specific string
  for (let fret = startFret; fret <= endFret; fret++) {
    const totalSemitones = baseNoteIndex + fret;
    const noteIndex = totalSemitones % 12;
    const octaveAdjustment = Math.floor(totalSemitones / 12);

    const noteName = NOTE_NAMES[noteIndex];
    const octave = string.octave + octaveAdjustment;

    notes.push(noteName + octave);
  }

  return notes;
}
