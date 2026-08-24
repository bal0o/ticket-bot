const {
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	MessageFlags,
} = require('discord.js');
const { createDB } = require('./mysql');
const func = require('./functions');
const { loadJson } = require('./jsonConfig');

const db = createDB();
const DEFAULT_FEEDBACK = {
	opt_in_prompt: 'Your ticket is closed. Would you like to rate your support experience?',
	opt_in_yes_label: 'Yes, I\'ll rate it',
	opt_in_no_label: 'No thanks',
	thanks_decline: 'No problem — thanks for contacting support.',
	thanks_complete: 'Thanks for your feedback. It helps us improve.',
	already_submitted: 'You\'ve already sent feedback for this ticket. Thank you!',
	session_expired: 'This feedback session expired. Thanks anyway!',
	session_ttl_hours: 24,
	comment_modal_title: 'Optional comment',
	comment_modal_label: 'Anything else? (optional)',
	comment_skip_label: 'Skip',
	comment_add_label: 'Add comment',
	questions: [],
};

const sessions = new Map();

function loadConfig() {
	return loadJson('content/handler/feedback.json', DEFAULT_FEEDBACK);
}

function sessionKey(userId, ticketId) {
	return `${userId}:${ticketId}`;
}

function getSession(userId, ticketId) {
	const key = sessionKey(userId, ticketId);
	const session = sessions.get(key);
	if (!session) return null;
	const ttlMs = (Number(loadConfig().session_ttl_hours) || 24) * 60 * 60 * 1000;
	if (Date.now() - session.startedAt > ttlMs) {
		sessions.delete(key);
		return null;
	}
	return session;
}

function setSession(userId, ticketId, data) {
	sessions.set(sessionKey(userId, ticketId), {
		...data,
		startedAt: data.startedAt || Date.now(),
	});
}

function clearSession(userId, ticketId) {
	sessions.delete(sessionKey(userId, ticketId));
}

function parseCsatId(customId) {
	if (!customId || !customId.startsWith('csat:')) return null;
	const parts = customId.split(':');
	return {
		action: parts[1] || null,
		ticketId: parts[2] || null,
		questionId: parts[3] || null,
		value: parts.slice(4).join(':') || null,
		parts,
	};
}

function buildOptInComponents(ticketId, cfg = loadConfig()) {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`csat:yes:${ticketId}`)
				.setLabel(cfg.opt_in_yes_label || 'Yes')
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId(`csat:no:${ticketId}`)
				.setLabel(cfg.opt_in_no_label || 'No thanks')
				.setStyle(ButtonStyle.Secondary)
		),
	];
}

function buildOptInEmbed(client, ticketMeta, cfg = loadConfig()) {
	return new EmbedBuilder()
		.setColor(client.config?.bot_settings?.main_color || 0x208cdd)
		.setTitle('Ticket feedback')
		.setDescription(cfg.opt_in_prompt || 'Would you like to rate your support experience?')
		.setFooter({
			text: `${ticketMeta.ticketType || 'ticket'} #${ticketMeta.ticketId}`,
		});
}

function buildQuestionComponents(ticketId, question) {
	const rows = [];
	if (question.type === 'scale') {
		const min = Number(question.min) || 1;
		const max = Number(question.max) || 5;
		const buttons = [];
		for (let i = min; i <= max; i++) {
			buttons.push(
				new ButtonBuilder()
					.setCustomId(`csat:ans:${ticketId}:${question.id}:${i}`)
					.setLabel(String(i))
					.setStyle(ButtonStyle.Primary)
			);
		}
		rows.push(new ActionRowBuilder().addComponents(buttons));
	} else if (question.type === 'choice') {
		const buttons = (question.options || []).slice(0, 5).map((opt) =>
			new ButtonBuilder()
				.setCustomId(`csat:ans:${ticketId}:${question.id}:${opt.value}`)
				.setLabel(String(opt.label || opt.value).slice(0, 80))
				.setStyle(ButtonStyle.Primary)
		);
		if (buttons.length) rows.push(new ActionRowBuilder().addComponents(buttons));
	} else if (question.type === 'comment') {
		const cfg = loadConfig();
		rows.push(
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`csat:comment:${ticketId}`)
					.setLabel(cfg.comment_add_label || 'Add comment')
					.setStyle(ButtonStyle.Primary),
				new ButtonBuilder()
					.setCustomId(`csat:skip:${ticketId}`)
					.setLabel(cfg.comment_skip_label || 'Skip')
					.setStyle(ButtonStyle.Secondary)
			)
		);
	}
	return rows;
}

