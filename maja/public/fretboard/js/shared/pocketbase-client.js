/**
 * PocketBase Client Wrapper
 * Provides authentication and data synchronization for the bass trainer app
 */

class PocketBaseClient {
    constructor() {
        this.pb = null;
        this.isInitialized = false;
        // Use dynamically injected API URL from Hugo config, fallback to production URL
        this.baseUrl = window.appConfig?.apiBaseURL || 'https://be.lyafb.com';
        this.currentUser = null;
        this.authCallbacks = [];
        
        this.init();
    }

    /**
     * Initialize PocketBase client
     */
    async init() {
        try {
            // Load PocketBase SDK if not already loaded
            if (typeof PocketBase === 'undefined') {
                await this.loadPocketBaseSDK();
            }
            
            this.pb = new PocketBase(this.baseUrl);
            
            // Auto-refresh authentication
            this.pb.authStore.onChange((auth) => {
                this.currentUser = auth.isValid ? auth.model : null;
                this.notifyAuthCallbacks(this.currentUser);
            });
            
            // Check if already authenticated
            if (this.pb.authStore.isValid) {
                this.currentUser = this.pb.authStore.model;
                this.notifyAuthCallbacks(this.currentUser);
            }
            
            this.isInitialized = true;
            console.log('PocketBase client initialized');
        } catch (error) {
            console.error('Failed to initialize PocketBase client:', error);
        }
    }

