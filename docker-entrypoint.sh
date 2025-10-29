#!/bin/sh
set -e

echo "[entrypoint] Starting ticket-bot entrypoint..."

# Switch to node user for running the app
if [ "$(id -u)" = "0" ]; then
    # Change ownership of app directory if we're root
    chown -R node:node /app || true
    # Switch to node user for the rest of the script
    exec su-exec node "$0" "$@"
fi

# Now running as node user

# Check if migration should run
if [ "$RUN_MIGRATION" = "true" ] || [ "$RUN_MIGRATION" = "1" ]; then
    echo "[entrypoint] Running MySQL migration..."
    
    # Check if migration has already been run
    if [ -f /app/.migration_complete ]; then
        echo "[entrypoint] Migration already completed (found .migration_complete marker)"
        echo "[entrypoint] To re-run migration, delete .migration_complete file and set RUN_MIGRATION=true"
    else
        echo "[entrypoint] Running migration script..."
        cd /app
        node scripts/migrate_to_mysql.js
        
        if [ $? -eq 0 ]; then
            echo "[entrypoint] Migration completed successfully"
            touch /app/.migration_complete
        else
            echo "[entrypoint] ERROR: Migration failed - check logs above"
            exit 1
        fi
    fi
fi

# Wait for MySQL to be ready (if configured)
if grep -q '"database"' /app/config/config.json 2>/dev/null; then
    echo "[entrypoint] Waiting for MySQL connection..."
    MAX_ATTEMPTS=30
    ATTEMPT=0
    
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        if node -e "
            try {
                const mysql = require('mysql2/promise');
                const config = require('./config/config.json');
                const dbConfig = config.database || {};
                if (!dbConfig.host) process.exit(1);
                mysql.createConnection({
                    host: dbConfig.host,
                    port: dbConfig.port || 3306,
                    user: dbConfig.user || 'root',
                    password: dbConfig.password || '',
                    database: dbConfig.database || 'ticketbot'
                }).then(async conn => {
                    await conn.query('SELECT 1');
                    await conn.end();
                    process.exit(0);
                }).catch(err => {
                    process.exit(1);
                });
            } catch (e) {
                process.exit(1);
            }
        " 2>/dev/null; then
            echo "[entrypoint] MySQL is ready"
            break
        fi
        
        ATTEMPT=$((ATTEMPT + 1))
        echo "[entrypoint] Waiting for MySQL... (attempt $ATTEMPT/$MAX_ATTEMPTS)"
        sleep 2
    done
    
    if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
        echo "[entrypoint] WARNING: MySQL connection test failed after $MAX_ATTEMPTS attempts"
        echo "[entrypoint] Continuing anyway - the bot will fail if MySQL is not accessible"
    fi
fi

# Start the application
echo "[entrypoint] Starting application..."
cd /app
if [ "$RUN_MODE" = "web" ]; then
    exec node web/server.js
else
    exec node index.js
fi

