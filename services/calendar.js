const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const Config = require('./config');

class CalendarService {
    constructor() {
        this.oauth2Client = null;
        this.calendar = null;
        this.initialized = false;
    }

    /**
     * Initialize OAuth2 client with stored credentials
     */
    initialize() {
        const credentials = Config.get('calendarCredentials');
        if (!credentials) {
            console.log('[Calendar] No credentials configured');
            return false;
        }

        try {
            const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web || {};
            this.oauth2Client = new google.auth.OAuth2(
                client_id,
                client_secret,
                redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob'
            );

            // Load saved tokens
            const tokens = Config.get('calendarTokens');
            if (tokens) {
                this.oauth2Client.setCredentials(tokens);
                this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
                this.initialized = true;
                console.log('[Calendar] Initialized with saved tokens');
            }

            // Auto-refresh tokens
            this.oauth2Client.on('tokens', (tokens) => {
                const existing = Config.get('calendarTokens') || {};
                Config.set('calendarTokens', { ...existing, ...tokens });
                console.log('[Calendar] Tokens refreshed');
            });

            return true;
        } catch (err) {
            console.error('[Calendar] Initialization error:', err.message);
            return false;
        }
    }

    /**
     * Generate OAuth2 authorization URL
     */
    getAuthUrl() {
        if (!this.oauth2Client) {
            this.initialize();
        }
        if (!this.oauth2Client) {
            return null;
        }

        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/calendar'],
            prompt: 'consent',
        });
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeCode(code) {
        if (!this.oauth2Client) throw new Error('OAuth2 client not initialized');

        const { tokens } = await this.oauth2Client.getToken(code);
        this.oauth2Client.setCredentials(tokens);
        Config.set('calendarTokens', tokens);
        this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
        this.initialized = true;
        console.log('[Calendar] Successfully authenticated');
        return true;
    }

    /**
     * Create a calendar event
     */
    async createEvent(eventData) {
        if (!this.initialized) throw new Error('Calendar not connected');

        const event = {
            summary: eventData.title,
            description: eventData.description || '',
            location: eventData.location || '',
            start: {
                dateTime: eventData.startTime,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            end: {
                dateTime: eventData.endTime,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            reminders: {
                useDefault: true,
            },
        };

        const result = await this.calendar.events.insert({
            calendarId: 'primary',
            resource: event,
        });

        console.log(`[Calendar] Event created: ${result.data.htmlLink}`);
        return {
            id: result.data.id,
            title: result.data.summary,
            link: result.data.htmlLink,
            start: result.data.start.dateTime,
            end: result.data.end.dateTime,
        };
    }

    /**
     * List upcoming events
     */
    async listEvents(maxResults = 10) {
        if (!this.initialized) throw new Error('Calendar not connected');

        const result = await this.calendar.events.list({
            calendarId: 'primary',
            timeMin: new Date().toISOString(),
            maxResults,
            singleEvents: true,
            orderBy: 'startTime',
        });

        return (result.data.items || []).map(event => ({
            id: event.id,
            title: event.summary,
            description: event.description,
            start: event.start.dateTime || event.start.date,
            end: event.end.dateTime || event.end.date,
            location: event.location,
            link: event.htmlLink,
        }));
    }

    /**
     * Delete a calendar event
     */
    async deleteEvent(eventId) {
        if (!this.initialized) throw new Error('Calendar not connected');

        await this.calendar.events.delete({
            calendarId: 'primary',
            eventId,
        });
        console.log(`[Calendar] Event deleted: ${eventId}`);
        return true;
    }

    /**
     * Check if calendar is connected
     */
    isConnected() {
        return this.initialized;
    }

    /**
     * Set credentials from JSON file content
     */
    setCredentials(credentialsJson) {
        try {
            const creds = typeof credentialsJson === 'string' ? JSON.parse(credentialsJson) : credentialsJson;
            Config.set('calendarCredentials', creds);
            this.initialize();
            return true;
        } catch (err) {
            console.error('[Calendar] Invalid credentials:', err.message);
            return false;
        }
    }
}

module.exports = CalendarService;
