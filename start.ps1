param(
    [switch]$Check,
    [switch]$DebugMode,
    [string]$Config
)

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Error "Node.js 22.19 or newer is required."
    exit 1
}

if (-not $env:OPENCODE_API_KEY) {
    Write-Error "OPENCODE_API_KEY is not visible in this terminal. Open a new terminal after creating the system environment variable."
    exit 1
}

$arguments = @("src/cli.ts")
if ($Check) { $arguments += "--check" }
if ($DebugMode) { $arguments += "--debug" }
if ($Config) { $arguments += @("--config", $Config) }

& $nodeCommand.Source @arguments
exit $LASTEXITCODE
