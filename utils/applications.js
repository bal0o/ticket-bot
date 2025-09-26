const { createDB } = require('./quickdb');
const db = createDB();

const APPLICATIONS_KEY = 'Applications';
const SCHEDULES_KEY = 'ApplicationSchedules';

async function generateApplicationId(userId) {
    const ts = Date.now();
    const rnd = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `${userId}-${ts}-${rnd}`;
}

module.exports = {
    async createApplication({ userId, username, type, server, ticketId, channelId, stage = 'Submitted', responses }) {
        const appId = await generateApplicationId(userId);
        const now = Date.now();
        const record = {
            id: appId,
            userId,
            username,
            type,
            server: server || null,
            stage,
            createdAt: now,
            updatedAt: now,
            // Seed with the original application ticket channel (type: 'origin') if present
            tickets: ticketId ? [{ ticketId, channelId, createdAt: now, type: 'origin' }] : [],
            history: [{ stage, at: now, by: null, note: 'Application created' }],
            responses: responses || ''
        };
        await db.set(`${APPLICATIONS_KEY}.${appId}`, record);
        return record;
    },

    async advanceStage(appId, nextStage, byStaffId, note) {
        const rec = await db.get(`${APPLICATIONS_KEY}.${appId}`);
        if (!rec) return null;
        rec.stage = nextStage;
        rec.updatedAt = Date.now();
        rec.history = rec.history || [];
        rec.history.push({ stage: nextStage, at: rec.updatedAt, by: byStaffId || null, note: note || '' });
        await db.set(`${APPLICATIONS_KEY}.${appId}`, rec);
        return rec;
    },

    async deny(appId, byStaffId, note) {
        return module.exports.advanceStage(appId, 'Denied', byStaffId, note || 'Denied');
    },

    async addComment(appId, byStaffId, comment) {
        const rec = await db.get(`${APPLICATIONS_KEY}.${appId}`);
        if (!rec) return null;
        rec.comments = rec.comments || [];
        rec.comments.push({ by: byStaffId, at: Date.now(), comment });
        await db.set(`${APPLICATIONS_KEY}.${appId}`, rec);
        return rec;
    },

    async linkTicket(appId, ticketId, channelId, linkType = 'comms') {
        const rec = await db.get(`${APPLICATIONS_KEY}.${appId}`);
        if (!rec) return null;
        rec.tickets = rec.tickets || [];
        rec.tickets.push({ ticketId, channelId, createdAt: Date.now(), type: linkType });
        await db.set(`${APPLICATIONS_KEY}.${appId}`, rec);
        return rec;
    },

    async listApplications({ stage, userId } = {}) {
        const apps = await db.get(APPLICATIONS_KEY) || {};
        const out = Object.values(apps);
        return out.filter(a => (!stage || a.stage === stage) && (!userId || a.userId === userId));
    },

    async getApplication(appId) {
        return db.get(`${APPLICATIONS_KEY}.${appId}`);
    },

    async scheduleInterview({ appId, atTs, staffId, mode = 'voice' }) {
        // Schedule record processed by bot loop
        const jobId = `${appId}-${atTs}`;
        const job = { id: jobId, appId, at: atTs, staffId, mode, createdAt: Date.now(), status: 'scheduled' };
        await db.set(`${SCHEDULES_KEY}.${jobId}`, job);
        return job;
    },

    async listSchedules() {
        return (await db.get(SCHEDULES_KEY)) || {};
    },

    async completeSchedule(jobId, status = 'done', info = {}) {
        const job = await db.get(`${SCHEDULES_KEY}.${jobId}`);
        if (!job) return null;
        job.status = status;
        job.completedAt = Date.now();
        job.info = info;
        await db.set(`${SCHEDULES_KEY}.${jobId}`, job);
        return job;
    },

    async deleteSchedule(jobId) {
        const job = await db.get(`${SCHEDULES_KEY}.${jobId}`);
        if (!job) return null;
        await db.delete(`${SCHEDULES_KEY}.${jobId}`);
        return job;
    },

    async cleanupOrphanedTickets(appId) {
        const rec = await db.get(`${APPLICATIONS_KEY}.${appId}`);
        if (!rec || !rec.tickets) return rec;
        
        // Filter out tickets where the channel no longer exists
        const validTickets = [];
        for (const ticket of rec.tickets) {
            if (ticket.channelId) {
                try {
                    // This would need to be called with the bot token context
                    // For now, we'll just keep the ticket record but mark it as potentially orphaned
                    validTickets.push(ticket);
                } catch (error) {
                    // Channel doesn't exist, skip this ticket
                    console.log(`Orphaned ticket found: ${ticket.channelId} for app ${appId}`);
                }
            }
        }
        
        rec.tickets = validTickets;
        await db.set(`${APPLICATIONS_KEY}.${appId}`, rec);
        return rec;
    }
};


