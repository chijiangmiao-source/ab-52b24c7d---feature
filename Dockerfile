FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test
COPY verify ./verify

# 构建可运行产物：全部源码语法校验，确保镜像内产物可直接运行
RUN node --check src/cluster.js \
 && node --check src/server.js \
 && node --check public/app.js \
 && node --check test/cluster.test.js \
 && node --check verify/smoke.js

EXPOSE 8080
VOLUME ["/data"]

ENV PORT=8080 \
    DATA_DIR=/data \
    LEASE_MS=120000

CMD ["node", "src/server.js"]
