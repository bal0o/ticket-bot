const { createDB } = require('../utils/mysql');
const db = createDB();
const func = require("../utils/functions.js");

module.exports = async function (client, oldMessage, newMessage) {
    try {
        if (!newMessage || !newMessage.channel || newMessage.author?.bot) return;

        // User DM edits -> update staff side
        if (newMessage.channel.type === "DM") {
            const map = await db.get(`ForwardMap.${newMessage.id}`);
            if (!map || !map.channelId) return;

            const staffChannel = await client.channels.fetch(map.channelId).catch(() => null);
            if (!staffChannel) return;

        // Sanitize content for staff channel
        const content = newMessage.content || "";
        const hasContent = content.trim() !== "";
        const sanitize = (text) => {
            let replyNoEveryone = text.replace(`@everyone`, `@ everyone`);
            let replyNoHere = replyNoEveryone.replace(`@here`, `@ here`);
            return replyNoHere.replace(`<@`, `<@ `);
        };

            // Prepare webhook
            const webhooks = await staffChannel.fetchWebhooks();
            let webhook = webhooks.find(wh => wh.name === "Ticket Webhook");
            if (!webhook) {
                webhook = await staffChannel.createWebhook("Ticket Webhook", {
                    avatar: newMessage.author.displayAvatarURL()
                });
            }

            // Case 1: Single combined message (content + maybe files) -> delete and resend text only
            if (map.combinedMessageId) {
            try { await staffChannel.messages.delete(map.combinedMessageId).catch(() => {}); } catch (_) {}
            const newTextIds = [];
            if (hasContent) {
                if (content.length <= 1900) {
                    const sent = await webhook.send({
                        content: sanitize(content),
                        username: newMessage.author.username,
                        avatarURL: newMessage.author.displayAvatarURL()
                    }).catch((err) => func.handle_errors(err, client, `messageUpdate.js`, null));
                    if (sent && sent.id) newTextIds.push(sent.id);
                } else {
                    for (let i = 0; i < content.length; i += 1900) {
                        const toSend = content.substring(i, Math.min(content.length, i + 1900));
                        const sent = await webhook.send({
                            content: sanitize(toSend),
                            username: newMessage.author.username,
                            avatarURL: newMessage.author.displayAvatarURL()
                        }).catch((err) => func.handle_errors(err, client, `messageUpdate.js`, null));
                        if (sent && sent.id) newTextIds.push(sent.id);
                    }
                }
            }
            await db.set(`ForwardMap.${newMessage.id}.combinedMessageId`, "");
            await db.set(`ForwardMap.${newMessage.id}.textMessageIds`, newTextIds);
                return;
            }

            // Case 2: Files message (kept) + text chunk messages -> replace only text messages
            if (Array.isArray(map.textMessageIds) && map.textMessageIds.length > 0) {
            // Delete old text messages
            for (const msgId of map.textMessageIds) {
                try { await staffChannel.messages.delete(msgId).catch(() => {}); } catch (_) {}
            }
            const newIds = [];
            if (hasContent) {
                for (let i = 0; i < content.length; i += 1900) {
                    const toSend = content.substring(i, Math.min(content.length, i + 1900));
                    const sent = await webhook.send({
                        content: sanitize(toSend),
                        username: newMessage.author.username,
                        avatarURL: newMessage.author.displayAvatarURL()
                    }).catch((err) => func.handle_errors(err, client, `messageUpdate.js`, null));
                    if (sent && sent.id) newIds.push(sent.id);
                }
            }
            await db.set(`ForwardMap.${newMessage.id}.textMessageIds`, newIds);
                return;
            }

            // Case 3: No mapping to text (e.g., only files were forwarded) -> nothing to update
            return;
        }

        // Staff edits in ticket -> update DM side if applicable
        if (newMessage.guild && newMessage.channel && !newMessage.channel.isThread()) {
            const map = await db.get(`StaffForwardMap.${newMessage.id}`);
            if (!map || !map.userId) return;

            const content = newMessage.content || "";
            const hasContent = content.trim() !== "";

            // Replace text messages; leave files untouched
            if (Array.isArray(map.textMessageIds) && map.textMessageIds.length > 0) {
                let dmChannel = null;
                
                // Try to fetch stored DM channel first
                if (map.dmChannelId) {
                    dmChannel = await client.channels.fetch(map.dmChannelId).catch(() => null);
                }
                
                // Recovery: If DM channel fetch failed (stale ID), fetch user and create new DM
                if (!dmChannel && map.userId) {
                    try {
                        const user = await client.users.fetch(map.userId).catch(() => null);
                        if (user) {
                            // Use sendDMWithRetry which will create a new DM channel
                            // For edits, we just need to send the new content (can't delete old messages)
                            const newIds = [];
                            if (hasContent) {
                                if (content.length <= 2000) {
                                    const result = await func.sendDMWithRetry(user, { content }, { maxAttempts: 2, baseDelayMs: 600 });
                                    const sent = result && result.message ? result.message : null;
                                    if (sent && sent.id) {
                                        newIds.push(sent.id);
                                        // Update stored dmChannelId with new channel ID
                                        await db.set(`StaffForwardMap.${newMessage.id}.dmChannelId`, sent.channel?.id || map.dmChannelId).catch(() => {});
                                    }
                                } else {
                                    for (let i = 0; i < content.length; i += 1900) {
                                        const toSend = content.substring(i, Math.min(content.length, i + 1900));
                                        const result = await func.sendDMWithRetry(user, { content: toSend }, { maxAttempts: 2, baseDelayMs: 600 });
                                        const sent = result && result.message ? result.message : null;
                                        if (sent && sent.id) {
                                            newIds.push(sent.id);
                                            // Update stored dmChannelId with new channel ID from first successful send
                                            if (i === 0 && sent.channel?.id) {
                                                await db.set(`StaffForwardMap.${newMessage.id}.dmChannelId`, sent.channel.id).catch(() => {});
                                            }
                                        }
                                    }
                                }
                            }
                            await db.set(`StaffForwardMap.${newMessage.id}.textMessageIds`, newIds);
                            return; // Exit early after recovery
                        }
                    } catch (recoveryError) {
                        func.handle_errors(recoveryError, client, `messageUpdate.js`, `DM recovery failed for user ${map.userId}`);
                    }
                    return; // Can't recover, exit
                }
                
                // Normal path: DM channel is valid, delete old messages and send new ones
                if (!dmChannel) return;
                
                // Delete old DM text messages
                for (const msgId of map.textMessageIds) {
                    try { await dmChannel.messages.delete(msgId).catch(() => {}); } catch (_) {}
                }
                const newIds = [];
                if (hasContent) {
                    if (content.length <= 2000) {
                        const sent = await dmChannel.send({ content }).catch(e => func.handle_errors(e, client, `messageUpdate.js`, null));
                        if (sent && sent.id) newIds.push(sent.id);
                    } else {
                        for (let i = 0; i < content.length; i += 1900) {
                            const toSend = content.substring(i, Math.min(content.length, i + 1900));
                            const sent = await dmChannel.send({ content: toSend }).catch(e => func.handle_errors(e, client, `messageUpdate.js`, null));
                            if (sent && sent.id) newIds.push(sent.id);
                        }
                    }
                }
                await db.set(`StaffForwardMap.${newMessage.id}.textMessageIds`, newIds);
            }
        }

    } catch (exception) {
        func.handle_errors(exception, client, `messageUpdate.js`, null);
    }
};


