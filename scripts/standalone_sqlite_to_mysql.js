#!/usr/bin/env node
/**
 * Standalone SQLite to MySQL Migration Script
 * 
 * This script migrates data from a quick.db SQLite database to MySQL.
 * It's completely self-contained and can be run independently.
 * 
 * Usage:
 *   node standalone_sqlite_to_mysql.js
 * 
 * Or with command line arguments:
 *   node standalone_sqlite_to_mysql.js \
 *     --sqlite ./data/json.sqlite \
 *     --mysql-host localhost \
 *     --mysql-port 3306 \
 *     --mysql-user root \
 *     --mysql-password "" \
 *     --mysql-database ticketbot
 * 
 * Or set environment variables:
 *   SQLITE_PATH=./data/json.sqlite \
 *   MYSQL_HOST=localhost \
 *   MYSQL_PORT=3306 \
 *   MYSQL_USER=root \
 *   MYSQL_PASSWORD=your_password \
 *   MYSQL_DATABASE=ticketbot \
 *   node standalone_sqlite_to_mysql.js
 */

const path = require('path');
const fs = require('fs');

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {};
    
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].substring(2).replace(/-/g, '_');
            const value = args[i + 1];
            if (value && !value.startsWith('--')) {
                config[key] = value;
                i++;
            } else {
                config[key] = true;
            }
        }
    }
    
    return {
        sqlitePath: config.sqlite || process.env.SQLITE_PATH || './data/json.sqlite',
        mysql: {
            host: config.mysql_host || process.env.MYSQL_HOST || 'localhost',
            port: parseInt(config.mysql_port || process.env.MYSQL_PORT || '3306'),
            user: config.mysql_user || process.env.MYSQL_USER || 'root',
            password: config.mysql_password || process.env.MYSQL_PASSWORD || '',
            database: config.mysql_database || process.env.MYSQL_DATABASE || 'ticketbot'
        }
    };
}

