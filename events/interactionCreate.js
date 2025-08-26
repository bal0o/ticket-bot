// Environment variables are now loaded from config.json
const config = require("../config/config.json");
const transcript = require("../utils/fetchTranscript.js");
const { readdirSync } = require("fs");
const Discord = require("discord.js");
const unirest = require("unirest");
const func = require("../utils/functions.js");
const lang = require("../content/handler/lang.json");
const {QuickDB} = require("quick.db")
const db = new QuickDB();
const metrics = require('../utils/metrics');
const applications = require('../utils/applications');

// Initialize commands collection if it doesn't exist
if (!Discord.Collection.prototype.commands) {
    Discord.Collection.prototype.commands = new Discord.Collection();
}

module.exports = async function (client, interaction) {
    if (interaction.isButton() && ['prev_page', 'next_page'].includes(interaction.customId)) {
        return;
    }
    // Initialize commands collection if it doesn't exist
    if (!client.commands) {
        client.commands = new Discord.Collection();
    }

    try {
        // Update status when bot starts
        if (!client.ticketStatusInitialized) {
            await func.updateTicketStatus(client);
            client.ticketStatusInitialized = true;
        }

        if (interaction.isCommand()) {
    const command = client.commands.get(interaction.commandName + `_slash`)
    if (!command) return;

    try {
        await command.execute(interaction, client);
        } catch(err) {
            if (err) func.handle_errors(err, client, `interactionCreate.js`, null)

            await interaction.reply({
                content:`An error occured while executing that command!`,
                ephemeral: true
            })
        }
            return;
    }
        
        if (interaction.customId === "feedbackModal") {
            await interaction.deferReply().catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null)})

            let feedbackChannel = client.channels.cache.find(x => x.id === client.config.channel_ids.feedback_channel)

            if (!feedbackChannel) {

                func.handle_errors(null, client, `interactionCreate.js`, `The Feedback channel could not be found, please assign it in the configs. Canceling feedback report.`)
                return interaction.editReply(lang.feedback_messages["feedback-error-no-channel"] != "" ? lang.feedback_messages["feedback-error-no-channel"] : "Thanks for your feedback, sadly our systems aren't working properly and it did not get saved. Please let a member of staff know!").catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null)})

            }

            const handlerRaw = require("../content/handler/options.json");
            let ticketType = interaction.message.embeds[0].footer.text.split("|")[1].substring(1);

            let validOption = ""
            for (let options of Object.keys(handlerRaw.options)) {

                if (options == ticketType) {
                    validOption = handlerRaw.options[`${options}`] 
                }
        }

        const questionFilesystem = require(`../content/questions/${validOption.question_file}`);
        if (!questionFilesystem) return func.handle_errors(null, client, `interactionCreate.js`, `There is a missing question file for ${ticketType}, have you changed the name or file directory recently?`)

            let feedbackModalResponse = new Discord.MessageEmbed()
            .setTitle(`Ticket Feedback`)
            .setDescription(`Feedback from: *${interaction.user.username} (${interaction.user.id})*`)
            .setColor(client.config.bot_settings.main_color)
            .setTimestamp()
            .setFooter({text: client.user.username, iconURL: client.user.displayAvatarURL()})

            for (let i = 0; i < interaction.components.length; i++) {
                feedbackModalResponse.addFields({ name: `${questionFilesystem.feedback_questions[i]}`, value: `${interaction.components[i].components[0].value == "" ? "No response" : interaction.components[i].components[0].value}` });
            }

            await interaction.editReply(questionFilesystem.successful_feedback_message == "" ? "Thanks for your feedback!" : questionFilesystem.successful_feedback_message)
           
            const feedbackRowDone = new Discord.MessageActionRow()
            feedbackRowDone.addComponents(
                new Discord.MessageButton()
                    .setCustomId(`feedbackbutton`)
                    .setLabel(`Feedback Sent!`)
                    .setStyle("SECONDARY")
                    .setEmoji("📋")
                    .setDisabled(true),
            );

           await interaction.message.edit({embeds: [interaction.message.embeds[0]], components: [feedbackRowDone]})
           
           
            return feedbackChannel.send({embeds: [feedbackModalResponse]}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
        }

        if (interaction.customId === 'closeTicketModal') {
            try {
                await interaction.deferReply({ ephemeral: true });
                
                const channel = interaction.channel;
                if (!channel) {
                    await interaction.editReply({ content: 'Could not find the ticket channel.', ephemeral: true });
                    return;
                }
                
                const reason = interaction.fields.getTextInputValue('closeReason') || 'No Reason Provided.';
                await func.closeTicket(client, channel, interaction.member, reason);
                await interaction.editReply({ content: `Your ticket has been closed.`, ephemeral: true });
            } catch (error) {
                func.handle_errors(error, client, 'interactionCreate.js', 'Error handling close ticket modal');
                try {
                    await interaction.editReply({ content: 'An error occurred while closing the ticket. Please try again.', ephemeral: true });
                } catch (e) {
                    // If we can't edit the reply, the interaction has probably timed out
                    console.error('Failed to edit reply:', e);
                }
            }
            return;
        }

        if (interaction.customId === "CustomResponseModal") {
            await interaction.deferUpdate().catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null)})

            const handlerRawCustomFinal = require("../content/handler/options.json");
            let ticketTypeCustomFinal = interaction?.message?.embeds[0].title.split(" | ")[0];
            if (ticketTypeCustomFinal == null || ticketTypeCustomFinal == undefined) {

                let errormsg = await interaction.channel.send({content: "The embed can not be found!" }).catch(e => { func.handle_errors(e, client, `interactionCreate.js`, null) });
               
                setTimeout(async () => {
                    return await errormsg.delete().catch(e => func.handle_errors(e, client, `interactionCreate.js`, null))
                }, client.config.timeouts.user_error_message_timeout_in_seconds * 1000);
                return;
            }
            const uniqueTicketID = interaction.message.embeds[0].footer.text.split("|")[0].trim();
            const DiscordID = uniqueTicketID.split(`-`)[0];
            let recepient = await client.users.fetch(DiscordID).catch(e => {
                func.handle_errors(e, client, `interactionCreate.js`, `Could not fetch user with ID ${DiscordID}`);
                return null;
            });
            if (recepient) {

            const foundCustomFinal = Object.keys(handlerRawCustomFinal.options).find(x => x.toLowerCase() == ticketTypeCustomFinal.toLowerCase());
            let typeFile = require(`../content/questions/${handlerRawCustomFinal.options[foundCustomFinal].question_file}`);
            let transcriptChannel = typeFile[`transcript-channel`];

            let reason = interaction.fields.getTextInputValue('customresponse') != "" ? `\`\`\`${interaction.fields.getTextInputValue('customresponse')}\`\`\`` : lang.close_ticket['close-default-reason'] != "" ? lang.close_ticket['close-default-reason'] : "\`\`\`No Reason Provided\`\`\`"
            const logs_channel = await interaction.message.guild.channels.cache.find(x => x.id === transcriptChannel);
            const embedFinal = interaction.message.embeds[0]

            func.updateResponseTimes(interaction.message.embeds[0].timestamp, Date.now(), ticketTypeCustomFinal, "CustomClose")
                
            await func.staffStats(ticketTypeCustomFinal, `customclose`, interaction.user.id);
            

                if (logs_channel) {
                    embedFinal.setAuthor({name: lang.custom_reply_close_ticket["close-transcript-embed-title"] != "" ? lang.custom_reply_close_ticket["close-transcript-embed-title"].replace(`{{ADMIN}}`, `${interaction.user.username}/${interaction.user.id}`) + `\n${embedFinal?.author?.name}`: `Custom Reply by ${interaction.user.username}/${interaction.user.id} \n${embedFinal?.author?.name}`, iconURL: interaction.user.displayAvatarURL()});
                    embedFinal.addFields({
                        name: lang.custom_reply_close_ticket["close-transcript-embed-reason-title"] != "" ? lang.custom_reply_close_ticket["close-transcript-embed-reason-title"] : `Reply`,
                        value: reason,
                        inline: true
                    });
                    embedFinal.addFields({
                        name: lang.custom_reply_close_ticket["close-transcript-embed-response-title"] != "" ? lang.custom_reply_close_ticket["close-transcript-embed-response-title"] : `Response Time`,
                        value: `\`\`\`${await func.convertMsToTime(Date.now() - embedFinal.timestamp)}\`\`\``,
                        inline: true
                    });
                    let messageID = await logs_channel.send({content: `<@${recepient.id}>`, embeds: [embedFinal] })?.catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null) });
                
                    await db.set(`PlayerStats.${recepient.id}.ticketLogs.${uniqueTicketID}.transcriptLink`, `https://discord.com/channels/${interaction.message.guild.id}/${logs_channel.id}/${messageID.id}`)
					
                };
                await db.set(`PlayerStats.${recepient.id}.ticketLogs.${uniqueTicketID}.firstActionTime`, Date.now() / 1000)
                await db.set(`PlayerStats.${recepient.id}.ticketLogs.${uniqueTicketID}.firstActionTimeAdminName`, interaction.user.username)
                await db.set(`PlayerStats.${recepient.id}.ticketLogs.${uniqueTicketID}.firstActionTimeAdminID`, interaction.user.id)
                await func.closeDataAddDB(recepient.id, uniqueTicketID, `Custom Close Message`, interaction.user.username, interaction.user.id, Date.now() / 1000, reason);

                await interaction.message.delete().catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null)})

                // Update ticket count after custom close
                await func.updateTicketStatus(client);

                let response = new Discord.MessageEmbed()
                .setTitle(lang.custom_reply_close_ticket["player-close-embed-title"] != "" ? 
                    lang.custom_reply_close_ticket["player-close-embed-title"]
                        .replace(`{{TICKETTYPE}}`, ticketTypeCustomFinal)
                        .replace(`{{TICKETNUMBER}}`, interaction.message.embeds[0].title.split('#')[1]) : 
                    `Your ${ticketTypeCustomFinal} ticket has been closed with the following response:`)
                .setDescription(`${reason}`)
                .setColor(client.config.bot_settings.main_color)
                .setFooter({text: client.user.username + ` | ` + ticketTypeCustomFinal, iconURL: client.user.displayAvatarURL()})

                if (typeFile.allow_feedback == true) {

                    const feedbackRow = new Discord.MessageActionRow()
                    feedbackRow.addComponents(
                        new Discord.MessageButton()
                            .setCustomId(`feedbackbutton`)
                            .setLabel(lang.feedback_messages["ticket-feedback-button-title"] != "" ? lang.feedback_messages["ticket-feedback-button-title"] : "Send Ticket Feedback")
                            .setStyle("SECONDARY")
                            .setEmoji("📋"),
                    );

                    recepient.send({embeds: [response], components: [feedbackRow]}).catch(async (err) => {

                        if (err.message === `Cannot send messages to this user`) {
                            func.handle_errors(null, client, `interactionCreate.js`, `I can not send the user a DM as their DMs are turned off. Channel: ${interaction.channel.name}(${interaction.channel.id}).`);
                        } else {func.handle_errors(err, client, `interactionCreate.js`, null)}
                    })

                } else {

                    recepient.send({embeds: [response]}).catch(async (err) => {

                        if (err.message === `Cannot send messages to this user`) {
                            func.handle_errors(null, client, `interactionCreate.js`, `I can not send the user a DM as their DMs are turned off. Channel: ${interaction.channel.name}(${interaction.channel.id}).`);
                        } else {func.handle_errors(err, client, `interactionCreate.js`, null)}
                    })
                }
            } else {
                await interaction.message.delete().catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null)})
                let errormsg = await interaction.channel.send({content: lang.misc["no-user-found"] != "" ? lang.misc["no-user-found"] : "Could not find that user to send them a message. Have they left the discord?", ephemeral: true}).catch(e => { func.handle_errors(e, client, `interactionCreate.js`, null) });
                setTimeout(async () => {
                    return await errormsg.delete().catch(e => func.handle_errors(e, client, `interactionCreate.js`, null))
                }, client.config.timeouts.user_error_message_timeout_in_seconds * 1000);
            }
        }

        if (interaction.customId === 'claimticket') {
            try {
                // Acknowledge early to prevent interaction token expiry
                await interaction.deferUpdate().catch(()=>{});
                if (!interaction.channel || interaction.channel.isThread()) return;
                const myPins = await interaction.channel.messages.fetchPinned();
                const LastPin = myPins.last();
                if (!LastPin || !LastPin.embeds[0] || !LastPin.embeds[0].footer) return;
                const embed = LastPin.embeds[0];
                const ticketType = embed.title.split(' #')[0];
                const footerParts = embed.footer.text.split('|');
                const idParts = footerParts[0].trim().split('-');
                const globalTicketNumber = idParts[1];
                const claimKey = `${interaction.channel.id}`;

                // If already claimed by someone else, block
                const existing = client.claims.get(claimKey);
                if (existing && existing.userId !== interaction.user.id) {
                    await interaction.followUp({ content: `This ticket is already claimed by <@${existing.userId}>.`, ephemeral: true }).catch(()=>{});
                    return;
                }

                // Toggle: unclaim if same user or admin
                const isAdmin = interaction.member.roles.cache.has(client.config.role_ids.default_admin_role_id);
                if (existing && (existing.userId === interaction.user.id || isAdmin)) {
                    client.claims.delete(claimKey);
                    try { await db.delete(`Claims.${interaction.channel.id}`); } catch (_) {}
                    // Enable send permissions for access roles again if restricted flow is used
                    if (client.config?.claims?.restrict_to_claimer) {
                        try {
                            const handlerRaw = require("../content/handler/options.json");
                            const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == ticketType.toLowerCase());
                            const typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
                            const accessRoleIDs = typeFile["access-role-id"] || [];
                            for (const roleId of accessRoleIDs) {
                                if (!roleId) continue;
                                await interaction.channel.permissionOverwrites.edit(roleId, { SEND_MESSAGES: true }).catch(() => {});
                            }
                        } catch (_) {}
                    }
                    // Update channel name to remove -claimed
                    try {
                        if (interaction.channel.name.endsWith('-claimed')) {
                            // Fire-and-forget to avoid blocking on route-specific rate limits
                            interaction.channel.setName(interaction.channel.name.replace(/-claimed$/, '')).catch(() => {});
                        }
                    } catch (_) {}
                    // Update button label to Claim Ticket
                    try {
                        const rows = interaction.message.components.map(row => {
                            const newRow = new Discord.MessageActionRow();
                            newRow.addComponents(row.components.map(comp => {
                                if (comp.customId === 'claimticket') return comp.setLabel('Claim Ticket');
                                return comp;
                            }));
                            return newRow;
                        });
                        await interaction.message.edit({ components: rows }).catch(()=>{});
                    } catch (_) {}
                    await interaction.followUp({ content: 'Unclaimed ticket.', ephemeral: true }).catch(()=>{});
                    return;
                }

                // Claim
                client.claims.set(claimKey, { userId: interaction.user.id, at: Date.now(), ticketType, ticketId: globalTicketNumber });
                try { await db.set(`Claims.${interaction.channel.id}`, { userId: interaction.user.id, at: Date.now(), ticketType, ticketId: globalTicketNumber }); } catch (_) {}
                try { 
					metrics.ticketClaimed(ticketType); 
					metrics.staffAction('claim', ticketType, interaction.user.id, interaction.user.username); 
				} catch (_) {}

                if (client.config?.claims?.restrict_to_claimer) {
                    try {
                        const handlerRaw = require("../content/handler/options.json");
                        const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == ticketType.toLowerCase());
                        const typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
                        const accessRoleIDs = typeFile["access-role-id"] || [];
                        const bypass = new Set((client.config?.claims?.role_bypass_ids || []).concat([client.config.role_ids.default_admin_role_id].filter(Boolean)));
                        // Disable send for all access roles except bypass ones; claimer retains via member overwrite
                        for (const roleId of accessRoleIDs) {
                            if (!roleId) continue;
                            if (bypass.has(roleId)) continue;
                            await interaction.channel.permissionOverwrites.edit(roleId, { SEND_MESSAGES: false }).catch(() => {});
                        }
                        await interaction.channel.permissionOverwrites.edit(interaction.user.id, { SEND_MESSAGES: true, VIEW_CHANNEL: true }).catch(() => {});
                    } catch (_) {}
                }

                // Rename channel to append -claimed
                try {
                    if (!interaction.channel.name.endsWith('-claimed')) {
                        // Fire-and-forget to avoid blocking on route-specific rate limits
                        interaction.channel.setName(`${interaction.channel.name}-claimed`).catch(() => {});
                    }
                } catch (_) {}
                // Update button label to Unclaim
                try {
                    const rows = interaction.message.components.map(row => {
                        const newRow = new Discord.MessageActionRow();
                        newRow.addComponents(row.components.map(comp => {
                            if (comp.customId === 'claimticket') return comp.setLabel('Unclaim');
                            return comp;
                        }));
                        return newRow;
                    });
                    await interaction.message.edit({ components: rows }).catch(()=>{});
                } catch (_) {}
                await interaction.followUp({ content: `You claimed this ticket.`, ephemeral: true }).catch(()=>{});
            } catch (e) {
                func.handle_errors(e, client, 'interactionCreate.js', 'Error in claimticket');
            }
            return;
        }

        // Application stage buttons
        if (interaction.customId === 'app_next_stage' || interaction.customId === 'app_deny') {
            try {
                await interaction.deferReply({ ephemeral: true });
                const channelId = interaction.channel.id;
                const appId = await db.get(`AppMap.channelToApp.${channelId}`);
                if (!appId) {
                    await interaction.editReply({ content: 'No application linked to this ticket.' });
                    return;
                }
                const roles = await (async () => await require('../web/server')) || null; // not used, keep role checks simple in guild
                const member = interaction.member;
                const isAdmin = member.roles.cache.has(config.role_ids.application_admin_role_id) || member.roles.cache.has(config.role_ids.default_admin_role_id);
                if (!isAdmin) {
                    await interaction.editReply({ content: 'You do not have permission to manage applications.' });
                    return;
                }
                const cfg = require('../config/config.json');
                const appCfg = cfg.applications || {};
                const msgs = appCfg.messages || {};
                if (interaction.customId === 'app_next_stage') {
                    const stages = appCfg.stages || ['Submitted','Initial Review','Background Check','Interview','Final Decision','Archived'];
                    const appRec = await applications.getApplication(appId);
                    const idx = Math.max(0, stages.indexOf(appRec?.stage || 'Submitted')) + 1;
                    const nextStage = stages[Math.min(idx, stages.length - 1)] || 'Initial Review';
                    await applications.advanceStage(appId, nextStage, interaction.user.id, 'Advanced via ticket');
                    const dm = (msgs.advance_dm || 'Your application has moved to the next stage: {{STAGE}}.').replace('{{STAGE}}', nextStage);
                    const user = await interaction.client.users.fetch(appRec.userId).catch(()=>null);
                    try { if (user) await user.send(dm); } catch(_){}
                    const chMsg = (msgs.advance_channel || 'Application advanced to {{STAGE}} by {{STAFF}}.').replace('{{STAGE}}', nextStage).replace('{{STAFF}}', interaction.user.username);
                    await interaction.channel.send(chMsg).catch(()=>{});
                    // Close ticket after stage advance
                    await func.closeTicket(interaction.client, interaction.channel, interaction.member, `Application advanced to ${nextStage}`);
                    await interaction.editReply({ content: `Advanced to ${nextStage} and ticket closed.` });
                } else {
                    await applications.deny(appId, interaction.user.id, 'Denied via ticket');
                    const appRec = await applications.getApplication(appId);
                    const user = await interaction.client.users.fetch(appRec.userId).catch(()=>null);
                    const dm = (msgs.deny_dm || 'Thank you for applying. Unfortunately your application was not successful at this time.');
                    try { if (user) await user.send(dm); } catch(_){}
                    const chMsg = (msgs.deny_channel || 'Application denied by {{STAFF}}.').replace('{{STAFF}}', interaction.user.username);
                    await interaction.channel.send(chMsg).catch(()=>{});
                    await func.closeTicket(interaction.client, interaction.channel, interaction.member, `Application denied`);
                    await interaction.editReply({ content: `Application denied and ticket closed.` });
                }
            } catch (e) {
                func.handle_errors(e, client, 'interactionCreate.js', 'Error processing application stage action');
            }
            return;
        }

        // Close communication ticket button
        if (interaction.customId === 'app_comm_close') {
            try {
                await interaction.deferReply({ ephemeral: true });
                const channel = interaction.channel;
                const appId = await db.get(`AppMap.channelToApp.${channel.id}`);
                if (!appId) { await interaction.editReply({ content: 'Not linked to an application.' }); return; }
                const member = interaction.member;
                const isAdmin = member.roles.cache.has(config.role_ids.application_admin_role_id) || member.roles.cache.has(config.role_ids.default_admin_role_id);
                if (!isAdmin) { await interaction.editReply({ content: 'You do not have permission to close this.' }); return; }
                
                // Get application details
                const appRec = await applications.getApplication(appId);
                if (!appRec) { await interaction.editReply({ content: 'Application not found.' }); return; }
                
                // Generate transcript for communication channel
                const transcript = require("../utils/fetchTranscript.js");
                const transcriptResult = await transcript.fetch(channel, {
                    channel: channel,
                    numberOfMessages: 99,
                    dateFormat: "MMM Do YYYY, h:mm:ss a",
                    dateLocale: "en",
                    DiscordID: appRec.userId,
                    closeReason: 'Communication session closed',
                    closedBy: member.user.username,
                    responseTime: 'N/A'
                });
                
                let savedTranscriptURL = null;
                if (transcriptResult) {
                    const fs = require('fs');
                    const { enabled, save_path, base_url } = client.config.transcript_settings;
                    if (enabled) {
                        if (!fs.existsSync(save_path)) {
                            fs.mkdirSync(save_path, { recursive: true });
                        }
                        try {
                            const filePathFull = `${save_path}/${channel.name}.full.html`;
                            fs.writeFileSync(filePathFull, transcriptResult);
                            savedTranscriptURL = `${base_url}${channel.name}.full.html`;
                            
                            // Also generate a user-facing transcript
                            const userData = await transcript.fetch(channel, {
                                channel: channel,
                                numberOfMessages: 99,
                                dateFormat: "MMM Do YYYY, h:mm:ss a",
                                dateLocale: "en",
                                DiscordID: appRec.userId,
                                filterMode: 'user',
                                closeReason: 'Communication session closed',
                                closedBy: member.user.username,
                                responseTime: 'N/A'
                            });
                            if (userData) {
                                const filePathUser = `${save_path}/${channel.name}.html`;
                                fs.writeFileSync(filePathUser, userData);
                            }
            } catch (e) {
                            console.error('Error saving transcript:', e);
                        }
                    }
                }
                
                // Send transcript to logs channel if configured
                const questionFile = require("../content/questions/application.json");
                const transcriptChannel = questionFile["transcript-channel"];
                const logs_channel = await channel.guild.channels.cache.find(x => x.id === transcriptChannel);
                if (logs_channel && transcriptResult) {
                    const file = new Discord.MessageAttachment(transcriptResult, `${channel.name}.full.html`);
                    await logs_channel.send({ 
                        content: `Communication channel transcript: ${savedTranscriptURL ? `<${savedTranscriptURL}>` : 'No URL available'}`,
                        files: [file] 
                    }).catch(e => console.error('Error sending transcript to logs:', e));
                }
                
                // Add comment to application with transcript URL
                if (savedTranscriptURL) {
                    await applications.addComment(appId, interaction.user.id, `Communication channel closed. Transcript available: ${savedTranscriptURL}`);
                } else {
                    await applications.addComment(appId, interaction.user.id, 'Communication channel closed. Transcript generation failed.');
                }
                
                // Send DM to user about closure
                try {
                    const user = await client.users.fetch(appRec.userId);
                    let reply = `Your application communication channel has been closed.\nReason: Communication session completed`;
                    if (savedTranscriptURL) {
                        const userUrl = `${client.config.transcript_settings.base_url}${channel.name}.html`;
                        reply += `\n\nView your transcript: <${userUrl}>`;
                    }
                    await user.send(reply);
                } catch (e) {
                    console.error('Error sending DM to user:', e);
                }
                
                // Remove the channel mapping
                await db.delete(`AppMap.channelToApp.${channel.id}`);
                
                // Delete the channel after a short delay
                setTimeout(async () => {
                    try {
                        await channel.delete();
                    } catch (err) {
                        console.error('Failed to delete communication channel:', err);
                    }
                }, 1000);
                
                await interaction.editReply({ content: 'Communication channel closed and transcript saved to application.' });
            } catch (e) {
                console.error('Error closing communication ticket:', e);
                await interaction.editReply({ content: 'Error closing communication channel. Please try again.' });
            }
            return;
        }

        if (interaction.customId === 'convertTicket') {
            await interaction.deferReply({ ephemeral: true });

            const handlerRaw = require("../content/handler/options.json");
            const myPins = await interaction.message.channel.messages.fetchPinned();
            const LastPin = myPins.find(m => m.embeds && m.embeds[0] && m.embeds[0].footer && typeof m.embeds[0].footer.text === 'string' && /\d{17,19}-\d+\s*\|/.test(m.embeds[0].footer.text)) || myPins.last();

            if (!LastPin || !LastPin.embeds[0]) {
                await interaction.editReply({ content: 'Could not find the ticket information. Please try again.', ephemeral: true });
                return;
            }

            // Get the user ID from the channel topic
            const userId = interaction.message.channel.topic;
            if (!userId || !/^\d{17,19}$/.test(userId)) {
                await interaction.editReply({ content: 'Could not find the user information. Please try again.', ephemeral: true });
                return;
            }

            // Get the user
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) {
                await interaction.editReply({ content: 'Could not find the user. Please try again.', ephemeral: true });
                return;
            }

            // Create a select menu with all available ticket types
            const row = new Discord.MessageActionRow()
                .addComponents(
                    new Discord.MessageSelectMenu()
                        .setCustomId('selectTicketType')
                        .setPlaceholder('Select a ticket type')
                        .addOptions(
                            Object.keys(handlerRaw.options).map(type => ({
                                label: type,
                                value: type,
                                description: `Convert to ${type} ticket`
                            }))
                        )
                );

            await interaction.editReply({ content: 'Select the new ticket type:', components: [row], ephemeral: true });
        }

        if (interaction.customId === 'selectTicketType') {
            await interaction.deferReply({ ephemeral: true });

            const newTicketType = interaction.values[0];
            const handlerRaw = require("../content/handler/options.json");
            const myPins = await interaction.message.channel.messages.fetchPinned();
            const LastPin = myPins.find(m => m.embeds && m.embeds[0] && m.embeds[0].footer && typeof m.embeds[0].footer.text === 'string' && /\d{17,19}-\d+\s*\|/.test(m.embeds[0].footer.text)) || myPins.last();

            if (!LastPin || !LastPin.embeds[0]) {
                await interaction.editReply({ content: 'Could not find the ticket information. Please try again.', ephemeral: true });
                return;
            }

            // Get the user ID from the channel topic
            const userId = interaction.message.channel.topic;
            if (!userId || !/^\d{17,19}$/.test(userId)) {
                await interaction.editReply({ content: 'Could not find the user information. Please try again.', ephemeral: true });
                return;
            }

            // Get the user
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) {
                await interaction.editReply({ content: 'Could not find the user. Please try again.', ephemeral: true });
                return;
            }

            // Get the new ticket type configuration
            const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == newTicketType.toLowerCase());
            if (!found) {
                await interaction.editReply({ content: 'Invalid ticket type selected. Please try again.', ephemeral: true });
                return;
            }

            const validOption = handlerRaw.options[found];
            const questionFilesystem = require(`../content/questions/${validOption.question_file}`);

            // Close the current ticket
            await interaction.message.channel.delete().catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));

            // Start the new ticket creation process
            return require("../utils/backbone")(client, interaction, user, newTicketType, validOption, questionFilesystem);
        }

        if (interaction.customId === 'moveticket') {
            await interaction.deferReply({ ephemeral: true });

            // Get all categories in the server
            const categories = interaction.guild.channels.cache.filter(c => c.type === 'GUILD_CATEGORY');
            
            // Get ticket categories from options.json
            const handlerRaw = require("../content/handler/options.json");
            const ticketCategories = new Set();
            
            // Collect all unique ticket categories from options
            Object.values(handlerRaw.options).forEach(option => {
                const questionFile = require(`../content/questions/${option.question_file}`);
                // Only add if ticket-category is set
                if (questionFile["ticket-category"]) {
                    ticketCategories.add(questionFile["ticket-category"]);
                }
            });

            // Filter categories to only include ticket categories
            const ticketCategoryChannels = categories.filter(category => 
                category && ticketCategories.has(category.id)
            );
            
            if (ticketCategoryChannels.size === 0) {
                await interaction.editReply({ content: 'No ticket categories found. Please make sure ticket categories are properly configured.', ephemeral: true });
                return;
            }

            // Create a select menu with only ticket categories
            const row = new Discord.MessageActionRow()
                .addComponents(
                    new Discord.MessageSelectMenu()
                        .setCustomId('selectCategory')
                        .setPlaceholder('Select a category')
                        .addOptions(
                            ticketCategoryChannels.map(category => ({
                                label: category.name,
                                value: category.id,
                                description: `Move ticket to ${category.name}`
                            }))
                        )
                );

            await interaction.editReply({ content: 'Select the category to move this ticket to:', components: [row], ephemeral: true });
        }

        if (interaction.customId === 'selectCategory') {
            await interaction.deferReply({ ephemeral: true });

            const categoryId = interaction.values[0];
            const category = interaction.guild.channels.cache.get(categoryId);

            if (!category) {
                await interaction.editReply({ content: 'Could not find the selected category. Please try again.', ephemeral: true });
                return;
            }

            // Get the current channel name and parse it
            const currentName = interaction.channel.name;
            const nameParts = currentName.split('-');
            
            // Extract server name, ticket type, and ticket number
            let serverName = null;
            let ticketNumber = null;
            let ticketTypePart = null;
            
            // Find the ticket number (it's always the last part)
            ticketNumber = nameParts[nameParts.length - 1];
            
            // If there are more than 2 parts, the first part is the server name
            if (nameParts.length > 2) {
                serverName = nameParts[0];
                // Everything between server name and ticket number is the ticket type
                ticketTypePart = nameParts.slice(1, -1).join('-');
            } else {
                // If only 2 parts, then it's just ticket type and number
                ticketTypePart = nameParts[0];
            }
            
            // Use category name as new ticket type
            const newTicketType = category.name.toLowerCase();
            
            // Create new channel name preserving the server name (if present) and ticket number
            const newName = serverName ? `${serverName}-${newTicketType}-${ticketNumber}` : `${newTicketType}-${ticketNumber}`;

            // Move the channel to the selected category and rename it
            await interaction.channel.setParent(categoryId)
                .then(async () => {
                    // Try to rename the channel after moving it
                    let renameSucceeded = true;
                    try {
                        await interaction.channel.setName(newName);
                    } catch (error) {
                        renameSucceeded = false;
                        func.handle_errors(error, client, 'interactionCreate.js', null);
                        await interaction.channel.send(
                            "⚠️ I couldn't rename this ticket channel. Please check permissions or try again later. Ticket actions will still work, but the name may be wrong."
                        ).catch(() => {});
                    }
                    // Update the pinned embed's footer to include the ticket type
                    const myPins = await interaction.channel.messages.fetchPinned();
                    const LastPin = myPins.find(m => m.embeds && m.embeds[0] && m.embeds[0].footer && typeof m.embeds[0].footer.text === 'string' && /\d{17,19}-\d+\s*\|/.test(m.embeds[0].footer.text)) || myPins.last();
                    if (LastPin && LastPin.embeds[0]) {
                        const embed = LastPin.embeds[0];
                        const footerParts = embed.footer.text.split("|");
                        const idParts = footerParts[0].trim().split('-');
                        const ticketType = embed.title.split(" | ")[0];
                        embed.setFooter({text: `${idParts[0]}-${idParts[1]} | ${ticketType} | Ticket Opened:`, iconURL: client.user.displayAvatarURL()});
                        await LastPin.edit({embeds: [embed]}).catch(e => func.handle_errors(e, client, 'interactionCreate.js', null));
                    }
                    // Delete move-related messages
                    await interaction.message.delete().catch(() => {});
                    // DM the ticket creator
                    const userId = interaction.channel.topic;
                    if (userId) {
                        const user = await client.users.fetch(userId).catch(() => null);
                        if (user) {
                            user.send(`Your ticket (${renameSucceeded ? newName : interaction.channel.name}) has been moved to ${category.name}.`).catch(() => {});
                        }
                    }
                    // Remove the ephemeral 'thinking' reply
                    await interaction.deleteReply().catch(() => {});
                    // Delete any lingering select menu or 'thinking...' messages
                    const messages = await interaction.channel.messages.fetch({ limit: 20 }).catch(() => []);
                    for (const msg of messages.values()) {
                        if (
                            msg.author.id === client.user.id &&
                            (
                                msg.components.some(row => row.components.some(comp => comp.customId === 'selectCategory')) ||
                                msg.content.includes('Brit Support is thinking...')
                            )
                        ) {
                            await msg.delete().catch(() => {});
                        }
                    }
                })
                .catch(async error => {
                    func.handle_errors(error, client, 'interactionCreate.js', null);
                    try {
                        await interaction.editReply({ content: 'Failed to move the ticket. Please try again.', ephemeral: true });
                    } catch (e) {
                        if (e?.code !== 10008) func.handle_errors(e, client, 'interactionCreate.js', 'editReply failed');
                    }
                });
        }

        if (!interaction.message || !interaction.message.guild || interaction.message.author.id != client.user.id || client.user.id == interaction.member.user.id) return;
        
        const files = readdirSync("./content/questions/");
		let valid = [];
		files.forEach(element => {
			const file = require(`../content/questions/${element}`);
			valid.push(file["post-channel"]);
		});

        if (valid.includes(interaction.message.channel.id) && ["supportaccept", "supportdeny", "supportcustom", "supportticket"].includes(interaction.customId)) {
            const split = await interaction.message.embeds[0].footer.text.split("|");
            let uniqueTicketID = split[0].trim();
            const recepientId = uniqueTicketID.split(`-`)[0];
            const ticketType = interaction.message.embeds[0].title.split(" | ")[0];

            const handlerRaw = require("../content/handler/options.json");
            const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == ticketType.toLowerCase());
            let typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
            let accessRoleIDs = typeFile["access-role-id"];
            let accepted = 0;

            // Get the member object
            const member = interaction.member;
            if (!member) {
                await interaction.reply({ content: 'Could not find member information.', ephemeral: true });
                return;
            }

            for (let role of accessRoleIDs) {
                if (member.roles.cache.find(x => x.id == role)) accepted++;
            }
            if (member.roles.cache.find(x => x.id == client.config.role_ids.default_admin_role_id)) accepted++;

            if (accepted > 0) {
                let recepient = client.users.cache.find(x => x.id == recepientId);
                if (!recepient) recepient = await client.users.fetch(recepientId).catch(() => null);
                if (!recepient) {
                    await interaction.reply({ content: `Could not find user with ID ${recepientId}.`, ephemeral: true });
                    return;
                }
                // Only call switcher if recepient is valid
                switcher(client, interaction, interaction.member.user, ticketType, interaction.customId, member, recepient, accessRoleIDs, found);
            } else {
                let role = interaction.message.guild.roles.cache.find(role => role.id === client.config.role_ids.default_admin_role_id)
                await interaction.reply({
                    content: lang.misc["incorrect-roles-for-action"] != "" ? 
                        lang.misc["incorrect-roles-for-action"].replace(`{{ROLENAME}}`, `\`${role.name}\``) : 
                        `It seems you do not have the correct roles to perform that action! You need the \`${role.name}\` role or an "access-role" if one is set!`,
                    ephemeral: true
                }).catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
                return;
            }
        } else {
            // Move the cooldown check to only run for new ticket creation
            if (!["moveticket", "selectCategory", "closeTicketModal", "CustomResponseModal"].includes(interaction.customId)) {
                await interaction.deferReply({ ephemeral: true }).catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));

                if (client.blocked_users.has(interaction.member.user.id) || client.cooldown.has(interaction.member.user.id)) {
                    await interaction.editReply({content: lang.user_errors["fast-ticket-creation"] != "" ? lang.user_errors["fast-ticket-creation"] : "You can not make another ticket that quickly!", ephemeral: true}).catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
                    return;
                }
            }

            let blacklistedRole = await interaction.message.guild.roles.fetch(client.config.role_ids.ticket_blacklisted_role_id).catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
            if (interaction.member.roles.cache.find(x => x.id == blacklistedRole)) {
                await interaction.editReply({content: lang.ticket_creation["blacklisted-user-error"] != "" ? lang.ticket_creation["blacklisted-user-error"] : "You are not allowed to use this system.", ephemeral: true}).catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
                return;
            }

            const handlerRaw = require("../content/handler/options.json");
            let validOption = ""
            let ticketType = ""
            for (let options of Object.keys(handlerRaw.options)) {

                if (handlerRaw.options[`${options}`].unique_button_identifier.toLowerCase().replace(` `,``) == interaction.customId) {
                    validOption = handlerRaw.options[`${options}`] 
                    ticketType = options
                }
            }

            if (validOption == "" || ticketType == "") return;

            const questionFilesystem = require(`../content/questions/${validOption.question_file}`);
            if (!questionFilesystem) return func.handle_errors(null, client, `interactionCreate.js`, `Missing question file for ${ticketType}. Have you changed the name or directory recently?`)



			if (questionFilesystem.needVerified === true) {

                if (!client.config.tokens.Linking_System_API_Key_Or_Secret || client.config.tokens.Linking_System_API_Key_Or_Secret == "") {
                        func.handle_errors(null, client, `interactionCreate.js`, `needVerified is enabled and Linking_System_API_Key_Or_Secret is not set in the config so could not access the API!`)
                        return interaction.editReply({content: lang.misc["api-access-denied"] != "" ? lang.misc["api-access-denied"] : `The API could not be accessed so we could not verify your accounts. Ticket Cancelled.`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
                    }
                    
                // Simple Link is 1
                if (client.config.linking_settings.linkingSystem === 1) {
                    let SteamIDGrab = await unirest.get(`${client.config.linking_settings.verify_link}/api.php?action=findByDiscord&id=${interaction.member.user.id}&secret=${client.config.tokens.Linking_System_API_Key_Or_Secret}`)
                    if (SteamIDGrab.body) {
                        if (SteamIDGrab.body?.toString) {
                            if (SteamIDGrab?.body?.toString().startsWith("7656119")) {
                                SteamID = SteamIDGrab.body
                            } else {
                                return interaction.editReply({content: lang.user_errors["verification-needed"] != "" ? lang.user_errors["verification-needed"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`).replace(`{{TICKETTYPE}}`, `\`${ticketType}\``).replace(`{{VERIFYLINK}}`, `${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}`) : `<@${interaction.member.user.id}>, you need to verify to make a '${ticketType}' ticket. ${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}'`, ephemeral: true})
                            }
                        }
                    } else {
                        func.handle_errors(null, client, `interactionCreate.js`, `Could not access API! Have you selected the correct linking system?\n\n**Linking System:** Simple Link`)
                        return interaction.editReply({content: lang.misc["api-access-denied"] != "" ? lang.misc["api-access-denied"] : `The API could not be accessed so we could not verify your accounts. Ticket Cancelled.`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
                    
                    }
    
                // Steamcord is 2
                } else if (client.config.linking_settings.linkingSystem === 2) {
                    
                    let SteamIDGrab = await unirest.get(`https://api.steamcord.io/players?discordId=${interaction.member.user.id}`).headers({'Authorization': `Bearer ${client.config.tokens.Linking_System_API_Key_Or_Secret}`, 'Content-Type': 'application/json'})
                    if (SteamIDGrab.body) {
                        if (SteamIDGrab.body.length > 0) {
                        if (SteamIDGrab.body[0]?.steamAccounts[0]?.steamId) {
                            if (SteamIDGrab.body[0]?.steamAccounts[0]?.steamId.toString().startsWith("7656119")) {
                            } else {
                                return interaction.editReply({content: lang.user_errors["verification-needed"] != "" ? lang.user_errors["verification-needed"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`).replace(`{{TICKETTYPE}}`, `\`${ticketType}\``).replace(`{{VERIFYLINK}}`, `${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}`) : `<@${interaction.member.user.id}>, you need to verify to make a '${ticketType}' ticket. ${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}'`, ephemeral: true})
                            }
                        } else {
                            return interaction.editReply({content:  lang.user_errors["no-steamid-verification-needed"] != "" ? lang.user_errors["no-steamid-verification-needed"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`).replace(`{{TICKETTYPE}}`, `\`${ticketType}\``).replace(`{{VERIFYLINK}}`, `${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}`) : `<@${interaction.member.user.id}>, no SteamID found! You need to verify to make a '${ticketType}' ticket. ${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}'`, ephemeral: true})
                    
                        }
                    } else {
                        return interaction.editReply({content: lang.user_errors["verification-needed"] != "" ? lang.user_errors["verification-needed"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`).replace(`{{TICKETTYPE}}`, `\`${ticketType}\``).replace(`{{VERIFYLINK}}`, `${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}`) : `<@${interaction.member.user.id}>, you need to verify to make a '${ticketType}' ticket. ${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}'`, ephemeral: true})
                    }
                    } else {
                        func.handle_errors(null, client, `interactionCreate.js`, `Could not access API! Have you selected the correct linking system and/or is your subscription active?\n\n**Linking System:** Steamcord`)
                        return interaction.editReply({content: lang.misc["api-access-denied"] != "" ? lang.misc["api-access-denied"] : `The API could not be accessed so we could not verify your accounts. Ticket Cancelled.`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
                    }
                    
                    // Platform Sync is 3
                } else if (client.config.linking_settings.linkingSystem === 3) {
                    
                    let SteamIDGrab = await unirest.get(`https://link.platformsync.io/api.php?id=${interaction.member.user.id}&token=${client.config.tokens.Linking_System_API_Key_Or_Secret}`)
                    if (SteamIDGrab.body) {
                        if (!SteamIDGrab.body?.Error) {
                            if (SteamIDGrab.body?.linked == true) {
                                if (SteamIDGrab.body?.steam_id) {
                                    if (SteamIDGrab.body?.steam_id?.toString().startsWith("7656119")) {
                                    } else {
                                        return interaction.editReply({content: lang.user_errors["verification-needed"] != "" ? lang.user_errors["verification-needed"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`).replace(`{{TICKETTYPE}}`, `\`${ticketType}\``).replace(`{{VERIFYLINK}}`, `${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}`) : `<@${interaction.member.user.id}>, you need to verify to make a '${ticketType}' ticket. ${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}'`, ephemeral: true})
                                    }
                                } else {
                                    return interaction.editReply({content: lang.user_errors["no-steamid-verification-needed"] != "" ? lang.user_errors["no-steamid-verification-needed"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`).replace(`{{TICKETTYPE}}`, `\`${ticketType}\``).replace(`{{VERIFYLINK}}`, `${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}`) : `<@${interaction.member.user.id}>, no SteamID found! You need to verify to make a '${ticketType}' ticket. ${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}'`, ephemeral: true})
                            
                                }
                            } else {
                                return interaction.editReply({content: lang.user_errors["verification-needed"] != "" ? lang.user_errors["verification-needed"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`).replace(`{{TICKETTYPE}}`, `\`${ticketType}\``).replace(`{{VERIFYLINK}}`, `${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}`) : `<@${interaction.member.user.id}>, you need to verify to make a '${ticketType}' ticket. ${client.config.linking_settings.verify_link === "" ? "" : `${client.config.linking_settings.verify_link}`}'`, ephemeral: true})
                            }
                        } else {
                            func.handle_errors(null, client, `interactionCreate.js`, `Could not access API! Is your API Key correct and is it a paid subscription?\n\n**Linking System:** Platform Sync`)
                            return interaction.editReply({content: lang.misc["api-access-denied"] != "" ? lang.misc["api-access-denied"] : `The API could not be accessed so we could not verify your accounts. Ticket Cancelled.`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
                        
                        }   
                    } else {
                        func.handle_errors(null, client, `interactionCreate.js`, `Could not access API! Have you selected the correct linking system?\n\n**Linking System:** Platform Sync`)
                        return interaction.editReply({content: lang.misc["api-access-denied"] != "" ? lang.misc["api-access-denied"] : `The API could not be accessed so we could not verify your accounts. Ticket Cancelled.`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
                    }
    
                }
		}

            // Skip post channel check if open-as-ticket is true
            if (!questionFilesystem["open-as-ticket"]) {
            let postchannel = await client.guilds.cache.get(client.config.channel_ids.staff_guild_id).channels.fetch(questionFilesystem["post-channel"])
            if (!postchannel) {
                await interaction.editReply({content: lang.misc["generic-error-message"] != "" ? lang.misc["generic-error-message"] : `Sorry we could not perform this action right now, the staff team have been made aware of the issue!`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));	
			    return func.handle_errors(null, client, `interactionCreate.js`, `I could not find the designated ticket creation channel for the bot, please make sure the ID is set correctly in your ticket specific config(s).\nVariable: post_channel\nTicketType: ${ticketType}`)
            }
            let maxCount = 0
            for (let eachMessage of await postchannel.messages.fetch({limit: 100})) {
                if (eachMessage.pinned) continue;
                if (eachMessage[1]?.embeds[0]?.footer?.text.includes(interaction.member.user.id)) {
                    if (eachMessage[1]?.embeds[0]?.footer?.text.toLowerCase().includes(validOption.abbreviation.toLowerCase())) {
                        maxCount++
                    }
                } 
            }

            if (maxCount >= questionFilesystem["max-active-tickets"]) {
				let errormsg = await interaction.editReply({content: lang.user_errors["too-many-pending-tickets"] != "" ? lang.user_errors["too-many-pending-tickets"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`) : `<@${interaction.member.user.id}>, you have too many tickets open, please wait for them to be resolved.`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
				return;
                }
            }

            // Get all channels from the staff guild
            const staffGuild = await client.guilds.cache.get(client.config.channel_ids.staff_guild_id);
            const allChannels = staffGuild.channels.cache;

            let filteredChannels = allChannels.filter(x => x.topic === interaction.member.user.id)
            if (filteredChannels.size >= client.config.bot_settings.max_tickets_per_user) {
                let errormsg = await interaction.editReply({content: lang.user_errors["ticket-already-open"] != "" ? lang.user_errors["ticket-already-open"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`) : `<@${interaction.member.user.id}>, you have reached your maximum limit of ${client.config.bot_settings.max_tickets_per_user} tickets. Please close some of your existing tickets before creating new ones.`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
				return;
		}

			client.cooldown.add(interaction.member.user.id);
			client.blocked_users.add(interaction.member.user.id);
			return require("../utils/backbone")(client, interaction, interaction.member.user, ticketType, validOption, questionFilesystem);

        }

        if (interaction.isModalSubmit && interaction.customId === 'moveServerModal') {
            // Retrieve context
            const ctx = client.moveTicketContext;
            if (!ctx) {
                await interaction.reply({ content: 'Move context missing. Please try again.', ephemeral: true });
                return;
            }
            const channel = await client.channels.fetch(ctx.channelId);
            const myPins = await channel.messages.fetchPinned();
            const LastPin = myPins.last();
            let embed;
            if (LastPin && LastPin.embeds[0]) {
                embed = LastPin.embeds[0];
                // Add the server field
                const serverValue = interaction.fields.getTextInputValue('serverInput');
                embed.addFields({ name: 'Server', value: serverValue });
                // Update the footer for the new ticket type
                const footerParts = embed.footer.text.split("|");
                const idParts = footerParts[0].trim().split('-');
                embed.setFooter({text: `${idParts[0]}-${idParts[1]} | ${ctx.ticketType} | Ticket Opened:`, iconURL: client.user.displayAvatarURL()});
                await LastPin.edit({embeds: [embed]}).catch(e => func.handle_errors(e, client, 'move.js', null));
            }
            // Move and rename
            let renameSucceeded = true;
            try {
                await channel.setParent(ctx.categoryId);
                await channel.setName(ctx.newName);
            } catch (error) {
                renameSucceeded = false;
                func.handle_errors(error, client, 'move.js', null);
                await channel.send("⚠️ I couldn't rename or move this ticket channel. Please check permissions or try again later. Ticket actions will still work, but the name may be wrong.").catch(() => {});
            }
            await interaction.reply({ content: `Ticket moved to ${ctx.ticketType}${renameSucceeded ? '' : ' (with errors)'}.`, ephemeral: true });
            // Clean up context
            client.moveTicketContext = undefined;
            return;
        }

        async function switcher(client, interaction, user, ticketType, customId, administratorMember, recepientMember, accessRoleIDs, found) {
            try {
                // Null checks for administratorMember and recepientMember
                if (!administratorMember || !recepientMember) {
                    await interaction.reply({ content: 'Could not find required user/member information to process this ticket action.', ephemeral: true }).catch(() => {});
                    return;
                }

                const embed = interaction.message.embeds[0];
                const handlerRaw = require("../content/handler/options.json");
                let typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
                let transcriptChannel = typeFile[`transcript-channel`];
                const logs_channel = await interaction.message.guild.channels.cache.find(x => x.id === transcriptChannel);
                const globalTicketNumber = interaction.message.embeds[0].footer.text.split("|")[0].trim();

                if (customId == "supportaccept") {

                    await interaction.deferUpdate().catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
                    embed.setAuthor({name: lang.accepted_ticket["accepted-transcript-embed-title"] != "" ? lang.accepted_ticket["accepted-transcript-embed-title"].replace(`{{ADMIN}}`, `${user.username}/${user.id}`) + `\n${embed?.author?.name}` : `Accepted by ${user.username}/${user.id} \n${embed?.author?.name}`, iconURL: user.displayAvatarURL()});
                    embed.addFields({
                        name: lang.accepted_ticket["accepted-transcript-embed-response-title"] != "" ? lang.accepted_ticket["accepted-transcript-embed-response-title"] : `Response Time`,
                        value: `\`\`\`${await func.convertMsToTime(Date.now() - interaction.message.embeds[0].timestamp)}\`\`\``,
                        inline: true
                    });

						if (logs_channel) {
							let messageID = await logs_channel.send({content: `<@${recepientMember.id}>`, embeds: [embed] }).catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null) });
                            await db.set(`PlayerStats.${recepientMember.id}.ticketLogs.${globalTicketNumber}.transcriptLink`, `https://discord.com/channels/${interaction.message.guild.id}/${logs_channel.id}/${messageID.id}`)
                    }
                        await db.set(`PlayerStats.${recepientMember.id}.ticketLogs.${globalTicketNumber}.firstActionTime`, Date.now() / 1000)
                        await db.set(`PlayerStats.${recepientMember.id}.ticketLogs.${globalTicketNumber}.firstActionTimeAdminName`, user.username)
                        await db.set(`PlayerStats.${recepientMember.id}.ticketLogs.${globalTicketNumber}.firstActionTimeAdminID`, user.id)
                        await func.closeDataAddDB(recepientMember.id, globalTicketNumber, `Accept Ticket`, user.username, user.id, Date.now() / 1000, `N/A`);
                        try { 
							metrics.ticketClosed(ticketType, user.id); 
							metrics.staffAction('accept', ticketType, user.id, user.username); 
						} catch (_) {}
                        await interaction.message.delete().catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null)});
					
						let reply = `Your active ${ticketType} ticket was read and accepted. Thank you.`;
						if (found) {
							const handlerRaw = require("../content/handler/options.json");
							let file = require(`../content/questions/${handlerRaw.options[found].question_file}`);
							reply = file["accept-message"];
						} else {
                            func.handle_errors(null, client, `interactionCreate.js`, `Could not accept/deny ticket correctly. Could not find files for that ticket type (${ticketType})`)
						}

                        func.updateResponseTimes(interaction.message.embeds[0].timestamp, Date.now(), ticketType, "Accepted")

                        await func.staffStats(ticketType, `accepted`, user.id);
                        

					let endresponse = new Discord.MessageEmbed()
                    .setTitle(lang.accepted_ticket["player-accepted-embed-title"] != "" ? 
                        lang.accepted_ticket["player-accepted-embed-title"]
                            .replace(`{{TICKETTYPE}}`, ticketType)
                            .replace(`{{TICKETNUMBER}}`, interaction.message.embeds[0].title.split('#')[1]) : 
                        `Your ${ticketType} ticket has been closed with the following response:`)
					.setDescription(`\`\`\`${reply}\`\`\``)
					.setColor(client.config.bot_settings.main_color)
					.setFooter({text: client.user.username, iconURL: client.user.displayAvatarURL()})

					await recepientMember.send({embeds: [endresponse]}).catch(async (err) => {

						if (err.message === `Cannot send messages to this user`) {
							let errormsg = await interaction.message.channel.send(`${recepientMember.username}/${recepientMember.id} has their DMs closed, could not send close reason to them!`).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
							setTimeout(async () => {
								return await errormsg.delete().catch(e => func.handle_errors(e, client, `interactionCreate.js`, null))
							}, client.config.timeouts.user_error_message_timeout_in_seconds * 1000);
						} else {func.handle_errors(err, client, `interactionCreate.js`, null)}
					})

                } else if (customId == "supportdeny") {

                    await interaction.deferUpdate().catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
                    embed.setAuthor({name: lang.denied_ticket["denied-transcript-embed-title"] != "" ? lang.denied_ticket["denied-transcript-embed-title"].replace(`{{ADMIN}}`, `${user.username}/${user.id}`) + `\n${embed?.author.name}`: `Denied by ${user.username}/${user.id} \n${embed?.author.name}`, iconURL: user.displayAvatarURL()});
                    embed.addFields({
                        name: lang.denied_ticket["denied-transcript-embed-response-title"] != "" ? lang.denied_ticket["denied-transcript-embed-response-title"] : `Response Time`,
                        value: `\`\`\`${await func.convertMsToTime(Date.now() - interaction.message.embeds[0].timestamp)}\`\`\``,
                        inline: true
                    });

						if (logs_channel) {
							let messageID = await logs_channel.send({content: `<@${recepientMember.id}>`, embeds: [embed] }).catch(e => { func.handle_errors(e, client, `interactionCreate.js`, null)});
                            await db.set(`PlayerStats.${recepientMember.id}.ticketLogs.${globalTicketNumber}.transcriptLink`, `https://discord.com/channels/${interaction.message.guild.id}/${logs_channel.id}/${messageID.id}`)
                    }
                        await db.set(`PlayerStats.${recepientMember.id}.ticketLogs.${globalTicketNumber}.firstActionTime`, Date.now() / 1000)
                        await db.set(`PlayerStats.${recepientMember.id}.ticketLogs.${globalTicketNumber}.firstActionTimeAdminName`, user.username)
                        await db.set(`PlayerStats.${recepientMember.id}.ticketLogs.${globalTicketNumber}.firstActionTimeAdminID`, user.id)
                        await func.closeDataAddDB(recepientMember.id, globalTicketNumber, `Deny Ticket`, user.username, user.id, Date.now() / 1000, `N/A`);
                        try { 
							metrics.ticketClosed(ticketType, user.id); 
							metrics.staffAction('deny', ticketType, user.id, user.username); 
						} catch (_) {}
                        await interaction.message.delete().catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null)});
					
						let reply = `Your active ${ticketType} ticket was denied.`;
						if (found) {
							const handlerRaw = require("../content/handler/options.json");
							let file = require(`../content/questions/${handlerRaw.options[found].question_file}`);
							reply = file["deny-message"];
						} else {
                            func.handle_errors(null, client, `interactionCreate.js`, `Could not accept/deny ticket correctly. Could not find files for that ticket type (${ticketType})`)
						}
	
                        func.updateResponseTimes(interaction.message.embeds[0].timestamp, Date.now(), ticketType, "Denied")

                        await func.staffStats(ticketType, `denied`, user.id);
                        

					let endresponse = new Discord.MessageEmbed()
                    .setTitle(lang.denied_ticket["player-denied-embed-title"] != "" ? 
                        lang.denied_ticket["player-denied-embed-title"]
                            .replace(`{{TICKETTYPE}}`, ticketType)
                            .replace(`{{TICKETNUMBER}}`, interaction.message.embeds[0].title.split('#')[1]) : 
                        `Your ${ticketType} ticket has been closed with the following response:`)
					.setDescription(`\`\`\`${reply}\`\`\``)
					.setColor(client.config.bot_settings.main_color)
					.setFooter({text: client.user.username, iconURL: client.user.displayAvatarURL()})

					await recepientMember.send({embeds: [endresponse]}).catch(async (err) => {

						if (err.message === `Cannot send messages to this user`) {
							let errormsg = await interaction.message.channel.send(`${recepientMember.username}/${recepientMember.id} has their DMs closed, could not send close reason to them!`).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
							setTimeout(async () => {
								return await errormsg.delete().catch(e => func.handle_errors(e, client, `interactionCreate.js`, null))
							}, client.config.timeouts.user_error_message_timeout_in_seconds * 1000);
						} else {func.handle_errors(err, client, `interactionCreate.js`, null)}
					})

                } else if (customId == "supportcustom") {

                    let accepted = 0
	
                    for (let role of accessRoleIDs) {
                    if (interaction.member.roles.cache.find(x => x.id == role)) accepted++
                    }
                    if (interaction.member.roles.cache.find(x => x.id == client.config.role_ids.default_admin_role_id)) accepted++
        
                    if (accepted > 0) {

                        const customResponseModal = new Discord.Modal()
                            .setCustomId('CustomResponseModal')
                            .setTitle(lang.custom_reply_close_ticket["close-modal-title"] != "" ? lang.custom_reply_close_ticket["close-modal-title"] : 'Custom Reply');
                        const customResponseReason = new Discord.TextInputComponent()
                            .setCustomId('customresponse')
                            .setLabel(lang.custom_reply_close_ticket["close-modal-reason-title"] != "" ? lang.custom_reply_close_ticket["close-modal-reason-title"] : "What would you like to say to the user?")
                            .setStyle('PARAGRAPH');
                        const firstActionRow = new Discord.MessageActionRow().addComponents(customResponseReason);
                        customResponseModal.addComponents(firstActionRow);
                        return await interaction.showModal(customResponseModal);
                        
                    }

                } else if (customId == "supportticket") {

                    await interaction.deferUpdate().catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));

                    if (found) {
                        const handlerRaw = require("../content/handler/options.json");
                        questionFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
                    }
                }
            } catch (err) {
                func.handle_errors(err, client, `interactionCreate.js`, null);
            }
        }
    } catch (err) {
        func.handle_errors(err, client, `interactionCreate.js`, null);
    }
}
