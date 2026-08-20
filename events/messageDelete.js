const { createDB } = require('../utils/mysql');
const db = createDB();
const func = require("../utils/functions.js");
const bots = require("../utils/clients");

module.exports = async function (client, message) {
    try {
        if (!message || !message.id) return;

        const isDM = message.channel && message.channel.type === require('discord.js').ChannelType.DM;
        if (isDM && message.client.botRole === 'staff') return;
        if (!isDM && message.guild && message.client.botRole === 'public') return;

        // If a user deletes a DM message, remove corresponding staff-side forwarded messages
        if (isDM && !message.author?.bot) {
            const map = await db.get(`ForwardMap.${message.id}`);
            if (map && map.channelId) {
                const staffChannel = await bots.fetchStaffChannel(client, map.channelId);
                if (staffChannel) {
                    // Delete combined message if present
                    if (map.combinedMessageId) {
                        try { await staffChannel.messages.delete(map.combinedMessageId).catch(() => {}); } catch (_) {}
                    }
                    // Delete files message if present
                    if (map.filesMessageId) {
                        try { await staffChannel.messages.delete(map.filesMessageId).catch(() => {}); } catch (_) {}
                    }
                    // Delete any text chunk messages
                    if (Array.isArray(map.textMessageIds)) {
                        for (const id of map.textMessageIds) {
                            try { await staffChannel.messages.delete(id).catch(() => {}); } catch (_) {}
                        }
                    }
                }
                // Remove mapping entry
                await db.delete(`ForwardMap.${message.id}`).catch(() => {});
            }
            return;
        }

        // If a staff member deletes their ticket message, remove corresponding DM messages
        if (message.guild && message.channel && !message.channel.isThread()) {
            const map = await db.get(`StaffForwardMap.${message.id}`);
            if (map && map.dmChannelId) {
                const dmChannel = await bots.fetchPublicChannel(client, map.dmChannelId);
                if (dmChannel) {
                    // Delete DM files message if present
                    if (map.filesMessageId) {
                        try { await dmChannel.messages.delete(map.filesMessageId).catch(() => {}); } catch (_) {}
                    }
                    // Delete DM text messages
                    if (Array.isArray(map.textMessageIds)) {
                        for (const id of map.textMessageIds) {
                            try { await dmChannel.messages.delete(id).catch(() => {}); } catch (_) {}
                        }
                    }
                }
                // Remove mapping entry
                await db.delete(`StaffForwardMap.${message.id}`).catch(() => {});
            }
        }
    } catch (exception) {
        func.handle_errors(exception, client, `messageDelete.js`, null);
    }
};



