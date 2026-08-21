const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags, Collection, StringSelectMenuBuilder } = require("discord.js");
const { createDB } = require('./mysql')
const db = createDB();
const bots = require("./clients");
const func = require("./functions.js")
const lang = require("../content/handler/lang.json");
const path = require("path");
let messageid = { messageId: "", internalMessageId: "" };
try {
    messageid = require("../config/messageid.json");
    if (typeof messageid !== 'object' || messageid === null) messageid = { messageId: "", internalMessageId: "" };
    if (messageid.messageId === undefined) messageid.messageId = "";
    if (messageid.internalMessageId === undefined) messageid.internalMessageId = "";
} catch (_) {
    try {
        const msgPath = path.join(__dirname, "..", "config", "messageid.json");
        fs.writeFileSync(msgPath, JSON.stringify(messageid));
    } catch (__) {}
}
const unirest = require("unirest");
const fs = require("fs");
const applications = require('./applications');
const perms = require('./permissions');

/**
 * Check if a ticket type is internal by looking up the question file
 * @param {string} ticketType - The ticket type name (e.g., "Admin Escalation" or "admin-escalation")
 * @returns {boolean} - True if the ticket type is internal, false otherwise
 */
module.exports.isTicketTypeInternal = function(ticketType) {
    try {
        if (!ticketType) return false;
        const handlerRaw = require("../content/handler/options.json");
        
        // Normalize the input: convert to lowercase and replace hyphens/spaces with a common separator
        const normalizedInput = ticketType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        
        // Try to find a match by normalizing both the input and the option keys
        const found = Object.keys(handlerRaw.options).find(optionKey => {
            const normalizedKey = optionKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            return normalizedKey === normalizedInput || optionKey.toLowerCase() === ticketType.toLowerCase();
        });
        
        if (!found) return false;
        const questionFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
        return !!questionFile.internal;
    } catch (_) {
        return false;
    }
};

/**
 * Check if a ticket type should be excluded from open ticket counts
 * (includes internal tickets and staff applications)
 * @param {string} ticketType - The ticket type name (e.g., "Staff Application" or "Admin Escalation")
 * @returns {boolean} - True if the ticket should be excluded from counts, false otherwise
 */
module.exports.shouldExcludeFromTicketCount = function(ticketType) {
    if (!ticketType) return false;
    
    // Check if it's an internal ticket
    if (module.exports.isTicketTypeInternal(ticketType)) {
        return true;
    }
    
    // Check if it's a staff application (case-insensitive)
    const normalizedType = ticketType.toLowerCase();
    if (normalizedType.includes('application') || normalizedType.includes('staff application')) {
        return true;
    }
    
    return false;
};

function ticketDmRelayKey(userId, ticketId) {
    return `TicketDmRelay.${userId}.${ticketId}`;
}

/** Parse ticket type label from pinned embed footer (`userId-num | Type | Ticket Opened:`). */
module.exports.parseTicketTypeFromEmbedFooter = function(footerText) {
    if (!footerText || typeof footerText !== 'string') return null;
    const parts = footerText.split('|');
    if (parts.length < 2) return null;
    const label = (parts[1] || '').trim();
    return label || null;
};

/** Parse numeric ticket id from channel name (e.g. appeal-1234 → 1234). */
module.exports.parseTicketNumberFromChannelName = function(channelName) {
    const parts = String(channelName || '').replace(/-claimed$/i, '').split('-');
    const last = parts[parts.length - 1];
    return /^\d+$/.test(last) ? last : null;
};

module.exports.setTicketDmRelay = async function(userId, ticketId, enabled) {
    if (!userId || !ticketId || typeof db.set !== 'function') return;
    await db.set(ticketDmRelayKey(userId, ticketId), !!enabled);
};

module.exports.getTicketDmRelay = async function(userId, ticketId) {
    if (!userId || !ticketId || typeof db.get !== 'function') return null;
    const value = await db.get(ticketDmRelayKey(userId, ticketId));
    if (value === true || value === 1 || value === '1') return true;
    if (value === false || value === 0 || value === '0') return false;
    return null;
};

/** Keep DM relay enabled when a public ticket is moved to an internal type. */
module.exports.preserveTicketDmRelayOnMove = async function(userId, ticketId, oldTicketType) {
    if (!userId || !ticketId) return;
    const existing = await module.exports.getTicketDmRelay(userId, ticketId);
    if (existing === true) return;
    if (!module.exports.isTicketTypeInternal(oldTicketType)) {
        await module.exports.setTicketDmRelay(userId, ticketId, true);
    }
};

module.exports.EPHEMERAL = MessageFlags.Ephemeral;

/** Fetch a specific guild member by ID (REST; does not require Guild Members intent). */
module.exports.resolveGuildMember = async function(guild, userId, { force = false } = {}) {
    if (!guild || !userId) return null;
    try {
        if (force) {
            return await guild.members.fetch({ user: userId, force: true });
        }
        const cached = guild.members.cache.get(String(userId));
        if (cached) return cached;
        return await guild.members.fetch({ user: userId });
    } catch (_) {
        return null;
    }
};

/** Resolve the guild member who sent a message, fetching by ID when needed. */
module.exports.resolveMessageMember = async function(message, { force = false } = {}) {
    if (message?.member) return message.member;
    if (!message?.guild || !message?.author?.id) return null;
    return module.exports.resolveGuildMember(message.guild, message.author.id, { force });
};

/** Build staff author details for relay embeds. */
module.exports.getStaffReplyAuthorInfo = function(member, author) {
    const authorName = author?.globalName || author?.username || 'Staff';
    if (!member) {
        return {
            displayName: authorName,
            roleName: 'Staff',
            avatarURL: typeof author?.displayAvatarURL === 'function' ? author.displayAvatarURL() : null
        };
    }

    let roleName = 'Staff';
    try {
        const roles = member.roles.cache
            .filter(role => role.id !== member.guild.id)
            .sort((a, b) => b.position - a.position);
        const highestRole = roles.first();
        if (highestRole) roleName = highestRole.name;
    } catch (_) {}

    const displayName = member.displayName || authorName;
    const avatarURL = (typeof member.displayAvatarURL === 'function' && member.displayAvatarURL())
        || (typeof author?.displayAvatarURL === 'function' && author.displayAvatarURL())
        || null;

    return { displayName, roleName, avatarURL };
};

/** Check whether a member has any of the given role IDs. */
module.exports.memberHasAnyRole = function(member, roleIds) {
    if (!member || !Array.isArray(roleIds) || roleIds.length === 0) return false;
    return member.roles.cache.some(role => roleIds.includes(role.id));
};

/**
 * Whether staff messages in the ticket channel should be forwarded to the owner's DMs.
 * Public tickets always relay; moved public→internal tickets keep relay via stored flag.
 */
module.exports.shouldRelayStaffToTicketOwner = async function(client, channel, userId, ticketTypeQuestionFile) {
    const ticketId = module.exports.parseTicketNumberFromChannelName(channel && channel.name);
    if (userId && ticketId) {
        const stored = await module.exports.getTicketDmRelay(userId, ticketId);
        if (stored === true) return true;
        if (stored === false) return false;
    }

    if (!ticketTypeQuestionFile || !ticketTypeQuestionFile.internal) return true;

    if (!channel || !channel.guild || !userId) return false;

    try {
        const member = await module.exports.resolveGuildMember(channel.guild, userId, { force: true });
        if (!member) return true;
        const perms = channel.permissionsFor(member);
        return !perms || !perms.has(PermissionsBitField.Flags.ViewChannel);
    } catch (_) {
        return true;
    }
};

/**
 * Send a DM with retries and delivery verification.
 * Returns { delivered: boolean, message: Message|null, error: Error|null }
 * On final failure, logs to the configured error channel via handle_errors.
 */
module.exports.sendDMWithRetry = async function(user, payload, opts = {}) {
    // Guard against accidentally sending completely empty DMs
    try {
        if (typeof payload === 'string') {
            if (!payload.trim()) {
                // Refuse to send a truly empty string DM
                throw new Error('sendDMWithRetry called with empty string payload');
            }
        } else if (payload && typeof payload === 'object') {
            const hasContent = typeof payload.content === 'string' && payload.content.trim() !== '';
            const hasEmbeds = Array.isArray(payload.embeds) && payload.embeds.length > 0;
            const hasFiles = Array.isArray(payload.files) && payload.files.length > 0;
            if (!hasContent && !hasEmbeds && !hasFiles) {
                throw new Error('sendDMWithRetry called with empty object payload (no content/embeds/files)');
            }
        }
    } catch (guardErr) {
        // Surface via handle_errors but don't crash callers
        try {
            module.exports.handle_errors(guardErr, user.client || null, 'functions.js', 'sendDMWithRetry guard rejected empty payload');
        } catch (_) {}
        return { delivered: false, message: null, error: guardErr };
    }

    const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 3;
    const baseDelayMs = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : 500;
    let attempt = 0;
    /** Classify if error is retryable */
    const isRetryable = (err) => {
        if (!err) return false;
        const code = err.code;
        const name = err.name || '';
        const msg = (err.message || '').toString();
        // Non-retryable: user DMs closed or cannot send to user
        if (code === 50007 || /Cannot send messages to this user/i.test(msg)) return false;
        // Unknown Channel/Message → not applicable to DMs; treat as non-retryable
        if (code === 10003 || code === 10008) return false;
        // Network / 5xx / transient Discord errors
        if (code === 500 || code === 502 || code === 503 || code === 504) return true;
        if (/FetchError|ETIMEDOUT|ECONNRESET|ENOTFOUND|rate.?limit/i.test(msg)) return true;
        // Default: retry once for unknown errors
        return true;
    };
    while (attempt < maxAttempts) {
        try {
            try {
                const logger = require('./logger');
                logger.event('sendDMWithRetry.attempt', {
                    userId: user && user.id ? user.id : 'unknown',
                    attempt,
                    maxAttempts,
                    hasContent: typeof payload === 'string' ? !!payload.trim() : !!(payload && typeof payload === 'object' && typeof payload.content === 'string' && payload.content.trim() !== ''),
                    hasEmbeds: !!(payload && typeof payload === 'object' && Array.isArray(payload.embeds) && payload.embeds.length > 0),
                    hasFiles: !!(payload && typeof payload === 'object' && Array.isArray(payload.files) && payload.files.length > 0)
                });
            } catch (_) {}
            const dmUser = await bots.fetchDmUser(user && user.client, user && user.id) || user;
            const message = await dmUser.send(payload);
            return { delivered: !!(message && message.id), message: message || null, error: null };
        } catch (err) {
            attempt++;
            if (!isRetryable(err) || attempt >= maxAttempts) {
                // Surface the failure to the bot's error channel
                try {
                    const client = (user && user.client) || null;
                    const context = `sendDMWithRetry final failure for user ${user && user.id ? user.id : 'unknown'}`;
                    module.exports.handle_errors(err, client, 'functions.js', context);
                } catch (_) {}
                return { delivered: false, message: null, error: err };
            }
            const jitter = Math.floor(Math.random() * 200);
            const delay = Math.min(5000, baseDelayMs * Math.pow(2, attempt - 1) + jitter);
            await new Promise(res => setTimeout(res, delay));
        }
    }
    return { delivered: false, message: null, error: new Error('Unknown DM send failure') };
}

