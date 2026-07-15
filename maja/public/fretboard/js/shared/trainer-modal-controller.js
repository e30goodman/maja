import { Services, SERVICE_NAMES } from './services.js';
import {
    getBassConfiguration,
    getAllConfigurationIds
} from './bass-configurations.js';
import {
    getExercisePreset,
    getExercisesByDifficulty
} from './exercise-presets.js';
import { SelectionModalManager } from './selection-modal-manager.js';

/**
 * Default exercise by device:
 * - phone/narrow: Open Strings
 * - desktop: First Position (natural notes within first 5 frets)
 */
export function getDefaultExercisePresetId() {
    const vw = Math.min(
        window.innerWidth || 9999,
        document.documentElement.clientWidth || 9999,
        (window.visualViewport && window.visualViewport.width) || 9999
    );
    const isPhone = window.matchMedia('(max-width: 900px)').matches || vw <= 900;
    return isPhone ? 'open-strings' : 'first-position';
}

/**
 * Manages all modal dialogs for the bass trainer
 * Handles bass config, exercise presets, custom exercises, and display options
 */
export class TrainerModalController {
    constructor(callbacks = {}) {
        this.callbacks = {
            onBassConfigChange: callbacks.onBassConfigChange || (() => {}),
            onExercisePresetChange: callbacks.onExercisePresetChange || (() => {}),
            onDisplayOptionsChange: callbacks.onDisplayOptionsChange || (() => {}),
            onNotification: callbacks.onNotification || (() => {})
        };

        this.currentBassConfig = 'bass-4-standard-20';
        // Mobile: open strings. Desktop: First Position (natural notes, frets 0–5).
        this.currentExercisePreset = getDefaultExercisePresetId();
        this.displayOptions = {
            showNoteName: true,
            playNoteSound: false,
            showTab: false
        };

        this.initializeModals();
        this.initializeCustomExerciseModal();
        this.initializeDisplayOptionsModal();
        this.loadDisplayOptions();
    }

    initializeModals() {
        // Bass Configuration Modal
        this.bassConfigModal = new SelectionModalManager({
            modalId: 'bassConfigModal',
            listId: 'bassConfigList',
            closeBtnId: 'closeBassConfigModal',
            cancelBtnId: 'cancelBassConfig',
            displayElementId: 'selectedBassConfig',
            onSelect: (value) => {
                this.selectBassConfiguration(value);
            },
            renderItem: (item) => {
                return `
                    <div class="bass-config-name">${item.label}</div>
                    <div class="bass-config-details">${item.description}</div>
                `;
            }
        });

        this.populateBassConfigList();

        // Exercise Preset Modal
        this.exercisePresetModal = new SelectionModalManager({
            modalId: 'exercisePresetModal',
            listId: 'exercisePresetList',
            closeOnSelect: false,
            closeBtnId: 'closeExercisePresetModal',
            cancelBtnId: 'cancelExercisePreset',
            displayElementId: 'selectedExercisePreset',
            onSelect: (value) => {
                this.selectExercisePreset(value);
            },
            renderItem: (item) => {
                return `
                    <div class="exercise-preset-icon">
                        <i class="${item.icon}"></i>
                        ${item.isCustom ? '<i class="fas fa-user-edit custom-indicator" title="Custom Exercise"></i>' : ''}
                    </div>
                    <div class="exercise-preset-content">
                        <div class="exercise-preset-name">${item.label}</div>
                        <div class="exercise-preset-description">${item.description}</div>
                        <div class="exercise-preset-difficulty ${item.difficulty}">${item.difficulty}</div>
                    </div>
                    ${item.isCustom ? `
                        <div class="custom-exercise-actions" data-prevent-select>
                            <button class="delete-custom-exercise" data-exercise-id="${item.value}" title="Delete">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    ` : ''}
                `;
            }
        });

        // Bind difficulty filter and custom exercise buttons
        this.bindExercisePresetControls();
        this.populateExercisePresetList();
    }

    populateBassConfigList() {
        const configIds = getAllConfigurationIds();
        const items = configIds.map(configId => {
            const config = getBassConfiguration(configId);
            if (!config) return null;

            const stringInfo = config.strings.map(s => `${s.note}${s.octave}`).join(' - ');
            return {
                value: configId,
                label: config.name,
                description: `${config.strings.length} strings: ${stringInfo}`,
                className: 'bass-config-item'
            };
        }).filter(Boolean);

        this.bassConfigModal.setItems(items);
        this.bassConfigModal.setValue(this.currentBassConfig);
    }

