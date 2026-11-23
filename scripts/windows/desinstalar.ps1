# Desliga a atualização automática (o app continua rodando normalmente).
Unregister-ScheduledTask -TaskName 'Financas - atualizar' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Atualização automática desligada.'
