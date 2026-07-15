class BassFretboard {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);
        this.selectedNotes = new Set();

        // Bass guitar configuration - use provided config or default to 4-string standard
        if (options.bassConfig && options.bassConfig.strings) {
            this.strings = options.bassConfig.strings.map(s => ({
                name: s.note,
                note: s.note,
                octave: s.octave
            }));
            this.numFrets = options.bassConfig.frets || options.numFrets || 12;
        } else {
            // Default 4-string standard bass configuration
            this.strings = [
                { name: 'G', note: 'G', octave: 2 },   // 4th string (highest)
                { name: 'D', note: 'D', octave: 2 },   // 3rd string
                { name: 'A', note: 'A', octave: 1 },   // 2nd string
                { name: 'E', note: 'E', octave: 1 }    // 1st string (lowest)
            ];
            this.numFrets = options.numFrets || 12;
        }
        
        // Mobile detection
        this.isMobile = window.innerWidth <= 768;
        this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

        // Responsive fretboard dimensions
        this.calculateDimensions();
        
        // Note names for chromatic scale
        this.noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        // Colors (kept only for any dynamic color changes if needed)
        this.colors = {}
        
        this.initializeFretboard();
        this.bindEvents();
        this.setupResponsiveListeners();
    }
    
    calculateDimensions() {
        const containerWidth = this.container.offsetWidth || window.innerWidth - 32;
        
        if (this.isMobile) {
            // Mobile dimensions - more compact
            this.fretboardWidth = Math.min(containerWidth - 16, 600);
            this.fretboardHeight = 120;
            this.dotSpaceHeight = 20;
            this.leftSpaceWidth = 40;
            this.noteCircleRadius = 12;
        } else {
            // Desktop dimensions
            this.fretboardWidth = Math.min(containerWidth - 32, 1000);
            this.fretboardHeight = 150;
            this.dotSpaceHeight = 25;
            this.leftSpaceWidth = 50;
            this.noteCircleRadius = 15;
        }
        
        this.fretboardAreaWidth = this.fretboardWidth - this.leftSpaceWidth;
        this.stringAreaHeight = this.fretboardHeight - this.dotSpaceHeight;
        this.stringSpacing = this.stringAreaHeight / (this.strings.length + 1);
    }
    
    setupResponsiveListeners() {
        // Listen for window resize
        window.addEventListener('resize', () => {
            this.handleResize();
        });
        
        // Listen for orientation change on mobile devices
        window.addEventListener('orientationchange', () => {
            setTimeout(() => {
                this.handleResize();
            }, 100);
        });
    }
    
    handleResize() {
        const wasMobile = this.isMobile;
        this.isMobile = window.innerWidth <= 768;
        
        // Only rebuild if mobile state changed
        if (wasMobile !== this.isMobile) {
            this.calculateDimensions();
            this.rebuild();
        } else {
            // Just update dimensions
            this.calculateDimensions();
            this.updateSVGDimensions();
        }
    }
    
    updateSVGDimensions() {
        if (this.svg) {
            this.svg.setAttribute('width', this.fretboardWidth);
            this.svg.setAttribute('height', this.fretboardHeight);
            this.svg.setAttribute('viewBox', `0 0 ${this.fretboardWidth} ${this.fretboardHeight}`);
        }
    }
    
    rebuild() {
        // Store current selection
        const currentSelection = new Set(this.selectedNotes);
        
        // Rebuild fretboard
        this.initializeFretboard();
        
        // Restore selection
        this.selectedNotes = currentSelection;
        this.updateSelectionDisplay();
    }
    
    initializeFretboard() {
        // Create SVG container
        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.setAttribute('width', this.fretboardWidth);
        this.svg.setAttribute('height', this.fretboardHeight);
        this.svg.setAttribute('viewBox', `0 0 ${this.fretboardWidth} ${this.fretboardHeight}`);
        this.svg.classList.add('bass-fretboard');
        
        // Clear container and add SVG
        this.container.innerHTML = '';
        this.container.appendChild(this.svg);
        
        this.drawFretboard();
        this.drawStrings();
        this.drawFrets();
        this.drawFretMarkers();
        this.drawNotePositions();
    }
    
    drawFretboard() {
        // Fretboard background
        const fretboardBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        fretboardBg.setAttribute('x', this.leftSpaceWidth);
        fretboardBg.setAttribute('y', this.dotSpaceHeight);
        fretboardBg.setAttribute('width', this.fretboardAreaWidth);
        fretboardBg.setAttribute('height', this.stringAreaHeight);
        fretboardBg.classList.add('fretboard-bg');
        this.svg.appendChild(fretboardBg);
    }
    
    drawStrings() {
        this.strings.forEach((string, index) => {
            const y = this.dotSpaceHeight + (this.stringSpacing * (index + 1));
            const stringLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            stringLine.setAttribute('x1', this.leftSpaceWidth);
            stringLine.setAttribute('y1', y);
            stringLine.setAttribute('x2', this.fretboardWidth);
            stringLine.setAttribute('y2', y);
            stringLine.classList.add('string-line');
            this.svg.appendChild(stringLine);
            
        });
    }
    
    drawFrets() {
        const fretWidth = this.fretboardAreaWidth / this.numFrets;
        
        for (let fret = 0; fret <= this.numFrets; fret++) {
            const x = this.leftSpaceWidth + (fretWidth * fret);
            const fretLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            fretLine.setAttribute('x1', x);
            fretLine.setAttribute('y1', this.dotSpaceHeight);
            fretLine.setAttribute('x2', x);
            fretLine.setAttribute('y2', this.fretboardHeight);
            fretLine.classList.add('fret-line');
            if (fret === 0) {
                fretLine.classList.add('nut');
            }
            this.svg.appendChild(fretLine);
        }
    }
    
    drawFretMarkers() {
        const fretWidth = this.fretboardAreaWidth / this.numFrets;
        const markerFrets = [3, 5, 7, 9, 12];
        const dotCenterY = this.dotSpaceHeight / 2;
        
        markerFrets.forEach(fret => {
            const x = this.leftSpaceWidth + (fretWidth * fret) - (fretWidth / 2);
            
            if (fret === 12) {
                // Double dots for 12th fret
                const dot1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                dot1.setAttribute('cx', x-6);
                dot1.setAttribute('cy', dotCenterY);
                dot1.setAttribute('r', '3');
                dot1.classList.add('fret-marker');
                this.svg.appendChild(dot1);
                
                const dot2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                dot2.setAttribute('cx', x+6);
                dot2.setAttribute('cy', dotCenterY);
                dot2.setAttribute('r', '3');
                dot2.classList.add('fret-marker');
                this.svg.appendChild(dot2);
            } else {
                // Single dot
                const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                dot.setAttribute('cx', x);
                dot.setAttribute('cy', dotCenterY);
                dot.setAttribute('r', '4');
                dot.classList.add('fret-marker');
                this.svg.appendChild(dot);
            }
        });
    }
    
    drawNotePositions() {
        const fretWidth = this.fretboardAreaWidth / this.numFrets;
        
        // Responsive touch target size
        const touchTargetSize = this.isMobile ? 32 : 24;
        const touchTargetHeight = this.isMobile ? 24 : 20;
        
        this.strings.forEach((string, stringIndex) => {
            const y = this.dotSpaceHeight + (this.stringSpacing * (stringIndex + 1));
            
            for (let fret = 0; fret <= this.numFrets; fret++) {
                const x = fret === 0 
                    ? this.leftSpaceWidth / 2 
                    : this.leftSpaceWidth + (fretWidth * fret) - (fretWidth / 2);
                const noteInfo = this.getNoteAtPosition(stringIndex, fret);
                
                // Create clickable note rectangle with responsive sizing
                const noteRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                noteRect.setAttribute('x', x - (touchTargetSize / 2));
                noteRect.setAttribute('y', y - (touchTargetHeight / 2));
                noteRect.setAttribute('width', touchTargetSize.toString());
                noteRect.setAttribute('height', touchTargetHeight.toString());
                noteRect.setAttribute('rx', this.isMobile ? '6' : '4');
                noteRect.classList.add('note-position');
                if (this.isTouch) {
                    noteRect.classList.add('touch-target');
                }
                noteRect.dataset.string = stringIndex;
                noteRect.dataset.fret = fret;
                noteRect.dataset.note = noteInfo.name;
                noteRect.dataset.octave = noteInfo.octave;
                noteRect.dataset.noteKey = noteInfo.fullName;
                this.svg.appendChild(noteRect);
                
                // Note name text with responsive sizing
                const noteText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                noteText.setAttribute('x', x);
                noteText.setAttribute('y', y + (this.isMobile ? 3 : 4));
                noteText.classList.add('note-name');
                if (this.isMobile) {
                    noteText.style.fontSize = '10px';
                } else {
                    noteText.style.fontSize = '12px';
                }
                noteText.textContent = noteInfo.fullName;
                this.svg.appendChild(noteText);
            }
        });
    }
    
    getNoteAtPosition(stringIndex, fret) {
        const string = this.strings[stringIndex];
        const baseNoteIndex = this.noteNames.indexOf(string.note);
        const noteIndex = (baseNoteIndex + fret) % 12;
        const octaveAdjustment = Math.floor((baseNoteIndex + fret) / 12);
        
        return {
            name: this.noteNames[noteIndex],
            octave: string.octave + octaveAdjustment,
            fullName: this.noteNames[noteIndex] + (string.octave + octaveAdjustment)
        };
    }
    
    bindEvents() {
        const resolveNoteEl = (target) => {
            if (!target || !target.closest) return null;
            return target.closest('.note-position');
        };

        // Primary click/touch event
        this.svg.addEventListener('click', (event) => {
            const noteEl = resolveNoteEl(event.target);
            if (noteEl) {
                this.toggleNoteSelection(noteEl);
            }
        });
        
        // Enhanced touch events for mobile
        if (this.isTouch) {
            this.svg.addEventListener('touchstart', (event) => {
                const noteEl = resolveNoteEl(event.target);
                if (noteEl) {
                    noteEl.style.transform = 'scale(0.95)';
                    // Haptic feedback if available
                    if (navigator.vibrate) {
                        navigator.vibrate(10);
                    }
                }
            });
            
            this.svg.addEventListener('touchend', (event) => {
                const noteEl = resolveNoteEl(event.target);
                if (noteEl) {
                    noteEl.style.transform = 'scale(1)';
                }
            });
            
            this.svg.addEventListener('touchcancel', (event) => {
                const noteEl = resolveNoteEl(event.target);
                if (noteEl) {
                    noteEl.style.transform = 'scale(1)';
                }
            });
        }
    }
    
    toggleNoteSelection(noteElement) {
        const posKey = this.getPositionKey(noteElement);
        if (this.selectedNotes.has(posKey)) {
            this.deselectPosition(noteElement);
        } else {
            this.selectPosition(noteElement);
        }
    }

    getPositionKey(noteElement) {
        return noteElement.dataset.string + ':' + noteElement.dataset.fret;
    }

    selectPosition(noteElement) {
        const posKey = this.getPositionKey(noteElement);
        if (this.selectedNotes.has(posKey)) return;

        this.selectedNotes.add(posKey);
        noteElement.classList.add('selected');

        this.container.dispatchEvent(new CustomEvent('noteSelectionChanged', {
            detail: {
                selectedNotes: this.getSelectedNotes(),
                selectedPositions: Array.from(this.selectedNotes),
                action: 'selected',
                note: noteElement.dataset.noteKey,
                position: posKey
            }
        }));
    }

    deselectPosition(noteElement) {
        const posKey = this.getPositionKey(noteElement);
        if (!this.selectedNotes.has(posKey)) return;

        this.selectedNotes.delete(posKey);
        noteElement.classList.remove('selected');

        this.container.dispatchEvent(new CustomEvent('noteSelectionChanged', {
            detail: {
                selectedNotes: this.getSelectedNotes(),
                selectedPositions: Array.from(this.selectedNotes),
                action: 'deselected',
                note: noteElement.dataset.noteKey,
                position: posKey
            }
        }));
    }

    selectPositionByKey(posKey) {
        const [stringIndex, fret] = String(posKey).split(':');
        const el = this.svg.querySelector(
            '.note-position[data-string="' + stringIndex + '"][data-fret="' + fret + '"]'
        );
        if (el) this.selectPosition(el);
    }

    getSelectedPositions() {
        return Array.from(this.selectedNotes);
    }
    
    // Public methods for preset selections
    selectOpenStrings() {
        const openStringNotes = ['E1','A1','D2','G2'] ;
        this.setNotes(openStringNotes);
    }
    
    selectNaturalNotes() {
        const naturalNotes = ['E1', 'F1', 'G1', 'A1', 'B1', 'C2', 'D2', 'E2', 'F2', 'G2', 'A2','B2','C3'];
        this.setNotes(naturalNotes);
    }
    
    selectAllNotes() {
        let allNotes = [];
        this.noteNames.forEach(note => allNotes.push(note+"1"));
        this.noteNames.forEach(note => allNotes.push(note+"2"));
        this.noteNames.forEach(note => allNotes.push(note+"3"));
        this.setNotes(allNotes);
    }
    
    clearSelection() {
        this.selectedNotes.clear();
        const notePositions = this.svg.querySelectorAll('.note-position');
        notePositions.forEach(pos => {
            pos.classList.remove('selected');
        });
        
        this.container.dispatchEvent(new CustomEvent('noteSelectionChanged', {
            detail: {
                selectedNotes: [],
                selectedPositions: [],
                action: 'cleared'
            }
        }));
    }
    setNotes(notes) {
        this.clearSelection();
        notes.forEach(note => this.selectNote(note));
    }
    selectNote(noteKey) {
        // Preset / bulk API: select every fretboard position of this pitch
        let added = false;
        const notePositions = this.svg.querySelectorAll('.note-position');
        notePositions.forEach(pos => {
            if (pos.dataset.noteKey == noteKey) {
                const posKey = this.getPositionKey(pos);
                if (!this.selectedNotes.has(posKey)) {
                    this.selectedNotes.add(posKey);
                    pos.classList.add('selected');
                    added = true;
                }
            }
        });
        if (!added) return;

        this.container.dispatchEvent(new CustomEvent('noteSelectionChanged', {
            detail: {
                selectedNotes: this.getSelectedNotes(),
                selectedPositions: Array.from(this.selectedNotes),
                action: 'selected',
                note: noteKey
            }
        }));
    }

    selectNoteInRange(noteKey, fretMin, fretMax) {
        // Preset API: select matching pitch positions within a fret window
        let added = false;
        const notePositions = this.svg.querySelectorAll('.note-position');
        notePositions.forEach(pos => {
            const fretNumber = parseInt(pos.dataset.fret, 10);
            if (pos.dataset.noteKey == noteKey && fretNumber >= fretMin && fretNumber <= fretMax) {
                const posKey = this.getPositionKey(pos);
                if (!this.selectedNotes.has(posKey)) {
                    this.selectedNotes.add(posKey);
                    pos.classList.add('selected');
                    added = true;
                }
            }
        });
        if (!added) return;

        this.container.dispatchEvent(new CustomEvent('noteSelectionChanged', {
            detail: {
                selectedNotes: this.getSelectedNotes(),
                selectedPositions: Array.from(this.selectedNotes),
                action: 'selected',
                note: noteKey
            }
        }));
    }

    deselectNote(noteKey) {
        // Bulk deselect: remove every position of this pitch
        let removed = false;
        const notePositions = this.svg.querySelectorAll('.note-position');
        notePositions.forEach(pos => {
            if (pos.dataset.noteKey == noteKey) {
                const posKey = this.getPositionKey(pos);
                if (this.selectedNotes.has(posKey)) {
                    this.selectedNotes.delete(posKey);
                    pos.classList.remove('selected');
                    removed = true;
                }
            }
        });
        if (!removed) return;

        this.container.dispatchEvent(new CustomEvent('noteSelectionChanged', {
            detail: {
                selectedNotes: this.getSelectedNotes(),
                selectedPositions: Array.from(this.selectedNotes),
                action: 'deselected',
                note: noteKey
            }
        }));
    }
    
    getSelectedNotes() {
        // Unique sounding pitches from selected positions (for practice pool)
        const pitches = new Set();
        for (const posKey of this.selectedNotes) {
            const [stringIndex, fret] = String(posKey).split(':');
            const el = this.svg.querySelector(
                '.note-position[data-string="' + stringIndex + '"][data-fret="' + fret + '"]'
            );
            if (el && el.dataset.noteKey) {
                pitches.add(el.dataset.noteKey);
            }
        }
        return Array.from(pitches);
    }
    
    // Display notes with custom labels (preserves original flat/sharp notation)
    displayNotesWithLabels(notesWithLabels) {
        // Clear previous selections
        this.clearSelection();
        
        // STEP 1: Reset ALL labels to original sharp notation
        this.resetAllLabelsToOriginal();
        
        // STEP 2: Apply new custom labels
        this.customLabels = new Map();
        
        notesWithLabels.forEach(({note, displayLabel}) => {
            // Use normalized note for selection
            this.selectNote(note);
            
            // Store custom label for this note
            this.customLabels.set(note, displayLabel);
            
            // Update displayed label to show original notation
            this.updateNoteLabel(note, displayLabel);
        });
    }
    
    // Helper method to find note text element for a given note
    findNoteTextElement(noteKey) {
        const noteTexts = this.svg.querySelectorAll('.note-name');
        for (let textElement of noteTexts) {
            const rect = textElement.previousElementSibling;
            if (rect && rect.dataset.noteKey === noteKey) {
                return textElement;
            }
        }
        return null;
    }
    
    // Reset all note labels to their original sharp notation
    resetAllLabelsToOriginal() {
        const noteTexts = this.svg.querySelectorAll('.note-name');
        noteTexts.forEach(textElement => {
            const rect = textElement.previousElementSibling;
            if (rect && rect.dataset.noteKey) {
                // Reset to original sharp notation from dataset
                textElement.textContent = rect.dataset.noteKey;
            }
        });
        
        // Clear custom labels map
        if (this.customLabels) {
            this.customLabels.clear();
        }
    }
    
    // Update a specific note's label
    updateNoteLabel(noteKey, displayLabel) {
        const noteTexts = this.svg.querySelectorAll('.note-name');
        noteTexts.forEach(textElement => {
            const rect = textElement.previousElementSibling;
            if (rect && rect.dataset.noteKey === noteKey) {
                textElement.textContent = displayLabel;
            }
        });
        
    }
    
    highlightTargetNote(noteKey, fretMin = 0, fretMax = 24) {
        // Remove previous highlights
        this.svg.querySelectorAll('.target-highlight').forEach(el => el.remove());

        // Add highlights for target note positions within the fret range
        const notePositions = this.svg.querySelectorAll('.note-position');

        notePositions.forEach(pos => {
            const posNoteKey = pos.dataset.note + pos.dataset.octave;
            const fretNumber = parseInt(pos.dataset.fret, 10);

            // Only highlight if note matches AND fret is within range
            if (posNoteKey === noteKey && fretNumber >= fretMin && fretNumber <= fretMax) {
                const highlight = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                const padding = this.isMobile ? 6 : 4;
                const width = this.isMobile ? 44 : 32;
                const height = this.isMobile ? 36 : 28;

                highlight.setAttribute('x', pos.getAttribute('x') - padding);
                highlight.setAttribute('y', pos.getAttribute('y') - padding);
                highlight.setAttribute('width', width.toString());
                highlight.setAttribute('height', height.toString());
                highlight.setAttribute('rx', this.isMobile ? '8' : '6');
                highlight.classList.add('target-highlight');
                this.svg.insertBefore(highlight, pos);
            }
        });
    }
    
    updateSelectionDisplay() {
        // Update visual selection state for all notes (per position)
        const notePositions = this.svg.querySelectorAll('.note-position');
        notePositions.forEach(pos => {
            const posKey = this.getPositionKey(pos);
            if (this.selectedNotes.has(posKey)) {
                pos.classList.add('selected');
            } else {
                pos.classList.remove('selected');
            }
        });
    }
}
