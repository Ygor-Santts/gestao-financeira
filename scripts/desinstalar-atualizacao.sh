#!/usr/bin/env bash
# Desliga a atualização automática (o app continua rodando normalmente).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v schtasks.exe > /dev/null; then schtasks.exe /Delete /F /TN "Financas - atualizar" > /dev/null 2>&1; fi
( crontab -l 2> /dev/null | grep -vF "$ROOT/scripts/atualizar.sh" ) | crontab - 2> /dev/null || true
echo "Atualização automática desligada."
