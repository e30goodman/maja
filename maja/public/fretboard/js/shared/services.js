/**
 * Service Locator Pattern Implementation
 *
 * Solves circular dependency issues by providing a central registry for services.
 * Modules register themselves at startup and look up dependencies through this registry.
 *
 * Benefits:
 * - Eliminates circular imports between modules
 * - Runtime service registration and discovery
 * - Easy service mocking for testing
 * - Clean separation of concerns
 *
 * Usage:
 * 1. Services register themselves: Services.register('scaleLibrary', scaleLibraryModule)
 * 2. Consumers look up services: Services.get('scaleLibrary').getScaleNotes(...)
 * 3. Registration typically happens in bass-trainer.js at startup
 */

class ServiceRegistry {
    constructor() {
        this._services = new Map();
        this._initialized = false;
    }

    /**
     * Register a service with the locator
     * @param {string} name - Service name (e.g., 'scaleLibrary', 'noteUtils')
     * @param {Object} service - Service implementation (module or class instance)
     */
    register(name, service) {
        if (this._services.has(name)) {
            console.warn(`Service '${name}' is being overridden`);
        }
        this._services.set(name, service);
        console.log(`✓ Registered service: ${name}`);
    }

    /**
     * Get a registered service
     * @param {string} name - Service name
     * @returns {Object} Service implementation
     * @throws {Error} If service is not found
     */
    get(name) {
        const service = this._services.get(name);
        if (!service) {
            const availableServices = Array.from(this._services.keys());
            throw new Error(
                `Service '${name}' not found. Available services: ${availableServices.join(', ')}`
            );
        }
        return service;
    }

    /**
     * Check if a service is registered
     * @param {string} name - Service name
     * @returns {boolean}
     */
    has(name) {
        return this._services.has(name);
    }

    /**
     * Get all registered service names
     * @returns {string[]} Array of service names
     */
    getServiceNames() {
        return Array.from(this._services.keys());
    }

    /**
     * Clear all services (useful for testing)
     */
    clear() {
        this._services.clear();
        this._initialized = false;
        console.log('Services cleared');
    }

    /**
     * Mark services as initialized (prevents late registration in production)
     */
    markInitialized() {
        this._initialized = true;
        console.log(`Services initialized with: ${this.getServiceNames().join(', ')}`);
    }

    /**
     * Check if services are initialized
     * @returns {boolean}
     */
    isInitialized() {
        return this._initialized;
    }
}

/**
 * Global service locator instance
 * This is the main interface that modules will use
 */
export const Services = new ServiceRegistry();

/**
 * Service names constants to avoid typos
 * These should be used when registering/accessing services
 */
export const SERVICE_NAMES = {
    SCALE_LIBRARY: 'scaleLibrary',
    NOTE_UTILS: 'noteUtils',
    CUSTOM_EXERCISES: 'customExercises',
    MUSIC_THEORY: 'musicTheory',
    BASS_CONFIGURATIONS: 'bassConfigurations'
};

/**
 * Helper function to safely get a service with error handling
 * @param {string} serviceName - Name of the service
 * @param {string} methodName - Name of the method being called (for better error messages)
 * @returns {Object} Service implementation
 */
export function getService(serviceName, methodName = 'unknown') {
    try {
        return Services.get(serviceName);
    } catch (error) {
        console.error(`Failed to get service '${serviceName}' for method '${methodName}':`, error.message);
        throw error;
    }
}