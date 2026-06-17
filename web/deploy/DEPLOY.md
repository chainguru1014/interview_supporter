# Deploy: https://interview.innosynch.com

Goal: serve the app at **https://interview.innosynch.com**, reverse-proxied to
the Node app running on `127.0.0.1:3002` (via pm2), with a free Let's Encrypt
TLS certificate.

## Prerequisites (already done / check these)

- [x] DNS **A record** for `interview.innosynch.com` -> your server IP.
- [ ] **Ports 80 and 443 open** to the internet (OS firewall *and* your cloud
      provider's security group). certbot needs port 80 to validate the domain.
- [ ] The app is running on port 3002:
      ```bash
      pm2 start npm --name interview-supporter -- run web   # if not already
      pm2 status
      curl http://localhost:3002/api/meta                   # -> {"passwordRequired":true,...}
      ```

## One-time setup (run on the server)

```bash
# 1. Get the latest code (includes this nginx config)
cd ~/interview_supporter && git pull

# 2. Install nginx + certbot if you don't have them
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx

# 3. Install the site config (copy from the repo, then enable it)
sudo cp web/deploy/nginx/interview.innosynch.com.conf /etc/nginx/sites-available/interview.innosynch.com
sudo ln -sf /etc/nginx/sites-available/interview.innosynch.com /etc/nginx/sites-enabled/

# 4. Test the config and reload nginx
sudo nginx -t && sudo systemctl reload nginx

# 5. Get the TLS certificate (certbot edits the config to add HTTPS + redirect)
sudo certbot --nginx -d interview.innosynch.com
#    - Enter an email, agree to the terms.
#    - When asked about redirecting HTTP to HTTPS, choose "Redirect" (option 2).
```

That's it. Open **https://interview.innosynch.com** — the login page should load
over HTTPS with no warnings. Enter your access password and use the app.

## Open the firewall ports (if using ufw)

```bash
sudo ufw allow 'Nginx Full'   # opens 80 + 443
sudo ufw status
```
> Also open 80 and 443 in your cloud provider's security group/firewall.

## Lock down the raw app port (recommended)

Once nginx works, the app only needs to be reachable from nginx on localhost, so
you can stop exposing 3002 directly:
```bash
sudo ufw deny 3002          # (and/or remove 3002 from the cloud security group)
```
The app keeps working because nginx talks to it on `127.0.0.1:3002`.

## Certificate renewal

certbot installs a systemd timer that auto-renews. Verify it works:
```bash
sudo certbot renew --dry-run
```

## Updating the app later

```bash
cd ~/interview_supporter
git pull
npm install            # only if dependencies changed
pm2 restart interview-supporter
```

## Additional domains: admin (3000) and dpp (3001)

These proxy to your **other existing projects** (not this app):
`admin.innosynch.com` -> port 3000, `dpp.innosynch.com` -> port 3001.

**Prerequisite:** add DNS **A records** for `admin.innosynch.com` and
`dpp.innosynch.com` pointing to the same server IP (just like `interview`).
Without them certbot can't validate the domains.

```bash
cd ~/interview_supporter && git pull

# (once) enable WebSocket support used by the admin/dpp configs
sudo cp web/deploy/nginx/websocket-map.conf /etc/nginx/conf.d/websocket-map.conf
#  ^ If `nginx -t` below complains that $connection_upgrade is already defined,
#    you already have this map — remove the file: sudo rm /etc/nginx/conf.d/websocket-map.conf

# install the two site configs
sudo cp web/deploy/nginx/admin.innosynch.com.conf /etc/nginx/sites-available/admin.innosynch.com
sudo cp web/deploy/nginx/dpp.innosynch.com.conf   /etc/nginx/sites-available/dpp.innosynch.com
sudo ln -sf /etc/nginx/sites-available/admin.innosynch.com /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/dpp.innosynch.com   /etc/nginx/sites-enabled/

# test + reload, then get certs for both at once
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d admin.innosynch.com -d dpp.innosynch.com
```

Result: **https://admin.innosynch.com** (3000) and **https://dpp.innosynch.com**
(3001) both work over HTTPS. Make sure those two apps are actually running and
listening on 3000/3001 (`curl http://localhost:3000` / `:3001` should respond),
otherwise you'll get a 502.

## API over HTTPS: api.innosynch.com (port 5052) — fixes the admin mixed-content/CORS error

The admin frontend is served over HTTPS, so it **cannot** call `http://<ip>:5052`
(browsers block HTTPS->HTTP "mixed content"). Expose the API over HTTPS instead
and point the frontend at it.

**Prerequisite:** add a DNS **A record** `api.innosynch.com` -> your server IP.

```bash
cd ~/interview_supporter && git pull
sudo cp web/deploy/nginx/api.innosynch.com.conf /etc/nginx/sites-available/api.innosynch.com
sudo ln -sf /etc/nginx/sites-available/api.innosynch.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.innosynch.com
```

Then rebuild the **admin frontend** to call the new URL. Find the env var name:
```bash
# in the admin project directory:
grep -rn "5052\|REACT_APP" .env* src/ 2>/dev/null
```
Set it (e.g. in the admin project's `.env`):
```
REACT_APP_API_URL=https://api.innosynch.com
```
Rebuild and redeploy the admin app (`npm run build`, or restart its dev server),
so the new API URL is baked in. Verify:
```bash
curl https://api.innosynch.com/user/login -i   # should reach the backend (not blocked)
```

> If you see a CORS error mentioning **multiple values** for
> `Access-Control-Allow-Origin`, your backend already sets CORS headers — this
> config strips them with `proxy_hide_header`, but double-check the backend
> isn't adding the header *after* a redirect. If a different admin origin needs
> access, add another `if ($http_origin = "https://other.example") { ... }` line.

## Troubleshooting

| Symptom | Fix |
|---|---|
| certbot fails: "challenge failed" / timeout | Port 80 not open, or DNS not propagated. Check `dig interview.innosynch.com` points to your IP, and that 80 is open in the cloud firewall. |
| 502 Bad Gateway | The app isn't running on 3002. `pm2 status`, `pm2 logs interview-supporter`, `curl http://localhost:3002/api/meta`. |
| Page loads but answers don't stream live | `proxy_buffering off;` missing — make sure you used this repo's config. |
| Mic/screen "Start" does nothing | Must be on **https://** (you are now) and grant the browser permission prompt. |
| `nginx -t` fails: duplicate default server | Another site already claims `default_server` — harmless here since we match by `server_name`. |
