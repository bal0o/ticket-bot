const { createDB } = require('./mysql');
const db = createDB();

const APPLICATIONS_KEY = 'Applications';
const SCHEDULES_KEY = 'ApplicationSchedules';

async function generateApplicationId(userId) {
    const ts = Date.now();
    const rnd = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `${userId}-${ts}-${rnd}`;
}

// Helper: Get database connection
function getPool() {
    // Access the pool from the MySQL adapter instance
    if (!db || !db.pool) {
        throw new Error('Database pool not available');
    }
    return db.pool;
}

// Helper: Load full application record with related data
async function loadApplication(appId) {
    const conn = await getPool().getConnection();
    try {
        // Get main application record
        const [appRows] = await conn.query(
            'SELECT * FROM applications WHERE id = ?',
            [appId]
        );
        
        if (appRows.length === 0) return null;
        
        const app = appRows[0];
        
        // Get related tickets
        const [ticketRows] = await conn.query(
            'SELECT ticket_id as ticketId, channel_id as channelId, link_type as type, created_at as createdAt ' +
            'FROM application_tickets WHERE application_id = ? ORDER BY created_at ASC',
            [appId]
        );
        
        // Get history
        const [historyRows] = await conn.query(
            'SELECT stage, changed_at as `at`, changed_by as `by`, note ' +
            'FROM application_history WHERE application_id = ? ORDER BY changed_at ASC',
            [appId]
        );
        
        // Get comments
        const [commentRows] = await conn.query(
            'SELECT created_by as `by`, created_at as `at`, comment ' +
            'FROM application_comments WHERE application_id = ? ORDER BY created_at ASC',
            [appId]
        );
        
        // Reconstruct application object to match old format
        return {
            id: app.id,
            userId: app.user_id,
            username: app.username,
            type: app.type,
            server: app.server,
            stage: app.stage,
            createdAt: app.created_at,
            updatedAt: app.updated_at,
            responses: app.responses || '',
            tickets: ticketRows.map(t => ({
                ticketId: t.ticketId,
                channelId: t.channelId,
                createdAt: t.createdAt,
                type: t.type
            })),
            history: historyRows.map(h => ({
                stage: h.stage,
                at: h.at,
                by: h.by,
                note: h.note || ''
            })),
            comments: commentRows.map(c => ({
                by: c.by,
                at: c.at,
                comment: c.comment
            }))
        };
    } finally {
        conn.release();
    }
}

