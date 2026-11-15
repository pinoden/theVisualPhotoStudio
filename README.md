# The Visuals Photo Studio: website

The studio's public site and booking system. The code is in [`web/`](web/): Next.js, TypeScript and PostgreSQL.

## Run it

You need Node.js 22.22 or newer. Nothing else: no database to install and no accounts to create.

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000. Locally the site uses an embedded database and a pretend card processor, and lists emails on a page instead of sending them.

## Read more

- [`web/README.md`](web/README.md): running, testing and the settings for production.
- [`CLAUDE.md`](CLAUDE.md): how the code is organised and, under "Rebuild decisions", what has been decided, what is still open and the known gaps.

The site is not connected to a real card processor, an email service or a host yet.
