# Fault-Tolerant Agent Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy workspace package files
COPY package.json ./
COPY shared/package.json ./shared/
COPY agent/package.json ./agent/

# Install dependencies
RUN npm install

# Copy source code
COPY shared/ ./shared/
COPY agent/ ./agent/

# Build shared types first, then agent
RUN npm run build -w @fault-tolerant/shared
RUN npm run build -w @fault-tolerant/agent

# Create data directory for agent ID persistence
RUN mkdir -p /app/agent/data

# Environment
ENV NODE_ENV=production
ENV SERVER_URL=http://server:3000
ENV POLL_INTERVAL=1000
ENV AGENT_DATA_PATH=/app/agent/data

# Run agent
WORKDIR /app/agent
CMD ["node", "dist/index.js"]
