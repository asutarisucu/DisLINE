# TypeScriptはNodeが直接実行するのでビルド段は無い。依存の取得だけ分けてキャッシュを効かせる。
FROM node:24-alpine AS deps
WORKDIR /app
# .npmrc が無いと @evex/linejs (JSR配布) を解決できない。
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app

# ログの時刻を日本時間にする。tzdata が無いとTZ指定は黙って無視される。
RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json .npmrc ./
COPY src ./src

# 認証トークンとSQLiteの置き場。compose側でボリュームを当てる。
# 先に作ってオーナーを移しておかないと、非rootで書けない。
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV DATA_DIR=/app/data

# 状態ファイルの更新が止まる＝ポーリングが死んでいる。中身ではなく更新時刻を見る。
HEALTHCHECK --interval=2m --timeout=10s --start-period=90s --retries=3 \
  CMD [ -f /app/data/health.json ] && [ $(( $(date +%s) - $(stat -c %Y /app/data/health.json) )) -lt 900 ]

# --env-file は付けない。環境変数は compose から渡す。
CMD ["node", "src/index.ts"]
