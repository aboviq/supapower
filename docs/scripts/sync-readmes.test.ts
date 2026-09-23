import { describe, expect, test } from 'bun:test';

import { PAGES, transform } from './sync-readmes.ts';

describe('transform', () => {
  test('strips picture/H1, converts alerts, rewrites links', () => {
    const fixture = `<picture>
  <source srcset="banner.png">
</picture>

# \`supapower\`

Some intro text.

> [!IMPORTANT]
> Two line alert.
> Second line.

See [worker](https://github.com/aboviq/supapower/tree/main/packages/worker#readme) for details.

[Apache-2.0](LICENSE), Copyright 2026 Aboviq AB.
`;

    const result = transform(fixture, 'supapower', 'A sync engine', 1);

    expect(result.startsWith('---\ntitle: "supapower"')).toBe(true);
    expect(result).toContain(':::note');
    expect(result).toContain('../worker/');
    expect(result).toContain('](https://github.com/aboviq/supapower/blob/main/LICENSE)');
    expect(result).not.toContain('<picture');
    expect(result).not.toContain('[!IMPORTANT]');
  });
});

describe('every package README', () => {
  for (const { dir, order } of PAGES) {
    test(`${dir} transforms cleanly`, async () => {
      const pkg = await Bun.file(
        new URL(`../../packages/${dir}/package.json`, import.meta.url),
      ).json();
      const readme = await Bun.file(
        new URL(`../../packages/${dir}/README.md`, import.meta.url),
      ).text();

      const result = transform(readme, pkg.name, pkg.description, order);

      expect(result).not.toContain('[!');
      expect(result.indexOf('---\n')).toBe(0);
      expect(result.indexOf('---\n', 1)).toBeGreaterThan(0);
    });
  }
});
