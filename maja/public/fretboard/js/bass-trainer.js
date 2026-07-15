// Import shared modules
import { AudioEngine } from './shared/audio-engine.js';
import { PracticeSession } from './shared/practice-session.js';
import { StatisticsManager } from './shared/statistics-manager.js';
import { AuthStatus } from './shared/auth-status.js';
import { ELEMENT_IDS, NOTE_PRESETS, EVENTS } from './shared/constants.js';
import { 
    getElements, 
    updatePracticeButton, 
    toggleButtons 
} from './shared/ui-helpers.js';
import { loadFretboardScript } from './shared/script-loader.js';
import { ModalManager } from './shared/modal-manager.js';
import { TrainerModalController } from './shared/trainer-modal-controller.js';
import {
    initializeFretboard,
    clearFretboardSelection
} from './shared/fretboard-utils.js';
import { PresetManager } from './shared/preset-manager.js';
import { setupTrainerAuthentication } from './shared/auth-setup.js';
import {
    EXERCISE_PRESETS,
    getExerciseNotes,
    getExercisesByDifficulty,
    getExercisePreset
} from './shared/exercise-presets.js';
import {
    BASS_CONFIGURATIONS,
    getBassConfiguration,
    getAllConfigurationIds,
    getGivenNotesInRange,
    getNaturalNotesInRange,
    getAllNotesInRange
} from './shared/bass-configurations.js';
import { Services, SERVICE_NAMES } from './shared/services.js';
import * as scaleLibrary from './shared/scale-library.js';
import * as customExercises from './shared/custom-exercises.js';
import * as musicTheory from './shared/music-theory-utils.js';
import * as bassConfigurations from './shared/bass-configurations.js';

class BassTrainer {
    constructor() {
        // Initialize audio engine with chromatic trainer specific settings
        this.audioEngine = new AudioEngine({
            consensusThreshold: 10,    // Conservative detection for chromatic practice
            bufferSize: 20,            // Stable detection buffer
            volumeThreshold: 0.001,    // Require louder notes to filter out slides
            lowClarityThreshold: 0.65  // Require clearer pitch to reduce false positives
        });
        
        // Initialize practice session manager
        this.practiceSession = new PracticeSession();
        
        // Initialize statistics manager
        this.statisticsManager = new StatisticsManager();
        
        // Initialize authentication status
        this.authStatus = new AuthStatus('auth-status-container');
        
        
        // Initialize modal manager
        this.modalManager = new ModalManager();

        // Initialize preset manager for notes (legacy - keeping for compatibility)
        this.presetManager = new PresetManager('note');

        // Initialize modal controller for all trainer modals
        this.modalController = new TrainerModalController({
            onBassConfigChange: (configId) => this.handleBassConfigChange(configId),
            onExercisePresetChange: (presetId) => this.handleExercisePresetChange(presetId),
            onDisplayOptionsChange: (options) => this.handleDisplayOptionsChange(options),
            onNotification: (message, type) => this.showNotification(message, type)
        });

        // Initialize authentication setup
        this.authSetup = setupTrainerAuthentication(
            this.authStatus,
            this.statisticsManager
        );

        // Register services with Service Locator to eliminate circular dependencies
        this.registerServices();

        // Initialize components
        this.initializeUI();
        this.initializeFretboard();
        this.bindEvents();
        this.setupAudioEngine();
        this.setupPracticeSession();
        this.setupModalManager();
        this.setupPresetManager();
        
        // Initialize fretboard visibility
        this.initializeFretboardVisibility();

        // Initialize preset system UI
        this.updatePresetSystemUI();

        // Auto-apply default exercise preset
        setTimeout(() => {
            this.applyExercisePreset();
        }, 100);
    }
    