// Helper: Save application record with related data
async function saveApplication(rec) {
    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();
        
        // Update or insert main application record
        await conn.query(
            'INSERT INTO applications (id, user_id, username, type, server, stage, created_at, updated_at, responses) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE ' +
            '  username = VALUES(username), ' +
            '  type = VALUES(type), ' +
            '  server = VALUES(server), ' +
            '  stage = VALUES(stage), ' +
            '  updated_at = VALUES(updated_at), ' +
            '  responses = VALUES(responses)',
            [
                rec.id,
                rec.userId,
                rec.username,
                rec.type,
                rec.server,
                rec.stage,
                rec.createdAt,
                rec.updatedAt,
                rec.responses || ''
            ]
        );
        
        // Save tickets (clear and reinsert)
        await conn.query('DELETE FROM application_tickets WHERE application_id = ?', [rec.id]);
        if (rec.tickets && Array.isArray(rec.tickets)) {
            for (const ticket of rec.tickets) {
                await conn.query(
                    'INSERT INTO application_tickets (application_id, ticket_id, channel_id, link_type, created_at) ' +
                    'VALUES (?, ?, ?, ?, ?)',
                    [
                        rec.id,
                        ticket.ticketId || null,
                        ticket.channelId || null,
                        ticket.type || 'comms',
                        ticket.createdAt || Date.now()
                    ]
                );
            }
        }
        
        // Save history (append new entries only to avoid duplicates)
        if (rec.history && Array.isArray(rec.history)) {
            // Check what we already have
            const [existingHistory] = await conn.query(
                'SELECT changed_at, stage FROM application_history WHERE application_id = ? ORDER BY changed_at DESC LIMIT 1',
                [rec.id]
            );
            
            // Only insert new history entries
            for (const hist of rec.history) {
                const exists = existingHistory.length > 0 && 
                               existingHistory[0].changed_at === hist.at && 
                               existingHistory[0].stage === hist.stage;
                
                if (!exists) {
                    await conn.query(
                        'INSERT INTO application_history (application_id, stage, changed_at, changed_by, note) ' +
                        'VALUES (?, ?, ?, ?, ?)',
                        [
                            rec.id,
                            hist.stage,
                            hist.at,
                            hist.by || null,
                            hist.note || ''
                        ]
                    );
                }
            }
        }
        
        // Save comments (append new entries only)
        if (rec.comments && Array.isArray(rec.comments)) {
            // Check what we already have
            const [existingComments] = await conn.query(
                'SELECT created_at, created_by FROM application_comments WHERE application_id = ? ORDER BY created_at DESC',
                [rec.id]
            );
            const existingSet = new Set(
                existingComments.map(c => `${c.created_at}:${c.created_by}`)
            );
            
            // Only insert new comments
            for (const comment of rec.comments) {
                const key = `${comment.at}:${comment.by}`;
                if (!existingSet.has(key)) {
                    await conn.query(
                        'INSERT INTO application_comments (application_id, created_by, created_at, comment) ' +
                        'VALUES (?, ?, ?, ?)',
                        [
                            rec.id,
                            comment.by || null,
                            comment.at,
                            comment.comment || ''
                        ]
                    );
                }
            }
        }
        
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
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
        await saveApplication(record);
        return record;
    },

    async advanceStage(appId, nextStage, byStaffId, note) {
        const rec = await loadApplication(appId);
        if (!rec) return null;
        rec.stage = nextStage;
        rec.updatedAt = Date.now();
        rec.history = rec.history || [];
        rec.history.push({ stage: nextStage, at: rec.updatedAt, by: byStaffId || null, note: note || '' });
        await saveApplication(rec);
        return rec;
    },

    async deny(appId, byStaffId, note) {
        return module.exports.advanceStage(appId, 'Denied', byStaffId, note || 'Denied');
    },

    async addComment(appId, byStaffId, comment) {
        const rec = await loadApplication(appId);
        if (!rec) return null;
        rec.comments = rec.comments || [];
        rec.comments.push({ by: byStaffId, at: Date.now(), comment });
        await saveApplication(rec);
        return rec;
    },

    async linkTicket(appId, ticketId, channelId, linkType = 'comms') {
        const rec = await loadApplication(appId);
        if (!rec) return null;
        rec.tickets = rec.tickets || [];
        rec.tickets.push({ ticketId, channelId, createdAt: Date.now(), type: linkType });
        await saveApplication(rec);
        return rec;
    },

    async listApplications({ stage, userId } = {}) {
        const conn = await getPool().getConnection();
        try {
            let sql = 'SELECT * FROM applications WHERE 1=1';
            const params = [];
            
            if (stage) {
                sql += ' AND stage = ?';
                params.push(stage);
            }
            
            if (userId) {
                sql += ' AND user_id = ?';
                params.push(userId);
            }
            
            sql += ' ORDER BY updated_at DESC';
            
            const [rows] = await conn.query(sql, params);
            
            // Load full records with related data
            const apps = [];
            for (const row of rows) {
                const app = await loadApplication(row.id);
                if (app) apps.push(app);
            }
            
            return apps;
        } finally {
            conn.release();
        }
    },

    async getApplication(appId) {
        return await loadApplication(appId);
    },

    async scheduleInterview({ appId, atTs, staffId, mode = 'voice' }) {
        // Schedule record processed by bot loop
        const jobId = `${appId}-${atTs}`;
        const job = { id: jobId, appId, at: atTs, staffId, mode, createdAt: Date.now(), status: 'scheduled' };
        
        const conn = await getPool().getConnection();
        try {
            await conn.query(
                'INSERT INTO application_schedules (id, application_id, scheduled_at, staff_id, mode, status, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE status = VALUES(status)',
                [jobId, appId, atTs, staffId, mode, 'scheduled', job.createdAt]
            );
        } finally {
            conn.release();
        }
        
        return job;
    },

    async listSchedules() {
        const conn = await getPool().getConnection();
        try {
            const [rows] = await conn.query(
                'SELECT * FROM application_schedules ORDER BY scheduled_at DESC'
            );
            
            // Convert to object format for backwards compatibility
            const schedules = {};
            for (const row of rows) {
                schedules[row.id] = {
                    id: row.id,
                    appId: row.application_id,
                    at: row.scheduled_at,
                    staffId: row.staff_id,
                    mode: row.mode,
                    status: row.status,
                    createdAt: row.created_at,
                    completedAt: row.completed_at,
                    info: row.info ? (typeof row.info === 'string' ? JSON.parse(row.info) : row.info) : {}
                };
            }
            
            return schedules;
        } finally {
            conn.release();
        }
    },

    async completeSchedule(jobId, status = 'done', info = {}) {
        const conn = await getPool().getConnection();
        try {
            await conn.query(
                'UPDATE application_schedules SET status = ?, completed_at = ?, info = ? WHERE id = ?',
                [status, Date.now(), JSON.stringify(info), jobId]
            );
            
            const [rows] = await conn.query('SELECT * FROM application_schedules WHERE id = ?', [jobId]);
            if (rows.length === 0) return null;
            
            const row = rows[0];
            return {
                id: row.id,
                appId: row.application_id,
                at: row.scheduled_at,
                staffId: row.staff_id,
                mode: row.mode,
                status: row.status,
                createdAt: row.created_at,
                completedAt: row.completed_at,
                info: row.info ? (typeof row.info === 'string' ? JSON.parse(row.info) : row.info) : {}
            };
        } finally {
            conn.release();
        }
    },

    async deleteSchedule(jobId) {
        const conn = await getPool().getConnection();
        try {
            const [rows] = await conn.query('SELECT * FROM application_schedules WHERE id = ?', [jobId]);
            if (rows.length === 0) return null;
            
            await conn.query('DELETE FROM application_schedules WHERE id = ?', [jobId]);
            
            const row = rows[0];
            return {
                id: row.id,
                appId: row.application_id,
                at: row.scheduled_at,
                staffId: row.staff_id,
                mode: row.mode,
                status: row.status,
                createdAt: row.created_at,
                completedAt: row.completed_at,
                info: row.info ? (typeof row.info === 'string' ? JSON.parse(row.info) : row.info) : {}
            };
        } finally {
            conn.release();
        }
    },

    async cleanupOrphanedTickets(appId) {
        const rec = await loadApplication(appId);
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
        await saveApplication(rec);
        return rec;
    }
};
