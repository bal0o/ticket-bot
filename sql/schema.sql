-- Ticket Bot MySQL Schema
-- Run this to create the database structure

CREATE DATABASE IF NOT EXISTS ticketbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ticketbot;

-- Key-value store for backwards compatibility and simple lookups
CREATE TABLE IF NOT EXISTS kv_store (
    `key` VARCHAR(255) NOT NULL PRIMARY KEY,
    value LONGTEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Main tickets table (denormalized from PlayerStats structure)
CREATE TABLE IF NOT EXISTS tickets (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    ticket_id VARCHAR(255) NOT NULL,
    ticket_type VARCHAR(100),
    server VARCHAR(255),
    username VARCHAR(255),
    steam_id VARCHAR(255),
    responses TEXT,
    created_at BIGINT,
    close_time BIGINT,
    close_type VARCHAR(100),
    close_user VARCHAR(255),
    close_user_id VARCHAR(255),
    close_reason TEXT,
    transcript_url VARCHAR(500),
    global_ticket_number VARCHAR(255),
    channel_id VARCHAR(32),
    first_staff_response_at BIGINT,
    first_staff_response_user_id VARCHAR(255),
    first_staff_response_user VARCHAR(255),
    last_staff_response_at BIGINT,
    last_staff_response_user_id VARCHAR(255),
    last_staff_response_user VARCHAR(255),
    claimed_by_user_id VARCHAR(255),
    claimed_by_user VARCHAR(255),
    claimed_at BIGINT,
    INDEX idx_user_id (user_id),
    INDEX idx_ticket_id (ticket_id),
    INDEX idx_ticket_type (ticket_type),
    INDEX idx_server (server),
    INDEX idx_close_user_id (close_user_id),
    INDEX idx_created_at (created_at),
    INDEX idx_close_time (close_time),
    INDEX idx_channel_id (channel_id),
    INDEX idx_first_staff_response_user_id (first_staff_response_user_id),
    INDEX idx_claimed_by_user_id (claimed_by_user_id),
    UNIQUE KEY unique_user_ticket (user_id, ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Applications table
CREATE TABLE IF NOT EXISTS applications (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    username VARCHAR(255),
    type VARCHAR(100),
    server VARCHAR(255),
    stage VARCHAR(50) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    responses TEXT,
    INDEX idx_user_id (user_id),
    INDEX idx_stage (stage),
    INDEX idx_type (type),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Application tickets (linked tickets to applications)
CREATE TABLE IF NOT EXISTS application_tickets (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    application_id VARCHAR(255) NOT NULL,
    ticket_id VARCHAR(255) NOT NULL,
    channel_id VARCHAR(255),
    link_type VARCHAR(50) DEFAULT 'comms',
    created_at BIGINT NOT NULL,
    INDEX idx_application_id (application_id),
    INDEX idx_ticket_id (ticket_id),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Application history (stage changes)
CREATE TABLE IF NOT EXISTS application_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    application_id VARCHAR(255) NOT NULL,
    stage VARCHAR(50) NOT NULL,
    changed_at BIGINT NOT NULL,
    changed_by VARCHAR(255),
    note TEXT,
    INDEX idx_application_id (application_id),
    INDEX idx_changed_at (changed_at),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Application comments
CREATE TABLE IF NOT EXISTS application_comments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    application_id VARCHAR(255) NOT NULL,
    created_at BIGINT NOT NULL,
    created_by VARCHAR(255),
    comment TEXT,
    INDEX idx_application_id (application_id),
    INDEX idx_created_at (created_at),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Application schedules (interviews)
CREATE TABLE IF NOT EXISTS application_schedules (
    id VARCHAR(255) PRIMARY KEY,
    application_id VARCHAR(255) NOT NULL,
    scheduled_at BIGINT NOT NULL,
    staff_id VARCHAR(255),
    mode VARCHAR(50) DEFAULT 'voice',
    status VARCHAR(50) DEFAULT 'scheduled',
    created_at BIGINT NOT NULL,
    completed_at BIGINT,
    info JSON,
    INDEX idx_application_id (application_id),
    INDEX idx_scheduled_at (scheduled_at),
    INDEX idx_status (status),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- App mappings (channel/ticket to application)
CREATE TABLE IF NOT EXISTS app_mappings (
    mapping_type ENUM('channel', 'ticket', 'user_channels') NOT NULL,
    lookup_key VARCHAR(255) NOT NULL,
    application_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (mapping_type, lookup_key),
    INDEX idx_application_id (application_id),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Staff statistics
CREATE TABLE IF NOT EXISTS staff_stats (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    ticket_type VARCHAR(100),
    action_type VARCHAR(50),
    count INT DEFAULT 1,
    last_action BIGINT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_stat (user_id, ticket_type, action_type),
    INDEX idx_user_id (user_id),
    INDEX idx_ticket_type (ticket_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Server statistics
CREATE TABLE IF NOT EXISTS server_stats (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ticket_type VARCHAR(100) NOT NULL,
    button_type VARCHAR(50) NOT NULL,
    total_time_spent BIGINT DEFAULT 0,
    total_tickets_handled INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_stat (ticket_type, button_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- User ticket index (active ticket channels per user)
CREATE TABLE IF NOT EXISTS user_ticket_index (
    user_id VARCHAR(255) NOT NULL,
    channel_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Transcript filename index
CREATE TABLE IF NOT EXISTS transcript_index (
    filename VARCHAR(255) NOT NULL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    ticket_id VARCHAR(255) NOT NULL,
    ticket_type VARCHAR(100),
    INDEX idx_user_id (user_id),
    INDEX idx_ticket_id (ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-message log for tickets (used to build transcripts dynamically)
CREATE TABLE IF NOT EXISTS ticket_messages (
    message_id VARCHAR(32) NOT NULL PRIMARY KEY,
    channel_id VARCHAR(32) NOT NULL,
    channel_name VARCHAR(255),
    guild_id VARCHAR(32),
    author_id VARCHAR(32) NOT NULL,
    author_tag VARCHAR(64),
    author_username VARCHAR(64),
    author_is_bot TINYINT(1) DEFAULT 0,
    created_at BIGINT NOT NULL,
    content LONGTEXT,
    pinned TINYINT(1) DEFAULT 0,
    type SMALLINT,
    webhook_id VARCHAR(32),
    embeds JSON,
    attachments JSON,
    INDEX idx_channel_created (channel_id, created_at),
    INDEX idx_channel_name_created (channel_name, created_at),
    INDEX idx_author (author_id),
    INDEX idx_guild_channel (guild_id, channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Extra reporters added when tickets are merged into a surviving ticket
CREATE TABLE IF NOT EXISTS ticket_participants (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ticket_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    source_ticket_id VARCHAR(255) NULL,
    merged_at BIGINT NOT NULL,
    UNIQUE KEY unique_ticket_user (ticket_id, user_id),
    INDEX idx_ticket_id (ticket_id),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE OR REPLACE VIEW grafana_ticket_metrics AS
SELECT
    t.id AS ticket_pk,
    t.ticket_id,
    t.global_ticket_number,
    t.ticket_type,
    t.server,
    t.channel_id,
    t.user_id AS opener_id,
    t.username AS opener_name,
    CASE
        WHEN t.created_at IS NULL THEN NULL
        WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000)
        ELSE t.created_at
    END AS created_at,
    CASE
        WHEN t.close_time IS NULL THEN NULL
        WHEN t.close_time > 9999999999 THEN FLOOR(t.close_time / 1000)
        ELSE t.close_time
    END AS close_time,
    t.close_type,
    t.close_user_id,
    t.close_user,
    t.close_reason,
    CASE
        WHEN t.first_staff_response_at IS NULL THEN NULL
        WHEN t.first_staff_response_at > 9999999999 THEN FLOOR(t.first_staff_response_at / 1000)
        ELSE t.first_staff_response_at
    END AS first_staff_response_at,
    t.first_staff_response_user_id,
    t.first_staff_response_user,
    CASE
        WHEN t.last_staff_response_at IS NULL THEN NULL
        WHEN t.last_staff_response_at > 9999999999 THEN FLOOR(t.last_staff_response_at / 1000)
        ELSE t.last_staff_response_at
    END AS last_staff_response_at,
    t.last_staff_response_user_id,
    t.last_staff_response_user,
    t.claimed_by_user_id,
    t.claimed_by_user,
    CASE
        WHEN t.claimed_at IS NULL THEN NULL
        WHEN t.claimed_at > 9999999999 THEN FLOOR(t.claimed_at / 1000)
        ELSE t.claimed_at
    END AS claimed_at,
    (t.close_time IS NOT NULL OR t.close_type IS NOT NULL OR t.transcript_url IS NOT NULL) AS is_closed,
    CASE
        WHEN t.first_staff_response_at IS NULL OR t.created_at IS NULL THEN NULL
        ELSE GREATEST(
            0,
            (CASE WHEN t.first_staff_response_at > 9999999999 THEN FLOOR(t.first_staff_response_at / 1000) ELSE t.first_staff_response_at END)
            - (CASE WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000) ELSE t.created_at END)
        )
    END AS time_to_first_response_seconds,
    CASE
        WHEN t.close_time IS NULL OR t.created_at IS NULL THEN NULL
        ELSE GREATEST(
            0,
            (CASE WHEN t.close_time > 9999999999 THEN FLOOR(t.close_time / 1000) ELSE t.close_time END)
            - (CASE WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000) ELSE t.created_at END)
        )
    END AS time_open_seconds,
    CASE
        WHEN t.close_time IS NULL OR t.first_staff_response_at IS NULL THEN NULL
        ELSE GREATEST(
            0,
            (CASE WHEN t.close_time > 9999999999 THEN FLOOR(t.close_time / 1000) ELSE t.close_time END)
            - (CASE WHEN t.first_staff_response_at > 9999999999 THEN FLOOR(t.first_staff_response_at / 1000) ELSE t.first_staff_response_at END)
        )
    END AS first_response_to_close_seconds,
    CASE
        WHEN t.claimed_at IS NULL OR t.created_at IS NULL THEN NULL
        ELSE GREATEST(
            0,
            (CASE WHEN t.claimed_at > 9999999999 THEN FLOOR(t.claimed_at / 1000) ELSE t.claimed_at END)
            - (CASE WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000) ELSE t.created_at END)
        )
    END AS time_to_claim_seconds,
    CASE
        WHEN t.close_time IS NOT NULL OR t.close_type IS NOT NULL OR t.transcript_url IS NOT NULL THEN NULL
        ELSE GREATEST(
            0,
            UNIX_TIMESTAMP()
            - CASE
                WHEN t.last_staff_response_at IS NOT NULL THEN
                    CASE WHEN t.last_staff_response_at > 9999999999 THEN FLOOR(t.last_staff_response_at / 1000) ELSE t.last_staff_response_at END
                WHEN t.created_at IS NOT NULL THEN
                    CASE WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000) ELSE t.created_at END
                ELSE UNIX_TIMESTAMP()
            END
        )
    END AS open_wait_seconds
FROM tickets t;

CREATE OR REPLACE VIEW grafana_staff_involvement AS
SELECT
    m.ticket_pk,
    m.ticket_id,
    m.ticket_type,
    m.server,
    m.created_at,
    m.close_time,
    m.is_closed,
    m.time_to_first_response_seconds,
    m.time_open_seconds,
    m.first_response_to_close_seconds,
    m.time_to_claim_seconds,
    'first_responder' AS involvement,
    m.first_staff_response_user_id AS staff_user_id,
    m.first_staff_response_user AS staff_name
FROM grafana_ticket_metrics m
WHERE m.first_staff_response_user_id IS NOT NULL
UNION ALL
SELECT
    m.ticket_pk,
    m.ticket_id,
    m.ticket_type,
    m.server,
    m.created_at,
    m.close_time,
    m.is_closed,
    m.time_to_first_response_seconds,
    m.time_open_seconds,
    m.first_response_to_close_seconds,
    m.time_to_claim_seconds,
    'closer' AS involvement,
    m.close_user_id AS staff_user_id,
    m.close_user AS staff_name
FROM grafana_ticket_metrics m
WHERE m.close_user_id IS NOT NULL
UNION ALL
SELECT
    m.ticket_pk,
    m.ticket_id,
    m.ticket_type,
    m.server,
    m.created_at,
    m.close_time,
    m.is_closed,
    m.time_to_first_response_seconds,
    m.time_open_seconds,
    m.first_response_to_close_seconds,
    m.time_to_claim_seconds,
    'claimer' AS involvement,
    m.claimed_by_user_id AS staff_user_id,
    m.claimed_by_user AS staff_name
FROM grafana_ticket_metrics m
WHERE m.claimed_by_user_id IS NOT NULL;

CREATE OR REPLACE VIEW grafana_staff_messages AS
SELECT
    t.ticket_id,
    t.ticket_type,
    t.server,
    CASE
        WHEN t.created_at IS NULL THEN NULL
        WHEN t.created_at > 9999999999 THEN FLOOR(t.created_at / 1000)
        ELSE t.created_at
    END AS created_at,
    m.author_id AS staff_user_id,
    MAX(m.author_username) AS staff_name,
    COUNT(*) AS message_count,
    MIN(m.created_at) AS first_message_at,
    MAX(m.created_at) AS last_message_at
FROM tickets t
INNER JOIN ticket_messages m ON m.channel_id = t.channel_id
LEFT JOIN ticket_participants p ON p.ticket_id = t.ticket_id AND p.user_id = m.author_id
WHERE t.channel_id IS NOT NULL
  AND m.author_is_bot = 0
  AND m.author_id <> t.user_id
  AND p.id IS NULL
  AND (m.channel_name IS NULL OR m.channel_name NOT LIKE 'staff-chat-%')
GROUP BY t.ticket_id, t.ticket_type, t.server, t.created_at, m.author_id;

CREATE OR REPLACE VIEW grafana_staff_activity AS
SELECT
    sm.ticket_id,
    sm.ticket_type,
    sm.server,
    sm.created_at,
    tm.close_time,
    tm.is_closed,
    sm.staff_user_id,
    sm.staff_name,
    sm.message_count,
    CASE
        WHEN sm.first_message_at > 9999999999 THEN FLOOR(sm.first_message_at / 1000)
        ELSE sm.first_message_at
    END AS first_message_at,
    CASE
        WHEN sm.last_message_at > 9999999999 THEN FLOOR(sm.last_message_at / 1000)
        ELSE sm.last_message_at
    END AS last_message_at,
    tm.time_to_first_response_seconds AS queue_wait_seconds,
    GREATEST(
        0,
        (CASE WHEN sm.first_message_at > 9999999999 THEN FLOOR(sm.first_message_at / 1000) ELSE sm.first_message_at END)
        - sm.created_at
    ) AS age_at_engagement_seconds,
    CASE
        WHEN tm.close_time IS NULL THEN NULL
        ELSE GREATEST(
            0,
            tm.close_time
            - (CASE WHEN sm.first_message_at > 9999999999 THEN FLOOR(sm.first_message_at / 1000) ELSE sm.first_message_at END)
        )
    END AS handle_after_pickup_seconds,
    CASE
        WHEN tm.claimed_by_user_id = sm.staff_user_id AND tm.claimed_at IS NOT NULL THEN
            GREATEST(
                0,
                (CASE WHEN sm.first_message_at > 9999999999 THEN FLOOR(sm.first_message_at / 1000) ELSE sm.first_message_at END)
                - tm.claimed_at
            )
        ELSE NULL
    END AS claim_to_first_message_seconds,
    (tm.first_staff_response_user_id = sm.staff_user_id) AS is_first_responder,
    (tm.close_user_id = sm.staff_user_id) AS is_closer,
    (tm.claimed_by_user_id = sm.staff_user_id) AS is_claimer,
    (
        tm.first_staff_response_user_id = sm.staff_user_id
        AND tm.time_to_first_response_seconds > 14400
    ) AS is_stale_pickup
FROM grafana_staff_messages sm
INNER JOIN grafana_ticket_metrics tm ON tm.ticket_id = sm.ticket_id;


