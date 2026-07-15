/**
 * Statistics Sync Service Module
 * Handles bidirectional synchronization between local storage and PocketBase server
 */
export class StatisticsSyncService {
    constructor(pbClient, storage) {
        this.pbClient = pbClient;
        this.storage = storage;
        this.offlineMode = false;
    }

    /**
     * Check online status and enable/disable sync
     */
    async checkOnlineStatus() {
        try {
            this.offlineMode = !(await this.pbClient.isOnline());
        } catch (error) {
            this.offlineMode = true;
        }
    }

    /**
     * Merge local and cloud session data
     * @param {Array} cloudSessions - Sessions from PocketBase
     * @param {Array} localSessions - Local sessions
     * @returns {Array} Merged session data
     */
    mergeLocalAndCloudData(cloudSessions, localSessions) {
        // Create a map of cloud sessions by sessionId
        const cloudSessionMap = new Map();
        cloudSessions.forEach(session => {
            if (session.sessionId) {
                cloudSessionMap.set(session.sessionId, session);
            }
        });

        // Merge data, preferring cloud data where available
        const mergedSessions = [];
        const processedIds = new Set();

        // Add cloud sessions first
        cloudSessions.forEach(session => {
            mergedSessions.push(session);
            if (session.sessionId) {
                processedIds.add(session.sessionId);
            }
        });

        // Add local sessions that aren't in cloud
        localSessions.forEach(session => {
            if (!processedIds.has(session.sessionId)) {
                mergedSessions.push(session);
            }
        });

        // Sort by timestamp (most recent first)
        mergedSessions.sort((a, b) => b.timestamp - a.timestamp);

        return mergedSessions;
    }

    /**
     * Perform full bidirectional sync between local storage and server
     * @returns {Object} Sync results
     */
    async performFullSync() {
        try {
            await this.checkOnlineStatus();

            if (this.offlineMode || !this.pbClient.isAuthenticated()) {
                return {
                    success: false,
                    error: 'Not authenticated or offline',
                    pushed: 0,
                    pulled: 0
                };
            }

            console.log('Starting full sync...');

            // Step 1: Get all sessions from both sources
            const [serverSessions, localSessions] = await Promise.all([
                this.getServerSessions(),
                Promise.resolve(this.getLocalSessions())
            ]);

            // Step 2: Identify what needs to be synced
            const sessionsToPush = this.identifyPushNeeded(localSessions, serverSessions);
            const sessionsToPull = this.identifyPullNeeded(serverSessions, localSessions);

            console.log(`Sync plan: Push ${sessionsToPush.length}, Pull ${sessionsToPull.length}`);

            // Step 3: Perform sync operations
            const [pushResults, pullResults] = await Promise.all([
                this.pushSessions(sessionsToPush),
                this.pullSessions(sessionsToPull)
            ]);

            // Update last sync time
            const data = this.storage.getData();
            if (data) {
                data.settings.lastSync = Date.now();
                this.storage.saveData(data);
            }

            const result = {
                success: true,
                pushed: pushResults.successful,
                pulled: pullResults.successful,
                pushFailed: pushResults.failed,
                pullFailed: pullResults.failed,
                totalProcessed: pushResults.successful + pullResults.successful
            };

            console.log('Sync completed:', result);
            return result;

        } catch (error) {
            console.error('Full sync failed:', error);
            return {
                success: false,
                error: error.message,
                pushed: 0,
                pulled: 0
            };
        }
    }

    /**
     * Get all sessions from server
     * @returns {Array} Server sessions
     */
    async getServerSessions() {
        try {
            return await this.pbClient.getAllPracticeSessions({ limit: 2000 });
        } catch (error) {
            console.error('Failed to fetch server sessions:', error);
            return [];
        }
    }

    /**
     * Get all local sessions
     * @returns {Array} Local sessions
     */
    getLocalSessions() {
        const data = this.storage.getData();
        return data ? data.sessions || [] : [];
    }

    /**
     * Identify sessions that exist locally but not on server (need to be pushed)
     * @param {Array} localSessions - Local sessions
     * @param {Array} serverSessions - Server sessions
     * @returns {Array} Sessions to push
     */
    identifyPushNeeded(localSessions, serverSessions) {
        const serverSessionIds = new Set(serverSessions.map(s => s.sessionId).filter(Boolean));

        const validSessions = localSessions.filter(session => {
            // Validate session has required data
            if (!session.sessionId) {
                console.warn('Skipping session without sessionId:', session);
                return false;
            }
            if (!session.records || session.records.length === 0) {
                console.warn('Skipping session without records:', session.sessionId);
                return false;
            }
            if ((session.total || 0) === 0) {
                console.warn('Skipping session with 0 total:', session.sessionId);
                return false;
            }
            return true;
        });

        return validSessions.filter(session => !serverSessionIds.has(session.sessionId));
    }