// Cache for pinned messages to prevent rate limiting
const pinnedCache = new Map(); // channelId -> { messages, timestamp }
const pendingFetches = new Map(); // channelId -> Promise
const lastFetchTimes = new Map(); // channelId -> timestamp of last fetch attempt
const CACHE_TTL = 60000; // 60 seconds cache (longer to avoid rate limits)
const MIN_REQUEST_INTERVAL = 3500; // Minimum 3.5 seconds between requests (respects 3s sublimit with margin)

function pinEntriesToCollection(pinData) {
    const messages = new Collection();
    const add = (value) => {
        const msg = value && value.message && value.message.id ? value.message : value;
        if (msg && msg.id) messages.set(msg.id, msg);
    };
    if (!pinData) return messages;
    if (typeof pinData.values === 'function') {
        for (const value of pinData.values()) add(value);
        return messages;
    }
    if (Array.isArray(pinData.items)) {
        for (const item of pinData.items) add(item);
        return messages;
    }
    if (Array.isArray(pinData)) {
        for (const item of pinData) add(item);
    }
    return messages;
}

module.exports.clearPinnedCache = function(channelId) {
    if (channelId) pinnedCache.delete(channelId);
};

function isTicketMetadataMessage(msg, ticketNumber) {
    const embed = msg && msg.embeds && msg.embeds[0];
    if (!embed) return false;
    const footer = embed.footer && embed.footer.text;
    if (typeof footer === 'string' && /\d{17,19}-\d+\s*\|/.test(footer)) return true;
    if (ticketNumber && typeof embed.title === 'string' && embed.title.includes(`#${ticketNumber}`)) return true;
    return false;
}

module.exports.findTicketMetadataMessage = async function(channel, ticketNumber) {
    if (!channel || !channel.messages) return null;
    const pins = await module.exports.fetchPinnedSafe(channel);
    const fromPins = pins.find(msg => isTicketMetadataMessage(msg, ticketNumber));
    if (fromPins) return fromPins;
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent) return null;
    return recent.find(msg => isTicketMetadataMessage(msg, ticketNumber)) || null;
};

module.exports.updateTicketMetadataEmbed = async function(message, embed) {
    if (!message || !embed) return null;
    try {
        const edited = await message.edit({ embeds: [embed] });
        module.exports.clearPinnedCache(message.channelId);
        return edited;
    } catch (e) {
        if (!e || (e.code !== 50005 && e.code !== 50013)) throw e;
        const sent = await message.channel.send({
            content: message.content || undefined,
            embeds: [embed],
            components: message.components
        });
        await sent.pin().catch(() => {});
        await message.unpin().catch(() => {});
        module.exports.clearPinnedCache(message.channelId);
        return sent;
    }
};

module.exports.fetchPinnedSafe = async function(channel) {
    if (!channel || !channel.messages) {
        throw new Error('Invalid channel provided');
    }
    
    const channelId = channel.id;
    const now = Date.now();
    
    const cached = pinnedCache.get(channelId);
    if (cached && cached.messages && cached.messages.size > 0 && (now - cached.timestamp) < CACHE_TTL) {
        return cached.messages;
    }
    
    // If there's already a pending fetch, wait for it instead of creating a new one
    if (pendingFetches.has(channelId)) {
        try {
            return await pendingFetches.get(channelId);
        } catch (err) {
            // If pending fetch failed, we'll try again below
            pendingFetches.delete(channelId);
        }
    }
    
    // Respect minimum interval between requests to avoid sublimit violations
    const lastFetch = lastFetchTimes.get(channelId);
    if (lastFetch && (now - lastFetch) < MIN_REQUEST_INTERVAL) {
        const waitTime = MIN_REQUEST_INTERVAL - (now - lastFetch);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Create a new fetch promise
    const fetchPromise = (async () => {
        const maxAttempts = 3;
        let attempt = 0;
        let baseDelay = 4000; // Start with 4 seconds to respect sublimit
        
        while (attempt < maxAttempts) {
            try {
                lastFetchTimes.set(channelId, Date.now());
                let messages = pinEntriesToCollection(await channel.messages.fetchPins());
                if (messages.size === 0 && typeof channel.messages.fetchPinned === 'function') {
                    try {
                        messages = pinEntriesToCollection(await channel.messages.fetchPinned(true));
                    } catch (_) {}
                }
                pinnedCache.set(channelId, { messages, timestamp: Date.now() });
                return messages;
            } catch (err) {
                attempt++;
                
                // Handle rate limit errors (429)
                // Discord.js may provide rate limit info in different formats
                const isRateLimit = err.code === 429 || err.httpStatus === 429 || 
                                   (err.request && err.request.status === 429) ||
                                   (err.message && /429|rate.?limit/i.test(err.message));
                
                if (isRateLimit) {
                    // Try to extract retry_after from various possible locations
                    let retryAfter = 3; // Default to 3 seconds for sublimit
                    if (err.retry_after !== undefined) {
                        retryAfter = typeof err.retry_after === 'number' ? err.retry_after : parseFloat(err.retry_after) || 3;
                    } else if (err.retryAfter !== undefined) {
                        retryAfter = typeof err.retryAfter === 'number' ? err.retryAfter : parseFloat(err.retryAfter) || 3;
                    } else if (err.timeout !== undefined) {
                        retryAfter = typeof err.timeout === 'number' ? err.timeout / 1000 : 3;
                    }
                    
                    // retry_after is usually in seconds, convert to milliseconds
                    // Add extra margin for sublimit
                    const delay = Math.max(
                        (retryAfter * 1000) + 500, // Add 500ms margin
                        MIN_REQUEST_INTERVAL * (attempt + 1) // Exponential backoff respecting sublimit
                    );
                    const finalDelay = Math.min(delay, 60000); // Max 60s
                    
                    if (attempt < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, finalDelay));
                        continue;
                    }
                }
                
                // For non-rate-limit errors, retry with exponential backoff
                if (attempt < maxAttempts) {
                    const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 10000);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                
                // All attempts failed
                throw err;
            }
        }
        
        throw new Error('Failed to fetch pinned messages after retries');
    })();
    
    // Store the promise so concurrent calls can share it
    pendingFetches.set(channelId, fetchPromise);
    
    try {
        const result = await fetchPromise;
        return result;
    } finally {
        // Clean up the pending fetch after completion
        pendingFetches.delete(channelId);
    }
}

/** Discord limit: max channels per category */
const MAX_CHANNELS_PER_CATEGORY = 50;

/**
 * Returns a category ID that has room for a new channel (< 50 children).
 * If the preferred category is full, finds an existing overflow category with room or creates one.
 * @param {Client} client - Bot client (for logging)
 * @param {Guild} staffGuild - The guild to look in
 * @param {string|null} preferredCategoryId - Preferred category ID from config
 * @param {string} ticketType - Ticket type name (for logging/overflow naming)
 * @returns {Promise<string|null>} Category ID to use, or null for guild root
 */
async function getCategoryWithRoom(client, staffGuild, preferredCategoryId, ticketType) {
    if (!staffGuild?.channels?.cache) return preferredCategoryId || null;

    const categoryById = (id) => staffGuild.channels.cache.get(id);
    const countChildren = (categoryId) =>
        staffGuild.channels.cache.filter((c) => c.parentId === categoryId).size;

    const tryCategory = (cat) => {
        if (!cat || cat.type !== ChannelType.GuildCategory) return null;
        return countChildren(cat.id) < MAX_CHANNELS_PER_CATEGORY ? cat.id : null;
    };

    if (preferredCategoryId) {
        const preferred = categoryById(preferredCategoryId);
        const usable = tryCategory(preferred);
        if (usable) return usable;

        // Preferred is full: look for existing overflow categories (same name + " (2)", " (3)", ...)
        const baseName = preferred?.name || 'Tickets';
        const overflowCats = staffGuild.channels.cache.filter(
            (c) => c.type === ChannelType.GuildCategory && c.name.startsWith(baseName)
        );
        for (const [, cat] of overflowCats) {
            const id = tryCategory(cat);
            if (id) return id;
        }

        // Create new overflow category: "BaseName (N)" for next N
        let n = 2;
        let name = `${baseName} (${n})`;
        while (staffGuild.channels.cache.some((c) => c.name === name)) {
            n++;
            name = `${baseName} (${n})`;
        }
        try {
            const newCat = await staffGuild.channels.create({ name, type: ChannelType.GuildCategory });
            if (client) func.handle_errors(null, client, 'functions.js', `Category "${baseName}" was full; created overflow category "${name}" for ticket type '${ticketType}'.`);
            return newCat.id;
        } catch (e) {
            if (client) func.handle_errors(e, client, 'functions.js', `Failed to create overflow category for '${ticketType}'; will try guild root.`);
            return null;
        }
    }

    return null;
}

