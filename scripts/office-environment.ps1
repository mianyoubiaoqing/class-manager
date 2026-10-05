$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$officeEnvironment = [ordered]@{ processes = @(Get-Process wps,wpp,et,wpspdf -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,MainWindowTitle); progIds = @() }
foreach ($officeProgId in @('KWPS.Application','KWPP.Application','WPS.Application','WPP.Application','Word.Application','PowerPoint.Application')) {
  $officeRegistryPath = 'Registry::HKEY_CLASSES_ROOT\' + $officeProgId
  if (Test-Path -LiteralPath $officeRegistryPath) {
    $officeClassId = (Get-Item -LiteralPath ($officeRegistryPath + '\CLSID')).GetValue('')
    $officeServerPath = 'Registry::HKEY_CLASSES_ROOT\CLSID\' + $officeClassId + '\LocalServer32'
    $officeEnvironment.progIds += @{ progId = $officeProgId; classId = $officeClassId; server = if(Test-Path -LiteralPath $officeServerPath) { (Get-Item -LiteralPath $officeServerPath).GetValue('') } else { $null } }
  }
}
$officeEnvironment | ConvertTo-Json -Depth 5
