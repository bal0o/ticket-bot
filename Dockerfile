# Use Node.js 18 LTS as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies (including MySQL client libraries for mysql2)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite \
    curl \
    mariadb-connector-c-dev \
    su-exec

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Copy and set up entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create necessary directories
RUN mkdir -p /app/config /app/content /app/transcripts /app/data

# Set proper permissions (entrypoint needs to be root for chown, then switch to node)
RUN chown root:root /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh
RUN chown -R node:node /app

# Expose port for web interface (web image only)
EXPOSE 3050

# Use entrypoint script for startup logic
ENTRYPOINT ["/docker-entrypoint.sh"]
