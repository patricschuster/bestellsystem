$Url = "http://192.168.10.220:3000"
$Clients = 6
$ItemsMin = 4
$ItemsMax = 12
$IntervalMin = 120
$IntervalMax = 360

$products = @((Invoke-RestMethod "$Url/api/products") | Where-Object { $_.active })
$tables   = @((Invoke-RestMethod "$Url/api/tables")   | Where-Object { $_.name -ne 'POS' })
$productIds = @($products | ForEach-Object { $_.id })
$tableIds   = @($tables   | ForEach-Object { $_.id })

Write-Host ("Browser-Sim Start: {0} Clients, {1} Produkte, {2} Tische, Items {3}-{4}, Intervall {5}-{6}s" -f $Clients, $productIds.Count, $tableIds.Count, $ItemsMin, $ItemsMax, $IntervalMin, $IntervalMax)

$jobs = 1..$Clients | ForEach-Object {
  $id = $_
  Start-Job -Name "browsersim$id" -ScriptBlock {
    param($id, $Url, $productIds, $tableIds, $itemsMin, $itemsMax, $intMin, $intMax)
    Start-Sleep -Seconds (Get-Random -Minimum 0 -Maximum $intMax)
    while ($true) {
      try {
        $n = Get-Random -Minimum $itemsMin -Maximum ($itemsMax+1)
        $items = @()
        1..$n | ForEach-Object { $items += ($productIds | Get-Random) }
        $body = @{
          table_id = ($tableIds | Get-Random)
          waiter   = "SIM_Browser_$id"
          items    = $items
        } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$Url/api/orders" -Method Post -ContentType "application/json" -Body $body -ErrorAction SilentlyContinue | Out-Null
      } catch {}
      Start-Sleep -Seconds (Get-Random -Minimum $intMin -Maximum ($intMax+1))
    }
  } -ArgumentList $id, $Url, $productIds, $tableIds, $ItemsMin, $ItemsMax, $IntervalMin, $IntervalMax
}

Write-Host ("{0} Jobs gestartet" -f $jobs.Count)
while ($true) { Start-Sleep -Seconds 30 }
