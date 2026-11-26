FROM node:24-alpine
LABEL authors="Jason Edmonds"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 3000
CMD ["node", "src/index.js"]