import { ELEMENT_IDS, CSS_CLASSES, PRACTICE_CONFIG } from './constants.js';
import { BassTabRenderer } from './bass-tablature-renderer.js';

/**
 * UI helper functions for DOM manipulation and state management
 * Consolidates common UI patterns used across the application
 */

/**
 * Safely get element by ID with error handling
 * @param {string} elementId - Element ID to find
 * @returns {HTMLElement|null} - Element or null if not found
 */
export function getElement(elementId) {
    const element = document.getElementById(elementId);
    if (!element) {
        console.warn(`Element with ID '${elementId}' not found`);
    }
    return element;
}

/**
 * Get multiple elements by IDs
 * @param {Array<string>} elementIds - Array of element IDs
 * @returns {Object} - Object with elementId as key, element as value
 */
export function getElements(elementIds) {
    const elements = {};
    elementIds.forEach(id => {
        elements[id] = getElement(id);
    });
    return elements;
}

/**
 * Update practice statistics display
 * @param {number} correct - Number of correct answers
 * @param {number} incorrect - Number of incorrect answers
 */
export function updateStatsDisplay(correct, incorrect) {
    const correctEl = getElement(ELEMENT_IDS.CORRECT_COUNT);
    const incorrectEl = getElement(ELEMENT_IDS.INCORRECT_COUNT);
    const accuracyEl = getElement(ELEMENT_IDS.ACCURACY);
    
    if (correctEl) correctEl.textContent = correct.toString();
    if (incorrectEl) incorrectEl.textContent = incorrect.toString();
    
    if (accuracyEl) {
        const total = correct + incorrect;
        const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
        accuracyEl.textContent = accuracy + '%';
        
        // Update accuracy class based on performance
        accuracyEl.className = accuracy >= PRACTICE_CONFIG.EXCELLENT_ACCURACY ? 
            `value ${CSS_CLASSES.CLARITY_EXCELLENT}` : 
            accuracy >= PRACTICE_CONFIG.GOOD_ACCURACY ? 
            `value ${CSS_CLASSES.CLARITY_GOOD}` : 
            'value';
    }
}


/**
 * Update practice button state
 * @param {boolean} hasNotes - Whether notes are selected
 * @param {boolean} practiceMode - Whether practice is active
 */
export function updatePracticeButton(hasNotes, practiceMode = false) {
    const btnEl = getElement(ELEMENT_IDS.START_PRACTICE_BTN);
    if (!btnEl) return;
    
    if (hasNotes) {
        btnEl.disabled = false;
        if (practiceMode) {
            btnEl.classList.add(CSS_CLASSES.PRACTICE_BTN_ACTIVE);
            btnEl.title = 'Stop Practice';
        } else {
            btnEl.classList.remove(CSS_CLASSES.PRACTICE_BTN_ACTIVE);
            btnEl.title = 'Start Practice & Listen';
        }
    } else {
        btnEl.disabled = true;
        btnEl.classList.remove(CSS_CLASSES.PRACTICE_BTN_ACTIVE);
        btnEl.title = 'Select notes to start practice';
    }
}

/**
 * Update note queue display with 7-note carousel effect
 * @param {Array<Object>} noteQueue - Array of note objects with {note, result}
 * @param {number} currentIndex - Index of current note (default 3)
 * @param {Object} displayOptions - Display options for notes (showNoteName, playNoteSound, showTab)
 * @param {Object} bassConfig - Bass configuration for tab rendering
 */
