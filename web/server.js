const path = require('path');
const fs = require('fs');
// Environment variables are now loaded from config.json

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const { createDB } = require('../utils/quickdb');
const metrics = require('../utils/metrics');
const permissions = require('../utils/permissions');

const config = require('../config/config.json');
const handlerOptions = require('../content/handler/options.json');
const applications = require('../utils/applications');

// --- Config ---
const WEB_ENABLED = config.web?.enabled !== false;
const HOST = config.web?.host || '0.0.0.0';
const PORT = config.web?.port || 3050;
const SESSION_SECRET = config.web?.session_secret || 'change_me';
const DISCORD_CLIENT_ID = config.web?.discord_oauth?.client_id || '';
const DISCORD_CLIENT_SECRET = config.web?.discord_oauth?.client_secret || '';
const DISCORD_CALLBACK_URL = config.web?.discord_oauth?.callback_url || 'http://localhost:3050/auth/callback';
const DISCORD_SCOPES = config.web?.discord_oauth?.scopes || ['identify'];
const STAFF_GUILD_ID = config.web?.staff_guild_id || config.channel_ids?.staff_guild_id;
const STAFF_ROLE_IDS = new Set((config.web?.roles?.staff_role_ids || []).filter(Boolean));
const ADMIN_ROLE_IDS = new Set((config.web?.roles?.admin_role_ids || []).filter(Boolean));
const BOT_TOKEN = config.tokens?.bot_token;
const TRANSCRIPT_DIR = path.resolve(process.cwd(), config.transcript_settings?.save_path || './transcripts/');

if (!WEB_ENABLED) {
    console.log('[web] Disabled by config.');
    process.exit(0);
}
if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    console.warn('[web] Missing Discord OAuth client ID/secret. Set in config.web.discord_oauth.');
}
if (!BOT_TOKEN) {
    console.warn('[web] Missing bot_token in config.tokens. Guild role checks will fail.');
}

// --- Databases ---
const db = createDB(); // persist to ./data/json.sqlite
// Admin overrides removed per requirements; no external permissions DB

// --- Auth setup ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    callbackURL: DISCORD_CALLBACK_URL,
    scope: DISCORD_SCOPES
}, (accessToken, refreshToken, profile, done) => {
    // Only need basic identity; roles will be resolved via bot token API
    const user = {
        id: profile.id,
        username: profile.username,
        discriminator: profile.discriminator,
        avatar: profile.avatar
    };
    return done(null, user);
}));

