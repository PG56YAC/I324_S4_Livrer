FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src .github/workflows/ci.yml
EXPOSE 3000
CMD ["node", "src/index.js"]