# The Mandate worker: the long-running process that lets each merchant's Buying and
# Selling agents act on a timer. The web app is deployed separately (Vercel); this
# only needs outbound network access. WhatsApp's session lives encrypted in the
# database, so the container is stateless and needs no volume.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# tsx runs the TypeScript directly; install everything the lockfile needs.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund

COPY tsconfig.json next-env.d.ts ./
COPY src ./src
COPY worker ./worker

# Configuration comes from the host's secrets, never from files in the image.
USER node
CMD ["npx", "tsx", "--tsconfig", "worker/tsconfig.json", "worker/src/index.ts"]
