import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // TODO: Update this URL before deployment. Use your GitHub Pages URL
  // (e.g. https://hakkisagdic.github.io/keyflip) or Cloudflare Pages subdomain
  // (e.g. https://keyflip.pages.dev). This placeholder is used for sitemap
  // generation and og:url meta tags.
  site: 'https://keyflip.dev',
  output: 'static',
  vite: {
    plugins: [tailwindcss()]
  },
  integrations: [
    sitemap()
  ],
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'tr'],
    routing: {
      prefixDefaultLocale: false
    }
  }
});
