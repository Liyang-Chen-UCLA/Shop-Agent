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

if ($Check) {
    $projectRoot = $PSScriptRoot
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uvCommand) {
        Write-Warning "uv was not found on PATH. The existing .venv can run, but uv is needed for future dependency setup."
    }
    foreach ($requiredFile in @("pyproject.toml", "uv.lock")) {
        if (-not (Test-Path (Join-Path $projectRoot $requiredFile))) {
            Write-Error "Required project file '$requiredFile' was not found under '$projectRoot'."
            exit 1
        }
    }

    $pythonExecutable = if ($IsWindows -or $env:OS -eq "Windows_NT") {
        Join-Path $projectRoot ".venv\Scripts\python.exe"
    } else {
        Join-Path $projectRoot ".venv/bin/python"
    }
    if (-not (Test-Path -LiteralPath $pythonExecutable -PathType Leaf)) {
        Write-Error "Python environment not found. Run 'uv sync' from the project root."
        exit 1
    }

    $dependencyProbe = @("-X", "utf8", "-c", "import langgraph, langgraph.checkpoint.sqlite, pyarrow, pydantic")
    Push-Location $projectRoot
    try {
        $dependencyOutput = & $pythonExecutable @dependencyProbe 2>&1
        $dependencyExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($dependencyExitCode -ne 0) {
        Write-Error "Required Python dependencies could not be imported from .venv (exit code $dependencyExitCode). Run 'uv sync' and retry."
        if ($dependencyOutput) { Write-Error ($dependencyOutput -join [Environment]::NewLine) }
        exit 1
    }
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
