require("dotenv").config({ path: "./config/.env" });
const { Client,Collection,Intents } = require("discord.js");
const config = require("./config/config.json");
const axios = require("axios");

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
		const interviewDuration = cfg.applications && cfg.applications.interview ? cfg.applications.interview.duration_minutes : 30;
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
							
							// Schedule auto-cleanup for the voice channel
							const cleanupTime = Date.now() + (interviewDuration * 60 * 1000); // Convert minutes to milliseconds
							await db.set(`InterviewCleanup.${vc.id}`, {
								channelId: vc.id,
								cleanupAt: cleanupTime,
								jobId: jobId,
								appId: job.appId,
								attempts: 0
							});
							
							// Send notifications to both users about the voice channel
							try {
								// Notify applicant
								const applicantDm = await axios.post(`https://discord.com/api/v10/users/@me/channels`, {
									recipient_id: appRec.userId
								}, { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } });
								
								if (applicantDm.data && applicantDm.data.id) {
									await axios.post(`https://discord.com/api/v10/channels/${applicantDm.data.id}/messages`, {
										content: `**Interview Voice Channel Ready** 🎤\n\nYour interview voice channel is now available!\n\n**Channel:** <#${vc.id}>\n**Duration:** ${interviewDuration} minutes\n\nPlease join the voice channel when you're ready to begin your interview.`
									}, { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } });
								}
								
								// Notify staff member
								const staffDm = await axios.post(`https://discord.com/api/v10/users/@me/channels`, {
									recipient_id: job.staffId
								}, { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } });
								
								if (staffDm.data && staffDm.data.id) {
									await axios.post(`https://discord.com/api/v10/channels/${staffDm.data.id}/messages`, {
										content: `**Interview Voice Channel Ready** 🎤\n\nInterview voice channel is now available!\n\n**Applicant:** ${appRec.username}\n**Channel:** <#${vc.id}>\n**Duration:** ${interviewDuration} minutes\n\nPlease join the voice channel when ready to begin the interview.`
									}, { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } });
								}
							} catch (notifyError) {
								console.error('Failed to send voice channel notifications:', notifyError?.response?.data || notifyError);
							}
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
		
		// Start interview cleanup scheduler
		async function runCleanupScheduler() {
			try {
				const cleanups = await db.get('InterviewCleanup') || {};
				const now = Date.now();
				for (const channelId of Object.keys(cleanups)) {
					const cleanup = cleanups[channelId];
					if (!cleanup || now < cleanup.cleanupAt) continue;
					
					try {
						const guild = client.guilds.cache.get(guildId);
						if (!guild) continue;
						
						const channel = guild.channels.cache.get(channelId);
						if (!channel) {
							// Channel doesn't exist, remove from cleanup list
							delete cleanups[channelId];
							await db.set('InterviewCleanup', cleanups);
							continue;
						}
						
						// Check if anyone is in the channel
						const memberCount = channel.members.size;
						
						if (memberCount === 0) {
							// No one in channel, delete it
							await channel.delete();
							delete cleanups[channelId];
							await db.set('InterviewCleanup', cleanups);
							console.log(`Deleted empty interview channel: ${channelId}`);
						} else {
							// People still in channel, reschedule cleanup in 5 minutes
							cleanup.cleanupAt = now + (5 * 60 * 1000); // 5 minutes
							cleanup.attempts = (cleanup.attempts || 0) + 1;
							
							// Don't reschedule more than 12 times (1 hour total)
							if (cleanup.attempts < 12) {
								cleanups[channelId] = cleanup;
								await db.set('InterviewCleanup', cleanups);
							} else {
								// Force delete after 1 hour
								await channel.delete();
								delete cleanups[channelId];
								await db.set('InterviewCleanup', cleanups);
								console.log(`Force deleted interview channel after 1 hour: ${channelId}`);
							}
						}
					} catch (cleanupError) {
						console.error('Error during interview cleanup:', cleanupError);
						// Remove from cleanup list if there's an error
						delete cleanups[channelId];
						await db.set('InterviewCleanup', cleanups);
					}
				}
			} catch (cleanupError) {
				console.error('Interview cleanup scheduler error:', cleanupError);
			}
			setTimeout(runCleanupScheduler, 30000); // Check every 30 seconds
		}
		runCleanupScheduler();
	} catch (e) { console.log('scheduler init error', e?.message || e); }
});

client
    .on("debug", console.log)
    .on("warn", console.log)