export function updateNoteQueue(noteQueue, currentIndex = PRACTICE_CONFIG.CURRENT_NOTE_INDEX, displayOptions = null, bassConfig = null) {
    const queueEl = getElement(ELEMENT_IDS.NOTE_QUEUE);
    if (!queueEl || !noteQueue || noteQueue.length === 0) {
        if (queueEl) {
            queueEl.innerHTML = `
                <div class="queue-placeholder text-center m-auto">
                    <button id="startPracticeBtn" class="btn-base btn-primary btn-md practice-btn hover-shadow-medium px-4 py-3 inline-flex items-center gap-2" disabled title="Start/Stop Practice">
                        <i class="fas fa-play"></i>
                        <span>Start Practice</span>
                    </button>
                </div>
            `;
        }
        return;
    }
    
    // Set default display options if not provided
    const defaultDisplayOptions = {
        showNoteName: true,
        playNoteSound: false,
        showTab: false
    };
    const options = displayOptions || defaultDisplayOptions;

    queueEl.innerHTML = '';

    noteQueue.forEach((noteObj, index) => {
        const noteElement = document.createElement('div');
        noteElement.className = CSS_CLASSES.NOTE_ITEM;

        // Past notes ALWAYS show note name only, regardless of display options
        const isPast = index < currentIndex;
        const displayOptionsForNote = isPast ? { showNoteName: true, playNoteSound: false, showTab: false } : options;

        // Create content based on display options
        createNoteContent(noteElement, noteObj.note, displayOptionsForNote, bassConfig);

        // Calculate distance from center for carousel effect
        const distance = Math.abs(index - currentIndex);
        noteElement.classList.add(`${CSS_CLASSES.DISTANCE_0.replace('0', Math.min(distance, 3))}`);

        // Add data attribute for center note pseudo-element ONLY when using default display
        // (When using custom display options, our content handles the display)
        const isUsingCustomDisplay = options && (options.showTab || !options.showNoteName ||
            (options.playNoteSound && !options.showNoteName && !options.showTab));

        if (distance === 0 && !isUsingCustomDisplay) {
            noteElement.setAttribute('data-note', noteObj.note);
        } else if (distance === 0 && isUsingCustomDisplay) {
            // Add a class to indicate custom display is being used
            noteElement.classList.add('custom-display-mode');
        }

        // Add state classes
        if (isPast) {
            noteElement.classList.add(CSS_CLASSES.NOTE_PAST);
            // Add result styling
            if (noteObj.result === 'correct') {
                noteElement.classList.add(CSS_CLASSES.NOTE_CORRECT);
            } else if (noteObj.result === 'incorrect') {
                noteElement.classList.add(CSS_CLASSES.NOTE_INCORRECT);
            }
        } else if (index === currentIndex) {
            noteElement.classList.add(CSS_CLASSES.NOTE_CURRENT);
        } else {
            noteElement.classList.add(CSS_CLASSES.NOTE_UPCOMING);
        }

        queueEl.appendChild(noteElement);
    });
}

/**
 * Create note content based on display options
 * @param {HTMLElement} noteElement - The note element to populate
 * @param {string} note - The note string (e.g., "E1", "A#2")
 * @param {Object} displayOptions - Display options (showNoteName, playNoteSound, showTab)
 * @param {Object} bassConfig - Bass configuration for tab rendering
 * @private
 */
function createNoteContent(noteElement, note, displayOptions, bassConfig) {
    const { showNoteName, playNoteSound, showTab } = displayOptions;

    // Ear training mode: only sound, no visual indicators
    if (playNoteSound && !showNoteName && !showTab) {
        noteElement.classList.add('ear-training-mode');
        noteElement.innerHTML = '<span class="ear-training-placeholder">♪</span>';
        return;
    }

    // Create container for content
    const contentContainer = document.createElement('div');
    contentContainer.className = 'note-content';

    // Add note name if enabled
    if (showNoteName) {
        const nameElement = document.createElement('span');
        nameElement.className = 'note-name';
        nameElement.textContent = note;
        contentContainer.appendChild(nameElement);
    }

    // Add tab notation if enabled
    if (showTab && bassConfig) {
        const tabElement = createCompactTab(note, bassConfig);
        if (tabElement) {
            tabElement.className = 'note-tab';
            contentContainer.appendChild(tabElement);
        }
    }

    // Handle case where both are enabled - add appropriate layout class
    if (showNoteName && showTab) {
        contentContainer.classList.add('note-content-combined');
        // Use horizontal layout for combined mode to prevent overlap
        contentContainer.style.flexDirection = 'row';
        contentContainer.style.gap = '4px';
    }

    noteElement.appendChild(contentContainer);
}

