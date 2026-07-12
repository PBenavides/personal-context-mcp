# syntax=docker/dockerfile:1
# Multi-stage build for personal-context-mcp.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY package.json ./
# The corpus is NOT baked in: production reads it from S3 (CORPUS_SOURCE=s3 +
# CONTEXT_BUCKET/CONTEXT_PREFIX, task-role or AWS_* credentials); local smoke
# runs mount a fixture directory and set CORPUS_SOURCE=file CORPUS_ROOT=/corpus.
# Drop root: the node:*-alpine images ship a non-root `node` user (uid 1000). The service is
# stateless and writes nothing to disk, so read-only access to /app is sufficient.
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
