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
    INDEX idx_user_id (user_id),
    INDEX idx_ticket_id (ticket_id),
    INDEX idx_ticket_type (ticket_type),
    INDEX idx_server (server),
    INDEX idx_close_user_id (close_user_id),
    INDEX idx_created_at (created_at),
    INDEX idx_close_time (close_time),
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

