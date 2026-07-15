/**
 * Authentication Status Component
 * Displays user authentication status and provides login/logout functionality
 */

import { pocketBaseClient } from './pocketbase-client.js';

class AuthStatus {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.currentUser = null;
        this.isAutoSyncing = false;
        this.autoSyncTimeout = null;
        this.render();
        this.bindEvents();
    }

    /**
     * Render the authentication status UI
     */
    render() {
        if (!this.container) return;

        this.container.innerHTML = `
            <div class="auth-status">
                <div id="auth-user-info" class="user-info" style="display: none;">
                    <div class="user-dropdown">
                        <button class="user-dropdown-toggle" onclick="toggleUserDropdown(this)">
                            <span class="user-name"></span>
                            <span class="sync-indicator"></span>
                            <i class="fas fa-chevron-down"></i>
                        </button>
                        <div class="user-dropdown-menu">
                            <a href="/statistics/" class="dropdown-item">
                                <i class="fas fa-chart-line"></i>
                                Statistics
                            </a>
                            <button id="auth-logout" class="dropdown-item logout-btn">
                                <i class="fas fa-sign-out-alt"></i>
                                Sign Out
                            </button>
                        </div>
                    </div>
                </div>
                <div id="auth-login-prompt" class="login-prompt">
                    <a href="/login/" class="login-link">Sign In</a>
                </div>
            </div>
        `;

        this.addStyles();
    }

    /**
     * Add CSS styles for the auth status component
     */
    addStyles() {
        if (document.getElementById('auth-status-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'auth-status-styles';
        styles.textContent = `
            .auth-status {
                display: flex;
                align-items: center;
                gap: 1rem;
                padding: 0.5rem;
                font-size: 0.9rem;
            }

            .user-info {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                color: var(--text-color, #333);
            }

            .user-name {
                font-weight: 500;
            }

            .logout-btn {
                background: none;
                border: 1px solid var(--border-color, #ddd);
                color: var(--text-color, #333);
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                font-size: 0.8rem;
                cursor: pointer;
                transition: background-color 0.2s;
            }

            .logout-btn:hover {
                background: var(--hover-color, #f5f5f5);
            }

            .login-prompt {
                display: flex;
                align-items: center;
            }

            .login-link {
                color: var(--primary-color, #007bff);
                text-decoration: none;
                font-weight: 500;
                padding: 0.5rem 1rem;
                border: 1px solid var(--primary-color, #007bff);
                border-radius: 4px;
                transition: all 0.2s;
                background: transparent;
            }

            .login-link:hover {
                background: var(--primary-color, #007bff);
                color: white;
                text-decoration: none;
            }

            .user-dropdown {
                position: relative;
                display: inline-block;
            }

            .user-dropdown-toggle {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                background: none;
                border: 1px solid var(--border-color, #ddd);
                color: var(--text-color, #333);
                padding: 0.5rem 1rem;
                border-radius: 4px;
                cursor: pointer;
                transition: background-color 0.2s;
                font-size: 0.9rem;
            }

            .user-dropdown-toggle:hover {
                background: var(--hover-color, #f5f5f5);
            }

            .user-dropdown-menu {
                position: absolute;
                top: 100%;
                right: 0;
                background: white;
                border: 1px solid var(--border-color, #ddd);
                border-radius: 4px;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                min-width: 150px;
                z-index: 1000;
                display: none;
            }

            .user-dropdown-menu.show {
                display: block;
            }

            .dropdown-item {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                padding: 0.75rem 1rem;
                color: var(--text-color, #333);
                text-decoration: none;
                border: none;
                background: none;
                width: 100%;
                text-align: left;
                cursor: pointer;
                transition: background-color 0.2s;
                font-size: 0.9rem;
            }

            .dropdown-item:hover {
                background: var(--hover-color, #f5f5f5);
                text-decoration: none;
            }

            .sync-status {
                display: flex;
                align-items: center;
                gap: 0.25rem;
                font-size: 0.8rem;
                color: var(--text-secondary, #666);
            }

            .sync-indicator {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--success-color, #28a745);
            }

            .sync-indicator.syncing {
                background: var(--warning-color, #ffc107);
                animation: pulse 1.5s ease-in-out infinite;
            }

            .sync-indicator.offline {
                background: var(--danger-color, #dc3545);
            }
            
            .sync-indicator.needs-sync {
                background: var(--warning-color, #ffc107);
            }
            
            .sync-button {
                margin-left: 0.5rem;
                padding: 0.2rem 0.5rem;
                font-size: 0.75rem;
                border: 1px solid var(--warning-color, #ffc107);
                background: transparent;
                color: var(--warning-color, #ffc107);
                border-radius: 3px;
                cursor: pointer;
                transition: background-color 0.2s;
            }
            
            .sync-button:hover {
                background: var(--warning-color, #ffc107);
                color: white;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
        `;
        document.head.appendChild(styles);
    }

    /**
     * Bind event listeners
     */
    bindEvents() {
        // Listen for authentication changes
        pocketBaseClient.onAuthChange((user) => {
            this.currentUser = user;
            this.updateUI();
        });

        // Handle logout and sync buttons
        this.container.addEventListener('click', (e) => {
            if (e.target.id === 'auth-logout') {
                this.handleLogout();
            } else if (e.target.classList.contains('sync-button')) {
                this.handleManualSync();
            }
        });
    }

    /**
     * Update the UI based on authentication status
     */
    updateUI() {
        const userInfo = this.container.querySelector('#auth-user-info');
        const loginPrompt = this.container.querySelector('#auth-login-prompt');

        if (this.currentUser) {
            // User is authenticated
            const userName = this.currentUser.name || this.currentUser.email || 'User';
            this.container.querySelector('.user-name').textContent = userName;
            
            userInfo.style.display = 'flex';
            loginPrompt.style.display = 'none';

            // Update sync status
            this.updateSyncStatus();
        } else {
            // User is not authenticated
            userInfo.style.display = 'none';
            loginPrompt.style.display = 'flex';
        }
    }

    /**
     * Update sync status indicator
     */
    async updateSyncStatus() {
        const indicator = this.container.querySelector('.sync-indicator');
        
        if (!indicator) return;

        try {
            // Get real sync status from StatisticsManager
            const syncStatus = await this.getSyncStatusFromStatistics();
            
            if (!syncStatus.isAuthenticated) {
                indicator.className = 'sync-indicator offline';
            } else if (!syncStatus.isOnline) {
                indicator.className = 'sync-indicator offline';
            } else if (syncStatus.needsSync) {
                if (!this.isAutoSyncing) {
                    // Start automatic sync
                    this.startAutoSync();
                }
                indicator.className = 'sync-indicator syncing';
            } else {
                indicator.className = 'sync-indicator';
            }
        } catch (error) {
            console.error('Failed to get sync status:', error);
            indicator.className = 'sync-indicator offline';
        }
    }

    /**
     * Get sync status from StatisticsManager
     * @returns {Object} Sync status information
     */
    async getSyncStatusFromStatistics() {
        // Try to get statistics manager from window object or find it
        let statsManager = null;
        
        // Look for statistics manager in common places
        if (window.trainer?.statisticsManager) {
            statsManager = window.trainer.statisticsManager;
        } else if (window.bassTrainer?.statisticsManager) {
            statsManager = window.bassTrainer.statisticsManager;
        } else if (window.chordTrainer?.statisticsManager) {
            statsManager = window.chordTrainer.statisticsManager;
        } else if (window.statisticsManager) {
            statsManager = window.statisticsManager;
        }
        
        if (statsManager && typeof statsManager.getSyncStatus === 'function') {
            return await statsManager.getSyncStatus();
        } else {
            // Fallback - just check basic online/auth status
            const isAuthenticated = pocketBaseClient.isAuthenticated();
            const isOnline = await pocketBaseClient.isOnline();
            
            return {
                isAuthenticated,
                isOnline,
                needsSync: false,
                pendingPush: 0,
                pendingPull: 0,
                canSync: isAuthenticated && isOnline
            };
        }
    }

    /**
     * Handle manual sync button click
     */
    async handleManualSync() {
        try {
            // Clear any pending auto sync
            if (this.autoSyncTimeout) {
                clearTimeout(this.autoSyncTimeout);
                this.autoSyncTimeout = null;
            }
            this.isAutoSyncing = false;
            
            // Get statistics manager to perform sync
            let statsManager = null;
            
            if (window.trainer?.statisticsManager) {
                statsManager = window.trainer.statisticsManager;
            } else if (window.bassTrainer?.statisticsManager) {
                statsManager = window.bassTrainer.statisticsManager;
            } else if (window.chordTrainer?.statisticsManager) {
                statsManager = window.chordTrainer.statisticsManager;
            } else if (window.statisticsManager) {
                statsManager = window.statisticsManager;
            }
            
            if (!statsManager) {
                console.error('No statistics manager found for manual sync');
                return;
            }
            
            // Show syncing status
            this.showSyncing();
            
            // Perform sync
            const result = await statsManager.performFullSync();
            console.log('Manual sync result:', result);
            
            // Update status after sync
            setTimeout(() => {
                this.updateSyncStatus();
            }, 1000);
            
        } catch (error) {
            console.error('Manual sync failed:', error);
            // Update status to show error state
            setTimeout(() => {
                this.updateSyncStatus();
            }, 1000);
        }
    }

    /**
     * Handle user logout
     */
    async handleLogout() {
        try {
            pocketBaseClient.logout();
            
            // Update status after logout
            setTimeout(() => {
                this.updateSyncStatus();
            }, 1000);
        } catch (error) {
            console.error('Logout error:', error);
        }
    }

    /**
     * Manually trigger sync status update
     */
    refreshSyncStatus() {
        if (this.currentUser) {
            this.updateSyncStatus();
        }
    }

    /**
     * Start automatic sync when out of sync and logged in
     */
    async startAutoSync() {
        if (this.isAutoSyncing || !this.currentUser) return;
        
        // Clear any existing timeout
        if (this.autoSyncTimeout) {
            clearTimeout(this.autoSyncTimeout);
        }
        
        // Add a small delay to avoid conflicts with rapid status checks
        this.autoSyncTimeout = setTimeout(async () => {
            this.isAutoSyncing = true;
            
            try {
                // Get statistics manager to perform sync
                let statsManager = null;
                
                if (window.trainer?.statisticsManager) {
                    statsManager = window.trainer.statisticsManager;
                } else if (window.bassTrainer?.statisticsManager) {
                    statsManager = window.bassTrainer.statisticsManager;
                } else if (window.chordTrainer?.statisticsManager) {
                    statsManager = window.chordTrainer.statisticsManager;
                } else if (window.statisticsManager) {
                    statsManager = window.statisticsManager;
                }
                
                if (!statsManager) {
                    console.error('No statistics manager found for auto sync');
                    return;
                }
                
                // Perform sync
                const result = await statsManager.performFullSync();
                console.log('Auto sync result:', result);
                
            } catch (error) {
                console.error('Auto sync failed:', error);
            } finally {
                this.isAutoSyncing = false;
                
                // Update status after sync completion
                setTimeout(() => {
                    this.updateSyncStatus();
                }, 1000);
            }
        }, 500); // 500ms delay before starting auto sync
    }

    /**
     * Show syncing status temporarily
     */
    showSyncing() {
        const indicator = this.container.querySelector('.sync-indicator');
        
        if (!indicator || !this.currentUser) return;

        indicator.className = 'sync-indicator syncing';
        
        setTimeout(() => {
            this.updateSyncStatus();
        }, 2000);
    }
}

// Export for use in other modules
export { AuthStatus };