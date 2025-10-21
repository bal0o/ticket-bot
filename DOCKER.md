# Docker Support for Ticket Bot

This document explains how to run the Discord Ticket Bot using Docker.

## Prerequisites

- Docker
- Docker Compose
- Discord Bot Token and OAuth credentials

## Quick Start

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd ticket-bot
   ```

2. **Set up configuration:**
   ```bash
   # Copy the example config
   cp config/config.json.example config/config.json
   
   # Edit config.json with your actual values
   nano config/config.json
   ```

3. **Create necessary directories:**
   ```bash
   mkdir -p config content transcripts data logs
   ```

4. **Copy your configuration files:**
   ```bash
   # Copy your config.json to the config directory
   cp your-config.json config/config.json
   
   # Copy your content files
   cp -r your-content/* content/
   ```

5. **Build and run:**
   ```bash
   docker-compose up -d
   ```

## Directory Structure

The Docker setup exposes the following directories to the host:

```
ticket-bot/
├── config/           # Configuration files (config.json)
├── content/          # Questions and handler files
├── transcripts/      # Saved ticket transcripts
├── data/            # Database files (json.sqlite)
├── logs/            # Application logs
├── Dockerfile       # Docker image definition
└── docker-compose.yml # Docker services configuration
```

## Volume Mounts

- **`./config:/app/config:rw`** - Configuration files
- **`./content:/app/content:rw`** - Content and handler files
- **`./transcripts:/app/transcripts:rw`** - Transcript storage
- **`./data:/app/data:rw`** - Database files
- **`./logs:/app/logs:rw`** - Application logs

## Configuration

**Note: This bot now uses config.json for all configuration. Environment variables are no longer required.**

### Required Configuration in config.json
- `config.tokens.bot_token` - Your Discord bot token
- `config.web.discord_oauth.client_id` - Discord OAuth client ID  
- `config.web.discord_oauth.client_secret` - Discord OAuth client secret
- `config.web.session_secret` - Web session secret

### Optional Configuration
- `config.web.enabled` - Enable/disable web interface (default: true)
- `config.web.host` - Web server host (default: 0.0.0.0)
- `config.web.port` - Web server port (default: 3050)

## Docker Commands

### Build the image
```bash
docker-compose build
```

### Start services
```bash
docker-compose up -d
```

### View logs
```bash
docker-compose logs -f ticket-bot
```

### Stop services
```bash
docker-compose down
```

### Restart services
```bash
docker-compose restart
```

### Update and rebuild
```bash
git pull
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## One-time index backfill (performance)

After upgrading, run the backfill to build fast indexes for staff pages and transcript lookups. This only needs to be done once per database (indexes are stored in `data/json.sqlite`).

```bash
# If running locally
npm run backfill:index

# If running in Docker
docker-compose run --rm ticket-bot npm run backfill:index
```

You can safely re-run the backfill; it is idempotent and will merge any missing entries.

## Health Checks

The container includes health checks that monitor the web interface:
- Checks `/health` endpoint every 30 seconds
- Container marked unhealthy if health check fails 3 times
- Health check starts after 40 seconds to allow startup time

## Troubleshooting

### Container won't start
1. Check logs: `docker-compose logs ticket-bot`
2. Verify environment variables are set correctly
3. Ensure required directories exist and have proper permissions

### Database issues
1. Verify the `data/` directory is mounted correctly
2. Check file permissions on the host
3. Ensure SQLite is accessible

### Web interface not accessible
1. Check if port 3050 is exposed and not blocked by firewall
2. Verify the container is running: `docker-compose ps`
3. Check container logs for web server errors

### Permission issues
1. Ensure the host directories have proper read/write permissions
2. The container runs as the `node` user (UID 1000)
3. You may need to adjust ownership: `chown -R 1000:1000 data/ transcripts/`

## Production Considerations

1. **Use Docker secrets** for sensitive environment variables
2. **Set up proper logging** with log rotation
3. **Configure backups** for the data and transcripts directories
4. **Use Docker networks** for security isolation
5. **Set resource limits** to prevent container resource exhaustion

## Example docker-compose.override.yml

For development, you can create a `docker-compose.override.yml`:

```yaml
version: '3.8'
services:
  ticket-bot:
    environment:
      - NODE_ENV=development
    volumes:
      - ./src:/app/src:ro  # Mount source code for development
    command: ["npm", "run", "dev"]
```

## Security Notes

- Never commit `.env` files to version control
- Use Docker secrets in production environments
- Regularly update the base Node.js image
- Monitor container logs for suspicious activity
- Restrict network access using Docker networks
