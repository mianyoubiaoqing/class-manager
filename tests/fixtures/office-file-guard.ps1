$ErrorActionPreference = 'Stop'
$officeGuardPath = [IO.Path]::GetFullPath($env:CLASS_MANAGER_OFFICE_GUARD_PATH)
$officeGuardRoot = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'output')) + [IO.Path]::DirectorySeparatorChar
if (-not $officeGuardPath.StartsWith($officeGuardRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Only owned test output may be guarded.' }
if ($env:CLASS_MANAGER_OFFICE_GUARD_MODE -eq 'lock') {
  $officeGuardHandle = [IO.File]::Open($officeGuardPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try { [Console]::WriteLine('READY'); [Console]::Out.Flush(); [void][Console]::ReadLine() }
  finally { $officeGuardHandle.Dispose() }
} elseif ($env:CLASS_MANAGER_OFFICE_GUARD_MODE -eq 'permission') {
  $officeGuardAcl = [IO.Directory]::GetAccessControl($officeGuardPath)
  $officeGuardOriginal = $officeGuardAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  $officeGuardSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $officeGuardRule = [Security.AccessControl.FileSystemAccessRule]::new($officeGuardSid, [Security.AccessControl.FileSystemRights]::CreateFiles, [Security.AccessControl.AccessControlType]::Deny)
  try {
    $officeGuardAcl.AddAccessRule($officeGuardRule)
    [IO.Directory]::SetAccessControl($officeGuardPath, $officeGuardAcl)
    [Console]::WriteLine('READY'); [Console]::Out.Flush(); [void][Console]::ReadLine()
  } finally {
    $officeGuardRestore = [IO.Directory]::GetAccessControl($officeGuardPath)
    $officeGuardRestore.SetSecurityDescriptorSddlForm($officeGuardOriginal, [Security.AccessControl.AccessControlSections]::Access)
    [IO.Directory]::SetAccessControl($officeGuardPath, $officeGuardRestore)
  }
} else { throw 'Unknown file guard mode.' }
