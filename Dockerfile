FROM oven/bun:1.4.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
RUN bun run build
ENV NODE_ENV=production
USER bun
EXPOSE 8787
# The probe is a one-line bun fetch, so the image needs no curl or wget. /api/health is public and answers even when
# a loop is down (the loop errors are in its body), so unhealthy means the process itself stopped answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8787}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "scripts/server.ts"]
