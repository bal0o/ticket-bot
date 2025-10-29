const path = require('path');
const fs = require('fs');
// Environment variables are now loaded from config.json

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const { createDB } = require('../utils/mysql');
const metrics = require('../utils/metrics');
const promClient = require('prom-client');
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

// Harden outbound HTTP calls
axios.defaults.timeout = 3000;

// Timeout wrapper for async operations
const withTimeout = (promise, ms = 5000, errorMessage = 'Operation timeout') => {
    return Promise.race([
        promise,
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error(errorMessage)), ms)
        )
    ]);
};

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
const db = createDB(); // MySQL database via utils/mysql.js
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
    if (!BOT_TOKEN) {
        console.warn('[web] BOT_TOKEN not configured, cannot fetch roles');
        return [];
    }
    if (!STAFF_GUILD_ID) {
        console.warn('[web] STAFF_GUILD_ID not configured, cannot fetch roles');
        return [];
    }
    try {
        const res = await axios.get(`https://discord.com/api/v10/guilds/${STAFF_GUILD_ID}/members/${userId}` , {
            headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        const roles = Array.isArray(res.data?.roles) ? res.data.roles : [];
        console.log('[web] Fetched roles for user', { userId, roleCount: roles.length });
        return roles;
    } catch (e) {
        console.error('[web] Error fetching guild member roles:', {
            userId,
            message: e.message,
            status: e.response?.status,
            statusText: e.response?.statusText
        });
        return [];
    }
}

// Role flags cache with TTL and request coalescing
const ROLE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let roleCache = new Map(); // userId -> { flags, expiresAt }
let roleInFlight = new Map(); // userId -> Promise<{ isStaff,isAdmin,roleIds }>

async function getRoleFlags(userId) {
    try {
        const cached = roleCache.get(userId);
        if (cached && cached.expiresAt > Date.now()) return cached.flags;
        if (roleInFlight.has(userId)) return await roleInFlight.get(userId);
        const p = (async () => {
            const fetchedRoles = await fetchGuildMemberRoles(userId);
            const roles = new Set(fetchedRoles);
            let isStaff = false;
            let isAdmin = false;
            
            // Debug logging
            console.log('[web] getRoleFlags:', {
                userId,
                fetchedRoleCount: fetchedRoles.length,
                adminRoleIds: Array.from(ADMIN_ROLE_IDS),
                staffRoleIds: Array.from(STAFF_ROLE_IDS),
                userRoles: Array.from(roles)
            });
            
            for (const rid of roles) {
                // Check both as string and convert to ensure type matching
                const ridStr = String(rid);
                if (ADMIN_ROLE_IDS.has(ridStr)) isAdmin = true;
                if (STAFF_ROLE_IDS.has(ridStr)) isStaff = true;
            }
            if (isAdmin) isStaff = true;
            const flags = { isStaff, isAdmin, roleIds: Array.from(roles) };
            
            console.log('[web] Role flags computed:', { userId, flags });
            
            roleCache.set(userId, { flags, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
            return flags;
        })().finally(() => {
            roleInFlight.delete(userId);
        });
        roleInFlight.set(userId, p);
        return await p;
    } catch (err) {
        console.error('[web] getRoleFlags error:', { userId, error: err.message });
        const cached = roleCache.get(userId);
        if (cached) return cached.flags;
        return { isStaff: false, isAdmin: false, roleIds: [] };
    }
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
    if (!Array.isArray(ids) || ids.length === 0) return map;
    for (const id of ids) {
        if (!id || map[id]) continue;
        const cached = usernameCache.get(id);
        if (cached && cached.expiresAt > Date.now()) {
            map[id] = cached.value;
            continue;
        }
        try {
            // Use MySQL getUserTickets instead of PlayerStats
            const logs = typeof db.getUserTickets === 'function' 
                ? (await db.getUserTickets(id, { closedOnly: false, limit: 1000 })).reduce((acc, t) => {
                    acc[t.ticketId] = {
                        ticketType: t.ticketType,
                        createdAt: t.createdAt,
                        transcriptURL: t.transcriptFilename ? `/transcripts/${t.transcriptFilename}` : null,
                        closeTime: t.closeUser ? Date.now() / 1000 : null
                    };
                    return acc;
                }, {})
                : {};
            let username = '';
            for (const tid of Object.keys(logs)) {
                if (logs[tid]?.username) { username = logs[tid].username; break; }
            }
            if (username) {
                usernameCache.set(id, { value: username, expiresAt: Date.now() + USERNAME_CACHE_TTL_MS });
                enforceUsernameCacheBound();
                map[id] = username;
            }
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

// Restrict access to Applications area: only site admins or users with application_admin_role_id
async function ensureApplicationsAccess(req, res, next) {
    try {
        if (!req.user) return res.status(401).redirect('/login');
        const rf = await getRoleFlags(req.user.id);
        const appAdminRoleId = config.role_ids && config.role_ids.application_admin_role_id;
        const can = !!(rf && (rf.isAdmin || (appAdminRoleId && Array.isArray(rf.roleIds) && rf.roleIds.includes(appAdminRoleId))));
        if (can) return next();
        return res.status(403).render('forbidden', { message: 'You do not have access to Applications.' });
    } catch (_) {
        return res.status(403).render('forbidden', { message: 'You do not have access to Applications.' });
    }
}

function sanitizeFilename(input) {
    return input.replace(/[^a-zA-Z0-9_.\-]/g, '');
}

// Short TTL caches for hot lookups
const CACHE_TTL_MS = 60 * 1000; // 60s
let cacheByFilename = new Map(); // filename -> { value, expiresAt }

// Username cache (DB-derived) to avoid Discord lookups on hot paths
const USERNAME_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const USERNAME_CACHE_MAX = 5000;
let usernameCache = new Map(); // userId -> { value, expiresAt }
function enforceUsernameCacheBound() {
    while (usernameCache.size > USERNAME_CACHE_MAX) {
        const firstKey = usernameCache.keys().next().value;
        if (!firstKey) break;
        usernameCache.delete(firstKey);
    }
}

// Compute allowed ticket types for a given role set
function computeAllowedTicketTypes(roleIds) {
    try {
        const types = getKnownTicketTypes();
        const allowed = [];
        for (const t of types) {
            if (userCanSeeTicketType(roleIds || [], t)) allowed.push(String(t).toLowerCase());
        }
        return allowed;
    } catch (_) {
        return [];
    }
}

// In-memory transcript context index for O(1) access checks
let transcriptIndex = new Map(); // lowercased filename -> { ownerId, ticketId, ticketType }
async function warmTranscriptIndex() {
    try {
        // Query MySQL transcript_index table
        if (typeof db.query === 'function') {
            const [rows] = await db.query('SELECT filename, user_id, ticket_id, ticket_type FROM transcript_index LIMIT 1000');
            const idx = new Map();
            for (const row of rows || []) {
                const filename = row.filename || '';
                const ownerId = String(row.user_id || '');
                const ticketId = String(row.ticket_id || '');
                const ticketType = row.ticket_type || null;
                
                if (!filename || !ownerId) continue;
                
                const base = String(filename).replace(/\.(?:full|staff)?\.html$/i, '').replace(/\.html$/i, '');
                const variants = [
                    `${base}.html`,
                    `${base}.full.html`,
                    `${base}.staff.html`
                ];
                for (const f of variants) {
                    idx.set(f.toLowerCase(), { ownerId, ticketId, ticketType });
                }
            }
            transcriptIndex = idx;
        }
    } catch (_) {
        // Leave previous index in place on failure
    }
}

async function findOwnerByFilename(filename) {
    // Normalize candidate filenames
    const candidates = new Set([filename]);
    if (/\.full\.html$/i.test(filename)) candidates.add(filename.replace(/\.full\.html$/i, '.html'));
    if (/\.html$/i.test(filename) && !/\.full\.html$/i.test(filename)) candidates.add(filename.replace(/\.html$/i, '.full.html'));

    // Fast path: in-memory transcript index
    for (const cand of candidates) {
        const rec = transcriptIndex.get(String(cand).toLowerCase());
        if (rec && rec.ownerId) return rec.ownerId;
    }

    // Try MySQL transcript_index table
    for (const cand of candidates) {
        const cKey = String(cand);
        const cKeyLower = cKey.toLowerCase();
        const cached = cacheByFilename.get(cKey) || cacheByFilename.get(cKeyLower);
        if (cached && cached.expiresAt > Date.now()) return cached.value?.ownerId || null;
        
        try {
            if (typeof db.getTranscriptIndex === 'function') {
                const idx = await db.getTranscriptIndex(cKey);
                if (idx && idx.ownerId) {
                    cacheByFilename.set(cKeyLower, { value: idx, expiresAt: Date.now() + CACHE_TTL_MS });
                    return idx.ownerId;
                }
            }
        } catch (_) {}
    }

    // Not found
    return null;
}

function userHasOverride(_userId, _filename) {
    return false;
}

async function findTicketContextByFilename(filename) {
    // Return { ownerId, ticketId, ticketType } using fast in-memory index or MySQL lookup
    try {
        // Build candidate filenames we consider equivalent
        const candidates = new Set([filename]);
        if (/\.staff\.html$/i.test(filename)) candidates.add(filename.replace(/\.staff\.html$/i, '.full.html'));
        if (/\.full\.html$/i.test(filename)) candidates.add(filename.replace(/\.full\.html$/i, '.html'));
        if (/\.html$/i.test(filename) && !/\.full\.html$/i.test(filename)) candidates.add(filename.replace(/\.html$/i, '.full.html'));
        const candList = Array.from(candidates).map(c => c.toLowerCase());

        // Fast path: in-memory index
        for (const c of candList) {
            const rec = transcriptIndex.get(c);
            if (rec) return rec;
        }
        
        // Try MySQL transcript_index table
        for (const c of candList) {
            try {
                if (typeof db.getTranscriptIndex === 'function') {
                    const idx = await db.getTranscriptIndex(c);
                    if (idx && (idx.ownerId || idx.ticketId)) {
                        // Enrich with ticketType from tickets table if missing
                        if (!idx.ticketType && idx.ownerId && idx.ticketId) {
                            try {
                                const [tickets] = await db.query(
                                    'SELECT ticket_type FROM tickets WHERE user_id = ? AND ticket_id = ? LIMIT 1',
                                    [idx.ownerId, idx.ticketId]
                                );
                                if (tickets && tickets.length > 0 && tickets[0].ticket_type) {
                                    idx.ticketType = tickets[0].ticket_type;
                                }
                            } catch (_) {}
                        }
                        return idx;
                    }
                }
            } catch (_) {}
        }
        // Last resort: derive ticketId from filename suffix and query MySQL directly
        const base = String(filename).replace(/\.(?:full|staff)?\.html$/i, '').replace(/\.html$/i, '');
        const idMatch = base.match(/-(\d{1,8})$/);
        if (idMatch) {
            const ticketId = idMatch[1];
            try {
                if (typeof db.query === 'function') {
                    const [rows] = await db.query(
                        'SELECT user_id, ticket_type FROM tickets WHERE ticket_id = ? LIMIT 1',
                        [ticketId]
                    );
                    if (rows && rows.length > 0) {
                        return {
                            ownerId: String(rows[0].user_id || ''),
                            ticketId: ticketId,
                            ticketType: rows[0].ticket_type || null
                        };
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
    return null;
}

async function canViewTranscript(userId, filename, roleFlags) {
    const t0 = Date.now();
    console.log('[auth] canViewTranscript start', { userId, filename });
    const rf = roleFlags || (await getRoleFlags(userId));
    const { isStaff, isAdmin, roleIds } = rf || { isStaff: false, isAdmin: false, roleIds: [] };
    console.log('[auth] roleFlags', { isStaff, isAdmin, roleCount: roleIds.length });
    if (isAdmin) { console.log('[auth] allow: admin', { ms: Date.now() - t0 }); return true; }
    if (userHasOverride(userId, filename)) { console.log('[auth] allow: manual override', { ms: Date.now() - t0 }); return true; }
    // Fast-path: check the current user's own tickets via MySQL
    try {
        const candList = [filename];
        if (/\.full\.html$/i.test(filename)) candList.push(filename.replace(/\.full\.html$/i, '.html'));
        if (/\.html$/i.test(filename) && !/\.full\.html$/i.test(filename)) candList.push(filename.replace(/\.html$/i, '.full.html'));
        
        if (typeof db.getUserTickets === 'function') {
            const userTickets = await db.getUserTickets(userId, { closedOnly: false, limit: 1000 });
            for (const t of userTickets) {
                // Check transcriptFilename directly, or reconstruct URL from transcriptFilename
                const urlFilename = t.transcriptFilename || '';
                if (candList.some(c => {
                    if (!urlFilename) return false;
                    return urlFilename === c || urlFilename.replace(/\.html$/i, '.full.html') === c || urlFilename.replace(/\.full\.html$/i, '.html') === c;
                })) {
                    console.log('[auth] allow: owner via MySQL tickets', { ticketId: t.ticketId, filename: urlFilename, ms: Date.now() - t0 });
                    return true;
                }
            }
        }
    } catch (e) { console.log('[auth] own tickets check error', e?.message || e); }
    const ownerId = await findOwnerByFilename(filename);
    console.log('[auth] owner lookup', { ownerId });
    if (ownerId && ownerId === userId) { console.log('[auth] allow: owner via reverse lookup', { ms: Date.now() - t0 }); return true; }
    // If not owner/admin, see if staff but only with per-type permission; infer type from DB
    if (isStaff) {
        try {
            const ctx = await findTicketContextByFilename(filename);
            console.log('[auth] staff mode; context', ctx);
            if (ctx && ctx.ticketType) {
                const can = userCanSeeTicketType(roleIds, ctx.ticketType);
                console.log('[auth] staff type permission', { ticketType: ctx.ticketType, can });
                if (can) { console.log('[auth] allow: staff by type', { ms: Date.now() - t0 }); return true; }
            } else {
                console.log('[auth] staff: could not infer ticketType for', { filename });
            }
        } catch (e) { console.log('[auth] staff check error', e?.message || e); }
    }
    console.log('[auth] deny: no rule matched', { userId, filename, isStaff, isAdmin, ms: Date.now() - t0 });
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

// Request timeout protection (10 seconds)
app.use((req, res, next) => {
    res.setTimeout(10000, () => {
        if (!res.headersSent) {
            console.error(`[web] Request timeout: ${req.method} ${req.path}`);
            res.status(503).send('Request timeout');
        }
    });
    next();
});

app.use(async (req, res, next) => {
    res.locals.user = req.user || null;
    // Session-cached role flags and allowed types
    if (req.user) {
        const now = Date.now();
        const sessFlags = req.session.roleFlags;
        const sessExp = req.session.roleFlagsExpiresAt || 0;
        if (!sessFlags || sessExp <= now) {
            const rf = await getRoleFlags(req.user.id);
            req.session.roleFlags = rf;
            req.session.roleFlagsExpiresAt = now + ROLE_CACHE_TTL_MS;
            req.session.allowedTicketTypes = computeAllowedTicketTypes(rf.roleIds);
            req.session.allowedTicketTypesExpiresAt = now + ROLE_CACHE_TTL_MS;
        } else if (!req.session.allowedTicketTypes || (req.session.allowedTicketTypesExpiresAt || 0) <= now) {
            req.session.allowedTicketTypes = computeAllowedTicketTypes((sessFlags && sessFlags.roleIds) || []);
            req.session.allowedTicketTypesExpiresAt = now + ROLE_CACHE_TTL_MS;
        }
        res.locals.roleFlags = req.session.roleFlags || { isStaff: false, isAdmin: false, roleIds: [] };
    } else {
        res.locals.roleFlags = { isStaff: false, isAdmin: false, roleIds: [] };
    }
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
    // Fire-and-forget prewarm to avoid blocking login redirect
    try {
        setImmediate(async () => {
            try {
                const rf = await getRoleFlags(req.user.id);
                // Compute allowed types from cached role flags; middleware will persist to session on next request
                computeAllowedTicketTypes(rf.roleIds);
            } catch (_) {}
        });
    } catch (_) {}
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
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;
        
        let tickets = [];
        let total = 0;
        
        // Use MySQL getUserTickets if available
        if (typeof db.getUserTickets === 'function') {
            // Get tickets for this page
            tickets = await db.getUserTickets(req.user.id, { closedOnly: true, limit, offset });
            
            // Get total count
            const [countRows] = await db.query(
                'SELECT COUNT(*) as total FROM tickets WHERE user_id = ? AND (close_time IS NOT NULL OR close_type IS NOT NULL OR transcript_url IS NOT NULL)',
                [String(req.user.id)]
            );
            total = countRows[0]?.total || 0;
            
            // Map to view format
            tickets = tickets.map(t => ({
                ticketId: t.ticketId,
                ticketType: t.ticketType,
                createdAt: t.createdAt ? new Date(t.createdAt * 1000) : null,
                transcriptFilename: t.transcriptFilename,
                transcriptAvailable: !!t.transcriptFilename,
                isClosed: true
            }));
        } else {
            // Fallback (shouldn't happen with MySQL-only)
            tickets = [];
            total = 0;
        }
        
        const totalPages = Math.max(1, Math.ceil(total / limit));
        res.render('my_tickets', { tickets, pagination: { page, limit, total, totalPages }, query: req.query });
    } catch (err) {
        console.error('[web] /my error:', err);
        res.status(500).send('Error loading tickets');
    }
});

// Health check
app.get('/health', (req, res) => res.send('ok'));

// Applications - list
app.get('/applications', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
app.get('/applications/:id', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
    const rf = await getRoleFlags(req.user.id);
    const canAdmin = !!(rf.isAdmin || (config.role_ids.application_admin_role_id && Array.isArray(rf.roleIds) && rf.roleIds.includes(config.role_ids.application_admin_role_id)));

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
app.post('/applications/:id/advance', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
app.post('/applications/:id/deny', ensureAuth, ensureApplicationsAccess, async (req, res) => {
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    if (appRec.stage === 'Denied' || appRec.stage === 'Archived') return res.redirect(`/applications/${appId}`);
    await applications.deny(appId, req.user.id, req.body.note || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - archive
app.post('/applications/:id/archive', ensureAuth, ensureApplicationsAccess, async (req, res) => {
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    if (appRec.stage === 'Archived') return res.redirect(`/applications/${appId}`);
    await applications.advanceStage(appId, 'Archived', req.user.id, req.body.note || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - comment
app.post('/applications/:id/comment', ensureAuth, ensureApplicationsAccess, async (req, res) => {
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    await applications.addComment(appId, req.user.id, req.body.comment || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - open communication ticket (new ticket linked to application)
app.post('/applications/:id/open_ticket', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
app.post('/applications/:id/schedule', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
app.get('/applications/:id/interviews', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
app.post('/applications/:id/interviews/:jobId/delete', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
app.post('/applications/:id/interviews/:jobId/reschedule', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
app.post('/applications/:id/interviews/:jobId/skip', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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
app.post('/applications/:id/approve', ensureAuth, ensureApplicationsAccess, async (req, res) => {
    const appId = req.params.id;
    const appRec = await applications.getApplication(appId);
    if (!appRec) return res.status(404).send('Not found');
    if (appRec.stage === 'Approved' || appRec.stage === 'Denied' || appRec.stage === 'Archived') return res.status(400).send('Application is closed');
    
    await applications.advanceStage(appId, 'Approved', req.user.id, req.body.note || '');
    return res.redirect(`/applications/${appId}`);
});

// Applications - cleanup old interview jobs
app.post('/applications/:id/interviews/cleanup', ensureAuth, ensureApplicationsAccess, async (req, res) => {
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

// Background-refreshed list of user IDs to avoid DB-wide scans on /api/users
let cachedUserIdList = [];
let cachedUserIdListExpiresAt = 0;
const USERID_LIST_TTL_MS = 60 * 1000; // 60s
async function refreshUserIdList() {
    try {
        if (typeof db.getUserIds === 'function') {
            const userIds = await db.getUserIds(500);
            cachedUserIdList = userIds;
            cachedUserIdListExpiresAt = Date.now() + USERID_LIST_TTL_MS;
        }
    } catch (_) {}
}
async function getAllUserIds() {
    if (cachedUserIdListExpiresAt <= Date.now() || !Array.isArray(cachedUserIdList) || cachedUserIdList.length === 0) {
        await refreshUserIdList();
    }
    return cachedUserIdList || [];
}

// Efficient ticket search using SQL queries
async function searchTickets({ ticketId, userId, ticketType, server, closedBy, fromDate, toDate, limit = 100 }) {
    try {
        if (typeof db.searchTickets === 'function') {
            return await db.searchTickets({ ticketId, userId, ticketType, server, closedBy, fromDate, toDate, limit });
        }
        
        // MySQL adapter should always have searchTickets method
        console.error('[web] MySQL searchTickets method not available');
        return [];
    } catch (err) {
        console.error('[web] Search tickets error:', err.message || err);
        return [];
    }
}

app.get('/staff', ensureAuth, async (req, res) => {
    try {
        const rf = res.locals.roleFlags || { isStaff: false, roleIds: [] };
        const { isStaff, roleIds } = rf;
        if (!isStaff) return res.status(403).send('Forbidden');
        req.session.staff_ok = true;

        const qUser = (req.query.user || '').replace(/[^0-9]/g, '');
        const qTicketId = (req.query.ticket_id || req.query.ticket || '').trim();
        const qType = (req.query.type || '').toLowerCase();
        const qFrom = req.query.from ? new Date(req.query.from) : null;
        const qTo = req.query.to ? new Date(req.query.to) : null;
        const qServer = (req.query.server || '').toLowerCase();
        const qClosedBy = (req.query.closed_by || '').toLowerCase();

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
        const offset = (page - 1) * limit;
        const allowedTypes = new Set((req.session.allowedTicketTypes || []).map(x => String(x).toLowerCase()));

        // Check if there are any search filters
        const hasSearchFilters = !!(qUser || qTicketId || qType || qServer || qClosedBy || qFrom || qTo);

        // Use MySQL searchTickets for efficient querying
        // If no filters, get the most recent 1000 tickets
        const searchLimit = hasSearchFilters ? limit * 3 : 1000;
        const searchResults = await searchTickets({
            ticketId: qTicketId || null,
            userId: qUser || null,
            ticketType: qType || null,
            server: qServer || null,
            closedBy: qClosedBy || null,
            fromDate: qFrom,
            toDate: qTo,
            limit: searchLimit,
            offset: 0
        });

        // Filter by allowed ticket types and date ranges
        let filteredTickets = searchResults.filter(row => {
            if (!row) return false;
            
            // Permission check
            const ttype = String(row.ticketType || '').toLowerCase();
            if (!allowedTypes.has(ttype)) return false;
            
            // Date range filters (already applied in SQL but double-check)
            if (qFrom && row.createdAt && (new Date(row.createdAt * 1000)) < qFrom) return false;
            if (qTo && row.createdAt && (new Date(row.createdAt * 1000)) > qTo) return false;
            
            return true;
        });

        // Get total count
        const total = filteredTickets.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        
        // Paginate
        const start = (page - 1) * limit;
        const pageTickets = filteredTickets.slice(start, start + limit);
        
        // Use usernames from database, fallback to Discord API lookup if missing
        const userIdsNeedingLookup = Array.from(new Set(
            pageTickets
                .filter(x => !x.username || x.username === x.userId)
                .map(x => x.userId)
        )).slice(0, 50);
        
        let nameMap = {};
        if (userIdsNeedingLookup.length > 0) {
            try {
                nameMap = await withTimeout(
                    getUsernamesMap(userIdsNeedingLookup),
                    3000,
                    'Username lookup timeout'
                );
            } catch (err) {
                console.error('[web] Username lookup timeout, continuing with database usernames');
            }
        }
        
        const tickets = pageTickets.map(x => ({
            userId: x.userId,
            username: x.username || nameMap[x.userId] || x.userId,
            ticketId: x.ticketId,
            ticketType: x.ticketType || 'Unknown',
            server: x.server || null,
            closeUser: x.closeUser || null,
            closeReason: x.closeReason || null,
            createdAt: x.createdAt ? new Date(x.createdAt * 1000) : null,
            transcriptFilename: x.transcriptFilename || null,
            transcriptAvailable: !!x.transcriptFilename
        }));
        
        const pagination = { page, limit, total, totalPages };
        // Show results if we have search filters OR if showing default recent tickets
        const hasSearchResults = hasSearchFilters || tickets.length > 0;
        
        res.render('staff_tickets', { 
            tickets, 
            hasSearchResults,
            resultCount: total,
            maxResults: limit,
            query: { 
                user: qUser, 
                ticket_id: qTicketId,
                ticket: qTicketId, // Also support 'ticket' query param
                type: qType, 
                from: req.query.from || '', 
                to: req.query.to || '', 
                server: req.query.server || '', 
                closed_by: req.query.closed_by || '' 
            }, 
            types: getKnownTicketTypes(), 
            pagination 
        });
    } catch (err) {
        console.error('[web] /staff error:', err.message || err);
        if (!res.headersSent) {
            res.status(500).render('forbidden', { message: 'An error occurred while loading tickets. Please try again.' });
        }
    }
});

app.get('/api/users', ensureAuth, async (req, res) => {
    if (!req.session.staff_ok) {
        const isStaff = !!(res.locals.roleFlags && res.locals.roleFlags.isStaff);
        if (!isStaff) return res.status(403).json([]);
    }
    const q = (req.query.q || '').toLowerCase();
    const users = await getAllUserIds();
    const results = [];
    const byIdCandidates = [];
    const nameCandidates = new Set();
    // First, match by ID without any DB I/O
    for (const userId of users) {
        if (results.length >= 10) break;
        if (!q || userId.toLowerCase().includes(q)) {
            byIdCandidates.push(userId);
        } else {
            // Defer to name check
            nameCandidates.add(userId);
        }
    }
    // Fill results from ID matches using cached usernames where possible
    if (byIdCandidates.length > 0) {
        const nameMap = await getUsernamesMap(byIdCandidates.slice(0, 10));
        for (const userId of byIdCandidates) {
            if (results.length >= 10) break;
            results.push({ userId, username: nameMap[userId] || '' });
        }
    }
    // If still need matches and q provided, do a limited name search using cached/batched lookups
    if (results.length < 10 && q) {
        const remaining = 10 - results.length;
        // Take a bounded subset to avoid large loops
        const subset = Array.from(nameCandidates).slice(0, 200);
        const nameMap = await getUsernamesMap(subset);
        for (const userId of subset) {
            if (results.length >= 10) break;
            const username = (nameMap[userId] || '').toLowerCase();
            if (username && username.includes(q)) {
                results.push({ userId, username: nameMap[userId] || '' });
            }
        }
    }
    res.json(results);
});

// Inline transcript view page (bot links will land here too)
app.get('/transcripts/:filename', ensureAuth, async (req, res) => {
    const filename = sanitizeFilename(req.params.filename);
    if (!filename.endsWith('.html')) return res.status(400).send('Invalid transcript');
    // Non-staff users should be routed to user-friendly transcript if available
    const { isStaff } = res.locals.roleFlags || { isStaff: false };
    let effectiveFilename = filename;
    if (!isStaff && filename.endsWith('.full.html')) {
        const alt = filename.replace(/\.full\.html$/, '.html');
        const altPath = path.join(TRANSCRIPT_DIR, alt);
        if (fs.existsSync(altPath)) {
            effectiveFilename = alt;
        }
    }
    console.log('[web] /transcripts view', { userId: req.user.id, filename, effectiveFilename, isStaff });
    const allowed = await canViewTranscript(req.user.id, effectiveFilename, res.locals.roleFlags);
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
            // Query MySQL tickets table for ticket details
            if (typeof db.query === 'function') {
                const [rows] = await db.query('SELECT steam_id FROM tickets WHERE user_id = ? AND ticket_id = ? LIMIT 1', [ownerId, ticketId]);
                if (rows && rows.length > 0) {
                    steamId = rows[0].steam_id || null;
                }
            }
        }
    } catch (_) {}
    res.render('transcript', { filename: effectiveFilename, ownerId, steamId, ticketId });
});

// Raw stream of transcript (iframe src)
app.get('/transcripts/raw/:filename', ensureAuth, async (req, res) => {
    const filename = sanitizeFilename(req.params.filename);
    if (!filename.endsWith('.html')) return res.status(400).send('Invalid transcript');
    console.log('[web] /transcripts/raw view', { userId: req.user.id, filename });
    const allowed = await canViewTranscript(req.user.id, filename, res.locals.roleFlags);
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

app.listen(PORT, HOST, async () => {
    console.log(`[web] Listening on http://${HOST}:${PORT}`);
    // Warm transcript index in background
    try { await warmTranscriptIndex(); } catch (_) {}
    // Prime the user ID list cache without blocking
    try { refreshUserIdList(); } catch (_) {}
    // Build staff index in background
    // Event loop lag instrumentation
    try {
        const eventLoopLagGauge = new promClient.Gauge({ name: 'ticketbot_event_loop_lag_ms', help: 'Event loop lag over 1s interval' });
        metrics.registry.registerMetric(eventLoopLagGauge);
        const intervalMs = 1000;
        let last = process.hrtime.bigint();
        setInterval(() => {
            const now = process.hrtime.bigint();
            const diffMs = Number(now - last) / 1e6;
            const lag = Math.max(0, diffMs - intervalMs);
            eventLoopLagGauge.set(lag);
            last = now;
        }, intervalMs).unref();
    } catch (_) {}
});


