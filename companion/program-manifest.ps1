# Shared by packaging and installation; compatible with the installer PowerShell 5.1 host.
function Read-CompanionProgramFiles([string]$SourceRoot) {
    $path = Join-Path $SourceRoot 'program-files.json'
    $manifest = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $keys = @($manifest.PSObject.Properties.Name)
    if ($keys.Count -ne 2 -or 'schemaVersion' -notin $keys -or 'files' -notin $keys -or
        ($manifest.schemaVersion -isnot [int] -and $manifest.schemaVersion -isnot [long]) -or
        $manifest.schemaVersion -ne 1 -or $manifest.files -isnot [Array] -or
        $manifest.files.Count -lt 1 -or $manifest.files.Count -gt 512) {
        throw 'Invalid Companion program manifest.'
    }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.files) {
        if ($entry -isnot [string] -or $entry.Length -gt 160 -or
            $entry -notmatch '^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$' -or
            $entry -match '(^|/)\.\.?(/|$)' -or $entry -match '(^|/)config\.local\.json$' -or
            ($entry.StartsWith('data/', [StringComparison]::OrdinalIgnoreCase) -and $entry -ne 'data/seed.json') -or
            -not $seen.Add($entry)) {
            throw 'Unsafe or duplicate Companion program entry.'
        }
    }
    foreach ($required in @('program-files.json', 'program-manifest.ps1', 'server.py', 'install-or-upgrade.ps1')) {
        if (-not $seen.Contains($required)) { throw 'Incomplete Companion program manifest.' }
    }
    return $manifest.files
}
