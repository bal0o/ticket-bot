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
		
		console.log(`[Interview Scheduler] Initialized with guildId: ${guildId}, adminRoleId: ${adminRoleId}, interviewCategory: ${interviewCategory}, duration: ${interviewDuration} minutes`);
		async function runScheduler() {
			try {
				const jobs = await db.get('ApplicationSchedules') || {};
				const now = Date.now();
				console.log(`[Interview Scheduler] Checking ${Object.keys(jobs).length} jobs at ${new Date(now).toISOString()}`);
				
				// Clean up old completed/error/skipped jobs (older than 24 hours)
				const jobsToCleanup = [];
				for (const jobId of Object.keys(jobs)) {
					const job = jobs[jobId];
					if (job && job.status !== 'scheduled') {
						const jobAge = now - (job.completedAt || job.createdAt);
						if (jobAge > 24 * 60 * 60 * 1000) { // 24 hours
							jobsToCleanup.push(jobId);
						}
					}
				}
				
				if (jobsToCleanup.length > 0) {
					console.log(`[Interview Scheduler] Cleaning up ${jobsToCleanup.length} old jobs`);
					for (const jobId of jobsToCleanup) {
						delete jobs[jobId];
					}
					await db.set('ApplicationSchedules', jobs);
				}
				
				for (const jobId of Object.keys(jobs)) {
					const job = jobs[jobId];
					if (!job || job.status !== 'scheduled') {
						console.log(`[Interview Scheduler] Skipping job ${jobId} - status: ${job?.status || 'null'}`);
						continue;
					}
					
					console.log(`[Interview Scheduler] Job ${jobId} scheduled for ${new Date(job.at).toISOString()}, current time: ${new Date(now).toISOString()}`);
					
					if (now >= job.at) {
						// Create voice channel
						try {
							console.log(`[Interview Scheduler] Processing job ${jobId} for app ${job.appId}`);
							console.log(`[Interview Scheduler] Job scheduled for: ${new Date(job.at).toISOString()} (${new Date(job.at).toLocaleString()})`);
							console.log(`[Interview Scheduler] Current time: ${new Date().toISOString()} (${new Date().toLocaleString()})`);
							const appRec = await db.get(`Applications.${job.appId}`);
							if (!appRec) { 
								console.log(`[Interview Scheduler] Application ${job.appId} not found, skipping job ${jobId}`);
								job.status = 'skipped'; 
								await db.set(`ApplicationSchedules.${jobId}`, job); 
								continue; 
							}
							console.log(`[Interview Scheduler] Looking for guild ${guildId} in ${client.guilds.cache.size} available guilds`);
							console.log(`[Interview Scheduler] Available guilds:`, Array.from(client.guilds.cache.keys()));
							
							const guild = client.guilds.cache.get(guildId);
							if (!guild) { 
								console.log(`[Interview Scheduler] Guild ${guildId} not found, erroring job ${jobId}`);
								console.log(`[Interview Scheduler] Guild cache keys:`, Array.from(client.guilds.cache.keys()));
								job.status = 'error'; 
								job.error = `Guild ${guildId} not found in bot's guild cache`;
								await db.set(`ApplicationSchedules.${jobId}`, job); 
								continue; 
							}
							
							console.log(`[Interview Scheduler] Found guild: ${guild.name} (${guild.id})`);
							console.log(`[Interview Scheduler] Guild channels:`, guild.channels.cache.size, 'channels available');
							console.log(`[Interview Scheduler] Guild permissions:`, guild.members.me?.permissions?.toArray() || 'unknown');
							// Build permission overwrites with proper user/role resolution
							const perms = [
								{ id: guild.id, deny: ['VIEW_CHANNEL'] },
								{ id: client.user.id, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] }
							];
							
							// Add admin role if it exists
							if (adminRoleId) {
								const adminRole = guild.roles.cache.get(adminRoleId);
								if (adminRole) {
									perms.push({ id: adminRole, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] });
								} else {
									console.log(`[Interview Scheduler] Admin role ${adminRoleId} not found in guild`);
								}
							}
							
							// Add staff member
							try {
								const staffMember = await guild.members.fetch(job.staffId);
								perms.push({ id: staffMember, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] });
							} catch (staffError) {
								console.log(`[Interview Scheduler] Staff member ${job.staffId} not found in guild, using ID directly`);
								perms.push({ id: job.staffId, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] });
							}
							
							// Add applicant
							try {
								const applicantMember = await guild.members.fetch(appRec.userId);
								perms.push({ id: applicantMember, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] });
							} catch (applicantError) {
								console.log(`[Interview Scheduler] Applicant ${appRec.userId} not found in guild, using ID directly`);
								perms.push({ id: appRec.userId, allow: ['VIEW_CHANNEL','CONNECT','SPEAK'] });
							}
							const baseUsername = String(appRec.username || appRec.userId || 'user');
							const safeUser = baseUsername.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
							const name = `interview-${safeUser || 'user'}`;
							const createOpts = { type: 'GUILD_VOICE', permissionOverwrites: perms };
							if (interviewCategory) {
								createOpts.parent = interviewCategory;
								console.log(`[Interview Scheduler] Using category ${interviewCategory} for channel creation`);
							} else {
								console.log(`[Interview Scheduler] No category specified, creating channel in guild root`);
							}
							
							console.log(`[Interview Scheduler] Creating voice channel "${name}" for job ${jobId} with options:`, JSON.stringify(createOpts, null, 2));
							const vc = await guild.channels.create(name, createOpts);
							console.log(`[Interview Scheduler] Successfully created voice channel ${vc.id} for job ${jobId}`);
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
								// Calculate interview start time (5 minutes after channel creation)
								const interviewStartTime = Math.floor((Date.now() + 5 * 60 * 1000) / 1000);
								
								// Notify applicant
								const applicantDm = await axios.post(`https://discord.com/api/v10/users/@me/channels`, {
									recipient_id: appRec.userId
								}, { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } });
								
								if (applicantDm.data && applicantDm.data.id) {
									await axios.post(`https://discord.com/api/v10/channels/${applicantDm.data.id}/messages`, {
										content: `**Interview Voice Channel Ready** 🎤\n\nYour interview voice channel is now available!\n\n**Channel:** <#${vc.id}>\n**Interview Start:** <t:${interviewStartTime}:F>\n**Duration:** ${interviewDuration} minutes\n\nPlease join the voice channel when you're ready to begin your interview.`
									}, { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } });
								}
								
								// Notify staff member
								const staffDm = await axios.post(`https://discord.com/api/v10/users/@me/channels`, {
									recipient_id: job.staffId
								}, { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } });
								
								if (staffDm.data && staffDm.data.id) {
									await axios.post(`https://discord.com/api/v10/channels/${staffDm.data.id}/messages`, {
										content: `**Interview Voice Channel Ready** 🎤\n\nInterview voice channel is now available!\n\n**Applicant:** ${appRec.username} (<@${appRec.userId}>)\n**Channel:** <#${vc.id}>\n**Interview Start:** <t:${interviewStartTime}:F>\n**Duration:** ${interviewDuration} minutes\n\nPlease join the voice channel when ready to begin the interview.`
									}, { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } });
								}
							} catch (notifyError) {
								console.error('Failed to send voice channel notifications:', notifyError?.response?.data || notifyError);
							}
						} catch (e) {
							console.error(`[Interview Scheduler] Error creating voice channel for job ${jobId}:`, e);
							console.error(`[Interview Scheduler] Error details:`, {
								message: e.message,
								code: e.code,
								status: e.status,
								stack: e.stack,
								guildId: guildId,
								guildName: guild?.name,
								botPermissions: guild?.members.me?.permissions?.toArray()
							});
							
							// Provide more specific error messages
							let errorMessage = e?.message || String(e);
							if (e?.code === 50001) {
								errorMessage = 'Missing Access: Bot does not have permission to access this guild';
							} else if (e?.code === 50013) {
								errorMessage = 'Missing Permissions: Bot lacks required permissions to create channels';
							} else if (e?.code === 10003) {
								errorMessage = 'Unknown Channel: The specified channel does not exist';
							} else if (e?.code === 10004) {
								errorMessage = 'Unknown Guild: The specified guild does not exist';
							}
							
							job.status = 'error'; 
							job.error = errorMessage;
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
				console.log(`[Interview Cleanup] Checking ${Object.keys(cleanups).length} cleanup jobs at ${new Date(now).toISOString()}`);
				
				for (const channelId of Object.keys(cleanups)) {
					const cleanup = cleanups[channelId];
					if (!cleanup || now < cleanup.cleanupAt) {
						if (cleanup) {
							console.log(`[Interview Cleanup] Channel ${channelId} cleanup scheduled for ${new Date(cleanup.cleanupAt).toISOString()}, skipping`);
						}
						continue;
					}
					
					try {
						console.log(`[Interview Cleanup] Processing cleanup for channel ${channelId}`);
						const guild = client.guilds.cache.get(guildId);
						if (!guild) {
							console.log(`[Interview Cleanup] Guild ${guildId} not found for channel ${channelId}`);
							continue;
						}
						
						console.log(`[Interview Cleanup] Found guild: ${guild.name} (${guild.id})`);
						const channel = guild.channels.cache.get(channelId);
						if (!channel) {
							console.log(`[Interview Cleanup] Channel ${channelId} not found in guild ${guild.name}, removing from cleanup list`);
							// Channel doesn't exist, remove from cleanup list
							delete cleanups[channelId];
							await db.set('InterviewCleanup', cleanups);
							continue;
						}
						
						// Check if anyone is in the channel
						const memberCount = channel.members.size;
						console.log(`[Interview Cleanup] Channel ${channelId} has ${memberCount} members`);
						
						if (memberCount === 0) {
							// No one in channel, delete it
							console.log(`[Interview Cleanup] Deleting empty channel ${channelId}`);
							await channel.delete();
							delete cleanups[channelId];
							await db.set('InterviewCleanup', cleanups);
							console.log(`[Interview Cleanup] Successfully deleted empty interview channel: ${channelId}`);
						} else {
							// People still in channel, reschedule cleanup in 5 minutes
							cleanup.cleanupAt = now + (5 * 60 * 1000); // 5 minutes
							cleanup.attempts = (cleanup.attempts || 0) + 1;
							
							console.log(`[Interview Cleanup] Channel ${channelId} still has members, rescheduling cleanup (attempt ${cleanup.attempts}/12)`);
							
							// Don't reschedule more than 12 times (1 hour total)
							if (cleanup.attempts < 12) {
								cleanups[channelId] = cleanup;
								await db.set('InterviewCleanup', cleanups);
								console.log(`[Interview Cleanup] Rescheduled cleanup for channel ${channelId} to ${new Date(cleanup.cleanupAt).toISOString()}`);
							} else {
								// Force delete after 1 hour
								console.log(`[Interview Cleanup] Force deleting channel ${channelId} after 1 hour of attempts`);
								await channel.delete();
								delete cleanups[channelId];
								await db.set('InterviewCleanup', cleanups);
								console.log(`[Interview Cleanup] Force deleted interview channel after 1 hour: ${channelId}`);
							}
						}
					} catch (cleanupError) {
						console.error(`[Interview Cleanup] Error during cleanup for channel ${channelId}:`, cleanupError);
						console.error(`[Interview Cleanup] Error details:`, {
							message: cleanupError.message,
							code: cleanupError.code,
							status: cleanupError.status,
							stack: cleanupError.stack
						});
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
