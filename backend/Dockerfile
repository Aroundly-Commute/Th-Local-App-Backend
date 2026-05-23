FROM node:20-bullseye-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-bullseye-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run prisma:generate
RUN npm run build

FROM node:20-bullseye-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Copy Prisma schema + migrations so migrate deploy works at runtime
COPY --from=build /app/src/prisma ./src/prisma

# Render injects PORT automatically. 
# prisma migrate deploy applies all pending migrations to Supabase, then starts the server.
CMD sh -c "npx prisma migrate deploy --schema src/prisma/schema.prisma && node dist/main.js"
