# syntax=docker/dockerfile:1
# Multi-stage build for the central MCP server.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY resource-files ./resource-files
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/resource-files ./resource-files
COPY package.json ./
# Drop root: the node:*-alpine images ship a non-root `node` user (uid 1000). The service is
# stateless and writes nothing to disk, so read-only access to /app is sufficient.
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
