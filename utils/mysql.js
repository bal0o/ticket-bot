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
                // Ensure core tables exist so the bot doesn't crash on first use
                await conn.query(`
                    CREATE TABLE IF NOT EXISTS ticket_messages (
                        message_id VARCHAR(32) NOT NULL PRIMARY KEY,
                        channel_id VARCHAR(32) NOT NULL,
                        channel_name VARCHAR(255),
                        guild_id VARCHAR(32),
                        author_id VARCHAR(32) NOT NULL,
                        author_tag VARCHAR(64),
                        author_username VARCHAR(64),
                        author_is_bot TINYINT(1) DEFAULT 0,
                        created_at BIGINT NOT NULL,
                        content LONGTEXT,
                        pinned TINYINT(1) DEFAULT 0,
                        type SMALLINT,
                        webhook_id VARCHAR(32),
                        embeds JSON,
                        attachments JSON,
                        INDEX idx_channel_created (channel_id, created_at),
                        INDEX idx_channel_name_created (channel_name, created_at),
                        INDEX idx_author (author_id),
                        INDEX idx_guild_channel (guild_id, channel_id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                `);
                await conn.query(`
                    CREATE TABLE IF NOT EXISTS transcript_index (
                        filename VARCHAR(255) NOT NULL PRIMARY KEY,
                        user_id VARCHAR(255) NOT NULL,
                        ticket_id VARCHAR(255) NOT NULL,
                        ticket_type VARCHAR(100),
                        INDEX idx_user_id (user_id),
                        INDEX idx_ticket_id (ticket_id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                `);
                await conn.query(`
                    CREATE TABLE IF NOT EXISTS ticket_participants (
                        id BIGINT AUTO_INCREMENT PRIMARY KEY,
                        ticket_id VARCHAR(255) NOT NULL,
                        user_id VARCHAR(255) NOT NULL,
                        source_ticket_id VARCHAR(255) NULL,
                        merged_at BIGINT NOT NULL,
                        UNIQUE KEY unique_ticket_user (ticket_id, user_id),
                        INDEX idx_ticket_id (ticket_id),
                        INDEX idx_user_id (user_id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                `);
                if (__adapter && typeof __adapter.ensureTicketMetricsSchema === 'function') {
                    try {
                        await __adapter.ensureTicketMetricsSchema(conn);
                        await __adapter.backfillTicketMetrics(conn);
                    } catch (metricsErr) {
                        console.error('[mysql] Ticket metrics schema/backfill failed:', metricsErr.message);
                    }
                }
                conn.release();
                console.log('[mysql] ✓ Connection test and core table check successful');
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
            // Try exact match first (for aggregated objects like Metrics.total.ticketsOpened)
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
            
            // For backwards compatibility: if no exact match and it's a metrics key,
            // check for old individual leaf keys (from before optimization)
            // This helps during migration period
            if (key.startsWith('Metrics.')) {
                const [nestedRows] = await conn.query(
                    'SELECT `key`, value FROM kv_store WHERE `key` LIKE ? ORDER BY `key` LIMIT 1000',
                    [`${key}.%`]
                );
                
                if (nestedRows.length > 0) {
                    // Reconstruct nested object from individual keys (legacy format)
                    const result = {};
                    for (const row of nestedRows) {
                        const fullKey = row.key;
                        const suffix = fullKey.substring(key.length + 1);
                        const parts = suffix.split('.');
                        
                        let current = result;
                        for (let i = 0; i < parts.length - 1; i++) {
                            const part = parts[i];
                            if (!current[part]) {
                                current[part] = {};
                            }
                            current = current[part];
                        }
                        
                        const finalKey = parts[parts.length - 1];
                        let value = row.value;
                        try {
                            value = JSON.parse(value);
                        } catch {
                            // Keep as-is if not JSON
                        }
                        current[finalKey] = value;
                    }
                    
                    // Auto-migrate: save as aggregated object and clean up individual keys
                    if (Object.keys(result).length > 0) {
                        const jsonValue = JSON.stringify(result);
                        await conn.query(
                            'INSERT INTO kv_store (`key`, value, updated_at) VALUES (?, ?, NOW()) ' +
                            'ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
                            [key, jsonValue, jsonValue]
                        );
                        // Note: Don't delete old keys here - let add() handle it incrementally
                    }
                    
                    return result;
                }
            }
            
            return null;
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
            const keyParts = key.split('.');
            
            // For nested metrics keys (e.g., Metrics.usernames.123456789), store in parent object
            // This keeps usernames grouped efficiently
            if (keyParts.length === 3 && key.startsWith('Metrics.usernames.')) {
                const parentKey = 'Metrics.usernames';
                const userId = keyParts[2];
                
                // Get existing usernames object
                const [parentRows] = await conn.query(
                    'SELECT value FROM kv_store WHERE `key` = ?',
                    [parentKey]
                );
                
                let usernamesObj = {};
                if (parentRows.length > 0) {
                    try {
                        usernamesObj = JSON.parse(parentRows[0].value);
                        if (typeof usernamesObj !== 'object' || usernamesObj === null) {
                            usernamesObj = {};
                        }
                    } catch {
                        usernamesObj = {};
                    }
                }
                
                // Update nested value
                usernamesObj[userId] = value;
                
                // Save entire object
                const jsonValue = JSON.stringify(usernamesObj);
                await conn.query(
                    'INSERT INTO kv_store (`key`, value, updated_at) VALUES (?, ?, NOW()) ' +
                    'ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
                    [parentKey, jsonValue, jsonValue]
                );
                
                // Cleanup old individual key
                await conn.query('DELETE FROM kv_store WHERE `key` = ?', [key]);
            } else {
                // For non-nested keys, store directly
                const jsonValue = typeof value === 'object' ? JSON.stringify(value) : value;
                
                await conn.query(
                    'INSERT INTO kv_store (`key`, value, updated_at) VALUES (?, ?, NOW()) ' +
                    'ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
                    [key, jsonValue, jsonValue]
                );
            }
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
        // Optimized: Store metrics as aggregated objects instead of individual leaf keys
        // e.g., Metrics.total.ticketsOpened.bugreport.eu1 increments the nested object
        const conn = await this.pool.getConnection();
        try {
            const numericValue = Number(value) || 0;
            const keyParts = key.split('.');
            
            // For simple keys (no dots) or usernames, use direct increment
            if (keyParts.length <= 2 || !key.startsWith('Metrics.total.')) {
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
            }
            
            // For nested metrics keys (e.g., Metrics.total.ticketsOpened.bugreport.eu1):
            // Store aggregated object at parent key (e.g., Metrics.total.ticketsOpened)
            // This is much more efficient than thousands of individual keys
            
            // Extract parent key (e.g., "Metrics.total.ticketsOpened") and nested path (e.g., ["bugreport", "eu1"])
            const parentKey = keyParts.slice(0, 3).join('.'); // Metrics.total.ticketsOpened
            const nestedPath = keyParts.slice(3); // ["bugreport", "eu1"]
            
            // Get or create parent object
            const [parentRows] = await conn.query(
                'SELECT value FROM kv_store WHERE `key` = ?',
                [parentKey]
            );
            
            let parentObj = {};
            if (parentRows.length > 0) {
                try {
                    parentObj = JSON.parse(parentRows[0].value);
                    if (typeof parentObj !== 'object' || parentObj === null) {
                        parentObj = {};
                    }
                } catch {
                    parentObj = {};
                }
            }
            
            // Navigate/create nested structure
            let current = parentObj;
            for (let i = 0; i < nestedPath.length - 1; i++) {
                const part = nestedPath[i];
                if (!current[part] || typeof current[part] !== 'object') {
                    current[part] = {};
                }
                current = current[part];
            }
            
            // Increment final value
            const finalKey = nestedPath[nestedPath.length - 1];
            const currentVal = typeof current[finalKey] === 'number' ? current[finalKey] : 0;
            current[finalKey] = currentVal + numericValue;
            
            // Save entire parent object back
            const jsonValue = JSON.stringify(parentObj);
            await conn.query(
                'INSERT INTO kv_store (`key`, value, updated_at) VALUES (?, ?, NOW()) ' +
                'ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
                [parentKey, jsonValue, jsonValue]
            );
            
            // Delete any old individual leaf keys (cleanup from migration)
            await conn.query(
                'DELETE FROM kv_store WHERE `key` = ?',
                [key]
            );
            
            return current[finalKey];
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
    
    // Ensure transcript_index table exists (idempotent)
    async ensureTranscriptIndexTable(conn) {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS transcript_index (
                filename VARCHAR(255) NOT NULL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                ticket_id VARCHAR(255) NOT NULL,
                ticket_type VARCHAR(100),
                INDEX idx_user_id (user_id),
                INDEX idx_ticket_id (ticket_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }
    
    // Get transcript index entry by filename (auto-creates table if missing)
    async getTranscriptIndex(filename) {
        const conn = await this.pool.getConnection();
        try {
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
            } catch (err) {
                // If table doesn't exist, create it on the fly and retry once
                if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146)) {
                    await this.ensureTranscriptIndexTable(conn);
                    const [rows] = await conn.query(
                        'SELECT user_id, ticket_id, ticket_type FROM transcript_index WHERE filename = ? LIMIT 1',
                        [filename]
                    );
                    if (rows.length === 0) return null;
                    return {
                        ownerId: String(rows[0].user_id || ''),
                        ticketId: String(rows[0].ticket_id || ''),
                        ticketType: rows[0].ticket_type || null
                    };
                }
                throw err;
            }
        } finally {
            conn.release();
        }
    }
    
    // Ensure ticket_participants table exists (idempotent)
    async ensureTicketParticipantsTable(conn) {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS ticket_participants (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                ticket_id VARCHAR(255) NOT NULL,
                user_id VARCHAR(255) NOT NULL,
                source_ticket_id VARCHAR(255) NULL,
                merged_at BIGINT NOT NULL,
                UNIQUE KEY unique_ticket_user (ticket_id, user_id),
                INDEX idx_ticket_id (ticket_id),
                INDEX idx_user_id (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    async addTicketParticipant(ticketId, userId, sourceTicketId = null) {
        if (!ticketId || !userId) return;
        const conn = await this.pool.getConnection();
        try {
            try {
                await conn.query(
                    `INSERT INTO ticket_participants (ticket_id, user_id, source_ticket_id, merged_at)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE source_ticket_id = COALESCE(VALUES(source_ticket_id), source_ticket_id)`,
                    [String(ticketId), String(userId), sourceTicketId ? String(sourceTicketId) : null, Math.floor(Date.now() / 1000)]
                );
            } catch (err) {
                if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146)) {
                    await this.ensureTicketParticipantsTable(conn);
                    await conn.query(
                        `INSERT INTO ticket_participants (ticket_id, user_id, source_ticket_id, merged_at)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE source_ticket_id = COALESCE(VALUES(source_ticket_id), source_ticket_id)`,
                        [String(ticketId), String(userId), sourceTicketId ? String(sourceTicketId) : null, Math.floor(Date.now() / 1000)]
                    );
                    return;
                }
                throw err;
            }
        } finally {
            conn.release();
        }
    }

    async getTicketParticipants(ticketId) {
        if (!ticketId) return [];
        const conn = await this.pool.getConnection();
        try {
            try {
                const [rows] = await conn.query(
                    'SELECT ticket_id, user_id, source_ticket_id, merged_at FROM ticket_participants WHERE ticket_id = ?',
                    [String(ticketId)]
                );
                return (rows || []).map(row => ({
                    ticketId: String(row.ticket_id || ''),
                    userId: String(row.user_id || ''),
                    sourceTicketId: row.source_ticket_id ? String(row.source_ticket_id) : null,
                    mergedAt: row.merged_at || null
                }));
            } catch (err) {
                if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146)) {
                    await this.ensureTicketParticipantsTable(conn);
                    return [];
                }
                throw err;
            }
        } finally {
            conn.release();
        }
    }

    // Ensure ticket_messages table exists (idempotent)
    async ensureTicketMessagesTable(conn) {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS ticket_messages (
                message_id VARCHAR(32) NOT NULL PRIMARY KEY,
                channel_id VARCHAR(32) NOT NULL,
                channel_name VARCHAR(255),
                guild_id VARCHAR(32),
                author_id VARCHAR(32) NOT NULL,
                author_tag VARCHAR(64),
                author_username VARCHAR(64),
                author_is_bot TINYINT(1) DEFAULT 0,
                created_at BIGINT NOT NULL,
                content LONGTEXT,
                pinned TINYINT(1) DEFAULT 0,
                type SMALLINT,
                webhook_id VARCHAR(32),
                embeds JSON,
                attachments JSON,
                INDEX idx_channel_created (channel_id, created_at),
                INDEX idx_channel_name_created (channel_name, created_at),
                INDEX idx_author (author_id),
                INDEX idx_guild_channel (guild_id, channel_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
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
                       close_user, close_user_id, close_reason, transcript_url,
                       close_time, global_ticket_number
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
                    globalTicketNumber: row.global_ticket_number || row.ticket_id || '',
                    ticketType: row.ticket_type || 'Unknown',
                    server: row.server || null,
                    createdAt: row.created_at || null,
                    closeTime: row.close_time || null,
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
            try {
                return await conn.query(sql, params);
            } catch (err) {
                // If ticket_messages table is missing, create it on the fly and retry once
                if (
                    err &&
                    (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146) &&
                    typeof sql === 'string' &&
                    /ticket_messages/i.test(sql)
                ) {
                    await this.ensureTicketMessagesTable(conn);
                    return await conn.query(sql, params);
                }
                if (
                    err &&
                    (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146) &&
                    typeof sql === 'string' &&
                    /ticket_participants/i.test(sql)
                ) {
                    await this.ensureTicketParticipantsTable(conn);
                    return await conn.query(sql, params);
                }
                throw err;
            }
        } finally {
            conn.release();
        }
    }
    
    async getConnection() {
        return await this.pool.getConnection();
    }

    async _columnExists(conn, table, column) {
        const [rows] = await conn.query(
            `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [table, column]
        );
        return Number(rows[0]?.c || 0) > 0;
    }

    async _indexExists(conn, table, indexName) {
        const [rows] = await conn.query(
            `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
            [table, indexName]
        );
        return Number(rows[0]?.c || 0) > 0;
    }

    async _addColumnIfMissing(conn, table, column, definition) {
        if (await this._columnExists(conn, table, column)) return;
        try {
            await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        } catch (err) {
            if (err && (err.errno === 1060 || err.code === 'ER_DUP_FIELDNAME')) return;
            throw err;
        }
    }

    async _addIndexIfMissing(conn, table, indexName, columnsSql) {
        if (await this._indexExists(conn, table, indexName)) return;
        try {
            await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` ${columnsSql}`);
        } catch (err) {
            if (err && (err.errno === 1061 || err.code === 'ER_DUP_KEYNAME')) return;
            throw err;
        }
    }

    async ensureTicketMetricsSchema(existingConn = null) {
        const conn = existingConn || await this.pool.getConnection();
        try {
            await this._addColumnIfMissing(conn, 'tickets', 'channel_id', 'VARCHAR(32) NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'first_staff_response_at', 'BIGINT NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'first_staff_response_user_id', 'VARCHAR(255) NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'first_staff_response_user', 'VARCHAR(255) NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'last_staff_response_at', 'BIGINT NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'last_staff_response_user_id', 'VARCHAR(255) NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'last_staff_response_user', 'VARCHAR(255) NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'claimed_by_user_id', 'VARCHAR(255) NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'claimed_by_user', 'VARCHAR(255) NULL');
            await this._addColumnIfMissing(conn, 'tickets', 'claimed_at', 'BIGINT NULL');
            await this._addIndexIfMissing(conn, 'tickets', 'idx_channel_id', '(channel_id)');
            await this._addIndexIfMissing(conn, 'tickets', 'idx_first_staff_response_user_id', '(first_staff_response_user_id)');
            await this._addIndexIfMissing(conn, 'tickets', 'idx_claimed_by_user_id', '(claimed_by_user_id)');
            try {
                await this.ensureGrafanaViews(conn);
            } catch (viewErr) {
                console.error('[mysql] Could not create Grafana views:', viewErr.message);
            }
        } finally {
            if (!existingConn) conn.release();
        }
    }

    async ensureGrafanaViews(conn) {
        await conn.query(`
            CREATE OR REPLACE VIEW grafana_ticket_metrics AS
            SELECT
                t.id AS ticket_pk,
                t.ticket_id,
                t.global_ticket_number,
                t.ticket_type,
                t.server,
                t.channel_id,
                t.user_id AS opener_id,
                t.username AS opener_name,
                CASE
                    WHEN t.created_at IS NULL THEN NULL
                    WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000)
                    ELSE t.created_at
                END AS created_at,
                CASE
                    WHEN t.close_time IS NULL THEN NULL
                    WHEN t.close_time > 9999999999 THEN FLOOR(t.close_time / 1000)
                    ELSE t.close_time
                END AS close_time,
                t.close_type,
                t.close_user_id,
                t.close_user,
                t.close_reason,
                t.transcript_url,
                CASE
                    WHEN t.first_staff_response_at IS NULL THEN NULL
                    WHEN t.first_staff_response_at > 9999999999 THEN FLOOR(t.first_staff_response_at / 1000)
                    ELSE t.first_staff_response_at
                END AS first_staff_response_at,
                t.first_staff_response_user_id,
                t.first_staff_response_user,
                CASE
                    WHEN t.last_staff_response_at IS NULL THEN NULL
                    WHEN t.last_staff_response_at > 9999999999 THEN FLOOR(t.last_staff_response_at / 1000)
                    ELSE t.last_staff_response_at
                END AS last_staff_response_at,
                t.last_staff_response_user_id,
                t.last_staff_response_user,
                t.claimed_by_user_id,
                t.claimed_by_user,
                CASE
                    WHEN t.claimed_at IS NULL THEN NULL
                    WHEN t.claimed_at > 9999999999 THEN FLOOR(t.claimed_at / 1000)
                    ELSE t.claimed_at
                END AS claimed_at,
                (t.close_time IS NOT NULL OR t.close_type IS NOT NULL OR t.transcript_url IS NOT NULL) AS is_closed,
                CASE
                    WHEN t.first_staff_response_at IS NULL OR t.created_at IS NULL THEN NULL
                    ELSE GREATEST(
                        0,
                        (CASE WHEN t.first_staff_response_at > 9999999999 THEN FLOOR(t.first_staff_response_at / 1000) ELSE t.first_staff_response_at END)
                        - (CASE WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000) ELSE t.created_at END)
                    )
                END AS time_to_first_response_seconds,
                CASE
                    WHEN t.close_time IS NULL OR t.created_at IS NULL THEN NULL
                    ELSE GREATEST(
                        0,
                        (CASE WHEN t.close_time > 9999999999 THEN FLOOR(t.close_time / 1000) ELSE t.close_time END)
                        - (CASE WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000) ELSE t.created_at END)
                    )
                END AS time_open_seconds,
                CASE
                    WHEN t.close_time IS NULL OR t.first_staff_response_at IS NULL THEN NULL
                    ELSE GREATEST(
                        0,
                        (CASE WHEN t.close_time > 9999999999 THEN FLOOR(t.close_time / 1000) ELSE t.close_time END)
                        - (CASE WHEN t.first_staff_response_at > 9999999999 THEN FLOOR(t.first_staff_response_at / 1000) ELSE t.first_staff_response_at END)
                    )
                END AS first_response_to_close_seconds,
                CASE
                    WHEN t.claimed_at IS NULL OR t.created_at IS NULL THEN NULL
                    ELSE GREATEST(
                        0,
                        (CASE WHEN t.claimed_at > 9999999999 THEN FLOOR(t.claimed_at / 1000) ELSE t.claimed_at END)
                        - (CASE WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000) ELSE t.created_at END)
                    )
                END AS time_to_claim_seconds,
                CASE
                    WHEN t.close_time IS NOT NULL OR t.close_type IS NOT NULL OR t.transcript_url IS NOT NULL THEN NULL
                    ELSE GREATEST(
                        0,
                        UNIX_TIMESTAMP()
                        - CASE
                            WHEN t.last_staff_response_at IS NOT NULL THEN
                                CASE WHEN t.last_staff_response_at > 9999999999 THEN FLOOR(t.last_staff_response_at / 1000) ELSE t.last_staff_response_at END
                            WHEN t.created_at IS NOT NULL THEN
                                CASE WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000) ELSE t.created_at END
                            ELSE UNIX_TIMESTAMP()
                        END
                    )
                END AS open_wait_seconds
            FROM tickets t
        `);
        await conn.query(`
            CREATE OR REPLACE VIEW grafana_staff_involvement AS
            SELECT
                m.ticket_pk,
                m.ticket_id,
                m.ticket_type,
                m.server,
                m.created_at,
                m.close_time,
                m.is_closed,
                m.time_to_first_response_seconds,
                m.time_open_seconds,
                m.first_response_to_close_seconds,
                m.time_to_claim_seconds,
                'first_responder' AS involvement,
                m.first_staff_response_user_id AS staff_user_id,
                m.first_staff_response_user AS staff_name
            FROM grafana_ticket_metrics m
            WHERE m.first_staff_response_user_id IS NOT NULL
            UNION ALL
            SELECT
                m.ticket_pk,
                m.ticket_id,
                m.ticket_type,
                m.server,
                m.created_at,
                m.close_time,
                m.is_closed,
                m.time_to_first_response_seconds,
                m.time_open_seconds,
                m.first_response_to_close_seconds,
                m.time_to_claim_seconds,
                'closer' AS involvement,
                m.close_user_id AS staff_user_id,
                m.close_user AS staff_name
            FROM grafana_ticket_metrics m
            WHERE m.close_user_id IS NOT NULL
            UNION ALL
            SELECT
                m.ticket_pk,
                m.ticket_id,
                m.ticket_type,
                m.server,
                m.created_at,
                m.close_time,
                m.is_closed,
                m.time_to_first_response_seconds,
                m.time_open_seconds,
                m.first_response_to_close_seconds,
                m.time_to_claim_seconds,
                'claimer' AS involvement,
                m.claimed_by_user_id AS staff_user_id,
                m.claimed_by_user AS staff_name
            FROM grafana_ticket_metrics m
            WHERE m.claimed_by_user_id IS NOT NULL
        `);
        await conn.query(`
            CREATE OR REPLACE VIEW grafana_staff_messages AS
            SELECT
                t.ticket_id,
                t.ticket_type,
                t.server,
                CASE
                    WHEN t.created_at IS NULL THEN NULL
                    WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000)
                    ELSE t.created_at
                END AS created_at,
                m.author_id AS staff_user_id,
                MAX(m.author_username) AS staff_name,
                COUNT(*) AS message_count,
                MIN(m.created_at) AS first_message_at,
                MAX(m.created_at) AS last_message_at
            FROM tickets t
            INNER JOIN ticket_messages m ON m.channel_id = t.channel_id
            LEFT JOIN ticket_participants p ON p.ticket_id = t.ticket_id AND p.user_id = m.author_id
            WHERE t.channel_id IS NOT NULL
              AND m.author_is_bot = 0
              AND m.author_id <> t.user_id
              AND p.id IS NULL
              AND (m.channel_name IS NULL OR m.channel_name NOT LIKE 'staff-chat-%')
            GROUP BY t.ticket_id, t.ticket_type, t.server, t.created_at, m.author_id
        `);
        await conn.query(`
            CREATE OR REPLACE VIEW grafana_staff_activity AS
            SELECT
                sm.ticket_id,
                sm.ticket_type,
                sm.server,
                sm.created_at,
                tm.close_time,
                tm.is_closed,
                sm.staff_user_id,
                sm.staff_name,
                sm.message_count,
                CASE
                    WHEN sm.first_message_at > 9999999999 THEN FLOOR(sm.first_message_at / 1000)
                    ELSE sm.first_message_at
                END AS first_message_at,
                CASE
                    WHEN sm.last_message_at > 9999999999 THEN FLOOR(sm.last_message_at / 1000)
                    ELSE sm.last_message_at
                END AS last_message_at,
                tm.time_to_first_response_seconds AS queue_wait_seconds,
                GREATEST(
                    0,
                    (CASE WHEN sm.first_message_at > 9999999999 THEN FLOOR(sm.first_message_at / 1000) ELSE sm.first_message_at END)
                    - sm.created_at
                ) AS age_at_engagement_seconds,
                CASE
                    WHEN tm.close_time IS NULL THEN NULL
                    ELSE GREATEST(
                        0,
                        tm.close_time
                        - (CASE WHEN sm.first_message_at > 9999999999 THEN FLOOR(sm.first_message_at / 1000) ELSE sm.first_message_at END)
                    )
                END AS handle_after_pickup_seconds,
                CASE
                    WHEN tm.claimed_by_user_id = sm.staff_user_id AND tm.claimed_at IS NOT NULL THEN
                        GREATEST(
                            0,
                            (CASE WHEN sm.first_message_at > 9999999999 THEN FLOOR(sm.first_message_at / 1000) ELSE sm.first_message_at END)
                            - tm.claimed_at
                        )
                    ELSE NULL
                END AS claim_to_first_message_seconds,
                (tm.first_staff_response_user_id = sm.staff_user_id) AS is_first_responder,
                (tm.close_user_id = sm.staff_user_id) AS is_closer,
                (tm.claimed_by_user_id = sm.staff_user_id) AS is_claimer,
                (
                    tm.first_staff_response_user_id = sm.staff_user_id
                    AND tm.time_to_first_response_seconds > 14400
                ) AS is_stale_pickup
            FROM grafana_staff_messages sm
            INNER JOIN grafana_ticket_metrics tm ON tm.ticket_id = sm.ticket_id
        `);
    }

    async backfillTicketMetrics(existingConn = null) {
        const conn = existingConn || await this.pool.getConnection();
        try {
            await this.ensureTicketMessagesTable(conn);
            await this.ensureTicketParticipantsTable(conn);
            await conn.query(`
                UPDATE tickets t
                INNER JOIN (
                    SELECT
                        SUBSTRING_INDEX(TRIM(TRAILING '-claimed' FROM m.channel_name), '-', -1) AS ticket_id,
                        MIN(m.channel_id) AS channel_id
                    FROM ticket_messages m
                    WHERE m.channel_name IS NOT NULL
                      AND m.channel_name NOT LIKE 'staff-chat-%'
                      AND SUBSTRING_INDEX(TRIM(TRAILING '-claimed' FROM m.channel_name), '-', -1) REGEXP '^[0-9]+$'
                    GROUP BY SUBSTRING_INDEX(TRIM(TRAILING '-claimed' FROM m.channel_name), '-', -1)
                ) src ON src.ticket_id = t.ticket_id
                SET t.channel_id = src.channel_id
                WHERE t.channel_id IS NULL
            `);
            await conn.query(`
                UPDATE tickets t
                INNER JOIN (
                    SELECT
                        x.ticket_pk,
                        m.created_at,
                        m.author_id,
                        m.author_username
                    FROM ticket_messages m
                    INNER JOIN (
                        SELECT
                            t2.id AS ticket_pk,
                            t2.channel_id,
                            MIN(m2.created_at) AS first_at
                        FROM tickets t2
                        INNER JOIN ticket_messages m2 ON m2.channel_id = t2.channel_id
                        LEFT JOIN ticket_participants p ON p.ticket_id = t2.ticket_id AND p.user_id = m2.author_id
                        WHERE t2.channel_id IS NOT NULL
                          AND t2.first_staff_response_at IS NULL
                          AND m2.author_is_bot = 0
                          AND m2.author_id <> t2.user_id
                          AND p.id IS NULL
                          AND (m2.channel_name IS NULL OR m2.channel_name NOT LIKE 'staff-chat-%')
                        GROUP BY t2.id, t2.channel_id
                    ) x ON m.channel_id = x.channel_id AND m.created_at = x.first_at
                    WHERE m.author_is_bot = 0
                ) src ON src.ticket_pk = t.id
                SET
                    t.first_staff_response_at = src.created_at,
                    t.first_staff_response_user_id = src.author_id,
                    t.first_staff_response_user = src.author_username
                WHERE t.first_staff_response_at IS NULL
            `);
            await conn.query(`
                UPDATE tickets t
                INNER JOIN (
                    SELECT
                        x.ticket_pk,
                        m.created_at,
                        m.author_id,
                        m.author_username
                    FROM ticket_messages m
                    INNER JOIN (
                        SELECT
                            t2.id AS ticket_pk,
                            t2.channel_id,
                            MAX(m2.created_at) AS last_at
                        FROM tickets t2
                        INNER JOIN ticket_messages m2 ON m2.channel_id = t2.channel_id
                        LEFT JOIN ticket_participants p ON p.ticket_id = t2.ticket_id AND p.user_id = m2.author_id
                        WHERE t2.channel_id IS NOT NULL
                          AND t2.last_staff_response_at IS NULL
                          AND m2.author_is_bot = 0
                          AND m2.author_id <> t2.user_id
                          AND p.id IS NULL
                          AND (m2.channel_name IS NULL OR m2.channel_name NOT LIKE 'staff-chat-%')
                        GROUP BY t2.id, t2.channel_id
                    ) x ON m.channel_id = x.channel_id AND m.created_at = x.last_at
                    WHERE m.author_is_bot = 0
                ) src ON src.ticket_pk = t.id
                SET
                    t.last_staff_response_at = src.created_at,
                    t.last_staff_response_user_id = src.author_id,
                    t.last_staff_response_user = src.author_username
                WHERE t.last_staff_response_at IS NULL
            `);
        } catch (err) {
            console.error('[mysql] backfillTicketMetrics error:', err.message);
        } finally {
            if (!existingConn) conn.release();
        }
    }

    async recordStaffTicketActivity({ channelId, ticketId, openerId, staffId, staffName, at } = {}) {
        if (!staffId || (!channelId && !ticketId)) return;
        if (openerId && String(staffId) === String(openerId)) return;
        const atSeconds = at > 9999999999 ? Math.floor(at / 1000) : Math.floor(at || Date.now() / 1000);
        const conn = await this.pool.getConnection();
        try {
            const params = [
                channelId ? String(channelId) : null,
                atSeconds,
                String(staffId),
                staffName ? String(staffName) : null,
                atSeconds,
                String(staffId),
                staffName ? String(staffName) : null,
            ];
            const where = [];
            if (channelId) {
                where.push('channel_id = ?');
                params.push(String(channelId));
            }
            if (ticketId && openerId) {
                where.push('(ticket_id = ? AND user_id = ?)');
                params.push(String(ticketId), String(openerId));
            } else if (ticketId) {
                where.push('ticket_id = ?');
                params.push(String(ticketId));
            }
            if (!where.length) return;
            await conn.query(
                `UPDATE tickets SET
                    channel_id = COALESCE(channel_id, ?),
                    first_staff_response_at = COALESCE(first_staff_response_at, ?),
                    first_staff_response_user_id = COALESCE(first_staff_response_user_id, ?),
                    first_staff_response_user = COALESCE(first_staff_response_user, ?),
                    last_staff_response_at = ?,
                    last_staff_response_user_id = ?,
                    last_staff_response_user = ?
                 WHERE ${where.join(' OR ')}
                 LIMIT 1`,
                params
            );
        } catch (err) {
            if (err && (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054)) {
                try {
                    await this.ensureTicketMetricsSchema(conn);
                    await this.recordStaffTicketActivity({ channelId, ticketId, openerId, staffId, staffName, at });
                    return;
                } catch (_) {}
            }
            console.error('[mysql] recordStaffTicketActivity error:', err.message);
        } finally {
            conn.release();
        }
    }

    async recordTicketClaim({ channelId, ticketId, openerId, staffId, staffName, at } = {}) {
        if (!staffId || (!channelId && !ticketId)) return;
        const atSeconds = at > 9999999999 ? Math.floor(at / 1000) : Math.floor(at || Date.now() / 1000);
        const conn = await this.pool.getConnection();
        try {
            const params = [
                String(staffId),
                staffName ? String(staffName) : null,
                atSeconds,
            ];
            const where = [];
            if (channelId) {
                where.push('channel_id = ?');
                params.push(String(channelId));
            }
            if (ticketId && openerId) {
                where.push('(ticket_id = ? AND user_id = ?)');
                params.push(String(ticketId), String(openerId));
            } else if (ticketId) {
                where.push('ticket_id = ?');
                params.push(String(ticketId));
            }
            if (!where.length) return;
            await conn.query(
                `UPDATE tickets SET
                    claimed_by_user_id = COALESCE(claimed_by_user_id, ?),
                    claimed_by_user = COALESCE(claimed_by_user, ?),
                    claimed_at = COALESCE(claimed_at, ?)
                 WHERE ${where.join(' OR ')}
                 LIMIT 1`,
                params
            );
        } catch (err) {
            if (err && (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054)) {
                try {
                    await this.ensureTicketMetricsSchema(conn);
                    await this.recordTicketClaim({ channelId, ticketId, openerId, staffId, staffName, at });
                    return;
                } catch (_) {}
            }
            console.error('[mysql] recordTicketClaim error:', err.message);
        } finally {
            conn.release();
        }
    }

    async finalizeTicketMetrics({ channelId, ticketId, openerId } = {}) {
        if (!channelId && !ticketId) return;
        const conn = await this.pool.getConnection();
        try {
            if (channelId && ticketId) {
                const params = [String(channelId)];
                let whereSql = 'ticket_id = ?';
                params.push(String(ticketId));
                if (openerId) {
                    whereSql = 'user_id = ? AND ticket_id = ?';
                    params.splice(1, 0, String(openerId));
                }
                await conn.query(
                    `UPDATE tickets SET channel_id = COALESCE(channel_id, ?) WHERE ${whereSql} LIMIT 1`,
                    params
                );
            }
            if (channelId) {
                await conn.query(`
                    UPDATE tickets t
                    INNER JOIN (
                        SELECT m.created_at, m.author_id, m.author_username
                        FROM ticket_messages m
                        LEFT JOIN tickets t2 ON t2.channel_id = m.channel_id
                        LEFT JOIN ticket_participants p ON p.ticket_id = t2.ticket_id AND p.user_id = m.author_id
                        WHERE m.channel_id = ?
                          AND m.author_is_bot = 0
                          AND m.author_id <> t2.user_id
                          AND p.id IS NULL
                          AND (m.channel_name IS NULL OR m.channel_name NOT LIKE 'staff-chat-%')
                        ORDER BY m.created_at ASC
                        LIMIT 1
                    ) src ON 1=1
                    SET
                        t.first_staff_response_at = COALESCE(t.first_staff_response_at, src.created_at),
                        t.first_staff_response_user_id = COALESCE(t.first_staff_response_user_id, src.author_id),
                        t.first_staff_response_user = COALESCE(t.first_staff_response_user, src.author_username)
                    WHERE t.channel_id = ? AND t.first_staff_response_at IS NULL
                `, [String(channelId), String(channelId)]);
            }
        } catch (err) {
            console.error('[mysql] finalizeTicketMetrics error:', err.message);
        } finally {
            conn.release();
        }
    }
    
    // Write ticket to tickets table (for MySQL mode)
    async writeTicket(ticketData, retried = false) {
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
                ticketData.globalTicketNumber || ticketData.global_ticket_number || null,
                ticketData.channelId || ticketData.channel_id || null
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
                    close_user_id, close_reason, transcript_url, global_ticket_number,
                    channel_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    global_ticket_number = COALESCE(VALUES(global_ticket_number), global_ticket_number),
                    channel_id = COALESCE(VALUES(channel_id), channel_id)
            `, params);
            
            console.log('[mysql] writeTicket result', { 
                affectedRows: result.affectedRows,
                insertId: result.insertId,
                changedRows: result.changedRows
            });
            
            // Also update transcript index (auto-create table if missing)
            if (ticketData.transcriptURL || ticketData.transcriptFilename) {
                const filename = ticketData.transcriptFilename || (ticketData.transcriptURL ? ticketData.transcriptURL.split('/').pop() : null);
                if (filename) {
                    await this.ensureTranscriptIndexTable(conn);
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
            if (err && !retried && (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054)) {
                try {
                    await this.ensureTicketMetricsSchema(conn);
                    return await this.writeTicket(ticketData, true);
                } catch (retryErr) {
                    err = retryErr;
                }
            }
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
                // Search by user_id (Discord ID), steam_id, and username
                const userIdStr = String(userId).trim();
                if (/^\d+$/.test(userIdStr)) {
                    // It's a numeric ID - could be Discord ID or Steam ID
                    // Search user_id exactly, steam_id exactly, and also allow partial username match
                    where.push('(user_id = ? OR steam_id = ? OR LOWER(username) LIKE ?)');
                    params.push(userIdStr, userIdStr, `%${userIdStr.toLowerCase()}%`);
                } else {
                    // It's a username or partial match - search username field, user_id, and steam_id
                    where.push('(LOWER(username) LIKE ? OR user_id LIKE ? OR steam_id LIKE ?)');
                    params.push(`%${userIdStr.toLowerCase()}%`, `%${userIdStr}%`, `%${userIdStr}%`);
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
    
    // Public query method for direct SQL queries
    async query(sql, params = []) {
        const conn = await this.pool.getConnection();
        try {
            try {
                return await conn.query(sql, params);
            } catch (err) {
                if (
                    err &&
                    (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146) &&
                    typeof sql === 'string' &&
                    /ticket_participants/i.test(sql)
                ) {
                    await this.ensureTicketParticipantsTable(conn);
                    return await conn.query(sql, params);
                }
                throw err;
            }
        } finally {
            conn.release();
        }
    }
}

module.exports = { createDB, MySQLAdapter };

