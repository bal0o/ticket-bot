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
    
    // MySQL is now required - strict validation
    if (!dbConfig.host || String(dbConfig.host).trim() === '') {
        console.error('[mysql] CRITICAL: MySQL host not configured!');
        console.error('[mysql] Please set config.database.host in config.json');
        throw new Error('MySQL configuration required! Please set config.database.host and other MySQL settings in config.json. The bot cannot run without MySQL.');
    }
    
    if (!__pool) {
        const poolConfig = {
            host: String(dbConfig.host).trim(),
            port: dbConfig.port || 3306,
            user: dbConfig.user || 'root',
            password: dbConfig.password || '',
            database: dbConfig.database || 'ticketbot',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0
        };
        
        console.log('[mysql] Creating MySQL connection pool:', {
            host: poolConfig.host,
            port: poolConfig.port,
            database: poolConfig.database,
            user: poolConfig.user
        });
        
        __pool = mysql.createPool(poolConfig);
        
        // Test connection asynchronously - log error but don't block startup
        // The first actual query will fail if connection is bad
        (async () => {
            try {
                const conn = await __pool.getConnection();
                await conn.query('SELECT 1');
                conn.release();
                console.log('[mysql] ✓ Connection test successful');
            } catch (err) {
                console.error('[mysql] ✗ CRITICAL: MySQL connection test failed!');
                console.error('[mysql] Error:', err.message);
                console.error('[mysql] The bot may fail when trying to use the database.');
                console.error('[mysql] Please check:');
                console.error('[mysql]   1. MySQL server is running');
                console.error('[mysql]   2. config.database settings in config.json are correct');
                console.error('[mysql]   3. Database user has proper permissions');
                console.error('[mysql]   4. Database exists: ' + poolConfig.database);
            }
        })();
        
        __adapter = new MySQLAdapter(__pool);
    }
    return __adapter;
}

// Compatibility layer that mimics quick.db interface
class MySQLAdapter {
    constructor(pool) {
        this.pool = pool;
    }
    
