# keyflip Website

The marketing and documentation site for [keyflip](https://github.com/hakkisagdic/keyflip) - a multi-account switcher CLI for Claude Code and other AI tools.

Built with [Astro](https://astro.build) as a static site with full bilingual (EN/TR) support.

---

## Development

### Prerequisites

- Node.js >= 18
- npm

### Commands

```bash
# Install dependencies
npm install

# Start the dev server (http://localhost:4321)
npm run dev

# Build for production
npm run build

# Preview the production build locally
npm run preview
```

---

## Directory Structure

```
website/
├── astro.config.mjs      # Astro configuration (i18n, sitemap, Tailwind)
├── package.json
├── tsconfig.json
├── public/               # Static assets (copied as-is to dist/)
├── src/
│   ├── components/       # Reusable Astro components
│   │   ├── CodeBlock.astro
│   │   ├── CommandReference.astro
│   │   ├── DarkModeToggle.astro
│   │   ├── FeatureCard.astro
│   │   ├── Footer.astro
│   │   ├── Header.astro
│   │   ├── Hero.astro
│   │   └── PageHeader.astro
│   ├── i18n/
│   │   └── index.ts      # Translation strings for EN and TR
│   ├── layouts/
│   │   └── BaseLayout.astro
│   ├── pages/            # File-based routing
│   │   ├── index.astro           # EN homepage
│   │   ├── 404.astro
│   │   ├── architecture.astro
│   │   ├── faq.astro
│   │   ├── features.astro
│   │   ├── pricing.astro
│   │   ├── use-cases.astro
│   │   ├── docs/                 # EN documentation pages
│   │   │   ├── index.astro
│   │   │   ├── cli-reference.astro
│   │   │   ├── fleet.astro
│   │   │   ├── installation.astro
│   │   │   ├── mcp.astro
│   │   │   ├── providers.astro
│   │   │   ├── sessions.astro
│   │   │   └── usage.astro
│   │   └── tr/                   # Turkish locale (mirrors EN)
│   │       ├── index.astro
│   │       ├── architecture.astro
│   │       ├── faq.astro
│   │       ├── features.astro
│   │       ├── pricing.astro
│   │       ├── use-cases.astro
│   │       └── docs/
│   │           └── ...
│   └── styles/
│       └── global.css    # Global styles + Tailwind imports
└── dist/                 # Build output (git-ignored)
```

---

## Adding & Editing Content

### Pages

Each page is an `.astro` file in `src/pages/`. The directory structure maps directly to URL paths:

- `src/pages/index.astro` -> `/`
- `src/pages/features.astro` -> `/features`
- `src/pages/docs/installation.astro` -> `/docs/installation`
- `src/pages/tr/index.astro` -> `/tr`

### Turkish translations

Turkish pages live under `src/pages/tr/` and mirror the English structure. Shared UI strings are in `src/i18n/index.ts`.

### Components

Reusable UI pieces are in `src/components/`. Import them into any page:

```astro
---
import FeatureCard from '../components/FeatureCard.astro';
---

<FeatureCard title="Fast switching" description="..." />
```

### Styling

The project uses Tailwind CSS v4 (via the Vite plugin). Global styles live in `src/styles/global.css`.

---

## Deployment

The site builds to a fully static `dist/` directory that can be deployed to any static hosting provider.

### GitHub Pages

1. In your repo settings, go to **Settings > Pages**.
2. Set the source to **GitHub Actions**.
3. Create `.github/workflows/deploy-website.yml`:

```yaml
name: Deploy Website

on:
  push:
    branches: [main]
    paths: ['website/**']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: website/package-lock.json
      - run: npm ci
        working-directory: website
      - run: npm run build
        working-directory: website
      - uses: actions/upload-pages-artifact@v3
        with:
          path: website/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

4. Update `site` in `astro.config.mjs` to match your GitHub Pages URL (e.g., `https://hakkisagdic.github.io/keyflip`).

### Cloudflare Pages

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com/) and go to **Workers & Pages**.
2. Click **Create application > Pages > Connect to Git**.
3. Select the repository and configure:
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `website`
4. Deploy. Cloudflare will assign a `*.pages.dev` subdomain automatically.
5. Optionally, add a custom domain (e.g., `keyflip.dev`) from the Pages project settings.
6. Update `site` in `astro.config.mjs` to your production URL.

### General static hosting

For any static host (Vercel, Netlify, S3, etc.):

1. Build: `cd website && npm run build`
2. Upload the contents of `website/dist/` to your host.
3. Ensure your host serves `404.html` for missing routes (Astro generates it automatically).

---

## Tech Stack

- **[Astro](https://astro.build)** - Static site generator with zero JS by default
- **[Tailwind CSS v4](https://tailwindcss.com)** - Utility-first CSS via the Vite plugin
- **[@astrojs/sitemap](https://docs.astro.build/en/guides/integrations-guide/sitemap/)** - Auto-generated sitemap.xml
- **TypeScript** - Type-safe i18n and configuration

---

## Monorepo Notes

This website lives inside the keyflip monorepo at `/website`. It has its own `package.json` and `node_modules` - fully independent from the root CLI project. Run all `npm` commands from within the `website/` directory.
