#!/usr/bin/env bash
# Liga a atualização automática. Rode uma vez, no terminal do Ubuntu (WSL), na pasta do projeto:
#   bash scripts/instalar-atualizacao.sh
# No WSL, cria uma tarefa no Agendador de Tarefas do Windows que chama o atualizar.sh
# a cada 10 minutos (funciona mesmo com o terminal do Ubuntu fechado).
# Em um Linux comum (sem Windows), usa o cron.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/atualizar.sh"
chmod +x "$SCRIPT"
for c in git docker curl python3 flock; do command -v "$c" > /dev/null || { echo "Falta o comando '$c'. Instale e rode de novo."; exit 1; }; done
[ -f "$ROOT/.env" ] || { echo "Falta o arquivo .env na pasta do projeto (copie o .env.example)."; exit 1; }
docker info > /dev/null 2>&1 || { echo "O Docker não respondeu aqui. Abra o Docker Desktop e confira se a integração com esta distro do WSL está ligada."; exit 1; }

if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v schtasks.exe > /dev/null; then
  WINAPP="$(cmd.exe /c 'echo %LOCALAPPDATA%' 2> /dev/null | tr -d '\r')"
  DIR_WIN="$WINAPP\\Financas"
  DIR_WSL="$(wslpath "$DIR_WIN")"
  mkdir -p "$DIR_WSL"
  # Um .vbs roda o wsl.exe sem abrir janela a cada 10 minutos.
  printf '%s\r\n' \
    "' Criado por instalar-atualizacao.sh: roda a atualização do app de Finanças sem abrir janela." \
    'Set sh = CreateObject("WScript.Shell")' \
    "sh.Run \"wsl.exe -d $WSL_DISTRO_NAME -u $(id -un) -- bash \"\"$SCRIPT\"\"\", 0, False" \
    > "$DIR_WSL/atualizar.vbs"
  schtasks.exe /Create /F /SC MINUTE /MO 10 /TN "Financas - atualizar" \
    /TR "wscript.exe \"$DIR_WIN\\atualizar.vbs\"" > /dev/null
  echo "Pronto: a tarefa \"Financas - atualizar\" do Windows roda a cada 10 minutos."
else
  LINE="*/10 * * * * bash \"$SCRIPT\""
  ( crontab -l 2> /dev/null | grep -vF "$SCRIPT"; echo "$LINE" ) | crontab -
  echo "Pronto: o cron roda a atualização a cada 10 minutos."
fi
echo "O que ela faz fica em: $ROOT/logs/atualizar.log"
echo "Rodando a primeira vez agora..."
bash "$SCRIPT"
tail -n 5 "$ROOT/logs/atualizar.log" 2> /dev/null || true
echo "Feito."
