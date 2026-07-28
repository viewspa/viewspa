# SANDBOX-ONLY: делает наши услуги bookable через уже-рабочего Sandbox Seller,
# добавляя его в team_member_ids каждой вариации. На проде не используется.

$ErrorActionPreference = 'Stop'
$T = 'EAAAl0uKB8ljr7dQpU1ulu8HcIGgWQRiiIHv0yjPLVtYUxjJ7AK6l2-wxaWfTon-'
$B = 'https://connect.squareupsandbox.com'
$V = '2025-10-16'
$SELLER = 'TMgzWe0_VxOCZy1k'
$headers = @{ 'Authorization' = "Bearer $T"; 'Square-Version' = $V; 'Content-Type' = 'application/json' }

$variationIds = @(
  'QGH37JSLCZDKTMC6A3NFZ2DO','B7JFFHXFG2BNUD4FLNOUVMUU','LPXMFL6XKBCLPP5EUYEERV4E',
  'VJPP3LIBR3NQB3GJN5F6OTKE','UAFSFUYC3K36EQXXLFXWT7ON','4BXURXW22X3AR7EATUAIHJYO',
  'U4NFRLYJVAJYTVRV6H3URFWL','5SPAUUQWJADUQISTTDFUEXZX','GCDP2V4X4OEOFWYAKY6DPEG7',
  'BBY5D4HMKV7MLXKAS7NASDBM','GBUTBA56U2FAEKDOGPUVSFFP','CAVWBSBQHB4FLFMD7CZK3EMW',
  'CRG7U25LFNY7EZ35QMWNLWBZ','BT4YDJV7QZY2PYTZ44RQN2ZJ','3ZW2O6E6GZXC42ZJ4ZW674FL',
  'O6YGEZNNREBVFV3JRW6HMUOM','6ZOEGXO2S7K3VRQETUS5IDAA','G723BJNIYKX7KSN6DOLDHE4H'
)

# 1) Забираем актуальные объекты (с версиями)
$retrieveBody = @{ object_ids = $variationIds } | ConvertTo-Json
$retrieved = Invoke-RestMethod -Method Post -Uri "$B/v2/catalog/batch-retrieve" -Headers $headers -Body $retrieveBody

# 2) Добавляем продавца в team_member_ids
$objects = @()
foreach ($obj in $retrieved.objects) {
  $tm = @($obj.item_variation_data.team_member_ids)
  if ($tm -notcontains $SELLER) { $tm += $SELLER }
  $obj.item_variation_data.team_member_ids = $tm
  $objects += $obj
}

# 3) Batch-upsert обратно
$upsertBody = @{
  idempotency_key = [guid]::NewGuid().ToString()
  batches = @(@{ objects = $objects })
} | ConvertTo-Json -Depth 30
$res = Invoke-RestMethod -Method Post -Uri "$B/v2/catalog/batch-upsert" -Headers $headers -Body $upsertBody
Write-Output ("Updated objects: " + $res.objects.Count)
