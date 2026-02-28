const Config = require('./config');

class HumanBehavior {
    constructor() {
        this.messageTimestamps = []; // Track message send times for rate limiting
    }

    /**
     * Calculate a natural reading delay based on message length
     */
    getReadDelay(messageText) {
        const behavior = Config.getBehavior();
        if (!behavior.enabled) return 0;

        // Average reading speed: ~250 words per minute
        const wordCount = (messageText || '').split(/\s+/).length;
        const readTimeMs = (wordCount / 250) * 60 * 1000;

        // Clamp between min and max
        let delay = Math.max(behavior.minReadDelay, Math.min(readTimeMs, behavior.maxReadDelay));

        // Add randomness
        delay = this.addVariance(delay, behavior.randomVariance);

        return Math.round(delay);
    }

    /**
     * Calculate typing delay based on response length
     */
    getTypingDelay(responseText) {
        const behavior = Config.getBehavior();
        if (!behavior.enabled) return 0;

        const wordCount = (responseText || '').split(/\s+/).length;
        const typingTimeMs = (wordCount / behavior.typingSpeedWPM) * 60 * 1000;

        // Cap at 15 seconds max typing indicator
        let delay = Math.min(typingTimeMs, 15000);

        // Add randomness
        delay = this.addVariance(delay, behavior.randomVariance);

        // Minimum 500ms typing indicator
        return Math.round(Math.max(500, delay));
    }

    /**
     * Add random variance to a delay value
     */
    addVariance(value, variance) {
        const factor = 1 + (Math.random() * 2 - 1) * variance;
        return value * factor;
    }

    /**
     * Check if we can send a message (rate limiting)
     */
    canSendMessage() {
        const behavior = Config.getBehavior();
        if (!behavior.enabled) return { allowed: true };

        const now = Date.now();

        // Clean old timestamps
        this.messageTimestamps = this.messageTimestamps.filter(t => now - t < 3600000);

        // Check messages per minute
        const lastMinute = this.messageTimestamps.filter(t => now - t < 60000);
        if (lastMinute.length >= behavior.maxMessagesPerMinute) {
            return {
                allowed: false,
                reason: 'Rate limit: too many messages per minute',
                retryAfterMs: 60000 - (now - lastMinute[0]),
            };
        }

        // Check messages per hour
        if (this.messageTimestamps.length >= behavior.maxMessagesPerHour) {
            return {
                allowed: false,
                reason: 'Rate limit: too many messages per hour',
                retryAfterMs: 3600000 - (now - this.messageTimestamps[0]),
            };
        }

        return { allowed: true };
    }

    /**
     * Record that a message was sent
     */
    recordMessageSent() {
        this.messageTimestamps.push(Date.now());
    }

    /**
     * Check if current time is within active hours
     */
    isWithinActiveHours() {
        const behavior = Config.getBehavior();
        if (!behavior.activeHoursEnabled) return true;

        const now = new Date();
        const currentHour = now.getHours();

        if (behavior.activeHoursStart <= behavior.activeHoursEnd) {
            return currentHour >= behavior.activeHoursStart && currentHour < behavior.activeHoursEnd;
        } else {
            // Wraps past midnight (e.g., 22 to 6)
            return currentHour >= behavior.activeHoursStart || currentHour < behavior.activeHoursEnd;
        }
    }

    /**
     * Full delay pipeline: read → pause → type → send
     * Returns { readDelay, typingDelay, totalDelay }
     */
    async calculateDelays(incomingMessage, responseText) {
        const readDelay = this.getReadDelay(incomingMessage);
        const typingDelay = this.getTypingDelay(responseText);

        // Add a small random "thinking" pause between reading and typing (0.5-2s)
        const thinkingPause = Math.round(500 + Math.random() * 1500);

        return {
            readDelay,
            thinkingPause,
            typingDelay,
            totalDelay: readDelay + thinkingPause + typingDelay,
        };
    }

    /**
     * Sleep helper
     */
    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = HumanBehavior;