/**
 * If parentCategoryId points to an overflow category (name like "Tickets (2)")
 * and it has no remaining children, delete the category. Call after deleting a ticket channel.
 * @param {Client|null} client - Bot client (for error logging)
 * @param {Guild} guild - Guild that owned the channel
 * @param {string|null} parentCategoryId - Parent category ID (from channel.parentId before delete)
 */
async function deleteEmptyOverflowCategory(client, guild, parentCategoryId) {
    if (!guild?.channels?.cache || !parentCategoryId) return;
    const category = guild.channels.cache.get(parentCategoryId);
    if (!category || category.type !== ChannelType.GuildCategory) return;
    // Overflow categories we create are named "BaseName (2)", "BaseName (3)", etc.
    if (!/^.+\s+\(\d+\)$/.test(category.name)) return;
    const childCount = guild.channels.cache.filter((c) => c.parentId === parentCategoryId).size;
    if (childCount > 0) return;
    try {
        await category.delete();
    } catch (e) {
        if (e?.code === 10003) return; // Already deleted
        if (client) func.handle_errors(e, client, 'functions.js', 'Failed to delete empty overflow category');
    }
}

module.exports.deleteEmptyOverflowCategory = deleteEmptyOverflowCategory;

module.exports.handle_errors = async (err, client, file, message) => {

	let ErrorChannel = client ? bots.findCachedChannel(client, client.config && client.config.channel_ids && client.config.channel_ids.error_channel) : null

    let errorEmbed = new EmbedBuilder()
    .setColor(0x990000)
    .setTitle(`Error Found!`)

    if (err) {
            errorEmbed.setDescription(`\`\`\`${err.stack ? err.stack.substring(0, 4000) : "Unknown"}\`\`\``)
            errorEmbed.addFields({ name: `Name`, value: err.name == null ? "No Name" : err.name.toString() })
            errorEmbed.addFields({ name: `Message`, value: err.msg == null ? "No Message" : err.msg.toString() })
            errorEmbed.addFields({ name: `Path`, value: err.path == null ? "No Path" : err.path.toString() })
            errorEmbed.addFields({ name: `Code`, value: err.code == null ? "No Code" : err.code.toString() })
            errorEmbed.addFields({ name: `File Name`, value: file ? file : "Unknown" })
    } else {
            errorEmbed.setDescription(`\`\`\`${message ? message : "Unknown Error (This shouldn't happen)"}\`\`\``)
            errorEmbed.addFields({ name: `File Name`, value: file ? file : `Unknown` })
    }

    if (!ErrorChannel) {
        console.log(err)
        console.log(`[FUNCTIONS - HANDLE_ERRORS] Could not find the error channel to display an error. Please make sure the channel ID is correct!`)
        return;
    }

    await ErrorChannel.send({ embeds: [errorEmbed] }).catch(e => {

        if (e.message == "Unknown Channel") {
            console.log(err)
            console.log(`[FUNCTIONS - HANDLE_ERRORS] Could not find the error channel to display an error. Please make sure the channel ID is correct!`)
        }
    })
}

module.exports.padTo2Digits = async (num) => {
    return num.toString().padStart(2, '0');
}

module.exports.convertMsToTime = async (milliseconds) => {
    let seconds = Math.floor(milliseconds / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);
  
    seconds = seconds % 60;
    minutes = minutes % 60;
    
    if (hours == 0 && minutes == 0) return `${await func.padTo2Digits(seconds,)} seconds`;
    if (hours == 0) return `${await func.padTo2Digits(minutes)} minutes and ${await func.padTo2Digits(seconds,)} seconds`;

    return `${await func.padTo2Digits(hours)} hours, ${await func.padTo2Digits(minutes)} minutes and ${await func.padTo2Digits(
      seconds,
    )} seconds`;
}

module.exports.closeDataAddDB = async (userid, ticketUniqueID, closeType, closeUser, closeUserID, closeTime, closeReason, transcriptURL = null) => {
	try {
		if (typeof db.query === 'function') {
			let closeTimeSeconds = Number(closeTime);
			if (!Number.isFinite(closeTimeSeconds)) closeTimeSeconds = Math.floor(Date.now() / 1000);
			if (closeTimeSeconds > 9999999999) closeTimeSeconds = Math.floor(closeTimeSeconds / 1000);
			else closeTimeSeconds = Math.floor(closeTimeSeconds);
			await db.query(
				`UPDATE tickets SET 
					close_type = ?, 
					close_user = ?, 
					close_user_id = ?, 
					close_time = ?, 
					close_reason = ?,
					transcript_url = COALESCE(?, transcript_url)
				WHERE user_id = ? AND ticket_id = ?`,
				[closeType, closeUser, closeUserID, closeTimeSeconds, closeReason, transcriptURL, String(userid), String(ticketUniqueID)]
			);
		}
	} catch (err) {
		console.error('[functions] Error updating ticket close data in MySQL:', {
			message: err.message,
			userId: userid,
			ticketId: ticketUniqueID
		});
		// Don't throw - ticket closing should continue even if MySQL update fails
	}
}

/** Derive BM staff-tool region (eu/us/au) from ticket responses. */
function getRegionCodeFromResponses(responses) {
    if (typeof responses !== 'string' || !responses.length) return null;
    try {
        let regionSource = null;
        const regionMatch = responses.match(/\*\*Region:\*\*\n(.*?)(?:\n\n|$)/i);
        if (regionMatch && regionMatch[1]) {
            regionSource = regionMatch[1].trim();
        } else {
            const serverMatch = responses.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/i);
            if (serverMatch && serverMatch[1]) regionSource = serverMatch[1].trim();
        }
        if (!regionSource) return null;
        const lower = regionSource.toLowerCase();
        if (lower.includes('eu')) return 'eu';
        if (lower.includes('us')) return 'us';
        if (lower.includes('au')) return 'au';
    } catch (_) {}
    return null;
}

/** Markdown value for staff-thread Quick Links embed field. */
function buildStaffQuickLinksValue(client, userId, steamId, responses) {
    const baseWeb = (client.config?.transcript_settings?.base_url || '').replace(/\/?transcripts\/?$/i, '') || 'http://localhost:3050';
    const lines = [
        `[Previous Tickets](${baseWeb}/staff?user=${userId})`
    ];
    if (steamId && steamId.toString().startsWith('7656119')) {
        const regionCode = getRegionCodeFromResponses(responses);
        let lookupUrl = `https://staff.britspve.com/lookup/player?steamid=${encodeURIComponent(String(steamId))}`;
        if (regionCode) lookupUrl += `&region=${regionCode}`;
        lines.push(`[Player Lookup](${lookupUrl})`);
    }
    return lines.join('\n');
}

/** True when BM lookup runs after open and will post the combined staff-thread embed. */
module.exports.willDeferStaffBmEmbed = function (client, steamId, bmInfo) {
    return !bmInfo
        && steamId
        && steamId.toString().startsWith('7656119')
        && !!client.config?.tokens?.battlemetricsToken;
};

function buildStaffThreadEmbed(client, recepientMember, formattedTicketNumber, steamId, responses, bmInfo) {
    const quickLinksField = {
        name: 'Quick Links',
        value: buildStaffQuickLinksValue(client, recepientMember.id, steamId, responses),
        inline: false
    };
    const embed = new EmbedBuilder()
        .setColor(client.config.bot_settings.main_color)
        .setAuthor({ name: `${recepientMember.username} (${recepientMember.id})`, iconURL: recepientMember.displayAvatarURL() });

    if (bmInfo) {
        const steamProfileId = bmInfo.steamId || steamId;
        embed.setTitle('User Info')
            .addFields(quickLinksField)
            .addFields(
                {
                    name: 'BM Name',
                    value: bmInfo.inGameName && bmInfo.playerId
                        ? `[${bmInfo.inGameName}](https://www.battlemetrics.com/rcon/players/${bmInfo.playerId})`
                        : 'N/A',
                    inline: true
                },
                {
                    name: 'BM Most Recent Server',
                    value: bmInfo.mostRecentServer && bmInfo.mostRecentServerId
                        ? `[${bmInfo.mostRecentServer}](https://www.battlemetrics.com/servers/rust/${bmInfo.mostRecentServerId})`
                        : 'N/A',
                    inline: true
                },
            )
            .addFields(
                { name: 'Time Played', value: `${bmInfo.timePlayed ? Math.floor(bmInfo.timePlayed / 3600) : 0} hours`, inline: true },
                {
                    name: 'First Seen',
                    value: bmInfo.firstSeen ? `<t:${Math.floor(new Date(bmInfo.firstSeen).getTime() / 1000)}:R>` : 'N/A',
                    inline: true
                },
                {
                    name: 'Last Seen',
                    value: bmInfo.lastSeen ? `<t:${Math.floor(new Date(bmInfo.lastSeen).getTime() / 1000)}:R>` : 'N/A',
                    inline: true
                },
            )
            .addFields(
                {
                    name: 'Steam Profile',
                    value: steamProfileId && steamProfileId.toString().startsWith('7656119')
                        ? `[${steamProfileId}](https://steamcommunity.com/profiles/${steamProfileId})`
                        : 'N/A'
                }
            );
        if (bmInfo.banInfo && bmInfo.banInfo.length > 0) {
            embed.addFields({ name: 'BM Bans', value: bmInfo.banInfo.join('\n').substring(0, 1024) });
        }
    } else {
        embed.setTitle('Staff Resources')
            .setDescription(`Ticket #${formattedTicketNumber}`)
            .addFields(quickLinksField);
    }
    return embed;
}

module.exports.sendStaffThreadInfo = async function (client, thread, recepientMember, formattedTicketNumber, steamId, responses, bmInfo) {
    if (!thread || typeof thread.send !== 'function') return;
    const embed = buildStaffThreadEmbed(client, recepientMember, formattedTicketNumber, steamId, responses, bmInfo);
    try {
        await thread.send({ embeds: [embed] });
    } catch (_) {}
};

