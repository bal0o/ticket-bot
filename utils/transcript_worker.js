
const { parentPort, workerData, isMainThread } = require('worker_threads');
const { JSDOM } = require('jsdom');
const fs = require('fs');

function sanitizeHtml(text) {
	if (typeof text !== 'string') return '';
	return text.replace(/<(\/?)script>/gi, '&lt;$1script&gt;');
}

function renderTranscript(messages, options) {
	const dom = new JSDOM();
	const document = dom.window.document;

	// Load cached template
	const template = fs.readFileSync('./utils/template.html', 'utf8');

	// Filter by mode
	const pinnedIds = new Set(messages.filter(m => m.pinned).map(m => m.id));
	let list;
	if (options.mode === 'user') {
		list = messages.filter(msg => {
			if (pinnedIds.has(msg.id)) return true;
			const firstEmbedTitle = (msg.embeds && msg.embeds[0] && msg.embeds[0].title) || '';
			const helpEmbed = firstEmbedTitle === 'How to Reply';
			const cheetosEmbed = firstEmbedTitle === 'Cheetos Check';
			const isThreadNotice = typeof msg.type === 'string' && /thread/i.test(msg.type);
			const mentionsStaffChat = typeof msg.content === 'string' && /staff-chat/i.test(msg.content);
			return !(helpEmbed || cheetosEmbed || isThreadNotice || mentionsStaffChat);
		});
	} else {
		list = messages;
	}

	// Chronological order
	list = list.slice().reverse();

	const core = document.createElement('div');

	const ticketOpenerId = options.DiscordID != null ? String(options.DiscordID) : null;
	for (const msg of list) {
		const isFromTicketOpener = ticketOpenerId != null && msg.author?.id != null && String(msg.author.id) === ticketOpenerId;
		const isStaffAnon = options.mode === 'user' && !msg.webhookId && !isFromTicketOpener && options.isAnonTicket && !/^!me\b/i.test(msg.content);
		const displayName = isStaffAnon ? 'Brit Support' : (msg.author?.tag || msg.author?.username || 'Unknown');
		const displayAvatar = isStaffAnon ? 'https://cdn.discordapp.com/embed/avatars/0.png' : (msg.author?.avatarURL || 'https://cdn.discordapp.com/embed/avatars/0.png');

		const parent = document.createElement('div');
		parent.className = 'parent-container';
		const avatarDiv = document.createElement('div');
		avatarDiv.className = 'avatar-container';
		const img = document.createElement('img');
		img.setAttribute('src', displayAvatar);
		img.className = 'avatar';
		avatarDiv.appendChild(img);
		parent.appendChild(avatarDiv);

		const messageContainer = document.createElement('div');
		messageContainer.className = 'message-container';
		const titleDiv = document.createElement('div');
		titleDiv.className = 'titleDiv';
		const nameSpan = document.createElement('span');
		nameSpan.className = 'nameElement';
		nameSpan.appendChild(document.createTextNode(displayName));
		titleDiv.appendChild(nameSpan);
		const meta = document.createElement('span');
		meta.className = 'IDtimeElement';
		const when = options.mode === 'user' ? (new Date(msg.createdAt)).toString() : `${msg.author?.id || 'unknown'} | ${(new Date(msg.createdAt)).toString()}`;
		meta.appendChild(document.createTextNode(when));
		titleDiv.appendChild(meta);
		messageContainer.appendChild(titleDiv);

		let content = msg.content || '';
		if (options.mode === 'user' && /^!(me|r)\b/i.test(content)) content = content.replace(/^!(?:me|r)\b\s*/i, '');
		if (content) {
			const node = document.createElement('div');
			node.className = 'maincontent';
			node.innerHTML = sanitizeHtml(content);
			messageContainer.appendChild(node);
		}

		// Embeds
		for (const emb of (msg.embeds || [])) {
			const body = document.createElement('div');
			body.className = 'EmbedBody';
			if (emb.title) {
				const t = document.createElement('span');
				t.className = 'EmbedTitle';
				t.innerHTML = sanitizeHtml(emb.title);
				body.appendChild(t);
			}
			if (emb.description) {
				const d = document.createElement('span');
				d.className = 'EmbedDesc';
				d.innerHTML = sanitizeHtml(emb.description);
				body.appendChild(d);
			}
			if (Array.isArray(emb.fields)) {
				for (const f of emb.fields) {
					const fb = document.createElement('div');
					fb.className = 'EmbedFieldBody';
					const ft = document.createElement('div');
					ft.className = 'EmbedFieldTitle';
					ft.appendChild(document.createTextNode(f.name || ''));
					const fc = document.createElement('div');
					fc.className = 'EmbedFieldContent';
					fc.innerHTML = sanitizeHtml(f.value || '');
					fb.appendChild(ft);
					fb.appendChild(fc);
					body.appendChild(fb);
				}
			}
			messageContainer.appendChild(body);
		}

		// Attachments
		for (const url of (msg.attachments || [])) {
			if (/\.(gif|png|jpe?g)$/i.test(url)) {
				const pic = document.createElement('img');
				pic.setAttribute('src', url);
				messageContainer.appendChild(pic);
			} else {
				const link = document.createElement('a');
				link.className = 'AttachmentFile';
				link.appendChild(document.createTextNode(url));
				link.title = url;
				link.href = url;
				messageContainer.appendChild(link);
			}
		}

		parent.appendChild(messageContainer);
		core.appendChild(parent);
	}

	// Close summary (for non-user modes include details)
	if (options.closeReason || options.closedBy || options.responseTime) {
		const closeHeader = document.createElement('div');
		closeHeader.className = 'EmbedBody';
		const title = document.createElement('span');
		title.className = 'EmbedTitle';
		title.appendChild(document.createTextNode('Close Summary'));
		closeHeader.appendChild(title);
		if (options.closedBy) {
			const row = document.createElement('div'); row.className = 'EmbedFieldBody';
			const k = document.createElement('div'); k.className = 'EmbedFieldTitle'; k.appendChild(document.createTextNode('Closed By'));
			const v = document.createElement('div'); v.className = 'EmbedFieldContent'; v.appendChild(document.createTextNode(options.closedBy));
			row.appendChild(k); row.appendChild(v);
			closeHeader.appendChild(row);
		}
		if (options.closeReason) {
			const row = document.createElement('div'); row.className = 'EmbedFieldBody';
			const k = document.createElement('div'); k.className = 'EmbedFieldTitle'; k.appendChild(document.createTextNode('Reason'));
			const v = document.createElement('div'); v.className = 'EmbedFieldContent'; v.appendChild(document.createTextNode(options.closeReason));
			row.appendChild(k); row.appendChild(v);
			closeHeader.appendChild(row);
		}
		if (options.responseTime) {
			const row = document.createElement('div'); row.className = 'EmbedFieldBody';
			const k = document.createElement('div'); k.className = 'EmbedFieldTitle'; k.appendChild(document.createTextNode('Response Time'));
			const v = document.createElement('div'); v.className = 'EmbedFieldContent'; v.appendChild(document.createTextNode(options.responseTime));
			row.appendChild(k); row.appendChild(v);
			closeHeader.appendChild(row);
		}
		core.appendChild(closeHeader);
	}

	const topText = `<!---- Downloadable HTML Transcript - DOWNLOAD TO VIEW ---->\n` +
		`<!---- Total of ${list.length} messages ---->\n` +
		(options.mode === 'user' ? '' : `<!---- Ticket Makers DiscordID: ${options.DiscordID || 'unknown'} ---->\n`);

	return Buffer.from(topText + template + core.innerHTML);
}

