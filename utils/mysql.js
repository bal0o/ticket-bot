const mysql = require('mysql2/promise');
let config = null;

try {
    config = require('../config/config.json');
} catch (e) {
    console.warn('[mysql] Config not found, using defaults');
    config = {};
}

// Maintain a singleton connection pool
let __pool = null;
let __adapter = null;

function createDB() {
    const dbConfig = config.database || {};
    
    // Check if MySQL is enabled
    if (dbConfig.type === 'mysql' || dbConfig.host) {
        if (!__pool) {
            __pool = mysql.createPool({
                host: dbConfig.host || 'localhost',
                port: dbConfig.port || 3306,
                user: dbConfig.user || 'root',
                password: dbConfig.password || '',
                database: dbConfig.database || 'ticketbot',
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
                enableKeepAlive: true,
                keepAliveInitialDelay: 0
            });
            
            __adapter = new MySQLAdapter(__pool);
        }
        return __adapter;
    }
    
    // Fallback to quick.db if MySQL not configured
    const { createDB: createQuickDB } = require('./quickdb');
    return createQuickDB();
}

// Compatibility layer that mimics quick.db interface
class MySQLAdapter {
    constructor(pool) {
        this.pool = pool;
    }
    
    async get(key) {
        const conn = await this.pool.getConnection();
        try {
            const [rows] = await conn.query(
                'SELECT value FROM kv_store WHERE `key` = ?',
                [key]
            );
            
            if (rows.length === 0) return null;
            const value = rows[0].value;
            
            // Parse JSON if it's a string
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        } finally {
            conn.release();
        }
    }
    
    async set(key, value) {
        const conn = await this.pool.getConnection();
        try {
            const jsonValue = typeof value === 'object' ? JSON.stringify(value) : value;
            
            await conn.query(
                'INSERT INTO kv_store (`key`, value, updated_at) VALUES (?, ?, NOW()) ' +
                'ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
                [key, jsonValue, jsonValue]
            );
        } finally {
            conn.release();
        }
    }
    
    async delete(key) {
        const conn = await this.pool.getConnection();
        try {
            await conn.query('DELETE FROM kv_store WHERE `key` = ?', [key]);
        } finally {
            conn.release();
        }
    }
    
    async all() {
        const conn = await this.pool.getConnection();
        try {
            const [rows] = await conn.query('SELECT `key`, value FROM kv_store');
            return rows.map(row => ({
                ID: row.key,
                key: row.key,
                value: (() => {
                    try {
                        return JSON.parse(row.value);
                    } catch {
                        return row.value;
                    }
                })()
            }));
        } finally {
            conn.release();
        }
    }
    
    // Direct MySQL methods for efficient queries
    async query(sql, params = []) {
        const conn = await this.pool.getConnection();
        try {
            return await conn.query(sql, params);
        } finally {
            conn.release();
        }
    }
    
    async getConnection() {
        return await this.pool.getConnection();
    }
    
