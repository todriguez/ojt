# syntax=docker/dockerfile:1.7
#
# OJT production image. Single-stage for simplicity; the Next.js build
# output ships as a standalone Node server under .next/.
#
# Build: docker build -t ojt .
# Run:   docker run --rm -p 3000:3000 --env-file .env.local ojt

FROM node:20-alpine AS deps

WORKDIR /app

RUN corepack enable \
 && corepack prepare pnpm@10.9.0 --activate

COPY package.json pnpm-lock.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile --prod=false

FROM node:20-alpine AS build

WORKDIR /app

RUN corepack enable \
 && corepack prepare pnpm@10.9.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

RUN corepack enable \
 && corepack prepare pnpm@10.9.0 --activate \
 && addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next ./.next
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=build --chown=nextjs:nodejs /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=build --chown=nextjs:nodejs /app/config ./config
COPY --from=build --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs

EXPOSE 3000

CMD ["pnpm", "start"]
