# SPDX-License-Identifier: AGPL-3.0-only
param(
  [Parameter(Mandatory = $true)][string]$InventoryRoot
)
$ErrorActionPreference = 'Stop'
$prefix = 'androidx.health.connect.client.records.'

# Fixed expectations from the pinned SDK model contracts, independent of the
# inventory generator's class filtering and getter extraction.
$nested = [ordered]@{
  'ExerciseRoute$Location' = [ordered]@{
    getTime = 'java.time.Instant'
    getLatitude = 'double'
    getLongitude = 'double'
    getHorizontalAccuracy = 'androidx.health.connect.client.units.Length'
    getVerticalAccuracy = 'androidx.health.connect.client.units.Length'
    getAltitude = 'androidx.health.connect.client.units.Length'
  }
  'ExerciseRouteResult$Data' = [ordered]@{
    getExerciseRoute = 'androidx.health.connect.client.records.ExerciseRoute'
  }
  'HeartRateRecord$Sample' = [ordered]@{
    getTime = 'java.time.Instant'
    getBeatsPerMinute = 'long'
  }
  'SleepSessionRecord$Stage' = [ordered]@{
    getStartTime = 'java.time.Instant'
    getEndTime = 'java.time.Instant'
    getStage = 'int'
  }
}
$alphaFields = @(
  @('ExerciseSegment', 'getWeight', 'androidx.health.connect.client.units.Mass'),
  @('ExerciseSegment', 'getSetIndex', 'java.lang.Integer'),
  @('ExerciseSegment', 'getRateOfPerceivedExertion', 'java.lang.Float'),
  @('ExerciseSessionRecord', 'getRateOfPerceivedExertion', 'java.lang.Float')
)
$versions = [ordered]@{ '1.1.0' = 41; '1.2.0-alpha06' = 42 }

foreach ($version in $versions.Keys) {
  $inventory = Get-Content -LiteralPath (Join-Path $InventoryRoot "$version-inventory.json") -Raw | ConvertFrom-Json
  $classes = @(Get-Content -LiteralPath (Join-Path $InventoryRoot "$version-classes.txt"))
  if ($inventory.version -cne $version) { throw "Inventory version mismatch for $version." }
  if ($inventory.ordinaryRecordCount -ne $versions[$version] -or
      @($inventory.ordinaryRecords).Count -ne $versions[$version]) {
    throw "Incorrect ordinary record count for $version."
  }
  foreach ($name in @('BodyWaterMassRecord', 'CyclingPedalingCadenceRecord', 'Vo2MaxRecord')) {
    if (($prefix + $name) -cnotin $inventory.ordinaryRecords) {
      throw "Missing required ordinary model $name in SDK $version."
    }
  }
  foreach ($name in $nested.Keys) {
    $className = $prefix + $name
    if ($className -cnotin $classes) {
      throw "Missing required nested model $className in SDK $version."
    }
    $actualFields = @($inventory.exposedGetters | Where-Object { $_.class -ceq $className })
    if ($actualFields.Count -ne $nested[$name].Count) {
      throw "Incorrect nested field count for $className in SDK $version."
    }
    foreach ($method in $nested[$name].Keys) {
      $actual = @($actualFields | Where-Object { $_.method -ceq $method })
      if ($actual.Count -ne 1 -or $actual[0].type -cne $nested[$name][$method]) {
        throw "Incorrect nested signature $className.$method in SDK $version."
      }
    }
  }
  $isAlpha = $version -ceq '1.2.0-alpha06'
  $hasIntensity = ($prefix + 'ActivityIntensityRecord') -cin $inventory.ordinaryRecords
  if ($hasIntensity -ne $isAlpha) {
    throw "Incorrect activity intensity availability in SDK $version."
  }
  foreach ($field in $alphaFields) {
    $className = $prefix + $field[0]
    $actual = @($inventory.exposedGetters | Where-Object { $_.class -ceq $className -and $_.method -ceq $field[1] })
    if ($isAlpha) {
      if ($actual.Count -ne 1 -or $actual[0].type -cne $field[2]) {
        throw "Missing or incorrect alpha signature $className.$($field[1])."
      }
    } elseif ($actual.Count -ne 0) {
      throw "Alpha-only field unexpectedly present in stable SDK: $className.$($field[1])."
    }
  }
}
Write-Output 'Independent ordinary, nested route/sample/stage and alpha exercise inventory checks passed.'
