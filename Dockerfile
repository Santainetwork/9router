# syntax=docker/dockerfile:1.7
ARG GO_IMAGE=golang:1.24-alpine
ARG NODE_IMAGE=node:22-alpine

# --- Stage 1: Build Golang Hybrid Concurrency Engine ---
FROM ${GO_IMAGE} AS engine-builder
WORKDIR /src/hybrid-engine
COPY hybrid-engine/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/router-engine ./cmd/engine

# --- Stage 2: Build Next.js Web Dashboard ---
FROM ${NODE_IMAGE} AS node-builder
WORKDIR /app

RUN apk --no-cache add python3 make g++ linux-headers

COPY package.json package-lock.json* ./
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm install --registry=${NPM_REGISTRY}

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- Stage 3: Production Runner ---
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"
LABEL org.opencontainers.image.description="9Router with Golang Hybrid Concurrency Engine"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
ENV APP_NAME=SantaiNetwork
ENV BACKEND_PORT=20127
ENV GATEWAY_PORT=20128
ENV LIMITER_PORT=20129
ENV PUBLIC_PORT=20140
ENV ENABLE_GO_HYBRID=true
ENV GO_ENGINE_URL=http://127.0.0.1:20129
ENV NODE_OPTIONS=--max-old-space-size=512

# Copy compiled Golang engine
COPY --from=engine-builder /bin/router-engine /app/router-engine

# Copy Next.js standalone artifacts
COPY --from=node-builder /app/public ./public
COPY --from=node-builder /app/.next/static ./.next/static
COPY --from=node-builder /app/.next/standalone ./
COPY --from=node-builder /app/custom-server.js ./custom-server.js
COPY --from=node-builder /app/open-sse ./open-sse
COPY --from=node-builder /app/deploy ./deploy
COPY --from=node-builder /app/src/mitm ./src/mitm

# Standalone dependency fallbacks
COPY --from=node-builder /app/node_modules/node-forge ./node_modules/node-forge
COPY --from=node-builder /app/node_modules/next ./node_modules/next
COPY --from=node-builder /app/node_modules/sql.js ./node_modules/sql.js
COPY --from=node-builder /app/node_modules/node-machine-id ./node_modules/node-machine-id

# Runtime requirements and directory setup
RUN apk --no-cache add su-exec ca-certificates tzdata && \
    mkdir -p /app/data /app/data-home && \
    chown -R node:node /app && \
    ln -sf /app/data-home /root/.9router 2>/dev/null || true

COPY deploy/docker-entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh /app/router-engine

# 20128: Master Gateway (API, Dashboard)
# 20140: Public Proxy (Usage-Check, Docs)
# 20129: Limiter RPC (Health, Semaphores)
EXPOSE 20128 20140 20129

VOLUME ["/app/data"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["run"]
