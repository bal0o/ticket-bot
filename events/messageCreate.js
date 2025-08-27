const config = require("../config/config.json");
const Discord = require("discord.js");
const func = require("../utils/functions.js");
const { createDB } = require('../utils/quickdb');
const db = createDB();
const metrics = require('../utils/metrics');
const lang = require("../content/handler/lang.json");

// Track users who are in the ticket selection process
const usersSelectingTicket = new Set();

module.exports = async function (client, message) {
    try {
        // Ignore messages from users who are in the selection process
        if (usersSelectingTicket.has(message.author.id)) return;

        if (message.author.bot || client.blocked_users.has(message.author.id)) return;
        if (message.channel.type === "DM") {
            const handlerRaw = require("../content/handler/options.json");
            const handlerKeys = Object.keys(handlerRaw.options);
            let categoryIDs = "";
        
            for (let TicketType of handlerKeys) {
                const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == TicketType.toLowerCase());
                let typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
                categoryIDs = categoryIDs + `${typeFile["ticket-category"]} `
            }

            let guild = client.guilds.cache.find(x => x.id == config.channel_ids.staff_guild_id);
            
            // Find all user's active ticket channels
            const channels = guild.channels.cache.filter(channel => 
                categoryIDs.includes(channel.parentId)
            );

            let activeTickets = [];
            for (const channel of channels.values()) {
                try {
                    const pinnedMessages = await channel.messages.fetchPinned();
                    const userTicket = pinnedMessages.find(m => 
                        m.embeds[0]?.footer?.text?.includes(message.author.id)
                    );
                    if (userTicket) {
                        activeTickets.push({
                            channel: channel,
                            ticketInfo: userTicket.embeds[0],
                            type: 'regular'
                        });
                    }
                } catch (err) {
                    continue;
                }
            }
            
            // Also check for application communication channels
            try {
                const allChannels = guild.channels.cache;
                for (const [channelId, channel] of allChannels) {
                    // Check if this channel is linked to an application
                    const appId = await db.get(`AppMap.channelToApp.${channelId}`);
                    if (appId) {
                        const appRec = await require('../utils/applications').getApplication(appId);
                        if (appRec && appRec.userId === message.author.id) {
                            activeTickets.push({
                                channel: channel,
                                ticketInfo: { title: `Application Communication - ${appRec.type}`, footer: { text: `${message.author.id}-app` } },
                                type: 'application',
                                appId: appId
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('Error checking application channels:', err);
            }

            // If no tickets found
            if (activeTickets.length === 0) {
                // Check if user has any application communication channels
                const appChannels = [];
                try {
                    const allChannels = guild.channels.cache;
                    for (const [channelId, channel] of allChannels) {
                        const appId = await db.get(`AppMap.channelToApp.${channelId}`);
                        if (appId) {
                            const appRec = await require('../utils/applications').getApplication(appId);
                            if (appRec && appRec.userId === message.author.id) {
                                appChannels.push({
                                    channel: channel,
                                    appRec: appRec
                                });
                            }
                        }
                    }
                } catch (err) {
                    console.error('Error checking application channels:', err);
                }
                
                if (appChannels.length === 0) {
                    // No tickets or application channels found
                    let ticketCountEmbed = new Discord.MessageEmbed()
                        .setTitle(lang.active_tickets["player-active-title"] != "" ? lang.active_tickets["player-active-title"].replace(`{{COUNT}}`, "0") : `You currently have 0 ticket(s) being looked at by the team.`)
                        .setDescription(lang.active_tickets["player-active-description"] != "" ? lang.active_tickets["player-active-description"].replace(`{{TICKETCHANNEL}}`, `<#${client.config.channel_ids.post_embed_channel_id}>`) : `If you would like to open a ticket, please head to <#${client.config.channel_ids.post_embed_channel_id}>.\n`)
                        .setColor(client.config.bot_settings.main_color)
                        .setFooter({text: client.user.username, iconURL: client.user.displayAvatarURL()})

                    await message.channel.send({embeds: [ticketCountEmbed]})
                    return;
                } else {
                    // User has application communication channels, process the message
                    if (appChannels.length === 1) {
                        await processTicketMessage(message, appChannels[0].channel, client);
                        return;
                    } else {
                        // Multiple application channels - let user choose
                        const selectionEmbed = new Discord.MessageEmbed()
                            .setTitle("Multiple Application Communications")
                            .setDescription("Please select which application communication you want to send your message to:")
                            .setColor(client.config.bot_settings.main_color);

                        let appList = "";
                        appChannels.forEach((app, index) => {
                            appList += `${index + 1}) ${app.appRec.type} Application\n`;
                        });
                        selectionEmbed.addFields({ name: "Your Applications", value: appList });

                        const selectionMessage = await message.channel.send({embeds: [selectionEmbed]});
                        usersSelectingTicket.add(message.author.id);

                        const filter = m => m.author.id === message.author.id && /^[1-9][0-9]*$/.test(m.content) && parseInt(m.content) <= appChannels.length;
                        try {
                            const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
                            const selectedApp = appChannels[parseInt(collected.first().content) - 1];
                            if (selectedApp) {
                                await selectionMessage.delete().catch(() => {});
                                await processTicketMessage(message, selectedApp.channel, client);
                            }
                        } catch (err) {
                            await selectionMessage.delete().catch(() => {});
                            await message.channel.send("No valid selection made. Please try sending your message again.");
                        } finally {
                            usersSelectingTicket.delete(message.author.id);
                        }
                        return;
                    }
                }
            }

            // If only one ticket, process it directly
            if (activeTickets.length === 1) {
                await processTicketMessage(message, activeTickets[0].channel, client);
                return;
            }

            // If multiple tickets, create selection menu
            const selectionEmbed = new Discord.MessageEmbed()
                .setTitle("Multiple Active Tickets")
                .setDescription("Please select which ticket you want to send your message to by replying with the corresponding number:")
                .setColor(client.config.bot_settings.main_color);

            let ticketList = "";
            activeTickets.forEach((ticket, index) => {
                const ticketType = ticket.ticketInfo.title.split(" | ")[0];
                const ticketNumber = ticket.ticketInfo.title.split("#")[1].trim();
                ticketList += `${index + 1}) ${ticketType} #${ticketNumber}\n`;
            });
            selectionEmbed.addFields({ name: "Your Active Tickets", value: ticketList });

            const selectionMessage = await message.channel.send({embeds: [selectionEmbed]});

            // Add user to selection process
            usersSelectingTicket.add(message.author.id);

            // Wait for user's selection
            const filter = m => m.author.id === message.author.id && /^[1-9][0-9]*$/.test(m.content) && parseInt(m.content) <= activeTickets.length;
            try {
                const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
                const selectedTicket = activeTickets[parseInt(collected.first().content) - 1];
                if (selectedTicket) {
                    // Only delete the selection embed
                    await selectionMessage.delete().catch(() => {});
                    
                    // Process the message for the selected ticket
                    await processTicketMessage(message, selectedTicket.channel, client);
                } else {
                    await message.channel.send("Invalid selection. Please try again.").catch(() => {});
                }
            } catch (err) {
                // Delete the selection embed if it times out
                await selectionMessage.delete().catch(() => {});
                await message.channel.send("No valid selection made. Please try sending your message again.");
            } finally {
                // Remove user from selection process
                usersSelectingTicket.delete(message.author.id);
            }
        } else {
            const staffGuild = await client.guilds.cache.get(client.config.channel_ids.staff_guild_id);
            if (!staffGuild || message.guild.id !== staffGuild.id) return;

            const userId = message.channel.topic;
            if (!userId || !/^\d{17,19}$/.test(userId)) {
                return;
            }

            if (message.channel.isThread()) {
                return;
            }
            
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) {
                return message.reply("Could not find the user to send the message to.");
            }
            
            const prefix = client.config.bot_settings.prefix;
            const handlerRaw = require("../content/handler/options.json");
            const handlerKeys = Object.keys(handlerRaw.options);
            let ticketType = null;
            for (let TicketType of handlerKeys) {
                const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == TicketType.toLowerCase());
                let typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
                if (typeFile["ticket-category"] === message.channel.parentId) {
                    ticketType = typeFile;
                    break;
                }
            }

            // Access roles are now added when the staff thread is created, not when staff type in the main channel
            
            // Claim enforcement: if enabled and ticket claimed by someone else, block
            try {
                if (client.config?.claims?.enabled && client.config?.claims?.restrict_to_claimer) {
                    const claim = (client.claims && client.claims.get(message.channel.id)) || await db.get(`Claims.${message.channel.id}`);
                    if (claim && claim.userId && claim.userId !== message.author.id) {
                        const bypassRoles = new Set(client.config?.claims?.role_bypass_ids || []);
                        const hasBypass = message.member.roles.cache.some(r => bypassRoles.has(r.id));
                        if (!hasBypass) {
                            await message.reply(`This ticket is claimed by <@${claim.userId}>.`).catch(() => {});
                            return;
                        }
                    }
                }
            } catch (_) {}

            // Prepare mapping container for staff->user forwards
            const staffForward = { userId: user.id, dmChannelId: null, filesMessageId: null, textMessageIds: [] };

            // Handle staff -> user attachments (send inline, no extra notices)
            if (message.attachments && message.attachments.size > 0) {
                try {
                    // Validate all attachments before sending any
                    for (let attachment of message.attachments) {
                        if (client.config.file_extensions.allowed_file_extensions_enabled === true) {
                            let allowedExtensionCount = 0;
                            let attachmentLink = attachment[1].attachment.split(`?ex=`)[0];
                            for (extension of client.config.file_extensions.allowed_file_extensions) {
                                if (attachmentLink.substring(attachmentLink.length - extension.length).toLowerCase() === extension.toLowerCase()) allowedExtensionCount++
                            }
                            if (allowedExtensionCount === 0) {
                                const errorEmbed = new Discord.MessageEmbed()
                                    .setDescription(lang.attachments["user-blacklisted-extension"] != "" ? lang.attachments["user-blacklisted-extension"].replace(`{{ATTACHMENT}}`, `${attachment[1].name}`) : `**Attachment \`(${attachment[1].name})\` contains a blacklisted extension and was not sent!**`)
                                    .setColor(client.config.active_ticket_settings.ticket_staff_embed_color);
                                await message.channel.send({ embeds: [errorEmbed] }).catch(e => { func.handle_errors(e, client, `messageCreate.js`, null) });
                                await message.react('❌').catch(() => {});
                                return;
                            }
                        }
                    }

                    // Send all files inline in a single DM
                    const filesToSend = [];
                    for (let attachment of message.attachments) {
                        filesToSend.push({ attachment: attachment[1].attachment, name: attachment[1].name });
                    }
                    const filesSent = await user.send({ files: filesToSend });
                    if (filesSent && filesSent.id) {
                        staffForward.filesMessageId = filesSent.id;
                        staffForward.dmChannelId = filesSent.channel?.id || staffForward.dmChannelId;
                    }
                } catch (err) {
                    func.handle_errors(err, client, `messageCreate.js`, null);
                    await message.reply("There was an error sending your attachment. Please try again.").catch(() => {});
                }
            }
            
            if (message.content.startsWith(`${prefix}me`)) {
                const replyContent = message.content.slice(`${prefix}me`.length).trim();
                if (!replyContent) {
                    return message.reply("Please provide a message to send.");
                }
				try {
					const isUrlOnly = /^https?:\/\/\S+$/i.test(replyContent);
                    if (isUrlOnly) {
                        const sent = await user.send(replyContent);
                        if (sent && sent.id) {
                            staffForward.textMessageIds.push(sent.id);
                            staffForward.dmChannelId = sent.channel?.id || staffForward.dmChannelId;
                        }
                        // continue to mapping write below
                        // do not return to allow other branches to be skipped naturally
                        // and mapping to be saved
                        return await db.set(`StaffForwardMap.${message.id}`, staffForward).catch(e => func.handle_errors(e, client, `messageCreate.js`, null));
                    }
                    const roles = message.member.roles.cache
                        .filter(role => role.id !== message.guild.id)
                        .sort((a, b) => b.position - a.position);
                    
                    const highestRole = roles.first();
                    const roleName = highestRole ? highestRole.name : 'Staff';
                    
                    const replyEmbed = new Discord.MessageEmbed()
                        .setAuthor({ 
                            name: `${message.member.displayName} (${roleName})`, 
                            iconURL: message.author.displayAvatarURL()
                        })
                        .setDescription(replyContent)
                        .setColor(client.config.bot_settings.main_color)
                    
                    const sent = await user.send({ embeds: [replyEmbed] });
                    if (sent && sent.id) {
                        staffForward.textMessageIds.push(sent.id);
                        staffForward.dmChannelId = sent.channel?.id || staffForward.dmChannelId;
                    }
                } catch (error) {
                    console.error('Error sending reply:', error);
                    await message.reply("There was an error sending your message. Please try again.");
                }

            } else if (message.content.startsWith(`${prefix}r`)) {
                if (ticketType && ticketType["anonymous-only-replies"] === false) {
                    const allowedRoles = client.config.role_ids.role_ids_anonymous_cmd;
                    if (!message.member.roles.cache.some(role => allowedRoles.includes(role.id))) {
                        return message.reply("You do not have permission to use this command.");
                    }
                }

                const replyContent = message.content.slice(`${prefix}r`.length).trim();
                if (!replyContent) {
                    return message.reply("Please provide a message to send.");
                }
                try {
                    const sent = await user.send(replyContent);
                    if (sent && sent.id) {
                        staffForward.textMessageIds.push(sent.id);
                        staffForward.dmChannelId = sent.channel?.id || staffForward.dmChannelId;
                    }
                    await message.react('🅰️');
                } catch (error) {
                    console.error('Error sending anonymous reply:', error);
                    await message.reply("There was an error sending your message. Please try again.");
                }

            } else if (message.content.startsWith(`${prefix}close`)) {
                const reason = message.content.slice(`${prefix}close`.length).trim() || 'No Reason Provided.';
                await func.closeTicket(client, message.channel, message.member, reason);
            
            } else if (message.content.startsWith(prefix)) {
                const args = message.content.slice(prefix.length).trim().split(/ +/);
                const command = args.shift().toLowerCase();
                if (!client.commands.has(command)) return;
                if (command.toLowerCase() === "ticketinfo" || command.toLowerCase() === "ticketcheetos" || command.toLowerCase() === "ticketuserinfo") return;
                client.commands.get(command)(client, message);

			} else {
                const replyContent = message.content;
                 if (!replyContent) {
                    return;
                }

                if (ticketType && ticketType["anonymous-only-replies"] === true) {
                    try {
                        const sent = await user.send(replyContent);
                        if (sent && sent.id) {
                            staffForward.textMessageIds.push(sent.id);
                            staffForward.dmChannelId = sent.channel?.id || staffForward.dmChannelId;
                        }
                        await message.react('🅰️');
                    } catch (error) {
                        console.error('Error sending anonymous reply:', error);
                        await message.reply("There was an error sending your message. Please try again.");
                    }
				} else {
					try {
						const isUrlOnly = /^https?:\/\/\S+$/i.test(replyContent);
						if (isUrlOnly) {
                            const sent = await user.send(replyContent);
                            if (sent && sent.id) {
                                staffForward.textMessageIds.push(sent.id);
                                staffForward.dmChannelId = sent.channel?.id || staffForward.dmChannelId;
                            }
							return;
						}
                        const roles = message.member.roles.cache
                            .filter(role => role.id !== message.guild.id)
                            .sort((a, b) => b.position - a.position);
                        
                        const highestRole = roles.first();
                        const roleName = highestRole ? highestRole.name : 'Staff';
                        
                        const replyEmbed = new Discord.MessageEmbed()
                            .setAuthor({ 
                                name: `${message.member.displayName} (${roleName})`, 
                                iconURL: message.author.displayAvatarURL()
                            })
                            .setDescription(replyContent)
                            .setColor(client.config.bot_settings.main_color)
                        
                        const sent = await user.send({ embeds: [replyEmbed] });
                        if (sent && sent.id) {
                            staffForward.textMessageIds.push(sent.id);
                            staffForward.dmChannelId = sent.channel?.id || staffForward.dmChannelId;
                        }
                    } catch (error) {
                        console.error('Error sending reply:', error);
                        await message.reply("There was an error sending your message. Please try again.");
                    }
                }
            }

            // Save mapping if any DM messages were sent
            if (staffForward.dmChannelId && (staffForward.textMessageIds.length > 0 || staffForward.filesMessageId)) {
                await db.set(`StaffForwardMap.${message.id}`, staffForward).catch(e => func.handle_errors(e, client, `messageCreate.js`, null));
            }
        }
    } catch (exception) {
        func.handle_errors(exception, client, `messageCreate.js`, null)
    };
};

async function processTicketMessage(message, channel, client) {
    // Check if this is an application communication channel
    const isAppChannel = await db.get(`AppMap.channelToApp.${channel.id}`);
    
    // Collect and validate attachments for inline sending
    const filesToSend = [];
    for (let attachment of message.attachments) {
        if (client.config.file_extensions.allowed_file_extensions_enabled === true) {
            let extensionChecks = 0;
            let attachementLink = attachment[1].attachment.split(`?ex=`)[0];
            for (extension of client.config.file_extensions.allowed_file_extensions) {
                if (attachementLink.substring(attachementLink.length - extension.length).toLowerCase() === extension.toLowerCase()) extensionChecks++
            }
            if (extensionChecks === 0) {
                const TicketreplyEmbed = new Discord.MessageEmbed()
                    .setDescription(lang.attachments["user-blacklisted-extension"] != "" ? lang.attachments["user-blacklisted-extension"].replace(`{{ATTACHMENT}}`, `${attachment[1].name}`) : `**Attachment \`(${attachment[1].name})\` contains a blacklisted extension and was not sent!**`)
                    .setColor(config.active_ticket_settings.ticket_user_embed_color);
                await message.channel.send({embeds: [TicketreplyEmbed]}).catch((err) => { func.handle_errors(err, client, `messageCreate.js`, null) })
                await message.react('❌')
                return;
            }
        }
        filesToSend.push({ attachment: attachment[1].attachment, name: attachment[1].name });
    }

    // Send combined text + images inline via webhook for proper author spoofing
    const sanitize = (text) => {
        let replyNoEveryone = text.replace(`@everyone`, `@ everyone`)
        let replyNoHere = replyNoEveryone.replace(`@here`, `@ here`)
        return replyNoHere.replace(`<@`, `<@ `)
    }

    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.name === "Ticket Webhook");
    if (!webhook) {
        webhook = await channel.createWebhook("Ticket Webhook", {
            avatar: message.author.displayAvatarURL()
        });
    }
    
    // For application channels, use plain username (no prefix needed)
    const username = message.author.username;
    
    // For application channels, use plain message content (no prefix needed)
    let messageContent = message.content;

    const hasContent = messageContent && messageContent.trim() !== "";
    let combinedMessage = null;
    let filesMessage = null;
    const textMessageIds = [];

    if (hasContent && message.content.length <= 1900) {
        combinedMessage = await webhook.send({
            content: sanitize(messageContent),
            username: username,
            avatarURL: message.author.displayAvatarURL(),
            files: filesToSend
        }).catch((err) => func.handle_errors(err, client, `messageCreate.js`, null));
    } else {
        if (filesToSend.length > 0) {
            filesMessage = await webhook.send({
                username: username,
                avatarURL: message.author.displayAvatarURL(),
                files: filesToSend
            }).catch((err) => func.handle_errors(err, client, `messageCreate.js`, null));
        }
        if (hasContent) {
            for (let i = 0; i < messageContent.length; i += 1900) {
                const toSend = messageContent.substring(i, Math.min(messageContent.length, i + 1900));
                const sent = await webhook.send({
                    content: sanitize(toSend),
                    username: username,
                    avatarURL: message.author.displayAvatarURL()
                }).catch((err) => func.handle_errors(err, client, `messageCreate.js`, null));
                if (sent && sent.id) textMessageIds.push(sent.id);
            }
        }
    }

    // Persist mapping for message edits
    try {
        await db.set(`ForwardMap.${message.id}`, {
            channelId: channel.id,
            combinedMessageId: combinedMessage && combinedMessage.id ? combinedMessage.id : null,
            filesMessageId: filesMessage && filesMessage.id ? filesMessage.id : null,
            textMessageIds: textMessageIds
        });
    } catch (e) {
        func.handle_errors(e, client, `messageCreate.js`, null);
    }
    
    // No notification needed for application channels - the webhook message is sufficient
}