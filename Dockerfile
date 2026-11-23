# Small image: Node 22 (SQLite built in) + pdftotext for PDF bills. No npm packages.
FROM node:22-alpine
RUN apk add --no-cache poppler-utils su-exec tzdata \
 && mkdir -p /data /backups && chown node:node /data /backups
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NODE_ENV=production PORT=8080 DB_FILE=/data/financas.db BACKUP_DIR=/backups TZ=America/Sao_Paulo
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
