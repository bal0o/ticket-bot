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
        const ack = client.config.active_ticket_settings?.ack || 'Thanks';
        
        // Get the selected category and response
        const category = interaction.options.getString('category');
        const responseKey = interaction.options.getString('response');
        
        if (!category || !responseKey) {
            return interaction.editReply('Please select both category and response.');
        }
        
        const responseText = responses[category]?.[responseKey];
        
        if (!responseText) {
            return interaction.editReply('Response not found.');
        }
        
        // Replace placeholders
        let finalResponse = responseText
            .replace(/{greeting}/g, greeting)
            .replace(/{player}/g, user.username)
            .replace(/{ack}/g, ack);
        
        // Send the message to the ticket channel
        await channel.send(finalResponse);
        
        await interaction.editReply('Response sent successfully!');
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