    initializeUI() {
        // Get UI elements using shared helper
        this.elements = getElements([
            ELEMENT_IDS.START_PRACTICE_BTN,
            ELEMENT_IDS.STOP_PRACTICE_BTN,
            ELEMENT_IDS.NOTE_QUEUE,
            ELEMENT_IDS.CORRECT_COUNT,
            ELEMENT_IDS.INCORRECT_COUNT,
            ELEMENT_IDS.ACCURACY,
        ]);
        
        // Get UI elements for preset system buttons
        this.bassConfigBtn = document.getElementById('bassConfigBtn');
        this.exercisePresetBtn = document.getElementById('exercisePresetBtn');
        this.displayOptionsBtn = document.getElementById('displayOptionsBtn');
        this.selectedBassConfig = document.getElementById('selectedBassConfig');
        this.selectedExercisePreset = document.getElementById('selectedExercisePreset');
        this.selectedDisplayOptions = document.getElementById('selectedDisplayOptions');
        this.exercisePresetIcon = document.getElementById('exercisePresetIcon');

        // Legacy elements (keeping for compatibility)
        this.presetDropdown = document.getElementById('notePresetSelect');
        this.fretboardModal = document.getElementById('fretboardModal');
        this.openFretboardBtn = document.getElementById('openFretboardBtn');
        this.closeFretboardModal = document.getElementById('closeFretboardModal');
        this.applyFretboardSelection = document.getElementById('applyFretboardSelection');
        this.modalFretboard = document.getElementById('modalFretboard');
        
        // Fretboard visibility elements
        this.fretboardToggle = document.getElementById('fretboardVisibleToggle');
        this.fretboardSection = document.querySelector('.fretboard-section');
        
    }
    
    initializeFretboard() {
        // Import and initialize the fretboard class using shared utilities
        loadFretboardScript().then(() => {
            const bassConfig = getBassConfiguration(this.modalController.getCurrentBassConfig());
            this.fretboard = initializeFretboard('fretboard', {
                width: 1000,
                height: 150,
                numFrets: bassConfig ? bassConfig.frets : 12
            }, bassConfig);
        });
    }
    
    bindEvents() {
        // Practice controls
        if (this.elements[ELEMENT_IDS.START_PRACTICE_BTN]) {
            this.elements[ELEMENT_IDS.START_PRACTICE_BTN].addEventListener('click', () => this.togglePractice());
        }
        if (this.elements[ELEMENT_IDS.STOP_PRACTICE_BTN]) {
            this.elements[ELEMENT_IDS.STOP_PRACTICE_BTN].addEventListener('click', () => this.stopPractice());
        }

        // Preset system event bindings - delegate to modal controller
        if (this.bassConfigBtn) {
            this.bassConfigBtn.addEventListener('click', () => this.modalController.openBassConfigModal());
        }
        if (this.exercisePresetBtn) {
            this.exercisePresetBtn.addEventListener('click', () => this.modalController.openExercisePresetModal());
        }
        if (this.displayOptionsBtn) {
            this.displayOptionsBtn.addEventListener('click', () => this.modalController.openDisplayOptionsModal());
        }

        // Legacy preset dropdown (keeping for compatibility)
        if (this.presetDropdown) {
            this.presetDropdown.addEventListener('change', (event) => this.handlePresetChange(event.target.value));
        }

        // Fretboard visibility toggle
        if (this.fretboardToggle) {
            this.fretboardToggle.addEventListener('change', () => this.handleFretboardVisibilityToggle());
        }
        
        
        // Listen for fretboard events (both inline and modal)
        const fretboardElement = document.getElementById(ELEMENT_IDS.FRETBOARD);
        if (fretboardElement) {
            fretboardElement.addEventListener(EVENTS.NOTE_SELECTION_CHANGED, (event) => {
                this.onNoteSelectionChanged(event.detail);
            });
        }
    }

    /**
     * Update the preset system UI with current selections
     */
    updatePresetSystemUI() {
        // Update bass config display
        const bassConfig = getBassConfiguration(this.modalController.getCurrentBassConfig());
        if (bassConfig && this.selectedBassConfig) {
            this.selectedBassConfig.textContent = bassConfig.name;
        }

        // Update exercise preset display
        let exercisePreset = getExercisePreset(this.modalController.getCurrentExercisePreset());

        // If not found in built-in presets, check custom exercises
        if (!exercisePreset) {
            try {
                const customExerciseService = Services.get(SERVICE_NAMES.CUSTOM_EXERCISES);
                const customExercises = customExerciseService.loadCustomExercises();
                exercisePreset = customExercises.find(ex => ex.id === this.modalController.getCurrentExercisePreset());
            } catch (error) {
                console.warn('Custom exercises not available:', error);
            }
        }

        if (exercisePreset) {
            if (this.selectedExercisePreset) {
                this.selectedExercisePreset.textContent = exercisePreset.name;
            }
            if (this.exercisePresetIcon) {
                this.exercisePresetIcon.className = `${exercisePreset.icon} text-green-400 text-xl`;
            }
        }

        // Update display options display
        this.updateDisplayOptionsDisplay();
    }

