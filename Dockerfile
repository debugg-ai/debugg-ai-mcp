FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get clean

WORKDIR /app

COPY src /app/src
COPY tsconfig.json /app/tsconfig.json
COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json

RUN npm install

RUN npm run build

ENTRYPOINT ["node", "dist/index.js"]