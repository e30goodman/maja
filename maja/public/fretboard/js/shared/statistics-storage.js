/**
 * Statistics Storage Module
 * Handles localStorage operations for practice session data
 */
export class StatisticsStorage {
    constructor(storageKey = 'bassTrainerStatistics', version = '2.0.0') {
        this.storageKey = storageKey;
        this.version = version;
    }

    /**
     * Initialize or migrate storage structure
     */
    initialize() {
        const existingData = localStorage.getItem(this.storageKey);
        if (!existingData) {
            const initialData = {
                version: this.version,
                sessions: [],
                settings: {
                    dataRetentionDays: 365,
                    syncEnabled: true,
                    lastSync: null
                },
                metadata: {
                    totalSessions: 0,
                    firstSessionDate: null,
                    lastSessionDate: null,
                    userId: null
                }
            };
            localStorage.setItem(this.storageKey, JSON.stringify(initialData));
        }
    }

    /**
     * Get all stored data
     * @returns {Object|null} Complete statistics data
     */
    getData() {
        try {
            const data = localStorage.getItem(this.storageKey);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('StatisticsStorage: Error reading data:', error);
            return null;
        }
    }

    /**
     * Save data to storage
     * @param {Object} data - Complete statistics data
     * @returns {boolean} Success status
     */
    saveData(data) {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(data));
            return true;
        } catch (error) {
            console.error('StatisticsStorage: Error saving data:', error);
            return false;
        }
    }

    /**
     * Clear all stored statistics data
     * @returns {boolean} Success status
     */
    clearAllData() {
        try {
            localStorage.removeItem(this.storageKey);
            this.initialize();
            return true;
        } catch (error) {
            console.error('StatisticsStorage: Error clearing data:', error);
            return false;
        }
    }

    /**
     * Update storage settings
     * @param {Object} settings - Settings to update
     * @returns {boolean} Success status
     */
    updateSettings(settings) {
        const data = this.getData();
        if (!data) return false;

        data.settings = { ...data.settings, ...settings };
        return this.saveData(data);
    }

    /**
     * Get storage information
     * @returns {Object|null} Storage metadata
     */
    getStorageInfo() {
        const data = this.getData();
        if (!data) return null;

        const storageSize = new Blob([JSON.stringify(data)]).size;

        return {
            version: data.version,
            totalSessions: data.metadata.totalSessions,
            firstSessionDate: data.metadata.firstSessionDate,
            lastSessionDate: data.metadata.lastSessionDate,
            storageSizeBytes: storageSize,
            retentionDays: data.settings.dataRetentionDays,
            syncEnabled: data.settings.syncEnabled,
            lastSync: data.settings.lastSync
        };
    }

    /**
     * Export all statistics data for backup or sync
     * @returns {Object|null} Complete statistics data
     */
    exportData() {
        return this.getData();
    }

    /**
     * Import statistics data (for restore or sync)
     * @param {Object} importData - Statistics data to import
     * @param {boolean} merge - Whether to merge with existing data
     * @returns {boolean} Success status
     */
    importData(importData, merge = false) {
        if (!importData || !importData.sessions) {
            console.warn('StatisticsStorage: Invalid import data');
            return false;
        }

        let finalData = importData;

        if (merge) {
            const existingData = this.getData();
            if (existingData) {
                // Merge sessions (avoid duplicates by sessionId)
                const existingSessionIds = new Set(existingData.sessions.map(s => s.sessionId));
                const newSessions = importData.sessions.filter(s => !existingSessionIds.has(s.sessionId));

                finalData = {
                    ...existingData,
                    sessions: [...existingData.sessions, ...newSessions],
                    metadata: {
                        ...existingData.metadata,
                        totalSessions: existingData.sessions.length + newSessions.length
                    }
                };
            }
        }

        // Update version and sync status
        finalData.version = this.version;
        finalData.settings = { ...finalData.settings, lastSync: Date.now() };

        return this.saveData(finalData);
    }
}
