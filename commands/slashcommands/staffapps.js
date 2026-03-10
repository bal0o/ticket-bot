const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { createDB } = require('../../utils/mysql');

const db = createDB();

function normalizeStaffAppsFlag(flag, fallback) {
    if (flag === null || flag === undefined) return !!fallback;
    if (typeof flag === 'boolean') return flag;
    if (typeof flag === 'number') return flag !== 0;
    if (typeof flag === 'string') {
        const v = flag.trim().toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
        if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
    }
    return !!flag;
}

function getMessageId() {
    try {
        const msgPath = path.join(__dirname, '../../config/messageid.json');
        const raw = fs.readFileSync(msgPath, 'utf8');
        const data = JSON.parse(raw);
        return data && typeof data.messageId === 'string' ? data : { messageId: '', internalMessageId: data?.internalMessageId || '' };
    } catch (_) {
        return { messageId: '', internalMessageId: '' };
    }
}

function setMessageId(messageId, internalMessageId) {
    const msgPath = path.join(__dirname, '../../config/messageid.json');
    const prev = getMessageId();
    const payload = { messageId: messageId || prev.messageId, internalMessageId: internalMessageId != null ? internalMessageId : prev.internalMessageId };
    fs.writeFileSync(msgPath, JSON.stringify(payload, null, 0));
}

async function rebuildMainEmbed(client) {
    const handlerRaw = require('../../content/handler/handler.json');
    const handlerData = require('../../content/handler/options.json');
    const keys = Object.keys(handlerData.options || {});
    const rows = [];
    let usedCustoms = '';

    // Resolve staff applications feature flag in the same way as ready.js
    let staffAppsEnabled = normalizeStaffAppsFlag(handlerRaw.staff_applications_enabled, true);
    try {
        const flag = await db.get('FeatureFlags.StaffApplications.Enabled');
        staffAppsEnabled = normalizeStaffAppsFlag(flag, staffAppsEnabled);
    } catch (_) {}

    for (const key of keys) {
        const opt = handlerData.options[key];
        if (!opt) continue;

        const questionFilesystem = require(`../../content/questions/${opt.question_file}`);
        if (questionFilesystem.internal) continue;
        if (questionFilesystem.staff_application === true && staffAppsEnabled === false) continue;

        if (questionFilesystem.active_ticket_button_content &&
            questionFilesystem.active_ticket_button_content.accept?.enabled === false &&
            questionFilesystem.active_ticket_button_content.deny?.enabled === false &&
            questionFilesystem.active_ticket_button_content.custom_response_message?.enabled === false &&
            questionFilesystem.active_ticket_button_content.make_a_ticket?.enabled === false) {
            continue;
        }
        if (!['PRIMARY', 'SECONDARY', 'DANGER', 'SUCCESS'].includes(opt.button_type)) continue;
        if (!opt.unique_button_identifier || opt.unique_button_identifier === '') continue;

        const customId = opt.unique_button_identifier.toLowerCase().replace(/ /g, '');
        if (usedCustoms.includes(customId)) continue;
        usedCustoms += ' - ' + customId;

        const styleKey = (opt.button_type || 'PRIMARY').toUpperCase();
        const styleEnum = ButtonStyle[styleKey] || ButtonStyle.Primary;

        let row = rows[rows.length - 1];
        if (!row || row.components.length >= 5) {
            row = new ActionRowBuilder();
            rows.push(row);
        }
        const btn = new ButtonBuilder().setCustomId(customId).setLabel(key).setStyle(styleEnum);
        if (opt.button_emoji) btn.setEmoji(opt.button_emoji);
        row.addComponents(btn);

        if (rows.length >= 5 && row.components.length >= 5) break;
    }

    if (rows.length === 0) return null;

    const guildName = client.guilds?.cache.get(client.config.channel_ids.public_guild_id)?.name || 'Server';
    const embed = new EmbedBuilder()
        .setTitle((handlerRaw.title || '').replace('{{SERVER}}', guildName))
        .setColor(client.config.bot_settings?.main_color ?? 0)
        .setDescription(handlerRaw.description || '')
        .setFooter({ text: client.user.username, iconURL: client.user.displayAvatarURL() });

    return { embeds: [embed], components: rows };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('staffapps')
        .setDescription('Enable, disable, or check status of the Staff Application button.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub
                .setName('enable')
                .setDescription('Enable the Staff Application button for users'))
        .addSubcommand(sub =>
            sub
                .setName('disable')
                .setDescription('Disable the Staff Application button for users'))
        .addSubcommand(sub =>
            sub
                .setName('status')
                .setDescription('Show whether the Staff Application button is currently enabled')),

    async execute(interaction, client) {
        const sub = interaction.options.getSubcommand();
        const key = 'FeatureFlags.StaffApplications.Enabled';

        if (sub === 'status') {
            let enabled = await db.get(key);
            enabled = normalizeStaffAppsFlag(
                enabled,
                client.config.bot_settings.staff_applications_enabled
            );
            return interaction.reply({
                content: `Staff applications are currently **${enabled ? 'ENABLED' : 'DISABLED'}**.`,
                ephemeral: true
            });
        }

        const enable = sub === 'enable';
        try {
            await db.set(key, enable);
        } catch (_) {}

        await interaction.deferReply({ ephemeral: true });

        const channelId = client.config?.channel_ids?.post_embed_channel_id;
        const postChannel = channelId ? client.channels.cache.get(channelId) : null;
        if (!postChannel) {
            return interaction.editReply({
                content: `Staff application button has been **${enable ? 'ENABLED' : 'DISABLED'}**, but the main embed could not be refreshed (embed channel not found).`
            });
        }

        const messageIdData = getMessageId();
        if (messageIdData.messageId) {
            try {
                const oldMsg = await postChannel.messages.fetch(messageIdData.messageId).catch(() => null);
                if (oldMsg) await oldMsg.delete();
            } catch (_) {}
        }

        const payload = await rebuildMainEmbed(client);
        if (!payload) {
            return interaction.editReply({
                content: `Staff application button has been **${enable ? 'ENABLED' : 'DISABLED'}**, but the main embed could not be rebuilt (no valid buttons).`
            });
        }

        const newMsg = await postChannel.send(payload).catch(() => null);
        if (newMsg) {
            setMessageId(newMsg.id, messageIdData.internalMessageId);
        }

        return interaction.editReply({
            content: `Staff application button has been **${enable ? 'ENABLED' : 'DISABLED'}** and the embed has been refreshed.`
        });
    }
};

