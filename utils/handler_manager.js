const { readdirSync } = require("fs");
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v10")

let commandsLoaded = false;

function loadCommands(client) {
	if (commandsLoaded) return;
	commandsLoaded = true;

	let commands = readdirSync("./commands/").filter(x => x.endsWith(".js")).map(x => x.split(".")[0]);
	let slashcommands = readdirSync("./commands/slashcommands/").filter(x => x.endsWith(".js"));

	commands.forEach(file => {
		client.commands.set(file, require(`../commands/${file}`));
		console.log(`Initialized ${file} Command`);
	});

	slashcommands.forEach(file => {
		const command = require(`../commands/slashcommands/${file}`);
		client.commands.set(command.data.name + `_slash`, command);
		console.log(`Initialized ${file} Slash-Command`);
	});
}

function bindEvents(client) {
	let events = readdirSync("./events/").filter(x => x.endsWith(".js")).map(x => x.split(".")[0]);
	events.forEach(file => {
		const handler = require(`../events/${file}`).bind(null, client);
		const eventName = file === 'ready' ? 'clientReady' : file;
		client.on(eventName, handler);
		console.log(`Initialized ${file} Event on ${client.botRole || 'bot'} (listening on '${eventName}')`);
	});
}

function registerSlash(client) {
	if (client.botRole !== 'staff') return;

	const CommandsList = [];
	let slashcommands = readdirSync("./commands/slashcommands/").filter(x => x.endsWith(".js"));
	slashcommands.forEach(file => {
		const command = require(`../commands/slashcommands/${file}`);
		CommandsList.push(command.data.toJSON());
	});

	const restClient = new REST({ version: "10" }).setToken(client.config.tokens.staff_bot_token)

	restClient.put(Routes.applicationGuildCommands(client.user.id, client.config.channel_ids.staff_guild_id),
		{ body: CommandsList })
		.then(() => console.log("Sucessfully registered local Commands!"))
		.catch(console.error)
}

module.exports = function (client) {
	loadCommands(client);
	bindEvents(client);
};

module.exports.registerSlash = registerSlash;
