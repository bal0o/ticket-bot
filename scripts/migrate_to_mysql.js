/**
 * Migration script from quick.db to MySQL
 * Run this once to migrate all data
 */

// Note: quickdb.js has been removed - this migration script should only be run once
// If you need to migrate again, restore the old quickdb.js temporarily
const { QuickDB } = require('quick.db');
let quickDbInstance = null;
function createQuickDB() {
    if (!quickDbInstance) {
        quickDbInstance = new QuickDB({ filePath: './data/json.sqlite' });
    }
    return quickDbInstance;
}
const mysql = require('mysql2/promise');
const config = require('../config/config.json');

async function migrate() {
    console.log('[migrate] Starting migration from quick.db to MySQL...');
    
    // Connect to MySQL
    const dbConfig = config.database || {};
    const mysqlConn = await mysql.createConnection({
        host: dbConfig.host || 'localhost',
        port: dbConfig.port || 3306,
        user: dbConfig.user || 'root',
        password: dbConfig.password || '',
        database: dbConfig.database || 'ticketbot',
        multipleStatements: true
    });
    
    console.log('[migrate] Connected to MySQL');
    
    // Load quick.db
    const quickDb = createQuickDB();
    console.log('[migrate] Connected to quick.db');
    
    try {
        // Migrate all kv_store entries
        console.log('[migrate] Migrating key-value store entries...');
        const allEntries = await quickDb.all();
        let kvCount = 0;
        
        for (const entry of allEntries) {
            const key = entry.key || entry.ID;
            if (!key) continue;
            
            const value = entry.value;
            const jsonValue = typeof value === 'object' ? JSON.stringify(value) : value;
            
            await mysqlConn.query(
                'INSERT INTO kv_store (`key`, value) VALUES (?, ?) ' +
                'ON DUPLICATE KEY UPDATE value = ?',
                [key, jsonValue, jsonValue]
            );
            kvCount++;
            
            if (kvCount % 100 === 0) {
                console.log(`[migrate] Migrated ${kvCount} kv entries...`);
            }
        }
        console.log(`[migrate] Migrated ${kvCount} key-value entries`);
        
        // Migrate tickets from PlayerStats
        console.log('[migrate] Migrating tickets from PlayerStats...');
        const playerStats = await quickDb.get('PlayerStats');
        let ticketCount = 0;
        
        if (playerStats && typeof playerStats === 'object') {
            for (const [userId, userData] of Object.entries(playerStats)) {
                if (!userData || !userData.ticketLogs) continue;
                
                for (const [ticketId, ticket] of Object.entries(userData.ticketLogs)) {
                    if (!ticket) continue;
                    
                    // Only migrate closed tickets (or all if needed)
                    const isClosed = !!(ticket.closeTime || ticket.closeType || ticket.transcriptURL);
                    
                    try {
                        await mysqlConn.query(`
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
                            String(userId),
                            String(ticketId),
                            ticket.ticketType || null,
                            ticket.server || null,
                            ticket.username || null,
                            ticket.steamId || null,
                            ticket.responses || null,
                            ticket.createdAt ? Math.floor(ticket.createdAt) : null,
                            ticket.closeTime ? Math.floor(ticket.closeTime) : null,
                            ticket.closeType || null,
                            ticket.closeUser || null,
                            ticket.closeUserID || null,
                            ticket.closeReason || null,
                            ticket.transcriptURL || null,
                            ticket.globalTicketNumber || null
                        ]);
                        
                        ticketCount++;
                        
                        if (ticketCount % 100 === 0) {
                            console.log(`[migrate] Migrated ${ticketCount} tickets...`);
                        }
                    } catch (err) {
                        console.error(`[migrate] Error migrating ticket ${userId}:${ticketId}:`, err.message);
                    }
                }
            }
        }
        console.log(`[migrate] Migrated ${ticketCount} tickets`);
        
        // Migrate applications
        console.log('[migrate] Migrating applications...');
        const applications = await quickDb.get('Applications');
        let appCount = 0;
        
        if (applications && typeof applications === 'object') {
            for (const [appId, app] of Object.entries(applications)) {
                if (!app || !app.id) continue;
                
                try {
                    await mysqlConn.query(`
                        INSERT INTO applications (id, user_id, username, type, server, stage, created_at, updated_at, responses)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            stage = VALUES(stage),
                            updated_at = VALUES(updated_at),
                            responses = VALUES(responses)
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
                        }
                    }
                    
                    // Migrate application history
                    if (app.history && Array.isArray(app.history)) {
                        for (const hist of app.history) {
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
                        }
                    }
                    
                    // Migrate application comments
                    if (app.comments && Array.isArray(app.comments)) {
                        for (const comment of app.comments) {
                            await mysqlConn.query(`
                                INSERT INTO application_comments (application_id, created_at, created_by, comment)
                                VALUES (?, ?, ?, ?)
                            `, [
                                app.id,
                                comment.at || Date.now(),
                                comment.by || null,
                                comment.comment || null
                            ]);
                        }
                    }
                    
                    appCount++;
                } catch (err) {
                    console.error(`[migrate] Error migrating application ${appId}:`, err.message);
                }
            }
        }
        console.log(`[migrate] Migrated ${appCount} applications`);
        
        // Migrate other indexes and stats (these can be reconstructed if needed)
        console.log('[migrate] Migration complete!');
        console.log('[migrate] Summary:');
        console.log(`  - ${kvCount} key-value entries`);
        console.log(`  - ${ticketCount} tickets`);
        console.log(`  - ${appCount} applications`);
        
    } catch (err) {
        console.error('[migrate] Migration error:', err);
        throw err;
    } finally {
        await mysqlConn.end();
    }
}

if (require.main === module) {
    migrate().then(() => {
        console.log('[migrate] Done!');
        process.exit(0);
    }).catch(err => {
        console.error('[migrate] Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { migrate };