function staffUserIds(staff) {
	if (!staff) return [];
	return [
		staff.close_user_id,
		staff.claimed_by_user_id,
		staff.first_staff_response_user_id,
	].filter(Boolean).map(String);
}

function feedbackAffectsBrit(staff, cfg = loadConfig()) {
	const britId = String(cfg.brit_user_id || '');
	if (!britId) return false;
	return staffUserIds(staff).includes(britId);
}

function questionDescription(question, staff, cfg = loadConfig()) {
	const prompt = question.prompt || '';
	if (question.id !== 'overall' || !feedbackAffectsBrit(staff, cfg)) return prompt;
	const joke = cfg.brit_rating_joke;
	if (!joke) return prompt;
	return `${prompt}\n\n${joke}`;
}

function buildQuestionEmbed(client, question, ticketMeta, step, total, staff, cfg = loadConfig()) {
	return new EmbedBuilder()
		.setColor(client.config?.bot_settings?.main_color || 0x208cdd)
		.setTitle(`Feedback (${step}/${total})`)
		.setDescription(questionDescription(question, staff, cfg))
		.setFooter({
			text: `${ticketMeta.ticketType || 'ticket'} #${ticketMeta.ticketId}`,
		});
}

function disabledRowFromMessage(message, label) {
	const row = new ActionRowBuilder();
	const first = message?.components?.[0]?.components?.[0];
	row.addComponents(
		new ButtonBuilder()
			.setCustomId(first?.customId || 'csat:done')
			.setLabel(label || 'Done')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(true)
	);
	return [row];
}

async function alreadySubmitted(userId, ticketId) {
	if (typeof db.query !== 'function') return false;
	const [rows] = await db.query(
		'SELECT id FROM ticket_feedback WHERE user_id = ? AND ticket_id = ? LIMIT 1',
		[String(userId), String(ticketId)]
	);
	return !!(rows && rows[0]);
}

async function loadTicketStaffContext(userId, ticketId) {
	if (typeof db.query !== 'function') return {};
	const [rows] = await db.query(
		`SELECT ticket_type, server, close_user_id, close_user,
		        claimed_by_user_id, claimed_by_user,
		        first_staff_response_user_id, first_staff_response_user
		 FROM tickets
		 WHERE user_id = ? AND ticket_id = ?
		 LIMIT 1`,
		[String(userId), String(ticketId)]
	);
	return rows?.[0] || {};
}

async function saveFeedback({ userId, ticketId, ticketType, server, answers, staff }) {
	const overall = answers.overall != null ? Number(answers.overall) : null;
	await db.query(
		`INSERT INTO ticket_feedback (
			ticket_id, user_id, ticket_type, server,
			overall_score, speed_rating, resolved, would_return, comment,
			closer_user_id, closer_user, claimer_user_id, claimer_user,
			first_responder_user_id, first_responder_user,
			answers_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			overall_score = VALUES(overall_score),
			speed_rating = VALUES(speed_rating),
			resolved = VALUES(resolved),
			would_return = VALUES(would_return),
			comment = VALUES(comment),
			closer_user_id = VALUES(closer_user_id),
			closer_user = VALUES(closer_user),
			claimer_user_id = VALUES(claimer_user_id),
			claimer_user = VALUES(claimer_user),
			first_responder_user_id = VALUES(first_responder_user_id),
			first_responder_user = VALUES(first_responder_user),
			answers_json = VALUES(answers_json),
			created_at = VALUES(created_at)`,
		[
			String(ticketId),
			String(userId),
			ticketType || null,
			server || null,
			Number.isFinite(overall) ? overall : null,
			answers.speed || null,
			answers.resolved || null,
			answers.would_return || null,
			answers.comment || null,
			staff.close_user_id || null,
			staff.close_user || null,
			staff.claimed_by_user_id || null,
			staff.claimed_by_user || null,
			staff.first_staff_response_user_id || null,
			staff.first_staff_response_user || null,
			JSON.stringify(answers || {}),
			Math.floor(Date.now() / 1000),
		]
	);
}

