# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
# npm 11.10+ honours min-release-age; .npmrc also turns off install scripts.
RUN npm install -g npm@11.21.3 --ignore-scripts
COPY package.json package-lock.json* .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Install only production dependencies.
RUN npm install -g npm@11.21.3 --ignore-scripts
COPY package.json package-lock.json* .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY slack ./slack
COPY mesh.config.example.yaml ./
COPY examples ./examples

# The state directory holds the SQLite dedupe/trace store.
RUN mkdir -p /app/.mesh && chown -R node:node /app
USER node

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--config", "mesh.config.yaml"]