/** Notify the user when ticket creation fails (ephemeral reply + DM when possible). */
async function notifyTicketCreationFailed(interaction, recepientMember) {
    const message = 'Your ticket could not be created. Please try again or contact staff.';
    if (interaction?.editReply) {
        await interaction.editReply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (recepientMember) {
        await module.exports.sendDMWithRetry(recepientMember, message, { maxAttempts: 2, baseDelayMs: 500 });
    }
}

module.exports.openTicket = async (client, interaction, questionFile, recepientMember, administratorMember, ticketType, embed, formattedTicketNumber, questionFilesystem, responses, bmInfo, steamId) => {
    // Null check for recepientMember
    if (!recepientMember) {
        func.handle_errors(null, client, 'functions.js', 'openTicket called with null recepientMember');
        if (interaction && interaction.editReply) {
            await interaction.editReply({ content: 'Could not find the user who opened this ticket. Please contact staff.', flags: MessageFlags.Ephemeral });
        }
        return;
    }

    let postchannel = null;
    let postchannelCategory = null;
    const staffBot = bots.staffClient(client);
    
    // Only try to get post channel if not using open-as-ticket
    if (!questionFile["open-as-ticket"]) {
        postchannel = staffBot.channels.cache.get(questionFile[`post-channel`]);
        if (postchannel) {
            postchannelCategory = postchannel.parentId;
        }
    }
    
    let ticketCategory = questionFile[`ticket-category`]
    let accessRoleIDs = questionFile[`access-role-id`]
	let pingRoleIDs = questionFile[`ping-role-id`];
    let staffGuild = staffBot.guilds.cache.get(client.config.channel_ids.staff_guild_id)

    if (administratorMember == null) {
        administratorMember = "Auto Ticket";
    }

    let creatorName = recepientMember.username.trim().replace(/[\r\n\x0B\x0C\u0085\u2028\u2029]+/g, `\n`);
    creatorName = creatorName.substring(0, 8).replace(`-`, ``).replace(` `, ``);;
    let creatorID = recepientMember.id

let overwrites = [
        {
            id: staffGuild.id,
            deny: ['ViewChannel', 'AddReactions'],
        },
        {
            id: staffBot.user.id,
            allow: ['ViewChannel', 'SendMessages', 'AddReactions', 'ManageThreads'],
        },
        {
            id: client.config.role_ids.default_admin_role_id,
            allow: ['ViewChannel', 'SendMessages'],
        }
    ];

    for (let role of accessRoleIDs) {

    if(role != "") {
        let accessRole = staffGuild.roles.cache.find(x => x.id == role)
        if(!accessRole) {
            func.handle_errors(null, client, `functions.js`, `Can not add "access role" to channel permissions as it doesn't exist!`)

        } else {
            let add = {
                id: role,
                allow: ['ViewChannel', 'SendMessages'],
            }
            overwrites.push(add)
        }
    }
}

    // For internal tickets: add the user so they can participate directly in the channel (same Discord)
    if (questionFile.internal) {
        overwrites.push({
            id: recepientMember.id,
            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
        });
    }

// Get the server name from the responses if server selection is enabled
let serverPrefix = "";
const typesRequireServer = ["rp", "lost items", "reports"];
if (questionFilesystem.server_selection?.enabled) {
    // Extract server name from the responses
    const serverMatch = responses.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/);
    if (serverMatch && serverMatch[1]) {
        serverPrefix = serverMatch[1].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    } else if (typesRequireServer.includes(ticketType.toLowerCase())) {
        // If required and missing, notify and do not create ticket
        if (interaction && interaction.editReply) {
            await interaction.editReply({ content: `You must select a server for this ticket type (${ticketType}). Please try again.`, flags: MessageFlags.Ephemeral });
        }
        return;
    }
}

let channelName = "";
if (typesRequireServer.includes(ticketType.toLowerCase())) {
    channelName = `${serverPrefix}-${ticketType.toLowerCase()}-${formattedTicketNumber}`;
} else {
    channelName = `${serverPrefix ? serverPrefix + '-' : ''}${ticketType.toLowerCase()}-${formattedTicketNumber}`;
}

// Validate category before creation; fall back to parent of post channel or guild root
let parentId = null;
try {
    const desired = ticketCategory ? staffGuild.channels.cache.get(ticketCategory) : null;
    if (desired && desired.type === ChannelType.GuildCategory) {
        parentId = desired.id;
    } else if (postchannelCategory) {
        const p = staffGuild.channels.cache.get(postchannelCategory);
        if (p && p.type === ChannelType.GuildCategory) parentId = p.id;
    }
    if (!parentId) {
        func.handle_errors(null, client, 'functions.js', `Configured category invalid or missing for ticket type '${ticketType}'. Creating in guild root.`);
    }
} catch (_) { parentId = null; }

// Ensure we use a category that has room (Discord max 50 channels per category)
parentId = await getCategoryWithRoom(client, staffGuild, parentId, ticketType);

let ticketChannel;
try {
    ticketChannel = await staffGuild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: recepientMember.id,
        parent: parentId || null,
        permissionOverwrites: overwrites,
    });
} catch (createErr) {
    const isCategoryFull = createErr?.code === 50035 || (createErr?.message && String(createErr.message).includes('Maximum number of channels in category reached'));
    if (isCategoryFull && parentId) {
        // Retry with a fresh category (overflow); getCategoryWithRoom will create/find one
        try {
            const fallbackParentId = await getCategoryWithRoom(client, staffGuild, parentId, ticketType);
            ticketChannel = await staffGuild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                topic: recepientMember.id,
                parent: fallbackParentId || null,
                permissionOverwrites: overwrites,
            });
        } catch (retryErr) {
            func.handle_errors(retryErr, client, 'functions.js', 'openTicket channel create failed (retry after category full)');
            await notifyTicketCreationFailed(interaction, recepientMember);
            return;
        }
    } else {
        func.handle_errors(createErr, client, 'functions.js', 'openTicket channel create failed');
        await notifyTicketCreationFailed(interaction, recepientMember);
        return;
    }
}

// Index: add to user's active ticket channels
try {
    const key = `UserTicketIndex.${recepientMember.id}`;
    const list = (await db.get(key)) || [];
    if (!list.includes(ticketChannel.id)) {
        list.push(ticketChannel.id);
        await db.set(key, list);
    }
} catch (_) {}