// --- Helpers ---
async function fetchGuildMemberRoles(userId) {
    if (!BOT_TOKEN || !STAFF_GUILD_ID) return [];
    try {
        const res = await axios.get(`https://discord.com/api/v10/guilds/${STAFF_GUILD_ID}/members/${userId}` , {
            headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        return Array.isArray(res.data?.roles) ? res.data.roles : [];
    } catch (e) {
        return [];
    }
}

async function getRoleFlags(userId) {
    const roles = new Set(await fetchGuildMemberRoles(userId));
    let isStaff = false;
    let isAdmin = false;
    for (const rid of roles) {
        if (ADMIN_ROLE_IDS.has(rid)) isAdmin = true;
        if (STAFF_ROLE_IDS.has(rid)) isStaff = true;
    }
    // Admin/staff solely via Discord roles; admins imply staff
    if (isAdmin) isStaff = true;
    return { isStaff, isAdmin, roleIds: Array.from(roles) };
}

function userCanSeeTicketType(roleIds, ticketType) {
    try {
        const adminIds = new Set((config.web?.roles?.admin_role_ids || []).filter(Boolean));
        // Fast path: admin roles
        for (const rid of roleIds) if (adminIds.has(rid)) return true;
        return permissions.userHasAccessToTicketType({ userRoleIds: roleIds, ticketType, config, adminRoleIds: Array.from(adminIds) });
    } catch (_) { return false; }
}

async function getUsernamesMap(ids = []) {
    const map = {};
    if (!BOT_TOKEN || !Array.isArray(ids) || ids.length === 0) return map;
    for (const id of ids) {
        if (!id || map[id]) continue;
        try {
            const r = await axios.get(`https://discord.com/api/v10/users/${id}`, {
                headers: { Authorization: `Bot ${BOT_TOKEN}` }
            });
            if (r && r.data && r.data.username) map[id] = r.data.username;
        } catch (_) {}
    }
    return map;
}
async function createGuildChannel({ name, type = 0, topic = '', parentId = '', permissionOverwrites = [] }) {
    if (!BOT_TOKEN || !STAFF_GUILD_ID) throw new Error('Missing bot token or staff guild');
    const body = { name, type, topic };
    if (parentId) body.parent_id = parentId;
    if (permissionOverwrites && permissionOverwrites.length > 0) body.permission_overwrites = permissionOverwrites;
    const res = await axios.post(`https://discord.com/api/v10/guilds/${STAFF_GUILD_ID}/channels`, body, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    return res.data;
}

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
}

function sanitizeFilename(input) {
    return input.replace(/[^a-zA-Z0-9_.\-]/g, '');
}

async function findOwnerByFilename(filename) {
    // Accept either user-facing (.html) or staff/full (.full.html) filenames
    const candidates = new Set([filename]);
    if (/\.full\.html$/i.test(filename)) candidates.add(filename.replace(/\.full\.html$/i, '.html'));
    if (/\.html$/i.test(filename) && !/\.full\.html$/i.test(filename)) candidates.add(filename.replace(/\.html$/i, '.full.html'));

    const all = await db.all();
    const candList = Array.from(candidates);
    for (const row of all) {
        const key = row.id || row.ID || row.key; // quick.db variants
        if (!key || !key.startsWith('PlayerStats.')) continue;
        if (!key.includes('.transcriptURL')) continue;
        const url = row.value ?? row.data;
        if (typeof url !== 'string') continue;
        // Match any candidate regardless of preceding slash
        if (candList.some(c => url.endsWith(c) || url.endsWith('/' + c) || url === c)) {
            const parts = key.split('.');
            return parts[1];
        }
    }
    // Fallback: scan each user's ticket logs
    for (const row of all) {
        const key = row.id || row.ID || row.key;
        if (!key || !key.startsWith('PlayerStats.') || !key.endsWith('.ticketLogs')) continue;
        const userId = key.split('.')[1];
        const logs = row.value ?? row.data;
        if (!logs || typeof logs !== 'object') continue;
        for (const ticketId of Object.keys(logs)) {
            const t = logs[ticketId];
            const url = t?.transcriptURL;
            if (typeof url !== 'string') continue;
            if (candList.some(c => url.endsWith(c) || url.endsWith('/' + c) || url === c)) {
                return userId;
            }
        }
    }
    return null;
}

function userHasOverride(_userId, _filename) {
    return false;
}

async function findTicketContextByFilename(filename) {
    // Return { ownerId, ticketId, ticketType } if we can resolve it from DB
    try {
        // Build candidate filenames we consider equivalent
        const candidates = new Set([filename]);
        if (/\.staff\.html$/i.test(filename)) candidates.add(filename.replace(/\.staff\.html$/i, '.full.html'));
        if (/\.full\.html$/i.test(filename)) candidates.add(filename.replace(/\.full\.html$/i, '.html'));
        if (/\.html$/i.test(filename) && !/\.full\.html$/i.test(filename)) candidates.add(filename.replace(/\.html$/i, '.full.html'));
        const candList = Array.from(candidates).map(c => c.toLowerCase());
        // Preferred: scan aggregated PlayerStats object for reliability
        try {
            const ps = await db.get('PlayerStats');
            if (ps && typeof ps === 'object') {
                for (const ownerId of Object.keys(ps)) {
                    const logs = ps[ownerId]?.ticketLogs || {};
                    for (const ticketId of Object.keys(logs)) {
                        const t = logs[ticketId];
                        const url = (t && t.transcriptURL) ? String(t.transcriptURL) : '';
                        const urlLower = url.toLowerCase();
                        if (candList.some(c => urlLower.endsWith(c) || urlLower.endsWith('/' + c) || urlLower === c)) {
                            const ticketType = t.ticketType || null;
                            return { ownerId, ticketId, ticketType };
                        }
                    }
                }
            }
        } catch (_) {}
        const all = await db.all();
        for (const row of all) {
            const key = row.id || row.ID || row.key;
            if (!key) continue;
            const m = key.match(/^PlayerStats\.(\d+)\.ticketLogs\.(\d+)\.transcriptURL$/);
            if (!m) continue;
            const url = (row.value ?? row.data);
            if (typeof url !== 'string') continue;
            const urlLower = url.toLowerCase();
            if (!candList.some(c => urlLower.endsWith(c) || urlLower.endsWith('/' + c) || urlLower === c)) continue;
            const ownerId = m[1];
            const ticketId = m[2];
            // Try to get ticketType fast via get
            let ticketType = null;
            try { ticketType = await db.get(`PlayerStats.${ownerId}.ticketLogs.${ticketId}.ticketType`); } catch (_) {}
            if (!ticketType) {
                // Fallback within cached rows
                const typeKey = `PlayerStats.${ownerId}.ticketLogs.${ticketId}.ticketType`;
                const tRow = all.find(r => (r.id||r.ID||r.key) === typeKey);
                if (tRow) ticketType = tRow.value ?? tRow.data;
            }
            return { ownerId, ticketId, ticketType };
        }

        // Secondary fallback: derive ticketId from filename suffix (e.g., ...-0003.*) and look up by id
        const base = String(filename).replace(/\.(?:full|staff)?\.html$/i, '').replace(/\.html$/i, '');
        const idMatch = base.match(/-(\d{1,8})$/);
        if (idMatch) {
            const ticketId = idMatch[1];
            // Try via aggregated object first
            try {
                const ps = await db.get('PlayerStats');
                if (ps && typeof ps === 'object') {
                    for (const ownerId of Object.keys(ps)) {
                        const t = ps[ownerId]?.ticketLogs?.[ticketId];
                        if (t && (t.ticketType || t.transcriptURL)) {
                            const ticketType = t.ticketType || null;
                            return { ownerId, ticketId, ticketType };
                        }
                    }
                }
            } catch (_) {}
            for (const row of all) {
                const key = row.id || row.ID || row.key;
                if (!key) continue;
                const m2 = key.match(/^PlayerStats\.(\d+)\.ticketLogs\.(\d+)\.ticketType$/);
                if (!m2) continue;
                if (m2[2] !== ticketId) continue;
                const ownerId = m2[1];
                const ticketType = row.value ?? row.data;
                return { ownerId, ticketId, ticketType };
            }
        }
    } catch (_) {}
    return null;
}

async function canViewTranscript(userId, filename) {
    console.log('[auth] canViewTranscript start', { userId, filename });
    const { isStaff, isAdmin, roleIds } = await getRoleFlags(userId);
    console.log('[auth] roleFlags', { isStaff, isAdmin, roleCount: roleIds.length });
    if (isAdmin) { console.log('[auth] allow: admin'); return true; }
    if (userHasOverride(userId, filename)) { console.log('[auth] allow: manual override'); return true; }
    // Fast-path: check the current user's own ticket logs directly
    try {
        const candList = [filename];
        if (/\.full\.html$/i.test(filename)) candList.push(filename.replace(/\.full\.html$/i, '.html'));
        if (/\.html$/i.test(filename) && !/\.full\.html$/i.test(filename)) candList.push(filename.replace(/\.html$/i, '.full.html'));
        const myLogs = await db.get(`PlayerStats.${userId}.ticketLogs`) || {};
        for (const tid of Object.keys(myLogs)) {
            const t = myLogs[tid];
            const url = t?.transcriptURL;
            if (typeof url !== 'string') continue;
            if (candList.some(c => url.endsWith(c) || url.endsWith('/' + c) || url === c)) {
                console.log('[auth] allow: owner via own logs', { ticketId: tid, url });
                return true;
            }
        }
    } catch (e) { console.log('[auth] own logs check error', e?.message || e); }
    const ownerId = await findOwnerByFilename(filename);
    console.log('[auth] owner lookup', { ownerId });
    if (ownerId && ownerId === userId) { console.log('[auth] allow: owner via reverse lookup'); return true; }
    // If not owner/admin, see if staff but only with per-type permission; infer type from DB
    if (isStaff) {
        try {
            const ctx = await findTicketContextByFilename(filename);
            console.log('[auth] staff mode; context', ctx);
            if (ctx && ctx.ticketType) {
                const can = userCanSeeTicketType(roleIds, ctx.ticketType);
                console.log('[auth] staff type permission', { ticketType: ctx.ticketType, can });
                if (can) return true;
            } else {
                console.log('[auth] staff: could not infer ticketType for', { filename });
            }
        } catch (e) { console.log('[auth] staff check error', e?.message || e); }
    }
    console.log('[auth] deny: no rule matched', { userId, filename, isStaff, isAdmin });
    return false;
}

// --- App ---
const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: true
    },
    proxy: true
}));
app.use(passport.initialize());
app.use(passport.session());

