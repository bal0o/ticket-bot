const Discord = require("discord.js");
const metrics = require('./metrics');
const { createDB } = require('./quickdb')
const db = createDB();
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

module.exports.handle_errors = async (err, client, file, message) => {

	let ErrorChannel = client.channels.cache.get(client.config.channel_ids.error_channel)

    let errorEmbed = new Discord.MessageEmbed()
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

module.exports.updateResponseTimes = async (openTime, closeTime, ticketType, ButtonType) => {

    let newTicketType = ticketType.replace(/ /g,`_`)
    let ServerResponseTimes = await db.get(`ServerStats.ResponseTimes`)


    let ticketDifference = closeTime - openTime
    if (ServerResponseTimes?.[`${newTicketType}`]?.[`${ButtonType}`]?.totalTimeSpent == null || ServerResponseTimes?.[`${newTicketType}`]?.[`${ButtonType}`]?.totalTimeSpent == undefined) {
        await db.set(`ServerStats.ResponseTimes.${newTicketType}.${ButtonType}.totalTimeSpent`, ticketDifference)
    } else {
        await db.set(`ServerStats.ResponseTimes.${newTicketType}.${ButtonType}.totalTimeSpent`, ServerResponseTimes?.[`${newTicketType}`]?.[`${ButtonType}`]?.totalTimeSpent + ticketDifference)
    }

    if ( ServerResponseTimes?.[`${newTicketType}`]?.[`${ButtonType}`]?.totalTicketsHandled == null ||  ServerResponseTimes?.[`${newTicketType}`]?.[`${ButtonType}`]?.totalTicketsHandled == undefined) {
        await db.set(`ServerStats.ResponseTimes.${newTicketType}.${ButtonType}.totalTicketsHandled`, 1)
    } else {
        await db.set(`ServerStats.ResponseTimes.${newTicketType}.${ButtonType}.totalTicketsHandled`, ServerResponseTimes?.[`${newTicketType}`]?.[`${ButtonType}`].totalTicketsHandled + 1)
    }
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

module.exports.staffStats = async (ticketType, directory, userid) => {

    let userStats = await db.get(`StaffStats.${userid}`)

	if (userStats?.[`${ticketType}`]?.[`${directory}`] == null || userStats?.[`${ticketType}`]?.[`${directory}`] == undefined) {
		await db.set(`StaffStats.${userid}.${ticketType}.${directory}`, 1);
	} else {
		await db.set(`StaffStats.${userid}.${ticketType}.${directory}`, userStats?.[`${ticketType}`]?.[`${directory}`] + 1);
	}

    if (userStats?.totalActions == null || userStats?.totalActions == undefined) {
        await db.set(`StaffStats.${userid}.totalActions`, 1);
    } else {
        await db.set(`StaffStats.${userid}.totalActions`, userStats?.totalActions + 1);
    }

    if (userStats?.[`${ticketType}`]?.[`total`] == null || userStats?.[`${ticketType}`]?.[`total`] == undefined) {
		await db.set(`StaffStats.${userid}.${ticketType}.total`, 1);
	} else {
		await db.set(`StaffStats.${userid}.${ticketType}.total`, userStats?.[`${ticketType}`]?.[`total`] + 1);
	}

    await db.set(`StaffStats.${userid}.lastAction`, Date.now());

}


module.exports.GrabUserStaffStats = async (userid, TicketType) => {

    let userStats = await db.get(`StaffStats.${userid}`);

    let soloUserStats = {
        totalActions: ``,
        acceptedActions: userStats?.[TicketType]?.accepted ? userStats?.[TicketType]?.accepted : 0,
        deniedActions: userStats?.[TicketType]?.denied ? userStats?.[TicketType]?.denied : 0,
        customCloseActions: userStats?.[TicketType]?.customclose ? userStats?.[TicketType]?.customclose : 0,
        openTicketActions: userStats?.[TicketType]?.openticket ? userStats?.[TicketType]?.openticket : 0,
        closeTicketActions: userStats?.[TicketType]?.closeticket ? userStats?.[TicketType]?.closeticket : 0,
        ticketMessagesHiddenActions: userStats?.[TicketType]?.ticketmessageshidden ? userStats?.[TicketType]?.ticketmessageshidden : 0,
        ticketMessagesVisibleActions: userStats?.[TicketType]?.ticketmessages ? userStats?.[TicketType]?.ticketmessages : 0
        
    }
    soloUserStats.totalActions = soloUserStats.acceptedActions + soloUserStats.deniedActions + soloUserStats.customCloseActions + soloUserStats.openTicketActions + soloUserStats.closeTicketActions + soloUserStats.ticketMessagesHiddenActions + soloUserStats.ticketMessagesVisibleActions
    return soloUserStats;
}

module.exports.CombineActionCountsUser = async (userid, actiontype) => {

    let userStats = await db.get(`StaffStats.${userid}`);
    let UserActionStats = 0
    const handlerRaw = require("../content/handler/options.json");
	const handlerKeys = Object.keys(handlerRaw.options);	

    for (let TicketType of handlerKeys) {
        if (userStats?.[`${TicketType}`]?.[`${actiontype}`] == null) continue;
        UserActionStats = UserActionStats + userStats?.[`${TicketType}`]?.[`${actiontype}`]
    }

    return UserActionStats;
}

module.exports.closeDataAddDB = async (userid, ticketUniqueID, closeType, closeUser, closeUserID, closeTime, closeReason, transcriptURL = null) => {

    await db.set(`PlayerStats.${userid}.ticketLogs.${ticketUniqueID}.closeType`, closeType)
    await db.set(`PlayerStats.${userid}.ticketLogs.${ticketUniqueID}.closeUser`, closeUser)
    await db.set(`PlayerStats.${userid}.ticketLogs.${ticketUniqueID}.closeUserID`, closeUserID)
    await db.set(`PlayerStats.${userid}.ticketLogs.${ticketUniqueID}.closeTime`, closeTime)
    await db.set(`PlayerStats.${userid}.ticketLogs.${ticketUniqueID}.closeReason`, closeReason)
    if (transcriptURL) {
        await db.set(`PlayerStats.${userid}.ticketLogs.${ticketUniqueID}.transcriptURL`, transcriptURL)
    }
}

module.exports.openTicket = async (client, interaction, questionFile, recepientMember, administratorMember, ticketType, embed, formattedTicketNumber, questionFilesystem, responses, bmInfo) => {
    // Null check for recepientMember
    if (!recepientMember) {
        func.handle_errors(null, client, 'functions.js', 'openTicket called with null recepientMember');
        if (interaction && interaction.editReply) {
            await interaction.editReply({ content: 'Could not find the user who opened this ticket. Please contact staff.', ephemeral: true });
        }
        return;
    }

    let postchannel = null;
    let postchannelCategory = null;
    
    // Only try to get post channel if not using open-as-ticket
    if (!questionFile["open-as-ticket"]) {
        postchannel = client.channels.cache.get(questionFile[`post-channel`]);
        if (postchannel) {
            postchannelCategory = postchannel.parentId;
        }
    }
    
    let ticketCategory = questionFile[`ticket-category`]
    let accessRoleIDs = questionFile[`access-role-id`]
	let pingRoleIDs = questionFile[`ping-role-id`];
    let staffGuild = await client.guilds.cache.get(client.config.channel_ids.staff_guild_id)

    if (administratorMember == null) {
        administratorMember = "Auto Ticket";
    }

    let creatorName = recepientMember.username.trim().replace(/[\r\n\x0B\x0C\u0085\u2028\u2029]+/g, `\n`);
    creatorName = creatorName.substring(0, 8).replace(`-`, ``).replace(` `, ``);;
    let creatorID = recepientMember.id

    let overwrites = [
        {
            id: staffGuild.id,
            deny: ['VIEW_CHANNEL', 'ADD_REACTIONS'],
        },
        {
            id: client.user.id,
            allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ADD_REACTIONS', 'MANAGE_THREADS'],
        },
        {
            id: client.config.role_ids.default_admin_role_id,
            allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
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
                allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
            }
            overwrites.push(add)
        }
    }
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
            await interaction.editReply({ content: `You must select a server for this ticket type (${ticketType}). Please try again.`, ephemeral: true });
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

let ticketChannel = await staffGuild.channels.create(channelName, {
    type: "text",
    topic: recepientMember.id,
    parent: (ticketCategory) ? ticketCategory : postchannelCategory ||  null,
    permissionOverwrites: overwrites,
});

// For public tickets, DM the user with the ticket name/number
try {
    if (!questionFile.internal) {
        await recepientMember.send(`Your ticket (${serverPrefix ? serverPrefix + '-' : ''}${ticketType.toLowerCase()}-${formattedTicketNumber}) has been created. Please use this number for any follow-up.`);
    }
} catch (e) {}

    // Build action buttons. For application tickets, only show application actions.
    let actionRow = new Discord.MessageActionRow();
    const isApplication = ticketType && ticketType.toLowerCase().includes('application');
    if (isApplication) {
        actionRow.addComponents(
            new Discord.MessageButton().setCustomId('app_next_stage').setLabel('Move to Next Stage').setStyle('PRIMARY'),
            new Discord.MessageButton().setCustomId('app_deny').setLabel('Deny').setStyle('DANGER')
        );
    } else {
        actionRow.addComponents(
            new Discord.MessageButton()
                .setCustomId(`ticketclose`)
                .setLabel(lang.close_ticket["close-ticket-button-title"] != "" ? lang.close_ticket["close-ticket-button-title"] : `Close Ticket`)
                .setStyle("DANGER")
                .setEmoji("📝"),
            new Discord.MessageButton()
                .setCustomId(`moveticket`)
                .setLabel("Move Ticket")
                .setStyle("PRIMARY")
                .setEmoji("↗️")
        );
        // Optional claim button for non-application tickets
        try {
            if (client.config?.claims?.enabled) {
                actionRow.addComponents(
                    new Discord.MessageButton()
                        .setCustomId(`claimticket`)
                        .setLabel('Claim Ticket')
                        .setStyle('SUCCESS')
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
    const initialMessage = await ticketChannel.send({
        content: (pingTags ? pingTags + "\n" : "") + (lang.ticket_creation["initial-message-content"] != "" ? lang.ticket_creation["initial-message-content"].replace(`{{USERNAME}}`, safeUsername).replace(`{{TICKETTYPE}}`, ticketType).replace(`{{ADMIN}}`, administratorMember).replace(/{{PREFIX}}/g, client.config.bot_settings.prefix) : `${safeUsername}'s ${ticketType} ticket`),
        embeds: [embed],
        components: [actionRow]
    });
    
    await initialMessage.pin()?.catch(e => { });

    let replyInfo = "";
    if (questionFile["anonymous-only-replies"] === true) {
        replyInfo = `Replies are **anonymous** by default. Use \`!me <message>\` to reply as yourself.`;
    } else {
        replyInfo = `Replies are sent **as yourself** by default. Use \`!r <message>\` to reply anonymously.`;
    }
    const instructionEmbed = new Discord.MessageEmbed()
        .setColor(client.config.bot_settings.main_color)
        .setTitle('How to Reply')
        .setDescription(replyInfo);

    await ticketChannel.send({ embeds: [instructionEmbed] });

    // Post Cheetos check in the main ticket channel (not in staff thread)
    try {
        const shouldCheckCheetos = !!questionFile["check-cheetos"] && !!client.config?.tokens?.cheetosToken;
        if (shouldCheckCheetos) {
            const req = require('unirest');
            const url = `https://Cheetos.gg/api.php?action=search&id=${encodeURIComponent(recepientMember.id)}`;
            const resp = await req.get(url).headers({
                'Auth-Key': client.config.tokens.cheetosToken,
                // Use configured requester ID if set, else bot ID
                'DiscordID': String(client.config?.misc?.cheetos_requestor_id || client.user?.id || '')
            });

            // Parse plaintext response into records
            const text = resp && resp.body ? (typeof resp.body === 'string' ? resp.body : (resp.body.toString ? resp.body.toString() : '')) : '';
            const lines = text.split(/\r?\n/);
            const records = [];
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

            const count = records.length;

            // Compute LTS from LastGuildScan only (epoch seconds)
            let lastEpoch = null;
            for (const r of records) {
                const lg = r['LastGuildScan'] ? parseInt(r['LastGuildScan'], 10) : null;
                if (Number.isFinite(lg) && lg > 0 && (!lastEpoch || lg > lastEpoch)) lastEpoch = lg;
            }
            let ltsStr = 'N/A';
            if (lastEpoch && Number.isFinite(lastEpoch)) {
                const nowSec = Math.floor(Date.now() / 1000);
                const diffSec = Math.max(0, nowSec - lastEpoch);
                const diffHours = Math.floor(diffSec / 3600);
                if (diffHours >= 24) {
                    const d = Math.floor(diffHours / 24);
                    ltsStr = `${d}d`;
                } else {
                    ltsStr = `${diffHours}h`;
                }
            }

            // WR = how many distinct discords they have roles in
            // Approximate by counting records where Roles is non-empty
            let wr = 0;
            for (const r of records) {
                const rolesVal = (r['Roles'] || '').trim();
                if (rolesVal && rolesVal.length > 0) wr++;
            }

            const cheetosEmbed = new Discord.MessageEmbed()
                .setColor(client.config.bot_settings.main_color)
                .setTitle('Cheetos Check')
                .setDescription(count > 0 ? `Cheetos Check: ${count} CC • LTS: ${ltsStr} • ${wr} WR` : `Cheetos Check: Clean`);
            await ticketChannel.send({ embeds: [cheetosEmbed] });
        }
    } catch (e) { func.handle_errors(e, client, 'functions.js', 'Failed to post Cheetos check'); }

    // Skip creating staff thread for internal tickets
    if (!questionFile.internal) try {
        console.log(`[Functions] Creating staff thread for ticket #${formattedTicketNumber}...`);
        // Create as public thread first so we can add role permissions
        const thread = await ticketChannel.threads.create({
            name: `staff-chat-${formattedTicketNumber}`,
            autoArchiveDuration: 10080,
            reason: `Private staff discussion for ticket #${formattedTicketNumber}`,
            type: 'GUILD_PUBLIC_THREAD'
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

        // Post a quick link to user's web ticket history for staff
        try {
            const baseWeb = (client.config?.transcript_settings?.base_url || '').replace(/\/?transcripts\/?$/i, '') || 'http://localhost:3050';
            await thread.send({
                content: `View user's ticket history on web: <${baseWeb}/staff?user=${recepientMember.id}>`,
                allowedMentions: { parse: [] }
            });
        } catch (_) {}

        if (bmInfo) {
            const staffEmbed = new Discord.MessageEmbed()
                .setColor(client.config.bot_settings.main_color)
                .setTitle(`User Info`)
                .setAuthor({ name: `${recepientMember.username} (${recepientMember.id})`, iconURL: recepientMember.displayAvatarURL() })
                .addFields(
                    { name: "BM Name", value: `[${bmInfo.inGameName}](https://www.battlemetrics.com/rcon/players/${bmInfo.playerId})`, inline: true },
                    { name: "BM Most Recent Server", value: `[${bmInfo.mostRecentServer}](https://www.battlemetrics.com/servers/rust/${bmInfo.mostRecentServerId})`, inline: true },
                )
                .addFields(
                    { name: 'Time Played', value: `${Math.floor(bmInfo.timePlayed / 3600)} hours`, inline: true },
                    { name: 'First Seen', value: `<t:${Math.floor(new Date(bmInfo.firstSeen).getTime() / 1000)}:R>`, inline: true },
                    { name: 'Last Seen', value: `<t:${Math.floor(new Date(bmInfo.lastSeen).getTime() / 1000)}:R>`, inline: true },
                )
                .addFields(
                    { name: 'Steam Profile', value: `[${bmInfo.steamId}](https://steamcommunity.com/profiles/${bmInfo.steamId})` }
                );

            if (bmInfo.banInfo && bmInfo.banInfo.length > 0) {
                staffEmbed.addField('BM Bans', bmInfo.banInfo.join('\n').substring(0, 1024));
            }
            
            try { await thread.send({ embeds: [staffEmbed] }); } catch (_) {}
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
                                                    VIEW_CHANNEL: true,
                                                    SEND_MESSAGES: true,
                                                    READ_MESSAGE_HISTORY: true
                                                });
                                                console.log(`[Functions] Successfully added role ${role.name} to thread permissions via permissionOverwrites`);
                                            } else {
                                                // Fallback: try to edit the thread with permissionOverwrites
                                                await thread.edit({
                                                    permissionOverwrites: [
                                                        {
                                                            id: roleId,
                                                            type: 'role',
                                                            allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY']
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
            
            // Convert thread to private after setting role permissions
            try {
                console.log(`[Functions] Converting thread to private for ticket #${formattedTicketNumber}...`);
                await thread.edit({
                    type: 'GUILD_PRIVATE_THREAD'
                });
                console.log(`[Functions] Successfully converted thread to private`);
            } catch (convertError) {
                console.error(`[Functions] Failed to convert thread to private:`, convertError);
            }
            
            // Debug: Check final thread state
            try {
                console.log(`[Functions] Final thread state for ticket #${formattedTicketNumber}:`);
                console.log(`[Functions] - Thread ID: ${thread.id}`);
                console.log(`[Functions] - Thread Name: ${thread.name}`);
                console.log(`[Functions] - Thread Type: ${thread.type}`);
                console.log(`[Functions] - Thread Archived: ${thread.archived}`);
                console.log(`[Functions] - Thread Locked: ${thread.locked}`);
                console.log(`[Functions] - Thread Parent Channel: ${thread.parent?.name} (${thread.parent?.id})`);
                
                // Check if thread is visible to the bot
                const fetchedThread = await ticketChannel.threads.fetch(thread.id).catch(() => null);
                if (fetchedThread) {
                    console.log(`[Functions] - Thread is fetchable by bot`);
                } else {
                    console.log(`[Functions] - WARNING: Thread is NOT fetchable by bot`);
                }
            } catch (debugError) {
                console.error(`[Functions] Error during thread debugging:`, debugError);
            }
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
    
    if (administratorMember) {
        await func.staffStats(ticketType, `openticket`, administratorMember.id);
    }

    // If application, create application record and link mapping
    try {
        if (ticketType && ticketType.toLowerCase().includes('application')) {
            let server = null;
            const m = typeof responses === 'string' && responses.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/);
            if (m && m[1]) server = m[1];
            const appRec = await applications.createApplication({ userId: recepientMember.id, username: recepientMember.username, type: ticketType, server, ticketId: formattedTicketNumber, channelId: ticketChannel.id, stage: 'Submitted', responses });
            await db.set(`AppMap.channelToApp.${ticketChannel.id}`, appRec.id);
            await db.set(`AppMap.ticketToApp.${formattedTicketNumber}`, appRec.id);
        }
    } catch(_){}

    // Update the bot's status to reflect the new ticket
    await module.exports.updateTicketStatus(client);
}

// Add function to update bot status
module.exports.updateTicketStatus = async function(client) {
    try {
        const staffGuild = await client.guilds.cache.get(client.config.channel_ids.staff_guild_id);
        if (!staffGuild) return;

        // Get all channels in the staff guild
        const channels = staffGuild.channels.cache;
        
        // Count channels that have a topic (indicating they are ticket channels)
        const ticketCount = channels.filter(channel => 
            channel.type === 'GUILD_TEXT' && 
            channel.topic && 
            channel.topic.match(/^\d{17,19}$/) // Check if topic is a Discord ID
        ).size;

        // Set metrics gauge
        try { metrics.setOpenTickets(ticketCount); } catch (_) {}

        // Get activity configuration from config
        const activityConfig = client.config.activityInfo;
        const activityType = activityConfig.type || 'WATCHING';
        
        // If there's only one message, use it directly
        if (activityConfig.messages.length === 1) {
            const message = activityConfig.messages[0].replace(/{count}/g, ticketCount);
            await client.user.setActivity(message, { type: activityType });
            return;
        }

        // If there are multiple messages, cycle through them
        if (!client.currentStatusIndex) {
            client.currentStatusIndex = 0;
        }

        // Get current message and replace {count} with actual count
        const currentMessage = activityConfig.messages[client.currentStatusIndex].replace(/{count}/g, ticketCount);
        await client.user.setActivity(currentMessage, { type: activityType });

        // Move to next message
        client.currentStatusIndex = (client.currentStatusIndex + 1) % activityConfig.messages.length;

        // Set up periodic updates if cycleTimeinSeconds is configured and interval doesn't exist
        if (activityConfig.cycleTimeinSeconds && !client.statusUpdateInterval) {
            client.statusUpdateInterval = setInterval(async () => {
                // Only update if we have multiple messages to cycle through
                if (activityConfig.messages.length > 1) {
                    await module.exports.updateTicketStatus(client).catch(error => {
                        func.handle_errors(error, client, 'functions.js', null);
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
        // removed debug marker
        // Check if the channel still exists and is accessible
        if (!channel || !channel.guild || !client.channels.cache.has(channel.id)) {
            // removed debug
            // Optionally log or notify that the channel is gone
            return;
        }
        // Fetch pinned message for ticket info
        let myPins;
        try {
            myPins = await channel.messages.fetchPinned();
        } catch (err) {
            // removed debug
            return;
        }
        const LastPin = myPins.last();
        if (!LastPin || !LastPin.embeds[0] || !LastPin.embeds[0].footer || !LastPin.embeds[0].footer.text) {
            // removed debug
            return;
        }
        // Parse ticket info
        const embed = LastPin.embeds[0];
        const footerParts = embed.footer.text.split("|");
        const idParts = footerParts[0].trim().split('-');
        let ticketType = footerParts[1]?.trim() || 'Unknown';
        if (ticketType.includes('#')) {
            ticketType = ticketType.split('#')[0].trim();
        }
        const globalTicketNumber = idParts[1] || 'Unknown';
        const DiscordID = idParts[0];
        // removed debug
        // Get user
        const user = await client.users.fetch(DiscordID).catch(() => null);
        if (!user) {
            // removed debug
        }
        // Get config for ticket type
        const handlerRaw = require("../content/handler/options.json");
        const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == ticketType.toLowerCase());
        if (!found) {
            // removed debug
            return;
        }
        let typeFile = require(`../content/questions/${handlerRaw.options[found].question_file}`);
        if (!typeFile) {
            // removed debug
            return;
        }
        const transcriptChannel = typeFile[`transcript-channel`];
        const logs_channel = await channel.guild.channels.cache.find(x => x.id === transcriptChannel);
        // removed debug
        // Prepare reason
        const reasonBlock = reason ? `\




${reason}` : 'No Reason Provided.';
        // Prepare embed
        embed.setAuthor({
            name: client.config.bot_settings.close_ticket_author_prefix
                ? client.config.bot_settings.close_ticket_author_prefix.replace('{{ADMIN}}', staffMember.username || staffMember.user?.username)
                : `Ticket Closed by ${staffMember.username || staffMember.user?.username}`,
            iconURL: staffMember.displayAvatarURL ? staffMember.displayAvatarURL() : client.user.displayAvatarURL()
        });
        embed.addFields({
            name: typeFile["close-transcript-embed-reason-title"] || "Close Reason",
            value: reasonBlock,
            inline: true
        });
        embed.addFields({
            name: typeFile["close-transcript-embed-response-title"] || "Response Time",
            value: `\




${await module.exports.convertMsToTime(Date.now() - embed.timestamp)}`,
            inline: true
        });
        // Log to transcript channel
        if (logs_channel) {
            await logs_channel.send({embeds: [embed]}).catch(e => module.exports.handle_errors(e, client, "functions.js", null));
        }

        const transcript = require("./fetchTranscript.js");
        let savedTranscriptURL = null;
        // Collect IDs of staff -> user messages during session (anon or not)
        const allowedIds = [];
        try {
            const recent = await channel.messages.fetch({ limit: 50 });
            recent.forEach(m => {
                if (m.author?.id === client.user.id) return; // skip bot markers
                // Include explicit recent staff-to-user signals by prefix commands or our own markers
                const isAnonCmd = typeof m.content === 'string' && m.content.startsWith('!r');
                const isStaffEmbed = m.embeds && m.embeds[0] && m.embeds[0].author && /Sent to user/i.test(m.embeds[0].author.name || '');
                if (isAnonCmd || isStaffEmbed) allowedIds.push(m.id);
            });
        } catch (_) {}

        const transcriptResult = await transcript.fetch(channel, {
            channel: channel,
            numberOfMessages: 99,
            dateFormat: "MMM Do YYYY, h:mm:ss a",
            dateLocale: "en",
            DiscordID: DiscordID,
            closeReason: reason,
            closedBy: staffMember.username || staffMember.user?.username,
            responseTime: await module.exports.convertMsToTime(Date.now() - embed.timestamp)
        });
        await (async (data) => {
            if (!data) return;

            const { enabled, save_path, base_url } = client.config.transcript_settings;
            if (enabled) {
                if (!fs.existsSync(save_path)) {
                    fs.mkdirSync(save_path, { recursive: true });
                }
                try {
                    const filePathFull = `${save_path}/${channel.name}.full.html`;
                    fs.writeFileSync(filePathFull, data);
                } catch (e) {
                    // removed debug
                }
                const transcriptURL = `${base_url}${channel.name}.full.html`;
                // Also generate a user-facing transcript
                const userData = await transcript.fetch(channel, {
                    channel: channel,
                    numberOfMessages: 99,
                    dateFormat: "MMM Do YYYY, h:mm:ss a",
                    dateLocale: "en",
                    DiscordID: DiscordID,
                    filterMode: 'user',
                    allowedMessageIds: allowedIds,
                    isAnonTicket: !!typeFile["anonymous-only-replies"],
                    closeReason: reason,
                    closedBy: staffMember.username || staffMember.user?.username,
                    responseTime: await module.exports.convertMsToTime(Date.now() - embed.timestamp)
                });
                if (userData) {
                    try {
                        const filePathUser = `${save_path}/${channel.name}.html`;
                        fs.writeFileSync(filePathUser, userData);
                    } catch (e) {
                        // removed debug
                    }
                }
                // Save staff thread transcript
                try {
                    let staffThread = channel.threads.cache.find(t => t.name === `staff-chat-${globalTicketNumber}`);
                    if (!staffThread && channel.threads && channel.threads.fetchActive) {
                        const fetched = await channel.threads.fetchActive().catch(() => null);
                        if (fetched && fetched.threads) {
                            staffThread = fetched.threads.find(t => t.name === `staff-chat-${globalTicketNumber}`);
                        }
                    }
                    if (staffThread) {
                        const staffData = await transcript.fetch(staffThread, {
                            channel: staffThread,
                            numberOfMessages: 99,
                            dateFormat: "MMM Do YYYY, h:mm:ss a",
                            dateLocale: "en",
                            DiscordID: DiscordID,
                        });
                        if (staffData) {
                            const staffPath = `${save_path}/${channel.name}.staff.html`;
                            fs.writeFileSync(staffPath, staffData);
                        }
                    }
                } catch (e) {
                    // removed debug
                }
                savedTranscriptURL = transcriptURL;
                await func.closeDataAddDB(DiscordID, globalTicketNumber, 'closed', staffMember.user.username, staffMember.id, Date.now(), reason, transcriptURL);
                try { 
                    const staffUsername = staffMember.user?.username || staffMember.username || 'unknown';
                    metrics.ticketClosed(ticketType, staffMember.id || staffMember.user?.id || staffMember.username, staffUsername); 
                } catch (_) {}
                if (logs_channel) {
                    const file = new Discord.MessageAttachment(data, `${channel.name}.full.html`);
                    logs_channel.send({ content: `Transcript saved: <${transcriptURL}>`, files: [file] }).catch(e => func.handle_errors(e, client, "functions.js", null));
                }
            } else {
                const file = new Discord.MessageAttachment(data, `${channel.name}.full.html`);
                if (logs_channel) logs_channel.send({ files: [file] }).catch(e => func.handle_errors(e, client, "functions.js", null));
            }
        })(transcriptResult);
        // After transcript generation, compute metrics
        try {
            const metrics = require('./metrics');
            const footerParts = embed.footer.text.split("|");
            let ticketType = footerParts[1]?.trim() || 'Unknown';
            if (ticketType.includes('#')) ticketType = ticketType.split('#')[0].trim();
            const responsesText = await db.get(`PlayerStats.${DiscordID}.ticketLogs.${globalTicketNumber}.responses`) || '';
            let server = 'none';
            const m = typeof responsesText === 'string' && responsesText.match(/\*\*Server:\*\*\n(.*?)(?:\n\n|$)/);
            if (m && m[1]) server = m[1];
            const openedAt = embed.timestamp ? new Date(embed.timestamp).getTime() : null;
            const durationSec = openedAt ? Math.floor((Date.now() - openedAt) / 1000) : 0;
            let messageCount = 0;
            let userMessages = 0;
            let staffMessages = 0;
            try {
                const fetched = await channel.messages.fetch({ limit: 100 });
                messageCount = fetched ? fetched.size : 0;
                fetched?.forEach(msg => {
                    if (!msg.author) return;
                    if (msg.author.bot) {
                        // Bot messages are often staff relays or system; count as staff
                        staffMessages++;
                    } else if (msg.author.id === DiscordID) {
                        userMessages++;
                    } else {
                        // Messages from guild members (not the user) are staff
                        staffMessages++;
                    }
                });
            } catch (_) {}
            const scope = typeFile && typeFile.internal ? 'internal' : 'public';
            metrics.recordTicketAggregates(ticketType, server, durationSec, messageCount, userMessages, staffMessages, DiscordID, user?.username || 'unknown', scope);
        } catch (_) {}
        // removed debug
        // DM user
        if (typeFile.send_close_dm !== false) {
            let reply = `Your ticket (#${globalTicketNumber}) has been closed.\nReason: ${reason}`;
            if (client.config.transcript_settings?.base_url) {
                const userUrl = `${client.config.transcript_settings.base_url}${channel.name}.html`;
                reply += `\n\nView your transcript: <${userUrl}>`;
            }
            let sentMsg = null;
            try { sentMsg = await user.send(reply); } catch (e) { /* ignore DM failures silently */ }
            // Extra safety: try suppressing embeds in case Discord still attempts a preview
            try { if (sentMsg && sentMsg.suppressEmbeds) await sentMsg.suppressEmbeds(true); } catch (_) {}
        }
        // Update ticket count
        await module.exports.updateTicketStatus(client);
        
        const thread = channel.threads.cache.find(t => t.name === `staff-chat-${globalTicketNumber}`);
        if (thread) {
            await thread.setArchived(true, 'Ticket closed.');
        }

        // Delete channel after a short delay
        setTimeout(async () => {
            try {
                await channel.delete();
            } catch (err) {
                module.exports.handle_errors(err, client, "functions.js", `Failed to delete ticket channel ${channel.name}(${channel.id})`);
            }
        }, 1000);
    } catch (err) {
        module.exports.handle_errors(err, client, "functions.js", `Error in closeTicket for channel ${channel.name}(${channel.id})`);
    }
};