async function writeFileSafe(path, data) {
	await fs.promises.mkdir(require('path').dirname(path), { recursive: true }).catch(()=>{});
	await fs.promises.writeFile(path, data);
}

async function run(job) {
	try {
		const { savePath, baseUrl, channelName, DiscordID, isAnonTicket, closeReason, closedBy, responseTime, messagesMain, messagesStaff } = job;
		// Full transcript
		const full = renderTranscript(messagesMain, { mode: 'full', DiscordID, isAnonTicket, closeReason, closedBy, responseTime });
		await writeFileSafe(`${savePath}/${channelName}.full.html`, full);
		// User transcript
		const user = renderTranscript(messagesMain, { mode: 'user', DiscordID, isAnonTicket, closeReason, closedBy, responseTime });
		await writeFileSafe(`${savePath}/${channelName}.html`, user);
		// Staff thread transcript
		if (Array.isArray(messagesStaff) && messagesStaff.length > 0) {
			const staff = renderTranscript(messagesStaff, { mode: 'staff', DiscordID, isAnonTicket, closeReason, closedBy, responseTime });
			await writeFileSafe(`${savePath}/${channelName}.staff.html`, staff);
		}
		if (parentPort) parentPort.postMessage({ ok: true, url: `${baseUrl}${channelName}.full.html` });
	} catch (e) {
		if (parentPort) parentPort.postMessage({ ok: false, error: e?.message || String(e) });
	}
}

if (!isMainThread) {
	run(workerData);
}


