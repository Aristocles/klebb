# SPDX-License-Identifier: AGPL-3.0-only
param(
  [Parameter(Mandatory = $true)][string]$StableAar,
  [Parameter(Mandatory = $true)][string]$AlphaAar,
  [string]$JavaHome = $env:JAVA_HOME,
  [string]$OutputRoot = (Join-Path $PSScriptRoot '../build/sdk-inventory')
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$expected = [ordered]@{
  '1.1.0' = 'ce1601af0ef671ec6a76b0f29d2af22acc578e408c7107d08ea23067d3822593'
  '1.2.0-alpha06' = '53d29a565146ae5eb801ed8d5968758539a3d05cb9f882b095cd8587c112cbf7'
}
$artifacts = [ordered]@{ '1.1.0' = $StableAar; '1.2.0-alpha06' = $AlphaAar }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)

function Find-JdkTool([string]$Name) {
  $suffix = ''
  if ([IO.Path]::DirectorySeparatorChar -eq '\') { $suffix = '.exe' }
  if ($JavaHome) {
    $candidate = Join-Path $JavaHome "bin/$Name$suffix"
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw "JDK tool $Name is missing from JavaHome."
    }
    return $candidate
  }
  return (Get-Command "$Name$suffix" -ErrorAction Stop).Source
}

function Write-Utf8([string]$Name, [string]$Text) {
  [IO.File]::WriteAllText((Join-Path $OutputRoot $Name), ($Text -replace "`r`n", "`n") + "`n", $utf8)
}

function ConvertTo-InventoryJson($Value) {
  $json = $Value | ConvertTo-Json -Depth 10
  # Windows PowerShell uses four-space indentation and HTML character escapes.
  # Normalise those differences so the same inputs give the same inventory.
  if ($PSVersionTable.PSVersion.Major -le 5) {
    $json = (($json -split '\r?\n') | ForEach-Object {
      if ($_ -match '^( +)(.*)$') { (' ' * ($Matches[1].Length / 2)) + $Matches[2] }
      else { $_ }
    }) -join "`n"
    $json = [regex]::Replace($json, '(?m)^(\s*"[^"]+":)  ', '$1 ')
  }
  return $json.Replace('\u003c', '<').Replace('\u003e', '>').Replace('\u0026', '&')
}

# Verify both complete inputs before creating or replacing any output.
foreach ($version in @($artifacts.Keys)) {
  $artifact = (Resolve-Path -LiteralPath $artifacts[$version]).ProviderPath
  $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
  if ($digest -ne $expected[$version]) {
    throw "Unexpected SDK artifact checksum for $version. No inventory was written."
  }
  $artifacts[$version] = $artifact
}
$jarCommand = Find-JdkTool 'jar'
$javapCommand = Find-JdkTool 'javap'
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$results = @()

