# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install production dependencies only
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Final image
FROM base AS release
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

USER bun
CMD ["bun", "run", "src/main.ts"]
