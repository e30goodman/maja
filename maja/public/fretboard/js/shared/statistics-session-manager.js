/**
 * Statistics Session Manager Module
 * Handles session CRUD operations and filtering
 */
export class StatisticsSessionManager {
    constructor(storage, validator) {
        this.storage = storage;
        this.validator = validator;
        this.isLoadingData = false;
        this.isCleaningData = false;
    }

    /**
     * Save a completed practice session
     * @param {Object} sessionSummary - Session summary from PracticeSession.getSessionSummary()
     * @param {Object} pbClient - PocketBase client instance
     * @param {string} version - Current version string
     * @returns {boolean} Success status
     */
    async saveSession(sessionSummary, pbClient, version) {
        if (!sessionSummary || !sessionSummary.records) {
            console.warn('StatisticsSessionManager: Invalid session summary provided');
            return false;
        }

        // Validate user and clear storage if needed
        if (!this.validator.validateUserAndClearIfNeeded(pbClient)) {
            // Data was cleared, need to reinitialize
            this.storage.initialize();
        }

        const data = this.storage.getData();
        if (!data) return false;

        // Ensure current user ID is tracked
        const currentUserId = pbClient.getCurrentUser()?.id || null;
        if (currentUserId && !data.metadata.userId) {
            data.metadata.userId = currentUserId;
        }

        const sessionId = this.generateSessionId();
        const enrichedSession = {
            sessionId: sessionId,
            timestamp: sessionSummary.endTime || Date.now(),
            date: new Date().toISOString().split('T')[0], // YYYY-MM-DD format

            // Core session data
            ...sessionSummary,

            // Additional metadata
            version: version
        };

        // Save to localStorage first (offline-first approach)
        data.sessions.push(enrichedSession);
        data.metadata.totalSessions++;
        data.metadata.lastSessionDate = enrichedSession.date;

        if (!data.metadata.firstSessionDate) {
            data.metadata.firstSessionDate = enrichedSession.date;
        }

        // Cleanup old sessions based on retention policy
        this.cleanupOldSessions(data);

        // Save to localStorage
        return this.storage.saveData(data);
    }

    /**
     * Generate unique session ID
     * @returns {string} Unique session identifier
     */
    generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Remove old sessions based on retention policy
     * @param {Object} data - Statistics data object
     */
    cleanupOldSessions(data) {
        const retentionDays = data.settings.dataRetentionDays;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffTimestamp = cutoffDate.getTime();

        data.sessions = data.sessions.filter(session => session.timestamp >= cutoffTimestamp);
    }

    /**
     * Remove sessions with 0 notes from storage
     * @returns {boolean} Success status
     */
    cleanupEmptySessions() {
        // Prevent cleanup during data loading operations
        if (this.isLoadingData) {
            console.log('StatisticsSessionManager: Skipping cleanup during data loading');
            return true;
        }

        if (this.isCleaningData) {
            console.log('StatisticsSessionManager: Cleanup already in progress');
            return true;
        }

        this.isCleaningData = true;

        try {
            const data = this.storage.getData();
            if (!data) return false;

            const originalCount = data.sessions.length;

            // Filter out sessions with 0 notes
            data.sessions = data.sessions.filter(session => {
                const total = session.total || 0;
                return total > 0;
            });

            const removedCount = originalCount - data.sessions.length;

            if (removedCount > 0) {
                // Update metadata
                data.metadata.totalSessions = data.sessions.length;

                // Update first and last session dates
                if (data.sessions.length > 0) {
                    const sortedSessions = data.sessions.sort((a, b) => new Date(a.date) - new Date(b.date));
                    data.metadata.firstSessionDate = sortedSessions[0].date;
                    data.metadata.lastSessionDate = sortedSessions[sortedSessions.length - 1].date;
                } else {
                    data.metadata.firstSessionDate = null;
                    data.metadata.lastSessionDate = null;
                }

                const success = this.storage.saveData(data);
                if (success) {
                    console.log(`StatisticsSessionManager: Cleaned up ${removedCount} empty sessions`);
                }
                return success;
            }

            return true; // No cleanup needed
        } finally {
            this.isCleaningData = false;
        }
    }

