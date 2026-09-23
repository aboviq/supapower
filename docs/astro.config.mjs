import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightThemeRapide from 'starlight-theme-rapide';

export default defineConfig({
  site: 'https://supapower.dev',
  integrations: [
    starlight({
      plugins: [starlightThemeRapide()],
      title: 'Supapower',
      description:
        'A sync engine that keeps a local PGlite database in sync with Supabase, so an application can read and write locally and stay usable while offline.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/aboviq/supapower' }],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
      },
      sidebar: [
        { label: 'Packages', items: [{ autogenerate: { directory: 'packages' } }] },
        { label: 'Examples', link: '/examples/' },
      ],
    }),
  ],
});
