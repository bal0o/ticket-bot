const { SlashCommandBuilder } = require('@discordjs/builders');
const Discord = require('discord.js');
const func = require('../../utils/functions.js');
const responses = require('../../content/response.json');

// Build a flat list of all responses for autocomplete
function buildResponseList() {
    const responseList = [];
    for (const [category, categoryResponses] of Object.entries(responses)) {
        for (const [responseKey, responseText] of Object.entries(categoryResponses)) {
            const categoryDisplay = category.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const responseDisplay = responseKey.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            responseList.push({
                name: `${categoryDisplay}: ${responseDisplay}`,
                value: `${category}:${responseKey}`,
                description: responseText.substring(0, 100).replace(/{greeting}|{player}|{ack}/g, '...')
            });
        }
    }
    return responseList;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reply')
        .setDescription('Send a standard response to the ticket.')
        .addStringOption(option =>
            option.setName('response')
                .setDescription('Select a standard response to send')
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
        
        // Get the selected response
        const responseValue = interaction.options.getString('response');
        if (!responseValue || !responseValue.includes(':')) {
            return interaction.editReply('Invalid response selected.');
        }
        
        const [category, responseKey] = responseValue.split(':');
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
        const focusedValue = interaction.options.getFocused();
        const responseList = buildResponseList();
        
        // Filter responses based on user input, or show all if no input
        let filtered;
        if (!focusedValue || focusedValue.trim() === '') {
            filtered = responseList.slice(0, 25);
        } else {
            filtered = responseList
                .filter(response => 
                    response.name.toLowerCase().includes(focusedValue.toLowerCase()) ||
                    response.description.toLowerCase().includes(focusedValue.toLowerCase())
                )
                .slice(0, 25); // Discord limit is 25 choices
        }
        
        await interaction.respond(
            filtered.map(response => ({
                name: response.name,
                value: response.value
            }))
        );
    }
};

