#!/bin/sh
set -e

echo "[entrypoint] Starting ticket-bot entrypoint..."

if [ "$(id -u)" = "0" ]; then
    chown -R node:node /app || true
    exec su-exec node "$0" "$@"
fi

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

echo "[entrypoint] Starting application..."
cd /app
if [ "$RUN_MODE" = "web" ]; then
    exec node web/server.js
else
    exec node index.js
fi