// For public tickets, DM the user with the ticket name/number
try {
    if (!questionFile.internal) {
        await module.exports.sendDMWithRetry(recepientMember, `Your ticket (${serverPrefix ? serverPrefix + '-' : ''}${ticketType.toLowerCase()}-${formattedTicketNumber}) has been created. Please use this number for any follow-up.`);
    }
} catch (e) {}

    // Build action buttons. For application tickets, only show application actions.
    let actionRow = new ActionRowBuilder();
    const isApplication = ticketType && ticketType.toLowerCase().includes('application');
    if (isApplication) {
        actionRow.addComponents(
            new ButtonBuilder().setCustomId('app_next_stage').setLabel('Move to Next Stage').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('app_deny').setLabel('Deny').setStyle(ButtonStyle.Danger)
        );
    } else {
        actionRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`ticketclose`)
                .setLabel(lang.close_ticket["close-ticket-button-title"] != "" ? lang.close_ticket["close-ticket-button-title"] : `Close Ticket`)
                .setStyle(ButtonStyle.Danger)
                .setEmoji("📝"),
            new ButtonBuilder()
                .setCustomId(`moveticket`)
                .setLabel("Move Ticket")
                .setStyle(ButtonStyle.Primary)
                .setEmoji("↗️")
        );
        // Optional claim button for non-application tickets
        try {
            if (client.config?.claims?.enabled) {
                actionRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`claimticket`)
                        .setLabel('Claim Ticket')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('🧾')
                );
            }
        } catch (_) {}
    }

    // Always define pingTags
    let pingSet = new Set();
    if (pingRoleIDs && pingRoleIDs.length > 0) {
        for (let role of pingRoleIDs) {
            if (role == "") continue;
            pingSet.add(role);
        }
    }
    let pingTags = Array.from(pingSet).map(id => `<@&${id}>`).join(' ');
    
    const safeUsername = recepientMember.username;
    // Optionally build a dedicated history embed for staff applications with prior history info
    let historyEmbed = null;
    try {
        const isStaffApplication = questionFile && questionFile.staff_application === true;
        if (isStaffApplication && typeof applications?.listApplications === 'function') {
            const allForUser = await applications.listApplications({ userId: recepientMember.id });
            let priorDeniedCount = 0;
            let otherOpenCount = 0;
            if (Array.isArray(allForUser)) {
                for (const a of allForUser) {
                    if (!a) continue;
                    // This ticket just created the new application; older ones are those with different id
                    if (a.stage === 'Denied') priorDeniedCount++;
                    else if (!['Approved', 'Archived'].includes(a.stage)) otherOpenCount++;
                }
            }
            const lines = [];
            if (priorDeniedCount > 0) {
                lines.push(`This user has **${priorDeniedCount}** previous staff application${priorDeniedCount === 1 ? '' : 's'} that were **Denied**.`);
            }
            if (otherOpenCount > 0) {
                lines.push(`This user has **${otherOpenCount}** other application${otherOpenCount === 1 ? '' : 's'} still in progress.`);
            }
            if (lines.length) {
                historyEmbed = new EmbedBuilder()
                    .setColor(0xf97316) // bright orange to stand out
                    .setTitle('Application History')
                    .setDescription(lines.join('\n'));
            }
        }
    } catch (_) {}

    const baseContent = (lang.ticket_creation["initial-message-content"] != "" ? lang.ticket_creation["initial-message-content"].replace(`{{USERNAME}}`, safeUsername).replace(`{{TICKETTYPE}}`, ticketType).replace(`{{ADMIN}}`, administratorMember).replace(/{{PREFIX}}/g, client.config.bot_settings.prefix) : `${safeUsername}'s ${ticketType} ticket`);

    const embedsToSend = historyEmbed ? [embed, historyEmbed] : [embed];

    const initialMessage = await ticketChannel.send({
        content: (pingTags ? pingTags + "\n" : "") + baseContent,
        embeds: embedsToSend,
        components: [actionRow]
    });
    
    await initialMessage.pin().catch(e => {
        func.handle_errors(e, client, 'functions.js', `Failed to pin ticket metadata in ${ticketChannel.name}(${ticketChannel.id}). Staff bot needs Pin Messages.`);
    });

    let replyInfo = "";
    if (questionFile["anonymous-only-replies"] === true) {
        replyInfo = `Replies are **anonymous** by default. Use \`!me <message>\` to reply as yourself.`;
    } else {
        replyInfo = `Replies are sent **as yourself** by default. Use \`!r <message>\` to reply anonymously.`;
    }
    const instructionEmbed = new EmbedBuilder()
        .setColor(client.config.bot_settings.main_color)
        .setTitle('How to Reply')
        .setDescription(replyInfo);

    // Fire-and-forget to avoid blocking the interaction path
    ticketChannel.send({ embeds: [instructionEmbed] }).catch(() => {});

    // Post Cheetos check in the main ticket channel (not in staff thread) - run in background to avoid blocking
    (async () => {
        try {
            const shouldCheckCheetos = !!questionFile["check-cheetos"] && !!client.config?.tokens?.cheetosToken;
            if (!shouldCheckCheetos) return;
            const req = require('unirest');
            const url = `https://Cheetos.gg/api.php?action=search&id=${encodeURIComponent(recepientMember.id)}`;
            try { if (client.config && client.config.debug) console.log(`[Cheetos] Requesting: ${url} with DiscordID=${String(client.config?.misc?.cheetos_requestor_id || client.user?.id || '')}`); } catch(_) {}
            const resp = await req.get(url).headers({
                'Auth-Key': client.config.tokens.cheetosToken,
                'DiscordID': String(client.config?.misc?.cheetos_requestor_id || client.user?.id || ''),
                'Accept': 'text/plain',
                'User-Agent': 'ticket-bot (Discord.js)'
            });
            const raw = (resp && (resp.raw_body || resp.body)) || '';
            const text = typeof raw === 'string' ? raw : (Buffer.isBuffer(raw) ? raw.toString('utf8') : (raw && raw.toString ? raw.toString() : ''));
            let records = [];
            try {
                if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
                    const json = JSON.parse(text);
                    const arr = Array.isArray(json) ? json : [json];
                    records = arr.map(x => ({
                        ID: x.ID ?? x.id ?? x.Id ?? '',
                        Username: x.Username ?? x.username ?? '',
                        FirstSeen: x.FirstSeen ?? x.firstSeen ?? x.first_seen ?? '',
                        TimestampAdded: x.TimestampAdded ?? x.timestampAdded ?? x.timestamp_added ?? '',
                        LastGuildScan: x.LastGuildScan ?? x.lastGuildScan ?? x.last_guild_scan ?? '',
                        Name: x.Name ?? x.name ?? '',
                        Roles: x.Roles ?? x.roles ?? '',
                        Notes: x.Notes ?? x.notes ?? ''
                    }));
                }
            } catch(_) {}
            if (!Array.isArray(records) || records.length === 0) {
                const lines = text.split(/\r?\n/);
                records = [];
                let current = null;
                for (const raw of lines) {
                    const line = (raw || '').trimEnd();
                    if (!line) continue;
                    const idx = line.indexOf(':');
                    if (idx === -1) continue;
                    const key = line.slice(0, idx).trim();
                    const value = line.slice(idx + 1).trim();
                    if (key.toLowerCase() === 'id') {
                        if (current && Object.keys(current).length) records.push(current);
                        current = {};
                    }
                    if (!current) current = {};
                    current[key] = value;
                }
                if (current && Object.keys(current).length) records.push(current);
            }
            let lastEpoch = null;
            for (const r of records) {
                const tsRaw = r['TimestampAdded'] ?? r.TimestampAdded;
                const ts = tsRaw !== undefined && tsRaw !== null ? parseInt(String(tsRaw), 10) : null;
                if (Number.isFinite(ts) && ts > 0 && (!lastEpoch || ts > lastEpoch)) lastEpoch = ts;
            }
            const toShortAge = (sec) => {
                const s = Math.max(0, sec|0);
                const h = Math.floor(s / 3600);
                if (h < 24) return `${h}h`;
                const d = Math.floor(h / 24);
                if (d < 7) return `${d}d`;
                const w = Math.floor(d / 7);
                if (w < 4) return `${w}w`;
                const m = Math.floor(d / 30);
                if (m < 12) return `${m}m`;
                const y = Math.floor(d / 365);
                return `${y}y`;
            };
            let ltsStr = 'N/A';
            if (lastEpoch && Number.isFinite(lastEpoch)) {
                const nowSec = Math.floor(Date.now() / 1000);
                const diffSec = Math.max(0, nowSec - lastEpoch);
                ltsStr = toShortAge(diffSec);
            }
            let wr = 0;
            for (const r of records) {
                const rolesVal = (r['Roles'] || '').trim();
                if (rolesVal && rolesVal.length > 0) wr++;
            }
            const cheetosEmbed = new EmbedBuilder()
                .setColor(client.config.bot_settings.main_color)
                .setTitle('Cheetos Check')
                .setDescription(records.length > 0 ? `Result: ${records.length} CC LTS ${ltsStr} ${wr} WR` : `Cheetos Check: Clean`);
            await ticketChannel.send({ embeds: [cheetosEmbed] });
        } catch (e) { func.handle_errors(e, client, 'functions.js', 'Failed to post Cheetos check'); }
    })();

    // Create staff thread for all tickets. For internal tickets it's a private thread (staff-only) so higher-level staff can discuss without the user seeing.
    let thread = null;
    try {
        console.log(`[Functions] Creating staff thread for ticket #${formattedTicketNumber}...`);
        // Create as public thread first so we can add role permissions
        thread = await ticketChannel.threads.create({
            name: `staff-chat-${formattedTicketNumber}`,
            autoArchiveDuration: 10080,
            reason: `Private staff discussion for ticket #${formattedTicketNumber}`,
            type: ChannelType.PublicThread
        });
        console.log(`[Functions] Staff thread created successfully: ${thread.name} (${thread.id})`);
        console.log(`[Functions] Thread type: ${thread.type}, archived: ${thread.archived}, locked: ${thread.locked}`);
        console.log(`[Functions] Thread permissions: ${thread.permissionOverwrites ? 'Available' : 'Not available'}`);

        // Seed the staff thread without role pings
        try {
            await thread.send({
                content: `Staff thread for ticket #${formattedTicketNumber}`,
                allowedMentions: { parse: [] }
            });
        } catch (seedErr) {
            console.error('[Functions] Failed to seed staff thread:', seedErr);
        }

        // One staff-thread info embed (links + optional BM). Deferred when async BM lookup will post the combined embed.
        if (!module.exports.willDeferStaffBmEmbed(client, steamId, bmInfo)) {
            await module.exports.sendStaffThreadInfo(client, thread, recepientMember, formattedTicketNumber, steamId, responses, bmInfo);
        }

        // Add access roles to the staff thread
        if (accessRoleIDs && Array.isArray(accessRoleIDs) && accessRoleIDs.length > 0) {
            try {
                for (const roleId of accessRoleIDs) {
                    if (!roleId) continue;
                    const role = staffGuild.roles.cache.get(roleId);
                    if (role) {
                        try {
                            // In Discord.js v13, threads have different permission handling
                            // Try to add the role to the thread using the thread's edit method
                            console.log(`[Functions] Attempting to add role ${role.name} (${roleId}) to staff thread for ticket #${formattedTicketNumber}`);
                            
                                                                    // Add the role directly to the thread permissions
                                        try {
                                            // For public threads, we can use permissionOverwrites
                                            if (thread.permissionOverwrites && typeof thread.permissionOverwrites.create === 'function') {
                                                await thread.permissionOverwrites.create(role, {
                                                    ViewChannel: true,
                                                    SendMessages: true,
                                                    ReadMessageHistory: true
                                                });
                                                console.log(`[Functions] Successfully added role ${role.name} to thread permissions via permissionOverwrites`);
                                            } else {
                                                // Fallback: try to edit the thread with permissionOverwrites
                                                    await thread.edit({
                                                    permissionOverwrites: [
                                                        {
                                                            id: roleId,
                                                            type: 'role',
                                                            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
                                                        }
                                                    ]
                                                });
                                                console.log(`[Functions] Successfully added role ${role.name} to thread permissions via thread.edit`);
                                            }
                                        } catch (roleError) {
                                            console.error(`[Functions] Failed to add role ${role.name} to thread permissions:`, roleError);
                                        }
                                                            } catch (roleError) {
                                        console.error(`[Functions] Failed to add role ${role.name} to permissions:`, roleError);
                                    }
                    } else {
                        console.log(`[Functions] Warning: Role ID ${roleId} not found in guild`);
                    }
                }
            } catch (e) {
                func.handle_errors(e, client, `functions.js`, `Failed to add access roles to staff thread for ticket #${formattedTicketNumber}`);
            }
        } else if (client.config.role_ids.default_admin_role_id) {
            // When no access roles: ensure admin role can access the staff thread
            try {
                const adminRole = staffGuild.roles.cache.get(client.config.role_ids.default_admin_role_id);
                if (adminRole && thread.permissionOverwrites?.create) {
                    await thread.permissionOverwrites.create(adminRole, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    });
                }
            } catch (_) {}
        }

        // Convert thread to private so only explicitly added roles/members can see it
        try {
            console.log(`[Functions] Converting thread to private for ticket #${formattedTicketNumber}...`);
            await thread.edit({
                type: ChannelType.PrivateThread
            });
            console.log(`[Functions] Successfully converted thread to private`);
        } catch (convertError) {
            console.error(`[Functions] Failed to convert thread to private:`, convertError);
        }

    } catch (e) {
        func.handle_errors(e, client, `functions.js`, `Failed to create a private thread or send info for ticket #${formattedTicketNumber}`);
    }


    try {
        const protectedIds = [];
        if (messageid && messageid.messageId) protectedIds.push(String(messageid.messageId));
        if (messageid && messageid.internalMessageId) protectedIds.push(String(messageid.internalMessageId));
        const triggerId = String(interaction?.message?.id || "");
        // Never delete the public or internal embed messages
        if (triggerId && !protectedIds.includes(triggerId)) {
            await interaction.message.delete().catch(e => { func.handle_errors(e, client, `functions.js`, null) });
        }
    } catch (_) {}
    
    // If application, create application record and link mapping
    try {
        if (ticketType && ticketType.toLowerCase().includes('application')) {
            let server = null;
            const m = typeof responses === 'string' && responses.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/);
            if (m && m[1]) server = m[1];
            // Mark the initial ticket link as type 'origin' inside the application record
            const appRec = await applications.createApplication({ userId: recepientMember.id, username: recepientMember.username, type: ticketType, server, ticketId: formattedTicketNumber, channelId: ticketChannel.id, stage: 'Submitted', responses });
            await db.set(`AppMap.channelToApp.${ticketChannel.id}`, appRec.id);
            await db.set(`AppMap.ticketToApp.${formattedTicketNumber}`, appRec.id);
        }
    } catch(_){}

    // Update the bot's status to reflect the new ticket
    await module.exports.updateTicketStatus(client);

    // Return identifiers for follow-up async tasks if caller needs them
    try { return { ticketChannelId: ticketChannel?.id || null, staffThreadId: thread?.id || null }; } catch (_) { return; }
}

