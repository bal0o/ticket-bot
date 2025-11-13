// Environment variables are now loaded from config.json
const config = require("../config/config.json");
const transcript = require("../utils/fetchTranscript.js");
const { readdirSync } = require("fs");
const Discord = require("discord.js");
const unirest = require("unirest");
const func = require("../utils/functions.js");
const lang = require("../content/handler/lang.json");
const { createDB } = require('../utils/mysql')
const db = createDB();
const metrics = require('../utils/metrics');
const logger = require('../utils/logger');
const applications = require('../utils/applications');
const perms = require('../utils/permissions');

// Initialize commands collection if it doesn't exist
if (!Discord.Collection.prototype.commands) {
    Discord.Collection.prototype.commands = new Discord.Collection();
}

module.exports = async function (client, interaction) {
    // Minimal interaction visibility without metrics noise
    try {
        const kind = interaction.isCommand() ? 'command' : (interaction.isButton() ? 'button' : (interaction.isModalSubmit ? 'modal' : (interaction.isSelectMenu ? 'select' : 'other')));
        const id = interaction.isCommand() ? interaction.commandName : (interaction.customId || 'n/a');
        logger.event('Interaction', { kind, id, userId: interaction.user?.id, channelId: interaction.channelId });
    } catch (_) {}
    if (interaction.isButton() && ['prev_page', 'next_page'].includes(interaction.customId)) {
        return;
    }
    // Initialize commands collection if it doesn't exist
    if (!client.commands) {
        client.commands = new Discord.Collection();
    }

    try {
        // Removed status init here to avoid delaying interaction ack; handled in ready.js

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
            try { await interaction.deferReply(); } catch (e) { if (e && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, `interactionCreate.js`, null); }

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
                try { await interaction.deferReply({ ephemeral: true }); } catch (e) { if (e && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, 'interactionCreate.js', 'deferReply failed for closeTicketModal'); }
                
                const channel = interaction.channel;
                if (!channel) {
                    try { await interaction.editReply({ content: 'Could not find the ticket channel.', ephemeral: true }); } catch(_) {}
                    return;
                }
                
                const reason = interaction.fields.getTextInputValue('closeReason') || 'No Reason Provided.';
                let closed = false;
                try {
                    const result = await Promise.race([
                        (async () => { await func.closeTicket(client, channel, interaction.member, reason); return 'done'; })(),
                        new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))
                    ]);
                    closed = result === 'done';
                } catch (e) {
                    func.handle_errors(e, client, 'interactionCreate.js', 'Error running closeTicket');
                }
                try {
                    const payload = { content: closed ? 'Your ticket has been closed.' : 'Closing ticket... this may take a few seconds. You can dismiss this.', ephemeral: true };
                    if (interaction.deferred || interaction.replied) {
                        await interaction.editReply(payload);
                    } else {
                        await interaction.reply(payload);
                    }
                } catch (e) {
                    // Ignore Unknown Message (10008) or Unknown Interaction (10062)
                    if (e && e.code !== 10008 && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, 'interactionCreate.js', 'reply/editReply failed after close');
                }
            } catch (error) {
                func.handle_errors(error, client, 'interactionCreate.js', 'Error handling close ticket modal');
                try {
                    await interaction.editReply({ content: 'An error occurred while closing the ticket. Please try again.', ephemeral: true });
                } catch (e) {
                    // If we can't edit the reply, the interaction has probably timed out
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
                
                    // Transcript link stored in MySQL tickets table via transcript_url - no need for separate PlayerStats entry
                };
                // firstActionTime metadata removed - not critical, not stored in tickets table schema
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
                    // Update channel name to remove -claimed (tolerate rate limits)
                    try {
                        if (interaction.channel.name.endsWith('-claimed')) {
                            await interaction.channel.setName(interaction.channel.name.replace(/-claimed$/, '')).catch(() => {});
                        }
                    } catch (_) {}
                    // Update button label to Claim Ticket (always attempt)
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
					const scopeClaim = (function(){ try { const handlerRaw = require("../content/handler/options.json"); const tf = require(`../content/questions/${handlerRaw.options[displayType || ticketType].question_file}`); return tf && tf.internal ? 'internal' : 'public'; } catch(_) { return 'public'; } })();
					metrics.ticketClaimed(ticketType, scopeClaim);
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

                // Rename channel to append -claimed (tolerate rate limits)
                try {
                    if (!interaction.channel.name.endsWith('-claimed')) {
                        await interaction.channel.setName(`${interaction.channel.name}-claimed`).catch(() => {});
                    }
                } catch (_) {}
                // Update button label to Unclaim (always attempt)
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
                try { await interaction.deferReply({ ephemeral: true }); } catch (e) { if (e && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, 'interactionCreate.js', 'deferReply failed for app_next_stage/deny'); }
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
                    try {
                        await interaction.editReply({ content: `Advanced to ${nextStage} and ticket closed.` });
                    } catch (e) {
                        if (e && e.code === 10008) {
                            func.handle_errors(null, client, 'interactionCreate.js', 'Edit reply skipped: Unknown Message (10008). The interaction response was likely cleaned up or expired.');
                        } else {
                            func.handle_errors(e, client, 'interactionCreate.js', null);
                        }
                    }
                } else {
                    await applications.deny(appId, interaction.user.id, 'Denied via ticket');
                    const appRec = await applications.getApplication(appId);
                    const user = await interaction.client.users.fetch(appRec.userId).catch(()=>null);
                    const dm = (msgs.deny_dm || 'Thank you for applying. Unfortunately your application was not successful at this time.');
                    try { if (user) await user.send(dm); } catch(_){}
                    const chMsg = (msgs.deny_channel || 'Application denied by {{STAFF}}.').replace('{{STAFF}}', interaction.user.username);
                    await interaction.channel.send(chMsg).catch(()=>{});
                    await func.closeTicket(interaction.client, interaction.channel, interaction.member, `Application denied`);
                    try {
                        await interaction.editReply({ content: `Application denied and ticket closed.` });
                    } catch (e) {
                        if (e && e.code === 10008) {
                            func.handle_errors(null, client, 'interactionCreate.js', 'Edit reply skipped: Unknown Message (10008). The interaction response was likely cleaned up or expired.');
                        } else {
                            func.handle_errors(e, client, 'interactionCreate.js', null);
                        }
                    }
                }
            } catch (e) {
                func.handle_errors(e, client, 'interactionCreate.js', 'Error processing application stage action');
            }
            return;
        }

        // Close communication ticket button
        if (interaction.customId === 'app_comm_close') {
            try {
                try { await interaction.deferReply({ ephemeral: true }); } catch (e) { if (e && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, 'interactionCreate.js', 'deferReply failed for app_comm_close'); }
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
                // Remove from AppMap.userToChannels index
                try {
                    const appId = await db.get(`AppMap.channelToApp.${channel.id}`);
                    if (appId) {
                        const appRec2 = await applications.getApplication(appId);
                        if (appRec2 && appRec2.userId) {
                            const key = `AppMap.userToChannels.${appRec2.userId}`;
                            const arr = (await db.get(key)) || [];
                            const filtered = arr.filter(cid => cid !== channel.id);
                            await db.set(key, filtered);
                        }
                    }
                } catch (_) {}
                
                await interaction.editReply({ content: 'Communication channel closed and transcript saved to application.' });
            } catch (e) {
                console.error('Error closing communication ticket:', e);
                await interaction.editReply({ content: 'Error closing communication channel. Please try again.' });
            }
            return;
        }

        if (interaction.customId === 'convertTicket') {
            try { await interaction.deferReply({ ephemeral: true }); } catch (e) { if (e && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, 'interactionCreate.js', 'deferReply failed for convertTicket'); }

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
            try { await interaction.deferReply({ ephemeral: true }); } catch (e) { if (e && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, 'interactionCreate.js', 'deferReply failed for selectTicketType'); }

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
            try {
                await interaction.deferReply({ ephemeral: true });
            } catch (e) {
                // Tolerate expired/unknown interaction to avoid noisy errors
                if (e && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, 'interactionCreate.js', 'deferReply failed for moveticket');
            }

            const handlerRaw = require("../content/handler/options.json");
            // Build move options from configured ticket types that have a valid ticket-category present in the guild
            const typeOptions = [];
            for (const typeKey of Object.keys(handlerRaw.options)) {
                try {
                    const qf = require(`../content/questions/${handlerRaw.options[typeKey].question_file}`);
                    const categoryId = qf["ticket-category"];
                    if (!categoryId) continue;
                    const cat = interaction.guild.channels.cache.get(categoryId);
                    if (!cat || cat.type !== 'GUILD_CATEGORY') continue;
                    typeOptions.push({ typeKey, categoryName: cat.name, categoryId });
                } catch (_) {}
            }

            if (typeOptions.length === 0) {
                await interaction.editReply({ content: 'No valid ticket types found with configured categories. Please check options and question files.', ephemeral: true });
                return;
            }

            // Create a select menu for ticket types (not raw categories)
            const row = new Discord.MessageActionRow()
                .addComponents(
                    new Discord.MessageSelectMenu()
                        .setCustomId('selectMoveType')
                        .setPlaceholder('Select a ticket type')
                        .addOptions(
                            typeOptions.map(opt => ({
                                label: opt.typeKey,
                                value: opt.typeKey,
                                description: `Move to ${opt.typeKey} (${opt.categoryName})`
                            }))
                        )
                );

            await interaction.editReply({ content: 'Select the ticket type to move this ticket to:', components: [row], ephemeral: true });
        }

        if (interaction.customId === 'selectMoveType') {
            try { await interaction.deferReply({ ephemeral: true }); } catch (e) { if (e && e.code !== 10062 && e.code !== 40060) func.handle_errors(e, client, 'interactionCreate.js', 'deferReply failed for selectMoveType'); }

            const typeKey = interaction.values[0];
            const handlerRaw = require("../content/handler/options.json");
            const opt = handlerRaw.options[typeKey];
            if (!opt) { await interaction.editReply({ content: 'Invalid ticket type selected.', ephemeral: true }); return; }
            const qf = require(`../content/questions/${opt.question_file}`);
            const categoryId = qf["ticket-category"]; 
            const category = categoryId ? interaction.guild.channels.cache.get(categoryId) : null;
            if (!category || category.type !== 'GUILD_CATEGORY') {
                await interaction.editReply({ content: 'Configured category for that type was not found. Please check configuration.', ephemeral: true });
                return;
            }

            // Get the current channel name and parse it
            const currentName = interaction.channel.name;
            const nameParts = currentName.split('-');
            let serverName = null;
            let ticketNumber = nameParts[nameParts.length - 1];
            if (nameParts.length > 2) serverName = nameParts[0];

            // Use options key for display; slug for channel name
            const displayType = typeKey.trim();
            const slugType = displayType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            const newName = serverName ? `${serverName}-${slugType}-${ticketNumber}` : `${slugType}-${ticketNumber}`;

            await interaction.channel.setParent(categoryId)
                .then(async () => {
                    let renameSucceeded = true;
                    try {
                        await interaction.channel.setName(newName);
                        const overwrites = perms.buildPermissionOverwritesForTicketType({ client, guild: interaction.guild, ticketType: displayType });
                        if (Array.isArray(overwrites) && overwrites.length > 0) await interaction.channel.permissionOverwrites.set(overwrites).catch(()=>{});
                    } catch (error) {
                        renameSucceeded = false;
                        func.handle_errors(error, client, 'interactionCreate.js', null);
                        await interaction.channel.send("⚠️ I couldn't rename this ticket channel. Please check permissions or try again later. Ticket actions will still work, but the name may be wrong.").catch(() => {});
                    }

                    // Update pinned embed title/footer and DB
                    const myPins = await interaction.channel.messages.fetchPinned();
                    const LastPin = myPins.find(m => m.embeds && m.embeds[0] && m.embeds[0].footer && typeof m.embeds[0].footer.text === 'string' && /\d{17,19}-\d+\s*\|/.test(m.embeds[0].footer.text)) || myPins.last();
                    if (LastPin && LastPin.embeds[0]) {
                        const embed = LastPin.embeds[0];
                        try { embed.setTitle(`${displayType} #${ticketNumber}`); } catch (_) {}
                        const footerParts = embed.footer.text.split('|');
                        const idParts = footerParts[0].trim().split('-');
                        embed.setFooter({ text: `${idParts[0]}-${idParts[1]} | ${displayType} | Ticket Opened:`, iconURL: client.user.displayAvatarURL() });
                        await LastPin.edit({ embeds: [embed] }).catch(e => func.handle_errors(e, client, 'interactionCreate.js', null));
                        // Update ticket type in MySQL tickets table (PlayerStats removed)
                        try { 
                            if (idParts[0] && idParts[1] && typeof db.query === 'function') {
                                await db.query(
                                    'UPDATE tickets SET ticket_type = ? WHERE user_id = ? AND ticket_id = ?',
                                    [displayType, idParts[0], idParts[1]]
                                );
                            }
                        } catch (_) {}
                    }

                    // Staff ping for target type
                    try {
                        const pingRoleIDs = Array.isArray(qf['ping-role-id']) ? qf['ping-role-id'].filter(Boolean) : [];
                        if (pingRoleIDs.length > 0) {
                            const tags = pingRoleIDs.map(id => `<@&${id}>`).join(' ');
                            await interaction.channel.send({ content: `${tags}\nTicket moved to ${displayType}.`, allowedMentions: { parse: [], roles: pingRoleIDs } }).catch(() => {});
                        }
                    } catch (_) {}

                    await interaction.message.delete().catch(() => {});
                    const topicUser = interaction.channel.topic;
                    if (topicUser) {
                        const user = await client.users.fetch(topicUser).catch(() => null);
                        if (user) user.send(`Your ticket (${renameSucceeded ? newName : interaction.channel.name}) has been moved to ${displayType}.`).catch(() => {});
                    }
                    await interaction.deleteReply().catch(() => {});
                })
                .catch(async error => {
                    func.handle_errors(error, client, 'interactionCreate.js', null);
                    try { await interaction.editReply({ content: 'Failed to move the ticket. Please try again.', ephemeral: true }); } catch (e) { if (e?.code !== 10008) func.handle_errors(e, client, 'interactionCreate.js', 'editReply failed'); }
                });
        }

        if (interaction.customId === 'ticketclose') {
            try {
                if (!interaction.message || !interaction.message.guild || interaction.message.author.id != client.user.id || client.user.id == interaction.member.user.id) return;
                if (interaction.message.channel?.type === "GUILD_PUBLIC_THREAD" || interaction.message.channel?.type === "DM" || interaction.message.channel?.type === "GUILD_PRIVATE_THREAD") return func.handle_errors(null, client, `interactionCreate.js`, `Message channel type is a thread for channel ${interaction.channel.name}(${interaction.channel.id}). I can not close a thread as it is not an official ticket channel.`)
                if (!interaction.message.channel.topic) return func.handle_errors(null, client, `interactionCreate.js`, `The description for the channel has been changed and I can not recognise who to send responses to anymore. Channel: ${interaction.channel.name}(${interaction.channel.id}).`)

                const handlerRaw = require("../content/handler/options.json");
                const myPins = await interaction.channel.messages.fetchPinned();
                const LastPin = myPins.find(m => m.embeds && m.embeds[0] && m.embeds[0].footer && typeof m.embeds[0].footer.text === 'string' && /\d{17,19}-\d+\s*\|/.test(m.embeds[0].footer.text)) || myPins.last();
                if (!LastPin || !LastPin.embeds[0]) return func.handle_errors(null, client, `interactionCreate.js`, `Can not find the pinned embed. Please make sure the initial embed is pinned for me to grab data. Channel: ${interaction.channel.name}(${interaction.channel.id}).`)

                let ticketTypeClose = LastPin.embeds[0].title.split(" #")[0]
                const foundClose = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == ticketTypeClose.toLowerCase());
                let typeFile = require(`../content/questions/${handlerRaw.options[foundClose].question_file}`);
                let accessRoleIDs = typeFile["access-role-id"] || [];
                let accepted = 0;
                for (let role of accessRoleIDs) {
                    if (interaction.member.roles.cache.find(x => x.id == role)) accepted++
                }
                if (interaction.member.roles.cache.find(x => x.id == client.config.role_ids.default_admin_role_id)) accepted++
                if (accepted === 0) {
                    let role = interaction.message.guild.roles.cache.find(role => role.id === client.config.role_ids.default_admin_role_id)
                    await interaction.reply({content: lang.misc["incorrect-roles-for-action"] != "" ? lang.misc["incorrect-roles-for-action"].replace(`{{ROLENAME}}`, `\`${role?.name || 'Admin'}\``) : `It seems you do not have the correct roles to perform that action! You need the \`${role?.name || 'Admin'}\` role or an "access-role" if one is set!`, ephemeral: true}).catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
                    return;
                }
                // Claim enforcement: only claimer (or bypass) can close when restricted
                try {
                    if (client.config?.claims?.enabled && client.config?.claims?.restrict_to_claimer) {
                        const claim = (client.claims && client.claims.get(interaction.channel.id)) || await db.get(`Claims.${interaction.channel.id}`);
                        if (claim && claim.userId && claim.userId !== interaction.user.id) {
                            const bypassRoles = new Set((client.config?.claims?.role_bypass_ids || []).concat([client.config.role_ids.default_admin_role_id].filter(Boolean)));
                            const hasBypass = interaction.member.roles.cache.some(r => bypassRoles.has(r.id));
                            if (!hasBypass) {
                                await interaction.reply({ content: `This ticket is claimed by <@${claim.userId}>.`, ephemeral: true }).catch(() => {});
                                return;
                            }
                        }
                    }
                } catch (_) {}

                // Show close ticket modal
                const closeTicketModal = new Discord.Modal()
                    .setCustomId('closeTicketModal')
                    .setTitle(lang.close_ticket["close-modal-title"] != "" ? lang.close_ticket["close-modal-title"] : 'Close Ticket');
                const closeReason = new Discord.TextInputComponent()
                    .setCustomId('closeReason')
                    .setLabel(lang.close_ticket["close-modal-reason-title"] != "" ? lang.close_ticket["close-modal-reason-title"] : 'Reason for closing')
                    .setStyle('PARAGRAPH')
                    .setRequired(true);
                const firstActionRow = new Discord.MessageActionRow().addComponents(closeReason);
                closeTicketModal.addComponents(firstActionRow);
                await interaction.showModal(closeTicketModal);
            } catch (e) {
                // Ignore expired/unknown interaction tokens when attempting to show modal
                if (!e || (e.code !== 10062 && e.code !== 40060)) func.handle_errors(e, client, 'interactionCreate.js', 'Error preparing close modal');
            }
            return;
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
                // Guard against double-defer to avoid INTERACTION_ALREADY_REPLIED
                if (!interaction.deferred && !interaction.replied) {
                    try {
                        await interaction.deferReply({ ephemeral: true });
                    } catch (err) {
                        // Only log unexpected errors
                        const msg = (err && (err.code || err.message || err.name || "")).toString();
                        if (!/INTERACTION_ALREADY_REPLIED/i.test(msg)) {
                            func.handle_errors(err, client, `interactionCreate.js`, null);
                        }
                    }
                }

                if (client.blocked_users.has(interaction.member.user.id) || client.cooldown.has(interaction.member.user.id)) {
                    const payload = { content: lang.user_errors["fast-ticket-creation"] != "" ? lang.user_errors["fast-ticket-creation"] : "You can not make another ticket that quickly!", ephemeral: true };
                    if (interaction.deferred) {
                        await interaction.editReply(payload).catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
                    } else {
                        await interaction.reply(payload).catch(err => func.handle_errors(err, client, `interactionCreate.js`, null));
                    }
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

            // Enforce per-user ticket limit only for public tickets (bypass for staff)
            if (!questionFilesystem.internal) {
			// Determine if the requester is staff/admin per config.web roles or default admin role
			const staffRoleIds = new Set(((client.config && client.config.web && client.config.web.roles && client.config.web.roles.staff_role_ids) || []).filter(Boolean));
			const adminRoleIds = new Set(((client.config && client.config.web && client.config.web.roles && client.config.web.roles.admin_role_ids) || []).filter(Boolean));
			const defaultAdminRoleId = client.config && client.config.role_ids ? client.config.role_ids.default_admin_role_id : '';
			const isStaffUser = interaction.member.roles.cache.some(r => adminRoleIds.has(r.id) || staffRoleIds.has(r.id) || (defaultAdminRoleId && r.id === defaultAdminRoleId));

			if (!isStaffUser) {
				// Get fresh channels (not just cache) to ensure accurate count
				const staffGuild = await client.guilds.fetch(client.config.channel_ids.staff_guild_id);
				const allChannels = await staffGuild.channels.fetch();
				
				// Filter to only text channels with topic matching user ID
				let candidateChannels = allChannels.filter(x => 
					x.type === 'GUILD_TEXT' && 
					x.topic === interaction.member.user.id
				);
				
				// Cross-reference with database to only count channels for open tickets
				// Channel names are in format: [server-]tickettype-#### or tickettype-####
				let openTicketCount = 0;
				if (candidateChannels.size > 0 && typeof db.query === 'function') {
					try {
						// Get all open tickets for this user from database
						const [openTicketsRows] = await db.query(
							`SELECT ticket_id FROM tickets 
							WHERE user_id = ? 
							AND (close_time IS NULL AND close_type IS NULL AND transcript_url IS NULL)`,
							[String(interaction.member.user.id)]
						);
						const openTicketIds = new Set(openTicketsRows.map(row => String(row.ticket_id)));
						
						// Only count channels that correspond to open tickets
						for (const channel of candidateChannels.values()) {
							// Extract ticket ID from channel name (last part after last '-')
							const nameParts = channel.name.split('-');
							if (nameParts.length > 0) {
								const ticketId = nameParts[nameParts.length - 1];
								// Check if this ticket ID exists in the open tickets set
								if (openTicketIds.size === 0) {
									// No open tickets in DB; stop counting further
									openTicketCount = 0;
									break;
								}
								if (openTicketIds.has(ticketId)) {
									openTicketCount++;
								}
							}
						}
					} catch (dbError) {
						// If database check fails, fall back to channel count (original behavior)
						func.handle_errors(dbError, client, 'interactionCreate.js', 'Error checking open tickets in database, falling back to channel count');
						openTicketCount = candidateChannels.size;
					}
				} else {
					// Fallback to channel count if no database or no candidate channels
					openTicketCount = candidateChannels.size;
				}
				
				if (openTicketCount >= client.config.bot_settings.max_tickets_per_user) {
					let errormsg = await interaction.editReply({content: lang.user_errors["ticket-already-open"] != "" ? lang.user_errors["ticket-already-open"].replace(`{{USER}}`, `<@${interaction.member.user.id}>`) : `<@${interaction.member.user.id}>, you have reached your maximum limit of ${client.config.bot_settings.max_tickets_per_user} tickets. Please close some of your existing tickets before creating new ones.`, ephemeral: true}).catch(e => func.handle_errors(e, client, `interactionCreate.js`, null));
					return;
				}
			}
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

                    try { await interaction.deferUpdate(); } catch (err) { if (err && err.code !== 10062 && err.code !== 40060) func.handle_errors(err, client, `interactionCreate.js`, null); }
                    embed.setAuthor({name: lang.accepted_ticket["accepted-transcript-embed-title"] != "" ? lang.accepted_ticket["accepted-transcript-embed-title"].replace(`{{ADMIN}}`, `${user.username}/${user.id}`) + `\n${embed?.author?.name}` : `Accepted by ${user.username}/${user.id} \n${embed?.author?.name}`, iconURL: user.displayAvatarURL()});
                    embed.addFields({
                        name: lang.accepted_ticket["accepted-transcript-embed-response-title"] != "" ? lang.accepted_ticket["accepted-transcript-embed-response-title"] : `Response Time`,
                        value: `\`\`\`${await func.convertMsToTime(Date.now() - interaction.message.embeds[0].timestamp)}\`\`\``,
                        inline: true
                    });

						if (logs_channel) {
							let messageID = await logs_channel.send({content: `<@${recepientMember.id}>`, embeds: [embed] }).catch(e => {func.handle_errors(e, client, `interactionCreate.js`, null) });
                            // Transcript link stored in MySQL tickets table via transcript_url - no need for separate PlayerStats entry
                    }
                        // firstActionTime metadata removed - not critical, not stored in tickets table schema
                        await func.closeDataAddDB(recepientMember.id, globalTicketNumber, `Accept Ticket`, user.username, user.id, Date.now() / 1000, `N/A`);
                        try { 
							const scopeAccept = (function(){ try { const handlerRaw = require("../content/handler/options.json"); const tf = require(`../content/questions/${handlerRaw.options[found].question_file}`); return tf && tf.internal ? 'internal' : 'public'; } catch(_) { return 'public'; } })();
							metrics.ticketClosed(ticketType, user.id, user.username, scopeAccept); 
							metrics.staffAction('accept', ticketType, user.id, user.username, scopeAccept); 
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

                    try { await interaction.deferUpdate(); } catch (err) { if (err && err.code !== 10062 && err.code !== 40060) func.handle_errors(err, client, `interactionCreate.js`, null); }
                    embed.setAuthor({name: lang.denied_ticket["denied-transcript-embed-title"] != "" ? lang.denied_ticket["denied-transcript-embed-title"].replace(`{{ADMIN}}`, `${user.username}/${user.id}`) + `\n${embed?.author.name}`: `Denied by ${user.username}/${user.id} \n${embed?.author.name}`, iconURL: user.displayAvatarURL()});
                    embed.addFields({
                        name: lang.denied_ticket["denied-transcript-embed-response-title"] != "" ? lang.denied_ticket["denied-transcript-embed-response-title"] : `Response Time`,
                        value: `\`\`\`${await func.convertMsToTime(Date.now() - interaction.message.embeds[0].timestamp)}\`\`\``,
                        inline: true
                    });

						if (logs_channel) {
							let messageID = await logs_channel.send({content: `<@${recepientMember.id}>`, embeds: [embed] }).catch(e => { func.handle_errors(e, client, `interactionCreate.js`, null)});
                            // Transcript link stored in MySQL tickets table via transcript_url - no need for separate PlayerStats entry
                    }
                        // firstActionTime metadata removed - not critical, not stored in tickets table schema
                        await func.closeDataAddDB(recepientMember.id, globalTicketNumber, `Deny Ticket`, user.username, user.id, Date.now() / 1000, `N/A`);
                        try { 
							const scopeDeny = (function(){ try { const handlerRaw = require("../content/handler/options.json"); const tf = require(`../content/questions/${handlerRaw.options[found].question_file}`); return tf && tf.internal ? 'internal' : 'public'; } catch(_) { return 'public'; } })();
							metrics.ticketClosed(ticketType, user.id, user.username, scopeDeny); 
							metrics.staffAction('deny', ticketType, user.id, user.username, scopeDeny); 
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

                    try { await interaction.deferUpdate(); } catch (err) { if (err && err.code !== 10062 && err.code !== 40060) func.handle_errors(err, client, `interactionCreate.js`, null); }

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
