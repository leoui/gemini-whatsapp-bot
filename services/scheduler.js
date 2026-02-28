/**
 * Scheduler Service — handles timed reminders and scheduled messages.
 * Stores tasks in electron-store and checks every 60 seconds for due tasks.
 */
const Config = require('./config');

class Scheduler {
    constructor() {
        this.intervalId = null;
        this.whatsapp = null;
        this.onTaskDue = null; // callback when a task fires
    }

    /**
     * Start the scheduler. Checks every 60 seconds for due tasks.
     * @param {WhatsAppService} whatsapp — reference to send messages
     * @param {Function} onTaskDue — callback(task) when a reminder fires
     */
    start(whatsapp, onTaskDue) {
        this.whatsapp = whatsapp;
        this.onTaskDue = onTaskDue;

        // Check every 60 seconds
        this.intervalId = setInterval(() => this.checkDueTasks(), 60 * 1000);
        console.log('[Scheduler] Started — checking every 60s');

        // Also check immediately on start (catch any missed reminders)
        this.checkDueTasks();
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        console.log('[Scheduler] Stopped');
    }

    /**
     * Add a scheduled task.
     * @param {object} task - { targetJid, message, dueAt (ISO string), createdBy, type }
     */
    addTask(task) {
        const tasks = this.getTasks();
        const newTask = {
            id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            targetJid: task.targetJid,
            message: task.message,
            dueAt: task.dueAt, // ISO string or timestamp
            createdBy: task.createdBy || 'unknown',
            createdAt: new Date().toISOString(),
            type: task.type || 'reminder', // 'reminder' | 'message'
            status: 'pending',
        };
        tasks.push(newTask);
        Config.set('scheduledTasks', tasks);
        console.log(`[Scheduler] Added task ${newTask.id}: "${newTask.message}" due at ${newTask.dueAt}`);
        return newTask;
    }

    /**
     * Get all scheduled tasks
     */
    getTasks() {
        return Config.get('scheduledTasks') || [];
    }

    /**
     * Get pending tasks only
     */
    getPendingTasks() {
        return this.getTasks().filter(t => t.status === 'pending');
    }

    /**
     * Remove a task by ID
     */
    removeTask(taskId) {
        const tasks = this.getTasks().filter(t => t.id !== taskId);
        Config.set('scheduledTasks', tasks);
    }

    /**
     * Clear all tasks
     */
    clearAll() {
        Config.set('scheduledTasks', []);
        console.log('[Scheduler] All tasks cleared');
    }

    /**
     * Check for due tasks and execute them
     */
    async checkDueTasks() {
        const tasks = this.getTasks();
        const now = Date.now();
        let updated = false;

        for (const task of tasks) {
            if (task.status !== 'pending') continue;

            const dueTime = new Date(task.dueAt).getTime();
            if (isNaN(dueTime)) {
                console.error(`[Scheduler] Invalid due time for task ${task.id}: ${task.dueAt}`);
                task.status = 'error';
                updated = true;
                continue;
            }

            // Task is due (within 90 second window to avoid missing by a few seconds)
            if (dueTime <= now + 30000) {
                console.log(`[Scheduler] Task ${task.id} is due! Sending message to ${task.targetJid}`);
                try {
                    if (this.whatsapp && this.whatsapp.connectionState === 'connected') {
                        await this.whatsapp.sendMessage(task.targetJid, task.message);
                        task.status = 'sent';
                        task.sentAt = new Date().toISOString();
                        console.log(`[Scheduler] ✅ Sent reminder to ${task.targetJid}: "${task.message.substring(0, 50)}..."`);

                        // Notify via callback
                        if (this.onTaskDue) {
                            this.onTaskDue(task);
                        }
                    } else {
                        console.log(`[Scheduler] WhatsApp not connected, skipping task ${task.id}`);
                    }
                } catch (err) {
                    console.error(`[Scheduler] Failed to send task ${task.id}:`, err.message);
                    task.status = 'error';
                    task.error = err.message;
                }
                updated = true;
            }
        }

        if (updated) {
            Config.set('scheduledTasks', tasks);
        }
    }

    /**
     * Parse a natural language time string into a Date object.
     * Handles: "7 AM", "14:30", "in 5 minutes", "tomorrow 9 AM", etc.
     * @param {string} timeStr
     * @returns {Date|null}
     */
    parseTime(timeStr) {
        const now = new Date();
        const lower = timeStr.toLowerCase().trim();

        // "in X minutes/hours"
        const relativeMatch = lower.match(/in\s+(\d+)\s+(minute|minutes|menit|hour|hours|jam|second|seconds|detik)/);
        if (relativeMatch) {
            const amount = parseInt(relativeMatch[1]);
            const unit = relativeMatch[2];
            const ms = unit.startsWith('hour') || unit === 'jam' ? amount * 3600000 :
                unit.startsWith('minute') || unit === 'menit' ? amount * 60000 :
                    amount * 1000;
            return new Date(now.getTime() + ms);
        }

        // "at HH:MM" or "HH:MM" or "H AM/PM"
        const timeMatch = lower.match(/(?:at\s+|pukul\s+|jam\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|pagi|siang|sore|malam)?/i);
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            const minutes = parseInt(timeMatch[2] || '0');
            const period = timeMatch[3]?.toLowerCase();

            if (period === 'pm' || period === 'sore' || period === 'malam') {
                if (hours < 12) hours += 12;
            } else if (period === 'am' || period === 'pagi') {
                if (hours === 12) hours = 0;
            }

            const target = new Date(now);
            target.setHours(hours, minutes, 0, 0);

            // If the time is in the past, schedule for tomorrow
            if (target <= now) {
                target.setDate(target.getDate() + 1);
            }

            // Check for "tomorrow" / "besok"
            if (lower.includes('tomorrow') || lower.includes('besok')) {
                const tomorrow = new Date(now);
                tomorrow.setDate(tomorrow.getDate() + 1);
                target.setFullYear(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
            }

            return target;
        }

        return null;
    }
}

module.exports = new Scheduler();
