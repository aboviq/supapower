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
        'Offline-first on Supabase without a sync service: a local PGlite database, two-way sync through the Data API and Realtime, and your RLS policies as the sync rules.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/aboviq/supapower' }],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
      },
      sidebar: [
        { label: 'Why Supapower', link: '/why-supapower/' },
        { label: 'Comparison', link: '/comparison/' },
        { label: 'Packages', items: [{ autogenerate: { directory: 'packages' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Examples', link: '/examples/' },
      ],
    }),
  ],
});