    /**
     * Load PocketBase SDK from CDN
     */
    async loadPocketBaseSDK() {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/pocketbase@latest/dist/pocketbase.umd.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    /**
     * Register authentication state callback
     * @param {Function} callback - Function to call on auth state change
     */
    onAuthChange(callback) {
        this.authCallbacks.push(callback);
        
        // Call immediately if already authenticated
        if (this.currentUser) {
            callback(this.currentUser);
        }
    }

    /**
     * Notify all auth callbacks
     * @param {Object|null} user - Current user object or null
     */
    notifyAuthCallbacks(user) {
        this.authCallbacks.forEach(callback => {
            try {
                callback(user);
            } catch (error) {
                console.error('Auth callback error:', error);
            }
        });
    }

    /**
     * Wait for client to be initialized
     */
    async waitForInit() {
        while (!this.isInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    /**
     * Login with email and password
     * @param {string} email 
     * @param {string} password 
     * @returns {Object} User data
     */
    async loginWithPassword(email, password) {
        await this.waitForInit();
        try {
            const authData = await this.pb.collection('users').authWithPassword(email, password);
            this.currentUser = authData.record;
            return authData.record;
        } catch (error) {
            console.error('Login failed:', error);
            throw error;
        }
    }

    /**
     * Register new user
     * @param {string} email 
     * @param {string} password 
     * @param {string} name - Optional display name
     * @returns {Object} User data
     */
    async register(email, password, name = '') {
        await this.waitForInit();
        try {
            const userData = {
                email: email,
                password: password,
                passwordConfirm: password,
                name: name
            };
            
            const createdUser = await this.pb.collection('users').create(userData);
            
            // Send verification email instead of auto-login
            await this.pb.collection('users').requestVerification(email);
            
            return {
                user: createdUser,
                emailSent: true,
                message: 'Registration successful! Please check your email to verify your account.'
            };
        } catch (error) {
            console.error('Registration failed:', error);
            throw error;
        }
    }

    /**
     * Login with Google OAuth2
     */
    async loginWithGoogle() {
        await this.waitForInit();
        try {
            const authData = await this.pb.collection('users').authWithOAuth2({ provider: 'google' });
            this.currentUser = authData.record;
            
            // Create user settings if first login
            const existingSettings = await this.getUserSettings();
            if (!existingSettings) {
                await this.createUserSettings(this.currentUser.id, {
                    dataRetentionDays: 365,
                    syncEnabled: true,
                    practiceGoals: {
                        dailyMinutes: 15,
                        weeklyAccuracy: 85
                    }
                });
            }
            
            return this.currentUser;
        } catch (error) {
            console.error('Google login failed:', error);
            throw error;
        }
    }

    /**
     * Logout current user
     */
    logout() {
        if (this.pb) {
            this.pb.authStore.clear();
            this.currentUser = null;
            
            // Clear local storage to prevent cross-account contamination
            this.clearUserLocalStorage();
        }
    }

    /**
     * Clear user-specific local storage data
     * @private
     */
    clearUserLocalStorage() {
        try {
            // Clear statistics data (practice sessions)
            localStorage.removeItem('bassTrainerStatistics');
            
            // Clear any other user-specific data that might exist
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                // Remove bass trainer related keys
                if (key && (key.startsWith('bassTrainer') || key.startsWith('bass_trainer'))) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));
            
            console.log('Local storage cleared on logout');
        } catch (error) {
            console.warn('Failed to clear local storage on logout:', error);
        }
    }

    /**
     * Check if user is authenticated
     * @returns {boolean}
     */
    isAuthenticated() {
        return this.pb && this.pb.authStore.isValid && this.currentUser !== null;
    }

    /**
     * Get current user
     * @returns {Object|null}
     */
    getCurrentUser() {
        return this.currentUser;
    }

    /**
     * Confirm email verification with token
     * @param {string} token - Verification token from email
     * @returns {boolean} Success status
     */
    async confirmVerification(token) {
        await this.waitForInit();
        try {
            await this.pb.collection('users').confirmVerification(token);
            return true;
        } catch (error) {
            console.error('Verification confirmation failed:', error);
            throw error;
        }
    }

    /**
     * Resend verification email
     * @param {string} email - User email address
     * @returns {boolean} Success status
     */
    async resendVerification(email) {
        await this.waitForInit();
        try {
            await this.pb.collection('users').requestVerification(email);
            return true;
        } catch (error) {
            console.error('Resend verification failed:', error);
            throw error;
        }
    }

    /**
     * Check if current user is verified
     * @returns {boolean}
     */
    isUserVerified() {
        return this.currentUser && this.currentUser.verified === true;
    }

    /**
     * Save practice session
     * @param {Object} sessionSummary - Complete session data from PracticeSession
     * @returns {Object} Created record
     */
    async savePracticeSession(sessionSummary) {
        if (!this.isAuthenticated()) {
            throw new Error('User not authenticated');
        }

        await this.waitForInit();
        
        try {
            // Note: Duplicate prevention is handled at the sync level
            const sessionData = {
                user: this.currentUser.id,
                session_id: sessionSummary.sessionId, // Extract sessionId as separate field
                session_data: sessionSummary,
                note_pool: sessionSummary.notePool || [],
                accuracy: sessionSummary.accuracy || 0,
                duration: sessionSummary.sessionDuration || 0,
                correct_count: sessionSummary.correct || 0,
                total_count: sessionSummary.total || 0,
                session_date: sessionSummary.date ? new Date(sessionSummary.date).toISOString() : new Date().toISOString()
            };

            const record = await this.pb.collection('practice_sessions').create(sessionData);
            console.log(`Created new session record: ${sessionSummary.sessionId}`);
            return record;
        } catch (error) {
            console.error('Failed to save practice session:', error);
            throw error;
        }
    }

    /**
     * Get all practice sessions for sync purposes (no date filtering)
     * @param {Object} options - Query options (limit only)
     * @returns {Array} All practice sessions
     */
    async getAllPracticeSessions(options = {}) {
        if (!this.isAuthenticated()) {
            return [];
        }

        await this.waitForInit();
        
        try {
            const filter = `user = "${this.currentUser.id}"`;

            const result = await this.pb.collection('practice_sessions').getList(1, 500, {
                filter: filter,
                sort: '-session_date'
            });

            return result.items.map(record => {
                const sessionData = {
                    ...record.session_data,
                    id: record.id,
                    created: record.created,
                    updated: record.updated,
                    sessionId: record.session_id // Extract sessionId from separate field
                };
                
                return sessionData;
            });
        } catch (error) {
            console.error('Failed to fetch all practice sessions:', error);
            return [];
        }
    }

    /**
     * Get practice sessions with filtering
     * @param {Object} options - Query options
     * @returns {Array} Practice sessions
     */
    async getPracticeSessions(options = {}) {
        if (!this.isAuthenticated()) {
            return [];
        }

        await this.waitForInit();
        
        try {
            let filter = `user = "${this.currentUser.id}"`;
            
            // Add date filters
            if (options.dateFrom) {
                filter += ` && created >= "${options.dateFrom}T00:00:00.000Z"`;
            }
            if (options.dateTo) {
                filter += ` && created <= "${options.dateTo}T23:59:59.999Z"`;
            }

            const result = await this.pb.collection('practice_sessions').getList(1, 200, {
                filter: filter,
                sort: '-session_date'
            });

            return result.items.map(record => {
                const sessionData = {
                    ...record.session_data,
                    id: record.id,
                    created: record.created,
                    updated: record.updated,
                    sessionId: record.session_id // Extract sessionId from separate field
                };
                
                return sessionData;
            });
        } catch (error) {
            console.error('Failed to fetch practice sessions:', error);
            return [];
        }
    }

    /**
     * Create user settings
     * @param {string} userId 
     * @param {Object} settings 
     * @returns {Object} Created record
     */
    async createUserSettings(userId, settings) {
        await this.waitForInit();
        
        try {
            const settingsData = {
                user: userId,
                settings_data: settings
            };

            const record = await this.pb.collection('user_settings').create(settingsData);
            return record;
        } catch (error) {
            console.error('Failed to create user settings:', error);
            throw error;
        }
    }

    /**
     * Get user settings
     * @returns {Object|null} Settings data
     */
    async getUserSettings() {
        if (!this.isAuthenticated()) {
            return null;
        }

        await this.waitForInit();
        
        try {
            const records = await this.pb.collection('user_settings').getFullList({
                filter: `user = "${this.currentUser.id}"`
            });

            return records.length > 0 ? records[0].settings_data : null;
        } catch (error) {
            console.error('Failed to get user settings:', error);
            return null;
        }
    }

    /**
     * Update user settings
     * @param {Object} settings - Settings to update
     * @returns {Object} Updated record
     */
    async updateUserSettings(settings) {
        if (!this.isAuthenticated()) {
            throw new Error('User not authenticated');
        }

        await this.waitForInit();
        
        try {
            const records = await this.pb.collection('user_settings').getFullList({
                filter: `user = "${this.currentUser.id}"`
            });

            if (records.length > 0) {
                const record = await this.pb.collection('user_settings').update(records[0].id, {
                    settings_data: settings
                });
                return record;
            } else {
                return await this.createUserSettings(this.currentUser.id, settings);
            }
        } catch (error) {
            console.error('Failed to update user settings:', error);
            throw error;
        }
    }

    /**
     * Check if online and connected to PocketBase
     * @returns {boolean}
     */
    async isOnline() {
        try {
            await this.waitForInit();
            const health = await this.pb.health.check();
            return health.code === 200;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get server info
     * @returns {Object} Server information
     */
    async getServerInfo() {
        try {
            await this.waitForInit();
            return await this.pb.health.check();
        } catch (error) {
            console.error('Failed to get server info:', error);
            return null;
        }
    }
}

// Create global instance
const pocketBaseClient = new PocketBaseClient();

// Export for use in other modules
export { pocketBaseClient, PocketBaseClient };