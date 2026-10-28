# SPDX-License-Identifier: AGPL-3.0-only
$ErrorActionPreference = 'Stop'
$checker = Join-Path $PSScriptRoot 'check-inventory-ownership.ps1'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('health-sdk-ownership-' + [guid]::NewGuid().ToString('N'))
$utf8 = New-Object System.Text.UTF8Encoding($false)
$api = @'
Compiled from "PublicBefore.java"
public final class example.PublicBefore {
  public final double getValue();
  public boolean hasMore();
  public static int getSharedCount();
}
Compiled from "Hidden.java"
abstract class example.Hidden {
  public abstract double getPrivateScale();
}
Compiled from "PublicAfter.java"
public final class example.PublicAfter {
  public final java.lang.String getName();
}
'@
$fields = @(
  [ordered]@{ class = 'example.PublicBefore'; method = 'getValue'; type = 'double' },
  [ordered]@{ class = 'example.PublicBefore'; method = 'hasMore'; type = 'boolean' },
  [ordered]@{ class = 'example.PublicAfter'; method = 'getName'; type = 'java.lang.String' }
)
$cases = @(
  [ordered]@{ name = 'public-owner'; accepted = $true; fields = $fields; classCount = 2 },
  [ordered]@{ name = 'public-owner-crlf'; accepted = $true; fields = $fields; classCount = 2; crlf = $true },
  [ordered]@{ name = 'predecessor-owner-leak'; accepted = $false; fields = ($fields + @(
    [ordered]@{ class = 'example.PublicBefore'; method = 'getPrivateScale'; type = 'double' }
  )); classCount = 2; failure = 'Accessor is not declared by its public owner:' },
  [ordered]@{ name = 'non-public-owner'; accepted = $false; fields = ($fields + @(
    [ordered]@{ class = 'example.Hidden'; method = 'getPrivateScale'; type = 'double' }
  )); classCount = 2; failure = 'Accessor is not declared by its public owner:' },
  [ordered]@{ name = 'wrong-public-owner'; accepted = $false; fields = @(
    $fields[0], $fields[1],
    [ordered]@{ class = 'example.PublicBefore'; method = 'getName'; type = 'java.lang.String' }
  ); classCount = 2; failure = 'Accessor is not declared by its public owner:' },
  [ordered]@{ name = 'static-accessor'; accepted = $false; fields = ($fields + @(
    [ordered]@{ class = 'example.PublicBefore'; method = 'getSharedCount'; type = 'int' }
  )); classCount = 2; failure = 'Accessor is not declared by its public owner:' },
  [ordered]@{ name = 'missing-public-field'; accepted = $false; fields = @($fields[0], $fields[2]); classCount = 2;
    failure = 'Structured accessors omit public declared fields' },
  [ordered]@{ name = 'duplicate-public-field'; accepted = $false; fields = ($fields + @($fields[0])); classCount = 2;
    failure = 'Duplicate structured accessor' },
  [ordered]@{ name = 'selected-class-count'; accepted = $false; fields = $fields; classCount = 3;
    failure = 'Incorrect public class count' }
)
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
  foreach ($case in $cases) {
    $affectedVersions = @('1.1.0', '1.2.0-alpha06')
    if ($case.accepted) { $affectedVersions = @('both') }
    foreach ($affected in $affectedVersions) {
      $caseRoot = Join-Path $fixtureRoot ($case.name + '-' + $affected)
      New-Item -ItemType Directory -Path $caseRoot | Out-Null
      foreach ($version in @('1.1.0', '1.2.0-alpha06')) {
        $raw = ($api -replace "`r`n", "`n") + "`n"
        if ($case.crlf) { $raw = $raw -replace "`n", "`r`n" }
        [IO.File]::WriteAllText((Join-Path $caseRoot "$version-public-api.txt"), $raw, $utf8)
        $selectedFields = $fields
        $selectedCount = 2
        if ($case.accepted -or $version -ceq $affected) {
          $selectedFields = $case.fields
          $selectedCount = $case.classCount
        }
        $inventory = [ordered]@{ exposedGetters = @($selectedFields); publicApiClassCount = $selectedCount }
        [IO.File]::WriteAllText((Join-Path $caseRoot "$version-inventory.json"), (ConvertTo-Json -InputObject $inventory -Depth 5), $utf8)
      }
      $accepted = $true
      $failure = ''
      try { & $checker -InventoryRoot $caseRoot | Out-Null }
      catch { $accepted = $false; $failure = $_.Exception.Message }
      if ($accepted -ne $case.accepted -or
          (-not $accepted -and -not $failure.StartsWith($case.failure, [StringComparison]::Ordinal))) {
        throw "Incorrect independent ownership fixture outcome: $($case.name) for $affected. $failure"
      }
      Write-Output "Ownership fixture passed: $($case.name) for $affected"
    }
  }
}
finally {
  $absoluteRoot = [IO.Path]::GetFullPath($fixtureRoot)
  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (-not $absoluteRoot.StartsWith($temporaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($absoluteRoot) -notmatch '^health-sdk-ownership-[a-f0-9]{32}$') {
    throw 'Refusing to remove an unexpected ownership fixture directory.'
  }
  Remove-Item -LiteralPath $absoluteRoot -Recurse -Force
}
