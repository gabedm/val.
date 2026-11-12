FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY docs/build-pack ./docs/build-pack
COPY fixtures ./fixtures
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY docs/build-pack ./docs/build-pack
COPY fixtures ./fixtures
COPY migrations ./migrations
COPY scripts/start-container.ts ./scripts/start-container.ts
COPY LICENSE ./LICENSE
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "scripts/start-container.ts"]
