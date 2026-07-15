/**
 * Bass Tablature SVG Renderer
 * A lightweight library for rendering bass guitar tablature notation using SVG
 * Renders proper bass tabs with horizontal string lines and fret numbers
 * Integrates with existing bass configurations and music theory utilities
 */

import { getBassConfiguration } from './bass-configurations.js';
import { parseNote, getNoteAtPosition } from './note-utils.js';
import { NOTE_NAMES } from './constants.js';

/**
 * Bass Tablature Renderer Class
 * Provides methods to render proper bass tablature notation in SVG format
 * Tablature format: horizontal lines with fret numbers placed on the lines
 */
export class BassTabRenderer {
    /**
     * Default rendering options for bass tablature
     */
    static defaultOptions = {
        height: 140,
        lineSpacing: 20,        // Vertical spacing between string lines
        fretCharWidth: 16,      // Width allocated per fret character (2 chars max)
        minNoteSpacing: 8,      // Minimum spacing between fret numbers
        leftMargin: 50,         // Space for string labels
        rightMargin: 20,
        topMargin: 20,
        bottomMargin: 20,
        lineColor: '#333',      // Color of tab lines
        lineWidth: 1,           // Width of tab lines
        textColor: '#333',      // Color of fret numbers
        fontSize: '14px',       // Size of fret numbers
        fontFamily: 'Courier New, monospace',  // Monospace for proper alignment
        showStringNames: true,  // Show G, D, A, E labels
        bassConfig: 'bass-4-standard-20'
    };

    /**
     * Render a single note on bass tablature
     * @param {string} noteString - Note to render (e.g., "E1", "A1")
     * @param {Object} options - Rendering options
     * @returns {SVGElement} - SVG element containing the tablature
     */
    static renderNote(noteString, options = {}) {
        return this.renderNotes([noteString], options);
    }

    /**
     * Render multiple notes on bass tablature
     * @param {Array<string>} noteArray - Array of notes to render
     * @param {Object} options - Rendering options
     * @returns {SVGElement} - SVG element containing the tablature
     */
    static renderNotes(noteArray, options = {}) {
        const opts = { ...this.defaultOptions, ...options };
        const bassConfig = getBassConfiguration(opts.bassConfig);

        if (!bassConfig) {
            throw new Error(`Unknown bass configuration: ${opts.bassConfig}`);
        }

        // Find tab positions for all notes
        const tabPositions = this._findTabPositions(noteArray, bassConfig, opts);

        // Calculate optimal width based on fret number content
        const calculatedWidth = this._calculateOptimalWidth(tabPositions, opts);
        const finalWidth = calculatedWidth;

        // Create SVG container
        const svg = this._createSVGElement(finalWidth, opts.height, opts);

        // Draw tablature lines
        this._drawTabLines(svg, bassConfig, opts);

        // Calculate note positions for even distribution
        const contentWidth = finalWidth - opts.leftMargin - opts.rightMargin;
        const notePositions = this._calculateNotePositions(tabPositions.length, contentWidth, opts);

        // Draw fret numbers on the lines
        tabPositions.forEach((pos, index) => {
            this._drawFretNumber(svg, pos, index, opts, notePositions);
        });

        return svg;
    }

    /**
     * Find tablature positions for given notes
     * @private
     */
    static _findTabPositions(noteArray, bassConfig, opts) {
        const positions = [];

        noteArray.forEach((noteString, noteIndex) => {
            const parsed = parseNote(noteString);
            if (!parsed) {
                console.warn(`Invalid note format: ${noteString}`);
                return;
            }

            // Find the position in tablature format
            let foundPosition = null;

            // Check each string for the note (prefer lower frets)
            bassConfig.strings.forEach((string, stringIndex) => {
                for (let fret = 0; fret <= bassConfig.frets; fret++) {
                    const noteInfo = getNoteAtPosition(stringIndex, fret);
                    if (noteInfo && noteInfo.fullName === noteString) {
                        // Prefer lower frets if multiple positions exist
                        if (!foundPosition || fret < foundPosition.fret) {
                            foundPosition = {
                                noteString,
                                stringIndex,
                                fret,
                                noteInfo,
                                noteIndex
                            };
                        }
                    }
                }
            });

            if (foundPosition) {
                positions.push(foundPosition);
            } else {
                console.warn(`Could not find position for note: ${noteString}`);
                // Add placeholder for unknown notes
                positions.push({
                    noteString,
                    stringIndex: 0, // Default to lowest string
                    fret: 'X',      // Unknown fret
                    noteIndex
                });
            }
        });

        return positions;
    }

    /**
     * Calculate optimal width based on fret number content
     * @private
     */
    static _calculateOptimalWidth(tabPositions, opts) {
        if (tabPositions.length === 0) {
            return opts.leftMargin + opts.rightMargin + (opts.fretCharWidth * 2);
        }

        // Each fret number gets space for 2 characters (handles 0-22+ frets)
        const totalFretWidth = tabPositions.length * opts.fretCharWidth;

        // Add minimum spacing between fret numbers
        const totalSpacing = Math.max(0, tabPositions.length - 1) * opts.minNoteSpacing;

        return opts.leftMargin + opts.rightMargin + totalFretWidth + totalSpacing;
    }

