const { readdirSync } = require("fs");
const func = require("./functions.js")
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9")

module.exports = function (client) {
	let commands = readdirSync("./commands/").filter(x => x.endsWith(".js")).map(x => x.split(".")[0]);
	let events = readdirSync("./events/").filter(x => x.endsWith(".js")).map(x => x.split(".")[0]);
	let slashcommands = readdirSync("./commands/slashcommands/").filter(x => x.endsWith(".js"));
	let CommandsList = [];

	commands.forEach(file => {
		client.commands.set(file, require(`../commands/${file}`));
		console.log(`Initialized ${file} Command`);
	});

	slashcommands.forEach(file => {
		const command = require(`../commands/slashcommands/${file}`);
		client.commands.set(command.data.name + `_slash`, command);
		CommandsList.push(command.data.toJSON());
		console.log(`Initialized ${file} Slash-Command`);
	});

	events.forEach(file => {
		client.on(file, require(`../events/${file}`).bind(null, client));
		console.log(`Initialized ${file} Event`);
	});

	const restClient = new REST({ version: "9" }).setToken(client.config.tokens.bot_token)

		restClient.put(Routes.applicationGuildCommands(client.user.id, client.config.channel_ids.staff_guild_id),
		{ body: CommandsList })
		.then(() => console.log("Sucessfully registered local Commands!"))
		.catch(console.error)

	

};