const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const { QuickDB } = require('quick.db');
const metrics = require('../utils/metrics');

const config = require('../config/config.json');
const handlerOptions = require('../content/handler/options.json');

// --- Config ---
const WEB_ENABLED = config.web?.enabled !== false;
const HOST = config.web?.host || '0.0.0.0';
const PORT = config.web?.port || 3050;
const SESSION_SECRET = config.web?.session_secret || 'change_me';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || config.web?.discord_oauth?.client_id || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || config.web?.discord_oauth?.client_secret || '';
const DISCORD_CALLBACK_URL = config.web?.discord_oauth?.callback_url || 'http://localhost:3050/auth/callback';
const DISCORD_SCOPES = config.web?.discord_oauth?.scopes || ['identify'];
const STAFF_GUILD_ID = config.web?.staff_guild_id || config.channel_ids?.staff_guild_id;
const STAFF_ROLE_IDS = new Set((config.web?.roles?.staff_role_ids || []).filter(Boolean));
const ADMIN_ROLE_IDS = new Set((config.web?.roles?.admin_role_ids || []).filter(Boolean));
const BOT_TOKEN = process.env.BOT_TOKEN; // from ../config/.env
const TRANSCRIPT_DIR = path.resolve(process.cwd(), config.transcript_settings?.save_path || './transcripts/');

if (!WEB_ENABLED) {
    console.log('[web] Disabled by config.');
    process.exit(0);
}
if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    console.warn('[web] Missing Discord OAuth client ID/secret. Set in config.web.discord_oauth or env.');
}
if (!BOT_TOKEN) {
    console.warn('[web] Missing BOT_TOKEN in config/.env. Guild role checks will fail.');
}

// --- Databases ---
const db = new QuickDB(); // shares ./json.sqlite by default
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

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
}

function sanitizeFilename(input) {
    return input.replace(/[^a-zA-Z0-9_.\-]/g, '');
}

async function findOwnerByFilename(filename) {
    // We look up any PlayerStats.<uid>.ticketLogs.<ticketId>.transcriptURL that ends with filename
    const all = await db.all();
    const suffix = `/${filename}`;
    for (const row of all) {
        const key = row.id || row.ID || row.key; // quick.db variants
        if (!key || !key.startsWith('PlayerStats.')) continue;
        // Load lazily only when key likely contains transcriptURL
        if (key.includes('.transcriptURL')) {
            const url = row.value ?? row.data;
            if (typeof url === 'string' && (url.endsWith(suffix) || url === filename)) {
                // extract userId from key: PlayerStats.<userId>.ticketLogs.<ticketId>.transcriptURL
                const parts = key.split('.');
                return parts[1];
            }
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
            if (t?.transcriptURL && (t.transcriptURL.endsWith(suffix) || t.transcriptURL === filename)) {
                return userId;
            }
        }
    }
    return null;
}

function userHasOverride(_userId, _filename) {
    return false;
}

async function canViewTranscript(userId, filename) {
    const { isStaff, isAdmin } = await getRoleFlags(userId);
    if (isAdmin || isStaff) return true; // staff can see all
    if (userHasOverride(userId, filename)) return true;
    const ownerId = await findOwnerByFilename(filename);
    if (ownerId && ownerId === userId) return true;
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
    res.locals.roleFlags = req.user ? await getRoleFlags(req.user.id) : { isStaff: false, isAdmin: false };
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
    res.render('index');
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
    res.render('my_tickets', { tickets: list });
});

// Health check
app.get('/health', (req, res) => res.send('ok'));

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
    const { isStaff } = await getRoleFlags(req.user.id);
    if (!isStaff) return res.status(403).send('Forbidden');
    req.session.staff_ok = true;

    const qUser = (req.query.user || '').replace(/[^0-9]/g, '');
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
                // Only closed tickets
                if (!t.closeTime && !t.closeType && !t.transcriptURL) continue;
                const url = t.transcriptURL || '';
                const filename = url ? url.split('/').pop() : null;
                const created = t.createdAt ? new Date((typeof t.createdAt === 'number' && t.createdAt < 2e10 ? t.createdAt * 1000 : t.createdAt)) : null;
                const typeLower = (t.ticketType || 'Unknown').toLowerCase();
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
    res.render('staff_tickets', { tickets, query: { user: qUser, type: qType, from: req.query.from || '', to: req.query.to || '', server: req.query.server || '', closed_by: req.query.closed_by || '' }, types: getKnownTicketTypes() });
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
    const allowed = await canViewTranscript(req.user.id, effectiveFilename);
    if (!allowed) return res.status(403).send('Forbidden');
    res.render('transcript', { filename: effectiveFilename });
});

// Raw stream of transcript (iframe src)
app.get('/transcripts/raw/:filename', ensureAuth, async (req, res) => {
    const filename = sanitizeFilename(req.params.filename);
    if (!filename.endsWith('.html')) return res.status(400).send('Invalid transcript');
    const allowed = await canViewTranscript(req.user.id, filename);
    if (!allowed) return res.status(403).send('Forbidden');
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


