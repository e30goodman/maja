/**
 * Shared constants for the Bass Fretboard Trainer application
 * Centralizes configuration, tuning data, and magic numbers
 */

// Bass guitar standard tuning (low to high)
export const BASS_STRINGS = [
    { name: 'G', note: 'G', octave: 2, openFreq: 98.00 },   // 4th string (highest)
    { name: 'D', note: 'D', octave: 2, openFreq: 73.42 },   // 3rd string
    { name: 'A', note: 'A', octave: 1, openFreq: 55.00 },   // 2nd string
    { name: 'E', note: 'E', octave: 1, openFreq: 41.20 }    // 1st string (lowest)
];

// Chromatic scale note names
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Fretboard configuration
export const FRETBOARD_CONFIG = {
    DEFAULT_NUM_FRETS: 12,
    DEFAULT_WIDTH: 800,
    DEFAULT_HEIGHT: 150,
    DOT_SPACE_HEIGHT: 25,
    LEFT_SPACE_WIDTH: 50,
    
    // Fret marker positions
    MARKER_FRETS: [3, 5, 7, 9, 12],
    DOUBLE_DOT_FRET: 12
};

// Audio detection configuration
export const AUDIO_CONFIG = {
    SAMPLE_RATE: 44100,
    CHANNEL_COUNT: 1,
    FFT_SIZE: 4096,
    SMOOTHING_TIME_CONSTANT: 0.3,
    
    // Detection thresholds
    VOLUME_THRESHOLD: 0.01,
    CLARITY_THRESHOLD: 0.8,
    LOW_CLARITY_THRESHOLD: 0.5,
    
    // Microphone settings
    ECHO_CANCELLATION: false,
    NOISE_SUPPRESSION: false,
    AUTO_GAIN_CONTROL: false
};

// Practice session configuration
export const PRACTICE_CONFIG = {
    NOTE_QUEUE_SIZE: 7,
    CURRENT_NOTE_INDEX: 3, // Center position in queue
    TUNING_TOLERANCE: 5, // cents for in-tune detection
    
    // Accuracy thresholds
    EXCELLENT_ACCURACY: 80,
    GOOD_ACCURACY: 60
};

// Frequency calculation constants
export const FREQUENCY_CONFIG = {
    C0_FREQUENCY: 16.35, // Hz - reference frequency for C0
    CENTS_PER_OCTAVE: 1200,
    SEMITONES_PER_OCTAVE: 12,
    MIN_FREQUENCY: 30 // Hz - minimum detectable frequency
};

// Preset note selections
export const NOTE_PRESETS = {
    OPEN_STRINGS: ['E1', 'A1', 'D2', 'G2'],
    NATURAL_NOTES: ['E1', 'F1', 'G1', 'A1', 'B1', 'C2', 'D2', 'E2', 'F2', 'G2', 'C3'],
    ALL_NOTES_OCTAVE_1: NOTE_NAMES.map(note => note + '1'),
    ALL_NOTES_OCTAVE_2: NOTE_NAMES.map(note => note + '2'),
    ALL_NOTES_OCTAVE_3: NOTE_NAMES.map(note => note + '3'),
    
    // Combined all notes across relevant octaves
    get ALL_NOTES() {
        return [
            ...this.ALL_NOTES_OCTAVE_1,
            ...this.ALL_NOTES_OCTAVE_2,
            ...this.ALL_NOTES_OCTAVE_3
        ];
    }
};

// CSS Animation durations (in ms)
export const ANIMATION_CONFIG = {
    BUTTON_HOVER: 300,
    FADE_TRANSITION: 400,
    PRACTICE_ADVANCE: 500,
    TARGET_PULSE: 2000,
    JAZZ_PULSE: 1800,
    
    // Easing functions
    SMOOTH_EASE: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    GENTLE_EASE: 'ease-in-out'
};

// Color theme constants (for dynamic styling if needed)
export const THEME_COLORS = {
    ACCENT_GOLD: '#d4af37',
    ACCENT_GOLD_LIGHT: '#f4e4bc',
    ACCENT_CRIMSON: '#8b0000',
    ACCENT_AMBER: '#ffbf00',
    ACCENT_COPPER: '#b87333',
    
    TEXT_PRIMARY: '#f8f9fa',
    TEXT_SECONDARY: '#e9ecef',
    TEXT_MUTED: '#adb5bd'
};

// UI element IDs and selectors
export const ELEMENT_IDS = {
    // Practice controls
    START_PRACTICE_BTN: 'startPracticeBtn',
    STOP_PRACTICE_BTN: 'stopPracticeBtn',
    NOTE_QUEUE: 'noteQueue',
    
    // Statistics
    CORRECT_COUNT: 'correctCount',
    INCORRECT_COUNT: 'incorrectCount',
    ACCURACY: 'accuracy',
    LAST_RESPONSE_TIME: 'lastResponseTime',
    BEST_RESPONSE_TIME: 'bestResponseTime',
    AVG_RESPONSE_TIME: 'avgResponseTime',
    
    
    // Fretboard
    FRETBOARD: 'fretboard',
    
    // Detection display
    STATUS: 'status',
    FREQUENCY: 'frequency',
    NOTE: 'note',
    CLARITY: 'clarity',
    CLARITY_FILL: 'clarityFill'
};