    async get(key) {
        const conn = await this.pool.getConnection();
        try {
            // First try exact match
            const [exactRows] = await conn.query(
                'SELECT value FROM kv_store WHERE `key` = ?',
                [key]
            );
            
            if (exactRows.length > 0) {
                const value = exactRows[0].value;
                // Parse JSON if it's a string
                try {
                    return JSON.parse(value);
                } catch {
                    return value;
                }
            }
            
            // If no exact match, check for nested keys (quick.db compatibility)
            // e.g., if key is "Metrics.total.ticketsOpened", look for keys starting with "Metrics.total.ticketsOpened."
            const [nestedRows] = await conn.query(
                'SELECT `key`, value FROM kv_store WHERE `key` LIKE ? ORDER BY `key`',
                [`${key}.%`]
            );
            
            if (nestedRows.length === 0) return null;
            
            // Reconstruct nested object from individual keys
            // e.g., "Metrics.total.ticketsOpened.bugreport.eu1" = 5
            // becomes { bugreport: { eu1: 5 } }
            const result = {};
            for (const row of nestedRows) {
                const fullKey = row.key;
                // Remove the prefix and split by dots to get the nested path
                const suffix = fullKey.substring(key.length + 1); // +1 to skip the dot
                const parts = suffix.split('.');
                
                let current = result;
                for (let i = 0; i < parts.length - 1; i++) {
                    const part = parts[i];
                    if (!current[part]) {
                        current[part] = {};
                    }
                    current = current[part];
                }
                
                // Set the final value
                const finalKey = parts[parts.length - 1];
                let value = row.value;
                try {
                    value = JSON.parse(value);
                } catch {
                    // Keep as-is if not JSON
                }
                current[finalKey] = value;
            }
            
            return result;
        } catch (err) {
            console.error('[mysql] get() error:', {
                key,
                message: err.message,
                code: err.code
            });
            throw new Error(`MySQL query failed: ${err.message}. Please ensure MySQL is configured and running.`);
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
        } catch (err) {
            console.error('[mysql] set() error:', {
                key,
                message: err.message,
                code: err.code
            });
            throw new Error(`MySQL query failed: ${err.message}. Please ensure MySQL is configured and running.`);
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
    
    async add(key, value = 0) {
        // Add/increment numeric value (compatible with quick.db add method)
        const conn = await this.pool.getConnection();
        try {
            const numericValue = Number(value) || 0;
            
            // Get current value
            const [rows] = await conn.query(
                'SELECT value FROM kv_store WHERE `key` = ?',
                [key]
            );
            
            let currentValue = 0;
            if (rows.length > 0) {
                try {
                    const parsed = JSON.parse(rows[0].value);
                    currentValue = typeof parsed === 'number' ? parsed : 0;
                } catch {
                    // If not JSON, try to parse as number
                    currentValue = Number(rows[0].value) || 0;
                }
            }
            
            const newValue = currentValue + numericValue;
            const jsonValue = JSON.stringify(newValue);
            
            await conn.query(
                'INSERT INTO kv_store (`key`, value, updated_at) VALUES (?, ?, NOW()) ' +
                'ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
                [key, jsonValue, jsonValue]
            );
            
            return newValue;
        } catch (err) {
            console.error('[mysql] add() error:', {
                key,
                message: err.message,
                code: err.code
            });
            throw new Error(`MySQL query failed: ${err.message}`);
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
    
    // Get transcript index entry by filename
    async getTranscriptIndex(filename) {
        const conn = await this.pool.getConnection();
        try {
            const [rows] = await conn.query(
                'SELECT user_id, ticket_id, ticket_type FROM transcript_index WHERE filename = ? LIMIT 1',
                [filename]
            );
            
            if (rows.length === 0) {
                // Try alternative filename variants
                const altFilename = filename.endsWith('.full.html') 
                    ? filename.replace(/\.full\.html$/i, '.html')
                    : filename.replace(/\.html$/i, '.full.html');
                const [altRows] = await conn.query(
                    'SELECT user_id, ticket_id, ticket_type FROM transcript_index WHERE filename = ? LIMIT 1',
                    [altFilename]
                );
                if (altRows.length === 0) return null;
                return {
                    ownerId: String(altRows[0].user_id || ''),
                    ticketId: String(altRows[0].ticket_id || ''),
                    ticketType: altRows[0].ticket_type || null
                };
            }
            
            return {
                ownerId: String(rows[0].user_id || ''),
                ticketId: String(rows[0].ticket_id || ''),
                ticketType: rows[0].ticket_type || null
            };
        } finally {
            conn.release();
        }
    }
    
    // Get unique user IDs from tickets (for user list caching)
    async getUserIds(limit = 500) {
        const conn = await this.pool.getConnection();
        try {
            const [rows] = await conn.query(
                'SELECT DISTINCT user_id FROM tickets WHERE user_id IS NOT NULL LIMIT ?',
                [limit]
            );
            return rows.map(row => String(row.user_id || '')).filter(Boolean);
        } finally {
            conn.release();
        }
    }
    
    // Get tickets for a specific user (for "my tickets" view)
    async getUserTickets(userId, options = {}) {
        const conn = await this.pool.getConnection();
        try {
            const { closedOnly = true, limit = 100, offset = 0 } = options;
            let where = ['user_id = ?'];
            const params = [String(userId)];
            
            if (closedOnly) {
                where.push('(close_time IS NOT NULL OR close_type IS NOT NULL OR transcript_url IS NOT NULL)');
            }
            
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
                    transcriptFilename: filename,
                    isClosed: !!(row.close_time || row.transcript_url)
                };
            });
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
            const params = [
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
            ];
            
            console.log('[mysql] writeTicket called', { 
                userId: params[0], 
                ticketId: params[1], 
                ticketType: params[2],
                hasResponses: !!params[6],
                createdAt: params[7]
            });
            
            const [result] = await conn.query(`
                INSERT INTO tickets (
                    user_id, ticket_id, ticket_type, server, username, steam_id,
                    responses, created_at, close_time, close_type, close_user,
                    close_user_id, close_reason, transcript_url, global_ticket_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    ticket_type = COALESCE(VALUES(ticket_type), ticket_type),
                    server = COALESCE(VALUES(server), server),
                    username = COALESCE(VALUES(username), username),
                    created_at = COALESCE(VALUES(created_at), created_at),
                    close_time = COALESCE(VALUES(close_time), close_time),
                    close_type = COALESCE(VALUES(close_type), close_type),
                    close_user = COALESCE(VALUES(close_user), close_user),
                    close_user_id = COALESCE(VALUES(close_user_id), close_user_id),
                    close_reason = COALESCE(VALUES(close_reason), close_reason),
                    transcript_url = COALESCE(VALUES(transcript_url), transcript_url),
                    global_ticket_number = COALESCE(VALUES(global_ticket_number), global_ticket_number)
            `, params);
            
            console.log('[mysql] writeTicket result', { 
                affectedRows: result.affectedRows,
                insertId: result.insertId,
                changedRows: result.changedRows
            });
            
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
        } catch (err) {
            console.error('[mysql] writeTicket error:', {
                message: err.message,
                code: err.code,
                sqlState: err.sqlState,
                sqlMessage: err.sqlMessage,
                ticketId: ticketData.ticketId || ticketData.ticket_id,
                userId: ticketData.userId || ticketData.user_id
            });
            throw err; // Re-throw so caller can handle it
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
                // Search by both user_id and username (similar to closed_by search)
                const userIdStr = String(userId).trim();
                if (/^\d+$/.test(userIdStr)) {
                    // It's a numeric ID - search user_id exactly, but also allow partial username match
                    where.push('(user_id = ? OR LOWER(username) LIKE ?)');
                    params.push(userIdStr, `%${userIdStr.toLowerCase()}%`);
                } else {
                    // It's a username - search username field and also check if it matches a user_id
                    where.push('(LOWER(username) LIKE ? OR user_id LIKE ?)');
                    params.push(`%${userIdStr.toLowerCase()}%`, `%${userIdStr}%`);
                }
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
                SELECT user_id, ticket_id, ticket_type, server, username, created_at,
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
                    username: row.username || null,
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

