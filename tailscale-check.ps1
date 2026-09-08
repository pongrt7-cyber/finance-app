$ip = (tailscale ip -4 2>$null | Select-Object -First 1)
if (-not $ip) { $ip = 'Tailscale ไม่พบหรือยังไม่ได้ติดตั้ง/เชื่อมต่อ' }
Write-Output "TAILSCALE_IP=$ip"
try {
  $rule = Get-NetFirewallRule -DisplayName 'Finance App 3000' -ErrorAction SilentlyContinue
  if (-not $rule) {
    New-NetFirewallRule -DisplayName 'Finance App 3000' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private -ErrorAction Stop | Out-Null
    Write-Output 'FIREWALL=created'
  } else {
    Write-Output 'FIREWALL=exists'
  }
} catch {
  Write-Output 'FIREWALL=needs-admin'
}
