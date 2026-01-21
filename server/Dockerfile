# Fault-Tolerant Control Server Dockerfile
FROM node:20-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace package files
COPY package.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/

# Install dependencies
RUN npm install

# Copy source code
COPY shared/ ./shared/
COPY server/ ./server/

# Build shared types first, then server
RUN npm run build -w @fault-tolerant/shared
RUN npm run build -w @fault-tolerant/server

# Create data directory
RUN mkdir -p /app/server/data

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/server/data/commands.db

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run server
WORKDIR /app/server
CMD ["node", "dist/index.js"]
