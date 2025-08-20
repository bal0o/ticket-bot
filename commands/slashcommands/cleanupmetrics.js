const { SlashCommandBuilder } = require('discord.js');
const metrics = require('../../utils/metrics');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('cleanupmetrics')
        .setDescription('Clean up incorrect role IDs from metrics database')
        .setDefaultMemberPermissions(0x8), // Administrator only
    
    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            
            console.log(`[CleanupMetrics] Manual cleanup triggered by ${interaction.user.tag} (${interaction.user.id})`);
            
            // Run the cleanup
            await metrics.cleanupRoleIds(interaction.client);
            
            await interaction.editReply({
                content: '✅ Metrics cleanup completed! Check the console for detailed information.',
                ephemeral: true
            });
            
        } catch (error) {
            console.error('[CleanupMetrics] Error:', error);
            await interaction.editReply({
                content: '❌ Error during metrics cleanup. Check the console for details.',
                ephemeral: true
            }).catch(() => {});
        }
    },
};
