const { SlashCommandBuilder } = require("@discordjs/builders");
const { MessageEmbed, MessageActionRow, MessageButton } = require("discord.js");
const { createDB } = require('../../utils/mysql');
const db = createDB();
const func = require("../../utils/functions.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("tickethistory")
        .setDescription("View a user's ticket history.")
        .addStringOption(option =>
            option.setName("discordid")
                .setDescription("The Discord User ID of the user.")
                .setRequired(true)),
    async execute(interaction, client) {
        try {
            const staffGuild = await client.guilds.cache.get(client.config.channel_ids.staff_guild_id);
            if (!staffGuild) {
                return interaction.reply({ content: "Error: Staff guild not configured.", ephemeral: true }).catch(console.error);
            }
            const member = await staffGuild.members.fetch(interaction.user.id).catch(() => null);

            if (!member || !member.roles.cache.has(client.config.role_ids.default_admin_role_id)) {
                return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true }).catch(console.error);
            }

            await interaction.deferReply({ ephemeral: true });

            const userId = interaction.options.getString("discordid");
            let user;
            try {
                user = await client.users.fetch(userId);
            } catch (error) {
                return interaction.editReply({ content: "Could not find a user with that ID. Please provide a valid Discord User ID." });
            }

            const userTickets = await db.get(`PlayerStats.${user.id}.ticketLogs`);

            if (!userTickets) {
                return interaction.editReply({ content: "This user has no ticket history." });
            }

            const ticketArray = Object.values(userTickets).reverse();
            const embeds = [];

            for (const [index, ticket] of ticketArray.entries()) {
                const embed = new MessageEmbed()
                    .setTitle(`Ticket #${ticket.globalTicketNumber}`)
                    .setColor(client.config.bot_settings.main_color)
                    .setFooter({ text: `Page ${index + 1} of ${ticketArray.length}` })
                    .addFields(
                        { name: "Ticket Type", value: ticket.ticketType || 'N/A', inline: true },
                        { name: "Opened At", value: ticket.createdAt ? `<t:${Math.floor(ticket.createdAt)}:f>` : 'N/A', inline: true },
                        { name: "Closed At", value: ticket.closeTime ? `<t:${Math.floor(ticket.closeTime / 1000)}:f>` : 'N/A', inline: true },
                        { name: "Closed By", value: ticket.closeUser || 'N/A', inline: true },
                        { name: "Close Reason", value: ticket.closeReason || 'N/A', inline: false }
                    );

                if (ticket.transcriptURL) {
                    embed.addFields({ name: "Transcript", value: `[View Transcript](${ticket.transcriptURL})`, inline: false });
                }

                embeds.push(embed);
            }

            if (embeds.length === 0) {
                return interaction.editReply({ content: "This user has no ticket history." });
            }

            let currentPage = 0;
            const generateButtons = () => {
                return new MessageActionRow().addComponents(
                    new MessageButton()
                        .setCustomId('prev_page')
                        .setLabel('Previous')
                        .setStyle('SUCCESS')
                        .setEmoji('⬅️')
                        .setDisabled(currentPage === 0),
                    new MessageButton()
                        .setCustomId('next_page')
                        .setLabel('Next')
                        .setStyle('SUCCESS')
                        .setEmoji('➡️')
                        .setDisabled(currentPage === embeds.length - 1)
                );
            };
            
            const message = await interaction.editReply({ embeds: [embeds[currentPage]], components: [generateButtons()], fetchReply: true });

            const collector = message.createMessageComponentCollector({ componentType: 'BUTTON', time: 120000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) {
                    return i.reply({ content: "You can't use these buttons.", ephemeral: true });
                }
                
                await i.deferUpdate();

                if (i.customId === 'prev_page') {
                    currentPage--;
                } else if (i.customId === 'next_page') {
                    currentPage++;
                }

                await interaction.editReply({ embeds: [embeds[currentPage]], components: [generateButtons()] });
            });

            collector.on('end', async () => {
                const finalButtons = new MessageActionRow().addComponents(
                    new MessageButton().setCustomId('prev_page').setLabel('Previous').setStyle('SUCCESS').setEmoji('⬅️').setDisabled(true),
                    new MessageButton().setCustomId('next_page').setLabel('Next').setStyle('SUCCESS').setEmoji('➡️').setDisabled(true)
                );
                await interaction.editReply({ components: [finalButtons] }).catch(()=>{});
            });

        } catch (error) {
            func.handle_errors(error, client, "history.js");
            const replyPayload = { content: 'An error occurred while executing the command. It has been logged.', ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(replyPayload).catch(console.error);
            } else {
                await interaction.reply(replyPayload).catch(console.error);
            }
        }
    }
};
