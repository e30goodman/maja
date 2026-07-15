/**
 * Statistics Calculator Module
 * Handles statistical analysis and aggregation of practice session data
 */
export class StatisticsCalculator {
    /**
     * Get aggregated statistics for sessions
     * @param {Array<Object>} sessions - Array of session objects
     * @param {string} period - Period identifier
     * @returns {Object} Aggregated statistics
     */
    calculateStatistics(sessions, period = 'all') {
        if (sessions.length === 0) {
            return this.getEmptyStatistics();
        }

        const stats = {
            period: period,
            sessionCount: sessions.length,
            totalAttempts: 0,
            totalCorrect: 0,
            totalIncorrect: 0,
            totalPracticeTime: 0,
            averageAccuracy: 0,
            averageResponseTime: 0,
            bestAccuracy: 0,
            worstAccuracy: 100,
            improvementTrend: 0,
            notePoolStats: {},
            dailyStats: {},
            weeklyTrend: []
        };

        // Process each session
        sessions.forEach(session => {
            stats.totalAttempts += session.total || 0;
            stats.totalCorrect += session.correct || 0;
            stats.totalIncorrect += session.incorrect || 0;
            stats.totalPracticeTime += session.sessionDuration || 0;

            // Track best/worst accuracy
            if (session.accuracy > stats.bestAccuracy) {
                stats.bestAccuracy = session.accuracy;
            }
            if (session.accuracy < stats.worstAccuracy) {
                stats.worstAccuracy = session.accuracy;
            }

            // Aggregate note pool statistics
            if (session.notePool) {
                session.notePool.forEach(note => {
                    if (!stats.notePoolStats[note]) {
                        stats.notePoolStats[note] = { sessions: 0, totalCorrect: 0, totalAttempts: 0 };
                    }
                    stats.notePoolStats[note].sessions++;
                });
            }

            // Daily statistics
            const dateKey = session.date;
            if (!stats.dailyStats[dateKey]) {
                stats.dailyStats[dateKey] = {
                    sessions: 0,
                    totalTime: 0,
                    totalAttempts: 0,
                    totalCorrect: 0
                };
            }
            stats.dailyStats[dateKey].sessions++;
            stats.dailyStats[dateKey].totalTime += session.sessionDuration || 0;
            stats.dailyStats[dateKey].totalAttempts += session.total || 0;
            stats.dailyStats[dateKey].totalCorrect += session.correct || 0;
        });

        // Calculate averages
        if (stats.totalAttempts > 0) {
            stats.averageAccuracy = Math.round((stats.totalCorrect / stats.totalAttempts) * 100);
        }

        if (sessions.length > 0) {
            const validResponseTimes = sessions
                .filter(s => s.averageResponseTime > 0)
                .map(s => s.averageResponseTime);

            if (validResponseTimes.length > 0) {
                stats.averageResponseTime = Math.round(
                    validResponseTimes.reduce((sum, time) => sum + time, 0) / validResponseTimes.length
                );
            }
        }

        // Calculate improvement trend
        stats.improvementTrend = this.calculateImprovementTrend(sessions);

        // Generate weekly trend data
        stats.weeklyTrend = this.generateWeeklyTrend(stats.dailyStats);

        return stats;
    }

    /**
     * Calculate improvement trend compared to previous period
     * @param {Array<Object>} sessions - Current period sessions
     * @returns {number} Improvement percentage
     */
    calculateImprovementTrend(sessions) {
        if (sessions.length < 2) return 0;

        const midpoint = Math.floor(sessions.length / 2);
        const recentSessions = sessions.slice(0, midpoint);
        const olderSessions = sessions.slice(midpoint);

        const recentAvg = this.calculateAverageAccuracy(recentSessions);
        const olderAvg = this.calculateAverageAccuracy(olderSessions);

        if (olderAvg === 0) return 0;

        return Math.round(((recentAvg - olderAvg) / olderAvg) * 100);
    }

    /**
     * Calculate average accuracy for a set of sessions
     * @param {Array<Object>} sessions - Array of sessions
     * @returns {number} Average accuracy percentage
     */
    calculateAverageAccuracy(sessions) {
        if (sessions.length === 0) return 0;

        const totalCorrect = sessions.reduce((sum, s) => sum + (s.correct || 0), 0);
        const totalAttempts = sessions.reduce((sum, s) => sum + (s.total || 0), 0);

        return totalAttempts > 0 ? (totalCorrect / totalAttempts) * 100 : 0;
    }

    /**
     * Generate weekly trend data from daily statistics
     * @param {Object} dailyStats - Daily statistics object
     * @returns {Array<Object>} Weekly trend data
     */
    generateWeeklyTrend(dailyStats) {
        const trend = [];
        const sortedDates = Object.keys(dailyStats).sort();

        for (const date of sortedDates) {
            const dayStats = dailyStats[date];
            const accuracy = dayStats.totalAttempts > 0 ?
                Math.round((dayStats.totalCorrect / dayStats.totalAttempts) * 100) : 0;

            trend.push({
                date: date,
                sessions: dayStats.sessions,
                accuracy: accuracy,
                practiceTime: dayStats.totalTime
            });
        }

        return trend;
    }

    /**
     * Get empty statistics structure
     * @returns {Object} Empty statistics object
     */
    getEmptyStatistics() {
        return {
            period: 'none',
            sessionCount: 0,
            totalAttempts: 0,
            totalCorrect: 0,
            totalIncorrect: 0,
            totalPracticeTime: 0,
            averageAccuracy: 0,
            averageResponseTime: 0,
            bestAccuracy: 0,
            worstAccuracy: 0,
            improvementTrend: 0,
            notePoolStats: {},
            dailyStats: {},
            weeklyTrend: []
        };
    }
}
