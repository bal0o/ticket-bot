const fs = require('fs');

let cachedTemplate = null;

function escapeHtml(text) {
	if (typeof text !== 'string') return '';
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function sanitizeHtml(text) {
	if (typeof text !== 'string') return '';
	return text.replace(/<(\/?)script>/gi, '&lt;$1script&gt;');
}

function linkify(text) {
	if (typeof text !== 'string' || !text) return text;
	return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}

function getTemplate() {
	if (!cachedTemplate) {
		cachedTemplate = fs.readFileSync('./utils/template.html', 'utf8');
	}
	return cachedTemplate;
}

function normalizeRows(rows, options) {
	const pinnedIds = new Set(rows.filter(r => r.pinned).map(r => r.message_id));
	let list;
	if (options.mode === 'user') {
		list = rows.filter(msg => {
			if (pinnedIds.has(msg.message_id)) return true;
			let embeds = [];
			try {
				embeds = Array.isArray(msg.embeds) ? msg.embeds : JSON.parse(msg.embeds || '[]');
			} catch (_) {
				embeds = [];
			}
			const firstEmbedTitle = (embeds[0] && embeds[0].title) || '';
			const helpEmbed = firstEmbedTitle === 'How to Reply';
			const cheetosEmbed = firstEmbedTitle === 'Cheetos Check';
			const isThreadNotice = typeof msg.type === 'string' && /thread/i.test(msg.type);
			const mentionsStaffChat = typeof msg.content === 'string' && /staff-chat/i.test(msg.content);
			const content = typeof msg.content === 'string' ? msg.content : '';
			const isInternalError =
				!!msg.author_is_bot &&
				/There was an error sending your message\. Please try again\./i.test(content);
			return !(helpEmbed || cheetosEmbed || isThreadNotice || mentionsStaffChat || isInternalError);
		});
	} else {
		list = rows;
	}
	return list.slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

function renderEmbed(emb) {
	let html = '<div class="EmbedBody">';
	if (emb.title) {
		html += `<span class="EmbedTitle">${sanitizeHtml(emb.title)}</span>`;
	}
	if (emb.description) {
		html += `<span class="EmbedDesc">${sanitizeHtml(emb.description)}</span>`;
	}
	if (Array.isArray(emb.fields)) {
		for (const f of emb.fields) {
			html += '<div class="EmbedFieldBody">';
			html += `<div class="EmbedFieldTitle">${escapeHtml(f.name || '')}</div>`;
			html += `<div class="EmbedFieldContent">${sanitizeHtml(f.value || '')}</div>`;
			html += '</div>';
		}
	}
	html += '</div>';
	return html;
}

function renderCloseSummary(options) {
	if (!options.closeReason && !options.closedBy && !options.responseTime) return '';
	let html = '<div class="EmbedBody"><span class="EmbedTitle">Close Summary</span>';
	if (options.closedBy) {
		html += '<div class="EmbedFieldBody">';
		html += '<div class="EmbedFieldTitle">Closed By</div>';
		html += `<div class="EmbedFieldContent">${escapeHtml(options.closedBy)}</div>`;
		html += '</div>';
	}
	if (options.closeReason) {
		html += '<div class="EmbedFieldBody">';
		html += '<div class="EmbedFieldTitle">Reason</div>';
		html += `<div class="EmbedFieldContent">${escapeHtml(options.closeReason)}</div>`;
		html += '</div>';
	}
	if (options.responseTime) {
		html += '<div class="EmbedFieldBody">';
		html += '<div class="EmbedFieldTitle">Response Time</div>';
		html += `<div class="EmbedFieldContent">${escapeHtml(options.responseTime)}</div>`;
		html += '</div>';
	}
	html += '</div>';
	return html;
}

function renderTranscriptFromRows(rows, options) {
	const opts = options || {};
	const list = normalizeRows(rows || [], opts);
	const ticketOpenerId = opts.DiscordID != null ? String(opts.DiscordID) : null;
	let core = '';

	for (const msg of list) {
		const isFromTicketOpener =
			ticketOpenerId != null && msg.author_id != null && String(msg.author_id) === ticketOpenerId;

		const contentStr =
			typeof msg.content === 'string' ? msg.content : msg.content != null ? String(msg.content) : '';

		const isStaffAnon =
			opts.mode === 'user' &&
			!msg.webhook_id &&
			!isFromTicketOpener &&
			opts.isAnonTicket &&
			!/^!me\b/i.test(contentStr);

		const displayName = isStaffAnon
			? 'Brit Support'
			: msg.author_tag || msg.author_username || 'Unknown';

		const displayAvatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
		const when =
			opts.mode === 'user'
				? new Date((msg.created_at || 0) * 1000).toString()
				: `${msg.author_id || 'unknown'} | ${new Date((msg.created_at || 0) * 1000).toString()}`;

		let content = contentStr;
		if (opts.mode === 'user' && /^!(me|r)\b/i.test(content)) {
			content = content.replace(/^!(?:me|r)\b\s*/i, '');
		}

		let embeds = [];
		try {
			embeds = Array.isArray(msg.embeds) ? msg.embeds : JSON.parse(msg.embeds || '[]');
		} catch (_) {
			embeds = [];
		}

		let attachments = [];
		try {
			attachments = Array.isArray(msg.attachments)
				? msg.attachments
				: JSON.parse(msg.attachments || '[]');
		} catch (_) {
			attachments = [];
		}

		const hasVisibleContent =
			(content && content.trim().length > 0) ||
			(embeds && embeds.length > 0) ||
			(attachments && attachments.length > 0);
		if (!hasVisibleContent) continue;

		core += '<div class="parent-container">';
		core += '<div class="avatar-container">';
		core += `<img src="${displayAvatar}" class="avatar">`;
		core += '</div>';
		core += '<div class="message-container">';
		core += '<div class="titleDiv">';
		core += `<span class="nameElement">${escapeHtml(displayName)}</span>`;
		core += `<span class="IDtimeElement">${escapeHtml(when)}</span>`;
		core += '</div>';

		if (content) {
			core += `<div class="maincontent">${linkify(sanitizeHtml(content))}</div>`;
		}

		for (const emb of embeds) {
			core += renderEmbed(emb);
		}

		for (const att of attachments) {
			const url = att.url || '';
			if (/\.(gif|png|jpe?g)$/i.test(url)) {
				core += `<img src="${escapeHtml(url)}">`;
			} else if (url) {
				const safe = escapeHtml(url);
				core += `<a class="AttachmentFile" href="${safe}" title="${safe}">${safe}</a>`;
			}
		}

		core += '</div></div>';
	}

	core += renderCloseSummary(opts);

	const topText =
		'<!---- Downloadable HTML Transcript - DOWNLOAD TO VIEW ---->\n' +
		`<!---- Total of ${list.length} messages ---->\n` +
		(opts.mode === 'user'
			? ''
			: `<!---- Ticket Makers DiscordID: ${opts.DiscordID || 'unknown'} ---->\n`);

	return Buffer.from(topText + getTemplate() + core);
}

module.exports = { renderTranscriptFromRows };
