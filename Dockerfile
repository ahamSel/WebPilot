FROM node:22-slim

# Playwright system dependencies for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    fonts-liberation fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Install Chromium via @playwright/mcp's own playwright-core (version must match)
RUN npx --prefix node_modules/@playwright/mcp playwright install chromium

# Copy source
COPY . .

# Build Next.js
RUN npm run build

# Data directories (mount as volumes for persistence)
RUN mkdir -p agent_runs agent_threads

# Headless by default in Docker
ENV BROWSER_HEADLESS=true
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
