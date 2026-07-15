/**
 * Selection Modal Manager
 * Generic utility for managing selection modals across the application
 * Handles modal lifecycle, selection state, and user interactions
 */

export class SelectionModalManager {
    /**
     * Create a new selection modal manager
     * @param {Object} config - Configuration object
     * @param {string} config.modalId - ID of the modal element
     * @param {string} config.listId - ID of the list container element
     * @param {string} config.triggerBtnId - ID of the button that opens the modal
     * @param {string} [config.closeBtnId] - ID of the close button
     * @param {string} [config.cancelBtnId] - ID of the cancel button
     * @param {string} [config.displayElementId] - ID of element to update with selected value
     * @param {Function} [config.onSelect] - Callback when item is selected
     * @param {Function} [config.onClose] - Callback when modal closes
     * @param {Function} [config.renderItem] - Custom item renderer function
     * @param {boolean} [config.closeOnSelect=true] - Auto-close modal after selection
     */
    constructor(config) {
        this.config = {
            closeOnSelect: true,
            ...config
        };

        // Validate required config
        if (!this.config.modalId || !this.config.listId) {
            throw new Error('SelectionModalManager requires modalId and listId');
        }

        this.currentValue = null;
        this.items = [];

        this.initializeElements();
        this.bindEvents();
    }

    initializeElements() {
        this.modal = document.getElementById(this.config.modalId);
        this.list = document.getElementById(this.config.listId);
        this.triggerBtn = this.config.triggerBtnId ? document.getElementById(this.config.triggerBtnId) : null;
        this.closeBtn = this.config.closeBtnId ? document.getElementById(this.config.closeBtnId) : null;
        this.cancelBtn = this.config.cancelBtnId ? document.getElementById(this.config.cancelBtnId) : null;
        this.displayElement = this.config.displayElementId ? document.getElementById(this.config.displayElementId) : null;

        if (!this.modal || !this.list) {
            console.warn(`SelectionModalManager: Could not find required elements for ${this.config.modalId}`);
        }
    }

    bindEvents() {
        // Open modal
        this.triggerBtn?.addEventListener('click', () => this.open());

        // Close modal
        this.closeBtn?.addEventListener('click', () => this.close());
        this.cancelBtn?.addEventListener('click', () => this.close());

        // Backdrop click
        this.modal?.addEventListener('click', (e) => {
            if (e.target === this.modal) this.close();
        });

        // ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) {
                this.close();
            }
        });
    }

    /**
     * Open the modal
     */
    open() {
        if (!this.modal) return;

        this.modal.classList.remove('hidden');
        this.modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        this.updateListSelection();
    }

    /**
     * Close the modal
     */
    close() {
        if (!this.modal) return;

        this.modal.classList.add('hidden');
        this.modal.classList.remove('active');
        document.body.style.overflow = '';

        if (this.config.onClose) {
            this.config.onClose();
        }
    }

    /**
     * Check if modal is currently open
     */
    isOpen() {
        return this.modal && !this.modal.classList.contains('hidden');
    }

    /**
     * Set the items to display in the list
     * @param {Array} items - Array of item objects
     */
    setItems(items) {
        this.items = items;
        this.renderList();
    }

    /**
     * Render the list of items
     */
    renderList() {
        if (!this.list) return;

        this.list.innerHTML = '';

        this.items.forEach(item => {
            const element = this.createItemElement(item);
            this.list.appendChild(element);
        });
    }

    /**
     * Create an item element
     * @param {Object} item - Item data
     */
    createItemElement(item) {
        const element = document.createElement('div');
        element.className = this.getItemClassName(item);
        element.dataset.value = item.value;

        // Use custom renderer if provided, otherwise use default
        if (this.config.renderItem) {
            element.innerHTML = this.config.renderItem(item);
        } else {
            element.innerHTML = this.defaultRenderItem(item);
        }

        // Click handler
        element.addEventListener('click', (e) => {
            // Allow custom click handling (e.g., for delete buttons)
            if (e.target.closest('[data-prevent-select]')) {
                return;
            }
            this.selectItem(item.value);
        });

        return element;
    }

    /**
     * Get CSS class name for item element
     * @param {Object} item - Item data
     */
    getItemClassName(item) {
        const baseClass = item.className || 'filter-option-item';
        const selectedClass = item.value === this.currentValue ? 'selected' : '';
        return `${baseClass} ${selectedClass}`.trim();
    }

    /**
     * Default item renderer
     * @param {Object} item - Item data
     */
    defaultRenderItem(item) {
        if (item.description) {
            return `
                <div class="filter-option-details">
                    <div class="filter-option-name">${item.label}</div>
                    <div class="filter-option-description">${item.description}</div>
                </div>
            `;
        }
        return item.label;
    }

    /**
     * Select an item
     * @param {*} value - Value of the item to select
     */
    selectItem(value) {
        const oldValue = this.currentValue;
        this.currentValue = value;

        // Update selection visually
        this.updateListSelection();

        // Update display element
        this.updateDisplay();

        // Trigger callback
        if (this.config.onSelect && oldValue !== value) {
            this.config.onSelect(value, this.getItemByValue(value));
        }

        // Auto-close if configured
        if (this.config.closeOnSelect) {
            this.close();
        }
    }

    /**
     * Update list selection state
     */
    updateListSelection() {
        if (!this.list) return;

        const items = this.list.querySelectorAll('[data-value]');
        items.forEach(item => {
            if (item.dataset.value === String(this.currentValue)) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    /**
     * Update the display element with current selection
     */
    updateDisplay() {
        if (!this.displayElement) return;

        const item = this.getItemByValue(this.currentValue);
        if (item && item.displayLabel) {
            this.displayElement.textContent = item.displayLabel;
        } else if (item) {
            this.displayElement.textContent = item.label;
        }
    }

    /**
     * Get item by value
     * @param {*} value - Value to search for
     */
    getItemByValue(value) {
        return this.items.find(item => item.value === value);
    }

    /**
     * Get current selected value
     */
    getValue() {
        return this.currentValue;
    }

    /**
     * Set current value without triggering callback
     * @param {*} value - Value to set
     */
    setValue(value) {
        this.currentValue = value;
        this.updateListSelection();
        this.updateDisplay();
    }

    /**
     * Refresh the list (re-render with current items)
     */
    refresh() {
        this.renderList();
    }

    /**
     * Clean up
     */
    destroy() {
        this.close();
        this.items = [];
        this.currentValue = null;
    }
}