// Add function to update bot status
module.exports.updateTicketStatus = async function(client) {
    try {
        const staffBot = bots.staffClient(client);
        const publicBot = bots.publicClient(client);
        const staffGuild = staffBot.guilds.cache.get(client.config.channel_ids.staff_guild_id);
        if (!staffGuild) {
            console.warn('[updateTicketStatus] Staff guild not found');
            return;
        }

        // Fetch channels to ensure cache is up to date
        try {
            await staffGuild.channels.fetch();
        } catch (fetchError) {
            console.warn('[updateTicketStatus] Could not fetch channels:', fetchError.message);
            // Continue with cached channels as fallback
        }

        // Get all channels in the staff guild
        const channels = staffGuild.channels.cache;
        
        // First, get all open non-internal tickets from the database
        let openPublicTicketIds = new Set();
        let dbQuerySucceeded = false;
        try {
            if (typeof db.query === 'function') {
                const [openTicketsRows] = await db.query(
                    `SELECT ticket_id, ticket_type FROM tickets 
                    WHERE (close_time IS NULL AND close_type IS NULL AND transcript_url IS NULL)`
                );
                
                dbQuerySucceeded = true;
                
                // Filter out internal tickets and applications
                for (const row of openTicketsRows) {
                    const ticketType = row.ticket_type;
                    if (!ticketType || !module.exports.shouldExcludeFromTicketCount(ticketType)) {
                        openPublicTicketIds.add(String(row.ticket_id));
                    }
                }
            }
        } catch (dbError) {
            console.warn('[updateTicketStatus] Error querying database for open tickets:', dbError.message);
            // Fall back to counting all channels if database query fails
        }
        
        // Count channels that have a topic matching Discord ID pattern (indicating they are ticket channels)
        // Exclude internal tickets from the count by matching against database
        const ticketCount = channels.filter(channel => {
            const isTextChannel = channel.type === ChannelType.GuildText;
            const hasTicketTopic = channel.topic && /^\d{17,19}$/.test(channel.topic);
            if (!isTextChannel || !hasTicketTopic) return false;
            
            // If database query succeeded, use it to filter out internal tickets
            if (dbQuerySucceeded) {
                try {
                    // Extract ticket number from channel name (last part after last '-')
                    const nameParts = channel.name.split('-');
                    if (nameParts.length >= 2) {
                        const ticketId = nameParts[nameParts.length - 1];
                        // Only count if this ticket ID is in our set of open public tickets
                        return openPublicTicketIds.has(ticketId);
                    }
                } catch (_) {
                    // If parsing fails, exclude it (safer to exclude when we can't determine)
                    return false;
                }
                // If we can't parse the ticket ID, exclude it
                return false;
            }
            
            // Fallback: if database query failed, count all channels (original behavior)
            return true;
        }).size;

        console.log(`[updateTicketStatus] Found ${ticketCount} open ticket channels`);

        // Get activity configuration from config
        const activityConfig = client.config?.activityInfo;
        if (!activityConfig || !activityConfig.messages || activityConfig.messages.length === 0) {
            console.warn('[updateTicketStatus] Activity config not found or invalid, skipping status update');
            return;
        }

        const activityType = activityConfig.type || 'WATCHING';
        
        // If there's only one message, use it directly
        if (activityConfig.messages.length === 1) {
            const message = activityConfig.messages[0].replace(/{count}/g, ticketCount);
            try {
                await staffBot.user.setActivity(message, { type: activityType });
                if (publicBot && publicBot.user && publicBot !== staffBot) {
                    await publicBot.user.setActivity(message, { type: activityType });
                }
                console.log(`[updateTicketStatus] Status updated: "${message}"`);
            } catch (activityError) {
                console.error('[updateTicketStatus] Failed to set activity:', activityError.message);
            }
            return;
        }

        // If there are multiple messages, cycle through them
        if (!staffBot.currentStatusIndex) {
            staffBot.currentStatusIndex = 0;
        }

        // Get current message and replace {count} with actual count
        const currentMessage = activityConfig.messages[staffBot.currentStatusIndex].replace(/{count}/g, ticketCount);
        try {
            await staffBot.user.setActivity(currentMessage, { type: activityType });
            if (publicBot && publicBot.user && publicBot !== staffBot) {
                await publicBot.user.setActivity(currentMessage, { type: activityType });
            }
            console.log(`[updateTicketStatus] Status updated: "${currentMessage}"`);
        } catch (activityError) {
            console.error('[updateTicketStatus] Failed to set activity:', activityError.message);
        }

        // Move to next message
        staffBot.currentStatusIndex = (staffBot.currentStatusIndex + 1) % activityConfig.messages.length;

        // Set up periodic updates if cycleTimeinSeconds is configured and interval doesn't exist
        if (activityConfig.cycleTimeinSeconds && !staffBot.statusUpdateInterval) {
            staffBot.statusUpdateInterval = setInterval(async () => {
                // Only update if we have multiple messages to cycle through
                if (activityConfig.messages.length > 1) {
                    await module.exports.updateTicketStatus(staffBot).catch(error => {
                        func.handle_errors(error, staffBot, 'functions.js', null);
                    });
                }
            }, activityConfig.cycleTimeinSeconds * 1000);
        }
    } catch (error) {
        func.handle_errors(error, client, 'functions.js', null);
    }
}

/**
 * Shared ticket closure logic for both button/modal and !close command
 * @param {Client} client
 * @param {TextChannel} channel
 * @param {GuildMember|User} staffMember
 * @param {string} reason
 */
