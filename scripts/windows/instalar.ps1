# Liga a atualização automática do app de Finanças neste Windows.
# Rode uma vez, na pasta do projeto:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\instalar.ps1
# Para desligar: powershell -ExecutionPolicy Bypass -File scripts\windows\desinstalar.ps1

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script = Join-Path $PSScriptRoot 'atualizar.ps1'
$hidden = Join-Path $PSScriptRoot 'rodar-oculto.vbs'

foreach ($cmd in 'git', 'docker') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Não achei o comando '$cmd'. Instale-o e rode este script de novo." }
}
if (-not (Test-Path (Join-Path $Root '.env'))) { throw 'Falta o arquivo .env na pasta do projeto (copie o .env.example).' }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$hidden`" `"$script`"" -WorkingDirectory $Root
$every10 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'Financas - atualizar' -Action $action -Trigger $every10, $atLogon -Settings $settings `
  -Description 'Mantém o app de Finanças no ar e atualizado (veja logs\atualizar.log na pasta do projeto).' -Force | Out-Null

Write-Host ''
Write-Host 'Pronto: a tarefa "Financas - atualizar" roda a cada 10 minutos e quando você entra no Windows.' -ForegroundColor Green
Write-Host "O que ela faz fica em: $(Join-Path $Root 'logs\atualizar.log')"
Write-Host ''
Write-Host 'Confira no Docker Desktop: Settings > General > "Start Docker Desktop when you sign in" ligado.'
Write-Host 'Rodando a primeira vez agora...'
& powershell -NoProfile -ExecutionPolicy Bypass -File $script
Write-Host 'Feito.'
