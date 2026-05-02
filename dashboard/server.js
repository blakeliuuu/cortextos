// Custom Next.js server for cortextOS dashboard.
//
// Why this exists:
//   `next dev` and `next start` only listen on HTTP. To serve HTTPS over
//   Tailscale's MagicDNS hostname (e.g. <machine>.<tailnet>.ts.net), we
//   need a custom server that wraps Next.js with Node's https module and
//   loads cert files from disk.
//
// Behavior:
//   - If HTTPS_CERT_PATH and HTTPS_KEY_PATH are both set in the env, the
//     server starts in HTTPS mode using those files.
//   - Otherwise, it falls back to plain HTTP (the historical default).
//
// Cert provisioning (operator one-time setup):
//   /Applications/Tailscale.app/Contents/MacOS/Tailscale cert <hostname>
//   # writes <hostname>.crt and <hostname>.key into the working directory.
//   # Then set HTTPS_CERT_PATH / HTTPS_KEY_PATH in dashboard/.env.local
//   # and restart the dashboard PM2 process.
//
// See ./HTTPS.md for the full deployment runbook.

const { readFileSync } = require('fs');
const { createServer: createHttpServer } = require('http');
const { createServer: createHttpsServer } = require('https');
const { parse } = require('url');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);
const certPath = process.env.HTTPS_CERT_PATH;
const keyPath = process.env.HTTPS_KEY_PATH;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const handler = (req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  };

  const useHttps = certPath && keyPath;

  if (useHttps) {
    let httpsOptions;
    try {
      httpsOptions = {
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
      };
    } catch (err) {
      console.error(`> dashboard: failed to read cert/key (HTTPS_CERT_PATH=${certPath}, HTTPS_KEY_PATH=${keyPath}): ${err.message}`);
      console.error('> dashboard: falling back to HTTP — fix the cert paths and restart for HTTPS.');
      createHttpServer(handler).listen(port, hostname, () => {
        console.log(`> Dashboard ready on http://${hostname}:${port} [HTTP fallback after cert load failure]`);
      });
      return;
    }
    createHttpsServer(httpsOptions, handler).listen(port, hostname, () => {
      console.log(`> Dashboard ready on https://${hostname}:${port} [Tailscale TLS]`);
    });
  } else {
    createHttpServer(handler).listen(port, hostname, () => {
      console.log(`> Dashboard ready on http://${hostname}:${port} [HTTP — set HTTPS_CERT_PATH + HTTPS_KEY_PATH in .env.local for TLS]`);
    });
  }
}).catch((err) => {
  console.error('> dashboard: app.prepare() failed:', err);
  process.exit(1);
});
