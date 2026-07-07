# Multi-stage build for the showcase MCP server.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# Install prod deps only. To use the Postgres store, add: RUN npm install pg
RUN npm ci --omit=dev --omit=optional
COPY --from=build /app/dist ./dist
# Run as non-root.
USER node
EXPOSE 8970
# Provide real values in production: OAUTH_ISSUER, OAUTH_JWKS_URI, OAUTH_AUDIENCE, RESOURCE_URL,
# and (for the Postgres store) STORE=pg + DATABASE_URL. Always terminate TLS in front of this.
CMD ["node", "dist/index.js"]
