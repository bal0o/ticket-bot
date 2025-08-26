const { QuickDB } = require("quick.db");
const db = new QuickDB();
const func = require("../utils/functions.js");

module.exports = async function (client, message) {
    try {
        if (!message || !message.id) return;

        // If a user deletes a DM message, remove corresponding staff-side forwarded messages
        if (message.channel && message.channel.type === "DM" && !message.author?.bot) {
            const map = await db.get(`ForwardMap.${message.id}`);
            if (map && map.channelId) {
                const staffChannel = await client.channels.fetch(map.channelId).catch(() => null);
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
                const dmChannel = await client.channels.fetch(map.dmChannelId).catch(() => null);
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



