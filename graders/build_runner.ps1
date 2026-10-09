# Rebuilds sandbox_runner.exe from sandbox_runner.cs using the .NET Framework compiler that ships with Windows.
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /optimize /target:exe /out:"$PSScriptRoot\sandbox_runner.exe" "$PSScriptRoot\sandbox_runner.cs"
