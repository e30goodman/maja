import { pocketBaseClient } from './pocketbase-client.js';
import { StatisticsStorage } from './statistics-storage.js';
import { StatisticsCalculator } from './statistics-calculator.js';
import { StatisticsSyncService } from './statistics-sync-service.js';
import { StatisticsSessionManager } from './statistics-session-manager.js';
import { StatisticsValidator } from './statistics-validator.js';

/**
 * Statistics Manager - Orchestrates statistics operations using modular services
 * Provides a unified interface for practice session data management
 */
export class StatisticsManager {
    constructor() {
        this.version = '2.0.0';
        this.pbClient = pocketBaseClient;

        // Initialize all service modules
        this.storage = new StatisticsStorage('bassTrainerStatistics', this.version);
        this.calculator = new StatisticsCalculator();
        this.validator = new StatisticsValidator(this.storage);
        this.syncService = new StatisticsSyncService(this.pbClient, this.storage);
        this.sessionManager = new StatisticsSessionManager(this.storage, this.validator);

        // Initialize storage and check online status
        this.storage.initialize();
        this.syncService.checkOnlineStatus();
    }

    // ==================== Session Management ====================

    /**
     * Save a completed practice session
     * @param {Object} sessionSummary - Session summary from PracticeSession.getSessionSummary()
     * @returns {boolean} Success status
     */
    async saveSession(sessionSummary) {
        return await this.sessionManager.saveSession(sessionSummary, this.pbClient, this.version);
    }

    /**
     * Get session history with cloud sync support
     * @param {Object} filters - Filter options
     * @returns {Array<Object>} Array of session objects
     */
    async getSessionHistory(filters = {}) {
        return await this.sessionManager.getSessionHistory(filters, this.pbClient, this.syncService);
    }

    /**
     * Remove sessions with 0 notes from storage
     * @returns {boolean} Success status
     */
    cleanupEmptySessions() {
        return this.sessionManager.cleanupEmptySessions();
    }

    // ==================== Statistics Calculations ====================

    /**
     * Get aggregated statistics for a time range
     * @param {Object} options - Statistics options
     * @param {string} options.period - 'day', 'week', 'month', or 'all'
     * @param {number} options.days - Number of days to analyze (alternative to period)
     * @param {string} options.sessionType - Session type filter ('chromatic' or 'chord')
     * @returns {Object} Aggregated statistics
     */
    getStatistics(options = { period: 'all' }) {
        // Clean up empty sessions before calculating statistics
        this.sessionManager.cleanupEmptySessions();

        const sessions = this.sessionManager.getSessionsForPeriod(options, this.pbClient);
        return this.calculator.calculateStatistics(sessions, options.period || 'custom');
    }

    // ==================== Storage Management ====================

    /**
     * Export all statistics data for backup or sync
     * @returns {Object} Complete statistics data
     */
    exportData() {
        return this.storage.exportData();
    }

    /**
     * Import statistics data (for restore or sync)
     * @param {Object} importData - Statistics data to import
     * @param {boolean} merge - Whether to merge with existing data
     * @returns {boolean} Success status
     */
    importData(importData, merge = false) {
        return this.storage.importData(importData, merge);
    }

    /**
     * Clear all stored statistics data
     * @returns {boolean} Success status
     */
    clearAllData() {
        return this.storage.clearAllData();
    }

    /**
     * Get storage information
     * @returns {Object} Storage metadata
     */
    getStorageInfo() {
        return this.storage.getStorageInfo();
    }

    /**
     * Update storage settings
     * @param {Object} settings - Settings to update
     * @returns {boolean} Success status
     */
    updateSettings(settings) {
        return this.storage.updateSettings(settings);
    }

    // ==================== Cloud Sync ====================

    /**
     * Check online status and enable/disable sync
     */
    async checkOnlineStatus() {
        return await this.syncService.checkOnlineStatus();
    }

    /**
     * Perform full bidirectional sync between local storage and server
     * @returns {Object} Sync results
     */
    async performFullSync() {
        // Validate user before sync
        if (!this.validator.validateUserAndClearIfNeeded(this.pbClient)) {
            this.storage.initialize();
        }

        return await this.syncService.performFullSync();
    }

    /**
     * Get sync status information
     * @returns {Object} Sync status
     */
    async getSyncStatus() {
        return await this.syncService.getSyncStatus();
    }

    // ==================== Legacy/Compatibility Methods ====================

    /**
     * Get local session history (private method made public for backward compatibility)
     * @param {Object} filters - Filter options
     * @returns {Array<Object>} Array of session objects
     */
    getLocalSessionHistory(filters = {}) {
        return this.sessionManager.getLocalSessionHistory(filters, this.pbClient);
    }

    /**
     * Validate user and clear storage if needed
     * @returns {boolean} True if data is valid, false if data was cleared
     */
    validateUserAndClearIfNeeded() {
        return this.validator.validateUserAndClearIfNeeded(this.pbClient);
    }

    /**
     * Initialize storage (delegated to storage module)
     */
    initializeStorage() {
        this.storage.initialize();
    }

    /**
     * Get data (delegated to storage module)
     * @returns {Object|null} Complete statistics data
     */
    getData() {
        return this.storage.getData();
    }

    /**
     * Save data (delegated to storage module)
     * @param {Object} data - Complete statistics data
     * @returns {boolean} Success status
     */
    saveData(data) {
        return this.storage.saveData(data);
    }

    /**
     * Generate unique session ID
     * @returns {string} Unique session identifier
     */
    generateSessionId() {
        return this.sessionManager.generateSessionId();
    }

    /**
     * Get offline mode status
     * @returns {boolean} Offline mode status
     */
    get offlineMode() {
        return this.syncService.offlineMode;
    }

    /**
     * Get loading state
     * @returns {boolean} Loading state
     */
    get isLoadingData() {
        return this.sessionManager.isLoadingData;
    }

    /**
     * Get cleaning state
     * @returns {boolean} Cleaning state
     */
    get isCleaningData() {
        return this.sessionManager.isCleaningData;
    }
}
