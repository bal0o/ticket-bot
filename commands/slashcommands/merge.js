const { SlashCommandBuilder } = require('@discordjs/builders');
const func = require('../../utils/functions.js');
const perms = require('../../utils/permissions.js');

function memberCanMergeTicket(interaction, ticketType, client) {
    const qf = perms.getQuestionFileForType(ticketType);
    const explicitRoles = Array.isArray(qf?.['access-role-id']) ? qf['access-role-id'].filter(Boolean) : [];
    if (explicitRoles.length === 0) return true;
    const userRoleIds = interaction.member?.roles?.cache ? Array.from(interaction.member.roles.cache.keys()) : [];
    return perms.userHasAccessToTicketType({
        userRoleIds,
        ticketType,
        config: client.config,
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('merge')
        .setDescription('Merge other open tickets of this type into the current ticket.'),
    async execute(interaction, client) {
        await interaction.deferReply({ flags: func.EPHEMERAL });
        const channel = interaction.channel;
        if (!channel.topic || !/^\d{17,19}$/.test(channel.topic)) {
            return interaction.editReply('This is not a valid ticket channel.');
        }

        const ticketType = await func.resolveTicketTypeFromChannel(channel);
        if (!ticketType) {
            return interaction.editReply('Could not determine this ticket type.');
        }
        if (!perms.ticketTypeAllowsMerges(ticketType)) {
            return interaction.editReply('This ticket type cannot be merged.');
        }
        if (!memberCanMergeTicket(interaction, ticketType, client)) {
            return interaction.editReply('You do not have permission to merge this ticket type.');
        }

        const candidates = await func.listOpenTicketsOfType(channel.guild, ticketType, channel.id);
        if (!candidates.length) {
            return interaction.editReply(`No other open ${ticketType} tickets found to merge.`);
        }

        const { content, components } = func.buildMergeSelectComponents(candidates, 0);
        await interaction.editReply({ content, components });
    }
};
