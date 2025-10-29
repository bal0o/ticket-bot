# Running MySQL Migration in Docker

This guide explains how to run the MySQL migration script when deploying with Docker.

## Prerequisites

1. **MySQL server running** (can be a separate container or external server)
2. **Database schema created** (run `sql/schema.sql` on MySQL server)
3. **Old SQLite data** (if migrating from existing installation)

## Option 1: One-Time Migration (Recommended)

Run the migration manually before starting the bot:

```bash
# 1. Ensure MySQL schema is created
mysql -h <mysql-host> -u root -p < sql/schema.sql

# 2. Run migration using Docker
docker-compose run --rm -e RUN_MODE=bot bot node scripts/migrate_to_mysql.js

# Or if MySQL is external, ensure it's accessible:
docker-compose run --rm -e RUN_MODE=bot bot node scripts/migrate_to_mysql.js
```

## Option 2: Automatic Migration on Startup

Add migration flag to docker-compose.yml:

```yaml
services:
  bot:
    environment:
      - RUN_MODE=bot
      - RUN_MIGRATION=true  # Add this
    # ... rest of config
```

**Note:** Migration will only run once (creates `.migration_complete` marker). To re-run, delete the marker:
```bash
docker-compose exec bot rm /app/.migration_complete
docker-compose restart bot
```

## Option 3: Manual Execution

Run migration inside a running container:

```bash
# Start containers first
docker-compose up -d

# Run migration in bot container
docker-compose exec bot node scripts/migrate_to_mysql.js

# Or run in web container (same code)
docker-compose exec web node scripts/migrate_to_mysql.js
```

## Step-by-Step: First Time Setup

### 1. Create MySQL Database and Schema

On your MySQL server:

```bash
# Connect to MySQL
mysql -u root -p

# Create database
CREATE DATABASE IF NOT EXISTS ticketbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# Run schema
mysql -u root -p ticketbot < sql/schema.sql
```

Or from host machine:
```bash
mysql -h <mysql-host> -u root -p < sql/schema.sql
```

### 2. Configure config.json

Ensure `config/config.json` has MySQL settings:

```json
{
  "database": {
    "host": "your-mysql-host",
    "port": 3306,
    "user": "root",
    "password": "your-password",
    "database": "ticketbot"
  }
}
```

**Important:** If MySQL is in a Docker network, use the service name (e.g., `mysql` or `mariadb`). If external, use IP or hostname.

### 3. Ensure Old Data is Accessible (If Migrating)

If you have existing `data/json.sqlite`:
- Mount `./data:/app/data:rw` in docker-compose.yml (already done)
- Ensure the SQLite file exists at `./data/json.sqlite` on host

### 4. Run Migration

```bash
# Option A: Run as separate command (recommended for first-time)
docker-compose run --rm bot node scripts/migrate_to_mysql.js

# Option B: Add to docker-compose and let entrypoint handle it
# Add RUN_MIGRATION=true to environment, then:
docker-compose up -d
```

### 5. Verify Migration

```bash
# Check MySQL tables
docker-compose exec bot node -e "
const mysql = require('mysql2/promise');
const config = require('./config/config.json');
const dbConfig = config.database || {};
mysql.createConnection(dbConfig).then(async conn => {
  const [rows] = await conn.query('SELECT COUNT(*) as count FROM tickets');
  console.log('Tickets in MySQL:', rows[0].count);
  await conn.end();
});
"

# Or connect to MySQL directly
mysql -h <mysql-host> -u root -p ticketbot -e "SELECT COUNT(*) FROM tickets;"
```

## Docker Compose with MySQL Service

If you want to include MySQL in docker-compose:

```yaml
services:
  mysql:
    image: mysql:8.0
    container_name: ticket-mysql
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: your_password
      MYSQL_DATABASE: ticketbot
    volumes:
      - mysql-data:/var/lib/mysql
      - ./sql/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro
    networks:
      - ticket-bot-network
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

  bot:
    # ... existing bot config ...
    depends_on:
      mysql:
        condition: service_healthy
    environment:
      - RUN_MODE=bot
      - RUN_MIGRATION=true

volumes:
  mysql-data:
```

This will:
- Start MySQL container
- Auto-create schema on first start (via volume mount)
- Wait for MySQL to be healthy
- Run migration automatically
- Start bot

## Troubleshooting

### Migration Fails: "Cannot find module 'quick.db'"

The migration script needs `quick.db` temporarily. Add it back:

```bash
docker-compose exec bot npm install quick.db
docker-compose exec bot node scripts/migrate_to_mysql.js
```

Or rebuild with quick.db:
```yaml
# In Dockerfile, temporarily add quick.db to dependencies for migration
```

### Migration Says "Already Migrated"

The script creates a `.migration_complete` marker. To re-run:
```bash
docker-compose exec bot rm /app/.migration_complete
docker-compose exec bot node scripts/migrate_to_mysql.js
```

### MySQL Connection Refused

Check:
1. MySQL host/port in config.json matches your MySQL server
2. If MySQL is in Docker network, use service name not `localhost`
3. MySQL server is running and accessible
4. Firewall rules allow connection

### No Data After Migration

Verify:
1. Old SQLite file exists and is readable
2. Migration script ran without errors
3. Check MySQL tables directly:
   ```bash
   mysql -h <host> -u root -p ticketbot -e "SELECT * FROM kv_store LIMIT 5;"
   ```

## Post-Migration

After successful migration:

1. **Remove migration flag** (optional):
   ```yaml
   # Remove RUN_MIGRATION=true from docker-compose.yml
   ```

2. **Backup MySQL** (recommended):
   ```bash
   docker-compose exec mysql mysqldump -u root -p ticketbot > backup.sql
   # Or if external MySQL:
   mysqldump -h <host> -u root -p ticketbot > backup.sql
   ```

3. **Test the bot**:
   - Create a test ticket
   - Close the ticket
   - Verify it appears in staff search
   - Check MySQL tables directly

4. **Old SQLite backup** (optional):
   ```bash
   cp data/json.sqlite data/json.sqlite.backup
   # Can delete data/json.sqlite once you're confident migration worked
   ```