app.use(async (req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.roleFlags = req.user ? await getRoleFlags(req.user.id) : { isStaff: false, isAdmin: false, roleIds: [] };
    // Applications visibility: admins or explicit application admin role id
    try {
        const appAdminRoleId = config.role_ids?.application_admin_role_id;
        const rf = res.locals.roleFlags || { isAdmin: false, roleIds: [] };
        res.locals.canSeeApplications = !!(rf.isAdmin || (appAdminRoleId && rf.roleIds && rf.roleIds.includes(appAdminRoleId)));
    } catch (_) {
        res.locals.canSeeApplications = false;
    }
    next();
});

// Expose Prometheus metrics for Grafana/Prometheus scrape
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', metrics.registry.contentType);
        res.end(await metrics.registry.metrics());
    } catch (e) {
        res.status(500).send('metrics error');
    }
});

app.get('/', (req, res) => {
    return res.redirect('/my');
});

app.get('/login', (req, res, next) => {
    console.log('[web] /login start');
    next();
}, passport.authenticate('discord'));
app.get('/auth/callback', (req, res, next) => {
    console.log('[web] /auth/callback hit');
    next();
}, passport.authenticate('discord', { failureRedirect: '/auth/failure' }), (req, res) => {
    const redirectTo = req.session.returnTo || '/my';
    delete req.session.returnTo;
    res.redirect(redirectTo);
});
app.get('/auth/failure', (req, res) => {
    res.status(401).send('Discord authentication failed. Please verify your OAuth client settings and callback URL.');
});
app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

app.get('/my', ensureAuth, async (req, res) => {
    const ticketLogs = await db.get(`PlayerStats.${req.user.id}.ticketLogs`) || {};
    const list = Object.keys(ticketLogs)
        .map(tid => {
            const t = ticketLogs[tid] || {};
            const url = t.transcriptURL || '';
            let filename = url ? url.split('/').pop() : null;
            if (filename && filename.endsWith('.full.html')) {
                filename = filename.replace(/\.full\.html$/, '.html');
            }
            return {
                ticketId: tid,
                ticketType: t.ticketType || 'Unknown',
                createdAt: t.createdAt ? new Date(t.createdAt * 1000) : null,
                transcriptFilename: filename,
                transcriptAvailable: !!filename,
                isClosed: !!(t.closeTime || t.closeType || filename)
            };
        })
        .filter(x => x.isClosed)
        .sort((a,b) => (b.createdAt?.getTime()||0) - (a.createdAt?.getTime()||0));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const tickets = list.slice(start, start + limit);
    res.render('my_tickets', { tickets, pagination: { page, limit, total, totalPages }, query: req.query });
});

// Health check
app.get('/health', (req, res) => res.send('ok'));

// Applications - list
app.get('/applications', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const stage = (req.query.stage || '').trim();
    let items = await applications.listApplications({ stage: stage || undefined });
    // By default, show only active applications (exclude Approved, Denied, Archived)
    if (!stage && !req.query.all) {
        items = items.filter(x => !['Approved','Denied','Archived'].includes(x.stage));
    }
    items.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const paged = items.slice(start, start + limit);
    // Pass request query and pagination to template
    res.render('applications_index', { items: paged, stage, request: { query: req.query }, query: req.query, pagination: { page, limit, total, totalPages } });
});

// Applications - detail
app.get('/applications/:id', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    // Resolve display names for history/comments
    const ids = new Set();
    (appRec.history || []).forEach(h => { if (h.by) ids.add(String(h.by)); });
    (appRec.comments || []).forEach(c => { if (c.by) ids.add(String(c.by)); });
    const userNames = await getUsernamesMap(Array.from(ids));
    // Compute nextStage from config
    const stages = (config.applications && Array.isArray(config.applications.stages)) ? config.applications.stages : ['Submitted','Initial Review','Background Check','Interview','Final Decision','Archived'];
    const idx = Math.max(0, stages.indexOf(appRec.stage || 'Submitted')) + 1;
    const nextStage = stages[Math.min(idx, stages.length - 1)] || 'Initial Review';
    const canAdmin = (await getRoleFlags(req.user.id)).isAdmin || (config.role_ids.application_admin_role_id && (await fetchGuildMemberRoles(req.user.id)).includes(config.role_ids.application_admin_role_id));

    // Compute prev/next application IDs (default list: active apps sorted by updatedAt desc)
    let prevId = null, nextId = null;
    try {
        let items = await applications.listApplications({});
        // By default, show only active applications (exclude Approved, Denied, Archived)
        items = items.filter(x => !['Approved','Denied','Archived'].includes(x.stage));
        items.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
        const idx = items.findIndex(x => x.id === appId);
        if (idx !== -1) {
            if (idx > 0) nextId = items[idx - 1]?.id || null; // newer item (previous in list)
            if (idx < items.length - 1) prevId = items[idx + 1]?.id || null; // older item (next in list)
        }
    } catch (_) {}
    
            // Check if the communication channel actually exists
        let channelExists = false;
        let lastTicket = null;
        if (appRec.tickets && appRec.tickets.length > 0) {
            // Only consider communication channels explicitly created via the web (type === 'comms')
            const commsTickets = appRec.tickets.filter(t => t && t.type === 'comms');
            lastTicket = commsTickets.length > 0 ? commsTickets[commsTickets.length - 1] : null;
            if (lastTicket && lastTicket.channelId) {
                try {
                    // Try to fetch the channel to see if it exists
                    const channelResponse = await axios.get(`https://discord.com/api/v10/channels/${lastTicket.channelId}`, {
                        headers: { Authorization: `Bot ${BOT_TOKEN}` }
                    });
                    channelExists = channelResponse.status === 200;
                    console.log(`Channel ${lastTicket.channelId} exists: ${channelExists}`);
                    
                    // If channel exists, check if it has the proper setup (close button)
                    if (channelExists) {
                        try {
                            const messagesResponse = await axios.get(`https://discord.com/api/v10/channels/${lastTicket.channelId}/messages?limit=10`, {
                                headers: { Authorization: `Bot ${BOT_TOKEN}` }
                            });
                            
                            // Check if any message has the close button
                            const hasCloseButton = messagesResponse.data.some(msg => 
                                msg.components && msg.components.some(comp => 
                                    comp.components && comp.components.some(btn => btn.custom_id === 'app_comm_close')
                                )
                            );
                            
                            if (!hasCloseButton) {
                                console.log(`Channel ${lastTicket.channelId} exists but missing close button, adding it...`);
                                // Add the close button message
                                await axios.post(`https://discord.com/api/v10/channels/${lastTicket.channelId}/messages`, {
                                    content: `📱 **Application Communication Channel**\n\nThis channel is for communicating with **${appRec.username}** about their application.\n\n**How it works:**\n• Messages you post here will be sent to the applicant via DM\n• The applicant can respond to your DMs and their responses will appear here\n• Use the close button below when communication is complete\n\n**Applicant:** <@${appRec.userId}>\n**Application Type:** ${appRec.type}\n**Current Stage:** ${appRec.stage}`,
                                    components: [
                                        { type: 1, components: [ { type: 2, style: 4, custom_id: 'app_comm_close', label: 'Close Communication', emoji: { name: '📝' } } ] }
                                    ]
                                }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
                            }
                        } catch (setupError) {
                            console.error('Failed to check/setup channel:', setupError?.response?.data || setupError);
                        }
                    }
                } catch (error) {
                    // Channel doesn't exist or we can't access it
                    channelExists = false;
                    if (error.response?.status === 404) {
                        console.log(`Channel ${lastTicket.channelId} not found (404) - this is expected if the channel was deleted`);
                    } else {
                        console.log(`Channel ${lastTicket.channelId} check failed:`, error.response?.status || error.message);
                    }
                }
            }
        }
    
    res.render('applications_detail', { 
        app: appRec, 
        canAdmin, 
        nextStage, 
        userNames, 
        stages,
        notification: req.query.notification,
        notificationType: req.query.type || 'info',
        channelExists,
        lastTicket,
        prevId,
        nextId
    });
});

