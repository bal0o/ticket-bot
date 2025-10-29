const Discord = require("discord.js");
const moment = require("moment");
const { SlashCommandBuilder } = require("@discordjs/builders")
const config = require("../../config/config.json");
const func = require("../../utils/functions.js");
const { createDB } = require('../../utils/mysql');
const db = createDB();

module.exports = {
	data: new SlashCommandBuilder()
		.setName('wipestats')
		.setDescription('Wipe global or individual user stats.')
		.addSubcommand(subcommand =>
			subcommand
				.setName('global')
				.setDescription('This will wipe all of your staff\'s statistics within the ticket bot.'))
		.addSubcommand(subcommand =>
			subcommand
				.setName('individual')
				.setDescription('Wipe an individual users ticket statistics within the ticket bot.')
				.addUserOption(option =>
					option.setName('user')
						.setDescription('Which user would you like to wipe of their staff stats?')
						.setRequired(true)))
		.addSubcommand(subcommand =>
			subcommand
				.setName('responsetimes')
				.setDescription('Wipe all of your response time data within the ticket bot.')),

	async execute(interaction, client) {
	
		await interaction.deferReply({ ephemeral: true }).catch(err => func.handle_errors(err, client, `wipestats.js`, null))
		let access = 0
		for (let statrole of config.role_ids.role_ids_wipestats_cmd) {
			if (interaction.member.roles.cache.find(r => r.id === statrole)) access++
		}

		if (access == 0) {
			return interaction.editReply({content:`Sorry! You can not use this command.`, ephemeral: true}).catch(err => {
				if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
				func.handle_errors(err, client, `stats.js`, null)
				})
		}

		if (interaction.options._subcommand == "global") {
			await db.get(`StaffStats`)
			await db.delete('StaffStats');

			return interaction.editReply({content:`Successfully deleted all staff statistics.`, ephemeral: true}).catch(err => {
				if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
				func.handle_errors(err, client, `wipestats.js`, null)
				})


		} else if (interaction.options._subcommand == "individual") {

			let userId = interaction.options._hoistedOptions[0].value
			await db.get(`StaffStats.${userId}`);
			await db.delete(`StaffStats.${userId}`);

				return interaction.editReply({content:`Successfully deleted statistics for <@${userId}> (${userId}).`, ephemeral: true}).catch(err => {
					if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
					func.handle_errors(err, client, `wipestats.js`, null)
					})


		} else if (interaction.options._subcommand == "responsetimes") {
			await db.get(`ServerStats.ResponseTimes`);
			await db.delete(`ServerStats.ResponseTimes`);

				return interaction.editReply({content:`Successfully deleted all response time statistics.`, ephemeral: true}).catch(err => {
					if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
					func.handle_errors(err, client, `wipestats.js`, null)
					})
		}
	}
}


