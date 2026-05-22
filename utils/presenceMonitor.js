const func = require('./functions');

const ONLINE_STATUSES = new Set(['online', 'idle', 'dnd']);

function isEnabled(client) {
    const cfg = client.config?.presence_monitor;
    if (cfg && cfg.enabled === false) return false;
    return !!(getPresenceGuildId(client) || getFallbackGuildId(client));
}

function getPresenceGuildId(client) {
    const cfg = client.config?.presence_monitor;
    if (cfg?.guild_id) return cfg.guild_id;
    return client.config?.channel_ids?.public_guild_id || null;
}

function getFallbackGuildId(client) {
    return client.config?.channel_ids?.staff_guild_id || null;
}

function isUserOnline(member) {
    const status = member?.presence?.status || 'offline';
    return ONLINE_STATUSES.has(status);
}

function ensureMaps(client) {
    if (!client.presenceMonitors) client.presenceMonitors = new Map();
    if (!client.presenceLastStatus) client.presenceLastStatus = new Map();
}

/** @returns {Map<string, { staffThreadId: string, ticketNumber: string, ticketChannelId: string }>} */
function getUserMonitors(client, userId) {
    ensureMaps(client);
    const key = String(userId);
    if (!client.presenceMonitors.has(key)) {
        client.presenceMonitors.set(key, new Map());
    }
    return client.presenceMonitors.get(key);
}

async function resolveMember(client, userId) {
    const ids = [getPresenceGuildId(client), getFallbackGuildId(client)].filter(Boolean);
    const seen = new Set();
    for (const guildId of ids) {
        if (seen.has(guildId)) continue;
        seen.add(guildId);
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) return { member, guild };
    }
    return { member: null, guild: null };
}

function formatStatusMessage(userId, online, { initial = false } = {}) {
    const label = online ? '**online**' : '**offline**';
    const verb = initial ? 'is currently' : 'is now';
    return `📡 **Ticket user status** — <@${userId}> ${verb} ${label}.`;
}

async function postToStaffThread(client, staffThreadId, content) {
    const thread = await client.channels.fetch(staffThreadId).catch(() => null);
    if (!thread || typeof thread.send !== 'function') return;
    try {
        await thread.send({ content, allowedMentions: { parse: [] } });
    } catch (e) {
        func.handle_errors(e, client, 'presenceMonitor.js', `Failed to post status to thread ${staffThreadId}`);
    }
}

async function broadcastStatus(client, userId, online, options = {}) {
    const monitors = getUserMonitors(client, userId);
    if (monitors.size === 0) return;
    const content = formatStatusMessage(userId, online, options);
    for (const entry of monitors.values()) {
        await postToStaffThread(client, entry.staffThreadId, content);
    }
}

async function syncUserPresence(client, userId, { initial = false, notify = true } = {}) {
    if (!isEnabled(client)) return;
    const { member } = await resolveMember(client, userId);
    const key = String(userId);

    if (!member) {
        if (initial && notify) {
            const monitors = getUserMonitors(client, userId);
            const primaryGuild = client.guilds.cache.get(getPresenceGuildId(client));
            const guildName = primaryGuild?.name || 'the configured server';
            const msg = `📡 **Ticket user status** — Unable to monitor <@${userId}> (not found in **${guildName}**). They may not share a server with the bot, or presence tracking is unavailable.`;
            for (const entry of monitors.values()) {
                await postToStaffThread(client, entry.staffThreadId, msg);
            }
        }
        return;
    }

    const online = isUserOnline(member);
    const statusKey = online ? 'online' : 'offline';
    const prev = client.presenceLastStatus.get(key);

    if (notify && (initial || (prev !== undefined && prev !== statusKey))) {
        await broadcastStatus(client, userId, online, { initial: initial || prev === undefined });
    }

    client.presenceLastStatus.set(key, statusKey);
}