function shouldOfferFeedback(typeFile, ticketType) {
	if (!typeFile || typeFile.allow_feedback !== true) return false;
	if (typeFile.internal) return false;
	if (func.isTicketTypeInternal(ticketType)) return false;
	const questions = loadConfig().questions;
	if (!Array.isArray(questions) || questions.length === 0) return false;
	return true;
}

async function offerFeedback(client, { user, ticketId, ticketType, typeFile }) {
	if (!user || !ticketId) return;
	if (!shouldOfferFeedback(typeFile, ticketType)) return;
	if (await alreadySubmitted(user.id, ticketId)) return;

	const cfg = loadConfig();
	const embed = buildOptInEmbed(client, { ticketId, ticketType }, cfg);
	const components = buildOptInComponents(ticketId, cfg);
	await func.sendDMWithRetry(user, { embeds: [embed], components }, { maxAttempts: 2, baseDelayMs: 500 });
}

async function startQuestionFlow(interaction, ticketId, ticketMeta) {
	const cfg = loadConfig();
	const questions = Array.isArray(cfg.questions) ? cfg.questions : [];
	if (!questions.length) {
		await interaction.update({
			content: cfg.thanks_complete || 'Thanks!',
			embeds: [],
			components: disabledRowFromMessage(interaction.message, 'Done'),
		}).catch(() => {});
		return;
	}

	setSession(interaction.user.id, ticketId, {
		index: 0,
		answers: {},
		ticketType: ticketMeta.ticketType || null,
		server: ticketMeta.server || null,
		staff: ticketMeta.staff || {},
		startedAt: Date.now(),
	});

	const q = questions[0];
	const embed = buildQuestionEmbed(
		clientFrom(interaction),
		q,
		{ ticketId, ticketType: ticketMeta.ticketType },
		1,
		questions.length,
		ticketMeta.staff
	);
	await interaction.update({
		embeds: [embed],
		components: buildQuestionComponents(ticketId, q),
		content: null,
	});
}

function clientFrom(interaction) {
	return interaction.client;
}

async function replySessionMessage(interaction, payload) {
	if (interaction.isModalSubmit()) {
		if (!interaction.deferred && !interaction.replied) {
			await interaction.deferUpdate().catch(() => {});
		}
		if (interaction.message) {
			await interaction.message.edit(payload);
			return;
		}
		await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
		return;
	}
	if (interaction.deferred || interaction.replied) {
		await interaction.editReply(payload).catch(async () => {
			if (interaction.message) await interaction.message.edit(payload);
		});
		return;
	}
	await interaction.update(payload);
}

async function advanceOrFinish(interaction, ticketId, session) {
	const cfg = loadConfig();
	const questions = Array.isArray(cfg.questions) ? cfg.questions : [];
	session.index += 1;

	if (session.index >= questions.length) {
		const staff = await loadTicketStaffContext(interaction.user.id, ticketId);
		await saveFeedback({
			userId: interaction.user.id,
			ticketId,
			ticketType: session.ticketType || staff.ticket_type || null,
			server: session.server || staff.server || null,
			answers: session.answers,
			staff,
		});
		clearSession(interaction.user.id, ticketId);
		const doneEmbed = new EmbedBuilder()
			.setColor(clientFrom(interaction).config?.bot_settings?.main_color || 0x208cdd)
			.setDescription(cfg.thanks_complete || 'Thanks for your feedback.');
		await replySessionMessage(interaction, {
			embeds: [doneEmbed],
			components: disabledRowFromMessage(interaction.message, 'Submitted'),
			content: null,
		});
		return;
	}

	setSession(interaction.user.id, ticketId, session);
	const q = questions[session.index];
	const embed = buildQuestionEmbed(
		clientFrom(interaction),
		q,
		{ ticketId, ticketType: session.ticketType },
		session.index + 1,
		questions.length,
		session.staff
	);
	await replySessionMessage(interaction, {
		embeds: [embed],
		components: buildQuestionComponents(ticketId, q),
		content: null,
	});
}

