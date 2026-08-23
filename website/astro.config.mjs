import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://hakkisagdic.github.io/keyflip',
  base: '/keyflip',
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
