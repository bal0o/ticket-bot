const { SlashCommandBuilder } = require('@discordjs/builders');
const Discord = require('discord.js');
const func = require('../../utils/functions.js');
const responses = require('../../content/response.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reply')
        .setDescription('Send a standard response to the ticket.'),
    async execute(interaction, client) {
        await interaction.deferReply({ ephemeral: true });
        
        const channel = interaction.channel;
        
        // Check if this is a valid ticket channel
        if (!channel.topic || !/^\d{17,19}$/.test(channel.topic)) {
            return interaction.editReply('This is not a valid ticket channel.');
        }
        
        // Get the user ID from channel topic
        const userId = channel.topic;
        
        // Fetch the user to get their username
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) {
            return interaction.editReply('Could not find the user for this ticket.');
        }
        
        // Get greeting and ack from config, with defaults
        const greeting = client.config.active_ticket_settings?.greeting || 'Hey';
        const ack = client.config.active_ticket_settings?.ack || 'Acknowledged';
        
        // Get top-level categories from response.json
        const categories = Object.keys(responses);
        
        if (categories.length === 0) {
            return interaction.editReply('No response categories found.');
        }
        
        // Create select menu for categories
        const categoryRow = new Discord.MessageActionRow()
            .addComponents(
                new Discord.MessageSelectMenu()
                    .setCustomId('reply_select_category')
                    .setPlaceholder('Select a response category')
                    .addOptions(
                        categories.map(category => ({
                            label: category.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                            value: category,
                            description: `Select ${category} responses`
                        }))
                    )
            );
        
        // Store user info and config values for later use
        client.replyContext = client.replyContext || new Map();
        client.replyContext.set(interaction.user.id, {
            channelId: channel.id,
            userId: userId,
            username: user.username,
            greeting: greeting,
            ack: ack
        });
        
        await interaction.editReply({ 
            content: 'Select a response category:', 
            components: [categoryRow] 
        });
    }
};

