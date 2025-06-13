FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get clean

WORKDIR /app

COPY e2e-agents /app/e2e-agents
COPY services /app/services
COPY tunnels /app/tunnels
COPY utils /app/utils

COPY tsconfig.json /app/tsconfig.json
COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
COPY index.ts /app/index.ts

RUN npm install

RUN npm run build

ENTRYPOINT ["node", "dist/index.js"]