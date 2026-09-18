import { IdbFs, PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';

import { MESSAGES_TABLE_SQL } from './schema.ts';

worker({
  async init() {
    const pg = new PGlite({
      fs: new IdbFs('supapower-vue-chat'),
      relaxedDurability: true,
    });

    // Only the elected leader runs this, and it finishes before any tab -
    // including a follower that takes over later - is served a query.
    await pg.exec(MESSAGES_TABLE_SQL);

    return pg;
  },
});
