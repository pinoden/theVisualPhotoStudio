// The browser tests' server for a production build (`E2E_BUILD=1`, playwright.config.ts): what `next build` made,
// served by Next.js's own request handler over HTTPS, as the host serves the site. Over plain http WebKit keeps no
// Secure cookie, and a production build makes the session's cookie and the page preview's Secure.
//
// The certificate is made for the run, in TLS_DIR, before this starts: the server asks itself for pages too (the page
// a server action sends the browser to), and Node trusts the certificate for that only when NODE_EXTRA_CA_CERTS names
// it at start. The tests' browsers are told to accept it.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import next from "next";

const port = Number(process.env.PORT);
const folder = process.env.TLS_DIR;
if (!Number.isInteger(port) || port <= 0 || !folder) throw new Error("Set PORT and TLS_DIR, as playwright.config.ts does.");
const tls = { key: readFileSync(join(folder, "key.pem")), cert: readFileSync(join(folder, "cert.pem")) };

const app = next({ dev: false, hostname: "localhost", port });
const handle = app.getRequestHandler();
await app.prepare();
createServer(tls, (request, response) => handle(request, response)).listen(port, "localhost", () => {
  console.log(`> The production build answers at https://localhost:${port}`);
});
