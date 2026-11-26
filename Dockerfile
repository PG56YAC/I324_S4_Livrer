
# Etape 1 : construire les dependances
FROM node:24-slim AS builder

WORKDIR /app

# Outils necessaires pour compiler sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Compiler sqlite3 pour l'environnement du conteneur
RUN npm_config_build_from_source=true npm ci --omit=dev

# Etape 2 : image finale de production
FROM node:24-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/index.js"]
