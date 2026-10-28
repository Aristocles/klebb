# SPDX-License-Identifier: AGPL-3.0-only
param(
  [Parameter(Mandatory = $true)][string]$InventoryRoot
)
$ErrorActionPreference = 'Stop'

# Read complete public declaration blocks independently of the generator's
# running owner state. A package-private block can never supply a public owner.
$publicBlock = '(?m)^public (?:(?:final|abstract) )*(?:class|interface) (?<owner>[^ <\r\n]+)[^{\r\n]*\{\r?\n(?<body>[\s\S]*?)^\}'
$methodLine = '(?m)^  public (?<signature>[^\r\n]+)\(\);\r?$'

foreach ($version in @('1.1.0', '1.2.0-alpha06')) {
  $inventory = Get-Content -LiteralPath (Join-Path $InventoryRoot "$version-inventory.json") -Raw | ConvertFrom-Json
  $api = Get-Content -LiteralPath (Join-Path $InventoryRoot "$version-public-api.txt") -Raw
  $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $owners = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($block in [regex]::Matches($api, $publicBlock)) {
    $owner = $block.Groups['owner'].Value
    if (-not $owners.Add($owner)) { throw "Duplicate public declaration $owner in SDK $version." }
    foreach ($method in [regex]::Matches($block.Groups['body'].Value, $methodLine)) {
      $signature = $method.Groups['signature'].Value
      if ($signature -match '\bstatic\b') { continue }
      $separator = $signature.LastIndexOf(' ')
      if ($separator -lt 0) { continue }
      $name = $signature.Substring($separator + 1)
      if ($name -cnotmatch '^(?:get|is|has)[A-Z][A-Za-z0-9_]*$') { continue }
      $type = $signature.Substring(0, $separator) -replace '^(?:(?:final|abstract|default) )+', ''
      $key = ConvertTo-Json -InputObject @($owner, $name, $type) -Compress
      if (-not $expected.Add($key)) { throw "Duplicate public accessor $owner.$name in SDK $version." }
    }
  }
  if ($owners.Count -eq 0 -or $expected.Count -eq 0) {
    throw "No public class/accessor declarations found in SDK $version."
  }
  $actual = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($field in $inventory.exposedGetters) {
    if ($field.class -isnot [string] -or $field.method -isnot [string] -or $field.type -isnot [string]) {
      throw "Invalid structured accessor identity in SDK $version."
    }
    $key = ConvertTo-Json -InputObject @($field.class, $field.method, $field.type) -Compress
    if (-not $expected.Contains($key)) {
      throw "Accessor is not declared by its public owner: $($field.class).$($field.method) in SDK $version."
    }
    if (-not $actual.Add($key)) { throw "Duplicate structured accessor $($field.class).$($field.method) in SDK $version." }
  }
  if (-not $expected.SetEquals($actual)) {
    throw "Structured accessors omit public declared fields in SDK $version."
  }
  if ($inventory.publicApiClassCount -ne $owners.Count) {
    throw "Incorrect public class count in SDK ${version}: expected $($owners.Count)."
  }
}
Write-Output 'Independent compiled public declaring-owner and class-count checks passed.'
