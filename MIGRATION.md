# MySQL Migration Guide

This guide explains how to migrate from quick.db to MySQL.

## Prerequisites

1. MySQL server installed and running
2. Node.js dependencies installed: `npm install`

## Step 1: Configure MySQL

Add database configuration to `config/config.json`:

```json
{
  "database": {
    "type": "mysql",
    "host": "localhost",
    "port": 3306,
    "user": "root",
    "password": "your_password",
    "database": "ticketbot"
  }
}
```

## Step 2: Create Database Schema

Run the schema SQL file to create all tables:

```bash
mysql -u root -p < sql/schema.sql
```

Or manually:
```sql
source sql/schema.sql
```

This creates:
- `kv_store` - Backwards compatible key-value store
- `tickets` - Main tickets table with proper indexes
- `applications` - Application records
- `application_*` - Related application tables
- `staff_stats` - Staff statistics
- `server_stats` - Server statistics
- `user_ticket_index` - User ticket channels
- `transcript_index` - Transcript filename lookups

## Step 3: Migrate Data

Run the migration script to copy all data from quick.db to MySQL:

```bash
node scripts/migrate_to_mysql.js
```

This will:
- Migrate all key-value entries to `kv_store` (for backwards compatibility)
- Migrate all **closed** tickets from `PlayerStats` to `tickets` table
- Migrate all applications and related data
- Create indexes for fast searching

**Note:** Only closed tickets are migrated to the `tickets` table (since that's what we search). Open tickets remain in `PlayerStats` structure for now.

**Important:** Backup your quick.db file before migration:
```bash
cp data/json.sqlite data/json.sqlite.backup
```

## Step 4: Verify Code Updated

All files have been updated to use `require('../utils/mysql')` or `require('./mysql')`. The `createDB()` function in `utils/mysql.js`:

1. Checks if MySQL is configured in `config.json`
2. Returns MySQL adapter if configured
3. Falls back to quick.db if not configured

This provides backwards compatibility - if MySQL config is missing, it automatically uses quick.db.

**Important:** After migration, new tickets will automatically write to MySQL `tickets` table when closed. Old tickets remain accessible through the migration.

## Step 5: Test

1. Start the bot: `npm start`
2. Test ticket creation/closing
3. Test staff search view
4. Verify applications still work

## Rollback

If you need to rollback:
1. Remove or comment out database config in `config/config.json`
2. The system will automatically fall back to quick.db
3. Your original `data/json.sqlite` will still be intact (if you backed it up)

## Benefits

- **True SQL queries** - No loading entire datasets
- **Proper indexes** - Fast searches on any field
- **Scalable** - Handles millions of tickets efficiently
- **Complete results** - No arbitrary scan limits
- **Better performance** - Only queries what you need

