const Discord = require("discord.js");
const { writeFileSync, existsSync, mkdirSync, unlinkSync } = require("fs");
let unirest = require('unirest');
const func = require("./functions.js")
const logger = require('./logger');
const lang = require("../content/handler/lang.json");
const { createDB } = require('./mysql');
const db = createDB();


module.exports = async function (client, interaction, user, ticketType, validOption, questionFilesystem) {
	try {
		const guild = await client.guilds.cache.find(x => x.id == client.config.channel_ids.staff_guild_id);
		const ticketChannel = await guild.channels.cache.find(x => x.id == questionFilesystem["post-channel"]);

		let responses = ""

		// Check verification first if required
		if (questionFilesystem.needVerified === true) {
			if (!client.config.tokens.Linking_System_API_Key_Or_Secret || client.config.tokens.Linking_System_API_Key_Or_Secret == "") {
				return func.handle_errors(null, client, `backbone.js`, `needVerified is enabled and Linking_System_API_Key_Or_Secret is not set in the config so could not access the API!`);
			}

			// Simple Link is 1
			if (client.config.linking_settings.linkingSystem === 1) {
				let SteamIDGrab = await unirest.get(`${client.config.linking_settings.verify_link}/api.php?action=findByDiscord&id=${user.id}&secret=${client.config.tokens.Linking_System_API_Key_Or_Secret}`);

				if (!SteamIDGrab.body || !SteamIDGrab.body?.toString || !SteamIDGrab?.body?.toString().startsWith("7656119")) {
					return interaction.editReply({
						content: lang.user_errors["verification-needed"] != "" 
							? lang.user_errors["verification-needed"]
								.replace(`{{USER}}`, `<@${user.id}>`)
								.replace(`{{TICKETTYPE}}`, `\`${ticketType}\``)
								.replace(`{{VERIFYLINK}}`, client.config.linking_settings.verify_link)
							: `<@${user.id}>, you need to verify to make a '${ticketType}' ticket. Verify at ${client.config.linking_settings.verify_link}`,
						ephemeral: true
					});
				}
			}
		}

		let errorFound = 0;
        // Visibility: beginning ticket DM flow
        try { logger.event('TicketDMStart', { userId: user.id, ticketType }); } catch (_) {}
        // Send a divider line as the first DM, with retry + verification
        {
            const result = await func.sendDMWithRetry(user, '------------ BRIT SUPPORT -------------', { maxAttempts: 3, baseDelayMs: 500 });
            if (!result.delivered) {
                errorFound++
                await interaction.editReply({content: `I couldn't send you a DM. Please make sure your DMs are open!`, ephemeral: true}).catch(e => func.handle_errors(e, client, `backbone.js`, null));
                try { logger.warn('[TicketDM] Failed initial divider DM', { userId: user.id, ticketType }); } catch (_) {}
            }
        }
		if (errorFound == 1) return;

        // Send the welcome/pre-message first
        {
            const welcomeText = questionFilesystem["pre-message"] == "" ? "Hi there! I'll ask you a few questions to help us better assist you. Please answer them to the best of your ability." : questionFilesystem["pre-message"];
            const result = await func.sendDMWithRetry(user, welcomeText, { maxAttempts: 3, baseDelayMs: 600 });
            if (!result.delivered) {
                errorFound++
                await interaction.editReply({content: `I couldn't send you a DM. Please make sure your DMs are open!`, ephemeral: true}).catch(e => func.handle_errors(e, client, `backbone.js`, null));
                try { logger.warn('[TicketDM] Failed welcome DM', { userId: user.id, ticketType }); } catch (_) {}
            }
        }

			if (errorFound == 1) return;
		await interaction.editReply({content: "I've sent you a DM to continue our conversation!", ephemeral: true}).catch(e => func.handle_errors(e, client, `backbone.js`, null));
			
			var stop = false;

		// Server selection (after pre-message)
		if (questionFilesystem.server_selection?.enabled) {
			let validServerSelected = false;
			let selectedServer = "";

			while (!validServerSelected) {
				// Create balanced rows of buttons
				const servers = questionFilesystem.server_selection.servers;
				const rows = [];
				const buttonsPerRow = Math.ceil(servers.length / Math.ceil(servers.length / 5));
				for (let i = 0; i < servers.length; i += buttonsPerRow) {
					const row = new Discord.MessageActionRow()
						.addComponents(
							servers.slice(i, i + buttonsPerRow).map(server => 
								new Discord.MessageButton()
									.setCustomId(server)
									.setLabel(server)
									.setStyle('PRIMARY')
							)
						);
					rows.push(row);
				}

                const sent = await user.send({
					content: "Which server are you playing on?",
					components: rows
				}).catch(async (err) => {
					if (err.message === `Cannot send messages to this user`) return;
					func.handle_errors(err, client, `backbone.js`, null);
				});

				if (!sent || !sent?.channel) {
					return;
				}

				try {
                    const collected = await sent.awaitMessageComponent({
						filter: i => i.user.id === user.id,
                        time: 600000
					});

					selectedServer = collected.customId;
					validServerSelected = true;

					// Disable all buttons after selection
					const disabledRows = rows.map(row => {
						return new Discord.MessageActionRow().addComponents(
							row.components.map(button => button.setDisabled(true))
						);
					});
					await collected.update({
						components: disabledRows
					});
				} catch (error) {
					return user.send("Your session was cancelled or timed out.").catch(() => {});
				}
			}

			responses = responses.concat(`\n\n**Server:**\n${selectedServer}`);
		}

			for (var x = 0; x < questionFilesystem.questions.length; x++) {
				if (stop) break;
				const question = questionFilesystem.questions[x];

            const sent = await user.send(question).catch(async (err) => {
					if (err.message === `Cannot send messages to this user`) return;
				func.handle_errors(err, client, `backbone.js`, null)
				})

				const filter = response => {
					return response.content != null && !response.author.bot;
				}

				if (!sent || !sent?.channel) {
					stop = true
					break;
				}
                const reply = await sent?.channel?.awaitMessages({filter, max: 1, time: 600 * 1000, errors: [ "time" ] }).catch(_obj => { return false });

				if (!reply || !reply?.first() || reply?.first()?.content?.toLowerCase() == "stop") {
					stop = true
					break;
				}

				const extraData = reply?.first()?.attachments?.first()?.url ? reply.first().attachments?.first()?.url : "";
				responses = responses.concat(`\n\n**${question}**\n${extraData} ${reply.first().content}`);
			};

		if (stop) return user.send("Your session was cancelled or timed out.").catch(async (err) => {
				if (err.message === `Cannot send messages to this user`) return;
			});

		// Auto-deny staff applications under 18 without creating a ticket
		try {
			if (ticketType && ticketType.toLowerCase().includes('application')) {
				const ageMatch = responses.match(/\*\*How old are you\?\*\*[\s\S]*?(\d{1,2})/i);
				const age = ageMatch && ageMatch[1] ? parseInt(ageMatch[1], 10) : null;
				if (age !== null && age < 18) {
					await user.send('You must be at least 18 to apply. Your application has been automatically denied.');
					client.blocked_users.delete(user.id);
					setTimeout(() => { client.cooldown.delete(user.id); }, client.config.timeouts.timeout_cooldown_in_seconds * 1000);
					return;
				}
			}
		} catch(_){}

        await user.send(questionFilesystem["post-message"] == "" ? "Thanks for your responses! Our team will review your ticket and get back to you as soon as possible." : questionFilesystem["post-message"]).catch(async (err) => {
				if (err.message === `Cannot send messages to this user`) return;
			func.handle_errors(err, client, `backbone.js`, null)
			});

        try { logger.event('TicketCollected', { userId: user.id, ticketType, length: responses.length }); } catch (_) {}
		
	

		let overflow = responses.length > 2000;
		let DiscordNumber = 0
		let title = ""
		let author = ""

		let SteamID = ""
		if (questionFilesystem.needVerified === true) { 

			if (!client.config.tokens.Linking_System_API_Key_Or_Secret || client.config.tokens.Linking_System_API_Key_Or_Secret == "") return func.handle_errors(null, client, `backbone.js`, `needVerified is enabled and Linking_System_API_Key_Or_Secret is not set in the config so could not access the API!`)

			// Simple Link is 1
			if (client.config.linking_settings.linkingSystem === 1) {

				let SteamIDGrab = await unirest.get(`${client.config.linking_settings.verify_link}/api.php?action=findByDiscord&id=${user.id}&secret=${client.config.tokens.Linking_System_API_Key_Or_Secret}`)

				if (SteamIDGrab.body) {

					if (SteamIDGrab.body?.toString) {
						if (SteamIDGrab?.body?.toString().startsWith("7656119")) SteamID = SteamIDGrab.body

					}
				} else {
					func.handle_errors(null, client, `backbone.js`, `Could not access API! Have you selected the correct linking system?`)
					
				}

			// Steamcord is 2
			} else if (client.config.linking_settings.linkingSystem === 2) {

				let SteamIDGrab = await unirest.get(`https://api.steamcord.io/players?discordId=${user.id}`).headers({'Authorization': `Bearer ${client.config.tokens.Linking_System_API_Key_Or_Secret}`, 'Content-Type': 'application/json'})
				if (SteamIDGrab.body) {
					if (SteamIDGrab.body[0]?.steamAccounts[0]?.steamId) {
						if (SteamIDGrab.body[0]?.steamAccounts[0]?.steamId.toString().startsWith("7656119")) SteamID = SteamIDGrab.body[0]?.steamAccounts[0]?.steamId
					}
				} else {
					func.handle_errors(null, client, `backbone.js`, `Could not access API! Have you selected the correct linking system?`)
				}
			
			// Platform Sync is 3
			} else if (client.config.linking_settings.linkingSystem === 3) {

				let SteamIDGrab = await unirest.get(`https://link.platformsync.io/api.php?id=${user.id}&token=${client.config.tokens.Linking_System_API_Key_Or_Secret}`)
				if (SteamIDGrab.body) {
						if (SteamIDGrab.body?.linked == true) {
							if (SteamIDGrab.body?.steam_id) {
								if (SteamIDGrab?.body?.steam_id?.startsWith("7656119")) SteamID = SteamIDGrab.body.steam_id
							}
						}
				} else {
					func.handle_errors(null, client, `backbone.js`, `Could not access API! Have you selected the correct linking system?`)
				}

			}

		}

	// BM lookup now done asynchronously after ticket creation
	let bmInfo = null;

	// Steam profile link for author (no link, just ID)
	let authorName = SteamID && SteamID.toString().startsWith('7656119')
		? `${user.username} (${SteamID})`
		: user.username;

		// Get the global ticket counter from MySQL
		let globalTicketCount = await db.get('globalTicketCount');
		if (globalTicketCount === null || globalTicketCount === undefined) {
			// Initialize to highest existing ticket number if tickets exist
			try {
				if (typeof db.query === 'function') {
					const [rows] = await db.query('SELECT MAX(CAST(ticket_id AS UNSIGNED)) as maxId FROM tickets WHERE ticket_id REGEXP "^[0-9]+$"');
					globalTicketCount = rows[0]?.maxId || 0;
				} else {
					globalTicketCount = 0;
				}
			} catch (_) {
				globalTicketCount = 0;
			}
		}
		globalTicketCount = Number(globalTicketCount) || 0;
		globalTicketCount++;
		await db.set('globalTicketCount', globalTicketCount);

		// Format the ticket number with leading zeros (e.g., 0001)
		let formattedTicketNumber = globalTicketCount.toString().padStart(4, '0');

	// Use ONLY the global ticket number for everything
	let ticketUniqueID = formattedTicketNumber;

		const embed = new Discord.MessageEmbed()
		.setAuthor({ name: authorName, iconURL: user.displayAvatarURL()})
		    .setTitle(`${ticketType} #${formattedTicketNumber}`)
		.setDescription(responses.substring(0, 4000))
		.setColor(client.config.bot_settings.main_color || '#208cdd')
		    .setTimestamp()
		.setFooter({text: `${user.id}-${formattedTicketNumber} | ${ticketType} | Ticket Opened:`, iconURL: client.user.displayAvatarURL()});

		let pingRoleIDs = questionFilesystem["ping-role-id"];
		let pingTags = `<@&${client.config.role_ids.default_admin_role_id}> <@${user.id}>`;
	
		if (pingRoleIDs && pingRoleIDs.length > 0) {
			for (let role of pingRoleIDs) {
				if (role == "") continue;
				pingTags = pingTags + ` <@&${role}>`;
			}
		}
		
        if (questionFilesystem["open-as-ticket"] == true) {
            try { logger.event('TicketOpenChannel', { userId: user.id, ticketType, formattedTicketNumber }); } catch (_) {}

const openResult = await func.openTicket(client, interaction, questionFilesystem, user, null, ticketType, embed, formattedTicketNumber, questionFilesystem, responses, bmInfo);
// Kick off BM lookup without delaying ticket creation
;(async () => {
    try {
        if (!(SteamID && SteamID.toString().startsWith('7656119'))) return;
        const bmToken = client.config.tokens.battlemetricsToken;
        if (!bmToken) return;
        const axios = require('axios');
        const bmHeaders = { 'Authorization': `Bearer ${bmToken}`, 'Accept': 'application/json' };
        const bmPlayerUrl = `https://api.battlemetrics.com/players?filter[search]=${SteamID}&include=identifier,server`;
        const bmResponse = await axios.get(bmPlayerUrl, { headers: bmHeaders, timeout: 10000 }).catch(e => e);
        if (!(bmResponse && bmResponse.status >= 200 && bmResponse.status < 300 && bmResponse.data && bmResponse.data.data && bmResponse.data.data.length > 0)) return;
        const playerData = bmResponse.data.data[0];
        const playerId = playerData.id;
        let inGameName = null, mostRecentServer = null, mostRecentServerId = null, timePlayed = null, firstSeen = null, lastSeen = null;
        if (bmResponse.data.included) {
            for (const inc of bmResponse.data.included) {
                if (inc.type === 'identifier' && inc.attributes.type === 'name' && !inGameName) inGameName = inc.attributes.identifier;
            }
            if (playerData.relationships && playerData.relationships.servers && playerData.relationships.servers.data && playerData.relationships.servers.data.length > 0) {
                const servers = playerData.relationships.servers.data;
                servers.sort((a, b) => (b.meta?.lastSeen || '').localeCompare(a.meta?.lastSeen || ''));
                const recentServer = servers[0];
                const serverId = recentServer.id;
                const serverInfo = bmResponse.data.included.find(inc => inc.type === 'server' && inc.id === serverId);
                if (serverInfo) {
                    mostRecentServer = serverInfo.attributes.name;
                    mostRecentServerId = serverId;
                    timePlayed = recentServer.meta?.timePlayed || null;
                    firstSeen = recentServer.meta?.firstSeen || null;
                    lastSeen = recentServer.meta?.lastSeen || null;
                }
            }
        }
        const bansUrl = `https://api.battlemetrics.com/bans?filter[player]=${playerId}&include=server`;
        const bansResponse = await axios.get(bansUrl, { headers: bmHeaders, timeout: 10000 }).catch(e => e);
        const banInfo = [];
        if (bansResponse && bansResponse.status >= 200 && bansResponse.status < 300 && bansResponse.data && bansResponse.data.data && bansResponse.data.data.length > 0) {
            for (const ban of bansResponse.data.data) {
                const reason = ban.attributes.reason || 'No reason provided';
                let serverName = ban.relationships?.server?.data?.id || '';
                if (bansResponse.data.included) {
                    const serverInc = bansResponse.data.included.find(inc => inc.type === 'server' && inc.id === serverName);
                    if (serverInc) serverName = serverInc.attributes.name;
                }
                banInfo.push(`Ban on ${serverName}: ${reason}`);
            }
        }
        const staffGuild = client.guilds.cache.get(client.config.channel_ids.staff_guild_id);
        if (!staffGuild) return;
        const channel = staffGuild.channels.cache.get(questionFilesystem["ticket-category"]) || null;
        const threadId = openResult && openResult.staffThreadId ? openResult.staffThreadId : null;
        let thread = null;
        if (threadId) {
            try { thread = await user.client.channels.fetch(threadId).catch(() => null); } catch (_) { thread = null; }
        }
        if (thread && typeof thread.send === 'function') {
            const Discord = require('discord.js');
            const staffEmbed = new Discord.MessageEmbed()
                .setColor(client.config.bot_settings.main_color)
                .setTitle('User Info')
                .setAuthor({ name: `${user.username} (${user.id})`, iconURL: user.displayAvatarURL() })
                .addFields(
                    { name: "BM Name", value: `${inGameName ? `[${inGameName}](https://www.battlemetrics.com/rcon/players/${playerId})` : 'N/A'}`, inline: true },
                    { name: "BM Most Recent Server", value: `${mostRecentServer ? `[${mostRecentServer}](https://www.battlemetrics.com/servers/rust/${mostRecentServerId})` : 'N/A'}`, inline: true },
                )
                .addFields(
                    { name: 'Time Played', value: `${timePlayed ? Math.floor(timePlayed / 3600) : 0} hours`, inline: true },
                    { name: 'First Seen', value: `${firstSeen ? `<t:${Math.floor(new Date(firstSeen).getTime() / 1000)}:R>` : 'N/A'}`, inline: true },
                    { name: 'Last Seen', value: `${lastSeen ? `<t:${Math.floor(new Date(lastSeen).getTime() / 1000)}:R>` : 'N/A'}`, inline: true },
                )
                .addFields(
                    { name: 'Steam Profile', value: `[${SteamID}](https://steamcommunity.com/profiles/${SteamID})` }
                );
            if (banInfo.length > 0) { try { staffEmbed.addFields({ name: 'BM Bans', value: banInfo.join('\n').substring(0, 1024) }); } catch (_) {} }
            try { await thread.send({ embeds: [staffEmbed] }); } catch (_) {}
        }
    } catch (e) { func.handle_errors(e, client, 'backbone.js', 'BM async lookup failed'); }
})();
try {
	const m = responses.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/);
	const serverVal = m && m[1] ? m[1] : 'none';
	const metrics = require('./metrics');
	const scope = questionFilesystem && questionFilesystem.internal ? 'internal' : 'public';
	metrics.ticketOpened(ticketType, serverVal, user.id, user.username, scope);
} catch (_) {}

        } else {
        try { logger.event('TicketHoldChannel', { userId: user.id, ticketType, formattedTicketNumber }); } catch (_) {}

		const row = new Discord.MessageActionRow()
		if (questionFilesystem.active_ticket_button_content.accept.enabled == true) {
			if (questionFilesystem.active_ticket_button_content.accept.emoji != "") {
				row.addComponents(new Discord.MessageButton().setCustomId(`supportaccept`).setLabel(questionFilesystem.active_ticket_button_content.accept.title == "" ? "Accept" : questionFilesystem.active_ticket_button_content.accept.title).setStyle("SUCCESS").setEmoji(questionFilesystem.active_ticket_button_content.accept.emoji));
			} else {
				row.addComponents(new Discord.MessageButton().setCustomId(`supportaccept`).setLabel(questionFilesystem.active_ticket_button_content.accept.title == "" ? "Accept" : questionFilesystem.active_ticket_button_content.accept.title).setStyle("SUCCESS"));
			}
		}

		if (questionFilesystem.active_ticket_button_content.deny.enabled == true) {
			if (questionFilesystem.active_ticket_button_content.deny.emoji != "") {
				row.addComponents(new Discord.MessageButton().setCustomId(`supportdeny`).setLabel(questionFilesystem.active_ticket_button_content.deny.title == "" ? "Deny" : questionFilesystem.active_ticket_button_content.deny.title).setStyle("DANGER").setEmoji(questionFilesystem.active_ticket_button_content.deny.emoji));
			} else {
				row.addComponents(new Discord.MessageButton().setCustomId(`supportdeny`).setLabel(questionFilesystem.active_ticket_button_content.deny.title == "" ? "Deny" : questionFilesystem.active_ticket_button_content.deny.title).setStyle("DANGER"));
			}
		}

		if (questionFilesystem.active_ticket_button_content.custom_response_message.enabled == true) {
			if (questionFilesystem.active_ticket_button_content.custom_response_message.emoji != "") {
				row.addComponents(new Discord.MessageButton().setCustomId(`supportcustom`).setLabel(questionFilesystem.active_ticket_button_content.custom_response_message.title == "" ? "Custom Close Response" : questionFilesystem.active_ticket_button_content.custom_response_message.title).setStyle("PRIMARY").setEmoji(questionFilesystem.active_ticket_button_content.custom_response_message.emoji));
			} else {
				row.addComponents(new Discord.MessageButton().setCustomId(`supportcustom`).setLabel(questionFilesystem.active_ticket_button_content.custom_response_message.title == "" ? "Custom Close Response" : questionFilesystem.active_ticket_button_content.custom_response_message.title).setStyle("PRIMARY"));
			}
		}

		if (questionFilesystem.active_ticket_button_content.make_a_ticket.enabled == true) {
			if (questionFilesystem.active_ticket_button_content.make_a_ticket.emoji != "") {
				row.addComponents(new Discord.MessageButton().setCustomId(`supportticket`).setLabel(questionFilesystem.active_ticket_button_content.make_a_ticket.title == "" ? "Open Support Ticket" : questionFilesystem.active_ticket_button_content.make_a_ticket.title).setStyle("PRIMARY").setEmoji(questionFilesystem.active_ticket_button_content.make_a_ticket.emoji));
			} else {
				row.addComponents(new Discord.MessageButton().setCustomId(`supportticket`).setLabel(questionFilesystem.active_ticket_button_content.make_a_ticket.title == "" ? "Open Support Ticket" : questionFilesystem.active_ticket_button_content.make_a_ticket.title).setStyle("PRIMARY"));
			}
		}

		let sent = null;
		if (overflow) {
			if (!existsSync("./temp")) mkdirSync("./temp");
			const dirpath = `./temp/${user.id}.txt`;
			writeFileSync(dirpath, responses, { encoding: "utf-8" });
			sent = await ticketChannel.send({ content: (pingRoleIDs && pingRoleIDs.length > 0) ? pingTags : `<@${user.id}>`, embeds: [embed], components: [row], files: [ dirpath ] }).catch(e => func.handle_errors(e, client, `backbone.js`, null));
			unlinkSync(dirpath);
		} else {
            sent = await ticketChannel.send({ content: (pingRoleIDs && pingRoleIDs.length > 0) ? pingTags : `<@${user.id}>`, embeds: [embed], components: [row] }).catch(e => func.handle_errors(e, client, `backbone.js`, null));
		};

        try { logger.event('TicketPosted', { channelId: sent?.channel?.id || ticketChannel?.id, messageId: sent?.id, ticketType, formattedTicketNumber }); } catch (_) {}

	}

	const createdAt = Math.floor(Date.now() / 1000);
	// Save parsed server for reporting
	let server = null;
	try {
		const m = responses.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/);
		if (m && m[1]) {
			server = m[1];
		}
	} catch (_) {}
	
	// Write to MySQL tickets table (PlayerStats removed - all data in MySQL now)
	try {
		if (typeof db.writeTicket === 'function') {
			console.log('[backbone] Writing ticket to MySQL', { 
				ticketId: formattedTicketNumber, 
				userId: user.id, 
				ticketType: ticketType 
			});
			await db.writeTicket({
				userId: String(user.id),
				ticketId: String(formattedTicketNumber),
				ticketType: ticketType || null,
				server: server || null,
				username: user.username || null,
				steamId: SteamID && SteamID.toString().startsWith('7656119') ? String(SteamID) : null,
				responses: responses || null,
				createdAt: createdAt,
				globalTicketNumber: formattedTicketNumber
			});
			console.log('[backbone] Successfully wrote ticket to MySQL', { ticketId: formattedTicketNumber });
		} else {
			console.warn('[backbone] writeTicket method not available on db adapter');
		}
	} catch (err) {
		console.error('[backbone] Error writing ticket to MySQL:', {
			message: err.message,
			code: err.code,
			stack: err.stack,
			ticketId: formattedTicketNumber,
			userId: user.id
		});
		// Don't throw - ticket creation should continue even if MySQL write fails
	}

	// After creating the ticket channel and sending the DM, update the bot's status
	await func.updateTicketStatus(client);

	} catch (e) {
		func.handle_errors(e, client, `backbone.js`, null);
	} finally {
		client.blocked_users.delete(user.id);
		setTimeout(() => {
			client.cooldown.delete(user.id);
		}, client.config.timeouts.timeout_cooldown_in_seconds * 1000);
	};
};
