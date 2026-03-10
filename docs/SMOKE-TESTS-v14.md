# Smoke tests after v14 + transcript migration

Run these after deploying the Discord.js v14 and DB-backed transcript changes.

## 1. Ticket flow
- Open a new ticket from the embed (button).
- Send a few messages in DM; confirm they appear in the ticket channel (and in staff thread if applicable).
- Close the ticket (Close Ticket button → modal with reason).
- Confirm the channel is removed and the transcript URL is posted (e.g. in logs).

## 2. Transcripts (web)
- Log in to the web app (staff or ticket owner).
- Open a transcript link (e.g. from logs or from the ticket history).
- Confirm the transcript page loads and shows messages (DB-backed).
- For an old ticket with only a legacy HTML file, confirm the transcript still loads (fallback).

## 3. Application communication channel
- Open an application and start a communication channel (if your setup has this).
- Send a few messages, then close the channel (e.g. “Close communication” button).
- Confirm the transcript link is posted (no HTML file written; served from DB).
- Open the transcript URL and confirm messages appear.

## 4. Slash commands
- `/tickethistory <discordId>` – returns paginated embeds and transcript links.
- `/stats` (staff/org) – runs without errors.
- `/reply`, `/move`, `/checkcc`, `/blacklist`, `/wipestats` – run as appropriate for your roles/channels.

## 5. Bot startup
- Start the bot and confirm slash commands register (no “discord-api-types/v10” or REST version errors).
- If you see module/version errors, check `utils/handler_manager.js` (REST version 10 and `discord-api-types/v10`) and install a compatible `discord-api-types` if needed.
