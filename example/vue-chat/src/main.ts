import { createClient } from '@supabase/supabase-js';
import { createApp } from 'vue';

import App from './App.vue';
import { pg } from './pglite.ts';

// oxlint-disable-next-line import/no-unassigned-import -- a global stylesheet has no binding to import.
import './style.css';

const root = document.querySelector('#app');

if (!root) {
  throw new Error('Missing the #app element in index.html');
}

const supabaseUrl = String(import.meta.env['VITE_SUPABASE_URL'] ?? '');
const supabaseKey = String(import.meta.env['VITE_SUPABASE_KEY'] ?? '');

if (supabaseUrl && supabaseKey) {
  const sync = await pg.supapower.sync({
    supabase: createClient(supabaseUrl, supabaseKey),
    // `access: 'anon'` because this demo has no sign in flow - see the README
    // for the Row Level Security policies that make that safe to try out.
    tables: [{ table: 'messages', access: 'anon' }],
  });

  createApp(App, { leadership: sync.leadership }).mount(root);
} else {
  root.textContent =
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_KEY. Copy .env.example to .env in example/vue-chat, fill them in, then restart the dev server.';
}
