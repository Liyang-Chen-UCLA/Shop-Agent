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

$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uvCommand) {
    Write-Error "uv is required but was not found on PATH. Install uv, then run 'uv sync' from the project directory."
    exit 1
}

if ($Check) {
    $projectRoot = $PSScriptRoot
    foreach ($requiredFile in @("pyproject.toml", "uv.lock")) {
        if (-not (Test-Path (Join-Path $projectRoot $requiredFile))) {
            Write-Error "Required project file '$requiredFile' was not found under '$projectRoot'."
            exit 1
        }
    }

    $environmentProbe = @("run", "--locked", "python", "-c", "import sys; print(sys.version)")
    Push-Location $projectRoot
    try {
        $environmentOutput = & $uvCommand.Source @environmentProbe 2>&1
        $environmentExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($environmentExitCode -ne 0) {
        Write-Error "uv project environment is not usable (exit code $environmentExitCode). Run 'uv sync' and retry."
        if ($environmentOutput) { Write-Error ($environmentOutput -join [Environment]::NewLine) }
        exit 1
    }

    $dependencyProbe = @("run", "--locked", "python", "-c", "import langgraph, langgraph.checkpoint.sqlite, pyarrow, pydantic")
    Push-Location $projectRoot
    try {
        $dependencyOutput = & $uvCommand.Source @dependencyProbe 2>&1
        $dependencyExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($dependencyExitCode -ne 0) {
        Write-Error "Required Python dependencies could not be imported in the uv environment (exit code $dependencyExitCode). Run 'uv sync' and retry."
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
