#!/usr/bin/env bash
# Atualização automática do app de Finanças (roda no Linux/WSL onde está o projeto).
# A tarefa agendada que o instalar-atualizacao.sh cria chama este script a cada 10 minutos. Ele:
#  1. copia os backups para a pasta da nuvem (PASTA_BACKUP_NUVEM no .env), se houver;
#  2. sobe o app se ele estiver parado (por exemplo, depois de reiniciar o PC);
#  3. se houver versão nova no GitHub e ela passou nos testes, faz um backup,
#     atualiza e confere se o app voltou. Se não voltar, retorna para a versão anterior.
# Tudo fica registrado em logs/atualizar.log.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p logs
LOG="$ROOT/logs/atualizar.log"
BAD="$ROOT/logs/versoes-com-problema.txt"
[ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ] && mv -f "$LOG" "$LOG.old"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG"; }
run() { "$@" >> "$LOG" 2>&1; }

# Só uma execução por vez
exec 9>"$ROOT/logs/.atualizar.lock"
flock -n 9 || exit 0

env_get() { grep -E "^\s*$1\s*=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^[[:space:]"'"'"']*//' -e 's/[[:space:]"'"'"']*$//'; }
PORT="$(env_get PORTA)"; PORT="${PORT:-8080}"
healthy() { curl -fsS -m 5 "http://localhost:$PORT/api/health" > /dev/null 2>&1; }
wait_healthy() { for _ in $(seq 1 40); do healthy && return 0; sleep 3; done; return 1; }

# 1. Cópia dos backups para a nuvem
CLOUD="$(env_get PASTA_BACKUP_NUVEM)"
if [ -n "$CLOUD" ] && [ -d backups ]; then
  mkdir -p "$CLOUD" 2>/dev/null && cp -u backups/financas-* "$CLOUD"/ 2>/dev/null
fi

# 2. Docker ligado e app no ar
if ! docker info > /dev/null 2>&1; then log "Docker não está rodando; nada feito."; exit 0; fi
if ! healthy; then
  log "App fora do ar; subindo."
  run docker compose up -d
  wait_healthy || log "O app não respondeu depois de subir. Veja: docker compose logs"
fi

# 3. Versão nova?
run git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"; REMOTE="$(git rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] && exit 0
if ! git merge-base --is-ancestor HEAD origin/main; then log "Esta pasta tem commits que não estão no GitHub; atualização pulada."; exit 0; fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then log "Há arquivos alterados nesta pasta; atualização pulada."; exit 0; fi
grep -qx "$REMOTE" "$BAD" 2>/dev/null && exit 0

# Só atualiza se os testes do GitHub passaram nesta versão.
REPO="$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
TOKEN="$(env_get GITHUB_TOKEN)"
JSON="$(curl -fsS -m 20 -H 'Accept: application/vnd.github+json' -H 'User-Agent: financas-atualizador' \
  ${TOKEN:+-H "Authorization: Bearer $TOKEN"} "https://api.github.com/repos/$REPO/commits/$REMOTE/check-runs")" \
  || { log "Não consegui consultar o GitHub."; exit 0; }
STATE="$(printf '%s' "$JSON" | python3 -c '
import json, sys
runs = json.load(sys.stdin).get("check_runs", [])
if not runs: print("waiting")
elif any(r["status"] != "completed" for r in runs): print("waiting")
elif all(r["conclusion"] in ("success", "skipped", "neutral") for r in runs): print("ok")
else: print("failed")')"
[ "$STATE" = "waiting" ] && exit 0
if [ "$STATE" != "ok" ]; then
  log "Versão ${REMOTE:0:7} falhou nos testes do GitHub; mantida a atual."
  echo "$REMOTE" >> "$BAD"; exit 0
fi

FROM="${LOCAL:0:7}"; TO="${REMOTE:0:7}"
log "Atualizando de $FROM para $TO."
if ! run docker compose exec -T -u node financas node --disable-warning=ExperimentalWarning server/backup-cli.js; then
  log "Backup antes de atualizar falhou; atualização adiada."; exit 0
fi
run git merge --ff-only origin/main
run docker compose up -d --build
if wait_healthy; then
  log "Atualizado para $TO."
  run docker image prune -f
  exit 0
fi
log "A versão $TO não subiu; voltando para $FROM."
echo "$REMOTE" >> "$BAD"
run git reset --hard "$LOCAL"
run docker compose up -d --build
if wait_healthy; then log "Versão $FROM restaurada."; else log "ATENÇÃO: o app não voltou. Rode: docker compose logs"; fi
