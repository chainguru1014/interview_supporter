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

## Troubleshooting

| Symptom | Fix |
|---|---|
| certbot fails: "challenge failed" / timeout | Port 80 not open, or DNS not propagated. Check `dig interview.innosynch.com` points to your IP, and that 80 is open in the cloud firewall. |
| 502 Bad Gateway | The app isn't running on 3002. `pm2 status`, `pm2 logs interview-supporter`, `curl http://localhost:3002/api/meta`. |
| Page loads but answers don't stream live | `proxy_buffering off;` missing — make sure you used this repo's config. |
| Mic/screen "Start" does nothing | Must be on **https://** (you are now) and grant the browser permission prompt. |
| `nginx -t` fails: duplicate default server | Another site already claims `default_server` — harmless here since we match by `server_name`. |
