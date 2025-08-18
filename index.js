require("dotenv").config({ path: "./config/.env" });
const { Client,Collection,Intents } = require("discord.js");
const config = require("./config/config.json");

const client = new Client({ intents: [
	Intents.FLAGS.GUILDS,
	Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
	Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
	Intents.FLAGS.GUILD_MEMBERS,
	Intents.FLAGS.GUILD_MESSAGES,
	Intents.FLAGS.DIRECT_MESSAGES
], partials: ["MESSAGE", "CHANNEL", "REACTION", "GUILD_MEMBER"]	});

client.commands = new Collection();
client.blocked_users = new Set();
client.cooldown = new Set();
client.claims = new Map();
client.config = config;

// Start the web server if enabled in config
try {
	if (client.config.web && client.config.web.enabled) {
		require("./web/server");
	}
} catch (e) {
	console.log("[web] Failed to start web server:", e?.message || e);
}


let startTime = new Date().getTime();
client.login(process.env.BOT_TOKEN).then(() => {

	eval(require("./utils/handler_manager")(client));
	let endTime = new Date().getTime();

	let difference = Math.round(endTime - startTime);
	console.log(`Successfully logged in as ${client.user.username}! Took ${difference}ms`);
	try { require('./utils/metrics').initPersisted?.(); } catch (_) {}

	// Start application interview scheduler loop
	try {
		const { QuickDB } = require('quick.db');
		const db = new QuickDB();
		const cfg = require('./config/config.json');
		const guildId = cfg.channel_ids.public_guild_id; // Use public guild for interview channels
		const adminRoleId = cfg.role_ids.application_admin_role_id || cfg.role_ids.default_admin_role_id;
		const interviewCategory = cfg.applications && cfg.applications.interview ? cfg.applications.interview.category_id : null;
		async function runScheduler() {
			try {
				const jobs = await db.get('ApplicationSchedules') || {};
				const now = Date.now();
				for (const jobId of Object.keys(jobs)) {
					const job = jobs[jobId];
					if (!job || job.status !== 'scheduled') continue;
					if (now >= job.at) {
						// Create voice channel
						try {
							const appRec = await db.get(`Applications.${job.appId}`);
							if (!appRec) { job.status = 'skipped'; await db.set(`ApplicationSchedules.${jobId}`, job); continue; }
							const guild = client.guilds.cache.get(guildId);
							if (!guild) { job.status = 'error'; await db.set(`ApplicationSchedules.${jobId}`, job); continue; }
							const perms = [
								{ id: guild.id, deny: ['VIEW_CHANNEL'] },
								{ id: client.user.id, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] },
								{ id: adminRoleId, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] },
								{ id: job.staffId, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] },
								{ id: appRec.userId, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] }
							];
							const name = `interview-${appRec.userId.slice(-4)}-${Math.floor(now/1000)}`;
							const createOpts = { type: 'GUILD_VOICE', permissionOverwrites: perms };
							if (interviewCategory) createOpts.parent = interviewCategory;
							const vc = await guild.channels.create(name, createOpts);
							job.status = 'done'; job.completedAt = Date.now(); job.info = { channelId: vc.id };
							await db.set(`ApplicationSchedules.${jobId}`, job);
						} catch (e) {
							job.status = 'error'; job.error = e?.message || String(e);
							await db.set(`ApplicationSchedules.${jobId}`, job);
						}
					}
				}
			} catch (_) {}
			setTimeout(runScheduler, 15000);
		}
		runScheduler();
	} catch (e) { console.log('scheduler init error', e?.message || e); }
});

client
    .on("debug", console.log)
    .on("warn", console.log)