    updateDisplayOptionsDisplay() {
        if (!this.selectedDisplayOptions) return;

        const displayOptions = this.modalController.getDisplayOptions();
        const activeOptions = [];
        if (displayOptions.showNoteName) activeOptions.push('Note Names');
        if (displayOptions.playNoteSound) activeOptions.push('Sound');
        if (displayOptions.showTab) activeOptions.push('Tab');

        const displayText = activeOptions.length > 0 ? activeOptions.join(' + ') : 'None';
        this.selectedDisplayOptions.textContent = displayText;
    }



    /**
     * Handle bass configuration change from modal controller
     */
    handleBassConfigChange(configId) {
        this.modalController.setCurrentBassConfig(configId);
        this.updatePresetSystemUI();
        this.rebuildFretboardWithConfiguration(configId);
        this.applyExercisePreset();
        console.log('Bass configuration changed:', configId);
    }

    /**
     * Handle exercise preset change from modal controller
     */
    handleExercisePresetChange(presetId) {
        this.modalController.setCurrentExercisePreset(presetId);
        this.updatePresetSystemUI();
        this.applyExercisePreset();
        console.log('Exercise preset changed:', presetId);
    }

    /**
     * Handle display options change from modal controller
     */
    handleDisplayOptionsChange(options) {
        this.updateDisplayOptionsDisplay();

        // Update audio engine auto-play setting
        if (this.practiceSession && this.practiceSession.setAutoPlayEnabled) {
            this.practiceSession.setAutoPlayEnabled(options.playNoteSound);
        }

        // If practice is currently running, update session data
        if (this.practiceSession && this.practiceSession.isSessionActive && this.practiceSession.isSessionActive()) {
            if (this.practiceSession.sessionData) {
                this.practiceSession.sessionData.displayOptions = { ...options };
            }
        }

        console.log('Display options updated:', options);
    }

    /**
     * Rebuild fretboard with specified bass configuration
     */
    rebuildFretboardWithConfiguration(configId) {
        if (!this.fretboard) return;

        const bassConfig = getBassConfiguration(configId || this.modalController.getCurrentBassConfig());
        this.fretboard = initializeFretboard('fretboard', {
            width: 1000,
            height: 150,
            numFrets: bassConfig ? bassConfig.frets : 12
        }, bassConfig);
    }

    /**
     * Apply the current exercise preset to the fretboard
     */
    applyExercisePreset() {
        if (!this.fretboard) return;

        const bassConfig = getBassConfiguration(this.modalController.getCurrentBassConfig());
        let exercisePreset = getExercisePreset(this.modalController.getCurrentExercisePreset());

        // If not found in built-in presets, check custom exercises
        if (!exercisePreset) {
            try {
                const customExerciseService = Services.get(SERVICE_NAMES.CUSTOM_EXERCISES);
                const customExercises = customExerciseService.loadCustomExercises();
                exercisePreset = customExercises.find(ex => ex.id === this.modalController.getCurrentExercisePreset());
            } catch (error) {
                console.warn('Custom exercises not available:', error);
            }
        }

        if (!bassConfig || !exercisePreset) {
            console.error('Invalid bass config or exercise preset');
            return;
        }

        let notes;

        // Generate notes based on exercise type
        if (exercisePreset.isCustom) {
            try {
                const customExerciseService = Services.get(SERVICE_NAMES.CUSTOM_EXERCISES);
                notes = customExerciseService.generateCustomExerciseNotes(exercisePreset, bassConfig);
            } catch (error) {
                console.error('Error generating custom exercise notes:', error);
                return;
            }
        } else {
            notes = getExerciseNotes(
                this.modalController.getCurrentExercisePreset(),
                bassConfig,
                getGivenNotesInRange,
                getNaturalNotesInRange,
                getAllNotesInRange
            );
        }

        // Clear current selection
        clearFretboardSelection(this.fretboard);

        // Get fret range from exercise preset
        const fretMin = exercisePreset.fretMin ?? 0;
        const fretMax = exercisePreset.fretMax ?? 12;

        // Select the exercise notes within the fret range
        notes.forEach(note => {
            try {
                this.fretboard.selectNoteInRange(note, fretMin, fretMax);
            } catch (error) {
                console.warn(`Could not select note ${note}:`, error);
            }
        });

        console.log(`Applied exercise "${exercisePreset.name}" with ${notes.length} notes in fret range ${fretMin}-${fretMax}`);
    }

