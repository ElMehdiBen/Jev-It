FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html jsconfig.json vite.config.js components.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server.js deployment-utils.js ./

USER node

EXPOSE 3001

ENTRYPOINT ["node", "server.js"]