    /**
     * Create SVG element with proper setup
     * @private
     */
    static _createSVGElement(width, height, opts) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', width);
        svg.setAttribute('height', height);
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.style.fontFamily = opts.fontFamily;
        svg.style.fontSize = opts.fontSize;

        // Add white background rectangle to entire SVG
        const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        background.setAttribute('x', 0);
        background.setAttribute('y', 0);
        background.setAttribute('width', width);
        background.setAttribute('height', height);
        background.setAttribute('fill', 'white');
        svg.appendChild(background);

        return svg;
    }

    /**
     * Draw tablature lines (one line per string)
     * @private
     */
    static _drawTabLines(svg, bassConfig, opts) {
        const stringCount = bassConfig.strings.length;
        const totalHeight = (stringCount - 1) * opts.lineSpacing;
        const startY = (opts.height - totalHeight) / 2;

        bassConfig.strings.forEach((string, index) => {
            const y = startY + (index * opts.lineSpacing);

            // Tablature line (represents one string)
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', opts.leftMargin);
            line.setAttribute('y1', y);
            line.setAttribute('x2', svg.getAttribute('width') - opts.rightMargin);
            line.setAttribute('y2', y);
            line.setAttribute('stroke', opts.lineColor);
            line.setAttribute('stroke-width', opts.lineWidth);
            svg.appendChild(line);

            // String name label (G, D, A, E)
            if (opts.showStringNames) {
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', opts.leftMargin - 15);
                text.setAttribute('y', y + 5); // Slightly below the line
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('fill', opts.textColor);
                text.setAttribute('font-family', opts.fontFamily);
                text.setAttribute('font-size', '12px');
                text.textContent = string.note; // Just the note name (G, D, A, E)
                svg.appendChild(text);
            }
        });
    }


    /**
     * Draw fret number on the appropriate tablature line
     * @private
     */
    static _drawFretNumber(svg, position, noteIndex, opts, notePositions) {
        // Get the bass configuration to know string count
        const stringLines = svg.querySelectorAll('line');
        const stringCount = stringLines.length;
        const totalHeight = (stringCount - 1) * opts.lineSpacing;
        const startY = (opts.height - totalHeight) / 2;

        // Use pre-calculated position for even distribution
        const x = opts.leftMargin + notePositions[noteIndex];
        const y = startY + (position.stringIndex * opts.lineSpacing);

        // Calculate background rectangle dimensions based on font size
        const fretText = position.fret.toString();
        const baseFontSize = parseInt(opts.fontSize);
        const charWidth = baseFontSize * 0.6; // More accurate character width estimate
        const textWidth = fretText.length * charWidth + (baseFontSize * 0.3);
        const textHeight = baseFontSize * 0.8; // Height relative to font size
        const padding = baseFontSize * 0.15; // Padding relative to font size

        // Draw white background rectangle behind the fret number (centered on string line)
        const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        background.setAttribute('x', x - (textWidth / 2) - padding);
        background.setAttribute('y', y - (textHeight / 2) + 1); // Center on the string line
        background.setAttribute('width', textWidth + (padding * 2));
        background.setAttribute('height', textHeight/2);
        background.setAttribute('fill', 'red');
        background.setAttribute('stroke', 'none');
        //svg.appendChild(background);

        // Draw the fret number on top of the white background
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y+(textHeight/2)); // Slightly below the line for readability
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', opts.textColor);
        text.setAttribute('font-family', opts.fontFamily);
        text.setAttribute('font-size', opts.fontSize);
        text.setAttribute('font-weight', 'bold');

        // Display the fret number (or X for unknown) - auto-centers in allocated space
        text.textContent = fretText;
        svg.appendChild(text);
    }

    /**
     * Calculate note positions for even distribution
     * @private
     */
    static _calculateNotePositions(noteCount, contentWidth, opts) {
        const positions = [];

        if (noteCount === 0) {
            return positions;
        }

        if (noteCount === 1) {
            positions.push(contentWidth / 2);
            return positions;
        }

        // Calculate positions for even distribution across content width
        const spacing = contentWidth / noteCount;
        for (let i = 0; i < noteCount; i++) {
            positions.push((spacing * i) + (spacing / 2));
        }

        return positions;
    }

    /**
     * Create a simple HTML container with the SVG for easy embedding
     * @param {SVGElement} svg - The SVG element to wrap
     * @param {Object} containerOptions - Container styling options
     * @returns {HTMLDivElement} - Div container with the SVG
     */
    static createContainer(svg, containerOptions = {}) {
        const container = document.createElement('div');
        container.style.display = 'inline-block';
        container.style.margin = containerOptions.margin || '10px';
        container.style.padding = containerOptions.padding || '10px';
        container.style.border = containerOptions.border || '1px solid #ccc';
        container.style.borderRadius = containerOptions.borderRadius || '4px';
        container.style.backgroundColor = containerOptions.backgroundColor || '#f9f9f9';

        container.appendChild(svg);
        return container;
    }
}

// Export default for convenient usage
export default BassTabRenderer;