FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
RUN mkdir -p /data/uploads && chown -R nextjs:nodejs /data/uploads
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]

# Migrations, seeding, account creation, import and recompute need the Prisma
# CLI, tsx and the TypeScript sources. None of those belong in the runtime
# image — a web server that can rewrite its own schema is a bigger target than
# it needs to be — so they live here, built from the same builder stage and run
# on demand. Compose keeps this behind the `ops` profile, so a plain `up` never
# starts it.
FROM builder AS ops
WORKDIR /app
CMD ["node", "--version"]
