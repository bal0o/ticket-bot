const { JSDOM } = require('jsdom');
const fs = require('fs');

function sanitizeHtml(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/<(\/?)script>/gi, '&lt;$1script&gt;');
}

function linkify(text) {
    if (typeof text !== 'string' || !text) return text;
    // Very simple URL matcher; safe because input is already sanitized
    return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}

function normalizeRows(rows, options) {
    const pinnedIds = new Set(rows.filter(r => r.pinned).map(r => r.message_id));
    let list;
    if (options.mode === 'user') {
        list = rows.filter(msg => {
            if (pinnedIds.has(msg.message_id)) return true;
            // msg.embeds may be a JSON string from MySQL; parse if needed
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
    // chronological
    return list.slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

function renderTranscriptFromRows(rows, options) {
    const dom = new JSDOM();
    const document = dom.window.document;

    const template = fs.readFileSync('./utils/template.html', 'utf8');

    const list = normalizeRows(rows || [], options || {});

    const core = document.createElement('div');

    const ticketOpenerId = options.DiscordID != null ? String(options.DiscordID) : null;

    for (const msg of list) {
        const isFromTicketOpener =
            ticketOpenerId != null && msg.author_id != null && String(msg.author_id) === ticketOpenerId;

        const contentStr =
            typeof msg.content === 'string' ? msg.content : msg.content != null ? String(msg.content) : '';

        const isStaffAnon =
            options.mode === 'user' &&
            !msg.webhook_id &&
            !isFromTicketOpener &&
            options.isAnonTicket &&
            !/^!me\b/i.test(contentStr);

        const displayName = isStaffAnon
            ? 'Brit Support'
            : msg.author_tag || msg.author_username || 'Unknown';

        const displayAvatar =
            'https://cdn.discordapp.com/embed/avatars/0.png';

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
        const when =
            options.mode === 'user'
                ? new Date((msg.created_at || 0) * 1000).toString()
                : `${msg.author_id || 'unknown'} | ${new Date(
                      (msg.created_at || 0) * 1000
                  ).toString()}`;
        meta.appendChild(document.createTextNode(when));
        titleDiv.appendChild(meta);
        messageContainer.appendChild(titleDiv);

        let content = contentStr;
        if (options.mode === 'user' && /^!(me|r)\b/i.test(content)) {
            content = content.replace(/^!(?:me|r)\b\s*/i, '');
        }

        // Embeds
        let embeds = [];
        try {
            embeds = Array.isArray(msg.embeds) ? msg.embeds : JSON.parse(msg.embeds || '[]');
        } catch (_) {
            embeds = [];
        }

        // Attachments
        let attachments = [];
        try {
            attachments = Array.isArray(msg.attachments)
                ? msg.attachments
                : JSON.parse(msg.attachments || '[]');
        } catch (_) {
            attachments = [];
        }

        // If there is literally nothing to show (no content, no embeds, no attachments),
        // skip rendering this message row to avoid blank lines in the transcript.
        const hasVisibleContent =
            (content && content.trim().length > 0) ||
            (embeds && embeds.length > 0) ||
            (attachments && attachments.length > 0);
        if (!hasVisibleContent) {
            continue;
        }

        if (content) {
            const node = document.createElement('div');
            node.className = 'maincontent';
            node.innerHTML = linkify(sanitizeHtml(content));
            messageContainer.appendChild(node);
        }

        for (const emb of embeds) {
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

        for (const att of attachments) {
            const url = att.url || '';
            if (/\.(gif|png|jpe?g)$/i.test(url)) {
                const pic = document.createElement('img');
                pic.setAttribute('src', url);
                messageContainer.appendChild(pic);
            } else if (url) {
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

    // Close summary
    if (options.closeReason || options.closedBy || options.responseTime) {
        const closeHeader = document.createElement('div');
        closeHeader.className = 'EmbedBody';
        const title = document.createElement('span');
        title.className = 'EmbedTitle';
        title.appendChild(document.createTextNode('Close Summary'));
        closeHeader.appendChild(title);
        if (options.closedBy) {
            const row = document.createElement('div');
            row.className = 'EmbedFieldBody';
            const k = document.createElement('div');
            k.className = 'EmbedFieldTitle';
            k.appendChild(document.createTextNode('Closed By'));
            const v = document.createElement('div');
            v.className = 'EmbedFieldContent';
            v.appendChild(document.createTextNode(options.closedBy));
            row.appendChild(k);
            row.appendChild(v);
            closeHeader.appendChild(row);
        }
        if (options.closeReason) {
            const row = document.createElement('div');
            row.className = 'EmbedFieldBody';
            const k = document.createElement('div');
            k.className = 'EmbedFieldTitle';
            k.appendChild(document.createTextNode('Reason'));
            const v = document.createElement('div');
            v.className = 'EmbedFieldContent';
            v.appendChild(document.createTextNode(options.closeReason));
            row.appendChild(k);
            row.appendChild(v);
            closeHeader.appendChild(row);
        }
        if (options.responseTime) {
            const row = document.createElement('div');
            row.className = 'EmbedFieldBody';
            const k = document.createElement('div');
            k.className = 'EmbedFieldTitle';
            k.appendChild(document.createTextNode('Response Time'));
            const v = document.createElement('div');
            v.className = 'EmbedFieldContent';
            v.appendChild(document.createTextNode(options.responseTime));
            row.appendChild(k);
            row.appendChild(v);
            closeHeader.appendChild(row);
        }
        core.appendChild(closeHeader);
    }

    const topText =
        '<!---- Downloadable HTML Transcript - DOWNLOAD TO VIEW ---->\n' +
        `<!---- Total of ${list.length} messages ---->\n` +
        (options.mode === 'user'
            ? ''
            : `<!---- Ticket Makers DiscordID: ${options.DiscordID || 'unknown'} ---->\n`);

    return Buffer.from(topText + template + core.innerHTML);
}

module.exports = { renderTranscriptFromRows };

