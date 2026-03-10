const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { createDB } = require('../../utils/mysql');

const db = createDB();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('staffapps')
        .setDescription('Enable, disable, or check status of the Staff Application button.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub
                .setName('enable')
                .setDescription('Enable the Staff Application button for users'))
        .addSubcommand(sub =>
            sub
                .setName('disable')
                .setDescription('Disable the Staff Application button for users'))
        .addSubcommand(sub =>
            sub
                .setName('status')
                .setDescription('Show whether the Staff Application button is currently enabled')),

    async execute(interaction, client) {
        const sub = interaction.options.getSubcommand();
        const key = 'FeatureFlags.StaffApplications.Enabled';

        if (sub === 'status') {
            let enabled = await db.get(key);
            if (enabled === null || enabled === undefined) {
                enabled = !!client.config.bot_settings.staff_applications_enabled;
            }
            return interaction.reply({
                content: `Staff applications are currently **${enabled ? 'ENABLED' : 'DISABLED'}**.`,
                ephemeral: true
            });
        }

        const enable = sub === 'enable';
        try {
            await db.set(key, enable);
        } catch (_) {}

        return interaction.reply({
            content: `Staff application button has been **${enable ? 'ENABLED' : 'DISABLED'}**.`,
            ephemeral: true
        });
    }
};

