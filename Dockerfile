# AutoLemon API container image (owning module: operations). Multi-stage, non-root, no dev
# dependencies, read-only friendly. Built and scanned in CI; deployment is NOT configured.
# Pin the base image by digest in CI after resolution (docs/DEPENDENCIES.md).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@12.18.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
# --ignore-scripts: sources are not copied yet, so the root postinstall (contracts build)
# must not run here; packages are built explicitly below.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @autolemon/contracts build && pnpm --filter @autolemon/api build \
 && cp -r apps/api/src/db/migrations apps/api/dist/db/migrations \
 && pnpm deploy --filter @autolemon/api --prod /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production
# The runtime only needs `node`. Remove the npm/corepack CLIs bundled in the base image: they
# are never used at runtime and carry their own dependency CVEs (pacote, sigstore, brace-expansion…).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
