# Package the committed code (git HEAD), upload it to S3, and run deploy.sh on
# the test server through SSM Run Command. No SSH, no open port 22.
#
#   powershell -File tools\aws\deploy.ps1
#
# Uncommitted changes are NOT shipped — commit first.
param([switch]$SkipUpload)

$aws      = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$r        = 'ap-south-1'
$bucket   = 'crm-test-deploy-010539085833'
$instance = 'i-0f31e28ef78199ee1'
$repo     = (Resolve-Path "$PSScriptRoot\..\..").Path
$enc      = New-Object Text.UTF8Encoding $false
# The CLI is Python: without UTF-8 mode it dies writing box-drawing characters
# from the server log to a Windows code page.
$env:PYTHONUTF8 = '1'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $SkipUpload) {
  $dirty = git -C $repo status --porcelain -- apps packages package.json package-lock.json
  if ($dirty) { Write-Warning "Uncommitted changes will NOT be deployed:`n$($dirty -join "`n")" }
  $tgz = Join-Path $env:TEMP 'crm-app.tar.gz'
  git -C $repo archive --format=tar.gz -o $tgz HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
  & $aws s3 cp $tgz "s3://$bucket/app.tar.gz" --region $r --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw 'upload failed' }
  # deploy.sh must reach the server with LF endings
  $sh = [IO.File]::ReadAllText("$PSScriptRoot\deploy.sh") -replace "`r`n", "`n"
  $shTmp = Join-Path $env:TEMP 'crm-deploy.sh'
  [IO.File]::WriteAllText($shTmp, $sh, $enc)
  & $aws s3 cp $shTmp "s3://$bucket/deploy.sh" --region $r --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw 'upload failed' }
}

$params = @{
  commands = @(
    "aws s3 cp s3://$bucket/deploy.sh /tmp/deploy.sh --region $r --only-show-errors",
    'bash /tmp/deploy.sh > /var/log/crm-deploy.log 2>&1; rc=$?; tail -n 60 /var/log/crm-deploy.log; exit $rc'
  )
  executionTimeout = @('3600')
} | ConvertTo-Json -Compress
$pf = Join-Path $env:TEMP 'crm-deploy-params.json'
[IO.File]::WriteAllText($pf, $params, $enc)

$cmd = & $aws ssm send-command --region $r --instance-ids $instance --document-name AWS-RunShellScript `
  --comment 'crm deploy' --parameters "file://$pf" --query Command.CommandId --output text
if ($LASTEXITCODE -ne 0) { throw 'send-command failed (is the server running? try start.ps1)' }
"Deploying ($cmd) - usually 10-15 minutes..."

do {
  Start-Sleep -Seconds 20
  $st = & $aws ssm get-command-invocation --region $r --command-id $cmd --instance-id $instance --query Status --output text 2>$null
} while (-not $st -or $st -in 'Pending', 'InProgress', 'Delayed')

# JSON, not text: the log contains box-drawing characters that the CLI cannot
# write to a Windows console code page in text mode.
$res = & $aws ssm get-command-invocation --region $r --command-id $cmd --instance-id $instance --output json | Out-String | ConvertFrom-Json
$res.StandardOutputContent
"status: $st   (full log on the server: /var/log/crm-deploy.log)"
if ($st -ne 'Success') { exit 1 }