// Applications - stage advance
app.post('/applications/:id/advance', ensureAuth, async (req, res) => {
    const roles = await fetchGuildMemberRoles(req.user.id);
    const isAdmin = roles.includes(config.role_ids.application_admin_role_id) || (await getRoleFlags(req.user.id)).isAdmin;
    if (!isAdmin) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    if (appRec.stage === 'Denied' || appRec.stage === 'Archived') return res.status(400).send('Application is closed');
    const stages = (config.applications && Array.isArray(config.applications.stages)) ? config.applications.stages : ['Submitted','Initial Review','Background Check','Interview','Final Decision','Archived'];
    const idx = Math.max(0, stages.indexOf(appRec.stage || 'Submitted')) + 1;
    const nextStage = stages[Math.min(idx, stages.length - 1)] || 'Initial Review';
    await applications.advanceStage(appId, nextStage, req.user.id, req.body.note || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - deny
app.post('/applications/:id/deny', ensureAuth, async (req, res) => {
    const roles = await fetchGuildMemberRoles(req.user.id);
    const isAdmin = roles.includes(config.role_ids.application_admin_role_id) || (await getRoleFlags(req.user.id)).isAdmin;
    if (!isAdmin) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    if (appRec.stage === 'Denied' || appRec.stage === 'Archived') return res.redirect(`/applications/${appId}`);
    await applications.deny(appId, req.user.id, req.body.note || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - archive
app.post('/applications/:id/archive', ensureAuth, async (req, res) => {
    const roles = await fetchGuildMemberRoles(req.user.id);
    const isAdmin = roles.includes(config.role_ids.application_admin_role_id) || (await getRoleFlags(req.user.id)).isAdmin;
    if (!isAdmin) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    if (appRec.stage === 'Archived') return res.redirect(`/applications/${appId}`);
    await applications.advanceStage(appId, 'Archived', req.user.id, req.body.note || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - comment
app.post('/applications/:id/comment', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    await applications.addComment(appId, req.user.id, req.body.comment || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - open communication ticket (new ticket linked to application)
app.post('/applications/:id/open_ticket', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    
    // Check if there's already an active communication channel for this application
    if (appRec.tickets && appRec.tickets.length > 0) {
        const lastTicket = appRec.tickets[appRec.tickets.length - 1];
        if (lastTicket && lastTicket.channelId) {
            try {
                // Check if the existing channel still exists
                const channelResponse = await axios.get(`https://discord.com/api/v10/channels/${lastTicket.channelId}`, {
                    headers: { Authorization: `Bot ${BOT_TOKEN}` }
                });
                if (channelResponse.status === 200) {
                    // Channel exists, redirect to application with warning
                    return res.redirect(`/applications/${appId}?notification=A communication channel is already open for this application!&type=error`);
                }
            } catch (error) {
                // Channel doesn't exist, we can create a new one
                console.log(`Existing channel ${lastTicket.channelId} not found, creating new one`);
            }
        }
    }
    
    try {
        const questionFile = require('../content/questions/application.json');
        const parentCategory = questionFile["ticket-category"] || '';
        const adminRoleId = config.role_ids.application_admin_role_id || config.role_ids.default_admin_role_id;

        // Viewer roles mirror application visibility: admin + staff roles from web.roles
        const viewerRoles = new Set();
        if (adminRoleId) viewerRoles.add(adminRoleId);
        if (config.web && config.web.roles && Array.isArray(config.web.roles.admin_role_ids)) {
            for (const rid of config.web.roles.admin_role_ids) if (rid) viewerRoles.add(rid);
        }
        if (config.web && config.web.roles && Array.isArray(config.web.roles.staff_role_ids)) {
            for (const rid of config.web.roles.staff_role_ids) if (rid) viewerRoles.add(rid);
        }

        const overwrites = [
            { id: STAFF_GUILD_ID, type: 0, deny: (1<<10).toString() }, // VIEW_CHANNEL deny to @everyone
            ...Array.from(viewerRoles).map(rid => ({ id: rid, type: 0, allow: (1<<10).toString() }))
        ];
        const channelName = `app-${appRec.username}-comms`;
        const chan = await createGuildChannel({ name: channelName, type: 0, topic: appRec.userId, parentId: parentCategory, permissionOverwrites: overwrites });
        await applications.linkTicket(appId, chan.id, chan.id, 'comms');
        // Map channel -> application for interaction handlers
        try { await db.set(`AppMap.channelToApp.${chan.id}`, appId); } catch (_) {}
        // Index application channel under user
        try {
            const key = `AppMap.userToChannels.${appRec.userId}`;
            const list = (await db.get(key)) || [];
            if (!list.includes(chan.id)) {
                list.push(chan.id);
                await db.set(key, list);
            }
        } catch (_) {}
        // Log to application history
        try { await applications.addComment(appId, req.user.id, `Opened communication ticket #${channelName} (${chan.id})`); } catch (_) {}
        
        // Post intro + close button
        try {
            await axios.post(`https://discord.com/api/v10/channels/${chan.id}/messages`, {
                content: `📱 **Application Communication Channel Opened**\n\nThis channel is for communicating with **${appRec.username}** about their application.\n\n**How it works:**\n• Messages you post here will be sent to the applicant via DM\n• The applicant can respond to your DMs and their responses will appear here\n• Use the close button below when communication is complete\n\n**Applicant:** <@${appRec.userId}>\n**Application Type:** ${appRec.type}\n**Current Stage:** ${appRec.stage}`,
                components: [
                    { type: 1, components: [ { type: 2, style: 4, custom_id: 'app_comm_close', label: 'Close Communication', emoji: { name: '📝' } } ] }
                ]
            }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            
            // Send DM notification to applicant
            try {
                const dmChannel = await axios.post(`https://discord.com/api/v10/users/@me/channels`, {
                    recipient_id: appRec.userId
                }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
                
                if (dmChannel.data && dmChannel.data.id) {
                    await axios.post(`https://discord.com/api/v10/channels/${dmChannel.data.id}/messages`, {
                        content: `**Application Communication Channel Opened** 📢\n\nStaff have opened a communication channel to discuss your application. You can now receive messages from staff members.\n\n**Application Type:** ${appRec.type}\n**Current Stage:** ${appRec.stage}\n\n**How to respond:**\n• Staff will send you messages here in this DM\n• You can respond directly to this DM and your responses will be sent to the staff channel\n• This allows for two-way communication about your application\n\nStaff will contact you shortly!`
                    }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
                }
            } catch (dmError) {
                console.error('Failed to send DM notification:', dmError?.response?.data || dmError);
            }
        } catch (channelError) {
            console.error('Failed to set up communication channel:', channelError?.response?.data || channelError);
        }
        
        // Redirect with success notification
        return res.redirect(`/applications/${appId}?notification=Communication channel opened successfully!&type=success`);
    } catch (e) {
        console.error('open_ticket error', e?.response?.data || e);
    }
    return res.redirect(`/applications/${appId}`);
});

// Applications - schedule interview
app.post('/applications/:id/schedule', ensureAuth, async (req, res) => {
    const roles = await fetchGuildMemberRoles(req.user.id);
    const isAdmin = roles.includes(config.role_ids.application_admin_role_id) || (await getRoleFlags(req.user.id)).isAdmin;
    if (!isAdmin) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    if (appRec.stage !== 'Interview') return res.redirect(`/applications/${appId}`);
    
    // Prefer explicit UTC from client if provided; fallback to parsing local and relying on JS conversion
    const whenSource = req.body.when_utc || req.body.when;
    const when = new Date(whenSource);
    const staffId = (req.body.staff_id || '').replace(/[^0-9]/g, '');
    if (!when || isNaN(when.getTime()) || !staffId) return res.redirect(`/applications/${appId}`);
    
    try {
        // Ensure the interview time is not in the past
        const now = new Date();
        if (when.getTime() <= now.getTime()) {
            return res.redirect(`/applications/${appId}?notification=Interview time must be in the future&type=error`);
        }
        
        // Schedule the interview first
        const atTs = when.getTime() - 5*60*1000; // 5 minutes before interview
        const scheduledJob = await applications.scheduleInterview({ appId, atTs, staffId, mode: 'voice' });
        
        // Add comment to application history
        await applications.addComment(appId, req.user.id, `Interview scheduled for ${when.toLocaleString()} with staff member ${staffId}`);
        
        // Only send notifications after successful scheduling
        const interviewTime = when.toLocaleString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
        });
        
        // Convert interview time to Discord timestamp (for both DMs)
        const interviewTimestamp = Math.floor(when.getTime() / 1000);
        
        // Send DM notification to applicant
        try {
            const dmChannel = await axios.post(`https://discord.com/api/v10/users/@me/channels`, {
                recipient_id: appRec.userId
            }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            
            if (dmChannel.data && dmChannel.data.id) {
                await axios.post(`https://discord.com/api/v10/channels/${dmChannel.data.id}/messages`, {
                    content: `**Interview Scheduled** 📅\n\nYour application interview has been scheduled!\n\n**Date & Time:** <t:${interviewTimestamp}:F>\n**Type:** Voice Interview\n**Staff Member:** <@${staffId}>\n\nA voice channel will be created 5 minutes before your interview time. You will be able to join the channel when it becomes available.\n\nIf you need to reschedule, please contact staff as soon as possible.`
                }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            }
        } catch (dmError) {
            console.error('Failed to send interview DM notification:', dmError?.response?.data || dmError);
        }
        
        // Send DM notification to staff member
        try {
            const staffDmChannel = await axios.post(`https://discord.com/api/v10/users/@me/channels`, {
                recipient_id: staffId
            }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            
            if (staffDmChannel.data && staffDmChannel.data.id) {
                await axios.post(`https://discord.com/api/v10/channels/${staffDmChannel.data.id}/messages`, {
                    content: `**Interview Scheduled** 📅\n\nYou have an interview scheduled!\n\n**Applicant:** ${appRec.username} (<@${appRec.userId}>)\n**Date & Time:** <t:${interviewTimestamp}:F>\n**Type:** Voice Interview\n\nA voice channel will be created 5 minutes before the interview time.`
                }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            }
        } catch (staffDmError) {
            console.error('Failed to send staff DM notification:', staffDmError?.response?.data || staffDmError);
        }
        
    } catch (error) {
        console.error('Interview scheduling error:', error);
        return res.redirect(`/applications/${appId}?notification=Failed to schedule interview: ${error.message}&type=error`);
    }
    
    return res.redirect(`/applications/${appId}?notification=Interview scheduled successfully!&type=success`);
});

// Applications - list scheduled interviews
app.get('/applications/:id/interviews', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    
    const schedules = await applications.listSchedules();
    const appSchedules = Object.entries(schedules)
        .filter(([jobId, job]) => job.appId === appId)
        .map(([jobId, job]) => {
            // Convert UTC time back to local time for display
            const interviewTime = new Date(job.at + 5*60*1000); // Convert back to interview time
            const localTime = interviewTime.toLocaleString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZoneName: 'short'
            });
            
            return {
                jobId,
                ...job,
                interviewTime,
                localTime,
                // Full ISO for precise client-side conversion to the viewer's local tz
                isoTime: interviewTime.toISOString(),
                // Store the original UTC time for form pre-filling (full ISO; client will convert to local)
                utcTime: interviewTime.toISOString()
            };
        })
        .sort((a, b) => a.at - b.at);
    
    res.render('interviews_list', { app: appRec, schedules: appSchedules });
});

// Applications - delete scheduled interview
app.post('/applications/:id/interviews/:jobId/delete', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const jobId = req.params.jobId;
    
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    
    try {
        const schedules = await applications.listSchedules();
        const job = schedules[jobId];
        if (!job || job.appId !== appId) {
            return res.redirect(`/applications/${appId}?notification=Interview not found&type=error`);
        }
        
        // Delete the schedule
        await applications.deleteSchedule(jobId);
        
        // Add comment to application history
        const interviewAt = new Date(job.at + 5*60*1000);
        await applications.addComment(appId, req.user.id, `Interview scheduled for ${interviewAt.toLocaleString()} was cancelled`);

        // DM applicant and staff about cancellation
        try {
            const applicantDm = await axios.post(`https://discord.com/api/v10/users/@me/channels`, { recipient_id: appRec.userId }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            if (applicantDm.data?.id) {
                const ts = Math.floor(interviewAt.getTime()/1000);
                await axios.post(`https://discord.com/api/v10/channels/${applicantDm.data.id}/messages`, { content: `**Interview Cancelled** ❌\n\nYour interview scheduled for <t:${ts}:F> has been cancelled by staff. If this was a mistake, please reach out to staff to reschedule.` }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            }
        } catch (e) { console.error('Cancel DM (applicant) failed:', e?.response?.data || e); }
        try {
            const staffDm = await axios.post(`https://discord.com/api/v10/users/@me/channels`, { recipient_id: job.staffId }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            if (staffDm.data?.id) {
                const ts = Math.floor(interviewAt.getTime()/1000);
                await axios.post(`https://discord.com/api/v10/channels/${staffDm.data.id}/messages`, { content: `**Interview Cancelled** ❌\n\nInterview with **${appRec.username}** (<@${appRec.userId}>) scheduled for <t:${ts}:F> has been cancelled.` }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            }
        } catch (e) { console.error('Cancel DM (staff) failed:', e?.response?.data || e); }
        
        return res.redirect(`/applications/${appId}?notification=Interview cancelled successfully&type=success`);
    } catch (error) {
        console.error('Interview deletion error:', error);
        return res.redirect(`/applications/${appId}?notification=Failed to cancel interview: ${error.message}&type=error`);
    }
});

// Applications - reschedule interview
app.post('/applications/:id/interviews/:jobId/reschedule', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const jobId = req.params.jobId;
    
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    
    // Prefer explicit UTC from client if provided; fallback to parsing local and relying on JS conversion
    const whenSource = req.body.when_utc || req.body.when;
    const when = new Date(whenSource);
    const staffId = (req.body.staff_id || '').replace(/[^0-9]/g, '');
    if (!when || isNaN(when.getTime()) || !staffId) {
        return res.redirect(`/applications/${appId}?notification=Invalid interview time or staff ID&type=error`);
    }
    
    try {
        // Ensure the interview time is not in the past
        const now = new Date();
        if (when.getTime() <= now.getTime()) {
            return res.redirect(`/applications/${appId}?notification=Interview time must be in the future&type=error`);
        }
        
        // Delete old schedule
        await applications.deleteSchedule(jobId);
        
        // Create new schedule
        const atTs = when.getTime() - 5*60*1000; // 5 minutes before interview
        await applications.scheduleInterview({ appId, atTs, staffId, mode: 'voice' });
        
        // Add comment to application history
        await applications.addComment(appId, req.user.id, `Interview rescheduled for ${when.toLocaleString()} with staff member ${staffId}`);

        // DM applicant and staff about reschedule
        try {
            const applicantDm = await axios.post(`https://discord.com/api/v10/users/@me/channels`, { recipient_id: appRec.userId }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            if (applicantDm.data?.id) {
                const ts = Math.floor(when.getTime()/1000);
                await axios.post(`https://discord.com/api/v10/channels/${applicantDm.data.id}/messages`, { content: `**Interview Rescheduled** 🔁\n\nYour interview has been rescheduled to <t:${ts}:F>. Please be ready at that time. A voice channel will be created 5 minutes prior.` }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            }
        } catch (e) { console.error('Reschedule DM (applicant) failed:', e?.response?.data || e); }
        try {
            const staffDm = await axios.post(`https://discord.com/api/v10/users/@me/channels`, { recipient_id: staffId }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            if (staffDm.data?.id) {
                const ts = Math.floor(when.getTime()/1000);
                await axios.post(`https://discord.com/api/v10/channels/${staffDm.data.id}/messages`, { content: `**Interview Rescheduled** 🔁\n\nInterview with **${appRec.username}** (<@${appRec.userId}>) moved to <t:${ts}:F>. A voice channel will be created 5 minutes prior.` }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
            }
        } catch (e) { console.error('Reschedule DM (staff) failed:', e?.response?.data || e); }
        
        return res.redirect(`/applications/${appId}?notification=Interview rescheduled successfully&type=success`);
    } catch (error) {
        console.error('Interview rescheduling error:', error);
        return res.redirect(`/applications/${appId}?notification=Failed to reschedule interview: ${error.message}&type=error`);
    }
});

// Applications - skip failed interview
app.post('/applications/:id/interviews/:jobId/skip', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const jobId = req.params.jobId;
    
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    
    try {
        const schedules = await applications.listSchedules();
        const job = schedules[jobId];
        if (!job || job.appId !== appId) {
            return res.redirect(`/applications/${appId}?notification=Interview not found&type=error`);
        }
        
        // Mark as skipped
        await applications.completeSchedule(jobId, 'skipped', { reason: 'Manually skipped by staff' });
        
        // Add comment to application history
        await applications.addComment(appId, req.user.id, `Failed interview skipped by staff`);
        
        return res.redirect(`/applications/${appId}?notification=Interview marked as skipped&type=success`);
    } catch (error) {
        console.error('Interview skip error:', error);
        return res.redirect(`/applications/${appId}?notification=Failed to skip interview: ${error.message}&type=error`);
    }
});

// Applications - approve
app.post('/applications/:id/approve', ensureAuth, async (req, res) => {
    const roles = await fetchGuildMemberRoles(req.user.id);
    const isAdmin = roles.includes(config.role_ids.application_admin_role_id) || (await getRoleFlags(req.user.id)).isAdmin;
    if (!isAdmin) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    if (appRec.stage === 'Approved' || appRec.stage === 'Denied' || appRec.stage === 'Archived') return res.status(400).send('Application is closed');
    
    await applications.advanceStage(appId, 'Approved', req.user.id, req.body.note || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - cleanup old interview jobs
app.post('/applications/:id/interviews/cleanup', ensureAuth, async (req, res) => {
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    const appId = req.params.id;
    
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    
    try {
        const schedules = await applications.listSchedules();
        const appSchedules = Object.entries(schedules)
            .filter(([jobId, job]) => job.appId === appId && job.status !== 'scheduled');
        
        let cleanedCount = 0;
        for (const [jobId, job] of appSchedules) {
            await applications.deleteSchedule(jobId);
            cleanedCount++;
        }
        
        if (cleanedCount > 0) {
            await applications.addComment(appId, req.user.id, `Cleaned up ${cleanedCount} old interview records`);
        }
        
        return res.redirect(`/applications/${appId}/interviews?notification=Cleaned up ${cleanedCount} old interview records&type=success`);
    } catch (error) {
        console.error('Interview cleanup error:', error);
        return res.redirect(`/applications/${appId}/interviews?notification=Failed to cleanup interviews: ${error.message}&type=error`);
    }
});


// Basic error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('[web] Unhandled error:', err && (err.stack || err));
    res.status(500).send('Internal Server Error');
});

function getKnownTicketTypes() {
    try {
        if (handlerOptions && handlerOptions.options) {
            return Object.keys(handlerOptions.options);
        }
    } catch {}
    return [];
}

async function getAllUserIds() {
    const ps = await db.get('PlayerStats');
    if (ps && typeof ps === 'object') return Object.keys(ps);
    const all = await db.all();
    const users = new Set();
    for (const row of all) {
        const key = row.id || row.ID || row.key;
        if (!key || !key.startsWith('PlayerStats.')) continue;
        const parts = key.split('.');
        if (parts.length >= 2) users.add(parts[1]);
    }
    return Array.from(users);
}

app.get('/staff', ensureAuth, async (req, res) => {
    const { isStaff, roleIds } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    req.session.staff_ok = true;

    const qUser = (req.query.user || '').replace(/[^0-9]/g, '');
    const qSteam = (req.query.steam || '').replace(/[^0-9]/g, '');
    const qType = (req.query.type || '').toLowerCase();
    const qFrom = req.query.from ? new Date(req.query.from) : null;
    const qTo = req.query.to ? new Date(req.query.to) : null;
    const qServer = (req.query.server || '').toLowerCase();
    const qClosedBy = (req.query.closed_by || '').toLowerCase();

    const tickets = [];
    const userNameCache = new Map();
    const ps = await db.get('PlayerStats');
    if (ps && typeof ps === 'object') {
        const userIds = qUser ? [qUser] : Object.keys(ps);
        for (const userId of userIds) {
            const logs = ps[userId]?.ticketLogs || {};
            if (!userNameCache.has(userId)) {
                let name = '';
                for (const tid of Object.keys(logs)) {
                    if (logs[tid]?.username) { name = logs[tid].username; break; }
                }
                userNameCache.set(userId, name || userId);
            }
            for (const ticketId of Object.keys(logs)) {
                const t = logs[ticketId] || {};
                if (qSteam && String(t.steamId || '').indexOf(qSteam) === -1) continue;
                // Only closed tickets
                if (!t.closeTime && !t.closeType && !t.transcriptURL) continue;
                const url = t.transcriptURL || '';
                const filename = url ? url.split('/').pop() : null;
                const created = t.createdAt ? new Date((typeof t.createdAt === 'number' && t.createdAt < 2e10 ? t.createdAt * 1000 : t.createdAt)) : null;
                const typeLower = (t.ticketType || 'Unknown').toLowerCase();
                // Enforce per-ticket-type visibility based on Discord roles
                if (!userCanSeeTicketType(roleIds, t.ticketType || '')) continue;
                if (qType && typeLower !== qType) continue;
                if (qFrom && created && created < qFrom) continue;
                if (qTo && created && created > qTo) continue;
                if (qServer) {
                    const serverLower = (t.server || '').toLowerCase();
                    if (!serverLower.includes(qServer)) continue;
                }
                if (qClosedBy) {
                    const closedByName = (t.closeUser || '').toLowerCase();
                    const closedById = (t.closeUserID || '').toString();
                    if (!(closedByName.includes(qClosedBy) || closedById === qClosedBy)) continue;
                }
                tickets.push({
                    userId,
                    username: t.username || userNameCache.get(userId) || userId,
                    ticketId,
                    ticketType: t.ticketType || 'Unknown',
                    server: t.server || null,
                    closeUser: t.closeUser || null,
                    closeReason: t.closeReason || null,
                    createdAt: created,
                    transcriptFilename: filename,
                    transcriptAvailable: !!filename
                });
            }
        }
    } else {
        // Fallback: scan across all keys
        const all = await db.all();
        const map = new Map(); // userId -> ticketId -> fields
        for (const row of all) {
            const key = row.id || row.ID || row.key;
            if (!key || !key.startsWith('PlayerStats.')) continue;
            const m = key.match(/^PlayerStats\.(\d+)\.ticketLogs\.(\d+)\.(\w+)$/);
            if (!m) continue;
            const [, userId, ticketId, field] = m;
            if (qUser && userId !== qUser) continue;
            if (!map.has(userId)) map.set(userId, new Map());
            const userMap = map.get(userId);
            if (!userMap.has(ticketId)) userMap.set(ticketId, {});
            const obj = userMap.get(ticketId);
            obj[field] = row.value ?? row.data;
        }
        for (const [userId, ticketMap] of map.entries()) {
            // prime username cache
            if (!userNameCache.has(userId)) {
                let name = '';
                for (const [, t] of ticketMap.entries()) {
                    if (t.username) { name = t.username; break; }
                }
                userNameCache.set(userId, name || userId);
            }
            for (const [ticketId, t] of ticketMap.entries()) {
                if (!t.closeTime && !t.closeType && !t.transcriptURL) continue;
                const url = t.transcriptURL || '';
                const filename = url ? url.split('/').pop() : null;
                const created = t.createdAt ? new Date((typeof t.createdAt === 'number' && t.createdAt < 2e10 ? t.createdAt * 1000 : t.createdAt)) : null;
                const typeLower = (t.ticketType || 'Unknown').toLowerCase();
                // Enforce per-ticket-type visibility based on Discord roles
                if (!userCanSeeTicketType(roleIds, t.ticketType || '')) continue;
                if (qType && typeLower !== qType) continue;
                if (qFrom && created && created < qFrom) continue;
                if (qTo && created && created > qTo) continue;
                if (qServer) {
                    const serverLower = (t.server || '').toLowerCase();
                    if (!serverLower.includes(qServer)) continue;
                }
                if (qClosedBy) {
                    const closedByName = (t.closeUser || '').toLowerCase();
                    const closedById = (t.closeUserID || '').toString();
                    if (!(closedByName.includes(qClosedBy) || closedById === qClosedBy)) continue;
                }
                tickets.push({
                    userId,
                    username: t.username || userNameCache.get(userId) || userId,
                    ticketId,
                    ticketType: t.ticketType || 'Unknown',
                    server: t.server || null,
                    closeUser: t.closeUser || null,
                    closeReason: t.closeReason || null,
                    createdAt: created,
                    transcriptFilename: filename,
                    transcriptAvailable: !!filename
                });
            }
        }
    }
    tickets.sort((a,b) => (b.createdAt?.getTime()||0) - (a.createdAt?.getTime()||0));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const total = tickets.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const paged = tickets.slice(start, start + limit);
    res.render('staff_tickets', { tickets: paged, query: { user: qUser, type: qType, from: req.query.from || '', to: req.query.to || '', server: req.query.server || '', closed_by: req.query.closed_by || '', steam: req.query.steam || '' }, types: getKnownTicketTypes(), pagination: { page, limit, total, totalPages } });
});

app.get('/api/users', ensureAuth, async (req, res) => {
    if (!req.session.staff_ok) {
        const { isStaff } = await getRoleFlags(req.user.id);
        if (!isStaff) return res.status(403).json([]);
    }
    const q = (req.query.q || '').toLowerCase();
    const users = await getAllUserIds();
    const results = [];
    for (const userId of users) {
        if (results.length >= 10) break;
        const logs = await db.get(`PlayerStats.${userId}.ticketLogs`) || {};
        let username = '';
        for (const tid of Object.keys(logs)) {
            if (logs[tid]?.username) { username = logs[tid].username; break; }
        }
        if (!q || userId.includes(q) || (username && username.toLowerCase().includes(q))) {
            results.push({ userId, username });
        }
    }
    res.json(results);
});

// Inline transcript view page (bot links will land here too)
app.get('/transcripts/:filename', ensureAuth, async (req, res) => {
    const filename = sanitizeFilename(req.params.filename);
    if (!filename.endsWith('.html')) return res.status(400).send('Invalid transcript');
    // Non-staff users should be routed to user-friendly transcript if available
    const { isStaff } = await getRoleFlags(req.user.id);
    let effectiveFilename = filename;
    if (!isStaff && filename.endsWith('.full.html')) {
        const alt = filename.replace(/\.full\.html$/, '.html');
        const altPath = path.join(TRANSCRIPT_DIR, alt);
        if (fs.existsSync(altPath)) {
            effectiveFilename = alt;
        }
    }
    console.log('[web] /transcripts view', { userId: req.user.id, filename, effectiveFilename, isStaff });
    const allowed = await canViewTranscript(req.user.id, effectiveFilename);
    if (!allowed) {
        console.log('[web] /transcripts deny', { userId: req.user.id, filename: effectiveFilename });
        return res.status(403).render('forbidden', { message: 'You do not have access to this transcript.' });
    }
    // Try to resolve owner, ticket and IDs for header display
    let ownerId = null;
    let steamId = null;
    let ticketId = null;
    try {
        const ctx = await findTicketContextByFilename(effectiveFilename);
        if (ctx) {
            ownerId = ctx.ownerId || null;
            ticketId = ctx.ticketId || null;
            const t = await db.get(`PlayerStats.${ownerId}.ticketLogs.${ticketId}`) || {};
            steamId = t.steamId || null;
        }
    } catch (_) {}
    res.render('transcript', { filename: effectiveFilename, ownerId, steamId, ticketId });
});

// Raw stream of transcript (iframe src)
app.get('/transcripts/raw/:filename', ensureAuth, async (req, res) => {
    const filename = sanitizeFilename(req.params.filename);
    if (!filename.endsWith('.html')) return res.status(400).send('Invalid transcript');
    console.log('[web] /transcripts/raw view', { userId: req.user.id, filename });
    const allowed = await canViewTranscript(req.user.id, filename);
    if (!allowed) {
        console.log('[web] /transcripts/raw deny', { userId: req.user.id, filename });
        return res.status(403).render('forbidden', { message: 'You do not have access to this transcript.' });
    }
    const abs = path.join(TRANSCRIPT_DIR, filename);
    if (!abs.startsWith(TRANSCRIPT_DIR)) return res.status(400).send('Invalid path');
    if (!fs.existsSync(abs)) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    fs.createReadStream(abs).pipe(res);
});

// Admin overrides routes removed

app.listen(PORT, HOST, () => {
    console.log(`[web] Listening on http://${HOST}:${PORT}`);
});


