const { SlashCommandBuilder } = require('@discordjs/builders');
const func = require('../../utils/functions.js');
const perms = require('../../utils/permissions.js');
const { createDB } = require('../../utils/quickdb');
const db = createDB();
const handlerRaw = require('../../content/handler/options.json');
const { Modal, TextInputComponent, MessageActionRow } = require('discord.js');

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
            await channel.setParent(categoryId);
            await channel.setName(newChannelName);
            // Rebuild permission overwrites based on new ticket type
            const overwrites = perms.buildPermissionOverwritesForTicketType({ client, guild: channel.guild, ticketType });
            if (Array.isArray(overwrites) && overwrites.length > 0) {
                await channel.permissionOverwrites.set(overwrites);
            }
        } catch (error) {
            renameSucceeded = false;
            func.handle_errors(error, client, 'move.js', null);
            await channel.send("⚠️ I couldn't rename or move this ticket channel. Please check permissions or try again later. Ticket actions will still work, but the name may be wrong.").catch(() => {});
        }
        // Update the pinned embed's title and footer to match the new ticket type
        const myPins = await channel.messages.fetchPinned();
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

            // Update stored ticket type in DB for web permission consistency
            try {
                const userId = idParts[0];
                const ticketNum = idParts[1];
                if (userId && ticketNum) {
                    await db.set(`PlayerStats.${userId}.ticketLogs.${ticketNum}.ticketType`, ticketType);
                }
            } catch (e) { func.handle_errors(e, client, 'move.js', 'Failed to update DB ticketType on move'); }
        }
        // Check for required fields in the new ticket type (e.g., server selection)
        if (questionFilesystem.server_selection && questionFilesystem.server_selection.enabled) {
            // Check if the pinned embed has a field for server selection
            const myPins = await channel.messages.fetchPinned();
            const LastPin = myPins.last();
            let hasServerField = false;
            if (LastPin && LastPin.embeds[0]) {
                const embed = LastPin.embeds[0];
                hasServerField = embed.fields && embed.fields.some(f => f.name.toLowerCase().includes('server'));
            }
            if (!hasServerField) {
                // Prompt staff for the required server selection
                const modal = new Modal()
                    .setCustomId('moveServerModal')
                    .setTitle('Provide Required Server');
                const serverInput = new TextInputComponent()
                    .setCustomId('serverInput')
                    .setLabel('Which server should be set for this ticket?')
                    .setStyle('SHORT')
                    .setRequired(true);
                const firstActionRow = new MessageActionRow().addComponents(serverInput);
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
        // Notify staff roles for the target ticket type
        try {
            const pingRoleIDs = Array.isArray(questionFilesystem['ping-role-id']) ? questionFilesystem['ping-role-id'].filter(Boolean) : [];
            if (pingRoleIDs.length > 0) {
                const tags = pingRoleIDs.map(id => `<@&${id}>`).join(' ');
                await channel.send({
                    content: `${tags}\nTicket moved to ${ticketType}.`,
                    allowedMentions: { parse: [], roles: pingRoleIDs }
                }).catch(() => {});
            }
        } catch (_) {}
        await interaction.editReply(`Ticket moved to ${ticketType}${renameSucceeded ? '' : ' (with errors)'}.`);
    }
}; 