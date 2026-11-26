FROM node:24-trixie-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild sqlite3

COPY src/ ./src/

EXPOSE 3000
CMD ["node", "src/index.js"]
