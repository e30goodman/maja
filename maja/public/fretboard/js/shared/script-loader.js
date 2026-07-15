/**
 * Script Loading Utilities
 * Provides reusable functions for dynamically loading external JavaScript files
 */

/**
 * Load a script dynamically and return a promise
 * @param {string} src - The source URL or path of the script
 * @param {Object} options - Optional configuration
 * @param {boolean} options.checkGlobal - If provided, check if this global variable exists before loading
 * @returns {Promise} - Resolves when script loads, rejects on error
 */
export function loadScript(src, options = {}) {
    return new Promise((resolve, reject) => {
        // Check if global variable already exists
        if (options.checkGlobal && typeof window[options.checkGlobal] !== 'undefined') {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.onload = () => {
            console.log(`Script loaded successfully: ${src}`);
            resolve();
        };
        script.onerror = () => {
            console.error(`Failed to load script: ${src}`);
            reject(new Error(`Failed to load script: ${src}`));
        };
        document.head.appendChild(script);
    });
}

/**
 * Load the fretboard script specifically
 * @returns {Promise} - Resolves when fretboard script loads
 */
export function loadFretboardScript() {
    const url = new URL('../bass-fretboard.js', import.meta.url);
    url.searchParams.set('v', '20260715f');
    return loadScript(url.href, { checkGlobal: 'BassFretboard' });
}

/**
 * Load Tonal.js library from local file
 * @returns {Promise} - Resolves when Tonal.js loads
 */
export function loadTonalJs() {
    return loadScript(new URL('../lib/tonal.min.js', import.meta.url).href, { checkGlobal: 'Tonal' });
}

/**
 * Load multiple scripts in sequence
 * @param {string[]} scripts - Array of script URLs to load
 * @returns {Promise} - Resolves when all scripts load
 */
export async function loadScriptsSequential(scripts) {
    for (const script of scripts) {
        await loadScript(script);
    }
}

/**
 * Load multiple scripts in parallel
 * @param {string[]} scripts - Array of script URLs to load
 * @returns {Promise} - Resolves when all scripts load
 */
export function loadScriptsParallel(scripts) {
    return Promise.all(scripts.map(script => loadScript(script)));
}
