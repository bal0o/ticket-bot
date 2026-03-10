const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError } = require("discord.js");
const path = require("path");
let messageId = { messageId: "", internalMessageId: "" };
try {
    messageId = require("../config/messageid.json");
    if (typeof messageId !== 'object' || messageId === null) messageId = { messageId: "", internalMessageId: "" };
    if (messageId.messageId === undefined) messageId.messageId = "";
    if (messageId.internalMessageId === undefined) messageId.internalMessageId = "";
} catch (_) {
    try {
        const msgPath = path.join(__dirname, "..", "config", "messageid.json");
        fs.writeFileSync(msgPath, JSON.stringify(messageId));
    } catch (__) {}
}
const fs = require("fs");
const func = require("../utils/functions.js");
const { createDB } = require('../utils/mysql')

module.exports = async function (client, message) {
    // Initialize the ticket status
    await func.updateTicketStatus(client);
    
    // Remove startup delay; proceed immediately
    
    // Warm the member cache for the staff guild so role membership is accurate
    try {
        const staffGuildId = client.config?.channel_ids?.staff_guild_id;
        if (staffGuildId) {
            const staffGuild = client.guilds.cache.get(staffGuildId);
            if (staffGuild) {
                console.log('[Ready] Fetching staff guild members to warm cache...');
                await staffGuild.members.fetch();
                console.log(`[Ready] Fetched ${staffGuild.members.cache.size} members in staff guild`);
            } else {
                console.log('[Ready] Staff guild not found in cache; skipping member fetch');
            }
        } else {
            console.log('[Ready] No staff guild configured; skipping member fetch');
        }
    } catch (e) {
        console.error('[Ready] Failed to fetch staff guild members:', e);
    }

    const db = createDB();

    // See if the Embed for creating tickets is available and if its not, make one.
    let buttonEmbed = undefined
    let postChannel = client.channels.cache.find(x => x.id == client.config.channel_ids.post_embed_channel_id)
    if (!postChannel) {
        func.handle_errors(null, client, `ready.js`, `Could not find the 'post_embed_channel_id' for ticket creation, please make sure it is defined in your config and the bot is in the correct discord server.`)
    } else {
        buttonEmbed = await postChannel.messages.fetch(messageId.messageId).catch((e) => {
            if (e.code === 10008) return;
        })

        if (buttonEmbed == undefined) {

            const handlerRaw = require("../content/handler/handler.json");
            const handlerData = require("../content/handler/options.json");
            
            if (!handlerRaw.description || handlerRaw.description == "") {
                return func.handle_errors(null, client, `ready.js`, `Embed Description can not be found or is listed as a blank space. Please go to your handler file to add a description.`);
            }

            const keys = Object.keys(handlerData.options);
            const rows = [];
            let usedCustoms = "";

            for (const key of keys) {
                const opt = handlerData.options[key];
                if (!opt) continue;

                const questionFilesystem = require(`../content/questions/${opt.question_file}`);
                if (questionFilesystem.internal) continue;

                // Skip validation for question files that don't have button content structure
                if (questionFilesystem.active_ticket_button_content && 
                    questionFilesystem.active_ticket_button_content.accept && 
                    questionFilesystem.active_ticket_button_content.accept.enabled == false &&
                    questionFilesystem.active_ticket_button_content.deny && 
                    questionFilesystem.active_ticket_button_content.deny.enabled == false &&
                    questionFilesystem.active_ticket_button_content.custom_response_message && 
                    questionFilesystem.active_ticket_button_content.custom_response_message.enabled == false &&
                    questionFilesystem.active_ticket_button_content.make_a_ticket && 
                    questionFilesystem.active_ticket_button_content.make_a_ticket.enabled == false
                ) {
                    func.handle_errors(null, client, `ready.js`, `You need to enabled at least one of the holding channel buttons in your question file for ${key}.`);
                    continue;
                }

                if (!["PRIMARY", "SECONDARY", "DANGER", "SUCCESS"].includes(opt.button_type)) {
                    func.handle_errors(null, client, `ready.js`, `Could not add ticket type "${key}" due to the button type being incorrect. Please use "PRIMARY", "SECONDARY", "DANGER" or "SUCCESS" only.`);
                    continue;
                }
                if (!opt.unique_button_identifier || opt.unique_button_identifier == "") {
                    func.handle_errors(null, client, `ready.js`, `Could not add ticket type "${key}" due to there being no unique identifier set.`);
                    continue;
                }
                const customId = opt.unique_button_identifier.toLowerCase().replace(/ /g, '');
                if (usedCustoms.includes(customId)) {
                    func.handle_errors(null, client, `ready.js`, `Could not submit a ticket type button due to conflicting unique identifiers. (${key} - the name \`${customId}\` is duplicated)`);
                    continue;
                }
                usedCustoms = usedCustoms + ` - ` + customId;

                const styleKey = (opt.button_type || "PRIMARY").toUpperCase();
                const styleEnum = ButtonStyle[styleKey] || ButtonStyle.Primary;

                // Create new row when the last row already has 5 components
                let row = rows[rows.length - 1];
                if (!row || row.components.length >= 5) {
                    row = new ActionRowBuilder();
                    rows.push(row);
                }

                const btn = new ButtonBuilder()
                    .setCustomId(customId)
                    .setLabel(key)
                    .setStyle(styleEnum);
                if (opt.button_emoji) btn.setEmoji(opt.button_emoji);
                row.addComponents(btn);

                // Respect Discord's hard limit of 5 rows (25 buttons)
                if (rows.length >= 5 && row.components.length >= 5) {
                    break;
                }
            }

            if (rows.length === 0) {
                return func.handle_errors(null, client, `ready.js`, `No valid ticket types could be rendered for the main embed.`);
            }

            const FinalEmbed = new EmbedBuilder()
                .setTitle(handlerRaw.title.replace("{{SERVER}}", client.guilds?.cache.get(client.config.channel_ids.public_guild_id).name))
                .setColor(client.config.bot_settings.main_color)
                .setDescription(handlerRaw.description)
                .setFooter({text: client.user.username, iconURL: client.user.displayAvatarURL()})

            buttonEmbed = await postChannel.send({embeds: [FinalEmbed], components: rows}).catch((e) => func.handle_errors(e, client, `ready.js`, null))
            messageId.messageId = buttonEmbed.id
            fs.writeFileSync('./config/messageid.json', JSON.stringify(messageId), (err) => {
              if (err) func.handle_errors(err, client, `ready.js`, null);
            });
            }
    }


    // Keeps your "open-appeals" channel clear of unwanted messages.
    const deleteMessagesInTicketEmbedChannel = () => {
        const handlerRaw = require("../content/handler/options.json");
        const handlerKeys = Object.keys(handlerRaw.options);

        handlerKeys.forEach(TicketType => {
            const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == TicketType.toLowerCase());
            let typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
            
            // Skip validation if open-as-ticket is true
            if (typeFile["open-as-ticket"]) return;
            
            let TicketTypeChannel = client.channels.cache.find(x => x.id == typeFile["post-channel"]);
            if (TicketTypeChannel === undefined || TicketTypeChannel === null) return func.handle_errors(null, client, `ready.js`, `Question file for ${found} has an invalid \`post-channel\` ID.`)

            TicketTypeChannel.messages.fetch({limit: 100})
                .then(fetched => {
                    const notPinned = fetched.filter(fetchedMsg => !fetchedMsg.pinned);
                    const notBot = notPinned.filter(fetchedMsg => fetchedMsg.author.id != client.user.id);
                    TicketTypeChannel.bulkDelete(notBot, true).catch(error => {
                        // If the message is deleted, the Discord API will return an unknown message error
                        if (error instanceof DiscordAPIError && error.code === 10008) return;
                        // handle error
                        console.error(error)
                      })
                })
                .catch(console.error);

        })

        setTimeout(deleteMessagesInTicketEmbedChannel, 60000 * client.config.timeouts.embed_channel_message_delete_time_in_minutes)

    }

    // If the config is set to keep the channels clean, run it
    if (client.config.bot_settings.keep_embed_channel_clean === true) {
    deleteMessagesInTicketEmbedChannel()
    };
    
    // Post Internal Ticket Embed (question files marked internal=true)
    try {
        const internalChannelId = client.config.channel_ids.internal_post_embed_channel_id;
        if (internalChannelId) {
            const internalChannel = client.channels.cache.get(internalChannelId);
            if (!internalChannel) {
                func.handle_errors(null, client, `ready.js`, `Could not find the 'internal_post_embed_channel_id' for internal ticket creation.`)
            } else {
                let internalEmbedMessage = await internalChannel.messages.fetch(messageId.internalMessageId).catch((e) => {
                    if (e.code === 10008) return;
                });
                if (internalEmbedMessage == undefined) {
                    const handlerRaw = require("../content/handler/handler.json");
                    const handlerData = require("../content/handler/options.json");
                    const keys = Object.keys(handlerData.options || {});
                    const internalKeys = keys.filter(k => {
                        try { const qf = require(`../content/questions/${handlerData.options[k]?.question_file}`); return !!qf.internal; } catch(_) { return false; }
                    });
                    if (internalKeys.length > 0) {
                        const rows = [];
                        let usedCustoms = "";

                        for (const key of internalKeys) {
                            const opt = handlerData.options[key];
                            if (!opt || !opt.unique_button_identifier) continue;

                            const customId = opt.unique_button_identifier.toLowerCase().replace(/ /g, '');
                            if (usedCustoms.includes(customId)) continue;
                            usedCustoms = usedCustoms + ` - ` + customId;

                            const styleKey = (opt.button_type || 'PRIMARY').toUpperCase();
                            const styleEnum = ButtonStyle[styleKey] || ButtonStyle.Primary;

                            let row = rows[rows.length - 1];
                            if (!row || row.components.length >= 5) {
                                row = new ActionRowBuilder();
                                rows.push(row);
                            }

                            const btn = new ButtonBuilder()
                                .setCustomId(customId)
                                .setLabel(key)
                                .setStyle(styleEnum);
                            if (opt.button_emoji) btn.setEmoji(opt.button_emoji);
                            row.addComponents(btn);

                            if (rows.length >= 5 && row.components.length >= 5) {
                                break;
                            }
                        }

                        if (rows.length === 0) {
                            return func.handle_errors(null, client, `ready.js`, `No valid internal ticket types could be rendered for the internal embed.`);
                        }

                        const embed = new EmbedBuilder()
                            .setTitle('Internal Tickets')
                            .setColor(client.config.bot_settings.main_color)
                            .setDescription(require("../content/handler/handler.json").description)
                            .setFooter({text: client.user.username, iconURL: client.user.displayAvatarURL()});

                        internalEmbedMessage = await internalChannel.send({ embeds: [embed], components: rows }).catch((e) => func.handle_errors(e, client, `ready.js`, null));
                        try {
                            messageId.internalMessageId = internalEmbedMessage.id;
                            fs.writeFileSync('./config/messageid.json', JSON.stringify(messageId), (err) => {
                                if (err) func.handle_errors(err, client, `ready.js`, null);
                            });
                        } catch (_) {}
                    }
                }
            }
        }
    } catch (e) {
        func.handle_errors(e, client, `ready.js`, `Failed to post internal embed`)
    }
};