async function handleInteraction(client, interaction) {
	const parsed = parseCsatId(interaction.customId);
	if (!parsed || !parsed.ticketId) return false;

	const cfg = loadConfig();
	const ticketId = parsed.ticketId;

	if (interaction.isModalSubmit() && parsed.action === 'commentmodal') {
		const comment = (interaction.fields.getTextInputValue('csat_comment') || '').trim().slice(0, 500);
		const session = getSession(interaction.user.id, ticketId);
		if (!session) {
			await interaction.reply({ content: cfg.session_expired || 'Session expired.', flags: MessageFlags.Ephemeral }).catch(() => {});
			return true;
		}
		session.answers.comment = comment || null;
		await advanceOrFinish(interaction, ticketId, session);
		return true;
	}

	if (!interaction.isButton()) return false;

	if (parsed.action === 'no') {
		clearSession(interaction.user.id, ticketId);
		const embed = new EmbedBuilder()
			.setColor(client.config?.bot_settings?.main_color || 0x208cdd)
			.setDescription(cfg.thanks_decline || 'Thanks anyway.');
		await interaction.update({
			embeds: [embed],
			components: disabledRowFromMessage(interaction.message, 'Declined'),
			content: null,
		}).catch(() => {});
		return true;
	}

	if (parsed.action === 'yes') {
		if (await alreadySubmitted(interaction.user.id, ticketId)) {
			const embed = new EmbedBuilder()
				.setColor(client.config?.bot_settings?.main_color || 0x208cdd)
				.setDescription(cfg.already_submitted || 'Already submitted.');
			await interaction.update({
				embeds: [embed],
				components: disabledRowFromMessage(interaction.message, 'Done'),
				content: null,
			}).catch(() => {});
			return true;
		}
		const staff = await loadTicketStaffContext(interaction.user.id, ticketId);
		await startQuestionFlow(interaction, ticketId, {
			ticketType: staff.ticket_type || null,
			server: staff.server || null,
			staff,
		});
		return true;
	}

	const session = getSession(interaction.user.id, ticketId);
	if (!session) {
		await interaction.reply({ content: cfg.session_expired || 'Session expired.', flags: MessageFlags.Ephemeral }).catch(() => {});
		return true;
	}

	if (parsed.action === 'comment') {
		const modal = new ModalBuilder()
			.setCustomId(`csat:commentmodal:${ticketId}`)
			.setTitle((cfg.comment_modal_title || 'Optional comment').slice(0, 45));
		modal.addComponents(
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
					.setCustomId('csat_comment')
					.setLabel((cfg.comment_modal_label || 'Comment').slice(0, 45))
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(false)
					.setMaxLength(500)
			)
		);
		await interaction.showModal(modal);
		return true;
	}

	if (parsed.action === 'skip') {
		session.answers.comment = null;
		await advanceOrFinish(interaction, ticketId, session);
		return true;
	}

	if (parsed.action === 'ans' && parsed.questionId) {
		const questions = Array.isArray(cfg.questions) ? cfg.questions : [];
		const expected = questions[session.index];
		if (!expected || expected.id !== parsed.questionId) {
			await interaction.reply({ content: 'That question is no longer active.', flags: MessageFlags.Ephemeral }).catch(() => {});
			return true;
		}
		session.answers[parsed.questionId] = parsed.value;
		await advanceOrFinish(interaction, ticketId, session);
		return true;
	}

	return false;
}

module.exports = {
	loadConfig,
	shouldOfferFeedback,
	offerFeedback,
	handleInteraction,
	parseCsatId,
};
