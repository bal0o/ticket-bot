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
    if (!client.presenceDisplayNames) client.presenceDisplayNames = new Map();
}

async function resolveDisplayName(client, userId, member) {
    const key = String(userId);
    const cached = client.presenceDisplayNames?.get(key);
    if (cached) return cached;

    if (member) {
        const name = member.displayName || member.user?.username || member.user?.globalName;
        if (name) {
            client.presenceDisplayNames.set(key, name);
            return name;
        }
    }

    const user = await client.users.fetch(userId).catch(() => null);
    const name = user?.username || user?.globalName || `User ${key}`;
    client.presenceDisplayNames.set(key, name);
    return name;
}

/** @returns {Map<string, { staffThreadId: string, ticketNumber: string, ticketChannelId: string, username?: string, statusMessageId?: string }>} */
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

function formatStatusMessage(displayName, online) {
    const label = online ? '**online**' : '**offline**';
    const name = displayName || 'Ticket user';
    return `📡 **Ticket user status** — **${name}** is currently ${label}.`;
}

function formatUnableToMonitorMessage(displayName, guildName) {
    const name = displayName || 'Ticket user';
    return `📡 **Ticket user status** — Unable to monitor **${name}** (not found in **${guildName}**). They may not share a server with the bot, or presence tracking is unavailable.`;
}

async function findExistingStatusMessage(client, thread) {
    if (!thread?.messages?.fetch) return null;
    try {
        const messages = await thread.messages.fetch({ limit: 50 });
        for (const msg of messages.values()) {
            if (msg.author?.id === client.user?.id && msg.content?.startsWith('📡 **Ticket user status**')) {
                return msg.id;
            }
        }
    } catch (_) {}
    return null;
}

async function upsertStatusMessage(client, staffThreadId, content, statusMessageId) {
    const thread = await client.channels.fetch(staffThreadId).catch(() => null);
    if (!thread || typeof thread.send !== 'function') return null;

    const payload = { content, allowedMentions: { parse: [] } };

    if (statusMessageId) {
        const msg = await thread.messages.fetch(statusMessageId).catch(() => null);
        if (msg && msg.author?.id === client.user?.id) {
            try {
                await msg.edit(payload);
                return statusMessageId;
            } catch (_) {}
        }
    }

    try {
        const sent = await thread.send(payload);
        return sent?.id || null;
    } catch (e) {
        func.handle_errors(e, client, 'presenceMonitor.js', `Failed to post status to thread ${staffThreadId}`);
        return null;
    }
}

async function postStatusToMonitor(client, monitors, threadId, entry, content) {
    const messageId = await upsertStatusMessage(client, entry.staffThreadId, content, entry.statusMessageId);
    if (messageId && messageId !== entry.statusMessageId) {
        entry.statusMessageId = messageId;
        monitors.set(threadId, entry);
    }
}

async function broadcastStatus(client, userId, online) {
    const monitors = getUserMonitors(client, userId);
    if (monitors.size === 0) return;
    const displayName = await resolveDisplayName(client, userId);
    const content = formatStatusMessage(displayName, online);
    for (const [threadId, entry] of monitors.entries()) {
        await postStatusToMonitor(client, monitors, threadId, entry, content);
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
            const displayName = await resolveDisplayName(client, userId);
            const msg = formatUnableToMonitorMessage(displayName, guildName);
            for (const [threadId, entry] of monitors.entries()) {
                await postStatusToMonitor(client, monitors, threadId, entry, msg);
            }
        }
        return;
    }

    const online = isUserOnline(member);
    const statusKey = online ? 'online' : 'offline';
    const prev = client.presenceLastStatus.get(key);

    if (notify && (initial || (prev !== undefined && prev !== statusKey))) {
        await broadcastStatus(client, userId, online);
    }

    client.presenceLastStatus.set(key, statusKey);
}

module.exports.registerTicket = async function (client, { userId, username, staffThreadId, ticketNumber, ticketChannelId }) {
    if (!isEnabled(client) || !staffThreadId || !userId) return;

    ensureMaps(client);
    if (username) {
        client.presenceDisplayNames.set(String(userId), String(username));
    }

    const monitors = getUserMonitors(client, userId);
    monitors.set(String(staffThreadId), {
        staffThreadId: String(staffThreadId),
        ticketNumber: String(ticketNumber || ''),
        ticketChannelId: String(ticketChannelId || ''),
        username: username ? String(username) : undefined
    });

    const { member } = await resolveMember(client, userId);
    const key = String(userId);
    const displayName = await resolveDisplayName(client, userId, member);

    const threadKey = String(staffThreadId);
    const entry = monitors.get(threadKey);

    if (!member) {
        const primaryGuild = client.guilds.cache.get(getPresenceGuildId(client));
        const guildName = primaryGuild?.name || 'the configured server';
        if (entry) {
            await postStatusToMonitor(client, monitors, threadKey, entry, formatUnableToMonitorMessage(displayName, guildName));
        }
        return;
    }

    const online = isUserOnline(member);
    const statusKey = online ? 'online' : 'offline';
    if (entry) {
        await postStatusToMonitor(client, monitors, threadKey, entry, formatStatusMessage(displayName, online));
    }
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
            client.presenceDisplayNames?.delete(userId);
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
    await resolveDisplayName(client, userId, member);
    await broadcastStatus(client, userId, online);
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

        const statusMessageId = await findExistingStatusMessage(client, thread);
        monitors.set(String(thread.id), {
            staffThreadId: String(thread.id),
            ticketNumber: String(ticketNumber),
            ticketChannelId: String(channel.id),
            ...(statusMessageId ? { statusMessageId } : {})
        });
        await resolveDisplayName(client, topic).catch(() => {});
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
