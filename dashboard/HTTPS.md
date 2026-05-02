# Dashboard HTTPS Hardening

How to flip the cortextOS dashboard from HTTP-over-Tailscale to HTTPS-with-Tailscale-certs. Operator runbook for the 5 steps in chiefjarvis's Task 3 dispatch (2026-05-01).

## Why

Today the dashboard runs HTTP. WireGuard at the network layer encrypts traffic between Tailscale peers, but cookies (incl. the `authjs.session-token`) flow with `secure: false`. That's fine for a single-machine localhost-only deploy, but with multiple devices on the tailnet hitting the dashboard via MagicDNS, real TLS at the application layer is the correct posture.

## What changed in the codebase (commits, ready to apply)

1. **`dashboard/server.js`** (new). Custom Node server that wraps Next.js. Reads `HTTPS_CERT_PATH` + `HTTPS_KEY_PATH` from env; if both set, listens HTTPS via `https.createServer` with the cert files. Falls back to HTTP if not set.
2. **`dashboard/package.json`** scripts:
   - `dev` is now `node server.js` (was `next dev`). Hot-reload still works because the server passes `dev: true` to `next()`.
   - `start` is now `NODE_ENV=production node server.js` (was `next start`).
   - `dev:next` and `start:next` preserved as escape hatches if you need stock Next behavior.
3. **`dashboard/src/lib/auth.ts`** session config:
   - `session.maxAge` now `parseInt(process.env.SESSION_MAX_AGE_SECONDS ?? '86400', 10)` — default 24h, tunable via env.
   - `secure` flag on cookies remains driven by `SECURE_COOKIES === 'true'` (already in place; you flip it after HTTPS is verified).

No changes to `ecosystem.config.js`. No PM2 restart triggered. No git push.

## Operator runbook (apply in order)

### 1. Provision the Tailscale cert

The Mac Tailscale app ships its CLI inside the .app bundle. From an interactive shell:

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
HOSTNAME="jarviss-mac-mini.tailcc4312.ts.net"   # Blake's MagicDNS name as of 2026-05-01
cd ~/cortextos/dashboard/certs/   # create this dir first; gitignored already
"$TS" cert "$HOSTNAME"
ls -la                                          # should see <hostname>.crt + <hostname>.key
```

Notes:
- First run prompts the tailnet admin to enable HTTPS + DNS challenges if not already on. Free tier supports it.
- Cert is valid 90 days. Renewal is `tailscale cert <hostname>` again — it overwrites in place. Worth a recurring cron at 60-day cadence.
- Cert files MUST live under a path the dashboard process can read at startup. `dashboard/certs/` is conventional and already gitignored by `.gitignore` line 13 (`orgs/`) — wait, that's orgs only. Add `dashboard/certs/` to `.gitignore` BEFORE running `tailscale cert` if it isn't already; we don't want certs in git.

### 2. Wire the env vars

Edit `dashboard/.env.local`:

```bash
# After running `tailscale cert ...` in dashboard/certs/
HTTPS_CERT_PATH=/Users/jarvis/cortextos/dashboard/certs/jarviss-mac-mini.tailcc4312.ts.net.crt
HTTPS_KEY_PATH=/Users/jarvis/cortextos/dashboard/certs/jarviss-mac-mini.tailcc4312.ts.net.key

# Optional: tune session lifetime (default 24h)
SESSION_MAX_AGE_SECONDS=86400
```

Do NOT flip `SECURE_COOKIES=true` yet — see step 4.

### 3. Restart the dashboard PM2 process

```bash
pm2 restart cortextos-dashboard
pm2 logs cortextos-dashboard --lines 20
```

Expected log line: `> Dashboard ready on https://0.0.0.0:3000 [Tailscale TLS]`

If the cert files fail to read, the server logs an explicit error and falls back to HTTP — the dashboard stays accessible while you fix the paths.

### 4. Smoke test from Tailscale

From any Tailscale peer (incl. the same Mac):
```bash
curl -v https://jarviss-mac-mini.tailcc4312.ts.net:3000/api/health
```

Should:
- TLS handshake succeed (Tailscale-issued cert valid)
- HTTP 200 with whatever the health route returns

Try the same in a browser. Expect a green padlock and no certificate warning.

If both work, **then** flip:
```bash
# In dashboard/.env.local
SECURE_COOKIES=true
```

And restart PM2 once more. The session cookie will now carry `Secure` flag, browser-enforced.

### 5. Verify the dashboard is functional under HTTPS

- Login flow works
- Logout works
- Session persists across reloads
- Navigation between pages doesn't bounce back to login

If anything breaks, set `SECURE_COOKIES=false`, restart, and report the symptom.

## Renewal cron (optional, recommended)

`tailscale cert` rotates 90-day certs. Add a monthly renewal cron:

```bash
# In some agent's config.json crons array (analyst is fine)
{
  "name": "renew-tailscale-cert",
  "type": "recurring",
  "cron": "23 4 1 * *",
  "prompt": "Renew the dashboard Tailscale cert: cd ~/cortextos/dashboard/certs && /Applications/Tailscale.app/Contents/MacOS/Tailscale cert jarviss-mac-mini.tailcc4312.ts.net && pm2 restart cortextos-dashboard. Then record this fire: cortextos bus update-cron-fire renew-tailscale-cert --interval 30d"
}
```

(Hostname goes hardcoded into the prompt — single source of truth.)

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `EACCES: cannot read cert file` | cert files have restricted perms | `chmod 600 <hostname>.key && chmod 644 <hostname>.crt`; ensure dashboard process owner can read |
| Cert chain incomplete | Tailscale didn't include the issuing chain | Re-run `tailscale cert <hostname>` |
| `secure cookie blocked` errors after step 4 | mixed-content (some asset on http://) | Verify `NEXTAUTH_URL` in .env.local is `https://...` |
| Session bounces back to login on reload | `SECURE_COOKIES=true` set but TLS handshake actually failed | Logs will show HTTP fallback — fix cert path |
| HTTP fallback warning in logs | server.js could not load cert/key | Re-check `HTTPS_CERT_PATH` and `HTTPS_KEY_PATH` paths and permissions |

## Reverting

If anything goes wrong:

```bash
# In dashboard/.env.local
unset HTTPS_CERT_PATH HTTPS_KEY_PATH SECURE_COOKIES
pm2 restart cortextos-dashboard
```

`server.js` falls back to HTTP automatically when the env vars are absent. No code revert needed.

## What this DOESN'T do

- Doesn't auto-provision the cert. `tailscale cert <hostname>` is operator-driven; agents don't run it (privileged, infrequent).
- Doesn't redirect HTTP→HTTPS. `server.js` listens on a single port; if you want both with redirect, add a second `http.createServer` on a different port that 301s to the HTTPS URL.
- Doesn't auto-renew. The optional cron above does; without it, the cert expires after 90 days and HTTPS handshake starts failing.