    /**
     * Show notification message
     */
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 4px;
            color: white;
            background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
            z-index: 9999;
            animation: slideInRight 0.3s ease-out;
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOutRight 0.3s ease-in';
            setTimeout(() => {
                document.body.removeChild(notification);
            }, 300);
        }, 3000);
    }

    /**
     * Toggle preset controls enabled/disabled state
     */
    togglePresetControls(enabled) {
        if (this.bassConfigBtn) {
            this.bassConfigBtn.disabled = !enabled;
        }
        if (this.exercisePresetBtn) {
            this.exercisePresetBtn.disabled = !enabled;
        }
        if (this.displayOptionsBtn) {
            this.displayOptionsBtn.disabled = !enabled;
        }

        // Also toggle legacy preset controls
        this.togglePresetButtons(enabled);
    }

    setupAudioEngine() {
        // Listen to consensus detections from DebouncedNoteDetector
        this.audioEngine.debouncedDetector.onNoteDetected = (noteInfo) => {
            console.log('BassTrainer: Processing consensus note:', noteInfo.fullName);
            this.practiceSession.handleDetectedNote({
                type: 'clear-debounced',
                frequency: noteInfo.frequency,
                clarity: noteInfo.clarity,
                note: {
                    name: noteInfo.name,
                    octave: noteInfo.octave,
                    fullName: noteInfo.fullName,
                    frequency: noteInfo.frequency,
                    targetFrequency: noteInfo.targetFrequency,
                    centsDeviation: noteInfo.centsDeviation,
                    isSharp: noteInfo.centsDeviation > 5,
                    isFlat: noteInfo.centsDeviation < -5,
                    isInTune: Math.abs(noteInfo.centsDeviation) <= 5
                },
                rms: noteInfo.rms,
                timestamp: noteInfo.confirmedTimestamp || noteInfo.timestamp,
                originalTimestamp: noteInfo.originalTimestamp || noteInfo.timestamp,
                detectionDelay: noteInfo.detectionDelay || 0
            });
        };
    }
    
    setupPracticeSession() {
        // Set event target for custom events
        const fretboardElement = document.getElementById(ELEMENT_IDS.FRETBOARD);
        if (fretboardElement) {
            this.practiceSession.setEventTarget(fretboardElement);
        }

        // Set audio engine reference for auto-play functionality
        this.practiceSession.setAudioEngine(this.audioEngine);

        // Set initial auto-play state based on display options
        if (this.practiceSession.setAutoPlayEnabled) {
            this.practiceSession.setAutoPlayEnabled(this.modalController.getDisplayOptions().playNoteSound);
        }
        
        // Set up practice session callbacks
        this.practiceSession.setCallbacks({
            onTargetChange: (newTarget) => {
                const sessionData = this.practiceSession.session?.sessionData;
                const fretMin = sessionData?.fretMin ?? 0;
                const fretMax = sessionData?.fretMax ?? 24;
                this.fretboard?.highlightTargetNote(newTarget, fretMin, fretMax);
            },
            onSessionStart: (firstTarget) => {
                const sessionData = this.practiceSession.session?.sessionData;
                const fretMin = sessionData?.fretMin ?? 0;
                const fretMax = sessionData?.fretMax ?? 24;
                this.fretboard?.highlightTargetNote(firstTarget, fretMin, fretMax);
                this.updatePracticeButtonState(true);
                this.togglePresetControls(false);
            },
            onSessionEnd: (sessionSummary) => {
                this.fretboard?.highlightTargetNote('');
                this.updatePracticeButtonState(false);
                this.togglePresetControls(true);

                // Re-enable practice button if there are selected notes
                const selectedNotes = this.fretboard?.getSelectedNotes() || [];
                updatePracticeButton(selectedNotes.length > 0, false);

                // Automatically save session to statistics
                const saved = this.statisticsManager.saveSession(sessionSummary);
                if (saved) {
                    console.log('Session saved to statistics');
                } else {
                    console.error('Failed to save session statistics');
                }
            }
        });
    }
    
    setupModalManager() {
        // Set up modal manager callbacks
        this.modalManager.setCallbacks({
            onCreateModalFretboard: () => {
                if (!this.modalFretboard) return null;

                const bassConfig = getBassConfiguration(this.modalController.getCurrentBassConfig());
                const modalWidth = Math.min(window.innerWidth * 0.9, 1000);
                const modalHeight = Math.min(window.innerHeight * 0.4, 200);

                const config = {
                    width: modalWidth,
                    height: modalHeight,
                    numFrets: bassConfig ? bassConfig.frets : 12
                };

                if (bassConfig) {
                    config.bassConfig = bassConfig;
                }

                const instance = new BassFretboard('modalFretboard', config);
                
                // Listen for modal fretboard events
                this.modalFretboard.addEventListener(EVENTS.NOTE_SELECTION_CHANGED, (event) => {
                    // Modal fretboard selection doesn't auto-apply, user must click "Done"
                });
                
                return instance;
            },
            onApplyModalSelection: () => {
                this.applyModalSelectionFromModal();
            },
            onFretboardModalOpen: () => {
                // Inline open: ensure the main (non-modal) fretboard is visible
                if (this.fretboardToggle) {
                    this.fretboardToggle.checked = true;
                }
                this.setFretboardVisibility(true);
            }
        });
    }
    
    setupPresetManager() {
        // Set up preset manager callbacks
        this.presetManager.setCallbacks({
            onNotePresetChange: (presetName, notes) => {
                console.log(`Applied note preset: ${presetName}`, notes);
                this.handleNotePresetSelection(notes);
            }
        });
    }
    
    /**
     * Handle note preset selection from preset manager
     * @param {string[]} notes - Array of note names to select
     */
    handleNotePresetSelection(notes) {
        if (!this.fretboard || !Array.isArray(notes)) return;
        
        // Clear current selection
        clearFretboardSelection(this.fretboard);
        
        // Select the preset notes
        notes.forEach(note => {
            try {
                this.fretboard.selectNote(note);
            } catch (error) {
                console.warn(`Could not select note ${note}:`, error);
            }
        });
        
        console.log(`Selected notes from preset:`, notes);
    }
    
    // Audio Detection Methods (now using AudioEngine)
    async startDetection() {
        const success = await this.audioEngine.startDetection();
        if (!success && this.practiceSession.isSessionActive()) {
            this.stopPractice();
        }
        return success;
    }
    
    stopDetection() {
        this.audioEngine.stopDetection();
    }
    
    // Note queue methods now handled by PracticeSession
    // Display is automatically updated via shared UI helpers
    
    // Practice Session Methods (now using PracticeSession)
    togglePractice() {
        if (this.practiceSession.isSessionActive()) {
            this.stopPractice();
        } else {
            this.startPractice();
        }
    }
    
    async startPractice() {
        if (!this.fretboard) return;
        
        const selectedNotes = this.fretboard.getSelectedNotes();
        if (selectedNotes.length === 0) return;
        
        // Start audio detection
        const audioStarted = await this.startDetection();
        if (!audioStarted) return;
        
        // Disable fretboard visibility toggle during practice
        this.updateFretboardToggleState(true);
        
        // Start practice session with fretboard visibility state and bass configuration
        const fretboardVisible = this.fretboardToggle?.checked ?? true;
        const bassConfig = getBassConfiguration(this.modalController.getCurrentBassConfig());
        let exercisePreset = getExercisePreset(this.modalController.getCurrentExercisePreset());

        // If not found in built-in presets, check custom exercises
        if (!exercisePreset) {
            try {
                const customExerciseService = Services.get(SERVICE_NAMES.CUSTOM_EXERCISES);
                const customExercises = customExerciseService.loadCustomExercises();
                exercisePreset = customExercises.find(ex => ex.id === this.modalController.getCurrentExercisePreset());
            } catch (error) {
                console.warn('Custom exercises not available:', error);
            }
        }

        const sessionMetadata = {
            fretboardVisible,
            bassConfigId: this.modalController.getCurrentBassConfig(),
            bassConfig: bassConfig,
            notationStyle: exercisePreset?.notationStyle || 'simple',
            displayOptions: { ...this.modalController.getDisplayOptions() },
            fretMin: exercisePreset?.fretMin ?? 0,
            fretMax: exercisePreset?.fretMax ?? 12
        };

        // Add scale context for scale notation style
        if (exercisePreset?.notationStyle === 'scale' && exercisePreset?.scaleRoot && exercisePreset?.scaleType) {
            sessionMetadata.scaleContext = {
                root: exercisePreset.scaleRoot,
                type: exercisePreset.scaleType
            };
        }

        this.practiceSession.startSession(selectedNotes, sessionMetadata);
    }
    
    stopPractice() {
        // Stop practice session
        this.practiceSession.stopSession();
        
        // Stop audio detection
        this.stopDetection();
        
        // Re-enable fretboard visibility toggle
        this.updateFretboardToggleState(false);
    }
    
    // Detection handling now done by AudioEngine and PracticeSession
    // Statistics are automatically updated via shared UI helpers
    
    
    // Note Selection Methods (now using shared UI helpers)
    onNoteSelectionChanged(detail) {
        updatePracticeButton(detail.selectedNotes.length > 0, this.practiceSession.isSessionActive());
        
        // Stop practice if no notes selected
        if (detail.selectedNotes.length === 0 && this.practiceSession.isSessionActive()) {
            this.stopPractice();
        }
    }
    
    // UI state management helpers
    updatePracticeButtonState(isActive) {
        const startBtn = this.elements[ELEMENT_IDS.START_PRACTICE_BTN];
        const stopBtn = this.elements[ELEMENT_IDS.STOP_PRACTICE_BTN];

        if (startBtn) {
            if (isActive) {
                startBtn.classList.add('active');
                startBtn.title = 'Practice is running';
            } else {
                startBtn.classList.remove('active');
                startBtn.title = 'Start Practice & Listen';
            }
        }

        if (stopBtn) {
            if (isActive) {
                stopBtn.classList.remove('hidden');
            } else {
                stopBtn.classList.add('hidden');
            }
        }
    }
    
    togglePresetButtons(enabled) {
        // Note: This method now controls the dropdown instead of buttons
        if (this.presetDropdown) {
            this.presetDropdown.disabled = !enabled;
        }
    }
    
    handlePresetChange(value) {
        if (!value || !this.fretboard) return;
        
        // Reset dropdown to placeholder
        setTimeout(() => {
            this.presetDropdown.value = '';
        }, 100);
        
        // Apply preset selection
        switch (value) {
            case 'open':
                this.fretboard.selectOpenStrings();
                break;
            case 'natural':
                this.fretboard.selectNaturalNotes();
                break;
            case 'all':
                this.fretboard.selectAllNotes();
                break;
            case 'clear':
                clearFretboardSelection(this.fretboard);
                break;
        }
    }
    
    handleFretboardVisibilityToggle() {
        const isVisible = this.fretboardToggle.checked;
        this.setFretboardVisibility(isVisible);
        
        // Save preference to localStorage
        localStorage.setItem('bassTrainer.fretboardVisible', isVisible);
    }
    
    setFretboardVisibility(visible) {
        if (!this.fretboardSection) return;
        
        if (visible) {
            this.fretboardSection.classList.remove('hidden');
        } else {
            this.fretboardSection.classList.add('hidden');
        }
    }
    
    initializeFretboardVisibility() {
        // Load saved preference or default to visible
        const savedVisibility = localStorage.getItem('bassTrainer.fretboardVisible');
        const isVisible = savedVisibility === null ? true : savedVisibility === 'true';
        
        // Set toggle state
        if (this.fretboardToggle) {
            this.fretboardToggle.checked = isVisible;
        }
        
        // Apply visibility
        this.setFretboardVisibility(isVisible);
    }
    
    updateFretboardToggleState(disabled) {
        if (this.fretboardToggle) {
            this.fretboardToggle.disabled = disabled;
        }
    }
    
    
    syncModalFretboard() {
        const modalInstance = this.modalManager.modalFretboardInstance;
        if (!modalInstance || !this.fretboard) return;
        
        // Copy current position selection to modal fretboard
        const currentPositions = this.fretboard.getSelectedPositions?.() || [];
        modalInstance.clearSelection();
        if (currentPositions.length > 0 && typeof modalInstance.selectPositionByKey === 'function') {
            currentPositions.forEach(posKey => modalInstance.selectPositionByKey(posKey));
        } else {
            // Fallback for pitch-only selection
            this.fretboard.getSelectedNotes().forEach(note => modalInstance.selectNote(note));
        }
    }
    
    applyModalSelectionFromModal() {
        const modalInstance = this.modalManager.modalFretboardInstance;
        if (!modalInstance || !this.fretboard) return;
        
        // Copy modal position selection back to main fretboard
        const modalPositions = modalInstance.getSelectedPositions?.() || [];
        clearFretboardSelection(this.fretboard);
        if (modalPositions.length > 0 && typeof this.fretboard.selectPositionByKey === 'function') {
            modalPositions.forEach(posKey => this.fretboard.selectPositionByKey(posKey));
        } else {
            modalInstance.getSelectedNotes().forEach(note => this.fretboard.selectNote(note));
        }
    }
    
    // Statistics Methods
    
    /**
     * Get weekly statistics
     * @returns {Object} Weekly statistics object
     */
    getWeeklyStats() {
        return this.statisticsManager.getStatistics({ period: 'week' });
    }
    
    /**
     * Get all-time statistics
     * @returns {Object} All-time statistics object
     */
    getAllTimeStats() {
        return this.statisticsManager.getStatistics({ period: 'all' });
    }
    
    /**
     * Export all statistics data for backup
     * @returns {Object} Complete statistics data
     */
    exportStatistics() {
        return this.statisticsManager.exportData();
    }
    
    /**
     * Clear all stored statistics data
     * @returns {boolean} Success status
     */
    clearStatistics() {
        return this.statisticsManager.clearAllData();
    }

    /**
     * Set up authentication integration
     */
    
    // Cleanup method
    destroy() {
        this.practiceSession.stopSession();
        this.audioEngine.stopDetection();
        
        // Clean up shared modules
        if (this.modalManager) {
            this.modalManager.destroy();
        }
        if (this.presetManager) {
            this.presetManager.reset();
        }
        if (this.authSetup) {
            this.authSetup.cleanup();
        }

        // Clear services
        Services.clear();
    }

    /**
     * Register all services with the Service Locator
     * This eliminates circular dependencies and provides clean access to modules
     */
    registerServices() {
        console.log('🔧 Registering services with Service Locator...');

        try {
            // Register all shared modules
            Services.register(SERVICE_NAMES.SCALE_LIBRARY, scaleLibrary);
            Services.register(SERVICE_NAMES.CUSTOM_EXERCISES, customExercises);
            Services.register(SERVICE_NAMES.MUSIC_THEORY, musicTheory);
            Services.register(SERVICE_NAMES.BASS_CONFIGURATIONS, bassConfigurations);

            // Mark services as initialized
            Services.markInitialized();

            console.log('✅ All services registered successfully');
        } catch (error) {
            console.error('❌ Failed to register services:', error);
        }
    }
}

// Initialize the trainer when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.trainer = new BassTrainer();
});
