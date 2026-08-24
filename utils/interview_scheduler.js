const { ChannelType } = require('discord.js');
const discordApi = require('./discordApi');
const logger = require('./logger');

function startInterviewSchedulers({ publicClient, config, db, applications, debugLog = () => {} }) {
	const guildId = config.channel_ids.public_guild_id;
	const adminRoleId = config.role_ids.application_admin_role_id || config.role_ids.default_admin_role_id;
	const interviewCategory = config.applications?.interview?.category_id || null;
	const interviewDuration = config.applications?.interview?.duration_minutes || 30;
	const publicToken = config.tokens.bot_token;

	debugLog(`[Interview Scheduler] Initialized with guildId: ${guildId}, adminRoleId: ${adminRoleId}, interviewCategory: ${interviewCategory}, duration: ${interviewDuration} minutes`);

	async function runScheduler() {
		try {
			const schedules = await applications.listSchedules();
			const entries = Object.entries(schedules);
			const now = Date.now();
			debugLog(`[Interview Scheduler] Checking ${entries.length} jobs at ${new Date(now).toISOString()}`);
			for (const [jobId, job] of entries) {
				if (!job || job.status !== 'scheduled') continue;
				debugLog(`[Interview Scheduler] Job ${jobId} scheduled for ${new Date(job.at).toISOString()}, current time: ${new Date(now).toISOString()}`);
				if (now < job.at) continue;

				let guild = null;
				try {
					debugLog(`[Interview Scheduler] Processing job ${jobId} for app ${job.appId}`);
					const appRec = await applications.getApplication(job.appId);
					if (!appRec) {
						debugLog(`[Interview Scheduler] Application ${job.appId} not found, marking job ${jobId} error`);
						await applications.completeSchedule(jobId, 'error', { reason: 'application_not_found' });
						continue;
					}

					guild = publicClient.guilds.cache.get(guildId);
					if (!guild) {
						debugLog(`[Interview Scheduler] Guild ${guildId} not found, erroring job ${jobId}`);
						await applications.completeSchedule(jobId, 'error', { reason: 'guild_not_found', guildId });
						continue;
					}

					const perms = [
						{ id: guild.id, deny: ['ViewChannel'] },
						{ id: publicClient.user.id, allow: ['ViewChannel', 'Connect', 'Speak'] },
					];

					if (adminRoleId) {
						const adminRole = guild.roles.cache.get(adminRoleId);
						if (adminRole) {
							perms.push({ id: adminRole.id, allow: ['ViewChannel', 'Connect', 'Speak'] });
						} else {
							debugLog(`[Interview Scheduler] Admin role ${adminRoleId} not found in guild`);
						}
					}

					perms.push({ id: job.staffId, allow: ['ViewChannel', 'Connect', 'Speak'] });
					perms.push({ id: appRec.userId, allow: ['ViewChannel', 'Connect', 'Speak'] });

					const baseUsername = String(appRec.username || appRec.userId || 'user');
					const safeUser = baseUsername.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
					const name = `interview-${safeUser || 'user'}`;
					const createOpts = { type: ChannelType.GuildVoice, permissionOverwrites: perms };
					if (interviewCategory) {
						createOpts.parent = interviewCategory;
					}

					debugLog(`[Interview Scheduler] Creating voice channel "${name}" for job ${jobId}`);
					const vc = await guild.channels.create({ name, ...createOpts });
					debugLog(`[Interview Scheduler] Successfully created voice channel ${vc.id} for job ${jobId}`);
					await applications.completeSchedule(jobId, 'done', { channelId: vc.id });

					const cleanupTime = Date.now() + (interviewDuration * 60 * 1000);
					await db.set(`InterviewCleanup.${vc.id}`, {
						channelId: vc.id,
						cleanupAt: cleanupTime,
						jobId,
						appId: job.appId,
						attempts: 0,
					});

					try {
						const interviewStartTime = Math.floor((Date.now() + 5 * 60 * 1000) / 1000);
						await discordApi.sendDm(
							publicToken,
							appRec.userId,
							`**Interview Voice Channel Ready** 🎤\n\nYour interview voice channel is now available!\n\n**Channel:** <#${vc.id}>\n**Interview Start:** <t:${interviewStartTime}:F>\n**Duration:** ${interviewDuration} minutes\n\nPlease join the voice channel when you're ready to begin your interview.`
						);
						await discordApi.sendDm(
							publicToken,
							job.staffId,
							`**Interview Voice Channel Ready** 🎤\n\nInterview voice channel is now available!\n\n**Applicant:** ${appRec.username} (<@${appRec.userId}>)\n**Channel:** <#${vc.id}>\n**Duration:** ${interviewDuration} minutes\n\nPlease join the voice channel when ready to begin the interview.`
						);
					} catch (notifyError) {
						logger.warn('Failed to send voice channel notifications:', notifyError?.data || notifyError);
					}
				} catch (e) {
					logger.error(`[Interview Scheduler] Error creating voice channel for job ${jobId}:`, e);
					let errorMessage = e?.message || String(e);
					if (e?.code === 50001) errorMessage = 'Missing Access: Bot does not have permission to access this guild';
					else if (e?.code === 50013) errorMessage = 'Missing Permissions: Bot lacks required permissions to create channels';
					else if (e?.code === 10003) errorMessage = 'Unknown Channel: The specified channel does not exist';
					else if (e?.code === 10004) errorMessage = 'Unknown Guild: The specified guild does not exist';
					else if (e?.code === 50035) errorMessage = 'Invalid channel options: ' + errorMessage;

					try {
						await applications.completeSchedule(jobId, 'error', {
							message: errorMessage,
							code: e?.code ?? null,
							status: e?.status ?? null,
						});
					} catch (scheduleErr) {
						logger.error(`[Interview Scheduler] Failed to mark job ${jobId} as error:`, scheduleErr);
					}
				}
			}
		} catch (schedulerErr) {
			logger.error('[Interview Scheduler] Scheduler loop error:', schedulerErr);
		}
		setTimeout(runScheduler, 15000);
	}

	async function runCleanupScheduler() {
		try {
			const cleanups = (await db.get('InterviewCleanup')) || {};
			const now = Date.now();
			debugLog(`[Interview Cleanup] Checking ${Object.keys(cleanups).length} cleanup jobs at ${new Date(now).toISOString()}`);

			for (const channelId of Object.keys(cleanups)) {
				const cleanup = cleanups[channelId];
				if (!cleanup || now < cleanup.cleanupAt) continue;

				try {
					const guild = publicClient.guilds.cache.get(guildId);
					if (!guild) continue;

					const channel = guild.channels.cache.get(channelId);
					if (!channel) {
						delete cleanups[channelId];
						await db.set('InterviewCleanup', cleanups);
						continue;
					}

					const memberCount = channel.members.size;
					if (memberCount === 0 || (cleanup.attempts || 0) >= 12) {
						await channel.delete();
						delete cleanups[channelId];
						await db.set('InterviewCleanup', cleanups);
					} else {
						cleanup.cleanupAt = now + (5 * 60 * 1000);
						cleanup.attempts = (cleanup.attempts || 0) + 1;
						cleanups[channelId] = cleanup;
						await db.set('InterviewCleanup', cleanups);
					}
				} catch (cleanupError) {
					logger.error(`[Interview Cleanup] Error during cleanup for channel ${channelId}:`, cleanupError);
					delete cleanups[channelId];
					await db.set('InterviewCleanup', cleanups);
				}
			}
		} catch (cleanupError) {
			logger.error('Interview cleanup scheduler error:', cleanupError);
		}
		setTimeout(runCleanupScheduler, 30000);
	}

	runScheduler();
	runCleanupScheduler();
}

module.exports = { startInterviewSchedulers };
