const Discord = require('discord.js');
const jsdom = require('jsdom');
const fs = require('fs');
const { JSDOM } = jsdom;

// Cache the transcript HTML template to avoid sync disk reads on every close
let CACHED_TEMPLATE = null;

/**
 * Generate an HTML transcript for a ticket or thread channel
 * Modes:
 *  - full:  all messages from the ticket channel (or staff thread)
 *  - user:  only user-visible messages (user's messages + staff DMs to user)
 *  - staff: same as full, intended for the staff thread
 */
module.exports.fetch = async (channel, options) => {
    if (!channel) throw new ReferenceError('[Transcript Error] => "channel" is not defined');
    if (typeof options !== 'object') throw new SyntaxError('[Transcript Error] => typeof "options" must be an object');

    const dom = new JSDOM();
    const document = dom.window.document;
    const moment = require('moment');

    const opts = {
        numberOfMessages: options.numberOfMessages || 1000,
        channel,
        dateFormat: options.dateFormat || 'E, d MMM yyyy HH:mm:ss Z',
        dateLocale: options.dateLocale || 'en',
        DiscordID: options.DiscordID || null,
        mode: options.filterMode || options.mode || 'full',
        allowedMessageIds: Array.isArray(options.allowedMessageIds) ? new Set(options.allowedMessageIds) : null,
        isAnonTicket: !!options.isAnonTicket,
    };
    moment.locale(opts.dateLocale);

    // Collect messages (newest -> oldest)
    let messageCollection = new Discord.Collection();
    let lastId = undefined;
    for (let i = 0; i < 15 && messageCollection.size < opts.numberOfMessages; i++) {
        const fetched = await opts.channel.messages.fetch({ limit: 100, before: lastId }).catch(() => null);
        if (!fetched || fetched.size === 0) break;
        messageCollection = messageCollection.concat(fetched);
        lastId = fetched.lastKey();
    }

    // Load HTML template (cached)
    if (!CACHED_TEMPLATE) {
        CACHED_TEMPLATE = fs.readFileSync('./utils/template.html', 'utf8');
        if (!CACHED_TEMPLATE) throw new Error('Missing transcript HTML template');
    }

    // Helper: reaction by requested canonical emoji name (e.g., ':white_check_mark:', ':a:')
    const hasReactionByName = (msg, name) => !!(msg.reactions && msg.reactions.cache && msg.reactions.cache.some(r => (r.emoji?.name || '') === name));

    // Build filtered list
    const allMessages = Array.from(messageCollection.values());
    const pinnedIds = new Set(allMessages.filter(m => m.pinned).map(m => m.id));

    let filtered;
    if (opts.mode === 'user') {
        filtered = allMessages.filter(msg => {
            if (pinnedIds.has(msg.id)) return true; // include initial info embed
            // Exclude the help/instruction embed, Cheetos embed, and thread creation notice
            const firstEmbed = (msg.embeds && msg.embeds[0]) ? msg.embeds[0] : null;
            const helpEmbed = !!(firstEmbed && firstEmbed.title === 'How to Reply');
            const cheetosEmbed = !!(firstEmbed && firstEmbed.title === 'Cheetos Check');
            const isThreadNotice = (typeof msg.type === 'string') && /thread/i.test(msg.type);
            const mentionsStaffChat = (typeof msg.content === 'string') && /staff-chat/i.test(msg.content);
            return !(helpEmbed || cheetosEmbed || isThreadNotice || mentionsStaffChat);
        });
    } else {
        filtered = allMessages; // full/staff
    }

    // Chronological order (oldest -> newest)
    filtered = filtered.reverse();

    // Top info (hide user Discord ID in user transcripts)
    let topText = `<!---- Downloadable HTML Transcript - DOWNLOAD TO VIEW ---->\n` +
                 `<!---- Total of ${filtered.length} messages ---->\n` +
                 (opts.mode === 'user' ? '' : `<!---- Ticket Makers DiscordID: ${opts.DiscordID || 'unknown'} ---->\n`);

    // Header UI
    const info = document.createElement('div');
    info.className = 'info';
    const iconWrap = document.createElement('div');
    iconWrap.className = 'info__guild-icon-container';
    const gIcon = document.createElement('img');
    gIcon.className = 'info__guild-icon';
    try {
        gIcon.setAttribute('src', channel.guild?.iconURL() || 'https://cdn.discordapp.com/attachments/878008751855112192/895637636671229953/icon_clyde_blurple_RGB.png');
    } catch (_) {
        gIcon.setAttribute('src', 'https://cdn.discordapp.com/attachments/878008751855112192/895637636671229953/icon_clyde_blurple_RGB.png');
    }
    iconWrap.appendChild(gIcon);
    info.appendChild(iconWrap);

    const core = document.createElement('div');
    core.appendChild(info);

    // Build close summary to append at the bottom later
    let closeHeader = null;
    if (options && (options.closeReason || options.closedBy || options.responseTime)) {
        closeHeader = document.createElement('div');
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
            row.appendChild(k); row.appendChild(v);
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
            row.appendChild(k); row.appendChild(v);
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
            row.appendChild(k); row.appendChild(v);
            closeHeader.appendChild(row);
        }
    }

    // Render messages
    for (let msg of filtered) {
        // Determine display identity per new rules
        const isUserForward = !!msg.webhookId;
        let rawContent = '';
        try { rawContent = msg.cleanContent || msg.content || ''; } catch (_) {}
        const startsWithMe = /^!me\b/i.test(rawContent);
        const startsWithAnon = /^!r\b/i.test(rawContent);
        const staffDefaultsAnon = !!opts.isAnonTicket;
        const shouldShowAsBrit = (opts.mode === 'user') && !isUserForward && (startsWithAnon || (!startsWithMe && staffDefaultsAnon));

        let baseName = (msg.author?.tag || 'Unknown');
        if (startsWithAnon && opts.mode !== 'user' && !isUserForward) {
            baseName = `${baseName} (Anon)`;
        }
        const displayName = shouldShowAsBrit ? 'Brit Support' : baseName;
        const displayAvatar = shouldShowAsBrit ? 'https://cdn.discordapp.com/embed/avatars/0.png' : (msg.author?.displayAvatarURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png');

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
        const when = (opts.mode === 'user')
            ? `${moment(msg.createdAt).format(opts.dateFormat)} ${moment.locale(opts.dateLocale).toUpperCase()}`
            : `${msg.author?.id || 'unknown'} | ${moment(msg.createdAt).format(opts.dateFormat)} ${moment.locale(opts.dateLocale).toUpperCase()}`;
        meta.appendChild(document.createTextNode(when));
        titleDiv.appendChild(meta);
        messageContainer.appendChild(titleDiv);

        // Content (strip leading !me/!r prefixes from staff messages for user view)
        let content = '';
        try { content = msg.cleanContent || msg.content || ''; } catch (_) {}
        if (!isUserForward && /^!(me|r)\b/i.test(content)) {
            content = content.replace(/^!(?:me|r)\b\s*/i, '');
        }
        if (content) {
            const node = document.createElement('div');
            node.className = 'maincontent';
            content = content.replace(/<(\/?)script>/gi, '&lt;$1script&gt;');
            node.innerHTML = content;
            messageContainer.appendChild(node);
        }

        // Embeds
        for (const emb of msg.embeds.values()) {
            const body = document.createElement('div');
            body.className = 'EmbedBody';
            if (emb.title) {
                const t = document.createElement('span');
                t.className = 'EmbedTitle';
                t.innerHTML = emb.title;
                body.appendChild(t);
            }
            if (emb.description) {
                const d = document.createElement('span');
                d.className = 'EmbedDesc';
                d.innerHTML = emb.description;
                body.appendChild(d);
            }
            if (emb.fields && emb.fields.length) {
                for (const f of emb.fields) {
                    const fb = document.createElement('div');
                    fb.className = 'EmbedFieldBody';
                    const ft = document.createElement('div');
                    ft.className = 'EmbedFieldTitle';
                    ft.appendChild(document.createTextNode(f.name || ''));
                    const fc = document.createElement('div');
                    fc.className = 'EmbedFieldContent';
                    fc.innerHTML = f.value || '';
                    fb.appendChild(ft);
                    fb.appendChild(fc);
                    body.appendChild(fb);
                }
            }
            messageContainer.appendChild(body);
        }

        // Attachments
        for (const att of msg.attachments.values()) {
            const url = att.url;
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
    // Append close summary at the bottom
    if (closeHeader) {
        core.appendChild(closeHeader);
    }
    
    return Buffer.from(topText + CACHED_TEMPLATE + core.innerHTML);
};

