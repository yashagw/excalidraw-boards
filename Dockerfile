# Excalidraw Boards: the web app plus a Node server (board API, live updates, MCP). Builds on amd64 and arm64.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npx vitest run

# Runtime needs only the packages the server bundle leaves external.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3779 \
    DATA_DIR=/data
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3779
CMD ["node", "dist/server/index.js"]
