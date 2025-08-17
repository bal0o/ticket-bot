# syntax=docker/dockerfile:1
FROM node:18-bullseye-slim

ENV NODE_ENV=production

# build tools for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app
COPY . .

# Default port (mapped from host). Do not change config.web.port automatically
EXPOSE 3050

CMD ["node", "index.js"]


