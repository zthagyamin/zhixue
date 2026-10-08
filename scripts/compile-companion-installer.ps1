# Windows PowerShell 5.1-only compatibility helper: emits a .NET Framework EXE.
param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$PayloadPath
)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop") {
    throw "Standalone installer compilation requires Windows PowerShell/.NET Framework."
}
$compiler = [Microsoft.CSharp.CSharpCodeProvider]::new()
$parameters = [System.CodeDom.Compiler.CompilerParameters]::new()
$parameters.GenerateExecutable = $true
$parameters.OutputAssembly = $OutputPath
$parameters.ReferencedAssemblies.AddRange(@('System.dll','System.Core.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll'))
$parameters.CompilerOptions = '/resource:"' + $PayloadPath + '",ZhixuePayload'
$result = $compiler.CompileAssemblyFromFile($parameters, $SourcePath)
if ($result.Errors.HasErrors) { throw (($result.Errors | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine) }
$compiler.Dispose()
