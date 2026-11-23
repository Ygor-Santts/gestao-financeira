# Atualização automática do app de Finanças (Windows).
# Roda a cada 10 minutos pela tarefa agendada que o instalar.ps1 cria. Ele:
#  1. copia os backups para a pasta da nuvem (PASTA_BACKUP_NUVEM no .env), se houver;
#  2. sobe o app se ele estiver parado (por exemplo, depois de reiniciar o PC);
#  3. se houver versão nova no GitHub e ela passou nos testes, faz um backup,
#     atualiza e confere se o app voltou. Se não voltar, retorna para a versão anterior.
# Tudo fica registrado em logs\atualizar.log.

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'atualizar.log'
if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) { Move-Item $Log "$Log.old" -Force }
function Log([string]$msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Add-Content -Path $Log -Encoding UTF8 }

# Comandos externos com a saída no log (via cmd, para o PowerShell não tratar avisos como erro).
function Run([string]$cmd) {
  cmd /c "$cmd >> `"$Log`" 2>&1"
  return $LASTEXITCODE
}

# Lê o .env
$cfg = @{}
if (Test-Path (Join-Path $Root '.env')) {
  Get-Content (Join-Path $Root '.env') | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $cfg[$matches[1]] = $matches[2].Trim('"').Trim("'") }
  }
}
$Port = if ($cfg['PORTA']) { $cfg['PORTA'] } else { '8080' }

function Healthy {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://localhost:$Port/api/health").StatusCode -eq 200 } catch { return $false }
}
function WaitHealthy {
  for ($i = 0; $i -lt 40; $i++) { if (Healthy) { return $true }; Start-Sleep -Seconds 3 }
  return $false
}

# 1. Cópia dos backups para a nuvem
$cloud = $cfg['PASTA_BACKUP_NUVEM']
if ($cloud -and (Test-Path (Join-Path $Root 'backups'))) {
  if (-not (Test-Path $cloud)) { New-Item -ItemType Directory -Force -Path $cloud | Out-Null }
  robocopy (Join-Path $Root 'backups') $cloud 'financas-*' /XO /NFL /NDL /NJH /NJS /NP | Out-Null
}

# 2. Docker ligado e app no ar
docker info *> $null
if ($LASTEXITCODE -ne 0) { Log 'Docker Desktop não está rodando; nada feito.'; exit 0 }
if (-not (Healthy)) {
  Log 'App fora do ar; subindo.'
  Run 'docker compose up -d' | Out-Null
  if (-not (WaitHealthy)) { Log 'O app não respondeu depois de subir. Veja: docker compose logs'; }
}

# 3. Versão nova?
Run 'git fetch --quiet origin main' | Out-Null
$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse origin/main).Trim()
if ($local -eq $remote) { exit 0 }

git merge-base --is-ancestor HEAD origin/main
if ($LASTEXITCODE -ne 0) { Log 'Esta pasta tem mudanças que não estão no GitHub; atualização automática pulada.'; exit 0 }
if ((git status --porcelain --untracked-files=no) -ne $null) { Log 'Há arquivos alterados nesta pasta; atualização automática pulada.'; exit 0 }

$bad = Join-Path $LogDir 'versoes-com-problema.txt'
if ((Test-Path $bad) -and (Select-String -Path $bad -SimpleMatch $remote -Quiet)) { exit 0 }

# Só atualiza se os testes do GitHub passaram nesta versão.
$url = (git remote get-url origin).Trim()
if ($url -notmatch 'github\.com[:/](.+?)(\.git)?$') { Log "Origem não é o GitHub ($url); atualização pulada."; exit 0 }
$repo = $matches[1]
$headers = @{ 'User-Agent' = 'financas-atualizador'; 'Accept' = 'application/vnd.github+json' }
if ($cfg['GITHUB_TOKEN']) { $headers['Authorization'] = "Bearer $($cfg['GITHUB_TOKEN'])" }
try {
  $runs = Invoke-RestMethod -UseBasicParsing -Headers $headers "https://api.github.com/repos/$repo/commits/$remote/check-runs"
} catch { Log "Não consegui consultar o GitHub: $($_.Exception.Message)"; exit 0 }
if ($runs.total_count -eq 0) { exit 0 }                                         # testes ainda não começaram
if ($runs.check_runs | Where-Object { $_.status -ne 'completed' }) { exit 0 }    # ainda rodando
if ($runs.check_runs | Where-Object { $_.conclusion -notin @('success', 'skipped', 'neutral') }) {
  Log "Versão $($remote.Substring(0,7)) falhou nos testes do GitHub; mantida a atual."
  Add-Content -Path $bad -Value $remote
  exit 0
}

$from = $local.Substring(0, 7); $to = $remote.Substring(0, 7)
Log "Atualizando de $from para $to."
if ((Run 'docker compose exec -T -u node financas node --disable-warning=ExperimentalWarning server/backup-cli.js') -ne 0) {
  Log 'Backup antes de atualizar falhou; atualização adiada.'
  exit 0
}
Run 'git merge --ff-only origin/main' | Out-Null
Run 'docker compose up -d --build' | Out-Null
if (WaitHealthy) {
  Log "Atualizado para $to."
  Run 'docker image prune -f' | Out-Null
  exit 0
}

Log "A versão $to não subiu; voltando para $from."
Add-Content -Path $bad -Value $remote
Run "git reset --hard $local" | Out-Null
Run 'docker compose up -d --build' | Out-Null
if (WaitHealthy) { Log "Versão $from restaurada." } else { Log 'ATENÇÃO: o app não voltou. Rode: docker compose logs' }
