# syntax=docker/dockerfile:1

# Build stage runs on bookworm: the compiled output (JS + better-sqlite3's native
# binding) is forward-compatible with the newer glibc of the runtime base.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Toolchain only in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build

# Runtime base matches the host distro (glibc 2.43 on Ubuntu 26.04) so the host
# binaries this app executes through bind mounts — the vLLM venv, llama.cpp,
# guidellm, nvidia-smi — actually run. A bookworm runtime (glibc 2.36) refuses
# them with "GLIBC_2.xx not found".
FROM ubuntu:26.04 AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3333 \
    VLLM_ADMIN_DATA_DIR=/data \
    HOME=/home/dewardvide \
    PATH=/home/dewardvide/.local/bin:/home/dewardvide/granite-inference/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# ca-certificates for HF/network calls; libstdc++ for the copied node binary and
# for llama.cpp / vLLM wheels.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/dewardvide /data \
 && chown 1000:1000 /home/dewardvide /data
# Same Node build as the builder, without dragging Debian's userland along.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
# `output: "standalone"` bundles the server and its traced node_modules,
# including the native better-sqlite3 build.
COPY --from=build --chown=1000:1000 /app/.next/standalone ./
COPY --from=build --chown=1000:1000 /app/.next/static ./.next/static
COPY --from=build --chown=1000:1000 /app/public ./public
# uid 1000 is the host user (`dewardvide`), so the bind-mounted home is writable
# for model downloads and readable for the venv it launches.
USER 1000:1000
VOLUME /data
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