foreach ($version in $artifacts.Keys) {
  $artifact = $artifacts[$version]
  $cacheRoot = Join-Path $OutputRoot "cache/$version"
  New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
  $classesJar = Join-Path $cacheRoot 'classes.jar'
  $archive = [IO.Compression.ZipFile]::OpenRead($artifact)
  try {
    $metadataEntry = $archive.GetEntry('META-INF/com/android/build/gradle/aar-metadata.properties')
    if ($null -eq $metadataEntry) { throw "SDK $version does not contain AAR build metadata." }
    $metadataReader = New-Object IO.StreamReader($metadataEntry.Open())
    try { $metadataText = $metadataReader.ReadToEnd() }
    finally { $metadataReader.Dispose() }
    $metadata = [ordered]@{}
    foreach ($line in ($metadataText -split '\r?\n')) {
      if ($line -match '^([^#=]+)=(.*)$') { $metadata[$Matches[1]] = $Matches[2] }
    }
    $entry = $archive.GetEntry('classes.jar')
    if ($null -eq $entry) { throw "SDK $version does not contain classes.jar." }
    $inputStream = $entry.Open()
    $outputStream = [IO.File]::Open($classesJar, [IO.FileMode]::Create)
    try { $inputStream.CopyTo($outputStream) }
    finally { $outputStream.Dispose(); $inputStream.Dispose() }
  }
  finally { $archive.Dispose() }

  $entries = & $jarCommand tf $classesJar
  if ($LASTEXITCODE -ne 0) { throw "Could not enumerate SDK classes for $version." }
  [string[]]$classes = @($entries | Where-Object {
    $_ -match '^androidx/health/connect/client/(records|units|request|response|permission|changes|time|aggregate|contracts)/.*\.class$' -or
    $_ -match '^androidx/health/connect/client/(HealthConnectClient|HealthConnectFeatures|PermissionController)\.class$'
  } | Where-Object {
    $_ -cnotmatch '\$(Companion|.*\$|WhenMappings|[0-9]+|DefaultImpls|[a-z])'
  } | ForEach-Object {
    ($_ -replace '\.class$', '') -replace '/', '.'
  })
  [Array]::Sort($classes, [StringComparer]::Ordinal)
  $ordinary = @($classes | Where-Object {
    $_ -match '^androidx\.health\.connect\.client\.records\.[A-Za-z0-9]+Record$' -and
    $_ -notmatch '\.(Record|IntervalRecord|InstantaneousRecord|SeriesRecord)$'
  })
  $api = @(& $javapCommand -public -constants -classpath $classesJar $classes)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect SDK signatures for $version." }
  Write-Utf8 "$version-classes.txt" ($classes -join "`n")
  Write-Utf8 "$version-ordinary-records.txt" ($ordinary -join "`n")
  Write-Utf8 "$version-public-api.txt" ($api -join "`n")

  $getters = @()
  $currentClass = $null
  $publicClassCount = 0
  foreach ($line in $api) {
    if ($line -match '^Compiled from ' -or $line -match '^\}$' -or
        $line -match '^(?:(?:public|protected|private|final|abstract|static) )*(?:class|interface|enum) ') {
      $currentClass = $null
    }
    if ($line -match '^public (?:final |abstract )?(?:class|interface) ([^ <]+)') {
      $currentClass = $Matches[1]
      $publicClassCount++
    }
    if ($null -ne $currentClass -and
        $line -cmatch '^  public (?:final |abstract |default )?([^ ]+(?:<.+>)?) ((?:get|is|has)[A-Z][^ ($]+)\(\);$') {
      $getters += [ordered]@{ class = $currentClass; method = $Matches[2]; type = $Matches[1] }
    }
  }
  $result = [ordered]@{
    version = $version
    sourceUrl = "https://dl.google.com/dl/android/maven2/androidx/health/connect/connect-client/$version/connect-client-$version.aar"
    artifactDigest = 'sha256:' + $expected[$version]
    compiledClassesDigest = 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $classesJar).Hash.ToLowerInvariant()
    aarBuildMetadata = $metadata
    ordinaryRecordCount = $ordinary.Count
    publicApiClassCount = $publicClassCount
    ordinaryRecords = $ordinary
    exposedGetters = $getters
    inventoryCommand = 'javap -public -constants -classpath classes.jar <selected SDK public model/API classes>'
    scope = 'Concrete ordinary records, nested values, metadata, units, route and medical models, request/response/change/aggregate APIs, permissions, feature constants and route contracts. Getters on non-public declaring classes and Kotlin internal/synthetic getters are excluded from the source-field list but retained in raw signatures. Java signatures do not express Kotlin nullability. Runtime availability and implemented serialization remain separate evidence.'
  }
  Write-Utf8 "$version-inventory.json" (ConvertTo-InventoryJson $result)
  $results += $result
}

$stableGetters = @($results[0].exposedGetters | ForEach-Object { "$($_.class)::$($_.method)::$($_.type)" })
$alphaGetters = @($results[1].exposedGetters | ForEach-Object { "$($_.class)::$($_.method)::$($_.type)" })
$comparison = [ordered]@{
  stable = $results[0].version
  alpha = $results[1].version
  addedRecords = @($results[1].ordinaryRecords | Where-Object { $_ -notin $results[0].ordinaryRecords })
  removedRecords = @($results[0].ordinaryRecords | Where-Object { $_ -notin $results[1].ordinaryRecords })
  addedGetters = @($results[1].exposedGetters | Where-Object { "$($_.class)::$($_.method)::$($_.type)" -notin $stableGetters })
  removedGetters = @($results[0].exposedGetters | Where-Object { "$($_.class)::$($_.method)::$($_.type)" -notin $alphaGetters })
}
Write-Utf8 'stable-alpha-comparison.json' (ConvertTo-InventoryJson $comparison)
Write-Output "Inventoried $($results[0].ordinaryRecordCount) stable and $($results[1].ordinaryRecordCount) alpha ordinary record types."