/**
 * Create a compact tablature representation for a single note
 * @param {string} note - The note string (e.g., "E1", "A#2")
 * @param {Object} bassConfig - Bass configuration for tab rendering
 * @returns {HTMLElement|null} - Compact tab element or null if rendering fails
 * @private
 */
function createCompactTab(note, bassConfig) {
    try {
        // Create compact tab options for queue display
        const tabOptions = {
            height: 45,           // Smaller height for queue
            lineSpacing: 8,       // Tighter line spacing
            fretCharWidth: 10,    // Narrower character width
            leftMargin: 8,        // Smaller margins
            rightMargin: 8,
            topMargin: 3,
            bottomMargin: 3,
            fontSize: '9px',      // Smaller font
            showStringNames: false,  // Don't show string labels in compact mode
            bassConfig: bassConfig?.id || 'bass-4-standard-20'
        };

        const svg = BassTabRenderer.renderNote(note, tabOptions);
        const wrapper = document.createElement('div');
        wrapper.className = 'compact-tab-wrapper';
        wrapper.appendChild(svg);
        return wrapper;
    } catch (error) {
        console.warn(`Failed to render tab for note ${note}:`, error);
        // Let it fail - no fallback
        return null;
    }
}

/**
 * Update detection display (for test interface)
 * @param {Object} detectionResult - Detection result from AudioEngine
 */
export function updateDetectionDisplay(detectionResult) {
    const frequencyEl = getElement(ELEMENT_IDS.FREQUENCY);
    const noteEl = getElement(ELEMENT_IDS.NOTE);
    const clarityEl = getElement(ELEMENT_IDS.CLARITY);
    const clarityFillEl = getElement(ELEMENT_IDS.CLARITY_FILL);
    
    switch (detectionResult.type) {
        case 'clear':
            if (frequencyEl) frequencyEl.textContent = detectionResult.frequency.toFixed(1) + ' Hz';
            if (noteEl) {
                noteEl.textContent = detectionResult.note.fullName;
                // Add bass range class
                const rangeClass = detectionResult.note.octave <= 1 ? 
                    CSS_CLASSES.BASS_RANGE : 
                    detectionResult.note.octave <= 2 ? 
                    CSS_CLASSES.UPPER_BASS : '';
                noteEl.className = `value ${rangeClass}`;
            }
            updateClarityDisplay(detectionResult.clarity);
            break;
            
        case 'uncertain':
            if (frequencyEl) frequencyEl.textContent = detectionResult.frequency.toFixed(1) + ' Hz';
            if (noteEl) {
                noteEl.textContent = '?';
                noteEl.className = 'value';
            }
            updateClarityDisplay(detectionResult.clarity);
            break;
            
        case 'noise':
            if (frequencyEl) frequencyEl.textContent = '-- Hz';
            if (noteEl) {
                noteEl.textContent = '--';
                noteEl.className = 'value';
            }
            updateClarityDisplay(detectionResult.clarity);
            break;
            
        case 'silence':
        default:
            if (frequencyEl) frequencyEl.textContent = '-- Hz';
            if (noteEl) {
                noteEl.textContent = '--';
                noteEl.className = 'value';
            }
            if (clarityEl) clarityEl.textContent = '--%';
            if (clarityFillEl) {
                clarityFillEl.style.width = '0%';
                clarityFillEl.className = 'clarity-fill';
            }
            break;
    }
}

/**
 * Update clarity display with appropriate styling
 * @param {number} clarity - Clarity value (0-1)
 */
