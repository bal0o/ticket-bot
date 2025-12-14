const { SlashCommandBuilder } = require('@discordjs/builders');
const Discord = require('discord.js');
const func = require('../../utils/functions.js');
const responses = require('../../content/response.json');

// Format category name for display
function formatCategoryName(category) {
    return category.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// Format response name for display
function formatResponseName(responseKey) {
    return responseKey.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reply')
        .setDescription('Send a standard response to the ticket.')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('Select a response category')
                .setRequired(true)
                .setAutocomplete(true))
        .addStringOption(option =>
            option.setName('response')
                .setDescription('Select a response from the category')
                .setRequired(true)
                .setAutocomplete(true)),
    async execute(interaction, client) {
        const channel = interaction.channel;
        
        // Check if this is a valid ticket channel
        if (!channel.topic || !/^\d{17,19}$/.test(channel.topic)) {
            return interaction.reply({ content: 'This is not a valid ticket channel.', ephemeral: true });
        }
        
        // Get the user ID from channel topic
        const userId = channel.topic;
        
        // Fetch the user to get their username
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) {
            return interaction.reply({ content: 'Could not find the user for this ticket.', ephemeral: true });
        }
        
        // Get greeting and ack from config, with defaults
        const greeting = client.config.active_ticket_settings?.greeting || 'Hey';
        const ack = client.config.active_ticket_settings?.ack || 'Thanks';
        
        // Get the selected category and response
        const category = interaction.options.getString('category');
        const responseKey = interaction.options.getString('response');
        
        if (!category || !responseKey) {
            return interaction.reply({ content: 'Please select both category and response.', ephemeral: true });
        }
        
        const responseText = responses[category]?.[responseKey];
        
        if (!responseText) {
            return interaction.reply({ content: 'Response not found.', ephemeral: true });
        }
        
        // Replace placeholders
        let preFilledResponse = responseText
            .replace(/{greeting}/g, greeting)
            .replace(/{player}/g, user.username)
            .replace(/{ack}/g, ack);
        
        // Store context for modal submission
        client.replyContext = client.replyContext || new Map();
        client.replyContext.set(interaction.user.id, {
            channelId: channel.id,
            userId: userId,
            username: user.username,
            greeting: greeting,
            ack: ack
        });
        
        // Create and show modal for editing
        const replyModal = new Discord.Modal()
            .setCustomId('replyStandardResponse')
            .setTitle('Edit Standard Response');
        
        const replyInput = new Discord.TextInputComponent()
            .setCustomId('replyText')
            .setLabel('Response (editable)')
            .setStyle('PARAGRAPH')
            .setRequired(true)
            .setValue(preFilledResponse.substring(0, 4000)); // Discord modal limit is 4000 chars
        
        const firstActionRow = new Discord.MessageActionRow().addComponents(replyInput);
        replyModal.addComponents(firstActionRow);
        
        await interaction.showModal(replyModal);
    },
    async autocomplete(interaction, client) {
        const focusedOption = interaction.options.getFocused(true);
        const focusedValue = focusedOption.value;
        
        if (focusedOption.name === 'category') {
            // Autocomplete for categories
            const categories = Object.keys(responses);
            let filtered;
            
            if (!focusedValue || focusedValue.trim() === '') {
                filtered = categories.slice(0, 25);
            } else {
                filtered = categories
                    .filter(cat => 
                        formatCategoryName(cat).toLowerCase().includes(focusedValue.toLowerCase()) ||
                        cat.toLowerCase().includes(focusedValue.toLowerCase())
                    )
                    .slice(0, 25);
            }
            
            await interaction.respond(
                filtered.map(category => ({
                    name: formatCategoryName(category),
                    value: category
                }))
            );
        } else if (focusedOption.name === 'response') {
            // Autocomplete for responses within the selected category
            const selectedCategory = interaction.options.getString('category');
            
            if (!selectedCategory || !responses[selectedCategory]) {
                // If no category selected yet, return empty
                await interaction.respond([]);
                return;
            }
            
            const categoryResponses = responses[selectedCategory];
            const responseKeys = Object.keys(categoryResponses);
            
            let filtered;
            if (!focusedValue || focusedValue.trim() === '') {
                filtered = responseKeys.slice(0, 25);
            } else {
                filtered = responseKeys
                    .filter(key => 
                        formatResponseName(key).toLowerCase().includes(focusedValue.toLowerCase()) ||
                        key.toLowerCase().includes(focusedValue.toLowerCase()) ||
                        categoryResponses[key].toLowerCase().includes(focusedValue.toLowerCase())
                    )
                    .slice(0, 25);
            }
            
            await interaction.respond(
                filtered.map(key => ({
                    name: formatResponseName(key),
                    value: key,
                    description: categoryResponses[key].substring(0, 100).replace(/{greeting}|{player}|{ack}/g, '...')
                }))
            );
        }
    }
};

