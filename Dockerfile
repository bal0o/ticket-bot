# Use Node.js 18 LTS as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite \
    curl

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p /app/config /app/content /app/transcripts /app/data

# Set proper permissions
RUN chown -R node:node /app
USER node

# Expose port for web interface (web image only)
EXPOSE 3050

# Start mode decided via RUN_MODE env ('bot' | 'web' | 'all')
CMD ["sh", "-lc", "if [ \"$RUN_MODE\" = web ]; then node web/server.js; else node index.js; fi"]