function updateClarityDisplay(clarity) {
    const clarityEl = getElement(ELEMENT_IDS.CLARITY);
    const clarityFillEl = getElement(ELEMENT_IDS.CLARITY_FILL);
    
    const clarityPercent = Math.round(clarity * 100);
    
    if (clarityEl) clarityEl.textContent = clarityPercent + '%';
    if (clarityFillEl) {
        clarityFillEl.style.width = clarityPercent + '%';
        
        // Set clarity class based on level
        if (clarity > 0.9) {
            clarityFillEl.className = `clarity-fill ${CSS_CLASSES.CLARITY_EXCELLENT}`;
        } else if (clarity > 0.8) {
            clarityFillEl.className = `clarity-fill ${CSS_CLASSES.CLARITY_GOOD}`;
        } else {
            clarityFillEl.className = `clarity-fill ${CSS_CLASSES.CLARITY_FAIR}`;
        }
    }
}

/**
 * Toggle button states (disabled/enabled)
 * @param {Array<string>} buttonIds - Array of button element IDs
 * @param {boolean} enabled - Whether buttons should be enabled
 */
export function toggleButtons(buttonIds, enabled) {
    buttonIds.forEach(id => {
        const btn = getElement(id);
        if (btn) {
            btn.disabled = !enabled;
        }
    });
}

/**
 * Set status message
 * @param {string} message - Status message to display
 * @param {string} type - Type of status: 'info', 'success', 'error'
 */
export function setStatusMessage(message, type = 'info') {
    const statusEl = getElement(ELEMENT_IDS.STATUS);
    if (!statusEl) return;
    
    statusEl.textContent = message;
    statusEl.className = `${CSS_CLASSES.DETECTION_STATUS} ${type === 'error' ? CSS_CLASSES.STATUS_ERROR : type === 'success' ? CSS_CLASSES.STATUS_ACTIVE : ''}`;
}

/**
 * Create and dispatch custom event
 * @param {HTMLElement} element - Element to dispatch from
 * @param {string} eventName - Name of the event
 * @param {Object} detail - Event detail object
 */
export function dispatchCustomEvent(element, eventName, detail = {}) {
    if (!element) return;
    
    const event = new CustomEvent(eventName, { detail });
    element.dispatchEvent(event);
}

/**
 * Smooth scroll to element
 * @param {HTMLElement|string} target - Element or selector to scroll to
 * @param {Object} options - Scroll options
 */
export function smoothScrollTo(target, options = {}) {
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element) return;
    
    element.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
        ...options
    });
}

/**
 * Add loading state to button
 * @param {HTMLElement} button - Button element
 * @param {string} loadingText - Text to show while loading
 */
export function setButtonLoading(button, loadingText = 'Loading...') {
    if (!button) return;
    
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
    button.disabled = true;
    button.classList.add('loading');
}

/**
 * Remove loading state from button
 * @param {HTMLElement} button - Button element
 */
export function removeButtonLoading(button) {
    if (!button) return;
    
    if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
    }
    button.disabled = false;
    button.classList.remove('loading');
}

/**
 * Show/hide element with optional animation
 * @param {HTMLElement} element - Element to show/hide
 * @param {boolean} show - Whether to show (true) or hide (false)
 * @param {string} animationClass - CSS class for animation
 */
export function toggleElementVisibility(element, show, animationClass = 'fade') {
    if (!element) return;
    
    if (show) {
        element.style.display = 'block';
        element.classList.add(animationClass);
    } else {
        element.classList.remove(animationClass);
        // Hide after animation completes
        setTimeout(() => {
            if (!element.classList.contains(animationClass)) {
                element.style.display = 'none';
            }
        }, 300);
    }
}

/**
 * Format time duration in MM:SS format
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} - Formatted time string
 */
export function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

/**
 * Debounce function to limit function calls
 * @param {Function} func - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} - Debounced function
 */
export function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}
