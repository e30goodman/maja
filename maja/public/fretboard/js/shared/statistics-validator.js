/**
 * Statistics Validator Module
 * Handles user validation and data consistency checks
 */
export class StatisticsValidator {
    constructor(storage) {
        this.storage = storage;
    }

    /**
     * Validate current user and clear storage if user changed
     * @param {Object} pbClient - PocketBase client instance
     * @returns {boolean} True if data is valid, false if data was cleared
     */
    validateUserAndClearIfNeeded(pbClient) {
        const data = this.storage.getData();
        if (!data) return true;

        // Check if PocketBase client is initialized before proceeding
        if (!pbClient.isInitialized) {
            console.log('StatisticsValidator: PocketBase not initialized yet, deferring user validation');
            return true; // Don't clear data during initialization
        }

        const currentUserId = pbClient.getCurrentUser()?.id || null;
        const storedUserId = data.metadata?.userId || null;

        // If we have a current user and stored user ID is different (and not null)
        if (currentUserId && storedUserId && currentUserId !== storedUserId) {
            console.log(`User changed from ${storedUserId} to ${currentUserId}, clearing local storage`);
            this.storage.clearAllData();
            return false; // Data was cleared
        }

        // If we have a current user but no stored user ID, update it
        if (currentUserId && !storedUserId) {
            data.metadata.userId = currentUserId;
            this.storage.saveData(data);
        }

        // If no current user and we're authenticated, the data belongs to someone else
        // But only clear if we're sure the auth system is fully initialized
        if (!currentUserId && storedUserId && pbClient.isInitialized) {
            // Check if we're truly not authenticated (not just during auth initialization)
            const authValid = pbClient.pb && pbClient.pb.authStore.isValid;
            if (authValid === false) {
                console.log('No current user but storage has user data, clearing local storage');
                this.storage.clearAllData();
                return false; // Data was cleared
            }
        }

        return true; // Data is valid
    }
}
