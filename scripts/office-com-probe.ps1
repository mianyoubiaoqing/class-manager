$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OfficeAuditWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$officeExistingIds = @(Get-Process wps -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$officeProbeReport = @()
foreach ($officeProgId in @('KWPS.Application','KWPP.Application')) {
  $officeApplication = $null
  $officeOwned = $false
  try {
    $officeApplication = New-Object -ComObject $officeProgId
    $officeWindow = [IntPtr][long]$officeApplication.Hwnd
    [uint32]$officeProcessId = 0
    [void][OfficeAuditWindow]::GetWindowThreadProcessId($officeWindow, [ref]$officeProcessId)
    $officeCount = if ($officeProgId -eq 'KWPS.Application') { [int]$officeApplication.Documents.Count } else { [int]$officeApplication.Presentations.Count }
    $officeOwned = $officeWindow -ne [IntPtr]::Zero -and $officeProcessId -gt 0 -and $officeExistingIds -notcontains [int]$officeProcessId -and $officeCount -eq 0
    $officeProbeReport += @{ progId = $officeProgId; hwnd = $officeWindow.ToInt64(); processId = $officeProcessId; existingProcess = $officeExistingIds -contains [int]$officeProcessId; documentCount = $officeCount; safeOwnedInstance = $officeOwned; version = [string]$officeApplication.Version }
  } catch {
    $officeProbeReport += @{ progId = $officeProgId; error = $_.Exception.Message }
  } finally {
    if ($officeApplication -ne $null) {
      if ($officeOwned) { $officeApplication.Quit() }
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeApplication)
    }
  }
}
$officeProbeReport | ConvertTo-Json -Depth 5
