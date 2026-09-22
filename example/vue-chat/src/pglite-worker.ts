import { IdbFs, PGlite } from '@electric-sql/pglite';

import { worker } from '@supapower/worker/worker';

import { MESSAGES_TABLE_SQL } from './schema.ts';

worker({
  async init() {
    const pg = new PGlite({
      fs: new IdbFs('supapower-vue-chat'),
      relaxedDurability: true,
    });

    // Runs once, whichever transport (SharedWorker or PGlite's dedicated
    // worker fallback) ends up hosting the database, before any tab is
    // served a query.
    await pg.exec(MESSAGES_TABLE_SQL);

    return pg;
  },
});
