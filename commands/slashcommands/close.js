const { SlashCommandBuilder } = require('@discordjs/builders');
const func = require('../../utils/functions.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close the current ticket with an optional reason.')
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for closing the ticket')
                .setRequired(false)),
    async execute(interaction, client) {
        await interaction.deferReply({ ephemeral: true });
        const channel = interaction.channel;
        if (!channel.topic || !/^\d{17,19}$/.test(channel.topic)) {
            return interaction.editReply('This is not a valid ticket channel.');
        }
        const reason = interaction.options.getString('reason') || 'No Reason Provided.';
        await func.closeTicket(client, channel, interaction.member, reason);
        await interaction.editReply('Ticket closed.');
    }
}; 