module.exports.closeTicket = async (client, channel, staffMember, reason) => {
    try {
        const staffBot = bots.staffClient(client);
        if (!channel || !channel.guild || !staffBot.channels.cache.has(channel.id)) {
            return;
        }

        const identity = await module.exports.resolveTicketIdentity(channel);
        const DiscordID = identity.userId;
        const globalTicketNumber = identity.ticketId;
        const ticketType = identity.ticketType;
        if (!DiscordID || !globalTicketNumber || !ticketType) {
            module.exports.handle_errors(
                null,
                client,
                'functions.js',
                `closeTicket missing identity for ${channel.name}(${channel.id}): user=${DiscordID} ticket=${globalTicketNumber} type=${ticketType}`
            );
            return;
        }

        const user = await bots.fetchDmUser(client, DiscordID);
        const handlerRaw = require("../content/handler/options.json");
        const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == ticketType.toLowerCase());
        if (!found) {
            module.exports.handle_errors(null, client, 'functions.js', `closeTicket unknown ticket type '${ticketType}' for ${channel.name}`);
            return;
        }
        const typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
        if (!typeFile) return;

        const transcriptChannel = typeFile[`transcript-channel`];
        const logs_channel = channel.guild.channels.cache.find(x => x.id === transcriptChannel);
        const reasonBlock = reason || 'No Reason Provided.';
        const openedAtMs = identity.createdAt ? identity.createdAt * 1000 : (channel.createdTimestamp || Date.now());

        const embed = new EmbedBuilder()
            .setTitle(`${ticketType} #${globalTicketNumber}`)
            .setColor(client.config.bot_settings.main_color)
            .setAuthor({
                name: client.config.bot_settings.close_ticket_author_prefix
                    ? client.config.bot_settings.close_ticket_author_prefix.replace('{{ADMIN}}', staffMember.username || staffMember.user?.username)
                    : `Ticket Closed by ${staffMember.username || staffMember.user?.username}`,
                iconURL: staffMember.displayAvatarURL ? staffMember.displayAvatarURL() : client.user.displayAvatarURL()
            })
            .setFooter({
                text: `${DiscordID}-${globalTicketNumber} | ${ticketType} | Ticket Closed:`,
                iconURL: client.user.displayAvatarURL()
            })
            .setTimestamp(new Date())
            .addFields(
                {
                    name: typeFile["close-transcript-embed-reason-title"] || "Close Reason",
                    value: reasonBlock,
                    inline: true
                },
                {
                    name: typeFile["close-transcript-embed-response-title"] || "Response Time",
                    value: await module.exports.convertMsToTime(Date.now() - openedAtMs),
                    inline: true
                }
            );

        if (logs_channel) {
            await logs_channel.send({ embeds: [embed] }).catch(e => module.exports.handle_errors(e, client, "functions.js", null));
        }

        let savedTranscriptURL = null;
        try {
            const { base_url } = client.config.transcript_settings;
            savedTranscriptURL = `${base_url}${channel.name}.full.html`;

            await func.closeDataAddDB(
                DiscordID,
                globalTicketNumber,
                'closed',
                staffMember.user.username,
                staffMember.id,
                Math.floor(Date.now() / 1000),
                reason,
                savedTranscriptURL
            );

            try {
                const createdAt = identity.createdAt || Math.floor(openedAtMs / 1000);
                let server = null;
                if (typeof db.query === 'function') {
                    const [rows] = await db.query(
                        'SELECT responses, server FROM tickets WHERE user_id = ? AND ticket_id = ? LIMIT 1',
                        [String(DiscordID), String(globalTicketNumber)]
                    );
                    if (rows && rows[0]) {
                        const responsesText = rows[0].responses || '';
                        const serverMatch = typeof responsesText === 'string' && responsesText.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/);
                        server = (serverMatch && serverMatch[1]) ? serverMatch[1] : (rows[0].server || null);
                    }
                }

                const ticketRow = {
                    userId: String(DiscordID),
                    ticketId: String(globalTicketNumber),
                    ticketType: ticketType,
                    server: server,
                    createdAt: createdAt,
                    closeTime: Math.floor(Date.now() / 1000),
                    closeUserID: String(staffMember.id || staffMember.user?.id || ''),
                    closeUser: String(staffMember.user?.username || staffMember.username || ''),
                    closeReason: String(reason || ''),
                    transcriptFilename: `${channel.name}.html`,
                    transcriptURL: savedTranscriptURL || null,
                    channelId: channel.id || null
                };

                if (typeof db.writeTicket === 'function') {
                    await db.writeTicket(ticketRow);
                } else {
                    throw new Error('MySQL writeTicket method not available');
                }
                if (typeof db.finalizeTicketMetrics === 'function') {
                    await db.finalizeTicketMetrics({
                        channelId: channel.id,
                        ticketId: String(globalTicketNumber),
                        openerId: String(DiscordID)
                    });
                }
            } catch (err) {
                console.error('[closeTicket] Error writing ticket data:', err.message);
            }

            if (logs_channel && savedTranscriptURL) {
                logs_channel
                    .send({ content: `Transcript saved: <${savedTranscriptURL}>` })
                    .catch(e => func.handle_errors(e, client, 'functions.js', null));
            }
        } catch (e) {
            func.handle_errors(e, client, 'functions.js', 'Transcript DB close setup failed');
        }

        const closeRecipientIds = new Set([String(DiscordID)]);
        try {
            if (typeof db.getTicketParticipants === 'function' && globalTicketNumber) {
                const extras = await db.getTicketParticipants(globalTicketNumber);
                for (const row of extras || []) {
                    if (row && row.userId) closeRecipientIds.add(String(row.userId));
                }
            }
        } catch (e) {
            func.handle_errors(e, client, 'functions.js', 'Failed to load ticket participants for close DMs');
        }

        if (typeFile.send_close_dm !== false) {
            let reply = `Your ticket (#${globalTicketNumber}) has been closed.\nReason: ${reason}`;
            if (client.config.transcript_settings?.base_url) {
                const userUrl = `${client.config.transcript_settings.base_url}${channel.name}.html`;
                reply += `\n\nView your transcript: <${userUrl}>`;
            }
            for (const recipientId of closeRecipientIds) {
                const recipient = recipientId === String(DiscordID)
                    ? user
                    : await bots.fetchDmUser(client, recipientId);
                if (!recipient) continue;
                try {
                    const result = await module.exports.sendDMWithRetry(recipient, reply, { maxAttempts: 3, baseDelayMs: 600 });
                    const sentMsg = result && result.message ? result.message : null;
                    if (sentMsg && sentMsg.suppressEmbeds) {
                        try { await sentMsg.suppressEmbeds(true); } catch (_) {}
                    }
                } catch (e) {
                    func.handle_errors(e, client, 'functions.js', `Failed to send closure DM to user ${recipientId}`);
                }
            }
        }
        await module.exports.updateTicketStatus(client);

        try {
            const thread = channel.threads.cache.find(t => t.name === `staff-chat-${globalTicketNumber}`);
            if (thread) {
                await thread.setArchived(true, 'Ticket closed.');
            }
        } catch (e) {
            if (e && e.code === 10003) {
                module.exports.handle_errors(null, client, "functions.js", `Archive skipped for staff thread #${globalTicketNumber}: Unknown Channel (10003). Likely already deleted or inaccessible.`);
            } else {
                module.exports.handle_errors(e, client, "functions.js", `Failed to archive staff thread for #${globalTicketNumber}`);
            }
        }

        for (const participantId of closeRecipientIds) {
            try {
                const key = `UserTicketIndex.${participantId}`;
                const list = (await db.get(key)) || [];
                const updated = list.filter(id => id !== channel.id);
                await db.set(key, updated);
            } catch (_) {}
        }

        try {
            const parentId = channel.parentId;
            const guild = channel.guild;
            setTimeout(async () => {
                try {
                    const liveChannel = guild.channels.cache.get(channel.id);
                    if (!liveChannel) return;
                    await liveChannel.delete('Ticket closed');
                    await module.exports.deleteEmptyOverflowCategory(client, guild, parentId);
                } catch (e) {
                    module.exports.handle_errors(e, client, "functions.js", `Failed to delete ticket channel ${channel.id} after close`);
                }
            }, 1000);
        } catch (e) {
            module.exports.handle_errors(e, client, "functions.js", `Error scheduling delete for ticket channel ${channel.id}`);
        }
    } catch (err) {
        module.exports.handle_errors(err, client, "functions.js", `Error in closeTicket for channel ${channel.name}(${channel.id})`);
    }
};

const MERGE_PAGE_SIZE = 25;

function ticketTypeSlug(ticketType) {
    return String(ticketType || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function channelNameMatchesTicketType(channelName, ticketType) {
    const slug = ticketTypeSlug(ticketType);
    if (!slug) return false;
    const name = String(channelName || '').toLowerCase();
    return name.includes(`-${slug}-`) || name.startsWith(`${slug}-`);
}

module.exports.MERGE_PAGE_SIZE = MERGE_PAGE_SIZE;

module.exports.normalizeTicketType = function(ticketType) {
    if (!ticketType) return null;
    const handlerRaw = require('../content/handler/options.json');
    const found = Object.keys(handlerRaw.options || {}).find(x => x.toLowerCase() === String(ticketType).toLowerCase());
    return found || ticketType;
};

module.exports.resolveTicketTypeFromChannel = async function(channel) {
    const ownerId = channel?.topic;
    const ticketNum = module.exports.parseTicketNumberFromChannelName(channel?.name);
    if (ownerId && ticketNum && typeof db.query === 'function') {
        try {
            const [rows] = await db.query(
                'SELECT ticket_type FROM tickets WHERE user_id = ? AND ticket_id = ? LIMIT 1',
                [String(ownerId), String(ticketNum)]
            );
            if (rows?.[0]?.ticket_type) return module.exports.normalizeTicketType(rows[0].ticket_type);
        } catch (_) {}
    }
    try {
        const handlerRaw = require('../content/handler/options.json');
        const name = String(channel?.name || '').toLowerCase();
        for (const key of Object.keys(handlerRaw.options || {})) {
            if (channelNameMatchesTicketType(name, key)) {
                return module.exports.normalizeTicketType(key);
            }
        }
    } catch (_) {}
    return null;
};

module.exports.resolveTicketIdentity = async function(channel) {
    const userId = channel?.topic && /^\d{17,19}$/.test(channel.topic) ? String(channel.topic) : null;
    const ticketId = module.exports.parseTicketNumberFromChannelName(channel?.name);
    const ticketType = await module.exports.resolveTicketTypeFromChannel(channel);
    let createdAt = null;
    if (userId && ticketId && typeof db.query === 'function') {
        try {
            const [rows] = await db.query(
                'SELECT created_at, ticket_type FROM tickets WHERE user_id = ? AND ticket_id = ? LIMIT 1',
                [userId, String(ticketId)]
            );
            if (rows?.[0]?.created_at) createdAt = Number(rows[0].created_at) || null;
        } catch (_) {}
    }
    return { userId, ticketId, ticketType, createdAt };
};

module.exports.getExtraParticipantUserIds = async function(ticketId, ownerId) {
    if (!ticketId || typeof db.getTicketParticipants !== 'function') return [];
    try {
        const rows = await db.getTicketParticipants(ticketId);
        return (rows || []).map(r => String(r.userId || '')).filter(id => id && id !== String(ownerId || ''));
    } catch (_) {
        return [];
    }
};

module.exports.applyTicketTypeOverwrites = async function(client, channel, ticketType, ownerId) {
    const ticketNum = module.exports.parseTicketNumberFromChannelName(channel?.name);
    const extraUserIds = await module.exports.getExtraParticipantUserIds(ticketNum, ownerId);
    const overwrites = perms.buildPermissionOverwritesForTicketType({
        client,
        guild: channel.guild,
        ticketType,
        userId: ownerId,
        extraUserIds,
    });
    if (!Array.isArray(overwrites) || overwrites.length === 0) return;
    try {
        await channel.permissionOverwrites.set(overwrites);
    } catch (err) {
        const baseOverwrites = perms.buildPermissionOverwritesForTicketType({
            client,
            guild: channel.guild,
            ticketType,
            userId: ownerId,
            extraUserIds: [],
        });
        if (baseOverwrites.length > 0) {
            await channel.permissionOverwrites.set(baseOverwrites);
        }
        for (const uid of extraUserIds) {
            try {
                await channel.permissionOverwrites.edit(uid, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                });
            } catch (extraErr) {
                module.exports.handle_errors(extraErr, client, 'functions.js', `Failed to restore merged participant overwrite for ${uid}`);
            }
        }
        module.exports.handle_errors(err, client, 'functions.js', 'Failed to set ticket overwrites in one pass; restored extras individually');
    }
};

async function addChannelToUserTicketIndex(userId, channelId) {
    if (!userId || !channelId) return;
    try {
        const key = `UserTicketIndex.${userId}`;
        const list = (await db.get(key)) || [];
        if (!list.includes(channelId)) {
            list.push(channelId);
            await db.set(key, list);
        }
    } catch (_) {}
}

async function getFormAnswersForTicket(userId, ticketId, sourceChannel) {
    if (userId && ticketId && typeof db.query === 'function') {
        try {
            const [rows] = await db.query(
                'SELECT responses FROM tickets WHERE user_id = ? AND ticket_id = ? LIMIT 1',
                [String(userId), String(ticketId)]
            );
            if (rows?.[0]?.responses) return String(rows[0].responses);
        } catch (_) {}
    }
    try {
        const pins = await module.exports.fetchPinnedSafe(sourceChannel);
        const pin = pins.find(m => m.embeds?.[0]?.footer?.text && /\d{17,19}-\d+\s*\|/.test(m.embeds[0].footer.text)) || pins.last();
        if (pin?.embeds?.[0]?.description) return String(pin.embeds[0].description);
        if (Array.isArray(pin?.embeds?.[0]?.fields) && pin.embeds[0].fields.length) {
            return pin.embeds[0].fields.map(f => `**${f.name}**\n${f.value}`).join('\n\n');
        }
    } catch (_) {}
    return '';
}

module.exports.listOpenTicketsOfType = async function(guild, ticketType, excludeChannelId) {
    const results = [];
    const seen = new Set();
    if (!guild) return results;
    try { await guild.channels.fetch(); } catch (_) {}

    try {
        if (typeof db.query === 'function') {
            const [rows] = await db.query(
                `SELECT user_id, ticket_id, username, responses
                 FROM tickets
                 WHERE LOWER(ticket_type) = LOWER(?)
                   AND (close_time IS NULL AND close_type IS NULL AND transcript_url IS NULL)`,
                [ticketType]
            );
            for (const row of rows || []) {
                const userId = String(row.user_id || '');
                const ticketId = String(row.ticket_id || '');
                const channel = guild.channels.cache.find(c =>
                    c.type === ChannelType.GuildText &&
                    String(c.topic || '') === userId &&
                    (c.name.endsWith(`-${ticketId}`) || c.name.endsWith(ticketId)) &&
                    c.id !== excludeChannelId
                );
                if (!channel || seen.has(channel.id)) continue;
                seen.add(channel.id);
                results.push({
                    channelId: channel.id,
                    name: channel.name,
                    ownerId: userId,
                    ownerName: row.username || userId,
                    ticketNumber: ticketId,
                    responses: row.responses || null,
                });
            }
        }
    } catch (_) {}

    for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildText) continue;
        if (channel.id === excludeChannelId) continue;
        if (seen.has(channel.id)) continue;
        if (!channel.topic || !/^\d{17,19}$/.test(channel.topic)) continue;
        if (!channelNameMatchesTicketType(channel.name, ticketType)) continue;
        const ticketNumber = module.exports.parseTicketNumberFromChannelName(channel.name);
        if (!ticketNumber) continue;
        seen.add(channel.id);
        results.push({
            channelId: channel.id,
            name: channel.name,
            ownerId: channel.topic,
            ownerName: channel.topic,
            ticketNumber,
            responses: null,
        });
    }

    results.sort((a, b) => String(a.ticketNumber).localeCompare(String(b.ticketNumber), undefined, { numeric: true }));
    return results;
};