async function main() {
    const config = parseArgs();
    
    console.log('========================================');
    console.log('SQLite to MySQL Migration Tool');
    console.log('========================================\n');
    
    // Check SQLite file exists
    if (!fs.existsSync(config.sqlitePath)) {
        console.error(`ERROR: SQLite file not found: ${config.sqlitePath}`);
        console.error('Please specify the path to your json.sqlite file using:');
        console.error('  --sqlite /path/to/json.sqlite');
        console.error('  or set SQLITE_PATH environment variable');
        process.exit(1);
    }
    
    console.log('Configuration:');
    console.log(`  SQLite: ${config.sqlitePath}`);
    console.log(`  MySQL: ${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`);
    console.log('');
    
    // Load dependencies
    let Database, mysql;
    try {
        Database = require('better-sqlite3');
        mysql = require('mysql2/promise');
    } catch (err) {
        console.error('ERROR: Missing required dependencies!');
        console.error('Please install: npm install better-sqlite3 mysql2');
        console.error('Error:', err.message);
        process.exit(1);
    }
    
    // Connect to SQLite
    console.log('[1/5] Connecting to SQLite database...');
    let sqliteDb;
    try {
        sqliteDb = new Database(config.sqlitePath, { readonly: true });
        console.log('✓ Connected to SQLite\n');
    } catch (err) {
        console.error('ERROR: Failed to connect to SQLite:', err.message);
        process.exit(1);
    }
    
    // Connect to MySQL
    console.log('[2/5] Connecting to MySQL database...');
    let mysqlConn;
    try {
        mysqlConn = await mysql.createConnection({
            host: config.mysql.host,
            port: config.mysql.port,
            user: config.mysql.user,
            password: config.mysql.password,
            database: config.mysql.database,
            multipleStatements: true
        });
        console.log('✓ Connected to MySQL\n');
    } catch (err) {
        console.error('ERROR: Failed to connect to MySQL:', err.message);
        console.error('Please check:');
        console.error('  1. MySQL server is running');
        console.error('  2. Database exists (run sql/schema.sql first)');
        console.error('  3. User has proper permissions');
        console.error('  4. Connection details are correct');
        sqliteDb.close();
        process.exit(1);
    }
    
    try {
        // Ensure tables exist (in case schema wasn't run)
        console.log('[3/5] Ensuring MySQL tables exist...');
        await mysqlConn.query(`
            CREATE TABLE IF NOT EXISTS kv_store (
                \`key\` VARCHAR(255) NOT NULL PRIMARY KEY,
                value LONGTEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_updated (updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        await mysqlConn.query(`
            CREATE TABLE IF NOT EXISTS tickets (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                ticket_id VARCHAR(255) NOT NULL,
                ticket_type VARCHAR(100),
                server VARCHAR(255),
                username VARCHAR(255),
                steam_id VARCHAR(255),
                responses TEXT,
                created_at BIGINT,
                close_time BIGINT,
                close_type VARCHAR(100),
                close_user VARCHAR(255),
                close_user_id VARCHAR(255),
                close_reason TEXT,
                transcript_url VARCHAR(500),
                global_ticket_number VARCHAR(255),
                INDEX idx_user_id (user_id),
                INDEX idx_ticket_id (ticket_id),
                INDEX idx_ticket_type (ticket_type),
                INDEX idx_server (server),
                INDEX idx_close_user_id (close_user_id),
                INDEX idx_created_at (created_at),
                INDEX idx_close_time (close_time),
                UNIQUE KEY unique_user_ticket (user_id, ticket_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        await mysqlConn.query(`
            CREATE TABLE IF NOT EXISTS transcript_index (
                filename VARCHAR(255) NOT NULL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                ticket_id VARCHAR(255) NOT NULL,
                ticket_type VARCHAR(100),
                INDEX idx_user_id (user_id),
                INDEX idx_ticket_id (ticket_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        await mysqlConn.query(`
            CREATE TABLE IF NOT EXISTS applications (
                id VARCHAR(255) PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                username VARCHAR(255),
                type VARCHAR(100),
                server VARCHAR(255),
                stage VARCHAR(50) NOT NULL,
                created_at BIGINT,
                updated_at BIGINT,
                responses TEXT,
                INDEX idx_user_id (user_id),
                INDEX idx_type (type),
                INDEX idx_stage (stage)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        await mysqlConn.query(`
            CREATE TABLE IF NOT EXISTS application_tickets (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                application_id VARCHAR(255) NOT NULL,
                ticket_id VARCHAR(255),
                channel_id VARCHAR(255),
                link_type VARCHAR(50),
                created_at BIGINT,
                INDEX idx_application_id (application_id),
                INDEX idx_ticket_id (ticket_id),
                FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        await mysqlConn.query(`
            CREATE TABLE IF NOT EXISTS application_history (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                application_id VARCHAR(255) NOT NULL,
                stage VARCHAR(50),
                changed_at BIGINT,
                changed_by VARCHAR(255),
                note TEXT,
                INDEX idx_application_id (application_id),
                FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        await mysqlConn.query(`
            CREATE TABLE IF NOT EXISTS application_comments (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                application_id VARCHAR(255) NOT NULL,
                created_at BIGINT,
                created_by VARCHAR(255),
                comment TEXT,
                INDEX idx_application_id (application_id),
                FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        console.log('✓ Tables ready\n');
        
        // Migrate kv_store entries
        console.log('[4/5] Migrating key-value store entries...');
        const kvStatement = sqliteDb.prepare('SELECT key, value FROM json WHERE key IS NOT NULL');
        const kvRows = kvStatement.all();
        let kvCount = 0;
        let kvSkipped = 0;
        
        for (const row of kvRows) {
            try {
                const key = row.key;
                let value = row.value;
                
                // Parse JSON if needed (quick.db stores as JSON strings)
                if (typeof value === 'string') {
                    try {
                        value = JSON.parse(value);
                        value = typeof value === 'object' ? JSON.stringify(value) : value;
                    } catch {
                        // Not JSON, use as-is
                    }
                } else if (typeof value === 'object') {
                    value = JSON.stringify(value);
                }
                
                await mysqlConn.query(
                    'INSERT INTO kv_store (`key`, value, updated_at) VALUES (?, ?, NOW()) ' +
                    'ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
                    [key, value, value]
                );
                kvCount++;
                
                if (kvCount % 100 === 0) {
                    process.stdout.write(`\r  Migrated ${kvCount} entries...`);
                }
            } catch (err) {
                kvSkipped++;
                if (kvSkipped <= 5) {
                    console.error(`\n  Warning: Skipped key ${row.key}: ${err.message}`);
                }
            }
        }
        console.log(`\r✓ Migrated ${kvCount} key-value entries (${kvSkipped} skipped)\n`);
        
        // Migrate tickets from PlayerStats
        console.log('[5/5] Migrating tickets from PlayerStats...');
        const playerStats = kvRows.find(r => r.key === 'PlayerStats');
        let playerStatsData = null;
        
        if (playerStats && playerStats.value) {
            try {
                playerStatsData = typeof playerStats.value === 'string' 
                    ? JSON.parse(playerStats.value) 
                    : playerStats.value;
            } catch (err) {
                console.error('Warning: Could not parse PlayerStats:', err.message);
            }
        }
        
        let ticketCount = 0;
        let ticketSkipped = 0;
        
        if (playerStatsData && typeof playerStatsData === 'object') {
            for (const [userId, userData] of Object.entries(playerStatsData)) {
                if (!userData || !userData.ticketLogs) continue;
                
                for (const [ticketId, ticket] of Object.entries(userData.ticketLogs)) {
                    if (!ticket) continue;
                    
                    // Only migrate closed tickets (they have transcript URL or close info)
                    const isClosed = !!(ticket.closeTime || ticket.closeType || ticket.transcriptURL);
                    
                    try {
                        const toSeconds = (val) => {
                            if (typeof val !== 'number') return null;
                            return val > 2e10 ? Math.floor(val / 1000) : Math.floor(val);
                        };
                        
                        await mysqlConn.query(`
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
                        `, [
                            String(userId),
                            String(ticketId),
                            ticket.ticketType || null,
                            ticket.server || null,
                            ticket.username || null,
                            ticket.steamId || null,
                            ticket.responses || null,
                            toSeconds(ticket.createdAt),
                            toSeconds(ticket.closeTime),
                            ticket.closeType || null,
                            ticket.closeUser || null,
                            ticket.closeUserID || null,
                            ticket.closeReason || null,
                            ticket.transcriptURL || null,
                            ticket.globalTicketNumber || ticketId || null
                        ]);
                        
                        // Update transcript index if transcript URL exists
                        if (ticket.transcriptURL) {
                            const url = String(ticket.transcriptURL);
                            const filename = url.split('/').pop();
                            if (filename && filename.endsWith('.html')) {
                                const baseFilename = filename.replace(/\.full\.html$/i, '.html');
                                
                                await mysqlConn.query(`
                                    INSERT INTO transcript_index (filename, user_id, ticket_id, ticket_type)
                                    VALUES (?, ?, ?, ?)
                                    ON DUPLICATE KEY UPDATE ticket_type = VALUES(ticket_type)
                                `, [
                                    baseFilename,
                                    String(userId),
                                    String(ticketId),
                                    ticket.ticketType || null
                                ]);
                                
                                // Also store .full.html variant
                                if (!filename.endsWith('.full.html')) {
                                    const fullFilename = filename.replace(/\.html$/i, '.full.html');
                                    await mysqlConn.query(`
                                        INSERT INTO transcript_index (filename, user_id, ticket_id, ticket_type)
                                        VALUES (?, ?, ?, ?)
                                        ON DUPLICATE KEY UPDATE ticket_type = VALUES(ticket_type)
                                    `, [fullFilename, String(userId), String(ticketId), ticket.ticketType || null]);
                                }
                            }
                        }
                        
                        ticketCount++;
                        
                        if (ticketCount % 100 === 0) {
                            process.stdout.write(`\r  Migrated ${ticketCount} tickets...`);
                        }
                    } catch (err) {
                        ticketSkipped++;
                        if (ticketSkipped <= 5) {
                            console.error(`\n  Warning: Skipped ticket ${userId}:${ticketId}: ${err.message}`);
                        }
                    }
                }
            }
        }
        console.log(`\r✓ Migrated ${ticketCount} tickets (${ticketSkipped} skipped)\n`);
        
        // Migrate applications
        console.log('[6/6] Migrating applications...');
        const applications = kvRows.find(r => r.key === 'Applications');
        let applicationsData = null;
        
        if (applications && applications.value) {
            try {
                applicationsData = typeof applications.value === 'string'
                    ? JSON.parse(applications.value)
                    : applications.value;
            } catch (err) {
                console.error('Warning: Could not parse Applications:', err.message);
            }
        }
        
        let appCount = 0;
        let appSkipped = 0;
        
        if (applicationsData && typeof applicationsData === 'object') {
            for (const [appId, app] of Object.entries(applicationsData)) {
                if (!app || !app.id) continue;
                
                try {
                    await mysqlConn.query(`
                        INSERT INTO applications (id, user_id, username, type, server, stage, created_at, updated_at, responses)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            stage = COALESCE(VALUES(stage), stage),
                            updated_at = COALESCE(VALUES(updated_at), updated_at),
                            responses = COALESCE(VALUES(responses), responses)
                    `, [
                        app.id,
                        app.userId || null,
                        app.username || null,
                        app.type || null,
                        app.server || null,
                        app.stage || 'Submitted',
                        app.createdAt || Date.now(),
                        app.updatedAt || Date.now(),
                        app.responses || null
                    ]);
                    
                    // Migrate application tickets
                    if (app.tickets && Array.isArray(app.tickets)) {
                        for (const ticket of app.tickets) {
                            try {
                                await mysqlConn.query(`
                                    INSERT INTO application_tickets (application_id, ticket_id, channel_id, link_type, created_at)
                                    VALUES (?, ?, ?, ?, ?)
                                    ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)
                                `, [
                                    app.id,
                                    ticket.ticketId || null,
                                    ticket.channelId || null,
                                    ticket.type || 'comms',
                                    ticket.createdAt || Date.now()
                                ]);
                            } catch (err) {
                                // Skip ticket links on error
                            }
                        }
                    }
                    
                    // Migrate application history
                    if (app.history && Array.isArray(app.history)) {
                        for (const hist of app.history) {
                            try {
                                await mysqlConn.query(`
                                    INSERT INTO application_history (application_id, stage, changed_at, changed_by, note)
                                    VALUES (?, ?, ?, ?, ?)
                                `, [
                                    app.id,
                                    hist.stage || null,
                                    hist.at || Date.now(),
                                    hist.by || null,
                                    hist.note || null
                                ]);
                            } catch (err) {
                                // Skip history entries on error
                            }
                        }
                    }
                    
                    // Migrate application comments
                    if (app.comments && Array.isArray(app.comments)) {
                        for (const comment of app.comments) {
                            try {
                                await mysqlConn.query(`
                                    INSERT INTO application_comments (application_id, created_at, created_by, comment)
                                    VALUES (?, ?, ?, ?)
                                `, [
                                    app.id,
                                    comment.at || Date.now(),
                                    comment.by || null,
                                    comment.comment || null
                                ]);
                            } catch (err) {
                                // Skip comments on error
                            }
                        }
                    }
                    
                    appCount++;
                    
                    if (appCount % 50 === 0) {
                        process.stdout.write(`\r  Migrated ${appCount} applications...`);
                    }
                } catch (err) {
                    appSkipped++;
                    if (appSkipped <= 5) {
                        console.error(`\n  Warning: Skipped application ${appId}: ${err.message}`);
                    }
                }
            }
        }
        console.log(`\r✓ Migrated ${appCount} applications (${appSkipped} skipped)\n`);
        
        // Summary
        console.log('========================================');
        console.log('Migration Complete!');
        console.log('========================================');
        console.log(`  Key-Value Entries: ${kvCount} (${kvSkipped} skipped)`);
        console.log(`  Tickets:           ${ticketCount} (${ticketSkipped} skipped)`);
        console.log(`  Applications:     ${appCount} (${appSkipped} skipped)`);
        console.log('========================================\n');
        
        // Verify some counts
        try {
            const [kvCountRows] = await mysqlConn.query('SELECT COUNT(*) as count FROM kv_store');
            const [ticketCountRows] = await mysqlConn.query('SELECT COUNT(*) as count FROM tickets');
            const [appCountRows] = await mysqlConn.query('SELECT COUNT(*) as count FROM applications');
            
            console.log('MySQL Database Counts:');
            console.log(`  kv_store entries: ${kvCountRows[0].count}`);
            console.log(`  tickets:          ${ticketCountRows[0].count}`);
            console.log(`  applications:     ${appCountRows[0].count}`);
            console.log('');
        } catch (err) {
            console.error('Warning: Could not verify counts:', err.message);
        }
        
    } catch (err) {
        console.error('\nERROR during migration:', err);
        throw err;
    } finally {
        sqliteDb.close();
        await mysqlConn.end();
        console.log('✓ Connections closed');
    }
}

// Run if called directly
if (require.main === module) {
    main().then(() => {
        console.log('✓ Migration completed successfully!');
        process.exit(0);
    }).catch(err => {
        console.error('\n✗ Migration failed:', err);
        process.exit(1);
    });
}

module.exports = { main };

