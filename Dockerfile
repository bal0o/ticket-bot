# Use Node.js 20 LTS as base image
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl su-exec

COPY package*.json ./

RUN npm ci --only=production

COPY . .

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

RUN mkdir -p /app/config /app/content /app/transcripts /app/data /app/logs

RUN chown root:root /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh
RUN chown -R node:node /app

EXPOSE 3050

ENTRYPOINT ["/docker-entrypoint.sh"]
