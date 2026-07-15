/**
 * Debounced Note Detector
 *
 * A consensus layer over AudioEngine that provides stable note detection.
 * Uses a circular buffer to track recent detections and requires consecutive
 * identical notes before confirming a detection.
 *
 * This class does NOT perform pitch detection - it receives detection results
 * from AudioEngine and applies consensus logic.
 */
export class DebouncedNoteDetector {
    constructor(options = {}) {
        // Configuration
        this.bufferSize = options.bufferSize || 10; // Number of recent detections to store
        this.consensusThreshold = options.consensusThreshold || 3; // Consecutive detections needed

        // Circular buffer for consensus tracking
        this.detectionBuffer = [];
        this.bufferIndex = 0;
        this.lastConfirmedNote = null;
        this.firstDetectionTimestamp = null;

        // Event callbacks
        this.onNoteDetected = null;
        this.onNoteCleared = null;
        this.onNoteChanged = null;

        // Initialize buffer with null values
        this.resetBuffer();
    }
    
    /**
     * Add a detection result from AudioEngine
     * @param {Object|null} noteInfo - Note info from AudioEngine (name, octave, fullName, frequency, etc.) or null
     * @param {number} rms - RMS volume level from the detection
     * @param {number} clarity - Clarity value from the pitch detector
     */
    addDetection(noteInfo, rms, clarity) {
        let detectedNote = null;

        if (noteInfo) {
            detectedNote = {
                ...noteInfo,
                rms,
                clarity,
                timestamp: Date.now(),
                isFirstDetection: false
            };
        }

        // Add detection to circular buffer
        this.addToBuffer(detectedNote);

        // Check for consensus and update confirmed note
        this.updateConfirmedNote();
    }

    /**
     * Reset the circular buffer
     */
    resetBuffer() {
        this.detectionBuffer = new Array(this.bufferSize).fill(null);
        this.bufferIndex = 0;
        this.firstDetectionTimestamp = null;
    }
    
    /**
     * Add a detection result to the circular buffer
     * @param {Object|null} noteInfo - Detected note info or null if no note
     */
    addToBuffer(noteInfo) {
        // Track first detection timestamp for timing accuracy
        if (noteInfo) {
            // Check if this is the start of a new note sequence
            const lastDetection = this.bufferIndex > 0 ? 
                this.detectionBuffer[this.bufferIndex - 1] : 
                this.detectionBuffer[this.bufferSize - 1];
            
            // If previous detection was null or different note, this is a first detection
            if (!lastDetection || lastDetection.fullName !== noteInfo.fullName) {
                this.firstDetectionTimestamp = noteInfo.timestamp;
                noteInfo.isFirstDetection = true;
            }
        } else {
            // Clear first detection timestamp when we lose the note
            this.firstDetectionTimestamp = null;
        }
        
        this.detectionBuffer[this.bufferIndex] = noteInfo;
        this.bufferIndex = (this.bufferIndex + 1) % this.bufferSize;
    }
    
    /**
     * Check for consensus in the buffer and update confirmed note
     */
    updateConfirmedNote() {
        const consensusNote = this.findConsensus();
        
        // Compare note names instead of object references
        const currentNoteName = this.lastConfirmedNote ? this.lastConfirmedNote.fullName : null;
        const newNoteName = consensusNote ? consensusNote.fullName : null;
        
        if (currentNoteName !== newNoteName) {
            const previousNote = this.lastConfirmedNote;
            this.lastConfirmedNote = consensusNote;
            
            if (consensusNote) {
                // Add timing information to the consensus note
                const enhancedNote = {
                    ...consensusNote,
                    confirmedTimestamp: consensusNote.timestamp,
                    originalTimestamp: this.firstDetectionTimestamp || consensusNote.timestamp,
                    detectionDelay: consensusNote.timestamp - (this.firstDetectionTimestamp || consensusNote.timestamp)
                };
                
                if (this.onNoteDetected) {
                    this.onNoteDetected(enhancedNote);
                }
                if (previousNote && this.onNoteChanged) {
                    this.onNoteChanged(enhancedNote, previousNote);
                }
            } else {
                if (this.onNoteCleared) {
                    this.onNoteCleared();
                }
            }
        }
    }
    
    /**
     * Find consensus note from recent detections
     * @returns {Object|null} Consensus note or null if no consensus
     */
    findConsensus() {
        // Get the most recent detections for consensus checking
        const recentDetections = [];
        for (let i = 0; i < this.consensusThreshold; i++) {
            const index = (this.bufferIndex - 1 - i + this.bufferSize) % this.bufferSize;
            recentDetections.push(this.detectionBuffer[index]);
        }
        
        // Check if we have enough consecutive non-null detections of the same note
        if (recentDetections.length < this.consensusThreshold) {
            return null;
        }
        
        const firstNote = recentDetections[0];
        if (!firstNote) {
            return null;
        }
        
        // Check if all recent detections are the same note
        const allSameNote = recentDetections.every(detection => 
            detection && detection.fullName === firstNote.fullName
        );
        
        return allSameNote ? firstNote : null;
    }
    
    
    /**
     * Get current confirmed note
     * @returns {Object|null} Current confirmed note or null
     */
    getCurrentNote() {
        return this.lastConfirmedNote;
    }
    
    /**
     * Check if a specific note is currently being detected
     * @param {string} noteFullName - Note name with octave (e.g., "E1")
     * @returns {boolean} True if the note is currently confirmed
     */
    isDetecting(noteFullName) {
        return this.lastConfirmedNote && this.lastConfirmedNote.fullName === noteFullName;
    }
}