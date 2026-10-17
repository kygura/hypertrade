FROM oven/bun:1.4.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
RUN bun run build
ENV NODE_ENV=production
USER bun
EXPOSE 8787
CMD ["bun", "scripts/server.ts"]
