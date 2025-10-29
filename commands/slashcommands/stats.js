const Discord = require("discord.js");
const moment = require("moment");
const { SlashCommandBuilder } = require("@discordjs/builders")
const config = require("../../config/config.json");
const func = require("../../utils/functions.js");
const { createDB } = require('../../utils/mysql');
const db = createDB();

module.exports = {
	data: new SlashCommandBuilder()
		.setName('stats')
		.setDescription('Check out the ticket statistics of the org and/or individual staff members!')
		.addSubcommandGroup(subcommand =>
			subcommand
				.setName('staff')
				.setDescription('See different types of staff statistics or individual members on their own.')
 				.addSubcommand(subcommand =>
					subcommand
						.setName('top10')
						.setDescription('See the top 10 staff members overall, based on their ticket stats.')) 
				.addSubcommand(subcommand =>
					subcommand
						.setName('actiontype')
						.setDescription('See the top staff members based on their action type.')
						.addStringOption(option =>
							option.setName('type')
								.setDescription('What action type would you like to see the top stats for?')
								.setRequired(true)
								.addChoices(
									{ name: 'Auto Approval', value: 'autoapproval' },
									{ name: 'Auto Denial', value: 'autodenial' },
									{ name: 'Custom Responses', value: 'customresponses' },
									{ name: 'Ticket Opening', value: 'ticketopening' },
									{ name: 'Ticket Closing', value: 'ticketclosing' },
									{ name: 'Ticket Messages (Hidden)', value: 'ticketmessageshidden' },
									{ name: 'Ticket Messages (Visible)', value: 'ticketmessagesvisible' },
									))
								)
				.addSubcommand(subcommand =>
					subcommand
						.setName('individual')
						.setDescription('See an individual staff members stats.')
						.addUserOption(option =>
							option.setName('user')
								.setDescription('Which user would you like to look up stats for?')
								.setRequired(true)))		
						)

		.addSubcommandGroup(subcommand =>
			subcommand
				.setName('org')
				.setDescription('See org based statistics.')
				.addSubcommand(subcommand =>
					subcommand
						.setName('responsetimes')
						.setDescription('See the overall response times of your org.'))
				.addSubcommand(subcommand =>
					subcommand
						.setName('totaltickets')
						.setDescription('See the overall count of tickets for your org.'))),

	async execute(interaction, client) {
	
		await interaction.deferReply({ ephemeral: true }).catch(err => func.handle_errors(err, client, `stats.js`, null))
		let access = 0
		for (let statrole of config.role_ids.role_ids_stats_cmd) {
			if (interaction.member.roles.cache.find(r => r.id === statrole)) access++
		}

		if (access == 0) {
			return interaction.editReply({content:`Sorry! You can not use this command.`, ephemeral: true}).catch(err => {
				if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
				func.handle_errors(err, client, `stats.js`, null)
				})
		}
		
		function compare(a, b) {
			if (a.Count > b.Count) {
				return -1;
			}
			if (a.Count < b.Count) {
				return 1;
			}
			return 0;
		}

		if (interaction.options._group == "staff") {

			let userStats = await db.get(`StaffStats`);
			if (userStats == null) {

				return interaction.editReply({content:`Sorry, there is no data available at this time!`, ephemeral: true}).catch(err => {
					if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
					func.handle_errors(err, client, `stats.js`, null)
					})
			}
			if (interaction.options._subcommand == "top10") {

				let users = [];

				for (let eachUser of Object.keys(userStats)) {	

						let userFinal = {
							ID: eachUser,
							Count: userStats?.[`${eachUser}`].totalActions
						}

						users.push(userFinal)	
				}

                let usersSorted = users.sort(compare);
				let usersSortedSliced = usersSorted.slice(0, 9);
				let i = 1
				let statsDesc = ""
				const StatsEmbed = new Discord.MessageEmbed()
				.setAuthor({name: `Ticket Statistics - Top 10 Staff Members`, iconURL: client.user.displayAvatarURL()})
				.setColor(config.bot_settings.main_color)

				for (let singleUser of usersSortedSliced) {
					let memberuser = await interaction.guild.members.fetch(`${singleUser.ID}`).catch(err => {
						if (err.code === Discord.Constants.APIErrors.UNKNOWN_MEMBER) return;
						if (err.code === Discord.Constants.APIErrors.UNKNOWN_USER) return;
						func.handle_errors(err, client, `stats.js`, null)
					})
					if (memberuser) {
						statsDesc = statsDesc + `\n${i++}. ${memberuser?.user?.username}/${singleUser.ID}: ${singleUser.Count}`
					} else {
						statsDesc = statsDesc + `\n${i++}. ${singleUser.ID}: ${singleUser.Count}`
					}
				}

				StatsEmbed.setDescription(`\`\`\`md\n${statsDesc}\`\`\``)

				return interaction.editReply({embeds: [StatsEmbed], ephemeral: true}).catch(err => {
					if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
					func.handle_errors(err, client, `stats.js`, null)
					})


			} else if (interaction.options._subcommand == "individual") {

				let soloUserStats = userStats?.[interaction.options._hoistedOptions[0].value]
				if (soloUserStats == null) {
					return interaction.editReply({content:`Sorry! That user is not in the database.`, ephemeral: true}).catch(err => {
						if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
						func.handle_errors(err, client, `stats.js`, null)
						})
				}

				let user = await interaction.guild.members.fetch(interaction.options._hoistedOptions[0].value);

				const StatsEmbed = new Discord.MessageEmbed()
				.setAuthor({name: `Ticket Statistics for ${user.user.username}/${user.user.id}`, iconURL: user.user.displayAvatarURL()})
				.setColor(config.bot_settings.main_color)


				const handlerRaw = require("../../content/handler/options.json");
				const handlerKeys = Object.keys(handlerRaw.options);	
				
				let totalActions = 0 
				let acceptedActions = 0 
				let deniedActions = 0 
				let customCloseActions = 0 
				let openTicketActions = 0 
				let closeTicketActions = 0 
				let ticketMessagesHiddenActions = 0 
				let ticketMessagesVisibleActions = 0
				let favouriteTicketType = ``
				let favouriteTicketTypeCount = null
				let leastFavouriteTicketType = ``
				let leastFavouriteTicketTypeCount = null

				let userStatsIndividual = userStats?.[`${user.user.id}`]
				for (let TicketType of handlerKeys) {

					let TickettypeTotal = userStatsIndividual?.[`${TicketType}`]?.total
					if (TickettypeTotal == null) TickettypeTotal = 0

					if (TickettypeTotal > favouriteTicketTypeCount || favouriteTicketTypeCount == null) {
						favouriteTicketTypeCount = TickettypeTotal
						favouriteTicketType = TicketType
					}

					if (TickettypeTotal < leastFavouriteTicketTypeCount || leastFavouriteTicketTypeCount == null) {
						leastFavouriteTicketTypeCount = TickettypeTotal
						leastFavouriteTicketType = TicketType
					}


					let typestats = await func.GrabUserStaffStats(user.user.id, TicketType);
					totalActions = totalActions + typestats.totalActions
					acceptedActions = acceptedActions + typestats.acceptedActions
					deniedActions = deniedActions + typestats.deniedActions
					customCloseActions = customCloseActions + typestats.customCloseActions
					openTicketActions = openTicketActions + typestats.openTicketActions
					closeTicketActions = closeTicketActions + typestats.closeTicketActions
					ticketMessagesHiddenActions = ticketMessagesHiddenActions + typestats.ticketMessagesHiddenActions
					ticketMessagesVisibleActions = ticketMessagesVisibleActions + typestats.ticketMessagesVisibleActions

					if (typestats.totalActions == 0) {
						StatsEmbed.addFields({ name: `${TicketType} Actions (${typestats.totalActions})`, value: "```No actions to display!```" });

					} else {
						let LinkedStats = ``
						if (typestats.acceptedActions > 0) LinkedStats = LinkedStats + `\nAuto Accepted:            ${typestats.acceptedActions}`
						if (typestats.deniedActions > 0) LinkedStats = LinkedStats + `\nAuto Denied:              ${typestats.deniedActions}`
						if (typestats.customCloseActions > 0) LinkedStats = LinkedStats + `\nCustom Reply:             ${typestats.customCloseActions}`
						if (typestats.openTicketActions > 0) LinkedStats = LinkedStats + `\nOpened Tickets:           ${typestats.openTicketActions}`
						if (typestats.closeTicketActions > 0) LinkedStats = LinkedStats + `\nClosed Tickets:           ${typestats.closeTicketActions}`
						if (typestats.ticketMessagesHiddenActions > 0) LinkedStats = LinkedStats + `\nHidden Ticket Messages:   ${typestats.ticketMessagesHiddenActions}`
						if (typestats.ticketMessagesVisibleActions > 0) LinkedStats = LinkedStats + `\nVisible Ticket Messages:  ${typestats.ticketMessagesVisibleActions}`

						StatsEmbed.addFields({ name: `${TicketType} Actions (${typestats.totalActions})`, value: `\`\`\`ml\n${LinkedStats}\`\`\`` });
					}
}

					StatsEmbed.addFields({ name: `Total Actions (${totalActions})`, value: `\`\`\`ml\nAuto Accepted:            ${acceptedActions}\nAuto Denied:              ${deniedActions}\nCustom Reply:             ${customCloseActions}\nOpened Tickets:           ${openTicketActions}\nClosed Tickets:           ${closeTicketActions}\nHidden Ticket Messages:   ${ticketMessagesHiddenActions}\nVisible Ticket Messages:  ${ticketMessagesVisibleActions}\`\`\`` });

					StatsEmbed.addFields({ name: `User Facts`, value: `***Last Ticket Interaction:*** \`${moment(userStats.lastAction).format('MMMM Do YYYY, h:mm:ss a')}\`\n***Favourite Ticket Type:*** \`${favouriteTicketType}\`\n***Least Favourite Ticket Type:*** \`${leastFavouriteTicketType}\`\n***Total Tickets:*** \`${userStats.totalTickets}\`\n***Total Actions:*** \`${userStats.totalActions}\`\n***Total Accepts:*** \`${userStats.totalAccepts}\`\n***Total Denies:*** \`${userStats.totalDenies}\`\n***Total Custom Closes:*** \`${userStats.totalCustomCloses}\`\n***Total Feedback:*** \`${userStats.totalFeedback}\`\n` });

					return interaction.editReply({embeds: [StatsEmbed], ephemeral: true}).catch(err => {
						if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
						func.handle_errors(err, client, `stats.js`, null)
						})

			} else if (interaction.options._subcommand == "actiontype") {

				let users = [];
				let typestats = ``
				let actionTypeName = ``

				for (let eachUser of Object.keys(userStats)) {	


					switch(interaction.options._hoistedOptions[0].value){

						case "autoapproval":
							typestats = await func.CombineActionCountsUser(eachUser, `approved`);
							actionTypeName = "Auto Approved"
							break;
						case "autodenial":
							typestats = await func.CombineActionCountsUser(eachUser, `denied`);
							actionTypeName = "Auto Denial"
							break;
						case "customresponses":
							typestats = await func.CombineActionCountsUser(eachUser, `customclose`);
							actionTypeName = "Custom Responses"
							break;
						case "ticketopening":
							typestats = await func.CombineActionCountsUser(eachUser, `openticket`);
							actionTypeName = "Ticket Opening"
							break;
						case "ticketclosing":
							typestats = await func.CombineActionCountsUser(eachUser, `closeticket`);
							actionTypeName = "Ticket Closing"
							break;
						case "ticketmessageshidden":
							typestats = await func.CombineActionCountsUser(eachUser, `ticketmessageshidden`);
							actionTypeName = "Ticket Messages (Hidden)"
							break;
						case "ticketmessagesvisible":
							typestats = await func.CombineActionCountsUser(eachUser, `ticketmessages`);
							actionTypeName = "Ticket Messages (Visible)"
							break;
								
					}

					let userFinal = {
						ID: eachUser,
						Count: typestats
					}
					users.push(userFinal)	
				}

                let usersSorted = users.sort(compare);
				let usersSortedSliced = usersSorted.slice(0, 9);
				let i = 1
				let statsDesc = ""
				const StatsEmbed = new Discord.MessageEmbed()
				.setAuthor({name: `${actionTypeName} Action - Top 10 Staff Members`, iconURL: client.user.displayAvatarURL()})
				.setColor(config.bot_settings.main_color)

				for (let singleUser of usersSortedSliced) {
					let memberuser = await interaction.guild.members.fetch(`${singleUser.ID}`).catch(err => {
						if (err.code === Discord.Constants.APIErrors.UNKNOWN_MEMBER) return;
						if (err.code === Discord.Constants.APIErrors.UNKNOWN_USER) return;
						func.handle_errors(err, client, `stats.js`, null)
					})
					
					if (memberuser) {
						statsDesc = statsDesc + `\n${i++}. ${memberuser?.user?.username}/${singleUser.ID}: ${singleUser.Count}`
					} else {
						statsDesc = statsDesc + `\n${i++}. ${singleUser.ID}: ${singleUser.Count}`
					}
				}

				StatsEmbed.setDescription(`\`\`\`md\n${statsDesc}\`\`\``)

				return interaction.editReply({embeds: [StatsEmbed], ephemeral: true}).catch(err => {
					if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
					func.handle_errors(err, client, `stats.js`, null)
					})
			}



		} else if (interaction.options._group == "org") {
			let orgStats = await db.get(`ServerStats`);
				if (interaction.options._subcommand == `responsetimes`) {

					let overallResponseTimeInMS = 0
					let overallTicketsHandled = 0
					let i = 0
					let embedDescription = ``

					const OrgStatsEmbed = new Discord.MessageEmbed()
						.setAuthor({name: `Average Response Times per Ticket Type`, iconURL: client.user.displayAvatarURL()})
						.setColor(config.bot_settings.main_color)

						if (!orgStats?.ResponseTimes) {

							return interaction.editReply({content:`Sorry, there is no data available at this time!`, ephemeral: true}).catch(err => {
								if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
								func.handle_errors(err, client, `stats.js`, null)
								})
	
						}

					for (let ticketType of Object.keys(orgStats.ResponseTimes)) {

						let TimeSpentInMS = 0
						let TicketsHandled = 0

						for (let actionType of Object.keys(orgStats.ResponseTimes?.[`${ticketType}`])) {

							TimeSpentInMS = TimeSpentInMS + (orgStats.ResponseTimes?.[`${ticketType}`]?.[`${actionType}`].totalTimeSpent ? orgStats.ResponseTimes?.[`${ticketType}`]?.[`${actionType}`].totalTimeSpent : 0)
							TicketsHandled = TicketsHandled + (orgStats.ResponseTimes?.[`${ticketType}`]?.[`${actionType}`].totalTicketsHandled ? orgStats.ResponseTimes?.[`${ticketType}`]?.[`${actionType}`].totalTicketsHandled : 0)

						}

						embedDescription = embedDescription + `${Object.keys(orgStats.ResponseTimes)[i].replace(/_/g, ` `)}: "${await func.convertMsToTime((TimeSpentInMS / TicketsHandled))}"\n`
						i++
						overallResponseTimeInMS = overallResponseTimeInMS + TimeSpentInMS
						overallTicketsHandled = overallTicketsHandled + TicketsHandled

					}

					embedDescription = embedDescription + `\nOverall Average Response Time: \n"${await func.convertMsToTime((overallResponseTimeInMS / overallTicketsHandled))}"`

					OrgStatsEmbed.setDescription(`\`\`\`ml\n${embedDescription}\`\`\``)

					return interaction.editReply({embeds: [OrgStatsEmbed], ephemeral: true}).catch(err => {
						if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
						func.handle_errors(err, client, `stats.js`, null)
						})
				} else if (interaction.options._subcommand == `totaltickets`) {

					let overallTicketsHandled = 0
					let i = 0
					let embedDescription = ``

					const OrgStatsEmbed = new Discord.MessageEmbed()
						.setAuthor({name: `Total Ticket Count per Ticket Type`, iconURL: client.user.displayAvatarURL()})
						.setColor(config.bot_settings.main_color)

					if (!orgStats?.ResponseTimes) {

						return interaction.editReply({content:`Sorry, there is no data available at this time!`, ephemeral: true}).catch(err => {
							if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
							func.handle_errors(err, client, `stats.js`, null)
							})

					}

					for (let ticketType of Object.keys(orgStats.ResponseTimes)) {
						let TicketsHandled = 0

						for (let actionType of Object.keys(orgStats.ResponseTimes?.[`${ticketType}`])) {
							TicketsHandled = TicketsHandled + (orgStats.ResponseTimes?.[`${ticketType}`]?.[`${actionType}`].totalTicketsHandled ? orgStats.ResponseTimes?.[`${ticketType}`]?.[`${actionType}`].totalTicketsHandled : 0)
						}
						embedDescription = embedDescription + `${Object.keys(orgStats.ResponseTimes)[i].replace(/_/g, ` `)}: "${TicketsHandled}"\n`
						i++
						overallTicketsHandled = overallTicketsHandled + TicketsHandled

					}

					embedDescription = embedDescription + `\nOverall Ticket Count: "${overallTicketsHandled}"`

					OrgStatsEmbed.setDescription(`\`\`\`ml\n${embedDescription}\`\`\``)

					return interaction.editReply({embeds: [OrgStatsEmbed], ephemeral: true}).catch(err => {
						if (err.code === Discord.Constants.APIErrors.UNKNOWN_MESSAGE) return;  
						func.handle_errors(err, client, `stats.js`, null)
						})




				}
		}

	}
}