// CSS class names
export const CSS_CLASSES = {
    // Note queue states
    NOTE_ITEM: 'note-item',
    NOTE_CURRENT: 'current',
    NOTE_PAST: 'past',
    NOTE_UPCOMING: 'upcoming',
    NOTE_CORRECT: 'correct',
    NOTE_INCORRECT: 'incorrect',
    
    // Distance-based styling for carousel effect
    DISTANCE_0: 'distance-0',
    DISTANCE_1: 'distance-1',
    DISTANCE_2: 'distance-2',
    DISTANCE_3: 'distance-3',
    
    // Button states
    PRACTICE_BTN: 'practice-btn',
    PRACTICE_BTN_STOP: 'stop',
    PRACTICE_BTN_ACTIVE: 'active',
    PRESET_BTN: 'preset-btn',
    
    // Fretboard elements
    NOTE_POSITION: 'note-position',
    NOTE_SELECTED: 'selected',
    TARGET_HIGHLIGHT: 'target-highlight',
    FRET_MARKER: 'fret-marker',
    STRING_LINE: 'string-line',
    FRET_LINE: 'fret-line',
    NOTE_NAME: 'note-name',
    
    // Detection status
    DETECTION_STATUS: 'detection-status',
    STATUS_ACTIVE: 'active',
    STATUS_ERROR: 'error',
    
    // Clarity levels
    CLARITY_EXCELLENT: 'excellent',
    CLARITY_GOOD: 'good',
    CLARITY_FAIR: 'fair',
    
    // Note ranges
    BASS_RANGE: 'bass-range',
    UPPER_BASS: 'upper-bass',
    
    // List states
    EMPTY: 'empty',
    HAS_NOTES: 'has-notes'
};

// Event names for custom events
export const EVENTS = {
    NOTE_SELECTION_CHANGED: 'noteSelectionChanged',
    PRACTICE_STARTED: 'practiceStarted',
    PRACTICE_STOPPED: 'practiceStopped',
    NOTE_DETECTED: 'noteDetected',
    TARGET_CHANGED: 'targetChanged'
};

// Error messages
export const ERROR_MESSAGES = {
    MICROPHONE_ACCESS: 'Could not access microphone. Please check permissions.',
    AUDIO_CONTEXT: 'Failed to initialize audio context.',
    DETECTION_FAILED: 'Audio detection failed to start.',
    NO_NOTES_SELECTED: 'Please select notes to practice.',
    BROWSER_NOT_SUPPORTED: 'Your browser does not support the required audio features.'
};

// Success messages
export const SUCCESS_MESSAGES = {
    DETECTION_STARTED: 'Audio detection started successfully.',
    PRACTICE_READY: 'Practice session ready to begin.',
    MICROPHONE_CONNECTED: 'Microphone connected successfully.'
};

// Bass Guitar Range (MIDI note numbers)
export const BASS_GUITAR_RANGE = {
    LOW_E1: 28,   // E1 - lowest note on bass guitar
    HIGH_DS4: 63, // D#4 - highest note on 20th fret
    HIGH_G3: 55   // G3 - highest note on 12th fret (G string, 12th fret)
};

// Chord Types for Chord Trainer
export const CHORD_TYPES = [
    { value: "", name: "Major Triad", description: "Root, Major 3rd, Perfect 5th" },
    { value: "m", name: "Minor Triad", description: "Root, Minor 3rd, Perfect 5th" },
    { value: "dim", name: "Diminished Triad", description: "Root, Minor 3rd, Diminished 5th" },
    { value: "aug", name: "Augmented Triad", description: "Root, Major 3rd, Augmented 5th" },
    { value: "7", name: "Dominant 7th", description: "Major triad + Minor 7th" },
    { value: "maj7", name: "Major 7th", description: "Major triad + Major 7th" },
    { value: "m7", name: "Minor 7th", description: "Minor triad + Minor 7th" },
    { value: "m7b5", name: "Minor 7th ♭5", description: "Half-diminished 7th" },
    { value: "dim7", name: "Diminished 7th", description: "Diminished triad + Diminished 7th" },
    { value: "9", name: "Dominant 9th", description: "Dominant 7th + Major 9th" },
    { value: "add9", name: "Add 9", description: "Major triad + Major 9th (no 7th)" }
];

// Chord Trainer Configuration
export const CHORD_TRAINER_CONFIG = {
    DEFAULT_FRET_LIMIT: 20,
    FRET_LIMIT_OPTIONS: [12, 20],
    MIN_CHORD_TONES: 3,
    MAX_CHORD_TONES: 7,
    DEFAULT_PRACTICE_TIME: 300, // 5 minutes in seconds
    
    // Difficulty levels
    DIFFICULTY_LEVELS: {
        BEGINNER: {
            chordTypes: ["", "m"],
            fretLimit: 12,
            rootNotes: ["C", "D", "E", "F", "G", "A", "B"]
        },
        INTERMEDIATE: {
            chordTypes: ["", "m", "7", "maj7", "m7"],
            fretLimit: 20,
            rootNotes: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        },
        ADVANCED: {
            chordTypes: ["", "m", "dim", "aug", "7", "maj7", "m7", "m7b5", "dim7", "9", "add9"],
            fretLimit: 20,
            rootNotes: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        }
    }
};

// Validation rules
export const VALIDATION = {
    MIN_SELECTED_NOTES: 1,
    MAX_SELECTED_NOTES: 100,
    MIN_ACCURACY_DISPLAY: 0,
    MAX_ACCURACY_DISPLAY: 100,
    
    // Chord trainer specific validation
    MIN_CHORD_PRACTICE_TIME: 30,  // seconds
    MAX_CHORD_PRACTICE_TIME: 1800, // 30 minutes
    MIN_CHORD_ATTEMPTS: 1,
    MAX_CHORD_ATTEMPTS: 1000
};
