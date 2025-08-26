#!/bin/bash

# Docker Setup Script for Ticket Bot
# This script helps set up the Docker environment

set -e

echo "🐳 Setting up Docker environment for Ticket Bot..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

echo "✅ Docker and Docker Compose are installed"

# Create necessary directories
echo "📁 Creating necessary directories..."
mkdir -p config content transcripts data logs

# Set proper permissions for data directories
echo "🔐 Setting proper permissions..."
chmod 755 config content transcripts data logs

# Check if .env file exists
if [ ! -f .env ]; then
    if [ -f env.example ]; then
        echo "📝 Creating .env file from env.example..."
        cp env.example .env
        echo "⚠️  Please edit .env file with your actual values before starting the bot!"
    else
        echo "❌ env.example not found. Please create a .env file manually."
        exit 1
    fi
else
    echo "✅ .env file already exists"
fi

# Check if config.json exists
if [ ! -f config/config.json ]; then
    if [ -f config/config.json.example ]; then
        echo "📝 Creating config.json from config.json.example..."
        cp config/config.json.example config/config.json
        echo "⚠️  Please edit config/config.json with your actual configuration!"
    else
        echo "❌ config.json.example not found. Please create config/config.json manually."
        exit 1
    fi
else
    echo "✅ config.json already exists"
fi

# Check if content directory has files
if [ ! "$(ls -A content 2>/dev/null)" ]; then
    echo "⚠️  Content directory is empty. Please copy your content files to the content/ directory."
else
    echo "✅ Content directory has files"
fi

echo ""
echo "🎉 Docker environment setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env file with your Discord bot credentials"
echo "2. Edit config/config.json with your server configuration"
echo "3. Copy your content files to the content/ directory"
echo "4. Run: docker-compose up -d"
echo ""
echo "For more information, see DOCKER.md"
