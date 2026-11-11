FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 may need to compile for the container architecture when a
# matching prebuild is unavailable (including linux/arm64 on Apple Silicon).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run verify
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Reuse the architecture-correct native dependencies compiled in the build
# stage. Running npm ci again in this toolchain-free image would be unreliable.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown -R node:node /app /data
USER node
ENV ORDERSEAL_DB_PATH=/data/orderseal.db
EXPOSE 3000
CMD ["node", "dist/server/server/index.js"]
