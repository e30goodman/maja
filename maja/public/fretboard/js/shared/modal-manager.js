/**
 * Modal Management Utilities
 * Provides reusable modal handling functionality for fretboard modals
 */

export class ModalManager {
    constructor(config = {}) {
        this.fretboardModal = null;
        this.modalFretboardInstance = null;
        
        // Configuration
        this.config = {
            fretboardModalId: 'fretboardModal',
            modalFretboardId: 'modalFretboard',
            openFretboardBtnId: 'openFretboardBtn',
            closeFretboardModalId: 'closeFretboardModal',
            applyFretboardSelectionId: 'applyFretboardSelection',
            ...config
        };
        
        this.initializeElements();
        this.bindEvents();
    }
    
    initializeElements() {
        this.fretboardModal = document.getElementById(this.config.fretboardModalId);
        this.modalFretboard = document.getElementById(this.config.modalFretboardId);
        
        this.openFretboardBtn = document.getElementById(this.config.openFretboardBtnId);
        this.closeFretboardModal = document.getElementById(this.config.closeFretboardModalId);
        this.applyFretboardSelection = document.getElementById(this.config.applyFretboardSelectionId);
    }
    
    bindEvents() {
        // Fretboard modal controls
        if (this.openFretboardBtn) {
            this.openFretboardBtn.addEventListener('click', () => this.openFretboardModal());
        }
        if (this.closeFretboardModal) {
            this.closeFretboardModal.addEventListener('click', () => this.closeFretboardModal());
        }
        if (this.applyFretboardSelection) {
            this.applyFretboardSelection.addEventListener('click', () => this.applyModalSelection());
        }
        
        // Close modal on backdrop click
        if (this.fretboardModal) {
            this.fretboardModal.addEventListener('click', (event) => {
                if (event.target === this.fretboardModal) {
                    this.closeFretboardModalHandler();
                }
            });
        }
        
        // Close modal on escape key
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                if (this.fretboardModal?.classList.contains('active')) {
                    this.closeFretboardModalHandler();
                }
            }
        });
    }
    
    openFretboardModal() {
        if (!this.fretboardModal) return;
        
        // Create modal fretboard if it doesn't exist
        if (!this.modalFretboardInstance && this.onCreateModalFretboard) {
            this.modalFretboardInstance = this.onCreateModalFretboard();
        }
        
        // Show modal
        this.fretboardModal.classList.add('active');
        document.body.style.overflow = 'hidden';
        
        // Trigger callback if provided
        if (this.onFretboardModalOpen) {
            this.onFretboardModalOpen();
        }
    }
    
    closeFretboardModalHandler() {
        if (!this.fretboardModal) return;
        
        this.fretboardModal.classList.remove('active');
        document.body.style.overflow = '';
        
        // Trigger callback if provided
        if (this.onFretboardModalClose) {
            this.onFretboardModalClose();
        }
    }
    
    
    applyModalSelection() {
        // Trigger callback if provided
        if (this.onApplyModalSelection) {
            this.onApplyModalSelection();
        }
        
        this.closeFretboardModalHandler();
    }
    
    /**
     * Set callback for creating modal fretboard
     * @param {Function} callback - Function that creates and returns fretboard instance
     */
    setCreateModalFretboardCallback(callback) {
        this.onCreateModalFretboard = callback;
    }
    
    /**
     * Set callback for applying modal selection
     * @param {Function} callback - Function to call when applying selection
     */
    setApplySelectionCallback(callback) {
        this.onApplyModalSelection = callback;
    }
    
    /**
     * Set callbacks for modal events
     * @param {Object} callbacks - Object with callback functions
     */
    setCallbacks(callbacks) {
        if (callbacks.onCreateModalFretboard) {
            this.onCreateModalFretboard = callbacks.onCreateModalFretboard;
        }
        if (callbacks.onApplyModalSelection) {
            this.onApplyModalSelection = callbacks.onApplyModalSelection;
        }
        if (callbacks.onFretboardModalOpen) {
            this.onFretboardModalOpen = callbacks.onFretboardModalOpen;
        }
        if (callbacks.onFretboardModalClose) {
            this.onFretboardModalClose = callbacks.onFretboardModalClose;
        }
    }
    
    /**
     * Clean up modal instance
     */
    destroy() {
        this.modalFretboardInstance = null;
        document.body.style.overflow = '';
        
        // Close any open modals
        if (this.fretboardModal?.classList.contains('active')) {
            this.closeFretboardModalHandler();
        }
    }
}