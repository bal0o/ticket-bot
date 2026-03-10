# Run the ticket bot locally

Use this to debug before deploying (e.g. to Docker Hub via GitHub Actions).

## Prerequisites

- **Node.js 18+** (LTS recommended)
- **MySQL** (running locally or in Docker)
- A **Discord bot token** and your **config** (channel IDs, role IDs, etc.)

## 1. Install dependencies

```bash
cd ticket-bot
npm install
```

## 2. Config

- Copy the example config and fill in your values (tokens, guild/channel/role IDs, database):

```bash
cp config/config.json.example config/config.json
```

- Edit `config/config.json`:
  - **`tokens.bot_token`** – your Discord bot token (required).
  - **`database`** – host, port, user, password, database name (MySQL is required).
  - **`channel_ids`** – `public_guild_id`, `staff_guild_id`, `post_embed_channel_id`, etc.
  - **`role_ids`** – `default_admin_role_id` and any others you use.
  - For **transcript links** to work locally, set e.g.  
    `transcript_settings.base_url` to `http://localhost:3050/transcripts/`  
    (and run the web server on port 3050 when testing transcripts).

- Optional: copy `config/.env.example` to `config/.env` if the web server uses it for session/OAuth.

## 3. Database

- Create the MySQL database (e.g. `ticketbot`) and run the schema:

```bash
mysql -u root -p your_database < sql/schema.sql
```

- Or open `sql/schema.sql` in your MySQL client and run it against your DB.

- Ensure `config.json` → `database` matches (host, port, user, password, database name).

## 4. Run the bot

**Bot only (no web UI):**

```bash
npm start
```

This runs `node --experimental-fetch index.js`. The bot will connect to Discord and register slash commands (uses REST API v10). If you see errors about `discord-api-types/v10`, see the note at the end.

**With web server (for transcript links and dashboard):**

In one terminal:

```bash
npm start
```

In a second terminal:

```bash
npm run web
```

- Web server runs on the port in `config.web.port` (e.g. **3050**).
- Set `transcript_settings.base_url` to that base URL (e.g. `http://localhost:3050/transcripts/`) so transcript links work when you click them.

Alternatively, to run **both** in one process (if your config supports it):

```bash
RUN_MODE=all npm start
```

(Only starts the web server when `config.web.enabled` is true.)

## 5. Quick checks

- Bot logs in and prints no MySQL connection errors.
- In Discord, slash commands appear (may take a minute).
- Open a ticket, send a few messages, close it; check logs and (if web is running) the transcript URL.

## 6. Slash commands / REST v10

The app registers slash commands using **REST API v10** and `discord-api-types/v10`. If you get:

```
Cannot find module 'discord-api-types/v10'
```

then install a version that supports v10, for example:

```bash
npm install discord-api-types@^0.37.0
```

If you prefer to keep the previous behaviour, you can temporarily switch `utils/handler_manager.js` back to `discord-api-types/v9` and REST `version: "9"` until your dependencies are updated.

## 7. Docker (optional, for MySQL only)

To run only MySQL locally in Docker:

```bash
docker run -d --name ticketbot-mysql -e MYSQL_ROOT_PASSWORD=yourpassword -e MYSQL_DATABASE=ticketbot -p 3306:3306 mysql:8
```

Then in `config.json` set `database.host` to `localhost`, `database.port` to `3306`, and run `sql/schema.sql` against it.

---

After debugging, your existing GitHub Actions workflow can continue to build and push the image to Docker Hub as before; the image uses `docker-entrypoint.sh` and expects `config/config.json` (and optionally env) to be provided at runtime (e.g. via bind mounts or secrets).
