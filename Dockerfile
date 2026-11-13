# Small image: Node 22 (SQLite built in) + pdftotext for PDF bills. No npm packages.
FROM node:22-alpine
RUN apk add --no-cache poppler-utils \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=8080 DB_FILE=/data/financas.db
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