    /**
     * Identify sessions that exist on server but not locally (need to be pulled)
     * @param {Array} serverSessions - Server sessions
     * @param {Array} localSessions - Local sessions
     * @returns {Array} Sessions to pull
     */
    identifyPullNeeded(serverSessions, localSessions) {
        const localSessionIds = new Set(localSessions.map(s => s.sessionId).filter(Boolean));

        const validServerSessions = serverSessions.filter(session => {
            // Validate server session has required data
            if (!session.sessionId) {
                console.warn('Skipping server session without sessionId:', session.id);
                return false;
            }
            return true;
        });

        return validServerSessions.filter(session => !localSessionIds.has(session.sessionId));
    }

    /**
     * Push sessions to server
     * @param {Array} sessions - Sessions to push
     * @returns {Object} Push results
     */
    async pushSessions(sessions) {
        if (sessions.length === 0) {
            return { successful: 0, failed: 0 };
        }

        console.log(`Pushing ${sessions.length} sessions to server...`);

        let successful = 0;
        let failed = 0;

        // Process sessions one at a time to avoid auto-cancellation
        for (const session of sessions) {
            try {
                await this.pbClient.savePracticeSession(session);
                successful++;
            } catch (error) {
                console.warn('Failed to push session:', session.sessionId, error);
                failed++;
            }

            // Delay between each request to avoid rate limiting
            if (sessions.indexOf(session) < sessions.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        console.log(`Push completed: ${successful} successful, ${failed} failed`);
        return { successful, failed };
    }

    /**
     * Pull sessions from server and add to local storage
     * @param {Array} sessions - Sessions to pull
     * @returns {Object} Pull results
     */
    async pullSessions(sessions) {
        if (sessions.length === 0) {
            return { successful: 0, failed: 0 };
        }

        console.log(`Pulling ${sessions.length} sessions from server...`);

        const data = this.storage.getData();
        if (!data) {
            return { successful: 0, failed: sessions.length };
        }

        let successful = 0;
        let failed = 0;

        for (const session of sessions) {
            try {
                // Add server session to local storage
                data.sessions.push(session);
                successful++;
            } catch (error) {
                console.warn('Failed to add server session locally:', session.sessionId, error);
                failed++;
            }
        }

        // Update metadata
        data.metadata.totalSessions = data.sessions.length;

        if (data.sessions.length > 0) {
            const sortedSessions = data.sessions.sort((a, b) => new Date(a.date) - new Date(b.date));
            data.metadata.firstSessionDate = sortedSessions[0].date;
            data.metadata.lastSessionDate = sortedSessions[sortedSessions.length - 1].date;
        }

        // Save updated data
        this.storage.saveData(data);

        console.log(`Pull completed: ${successful} successful, ${failed} failed`);
        return { successful, failed };
    }

    /**
     * Get sync status information
     * @returns {Object} Sync status
     */
    async getSyncStatus() {
        try {
            await this.checkOnlineStatus();

            const isAuthenticated = this.pbClient.isAuthenticated();
            const isOnline = !this.offlineMode;

            if (!isAuthenticated || !isOnline) {
                return {
                    canSync: false,
                    isAuthenticated,
                    isOnline,
                    pendingPush: 0,
                    pendingPull: 0,
                    lastSync: this.getLastSyncTime()
                };
            }

            // Get session counts for status
            const [serverSessions, localSessions] = await Promise.all([
                this.getServerSessions(),
                Promise.resolve(this.getLocalSessions())
            ]);

            const pendingPush = this.identifyPushNeeded(localSessions, serverSessions).length;
            const pendingPull = this.identifyPullNeeded(serverSessions, localSessions).length;

            return {
                canSync: true,
                isAuthenticated,
                isOnline,
                pendingPush,
                pendingPull,
                needsSync: pendingPush > 0 || pendingPull > 0,
                lastSync: this.getLastSyncTime()
            };

        } catch (error) {
            console.error('Failed to get sync status:', error);
            return {
                canSync: false,
                isAuthenticated: false,
                isOnline: false,
                pendingPush: 0,
                pendingPull: 0,
                lastSync: null,
                error: error.message
            };
        }
    }

    /**
     * Get last sync timestamp
     * @returns {number|null} Last sync time
     */
    getLastSyncTime() {
        const data = this.storage.getData();
        return data?.settings?.lastSync || null;
    }
}
