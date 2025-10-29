# MySQL Migration Checklist

## Before Migration

- [ ] Backup `data/json.sqlite` file
- [ ] Ensure MySQL server is running
- [ ] Install dependencies: `npm install` (adds mysql2)
- [ ] Add database config to `config/config.json` (see config.json.example)

## Migration Steps

1. **Create Schema**
   ```bash
   mysql -u root -p < sql/schema.sql
   ```
   
2. **Run Migration**
   ```bash
   node scripts/migrate_to_mysql.js
   ```
   
3. **Verify Migration**
   - Check ticket count: `SELECT COUNT(*) FROM tickets;`
   - Check applications: `SELECT COUNT(*) FROM applications;`
   - Test a search in staff view

## After Migration

- [ ] Test ticket creation/closure
- [ ] Test staff search (should be fast and return complete results)
- [ ] Test applications view
- [ ] Monitor error logs for any issues

## Rollback Plan

If issues occur:
1. Remove/comment out `database` section in `config/config.json`
2. System will automatically fall back to quick.db
3. Restore `data/json.sqlite` from backup if needed

## Key Changes

- **Staff search**: Now uses SQL queries on `tickets` table (complete results, fast)
- **Ticket writes**: New closed tickets written to MySQL `tickets` table
- **Backwards compatible**: Old PlayerStats structure still works via kv_store
- **No data loss**: All existing data preserved

