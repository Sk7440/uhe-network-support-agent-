# One-shot free deployment: GitHub (private) + Hugging Face Space (backend) + Vercel (frontend).
# Run from a normal terminal:  double-click deploy.bat   (keys are typed here, never stored in git)

$ErrorActionPreference = "Continue"   # native CLIs write warnings to stderr; we check exit codes instead
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Py = Join-Path $Backend ".venv\Scripts\python.exe"
$Hf = Join-Path $Backend ".venv\Scripts\hf.exe"

function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Fail($t) { Write-Host "`nERROR: $t" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 0. tools
Step "Checking tools"
foreach ($t in @("git", "gh", "vercel")) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Fail "$t is not installed" }
}
if (-not (Test-Path $Py)) {
    python -m venv (Join-Path $Backend ".venv")
    & $Py -m pip install -q -r (Join-Path $Backend "requirements.txt")
}
& $Py -m pip install -q huggingface_hub | Out-Null
Write-Host "OK"

# ---------------------------------------------------------------- 1. logins
Step "Hugging Face login"
& $Hf auth whoami *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Create a WRITE token at https://huggingface.co/settings/tokens and paste it below."
    & $Hf auth login
    & $Hf auth whoami *> $null
    if ($LASTEXITCODE -ne 0) { Fail "Hugging Face login failed" }
}
& $Hf auth whoami

Step "Vercel login"
vercel whoami 2>$null
if ($LASTEXITCODE -ne 0) { vercel login; if ($LASTEXITCODE -ne 0) { Fail "Vercel login failed" } }

# ---------------------------------------------------------------- 2. Ollama key + model check
Step "Ollama Cloud API key"
$sec = Read-Host "Paste your Ollama API key (from https://ollama.com/settings/keys)" -AsSecureString
$key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if (-not $key) { Fail "No key entered" }
$headers = @{ Authorization = "Bearer $key" }
try {
    $names = (Invoke-RestMethod "https://ollama.com/api/tags" -Headers $headers -TimeoutSec 30 -ErrorAction Stop).models | ForEach-Object { $_.name }
} catch { Fail "Ollama key rejected or ollama.com unreachable: $($_.Exception.Message)" }
$model = $names | Where-Object { $_ -eq "gemma4:31b" } | Select-Object -First 1
if (-not $model) { $model = $names | Where-Object { $_ -like "gemma4*" } | Select-Object -First 1 }
if (-not $model) { Fail "No gemma4 model available for this key. Available: $($names -join ', ')" }
$body = @{ model = $model; stream = $false; messages = @(@{ role = "user"; content = "Reply OK" }) } | ConvertTo-Json -Depth 5
try {
    $r = Invoke-RestMethod "https://ollama.com/api/chat" -Method Post -Headers $headers -Body $body -ContentType "application/json" -TimeoutSec 120 -ErrorAction Stop
} catch { Fail "Model test failed: $($_.Exception.Message)" }
Write-Host "Model $model works (reply: $($r.message.content.Trim()))" -ForegroundColor Green

# ---------------------------------------------------------------- 3. admin token
$tokenFile = Join-Path $Root "admin-token.txt"
if (Test-Path $tokenFile) { $admin = (Get-Content $tokenFile -Raw).Trim() }
else {
    $admin = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")).Substring(0, 40)
    Set-Content -Path $tokenFile -Value $admin -Encoding ascii
}

# ---------------------------------------------------------------- 4. GitHub (private)
Step "GitHub (private repo)"
Push-Location $Root
git remote get-url origin *> $null
if ($LASTEXITCODE -ne 0) {
    gh repo create uhe-network-support-agent --private --source=. --remote=origin --push
} else {
    git push -u origin main
}
if ($LASTEXITCODE -ne 0) { Write-Host "GitHub push failed - continuing with deployment" -ForegroundColor Yellow }
Pop-Location

# ---------------------------------------------------------------- 5. Hugging Face Space
Step "Backend -> Hugging Face Space"
$env:OLLAMA_API_KEY = $key
$env:ADMIN_TOKEN = $admin
$env:CHAT_MODEL = $model
$out = & $Py (Join-Path $PSScriptRoot "deploy_hf.py") 2>&1
$out | Where-Object { $_ -notmatch "^SPACE_URL=" } | ForEach-Object { Write-Host $_ }
Remove-Item Env:OLLAMA_API_KEY, Env:ADMIN_TOKEN
if ($LASTEXITCODE -ne 0) { Fail "Hugging Face deployment failed" }
$api = (($out | Where-Object { $_ -match "^SPACE_URL=" }) -replace "^SPACE_URL=", "").Trim()
Write-Host "Backend URL: $api"

Write-Host "Waiting for the Space to build and start (usually 3-6 minutes)..."
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 10
    try {
        $h = Invoke-RestMethod "$api/api/health" -TimeoutSec 15 -ErrorAction Stop
        if ($h.api) { $ok = $true; break }
    } catch { Write-Host -NoNewline "." }
}
if (-not $ok) { Fail "Backend did not start. Check build logs: https://huggingface.co/spaces/$((& $Hf auth whoami | Select-Object -First 1).Trim())/uhe-network-agent-api?logs=build" }
Write-Host "`nBackend online. Ollama connected: $($h.ollama)" -ForegroundColor Green

# ---------------------------------------------------------------- 6. Vercel
Step "Frontend -> Vercel"
Push-Location $Frontend
vercel project add uhe-network-support-agent 2>$null | Out-Null
vercel link --yes --project uhe-network-support-agent
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "vercel link failed" }
vercel env add NEXT_PUBLIC_API_URL --environment production --value $api --force --yes
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "Could not set NEXT_PUBLIC_API_URL on Vercel" }
$deployOut = vercel --prod --yes 2>&1
$deployOut | ForEach-Object { Write-Host $_ }
Pop-Location
$text = ($deployOut | Out-String)
$aliased = [regex]::Match($text, "Aliased:\s*(https://\S+?\.vercel\.app)")
if ($aliased.Success) { $site = $aliased.Groups[1].Value }
else {
    $site = "https://uhe-network-support-agent.vercel.app"
    try { Invoke-WebRequest $site -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop | Out-Null }
    catch { $site = [regex]::Match($text, "https://\S+?\.vercel\.app").Value }
}

# ---------------------------------------------------------------- done
Step "DONE"
Write-Host "Assistant      : $site" -ForegroundColor Green
Write-Host "Admin console  : $site/admin" -ForegroundColor Green
Write-Host "Admin token    : saved in $tokenFile"
Write-Host "Backend (API)  : $api   (docs: $api/docs)"
Start-Process $site