module.exports.registerTicket = async function (client, { userId, staffThreadId, ticketNumber, ticketChannelId }) {
    if (!isEnabled(client) || !staffThreadId || !userId) return;

    const monitors = getUserMonitors(client, userId);
    monitors.set(String(staffThreadId), {
        staffThreadId: String(staffThreadId),
        ticketNumber: String(ticketNumber || ''),
        ticketChannelId: String(ticketChannelId || '')
    });

    const { member } = await resolveMember(client, userId);
    const key = String(userId);

    if (!member) {
        const primaryGuild = client.guilds.cache.get(getPresenceGuildId(client));
        const guildName = primaryGuild?.name || 'the configured server';
        const msg = `📡 **Ticket user status** — Unable to monitor <@${userId}> (not found in **${guildName}**). They may not share a server with the bot, or presence tracking is unavailable.`;
        await postToStaffThread(client, staffThreadId, msg);
        return;
    }

    const online = isUserOnline(member);
    const statusKey = online ? 'online' : 'offline';
    await postToStaffThread(client, staffThreadId, formatStatusMessage(userId, online, { initial: true }));
    client.presenceLastStatus.set(key, statusKey);
};

module.exports.unregisterTicketChannel = function (client, ticketChannelId) {
    if (!ticketChannelId || !client.presenceMonitors) return;
    const channelKey = String(ticketChannelId);
    for (const [userId, monitors] of client.presenceMonitors.entries()) {
        for (const [threadId, entry] of monitors.entries()) {
            if (entry.ticketChannelId === channelKey) {
                monitors.delete(threadId);
            }
        }
        if (monitors.size === 0) {
            client.presenceMonitors.delete(userId);
            client.presenceLastStatus?.delete(userId);
        }
    }
};

module.exports.handlePresenceUpdate = async function (client, oldPresence, newPresence) {
    if (!isEnabled(client)) return;

    const presence = newPresence || oldPresence;
    if (!presence?.guild || !presence.userId) return;

    const guildId = presence.guild.id;
    const allowedGuilds = new Set([getPresenceGuildId(client), getFallbackGuildId(client)].filter(Boolean));
    if (!allowedGuilds.has(guildId)) return;

    const userId = presence.userId;
    ensureMaps(client);
    if (!client.presenceMonitors.has(String(userId))) return;

    const member = presence.member || await presence.guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const online = isUserOnline(member);
    const statusKey = online ? 'online' : 'offline';
    const key = String(userId);
    const prev = client.presenceLastStatus.get(key);

    if (prev === statusKey) return;

    client.presenceLastStatus.set(key, statusKey);
    await broadcastStatus(client, userId, online, { initial: false });
};

module.exports.restoreOpenTickets = async function (client) {
    if (!isEnabled(client)) return;

    const staffGuildId = client.config?.channel_ids?.staff_guild_id;
    if (!staffGuildId) return;

    const staffGuild = client.guilds.cache.get(staffGuildId);
    if (!staffGuild) return;

    let restored = 0;
    for (const channel of staffGuild.channels.cache.values()) {
        if (!channel.isTextBased?.() || channel.isThread?.()) continue;
        const topic = channel.topic;
        if (!topic || !/^\d{17,19}$/.test(topic)) continue;

        const match = channel.name.match(/-(\d+)$/);
        const ticketNumber = match ? match[1] : null;
        if (!ticketNumber) continue;

        let thread = channel.threads?.cache?.find(t => t.name === `staff-chat-${ticketNumber}`);
        if (!thread) {
            try {
                const active = await channel.threads.fetchActive();
                thread = active?.threads?.find(t => t.name === `staff-chat-${ticketNumber}`);
            } catch (_) {}
        }
        if (!thread) continue;

        const monitors = getUserMonitors(client, topic);
        if (monitors.has(thread.id)) continue;

        monitors.set(String(thread.id), {
            staffThreadId: String(thread.id),
            ticketNumber: String(ticketNumber),
            ticketChannelId: String(channel.id)
        });
        restored++;
    }

    if (restored > 0) {
        console.log(`[PresenceMonitor] Restored ${restored} open ticket monitor(s)`);
    }

    for (const userId of client.presenceMonitors.keys()) {
        await syncUserPresence(client, userId, { initial: false, notify: false });
    }
};

module.exports.init = function (client) {
    ensureMaps(client);
    if (!isEnabled(client)) {
        console.log('[PresenceMonitor] Disabled or no guild configured');
        return;
    }
    console.log('[PresenceMonitor] Enabled — watching presence in configured guild(s)');
};
