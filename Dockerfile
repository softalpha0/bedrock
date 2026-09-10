# Bedrock — single-stage image. Build is fast and the dev deps (Vite) are only
# needed at `npm run build`, so a multi-stage split isn't worth the complexity.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# The server reads PORT from the environment (defaults to 8787).
EXPOSE 8787
CMD ["npm", "start"]
