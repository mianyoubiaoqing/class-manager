$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$officeAuditRoot = [IO.Path]::GetFullPath($env:CLASS_MANAGER_OFFICE_OUTPUT)
$officeWorkspaceOutput = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'output')) + [IO.Path]::DirectorySeparatorChar
if (-not $officeAuditRoot.StartsWith($officeWorkspaceOutput, [StringComparison]::OrdinalIgnoreCase)) { throw 'Audit files must remain under workspace output.' }
$officeAuditReport = [ordered]@{ target = 'WPS 12.1.0.28505'; word = $null; presentation = $null; errors = @(); existingWindowsUntouched = $true }
$officeApplication = $null
$officeDocument = $null
try {
  $officeApplication = New-Object -ComObject KWPS.Application
  $officeDocument = $officeApplication.Documents.Open((Join-Path $officeAuditRoot 'lesson.docx'))
  $officeDocument.ExportAsFixedFormat((Join-Path $officeAuditRoot 'word-original.pdf'), 17)
  $officeDocument.Content.InsertAfter("`rWPS_NATIVE_EDIT：办公软件实际编辑保存验收。")
  $officeDocument.Tables.Item(1).Cell(2,2).Range.Text = 'WPS_NATIVE_TABLE_EDIT'
  $officeDocument.SaveAs((Join-Path $officeAuditRoot 'word-edited.docx'), 12)
  $officeDocument.Close(0)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeDocument)
  $officeDocument = $officeApplication.Documents.Open((Join-Path $officeAuditRoot 'word-edited.docx'))
  $officeWordText = [string]$officeDocument.Content.Text
  if (-not $officeWordText.Contains('WPS_NATIVE_EDIT') -or -not $officeWordText.Contains('WPS_NATIVE_TABLE_EDIT')) { throw 'Word edits did not survive reopen.' }
  $officeDocument.ExportAsFixedFormat((Join-Path $officeAuditRoot 'word-edited.pdf'), 17)
  $officeAuditReport.word = @{ editedAndReopened = $true; tables = [int]$officeDocument.Tables.Count; inlineImages = [int]$officeDocument.InlineShapes.Count; applicationVersion = [string]$officeApplication.Version }
} catch { $officeAuditReport.errors += @{ format = 'docx'; error = $_.Exception.Message } }
finally {
  if ($officeDocument -ne $null) { try { $officeDocument.Close(0) } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeDocument); $officeDocument = $null }
  # Never quit or change visibility/alerts of an application whose exclusive ownership is unknown.
  if ($officeApplication -ne $null) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeApplication); $officeApplication = $null }
}
try {
  $officeApplication = New-Object -ComObject KWPP.Application
  $officeDocument = $officeApplication.Presentations.Open((Join-Path $officeAuditRoot 'lesson.pptx'), 0, 0, 0)
  $officeDocument.SaveAs((Join-Path $officeAuditRoot 'presentation-original.pdf'), 32)
  $officeShape = $officeDocument.Slides.Item(1).Shapes.Item(1)
  $officeShape.TextFrame.TextRange.Text = [string]$officeShape.TextFrame.TextRange.Text + ' WPS_NATIVE_SLIDE_EDIT'
  $officeEditedTable = $false
  foreach ($officeSlide in $officeDocument.Slides) {
    foreach ($officeTableShape in $officeSlide.Shapes) {
      if ($officeTableShape.HasTable -eq -1 -and -not $officeEditedTable) {
        $officeTableShape.Table.Cell(2,2).Shape.TextFrame.TextRange.Text = 'WPS_NATIVE_TABLE_EDIT'
        $officeEditedTable = $true
      }
    }
  }
  if (-not $officeEditedTable) { throw 'No editable native presentation table found.' }
  $officeDocument.SaveAs((Join-Path $officeAuditRoot 'presentation-edited.pptx'), 24)
  $officeDocument.Close()
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeDocument)
  $officeDocument = $officeApplication.Presentations.Open((Join-Path $officeAuditRoot 'presentation-edited.pptx'), 0, 0, 0)
  if (-not ([string]$officeDocument.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Text).Contains('WPS_NATIVE_SLIDE_EDIT')) { throw 'Presentation text edit did not survive reopen.' }
  $officeTableReopened = $false
  $officeNativeTableCount = 0
  foreach ($officeSlide in $officeDocument.Slides) {
    foreach ($officeTableShape in $officeSlide.Shapes) {
      if ($officeTableShape.HasTable -eq -1) {
        $officeNativeTableCount++
        if (([string]$officeTableShape.Table.Cell(2,2).Shape.TextFrame.TextRange.Text).Contains('WPS_NATIVE_TABLE_EDIT')) { $officeTableReopened = $true }
      }
    }
  }
  if (-not $officeTableReopened) { throw 'Presentation table edit did not survive reopen.' }
  $officeDocument.SaveAs((Join-Path $officeAuditRoot 'presentation-edited.pdf'), 32)
  $officeAuditReport.presentation = @{ editedAndReopened = $true; slides = [int]$officeDocument.Slides.Count; nativeTables = $officeNativeTableCount; applicationVersion = [string]$officeApplication.Version }
} catch { $officeAuditReport.errors += @{ format = 'pptx'; error = $_.Exception.Message } }
finally {
  if ($officeDocument -ne $null) { try { $officeDocument.Close() } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeDocument) }
  if ($officeApplication -ne $null) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeApplication) }
}
$officeAuditJson = $officeAuditReport | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $officeAuditRoot 'wps-report.json'), $officeAuditJson, [Text.UTF8Encoding]::new($false))
$officeAuditJson
if ($officeAuditReport.errors.Count -gt 0) { exit 1 }