module.exports.buildMergeSelectComponents = function(candidates, page) {
    const total = candidates.length;
    const pageCount = Math.max(1, Math.ceil(total / MERGE_PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), pageCount - 1);
    const start = safePage * MERGE_PAGE_SIZE;
    const pageItems = candidates.slice(start, start + MERGE_PAGE_SIZE);
    const rows = [];

    if (pageItems.length > 0) {
        const select = new StringSelectMenuBuilder()
            .setCustomId('merge_select')
            .setPlaceholder('Select one or more tickets to merge into this one')
            .setMinValues(1)
            .setMaxValues(pageItems.length)
            .addOptions(pageItems.map(item => {
                const label = `#${item.ticketNumber} · ${item.ownerName || item.ownerId}`.slice(0, 100);
                return {
                    label,
                    value: item.channelId,
                    description: String(item.name || 'Ticket').slice(0, 100) || 'Ticket',
                };
            }));
        rows.push(new ActionRowBuilder().addComponents(select));
    }

    if (pageCount > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`merge_page:${safePage - 1}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage <= 0),
            new ButtonBuilder()
                .setCustomId(`merge_page:${safePage + 1}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage >= pageCount - 1)
        ));
    }

    const end = Math.min(start + pageItems.length, total);
    const content = pageCount > 1
        ? `Select tickets to merge into this one. Showing ${start + 1}–${end} of ${total}.`
        : `Select tickets to merge into this one (${total} open).`;
    return { content, components: rows, page: safePage };
};

module.exports.mergeTickets = async function(client, survivorChannel, sourceChannelIds, staffMember) {
    const succeeded = [];
    const failed = [];
    const ownerId = survivorChannel?.topic;
    const survivorNumber = module.exports.parseTicketNumberFromChannelName(survivorChannel?.name);
    const survivorType = await module.exports.resolveTicketTypeFromChannel(survivorChannel);

    if (!survivorChannel || !ownerId || !/^\d{17,19}$/.test(ownerId) || !survivorNumber || !survivorType) {
        return { succeeded, failed: [{ id: survivorChannel?.id, error: 'Could not resolve this ticket.' }] };
    }
    if (!perms.ticketTypeAllowsMerges(survivorType)) {
        return { succeeded, failed: [{ id: survivorChannel.id, error: 'This ticket type cannot be merged.' }] };
    }

    const uniqueSourceIds = [...new Set((sourceChannelIds || []).map(String))].filter(id => id && id !== survivorChannel.id);
    const addedUserIds = new Set();

    try {
        if (typeof db.addTicketParticipant === 'function') {
            await db.addTicketParticipant(survivorNumber, ownerId, null);
        }
    } catch (e) {
        func.handle_errors(e, client, 'functions.js', 'Failed to record original ticket owner as participant');
    }

    for (const sourceId of uniqueSourceIds) {
        let sourceChannel = null;
        try {
            sourceChannel = survivorChannel.guild.channels.cache.get(sourceId)
                || await survivorChannel.guild.channels.fetch(sourceId).catch(() => null);
            if (!sourceChannel || sourceChannel.type !== ChannelType.GuildText) {
                failed.push({ id: sourceId, error: 'Channel not found.' });
                continue;
            }
            if (!sourceChannel.topic || !/^\d{17,19}$/.test(sourceChannel.topic)) {
                failed.push({ id: sourceId, error: 'Not a valid ticket channel.' });
                continue;
            }
            const sourceType = await module.exports.resolveTicketTypeFromChannel(sourceChannel);
            if (!sourceType || sourceType.toLowerCase() !== survivorType.toLowerCase()) {
                failed.push({ id: sourceId, error: 'Different ticket type.' });
                continue;
            }
            const sourceOwnerId = String(sourceChannel.topic);
            const sourceNumber = module.exports.parseTicketNumberFromChannelName(sourceChannel.name);
            if (!sourceNumber) {
                failed.push({ id: sourceId, error: 'Could not parse ticket number.' });
                continue;
            }

            const formAnswers = await getFormAnswersForTicket(sourceOwnerId, sourceNumber, sourceChannel);
            const sourceUser = await bots.fetchDmUser(client, sourceOwnerId);
            const extraParts = typeof db.getTicketParticipants === 'function'
                ? await db.getTicketParticipants(sourceNumber).catch(() => [])
                : [];
            const usersToAdd = new Set([sourceOwnerId, ...((extraParts || []).map(p => String(p.userId || '')).filter(Boolean))]);

            for (const uid of usersToAdd) {
                try {
                    await survivorChannel.permissionOverwrites.edit(uid, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true,
                    });
                } catch (permErr) {
                    func.handle_errors(permErr, client, 'functions.js', `Failed to add <@${uid}> to merged ticket overwrites`);
                }
                try {
                    if (typeof db.addTicketParticipant === 'function') {
                        const srcId = uid === sourceOwnerId ? sourceNumber : ((extraParts || []).find(p => String(p.userId) === uid)?.sourceTicketId || sourceNumber);
                        await db.addTicketParticipant(survivorNumber, uid, srcId);
                    }
                } catch (dbErr) {
                    func.handle_errors(dbErr, client, 'functions.js', 'Failed to store merged ticket participant');
                }
                await addChannelToUserTicketIndex(uid, survivorChannel.id);
                addedUserIds.add(uid);
            }

            const answers = (formAnswers || '').trim() || 'No form answers found.';
            const embed = new EmbedBuilder()
                .setColor(client.config?.bot_settings?.main_color || 0x208cdd)
                .setTitle(`Merged from ${survivorType} #${sourceNumber}`)
                .setDescription(answers.slice(0, 4000))
                .setFooter({ text: `Original ticket ${sourceChannel.name}` });
            if (sourceUser) {
                embed.setAuthor({ name: sourceUser.username, iconURL: sourceUser.displayAvatarURL() });
            }
            const pingList = [...usersToAdd].map(id => `<@${id}>`).join(' ');
            try {
                await survivorChannel.send({
                    content: `${pingList} your report was merged into this ticket. You can keep adding information here.`,
                    embeds: [embed],
                    allowedMentions: { users: [...usersToAdd] },
                });
            } catch (embedErr) {
                func.handle_errors(embedErr, client, 'functions.js', `Failed to post merged form answers from ${sourceChannel.name}`);
            }

            await module.exports.closeTicket(client, sourceChannel, staffMember, `Merged into #${survivorNumber}`);
            succeeded.push({ id: sourceId, name: sourceChannel.name, ticketNumber: sourceNumber });
        } catch (err) {
            func.handle_errors(err, client, 'functions.js', `Failed to merge ticket ${sourceId}`);
            failed.push({ id: sourceId, error: err.message || 'Unexpected error.' });
        }
    }

    return { succeeded, failed, survivorNumber, addedCount: addedUserIds.size };
};