    // Write ticket to tickets table (for MySQL mode)
    async writeTicket(ticketData) {
        const conn = await this.pool.getConnection();
        try {
            await conn.query(`
                INSERT INTO tickets (
                    user_id, ticket_id, ticket_type, server, username, steam_id,
                    responses, created_at, close_time, close_type, close_user,
                    close_user_id, close_reason, transcript_url, global_ticket_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    ticket_type = VALUES(ticket_type),
                    server = VALUES(server),
                    username = VALUES(username),
                    close_time = VALUES(close_time),
                    close_type = VALUES(close_type),
                    close_user = VALUES(close_user),
                    close_user_id = VALUES(close_user_id),
                    close_reason = VALUES(close_reason),
                    transcript_url = VALUES(transcript_url)
            `, [
                ticketData.userId || ticketData.user_id,
                ticketData.ticketId || ticketData.ticket_id,
                ticketData.ticketType || ticketData.ticket_type || null,
                ticketData.server || null,
                ticketData.username || null,
                ticketData.steamId || ticketData.steam_id || null,
                ticketData.responses || null,
                ticketData.createdAt || ticketData.created_at || null,
                ticketData.closeTime || ticketData.close_time || null,
                ticketData.closeType || ticketData.close_type || null,
                ticketData.closeUser || ticketData.close_user || null,
                ticketData.closeUserID || ticketData.close_user_id || null,
                ticketData.closeReason || ticketData.close_reason || null,
                ticketData.transcriptURL || ticketData.transcript_url || null,
                ticketData.globalTicketNumber || ticketData.global_ticket_number || null
            ]);
            
            // Also update transcript index
            if (ticketData.transcriptURL || ticketData.transcriptFilename) {
                const filename = ticketData.transcriptFilename || (ticketData.transcriptURL ? ticketData.transcriptURL.split('/').pop() : null);
                if (filename) {
                    const baseFilename = filename.replace(/\.full\.html$/i, '.html');
                    await conn.query(`
                        INSERT INTO transcript_index (filename, user_id, ticket_id, ticket_type)
                        VALUES (?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE ticket_type = VALUES(ticket_type)
                    `, [
                        baseFilename,
                        ticketData.userId || ticketData.user_id,
                        ticketData.ticketId || ticketData.ticket_id,
                        ticketData.ticketType || ticketData.ticket_type || null
                    ]);
                    
                    // Also store .full.html variant
                    if (!filename.endsWith('.full.html')) {
                        const fullFilename = filename.replace(/\.html$/i, '.full.html');
                        await conn.query(`
                            INSERT INTO transcript_index (filename, user_id, ticket_id, ticket_type)
                            VALUES (?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE ticket_type = VALUES(ticket_type)
                        `, [fullFilename, ticketData.userId || ticketData.user_id, ticketData.ticketId || ticketData.ticket_id, ticketData.ticketType || ticketData.ticket_type || null]);
                    }
                }
            }
        } finally {
            conn.release();
        }
    }
    
    // Efficient ticket search using SQL
    async searchTickets({ ticketId, userId, ticketType, server, closedBy, fromDate, toDate, limit = 100, offset = 0 }) {
        const conn = await this.pool.getConnection();
        try {
            let where = ['1=1'];
            const params = [];
            
            if (ticketId) {
                where.push('(ticket_id = ? OR ticket_id LIKE ? OR ticket_id LIKE ?)');
                const tid = String(ticketId).trim();
                params.push(tid, `%${tid}%`, `${tid.padStart(4, '0')}%`);
            }
            
            if (userId) {
                where.push('user_id = ?');
                params.push(String(userId));
            }
            
            if (ticketType) {
                where.push('LOWER(ticket_type) = ?');
                params.push(String(ticketType).toLowerCase());
            }
            
            if (server) {
                where.push('LOWER(server) LIKE ?');
                params.push(`%${String(server).toLowerCase()}%`);
            }
            
            if (closedBy) {
                where.push('(LOWER(close_user) LIKE ? OR LOWER(close_user_id) LIKE ?)');
                const search = `%${String(closedBy).toLowerCase()}%`;
                params.push(search, search);
            }
            
            if (fromDate) {
                where.push('created_at >= ?');
                params.push(Math.floor(fromDate.getTime() / 1000));
            }
            
            if (toDate) {
                where.push('created_at <= ?');
                params.push(Math.floor(toDate.getTime() / 1000));
            }
            
            // Only closed tickets
            where.push('(close_time IS NOT NULL OR close_type IS NOT NULL OR transcript_url IS NOT NULL)');
            
            const sql = `
                SELECT user_id, ticket_id, ticket_type, server, created_at,
                       close_user, close_user_id, close_reason, transcript_url
                FROM tickets
                WHERE ${where.join(' AND ')}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            `;
            
            params.push(limit, offset);
            
            const [rows] = await conn.query(sql, params);
            
            return rows.map(row => {
                const url = row.transcript_url || '';
                let filename = url ? url.split('/').pop() : null;
                if (filename && filename.endsWith('.full.html')) {
                    filename = filename.replace(/\.full\.html$/, '.html');
                }
                
                return {
                    userId: String(row.user_id || ''),
                    ticketId: String(row.ticket_id || ''),
                    ticketType: row.ticket_type || 'Unknown',
                    server: row.server || null,
                    createdAt: row.created_at || null,
                    closeUser: row.close_user || null,
                    closeUserID: row.close_user_id || null,
                    closeReason: row.close_reason || null,
                    transcriptFilename: filename
                };
            });
        } finally {
            conn.release();
        }
    }
}

module.exports = { createDB, MySQLAdapter };

