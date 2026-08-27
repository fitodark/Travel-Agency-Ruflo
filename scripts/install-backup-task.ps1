<#
    Instala las tareas programadas de respaldo en la PC de la sucursal.

    Blueprint v0.2 - CHANGELOG D-2 y D-5.

    Crea DOS tareas, no una:

      Donaji-Respaldo-Horario     cada hora, sin verificar. Es barato y no estorba
                                  la operacion de la caja.
      Donaji-Respaldo-Verificado  una vez al dia en la ventana de madrugada. Restaura
                                  el ultimo dump en una base desechable y lo compara
                                  contra el origen. Un respaldo que nadie ha restaurado
                                  no es un respaldo.

    Se ejecutan aunque nadie haya iniciado sesion (-RunLevel Highest, cuenta SYSTEM),
    porque la caja puede estar cerrada y la maquina encendida.

    Uso (PowerShell como administrador):
      .\install-backup-task.ps1 -ProjectDir "C:\donaji" -BackupDir "E:\respaldos" -Sucursal A
      .\install-backup-task.ps1 -Uninstall
#>
param(
    [string]$ProjectDir,
    [string]$BackupDir,
    [string]$Sucursal = 'A',
    [int]$RetentionDays = 7,
    [string]$HoraVerificacion = '03:30',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$TareaHoraria = 'Donaji-Respaldo-Horario'
$TareaDiaria  = 'Donaji-Respaldo-Verificado'

function Remove-TareaSiExiste([string]$Nombre) {
    if (Get-ScheduledTask -TaskName $Nombre -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Nombre -Confirm:$false
        Write-Output "Eliminada: $Nombre"
    }
}

if ($Uninstall) {
    Remove-TareaSiExiste $TareaHoraria
    Remove-TareaSiExiste $TareaDiaria
    Write-Output 'Tareas de respaldo desinstaladas.'
    exit 0
}

if (-not $ProjectDir) { throw 'Falta -ProjectDir' }
if (-not $BackupDir)  { throw 'Falta -BackupDir' }
if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "No existe -ProjectDir: $ProjectDir" }

# El destino debe existir ANTES de programar nada: si la USB no esta montada, es mejor
# fallar aqui, con alguien mirando, que descubrirlo en el primer disco muerto.
if (-not (Test-Path -LiteralPath $BackupDir)) {
    throw "No existe -BackupDir: $BackupDir. Conecta el medio externo o crea la carpeta."
}

$volProyecto = (Get-Item -LiteralPath $ProjectDir).PSDrive.Name
$volRespaldo = (Get-Item -LiteralPath $BackupDir).PSDrive.Name
if ($volProyecto -eq $volRespaldo) {
    Write-Warning "El respaldo va al mismo volumen ($volRespaldo`:) que el sistema. Un fallo de disco se lleva ambos. En produccion debe ser una USB o disco externo dedicado."
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npm) { throw 'No se encontro npm en el PATH.' }

function New-TareaRespaldo {
    param([string]$Nombre, [string]$Script, $Trigger, [string]$Descripcion)

    Remove-TareaSiExiste $Nombre

    $accion = New-ScheduledTaskAction `
        -Execute $npm.Source `
        -Argument "run $Script" `
        -WorkingDirectory $ProjectDir

    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    # StartWhenAvailable: si la maquina estaba apagada a la hora programada, la tarea
    # corre en cuanto encienda en vez de perder ese respaldo por completo.
    $opciones = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -DontStopOnIdleEnd `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask `
        -TaskName $Nombre `
        -Action $accion `
        -Trigger $Trigger `
        -Principal $principal `
        -Settings $opciones `
        -Description $Descripcion | Out-Null

    Write-Output "Registrada: $Nombre"
}

$triggerHorario = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

$triggerDiario = New-ScheduledTaskTrigger -Daily -At $HoraVerificacion

New-TareaRespaldo -Nombre $TareaHoraria -Script 'backup:hourly' -Trigger $triggerHorario `
    -Descripcion 'Respaldo horario de la base local de la sucursal (sin verificacion).'

New-TareaRespaldo -Nombre $TareaDiaria -Script 'backup' -Trigger $triggerDiario `
    -Descripcion 'Respaldo diario con restauracion verificada en base desechable.'

# La configuracion viaja por variables de entorno de maquina para que las tareas
# (que corren como SYSTEM, sin el perfil del usuario) la vean.
[Environment]::SetEnvironmentVariable('BACKUP_DIR', $BackupDir, 'Machine')
[Environment]::SetEnvironmentVariable('SUCURSAL_CODIGO', $Sucursal, 'Machine')
[Environment]::SetEnvironmentVariable('BACKUP_RETENTION_DAYS', "$RetentionDays", 'Machine')

Write-Output ''
Write-Output "Destino    : $BackupDir"
Write-Output "Sucursal   : $Sucursal"
Write-Output "Retencion  : $RetentionDays dias"
Write-Output "Verificado : diario a las $HoraVerificacion"
Write-Output ''
Write-Output 'Para probar ahora:  Start-ScheduledTask -TaskName Donaji-Respaldo-Verificado'