    populateExercisePresetList() {
        const currentDifficulty = this.getCurrentDifficultyFilter();
        let exercises = getExercisesByDifficulty(currentDifficulty);

        // Add custom exercises
        try {
            if (Services.has(SERVICE_NAMES.CUSTOM_EXERCISES)) {
                const customExerciseService = Services.get(SERVICE_NAMES.CUSTOM_EXERCISES);
                const customExercises = customExerciseService.loadCustomExercises();
                const filteredCustomExercises = currentDifficulty === 'all' ?
                    customExercises :
                    customExercises.filter(ex => ex.difficulty === currentDifficulty);
                exercises = [...exercises, ...filteredCustomExercises];
            }
        } catch (error) {
            console.warn('Custom exercises not available:', error);
        }

        const items = exercises.map(exercise => ({
            value: exercise.id,
            label: exercise.name,
            description: exercise.description,
            icon: exercise.icon,
            difficulty: exercise.difficulty,
            isCustom: exercise.isCustom,
            className: 'exercise-preset-item'
        }));

        this.exercisePresetModal.setItems(items);
        this.exercisePresetModal.setValue(this.currentExercisePreset);
    }

    bindExercisePresetControls() {
        // Difficulty filter buttons
        const filterButtons = document.querySelectorAll('.difficulty-filter-btn');
        filterButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                filterButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.populateExercisePresetList();
            });
        });

        // Create custom exercise button
        const createCustomBtn = document.getElementById('createCustomExercise');
        createCustomBtn?.addEventListener('click', () => this.openCustomExerciseModal());

        // Delete custom exercise handler (delegated)
        document.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.delete-custom-exercise');
            if (deleteBtn) {
                const exerciseId = deleteBtn.dataset.exerciseId;
                this.deleteCustomExercise(exerciseId);
            }
        });
    }

    getCurrentDifficultyFilter() {
        const activeFilter = document.querySelector('.difficulty-filter-btn.active');
        return activeFilter ? activeFilter.dataset.difficulty : 'all';
    }

    selectBassConfiguration(configId) {
        if (this.currentBassConfig === configId) return;
        this.currentBassConfig = configId;
        this.callbacks.onBassConfigChange(configId);
    }

    selectExercisePreset(exerciseId) {
        if (this.currentExercisePreset === exerciseId) return;
        this.currentExercisePreset = exerciseId;
        this.callbacks.onExercisePresetChange(exerciseId);
        this.exercisePresetModal.close();
    }

    deleteCustomExercise(exerciseId) {
        if (!confirm('Are you sure you want to delete this custom exercise?')) return;

        try {
            const customExerciseService = Services.get(SERVICE_NAMES.CUSTOM_EXERCISES);
            const deleted = customExerciseService.deleteCustomExercise(exerciseId);

            if (deleted) {
                if (this.currentExercisePreset === exerciseId) {
                    this.selectExercisePreset('open-strings');
                }
                this.populateExercisePresetList();
                this.callbacks.onNotification('Custom exercise deleted', 'info');
            } else {
                throw new Error('Failed to delete exercise');
            }
        } catch (error) {
            console.error('Error deleting custom exercise:', error);
            this.callbacks.onNotification('Failed to delete custom exercise', 'error');
        }
    }

    // ==================== Bass Config Modal Public API ====================

    openBassConfigModal() {
        this.bassConfigModal.open();
    }

    // ==================== Exercise Preset Modal Public API ====================

    openExercisePresetModal() {
        this.populateExercisePresetList();
        this.exercisePresetModal.open();
    }

    // ==================== Custom Exercise Modal ====================

    initializeCustomExerciseModal() {
        this.customExerciseModal = document.getElementById('customExerciseModal');
        this.closeCustomExerciseModalBtn = document.getElementById('closeCustomExerciseModal');
        this.cancelCustomExerciseBtn = document.getElementById('cancelCustomExercise');
        this.saveCustomExerciseBtn = document.getElementById('saveCustomExercise');

        this.closeCustomExerciseModalBtn?.addEventListener('click', () => this.closeCustomExerciseModal());
        this.cancelCustomExerciseBtn?.addEventListener('click', () => this.closeCustomExerciseModal());
        this.saveCustomExerciseBtn?.addEventListener('click', () => this.saveCustomExercise());
        this.customExerciseModal?.addEventListener('click', (e) => {
            if (e.target === this.customExerciseModal) this.closeCustomExerciseModal();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!this.customExerciseModal?.classList.contains('hidden')) this.closeCustomExerciseModal();
            }
        });
    }

    openCustomExerciseModal() {
        this.customExerciseModal?.classList.remove('hidden');
        this.customExerciseModal?.classList.add('active');
        document.body.style.overflow = 'hidden';
        this.resetCustomExerciseForm();
        this.bindCustomExerciseEvents();
    }

    closeCustomExerciseModal() {
        this.customExerciseModal?.classList.add('hidden');
        this.customExerciseModal?.classList.remove('active');
        document.body.style.overflow = '';
        this.resetCustomExerciseForm();
    }

    resetCustomExerciseForm() {
        document.getElementById('customExerciseName')?.setAttribute('value', '');
        document.getElementById('fretMinSlider')?.setAttribute('value', '0');
        document.getElementById('fretMaxSlider')?.setAttribute('value', '12');

        document.querySelectorAll('.method-tab').forEach(tab => tab.classList.remove('active'));
        document.querySelector('.method-tab[data-method="chromatic"]')?.classList.add('active');

        document.querySelectorAll('.method-content').forEach(content => content.classList.remove('active'));
        document.querySelector('.method-content[data-method="chromatic"]')?.classList.add('active');

        document.querySelector('input[name="customNotationStyle"][value="simple"]')?.setAttribute('checked', 'checked');
        document.querySelectorAll('.note-checkbox input[type="checkbox"]').forEach(cb => cb.checked = false);

        const validation = document.getElementById('customExerciseValidation');
        if (validation) validation.textContent = '';

        this.updateFretRangeDisplay();
        this.updateScalePreview();
    }

    bindCustomExerciseEvents() {
        const fretMinSlider = document.getElementById('fretMinSlider');
        const fretMaxSlider = document.getElementById('fretMaxSlider');

        fretMinSlider?.addEventListener('input', () => this.updateFretRangeDisplay());
        fretMaxSlider?.addEventListener('input', () => this.updateFretRangeDisplay());

        document.querySelectorAll('.method-tab').forEach(tab => {
            tab.addEventListener('click', () => this.handleNotePoolMethodChange(tab.dataset.method));
        });

        const scaleRoot = document.getElementById('scaleRoot');
        const scaleType = document.getElementById('scaleType');
        scaleRoot?.addEventListener('change', () => this.updateScalePreview());
        scaleType?.addEventListener('change', () => this.updateScalePreview());

        document.getElementById('selectAllNotes')?.addEventListener('click', () => {
            document.querySelectorAll('.note-checkbox input[type="checkbox"]').forEach(cb => cb.checked = true);
        });
        document.getElementById('clearAllNotes')?.addEventListener('click', () => {
            document.querySelectorAll('.note-checkbox input[type="checkbox"]').forEach(cb => cb.checked = false);
        });
    }

    handleNotePoolMethodChange(method) {
        document.querySelectorAll('.method-tab').forEach(tab => tab.classList.remove('active'));
        document.querySelector(`.method-tab[data-method="${method}"]`)?.classList.add('active');

        document.querySelectorAll('.method-content').forEach(content => content.classList.remove('active'));
        document.querySelector(`.method-content[data-method="${method}"]`)?.classList.add('active');

        if (method === 'scale') this.updateScalePreview();
    }

    updateScalePreview() {
        const scaleRoot = document.getElementById('scaleRoot')?.value;
        const scaleType = document.getElementById('scaleType')?.value;
        const previewContainer = document.getElementById('scaleNotesPreview');
        if (!previewContainer) return;

        if (!scaleRoot || !scaleType) {
            previewContainer.innerHTML = '<span class="text-gray-400">Select root and scale type</span>';
            return;
        }

        try {
            const scaleLibraryService = Services.get(SERVICE_NAMES.SCALE_LIBRARY);
            const scaleNotes = scaleLibraryService.getScaleNotes(scaleRoot, scaleType);

            if (scaleNotes && scaleNotes.length > 0) {
                previewContainer.innerHTML = scaleNotes.map(note =>
                    `<span class="note-preview">${note}</span>`
                ).join('');
            } else {
                previewContainer.innerHTML = '<span class="text-red-400">Scale not found</span>';
            }
        } catch (error) {
            previewContainer.innerHTML = '<span class="text-red-400">Error loading scale</span>';
            console.error('Error updating scale preview:', error);
        }
    }

    updateFretRangeDisplay() {
        const fretMinSlider = document.getElementById('fretMinSlider');
        const fretMaxSlider = document.getElementById('fretMaxSlider');
        const fretMinDisplay = document.getElementById('fretMinDisplay');
        const fretMaxDisplay = document.getElementById('fretMaxDisplay');
        const rangeSummary = document.querySelector('.range-summary');

        if (fretMinSlider && fretMaxSlider && fretMinDisplay && fretMaxDisplay && rangeSummary) {
            const fretMin = fretMinSlider.value;
            const fretMax = fretMaxSlider.value;
            fretMinDisplay.textContent = fretMin;
            fretMaxDisplay.textContent = fretMax;
            rangeSummary.textContent = `Frets ${fretMin}-${fretMax}`;
        }
    }

    validateCustomExercise() {
        const validation = document.getElementById('customExerciseValidation');
        const name = document.getElementById('customExerciseName')?.value?.trim();
        const fretMinSlider = document.getElementById('fretMinSlider');
        const fretMaxSlider = document.getElementById('fretMaxSlider');
        const activeMethodTab = document.querySelector('.method-tab.active');

        if (!validation) return false;

        validation.textContent = '';
        validation.className = 'validation-message';

        if (!name) {
            validation.textContent = 'Exercise name is required';
            validation.classList.add('error');
            return false;
        }

        if (fretMinSlider && fretMaxSlider) {
            const fretMin = parseInt(fretMinSlider.value);
            const fretMax = parseInt(fretMaxSlider.value);
            if (fretMin >= fretMax) {
                validation.textContent = 'Max fret must be greater than min fret';
                validation.classList.add('error');
                return false;
            }
        }

        if (activeMethodTab && activeMethodTab.dataset.method === 'custom') {
            const selectedNotes = Array.from(document.querySelectorAll('.note-checkbox input:checked')).length;
            if (selectedNotes === 0) {
                validation.textContent = 'Select at least one note for custom method';
                validation.classList.add('error');
                return false;
            }
        }

        validation.textContent = '✓ Exercise configuration is valid';
        validation.classList.add('success');
        return true;
    }

    saveCustomExercise() {
        if (!this.validateCustomExercise()) return;

        const name = document.getElementById('customExerciseName')?.value.trim();
        const fretMinSlider = document.getElementById('fretMinSlider');
        const fretMaxSlider = document.getElementById('fretMaxSlider');
        const activeMethodTab = document.querySelector('.method-tab.active');
        const notationStyleInput = document.querySelector('input[name="customNotationStyle"]:checked');

        if (!fretMinSlider || !fretMaxSlider || !activeMethodTab || !notationStyleInput) {
            console.error('Required form elements not found');
            return;
        }

        const exerciseConfig = {
            name: name || '',
            fretMin: parseInt(fretMinSlider.value),
            fretMax: parseInt(fretMaxSlider.value),
            notePoolMethod: activeMethodTab.dataset.method,
            notationStyle: notationStyleInput.value
        };

        if (activeMethodTab.dataset.method === 'scale') {
            const scaleRoot = document.getElementById('scaleRoot');
            const scaleType = document.getElementById('scaleType');
            if (scaleRoot && scaleType) {
                exerciseConfig.scaleRoot = scaleRoot.value;
                exerciseConfig.scaleType = scaleType.value;
            }
        } else if (activeMethodTab.dataset.method === 'custom') {
            exerciseConfig.customNotes = Array.from(
                document.querySelectorAll('.note-checkbox input:checked')
            ).map(cb => cb.value);
        }

        try {
            const customExerciseService = Services.get(SERVICE_NAMES.CUSTOM_EXERCISES);
            const exercise = customExerciseService.createCustomExercise(exerciseConfig);
            const saved = customExerciseService.saveCustomExercise(exercise);

            if (saved) {
                this.closeCustomExerciseModal();
                this.populateExercisePresetList();
                this.callbacks.onNotification('Custom exercise saved successfully!', 'success');
            } else {
                throw new Error('Failed to save exercise');
            }
        } catch (error) {
            console.error('Error saving custom exercise:', error);
            this.callbacks.onNotification('Failed to save custom exercise', 'error');
        }
    }

    // ==================== Display Options Modal ====================

    initializeDisplayOptionsModal() {
        this.displayOptionsModal = document.getElementById('displayOptionsModal');
        this.closeDisplayOptionsModal = document.getElementById('closeDisplayOptionsModal');
        this.applyDisplayOptions = document.getElementById('applyDisplayOptions');
        this.cancelDisplayOptions = document.getElementById('cancelDisplayOptions');
        this.showNoteNameCheckbox = document.getElementById('showNoteName');
        this.playNoteSoundCheckbox = document.getElementById('playNoteSound');
        this.showTabCheckbox = document.getElementById('showTab');

        this.closeDisplayOptionsModal?.addEventListener('click', () => this.closeDisplayOptionsModalHandler());
        this.cancelDisplayOptions?.addEventListener('click', () => this.closeDisplayOptionsModalHandler());
        this.applyDisplayOptions?.addEventListener('click', () => this.applyDisplayOptionsHandler());
        this.displayOptionsModal?.addEventListener('click', (e) => {
            if (e.target === this.displayOptionsModal) this.closeDisplayOptionsModalHandler();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!this.displayOptionsModal?.classList.contains('hidden')) this.closeDisplayOptionsModalHandler();
            }
        });
    }

    openDisplayOptionsModal() {
        this.syncDisplayOptionsToModal();
        this.displayOptionsModal?.classList.remove('hidden');
        this.displayOptionsModal?.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    closeDisplayOptionsModalHandler() {
        this.displayOptionsModal?.classList.add('hidden');
        this.displayOptionsModal?.classList.remove('active');
        document.body.style.overflow = '';
        this.clearDisplayOptionsValidation();
    }

    syncDisplayOptionsToModal() {
        if (this.showNoteNameCheckbox) this.showNoteNameCheckbox.checked = this.displayOptions.showNoteName;
        if (this.playNoteSoundCheckbox) this.playNoteSoundCheckbox.checked = this.displayOptions.playNoteSound;
        if (this.showTabCheckbox) this.showTabCheckbox.checked = this.displayOptions.showTab;
    }

    applyDisplayOptionsHandler() {
        if (!this.validateDisplayOptions()) return;

        this.displayOptions.showNoteName = this.showNoteNameCheckbox?.checked || false;
        this.displayOptions.playNoteSound = this.playNoteSoundCheckbox?.checked || false;
        this.displayOptions.showTab = this.showTabCheckbox?.checked || false;

        localStorage.setItem('bassTrainer.displayOptions', JSON.stringify(this.displayOptions));
        this.callbacks.onDisplayOptionsChange(this.displayOptions);

        this.showDisplayOptionsValidationMessage('Display options applied successfully!', 'success');
        setTimeout(() => this.closeDisplayOptionsModalHandler(), 1000);
    }

    validateDisplayOptions() {
        const showNoteName = this.showNoteNameCheckbox?.checked || false;
        const playNoteSound = this.playNoteSoundCheckbox?.checked || false;
        const showTab = this.showTabCheckbox?.checked || false;

        if (!showNoteName && !playNoteSound && !showTab) {
            this.showDisplayOptionsValidationMessage('At least one display option must be selected', 'error');
            return false;
        }

        this.clearDisplayOptionsValidation();
        return true;
    }

    showDisplayOptionsValidationMessage(message, type = 'info') {
        const validation = document.getElementById('displayOptionsValidation');
        if (!validation) return;
        validation.textContent = message;
        validation.className = `validation-message ${type}`;
    }

    clearDisplayOptionsValidation() {
        const validation = document.getElementById('displayOptionsValidation');
        if (validation) {
            validation.textContent = '';
            validation.className = 'validation-message';
        }
    }

    loadDisplayOptions() {
        try {
            const saved = localStorage.getItem('bassTrainer.displayOptions');
            if (saved) {
                const parsed = JSON.parse(saved);
                this.displayOptions = {
                    showNoteName: parsed.showNoteName !== undefined ? parsed.showNoteName : true,
                    playNoteSound: parsed.playNoteSound !== undefined ? parsed.playNoteSound : false,
                    showTab: parsed.showTab !== undefined ? parsed.showTab : false
                };
            }
        } catch (error) {
            console.warn('Failed to load display options from localStorage:', error);
        }
    }

    // ==================== Public API ====================

    getCurrentBassConfig() {
        return this.currentBassConfig;
    }

    getCurrentExercisePreset() {
        return this.currentExercisePreset;
    }

    getDisplayOptions() {
        return { ...this.displayOptions };
    }

    setCurrentBassConfig(configId) {
        this.currentBassConfig = configId;
        this.bassConfigModal.setValue(configId);
    }

    setCurrentExercisePreset(presetId) {
        this.currentExercisePreset = presetId;
        this.exercisePresetModal.setValue(presetId);
    }
}
