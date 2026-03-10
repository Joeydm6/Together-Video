# Cloudflare Tunnel Setup voor TogetherVideo

## Voordelen van Cloudflare Tunnel vs ngrok

✅ **Gratis** - Geen limiet op aantal verbindingen  
✅ **Sneller** - Cloudflare's wereldwijde netwerk  
✅ **Veiliger** - Geen inbound firewall rules nodig  
✅ **Betrouwbaarder** - Geen tijdslimiet op tunnels  
✅ **Custom domain** - Gebruik je eigen domein  

## Setup Stappen

### 1. Authenticatie (Eenmalig)
```bash
cloudflared tunnel login
```
Dit opent een browser venster waar je moet inloggen bij Cloudflare.

### 2. Maak een tunnel (Eenmalig)
```bash
cloudflared tunnel create togethervideo
```

### 3. Configureer DNS (Eenmalig)
Vervang `jouw-domein.com` met je eigen domein:
```bash
cloudflared tunnel route dns togethervideo video.jouw-domein.com
```

### 4. Maak config bestand
Maak een bestand `.cloudflared/config.yml` in je home directory:

**Windows**: `C:\Users\YourUsername\.cloudflared\config.yml`

```yaml
url: http://localhost:8000
tunnel: togethervideo
credentials-file: C:\Users\YourUsername\.cloudflared\[tunnel-id].json

ingress:
  - hostname: video.jouw-domein.com
    service: http://localhost:8000
  - service: http_status:404
```

### 5. Test je tunnel
```bash
# Tijdelijke tunnel (voor testen)
npm run tunnel

# Of permanente tunnel met custom domain
npm run tunnel-named
```

## Gebruik

### Voor development (tijdelijke tunnel):
```bash
npm start    # Start de server
npm run tunnel    # Start tijdelijke tunnel (krijgt random URL)
```

### Voor productie (permanente tunnel):
```bash
npm start    # Start de server  
npm run tunnel-named    # Start tunnel met je custom domain
```

## Migratie van ngrok

1. ✅ **package.json is al bijgewerkt**
2. ⚠️ **ngrok.exe kan worden verwijderd** (optioneel)
3. ⚠️ **Update eventuele bookmarks** naar je nieuwe Cloudflare URL

## Troubleshooting

### "tunnel credentials file not found"
Zorg dat je `cloudflared tunnel login` hebt uitgevoerd.

### "hostname already exists"
Gebruik een andere subdomain of verwijder de bestaande route:
```bash
cloudflared tunnel route dns delete video.jouw-domein.com
```

### Verbinding problemen
Check of je server draait op poort 8000:
```bash
npm start
``` 