/**
 * Authentication Setup Utilities
 * Provides reusable authentication setup patterns for trainers
 */

export class AuthenticationSetup {
    constructor(authStatus, statisticsManager) {
        this.authStatus = authStatus;
        this.statisticsManager = statisticsManager;
        
        this.originalSaveSession = null;
    }
    
    /**
     * Set up authentication with sync status and automatic sync
     */
    setupAuthentication() {
        if (!this.authStatus || !this.statisticsManager) {
            console.warn('AuthenticationSetup: Missing required dependencies');
            return;
        }
        
        // Clear any legacy migration status to ensure pure data-driven sync
        localStorage.removeItem('bass_trainer_migration_status');
        
        // Listen for authentication state changes
        this.authStatus.pbClient?.onAuthChange(async (user) => {
            if (user) {
                console.log('User authenticated, performing sync...');
                
                // Always perform full sync on login
                try {
                    const syncResult = await this.statisticsManager.performFullSync();
                    console.log('Login sync completed:', syncResult);
                } catch (error) {
                    console.error('Login sync failed:', error);
                }
                
                // Refresh sync status
                this.authStatus.refreshSyncStatus();
            } else {
                // User logged out - clear local storage to prevent cross-account contamination
                console.log('User logged out, clearing local storage...');
                if (this.statisticsManager) {
                    this.statisticsManager.clearAllData();
                }
            }
        });

        // Override the saveSession method to show sync status
        this.setupSyncStatusIndicator();
    }
    
    /**
     * Set up sync status indicator for session saves
     */
    setupSyncStatusIndicator() {
        if (!this.statisticsManager || !this.authStatus) return;
        
        // Store original method if not already stored
        if (!this.originalSaveSession) {
            this.originalSaveSession = this.statisticsManager.saveSession.bind(this.statisticsManager);
        }
        
        // Override saveSession to show syncing status
        this.statisticsManager.saveSession = async (sessionSummary) => {
            // Show syncing indicator
            this.authStatus.showSyncing();
            
            // Call original method
            const result = await this.originalSaveSession(sessionSummary);
            
            // If user is authenticated, perform sync after saving
            if (this.authStatus.pbClient?.isAuthenticated()) {
                try {
                    await this.statisticsManager.performFullSync();
                } catch (error) {
                    console.warn('Post-session sync failed:', error);
                }
            }
            
            // Refresh sync status after a brief delay
            setTimeout(() => {
                this.authStatus.refreshSyncStatus();
            }, 1000);
            
            return result;
        };
    }
    
    /**
     * Restore original saveSession method
     */
    restoreOriginalSaveSession() {
        if (this.originalSaveSession && this.statisticsManager) {
            this.statisticsManager.saveSession = this.originalSaveSession;
            this.originalSaveSession = null;
        }
    }
    
    /**
     * Check if user is authenticated
     * @returns {boolean} Whether user is authenticated
     */
    isAuthenticated() {
        return this.authStatus?.pbClient?.authStore?.isValid || false;
    }
    
    /**
     * Get current user information
     * @returns {Object|null} Current user data or null
     */
    getCurrentUser() {
        return this.authStatus?.pbClient?.authStore?.model || null;
    }
    
    /**
     * Trigger manual sync status refresh
     */
    refreshSyncStatus() {
        if (this.authStatus) {
            this.authStatus.refreshSyncStatus();
        }
    }
    
    /**
     * Trigger manual sync
     * @returns {Object} Sync results
     */
    async performManualSync() {
        if (!this.statisticsManager) return { success: false, error: 'No statistics manager' };
        
        this.authStatus?.showSyncing();
        
        try {
            const result = await this.statisticsManager.performFullSync();
            console.log('Manual sync completed:', result);
            
            // Refresh status after sync
            setTimeout(() => {
                this.authStatus?.refreshSyncStatus();
            }, 500);
            
            return result;
        } catch (error) {
            console.error('Manual sync failed:', error);
            this.authStatus?.refreshSyncStatus();
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Show syncing indicator
     */
    showSyncing() {
        if (this.authStatus) {
            this.authStatus.showSyncing();
        }
    }
    
    /**
     * Set up authentication with custom callbacks
     * @param {Object} callbacks - Custom callback functions
     * @param {Function} callbacks.onLogin - Called when user logs in
     * @param {Function} callbacks.onLogout - Called when user logs out
     * @param {Function} callbacks.onSyncStart - Called when sync starts
     * @param {Function} callbacks.onSyncComplete - Called when sync completes
     */
    setupWithCallbacks(callbacks = {}) {
        if (!this.authStatus) return;
        
        // Set up auth state change listener with callbacks
        this.authStatus.pbClient?.onAuthChange(async (user) => {
            if (user) {
                console.log('User authenticated with callbacks, performing sync...');
                
                // Always perform full sync on login
                if (callbacks.onSyncStart) {
                    callbacks.onSyncStart();
                }
                
                try {
                    const syncResult = await this.statisticsManager.performFullSync();
                    console.log('Login sync with callbacks completed:', syncResult);
                    
                    if (callbacks.onSyncComplete) {
                        callbacks.onSyncComplete(syncResult);
                    }
                } catch (error) {
                    console.error('Login sync with callbacks failed:', error);
                    if (callbacks.onSyncComplete) {
                        callbacks.onSyncComplete({ success: false, error: error.message });
                    }
                }
                
                this.authStatus.refreshSyncStatus();
                
                if (callbacks.onLogin) {
                    callbacks.onLogin(user);
                }
            } else {
                // User logged out - clear local storage to prevent cross-account contamination
                console.log('User logged out with callbacks, clearing local storage...');
                if (this.statisticsManager) {
                    this.statisticsManager.clearAllData();
                }
                
                if (callbacks.onLogout) {
                    callbacks.onLogout();
                }
            }
        });
        
        // Override saveSession with callbacks
        if (this.statisticsManager) {
            if (!this.originalSaveSession) {
                this.originalSaveSession = this.statisticsManager.saveSession.bind(this.statisticsManager);
            }
            
            this.statisticsManager.saveSession = async (sessionSummary) => {
                // Sync start callback
                if (callbacks.onSyncStart) {
                    callbacks.onSyncStart();
                }
                
                this.authStatus.showSyncing();
                const result = await this.originalSaveSession(sessionSummary);
                
                // If user is authenticated, perform sync after saving
                if (this.authStatus.pbClient?.isAuthenticated()) {
                    try {
                        await this.statisticsManager.performFullSync();
                    } catch (error) {
                        console.warn('Post-session sync with callbacks failed:', error);
                    }
                }
                
                setTimeout(() => {
                    this.authStatus.refreshSyncStatus();
                    
                    // Sync complete callback
                    if (callbacks.onSyncComplete) {
                        callbacks.onSyncComplete(result);
                    }
                }, 1000);
                
                return result;
            };
        }
    }
    
    /**
     * Clean up authentication setup
     */
    cleanup() {
        this.restoreOriginalSaveSession();
    }
}

/**
 * Utility function to create and setup authentication for a trainer
 * @param {Object} authStatus - AuthStatus instance
 * @param {Object} statisticsManager - StatisticsManager instance  
 * @param {Object} callbacks - Optional callbacks for auth events
 * @returns {AuthenticationSetup} Configured authentication setup instance
 */
export function setupTrainerAuthentication(authStatus, statisticsManager, callbacks = {}) {
    const authSetup = new AuthenticationSetup(authStatus, statisticsManager);
    
    if (Object.keys(callbacks).length > 0) {
        authSetup.setupWithCallbacks(callbacks);
    } else {
        authSetup.setupAuthentication();
    }
    
    return authSetup;
}