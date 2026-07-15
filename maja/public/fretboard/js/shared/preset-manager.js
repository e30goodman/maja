/**
 * Preset Management Utilities
 * Handles preset selection and configuration for both chord and note trainers
 */

import { CHORD_TRAINER_CONFIG } from './constants.js';

export class PresetManager {
    constructor(type = 'chord') {
        this.type = type; // 'chord' or 'note'
        this.selectedTypes = [];
        this.selectedNotes = [];
        this.fretLimit = 12;
        this.rootNotes = [];
        this.activePreset = null;
        
        this.presetButtons = [];
        this.typeSelect = null;
        this.fretLimitSelect = null;
        
        this.initializeElements();
        this.bindEvents();
    }
    
    initializeElements() {
        this.presetButtons = document.querySelectorAll('.preset-btn');
        
        if (this.type === 'chord') {
            this.typeSelect = document.getElementById('chordTypesSelect');
            this.fretLimitSelect = document.getElementById('fretLimitSelect');
        } else if (this.type === 'note') {
            this.typeSelect = document.getElementById('notePresetSelect');
        }
    }
    
    bindEvents() {
        // Preset buttons
        this.presetButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const preset = e.target.dataset.preset;
                this.handlePresetSelection(preset);
            });
        });
        
        // Type selection changes
        if (this.typeSelect) {
            if (this.type === 'chord') {
                this.typeSelect.addEventListener('change', () => this.updateSelectedChordTypes());
            } else if (this.type === 'note') {
                this.typeSelect.addEventListener('change', (e) => this.handleNotePresetChange(e.target.value));
            }
        }
        
        // Fret limit changes
        if (this.fretLimitSelect) {
            this.fretLimitSelect.addEventListener('change', (e) => {
                this.fretLimit = parseInt(e.target.value);
                this.onFretLimitChange?.(this.fretLimit);
            });
        }
    }
    
    /**
     * Handle preset selection for chord trainer
     * @param {string} preset - Preset name (beginner, intermediate, advanced)
     */
    handlePresetSelection(preset) {
        if (!preset || this.type !== 'chord') return;
        
        // Clear previous preset selection
        this.clearPresetSelection();
        
        // Set active preset
        const activeButton = document.querySelector(`.preset-btn[data-preset="${preset}"]`);
        if (activeButton) {
            activeButton.classList.add('active');
            this.activePreset = preset;
        }
        
        // Configure based on preset
        const config = CHORD_TRAINER_CONFIG.DIFFICULTY_LEVELS[preset.toUpperCase()];
        if (config) {
            // Update chord types selection
            this.selectedTypes = [...config.chordTypes];
            this.updateChordTypesSelection();
            
            // Update fret limit
            this.fretLimit = config.fretLimit;
            if (this.fretLimitSelect) {
                this.fretLimitSelect.value = config.fretLimit.toString();
            }
            
            // Update root notes
            this.rootNotes = [...config.rootNotes];
            
            // Trigger callbacks
            this.onPresetChange?.(preset, config);
            this.onFretLimitChange?.(this.fretLimit);
            
            console.log(`Applied preset: ${preset}`, config);
        }
    }
    
    /**
     * Handle note preset changes for note trainer
     * @param {string} presetName - Name of the note preset
     */
    handleNotePresetChange(presetName) {
        if (this.type !== 'note' || !presetName) return;
        
        // Get notes data from the selected option's data-notes attribute
        const selectedOption = this.typeSelect.querySelector(`option[value="${presetName}"]`);
        const notesData = selectedOption?.dataset.notes;
        
        if (notesData) {
            try {
                const notes = JSON.parse(notesData);
                this.selectedNotes = [...notes];
                this.activePreset = presetName;
                
                // Trigger callback
                this.onNotePresetChange?.(presetName, notes);
                
                console.log(`Applied note preset: ${presetName}`, notes);
            } catch (error) {
                console.error(`Failed to parse notes data for preset ${presetName}:`, error);
            }
        }
    }
    
    /**
     * Update selected chord types from multi-select
     */
    updateSelectedChordTypes() {
        if (!this.typeSelect || this.type !== 'chord') return;
        
        const selectedOptions = Array.from(this.typeSelect.selectedOptions);
        this.selectedTypes = selectedOptions.map(option => option.value);
        
        // Clear preset selection if manual change
        if (this.selectedTypes.length > 0) {
            this.clearPresetSelection();
        }
        
        // Trigger callback
        this.onChordTypesChange?.(this.selectedTypes);
        
        console.log('Selected chord types:', this.selectedTypes);
    }
    
    /**
     * Update chord types multi-select based on current selection
     */
    updateChordTypesSelection() {
        if (!this.typeSelect || this.type !== 'chord') return;
        
        // Clear and set selections
        Array.from(this.typeSelect.options).forEach(option => {
            option.selected = this.selectedTypes.includes(option.value);
        });
    }
    
    /**
     * Clear all preset button selections
     */
    clearPresetSelection() {
        this.presetButtons.forEach(btn => btn.classList.remove('active'));
        this.activePreset = null;
    }
    
    /**
     * Toggle preset controls enabled/disabled state
     * @param {boolean} enabled - Whether controls should be enabled
     */
    toggleControls(enabled) {
        if (this.typeSelect) {
            this.typeSelect.disabled = !enabled;
        }
        if (this.fretLimitSelect) {
            this.fretLimitSelect.disabled = !enabled;
        }
        this.presetButtons.forEach(button => {
            button.disabled = !enabled;
        });
    }
    
    /**
     * Get current configuration
     * @returns {Object} Current preset configuration
     */
    getCurrentConfig() {
        if (this.type === 'chord') {
            return {
                chordTypes: this.selectedTypes,
                fretLimit: this.fretLimit,
                rootNotes: this.rootNotes,
                preset: this.activePreset
            };
        } else if (this.type === 'note') {
            return {
                selectedNotes: this.selectedNotes,
                preset: this.activePreset
            };
        }
        return {};
    }
    
    /**
     * Check if current configuration is valid for practice
     * @returns {boolean} Whether configuration is valid
     */
    isValidConfig() {
        if (this.type === 'chord') {
            return this.selectedTypes.length > 0;
        } else if (this.type === 'note') {
            return this.selectedNotes.length > 0;
        }
        return false;
    }
    
    /**
     * Set callback functions for preset events
     * @param {Object} callbacks - Object containing callback functions
     */
    setCallbacks(callbacks) {
        if (callbacks.onPresetChange) {
            this.onPresetChange = callbacks.onPresetChange;
        }
        if (callbacks.onChordTypesChange) {
            this.onChordTypesChange = callbacks.onChordTypesChange;
        }
        if (callbacks.onNotePresetChange) {
            this.onNotePresetChange = callbacks.onNotePresetChange;
        }
        if (callbacks.onFretLimitChange) {
            this.onFretLimitChange = callbacks.onFretLimitChange;
        }
    }
    
    /**
     * Reset to default state
     */
    reset() {
        this.clearPresetSelection();
        this.selectedTypes = [];
        this.selectedNotes = [];
        this.fretLimit = 12;
        this.rootNotes = [];
        this.activePreset = null;
        
        if (this.fretLimitSelect) {
            this.fretLimitSelect.value = '12';
        }
        
        if (this.typeSelect && this.type === 'chord') {
            Array.from(this.typeSelect.options).forEach(option => {
                option.selected = false;
            });
        }
    }
}