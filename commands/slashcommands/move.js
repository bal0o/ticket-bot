const { SlashCommandBuilder } = require('@discordjs/builders');
const func = require('../../utils/functions.js');
const perms = require('../../utils/permissions.js');
const { createDB } = require('../../utils/mysql');
const db = createDB();
const handlerRaw = require('../../content/handler/options.json');
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ChannelType } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('move')
        .setDescription('Move this ticket to a different ticket type/category.')
        .addStringOption(option =>
            option.setName('ticket_type')
                .setDescription('The ticket type to move this ticket to')
                .setRequired(true)
                .addChoices(...Object.keys(handlerRaw.options).map(type => ({ name: type, value: type })))),
    async execute(interaction, client) {
        await interaction.deferReply({ ephemeral: true });
        const channel = interaction.channel;
        if (!channel.topic || !/^\d{17,19}$/.test(channel.topic)) {
            return interaction.editReply('This is not a valid ticket channel.');
        }
        const ticketType = interaction.options.getString('ticket_type');
        const found = Object.keys(handlerRaw.options).find(x => x.toLowerCase() == ticketType.toLowerCase());
        if (!found) {
            return interaction.editReply('Invalid ticket type.');
        }
        const validOption = handlerRaw.options[found];
        const questionFilesystem = require(`../../content/questions/${validOption.question_file}`);
        // Find the category ID for the new ticket type
        const categoryId = questionFilesystem['ticket-category'];
        if (!categoryId) {
            return interaction.editReply('No category configured for this ticket type.');
        }
        let category = channel.guild.channels.cache.get(categoryId);
        if (!category) {
            try {
                category = await channel.guild.channels.fetch(categoryId);
            } catch (_) {
                return interaction.editReply('Configured category for this ticket type was not found.');
            }
        }
        if (!category || category.type !== ChannelType.GuildCategory) {
            return interaction.editReply('Configured category for this ticket type was not found.');
        }
        // Build new channel name and embed title
        const nameParts = channel.name.split('-');
        let serverName = null;
        let ticketNumber = null;
        // Find the ticket number (it's always the last part)
        ticketNumber = nameParts[nameParts.length - 1];
        // If there are more than 2 parts, the first part is the server name
        if (nameParts.length > 2) {
            serverName = nameParts[0];
        }
        let newTitle = `${ticketType} #${ticketNumber}`;
        let newFooter = '';
        let newChannelName = '';
        if (questionFilesystem.server_selection && questionFilesystem.server_selection.enabled) {
            // If server selection is required, keep serverName if present
            newChannelName = serverName ? `${serverName}-${ticketType.toLowerCase()}-${ticketNumber}` : `${ticketType.toLowerCase()}-${ticketNumber}`;
        } else {
            // If not required, drop serverName
            newChannelName = `${ticketType.toLowerCase()}-${ticketNumber}`;
        }
        // Move, rename, and reapply permissions for target ticket type
        let renameSucceeded = true;
        try {
            await channel.setParent(categoryId, { lockPermissions: true });
            await channel.setName(newChannelName);
            // Rebuild permission overwrites based on new ticket type
            const overwrites = perms.buildPermissionOverwritesForTicketType({
                client,
                guild: channel.guild,
                ticketType,
                category
            });
            if (Array.isArray(overwrites) && overwrites.length > 0) {
                await channel.permissionOverwrites.set(overwrites);
            }
        } catch (error) {
            renameSucceeded = false;
            func.handle_errors(error, client, 'move.js', null);
            await channel.send("⚠️ I couldn't rename or move this ticket channel. Please check permissions or try again later. Ticket actions will still work, but the name may be wrong.").catch(() => {});
        }
        // Update the pinned embed's title and footer to match the new ticket type
        const myPins = await func.fetchPinnedSafe(channel);
        const LastPin = myPins.last();
        if (LastPin && LastPin.embeds[0]) {
            const embed = LastPin.embeds[0];
            // Update title
            embed.setTitle(newTitle);
            // Update footer
            const footerParts = embed.footer.text.split("|");
            const idParts = footerParts[0].trim().split('-');
            const userId = idParts[0];
            const ticketNum = idParts[1];
            let footerTicketType = ticketType;
            // Always split on # and use only the part before for the footer
            if (footerTicketType.includes('#')) {
                footerTicketType = footerTicketType.split('#')[0].trim();
            }
            newFooter = `${userId}-${ticketNum} | ${footerTicketType} | Ticket Opened:`;
            embed.setFooter({text: newFooter, iconURL: client.user.displayAvatarURL()});
            await LastPin.edit({embeds: [embed]}).catch(e => func.handle_errors(e, client, 'move.js', null));

            // Update stored ticket type in MySQL tickets table for web permission consistency
            try {
                const userId = idParts[0];
                const ticketNum = idParts[1];
                if (userId && ticketNum && typeof db.query === 'function') {
                    await db.query(
                        'UPDATE tickets SET ticket_type = ? WHERE user_id = ? AND ticket_id = ?',
                        [ticketType, userId, ticketNum]
                    );
                }
            } catch (e) { func.handle_errors(e, client, 'move.js', 'Failed to update MySQL ticketType on move'); }
        }
        // Check for required fields in the new ticket type (e.g., server selection)
        if (questionFilesystem.server_selection && questionFilesystem.server_selection.enabled) {
            // Check if the pinned embed has a field for server selection
            const myPins = await func.fetchPinnedSafe(channel);
            const LastPin = myPins.last();
            let hasServerField = false;
            if (LastPin && LastPin.embeds[0]) {
                const embed = LastPin.embeds[0];
                hasServerField = embed.fields && embed.fields.some(f => f.name.toLowerCase().includes('server'));
            }
            if (!hasServerField) {
                // Prompt staff for the required server selection
                const modal = new ModalBuilder()
                    .setCustomId('moveServerModal')
                    .setTitle('Provide Required Server');
                const serverInput = new TextInputBuilder()
                    .setCustomId('serverInput')
                    .setLabel('Which server should be set for this ticket?')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                const firstActionRow = new ActionRowBuilder().addComponents(serverInput);
                modal.addComponents(firstActionRow);
                await interaction.showModal(modal);
                // Save context for after modal submission
                client.moveTicketContext = {
                    channelId: channel.id,
                    ticketType,
                    categoryId,
                    newName: newChannelName
                };
                return;
            }
        }
        const deliveryWarnings = [];

        // Notify staff roles for the target ticket type
        try {
            const pingRoleIDs = Array.isArray(questionFilesystem['ping-role-id']) ? questionFilesystem['ping-role-id'].filter(Boolean) : [];
            if (pingRoleIDs.length > 0) {
                const tags = pingRoleIDs.map(id => `<@&${id}>`).join(' ');
                await channel.send({
                    content: `${tags}\nTicket moved to ${ticketType}.`,
                    allowedMentions: { parse: [], roles: pingRoleIDs }
                }).catch((e) => {
                    deliveryWarnings.push(`Could not post the move notification for ${ticketType}.`);
                    func.handle_errors(e, client, 'move.js', 'Failed to send staff move notification');
                });
            }
        } catch (e) {
            deliveryWarnings.push(`Could not prepare the move notification for ${ticketType}.`);
            func.handle_errors(e, client, 'move.js', 'Error preparing move notification');
        }

        // DM the ticket owner about the move and surface failures to staff
        const topicUser = channel.topic;
        if (topicUser) {
            const user = await client.users.fetch(topicUser).catch(() => null);
            if (user) {
                try {
                    await func.sendDMWithRetry(
                        user,
                        `Your ticket (${renameSucceeded ? newChannelName : channel.name}) has been moved to ${ticketType}.`,
                        { maxAttempts: 2, baseDelayMs: 500 }
                    );
                } catch (dmError) {
                    deliveryWarnings.push(`Could not DM <@${user.id}> about this move.`);
                    func.handle_errors(dmError, client, 'move.js', 'Failed to DM user after moving ticket');
                }
            } else {
                deliveryWarnings.push(`Could not resolve the ticket owner (<@${topicUser}>) to DM them about this move.`);
            }
        } else {
            deliveryWarnings.push('Could not DM the ticket owner because this channel has no ticket owner in its topic.');
        }

        if (deliveryWarnings.length > 0) {
            await channel.send({
                content: `⚠️ Move completed, but some notifications failed:\n- ${deliveryWarnings.join('\n- ')}`
            }).catch(e => func.handle_errors(e, client, 'move.js', 'Failed to send delivery warning to ticket channel'));
            await interaction.editReply(
                `Ticket moved to ${ticketType}${renameSucceeded ? '': ' (with errors)'}, but some notifications failed:\n- ${deliveryWarnings.join('\n- ')}`
            );
            return;
        }

        await interaction.editReply(`Ticket moved to ${ticketType}${renameSucceeded ? '' : ' (with errors)'}.`);
    }
}; 