    /**
     * Get session history with cloud sync support
     * @param {Object} filters - Filter options
     * @param {Object} pbClient - PocketBase client instance
     * @param {Object} syncService - Sync service instance
     * @returns {Array<Object>} Array of session objects
     */
    async getSessionHistory(filters, pbClient, syncService) {
        if (this.isLoadingData) {
            console.log('StatisticsSessionManager: Data loading already in progress');
            // Wait a bit and try again
            await new Promise(resolve => setTimeout(resolve, 100));
            if (this.isLoadingData) {
                console.warn('StatisticsSessionManager: Data loading still in progress, returning empty');
                return [];
            }
        }

        this.isLoadingData = true;

        try {
            // Clean up empty sessions before returning data (only if not currently cleaning)
            if (!this.isCleaningData) {
                this.cleanupEmptySessions();
            }

            // Try to get data from cloud if authenticated and online
            if (pbClient.isAuthenticated() && !syncService.offlineMode) {
                try {
                    console.log('StatisticsSessionManager: Fetching cloud sessions...');
                    const cloudSessions = await pbClient.getPracticeSessions({
                        dateFrom: filters.dateFrom,
                        dateTo: filters.dateTo,
                        limit: filters.limit,
                        sessionType: filters.sessionType,
                        fretboardVisible: filters.fretboardVisible
                    });

                    if (cloudSessions.length > 0) {
                        console.log('StatisticsSessionManager: Cloud sessions found, merging with local data');
                        const localSessions = this.getLocalSessionHistory(filters, pbClient);
                        return syncService.mergeLocalAndCloudData(cloudSessions, localSessions);
                    }
                } catch (error) {
                    console.warn('StatisticsSessionManager: Failed to fetch cloud sessions, using local data:', error);
                }
            }

            // Fallback to local data
            console.log('StatisticsSessionManager: Using local session data');
            return this.getLocalSessionHistory(filters, pbClient);

        } finally {
            this.isLoadingData = false;
        }
    }

    /**
     * Get local session history with filters
     * @param {Object} filters - Filter options
     * @param {Object} pbClient - PocketBase client instance
     * @returns {Array<Object>} Array of session objects
     */
    getLocalSessionHistory(filters, pbClient) {
        // Validate user and clear storage if needed
        if (!this.validator.validateUserAndClearIfNeeded(pbClient)) {
            return []; // Data was cleared
        }

        const data = this.storage.getData();
        if (!data) return [];

        let sessions = [...data.sessions];

        // Apply date filters
        if (filters.dateFrom) {
            const fromDate = new Date(filters.dateFrom).getTime();
            sessions = sessions.filter(session => session.timestamp >= fromDate);
        }

        if (filters.dateTo) {
            const toDate = new Date(filters.dateTo + 'T23:59:59').getTime();
            sessions = sessions.filter(session => session.timestamp <= toDate);
        }

        // Filter by session type
        if (filters.sessionType) {
            sessions = sessions.filter(session => session.sessionType === filters.sessionType);
        }

        // Filter by fretboard visibility
        if (filters.fretboardVisible !== undefined) {
            sessions = sessions.filter(session => {
                const sessionFretboardVisible = session.metadata?.fretboardVisible ?? true;
                return sessionFretboardVisible === filters.fretboardVisible;
            });
        }

        // Filter by note pool
        if (filters.notePool && filters.notePool.length > 0) {
            sessions = sessions.filter(session => {
                return session.notePool && session.notePool.some(note =>
                    filters.notePool.includes(note)
                );
            });
        }

        // Sort by timestamp (most recent first)
        sessions.sort((a, b) => b.timestamp - a.timestamp);

        // Apply limit
        if (filters.limit && filters.limit > 0) {
            sessions = sessions.slice(0, filters.limit);
        }

        return sessions;
    }

    /**
     * Get sessions for a specific time period
     * @param {Object} options - Period options
     * @param {Object} pbClient - PocketBase client instance
     * @returns {Array<Object>} Filtered sessions
     */
    getSessionsForPeriod(options, pbClient) {
        const now = new Date();
        let dateFrom = null;

        if (options.days) {
            dateFrom = new Date(now);
            dateFrom.setDate(dateFrom.getDate() - options.days);
        } else {
            switch (options.period) {
                case 'day':
                    dateFrom = new Date(now);
                    dateFrom.setHours(0, 0, 0, 0);
                    break;
                case 'week':
                    dateFrom = new Date(now);
                    dateFrom.setDate(dateFrom.getDate() - 7);
                    break;
                case 'month':
                    dateFrom = new Date(now);
                    dateFrom.setMonth(dateFrom.getMonth() - 1);
                    break;
                case 'all':
                default:
                    return this.getLocalSessionHistory({
                        sessionType: options.sessionType,
                        fretboardVisible: options.fretboardVisible
                    }, pbClient);
            }
        }

        return this.getLocalSessionHistory({
            dateFrom: dateFrom.toISOString().split('T')[0],
            sessionType: options.sessionType,
            fretboardVisible: options.fretboardVisible
        }, pbClient);
    }
}
