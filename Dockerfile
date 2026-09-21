FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PQ_HOST=0.0.0.0 PQ_DATABASE=/data/queue.sqlite PORT=8787
RUN mkdir /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY scripts/backup.mjs ./scripts/backup.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/packages/server/cli.js"]
