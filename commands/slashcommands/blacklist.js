const Discord = require("discord.js");
const moment = require("moment");
const { SlashCommandBuilder } = require("@discordjs/builders")
const config = require("../../config/config.json");
const func = require("../../utils/functions.js");
const { createDB } = require('../../utils/quickdb');
const db = createDB();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('blacklist')
        .setDescription('Adds or removes a user from the ticket blacklist.')
        .addUserOption(option => option.setName('target').setDescription('Select a user you want to give a role to.').setRequired(true)),


    async execute(interaction, client) {


        await interaction.deferReply({ ephemeral: true }).catch(err => func.handle_errors(err, client, `blacklist.js`, null))
		let access = 0
		for (let blacklistrole of config.role_ids.role_ids_blacklist_cmd) {
			if (interaction.member.roles.cache.find(r => r.id === blacklistrole)) access++
		}

		if (access == 0) {
			return interaction.editReply({content:`Sorry! You can not use this command.`, ephemeral: true}).catch(err => {
				if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
				func.handle_errors(err, client, `blacklist.js`, null)
				})
		}

        let publicGuild = await client.guilds.fetch(config.channel_ids.public_guild_id).catch(err => func.handle_errors(err, client, `blacklist.js`, null))
        var member = await publicGuild.members.fetch(interaction.options._hoistedOptions[0].value).catch(err => func.handle_errors(err, client, `blacklist.js`, null))
        let role = await publicGuild.roles.fetch(config.role_ids.ticket_blacklisted_role_id).catch(err => func.handle_errors(err, client, `blacklist.js`, null))

            if (member.roles.cache.find(r => r.id === role.id)) {
                await member.roles.remove(role);
                return interaction.editReply({ content: `${member.user.username} already has the role \`${role.name}\`. Role has been removed.`, ephemeral: true }).catch(err => func.handle_errors(err, client, `blacklist.js`, null))			
            } else {
                await member.roles.add(role);
                return interaction.editReply({ content: `You added the \`${role.name}\` role to ${member.user.username}.`, ephemeral: true }).catch(err => func.handle_errors(err, client, `blacklist.js`, null))
            }
    }
}