const Discord = require("discord.js");
const messageId = require("../config/messageid.json");
const fs = require("fs");
const func = require("../utils/functions.js");
const {QuickDB} = require("quick.db")

module.exports = async function (client, message) {
    // Initialize the ticket status
    await func.updateTicketStatus(client);
    
    // Wait a bit for the guild to fully load before initializing metrics
    console.log('[Ready] Waiting 15 seconds for guild to fully load...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // Initialize staff metrics with actual user IDs from roles
    try {
        const metrics = require('../utils/metrics');
        await metrics.initStaffMetrics(client);
        
        // Run cleanup once to fix any existing role ID entries
        console.log('[Ready] Running one-time cleanup of incorrect role IDs...');
        await metrics.cleanupRoleIds(client);
    } catch (error) {
        console.error('[Ready] Error initializing staff metrics:', error);
    }

    const db = new QuickDB();

    // See if the Embed for creating tickets is available and if its not, make one.
    let buttonEmbed = undefined
    let postChannel = client.channels.cache.find(x => x.id == client.config.channel_ids.post_embed_channel_id)
    if (!postChannel) {
        func.handle_errors(null, client, `ready.js`, `Could not find the 'post_embed_channel_id' for ticket creation, please make sure it is defined in your config and the bot is in the correct discord server.`)
    } else {
        buttonEmbed = await postChannel.messages.fetch(messageId.messageId).catch((e) => {
            if (e.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;
        })

        if (buttonEmbed == undefined) {

            const handlerRaw = require("../content/handler/handler.json");
            const handlerData = require("../content/handler/options.json");
            
            if (!handlerRaw.description || handlerRaw.description == "") return func.handle_errors(null, client, `ready.js`, `Embed Description can not be found or is listed as a blank space. Please go to your handler file to add a description.`)
            let TypeCount = Object.keys(handlerData.options).length
            if (TypeCount > 10) return func.handle_errors(null, client, `ready.js`, `There are too many ticket types in your options.json file. The limit is 10!`)
            const rowOne = new Discord.MessageActionRow()
            const rowTwo = new Discord.MessageActionRow()
            let TwoRow = 0
            const keys = Object.keys(handlerData.options);
            let usedCustoms = ""
            for (let i = 0; i < 5; i++) {

                if (!handlerData.options[`${keys[i]}`]) continue;

                let questionFilesystem = require(`../content/questions/${handlerData.options[`${keys[i]}`]?.question_file}`);

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
                        func.handle_errors(null, client, `ready.js`, `You need to enabled at least one of the holding channel buttons in your question file for ${keys[i]}.`)
                        continue;
                    }

                if (!["PRIMARY", "SECONDARY", "DANGER", "SUCCESS"].includes(handlerData.options[`${keys[i]}`]?.button_type)) {
                    func.handle_errors(null, client, `ready.js`, `Could not add number ${i + 1} of your options due to the button type being incorrect. Please use "PRIMARY", "SECONDARY", "DANGER" or "SUCCESS" only.`)
                    continue;
                }
                if (!handlerData.options[`${keys[i]}`]?.unique_button_identifier || handlerData.options[`${keys[i]}`]?.unique_button_identifier == "") {
                    func.handle_errors(null, client, `ready.js`, `Could not add number ${i + 1} of your options due to there being no unique identifer set.`)
                    continue;
                }
                if (usedCustoms.includes(handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``))) {
                    func.handle_errors(null, client, `ready.js`, `Could not submit a ticket type button due to conflicting unique identifiers. (${keys[i]} - the name \`${handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``)}\` is duplicated)`)
                    continue;
                }
                usedCustoms = usedCustoms + ` - ` + handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``)
                if (handlerData.options[`${keys[i]}`].button_emoji == "") {
                    rowOne.addComponents(
                        new Discord.MessageButton()
                            .setCustomId(handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``))
                            .setLabel(keys[i])
                            .setStyle(handlerData.options[`${keys[i]}`]?.button_type != "" ? handlerData.options[`${keys[i]}`]?.button_type.toUpperCase() : "PRIMARY"),
                    );
                } else {
                    rowOne.addComponents(
                        new Discord.MessageButton()
                            .setCustomId(handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``))
                            .setLabel(keys[i])
                            .setStyle(handlerData.options[`${keys[i]}`]?.button_type != "" ? handlerData.options[`${keys[i]}`]?.button_type.toUpperCase() : "PRIMARY")
                            .setEmoji(handlerData.options[`${keys[i]}`]?.button_emoji),
                    );
                }
            }
            if (TypeCount > 5) {
                TwoRow++
                for (let i = 5; i < 10; i++) {

                    if (!handlerData.options[`${keys[i]}`]) continue;

                    let questionFilesystem = require(`../content/questions/${handlerData.options[`${keys[i]}`]?.question_file}`);

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
                            func.handle_errors(null, client, `ready.js`, `You need to enabled at least one of the holding channel buttons in your question file for ${keys[i]}.`)
                            continue;
                        }

                    if (!["PRIMARY", "SECONDARY", "DANGER", "SUCCESS"].includes(handlerData.options[`${keys[i]}`]?.button_type)) {
                        func.handle_errors(null, client, `ready.js`, `Could not add number ${i + 1} of your options due to the button type being incorrect. Please use "PRIMARY", "SECONDARY", "DANGER" or "SUCCESS" only.`)
                        continue;
                    }
                    if (!handlerData.options[`${keys[i]}`]?.unique_button_identifier || handlerData.options[`${keys[i]}`]?.unique_button_identifier == "") {
                        func.handle_errors(null, client, `ready.js`, `Could not add number ${i + 1} of your options due to there being no unique identifer set.`)
                        continue;
                    }

                    if (usedCustoms.includes(handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``))) {
                        func.handle_errors(null, client, `ready.js`, `Could not submit a ticket type button due to conflicting unique identifiers. (${keys[i]} - the name \`${handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``)}\` is duplicated)`)
                        continue;
                    }

                    if (handlerData.options[`${keys[i]}`].button_emoji == "") {
                        rowTwo.addComponents(
                            new Discord.MessageButton()
                                .setCustomId(handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``))
                                .setLabel(keys[i])
                                .setStyle(handlerData.options[`${keys[i]}`]?.button_type != "" ? handlerData.options[`${keys[i]}`]?.button_type.toUpperCase() : "PRIMARY"),
                        );
                    } else {
                        rowTwo.addComponents(
                            new Discord.MessageButton()
                                .setCustomId(handlerData.options[`${keys[i]}`]?.unique_button_identifier.toLowerCase().replace(` `,``))
                                .setLabel(keys[i])
                                .setStyle(handlerData.options[`${keys[i]}`]?.button_type != "" ? handlerData.options[`${keys[i]}`]?.button_type.toUpperCase() : "PRIMARY")
                                .setEmoji(handlerData.options[`${keys[i]}`]?.button_emoji),
                        );
                    }
                }
            }

            const FinalEmbed = new Discord.MessageEmbed()
                .setTitle(handlerRaw.title.replace("{{SERVER}}", client.guilds?.cache.get(client.config.channel_ids.public_guild_id).name))
                .setColor(client.config.bot_settings.main_color)
                .setDescription(handlerRaw.description)
                .setFooter({text: client.user.username, iconURL: client.user.displayAvatarURL()})

            if (TwoRow == 0) {
                buttonEmbed = await postChannel.send({embeds: [FinalEmbed], components: [rowOne]}).catch((e) => func.handle_errors(e, client, `ready.js`, null))
            } else {
                buttonEmbed = await postChannel.send({embeds: [FinalEmbed], components: [rowOne, rowTwo]}).catch((e) => func.handle_errors(e, client, `ready.js`, null))
            }
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
                        if (error instanceof Discord.DiscordAPIError && error.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;
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
};