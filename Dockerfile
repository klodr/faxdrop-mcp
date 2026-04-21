# syntax=docker/dockerfile:1.7
#
# Multi-stage image for the stdio MCP server. The build stage
# compiles TypeScript with tsup; the runtime stage keeps only the
# bundled dist/, pruned node_modules, and package.json.
#
# Version is a build-arg so the release workflow can pass the
# package.json version without the Dockerfile hard-coding anything.

FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev


FROM node:20-alpine AS runtime

ARG VERSION=0.0.0

LABEL org.opencontainers.image.source="https://github.com/klodr/faxdrop-mcp"
LABEL org.opencontainers.image.url="https://github.com/klodr/faxdrop-mcp"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="faxdrop-mcp"
LABEL org.opencontainers.image.description="Send real faxes from any MCP-enabled AI assistant via the FaxDrop API."

# Drop root — the stdio MCP process does not need any capabilities.
RUN addgroup -S mcp && adduser -S -G mcp mcp
USER mcp

WORKDIR /app
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --from=build --chown=mcp:mcp /app/package.json ./package.json

# Sensible defaults for the fax outbox inside the container.
ENV FAXDROP_MCP_WORK_DIR=/app/outbox
RUN mkdir -p /app/outbox

# stdio MCP: no listening sockets, no EXPOSE.
ENTRYPOINT ["node", "dist/index.js"]
