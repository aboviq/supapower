import { describe, expect, test } from 'bun:test';

import { GUIDES, PAGES, generate, splitSection, transform } from './sync-readmes.ts';

const readmes: Record<string, string> = {};
const meta: Record<string, { name: string; description: string }> = {};

await Promise.all(
  PAGES.map(async ({ dir }) => {
    readmes[dir] = await Bun.file(
      new URL(`../../packages/${dir}/README.md`, import.meta.url),
    ).text();
    meta[dir] = await Bun.file(
      new URL(`../../packages/${dir}/package.json`, import.meta.url),
    ).json();
  }),
);

const files = generate(readmes, meta);
const page = (path: string) => files.get(path) ?? '';

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

    const result = transform(fixture, {
      dir: 'supapower',
      title: 'supapower',
      description: 'A sync engine',
      order: 1,
    });

    expect(result.startsWith('---\ntitle: "supapower"')).toBe(true);
    expect(result).toContain(':::note');
    expect(result).toContain('/packages/worker/');
    expect(result).toContain('](https://github.com/aboviq/supapower/blob/main/LICENSE)');
    expect(result).not.toContain('<picture');
    expect(result).not.toContain('[!IMPORTANT]');
  });
});

describe('splitSection', () => {
  const fixture = `Intro text.

### Target

Target body.

#### Child

Child body.

### After

After body.
`;

  test('lifts the section out, re-leveling headings and collecting anchors', () => {
    const { rest, section, anchors } = splitSection(fixture, 'Target');

    expect(rest).not.toContain('Target body.');
    expect(rest).toContain('### After');
    expect(section).toContain('## Child');
    expect(section).not.toContain('#### Child');
    expect(anchors).toEqual(['target', 'child']);
  });

  test('throws for a heading that does not exist', () => {
    expect(() => splitSection(fixture, 'Nope')).toThrow(/section "Nope" not found/);
  });
});

describe('database-migrations guide', () => {
  const content = page('src/content/docs/guides/database-migrations.mdx');

  test('imports and renders Badge for C/S markers', () => {
    expect(content).toContain("import { Badge } from '@astrojs/starlight/components';");
    expect(content).toContain('<Badge text="C" variant="tip" size="small" />');
    expect(content).toContain('<Badge text="S" variant="note" size="small" />');
    expect(content).not.toContain('<kbd');
  });

  test('back-links to the package page anchors that stayed behind', () => {
    expect(content).toContain('](/packages/supapower/#error-handling)');
    expect(content).toContain('](/packages/supapower/#table-cursor-configuration)');
  });

  test('keeps its own sub-section', () => {
    expect(content).toContain('## Schema recommendations');
  });
});

describe('multi-tab-behavior guide', () => {
  const content = page('src/content/docs/guides/multi-tab-behavior.mdx');

  test('links to the other guide instead of a same-page anchor', () => {
    expect(content).toContain('](/guides/database-migrations/)');
    expect(content).not.toContain('](#multi-tab-behavior)');
  });

  test('keeps its own sub-sections and package links', () => {
    expect(content).toContain('## Setting it up');
    expect(content).toContain('## How leadership works');
    expect(content).toContain('/packages/worker/');
  });
});

describe('supapower package page', () => {
  const content = page('src/content/docs/packages/supapower.md');

  test('no longer contains the extracted sections', () => {
    expect(content).not.toContain('## Database migrations');
    expect(content).not.toContain('### Multi-tab behavior');
  });

  test('links to the guides, dropping a trailing "below"', () => {
    expect(content).toContain('](/guides/multi-tab-behavior/) for the safe way');
    expect(content).toContain('](/guides/database-migrations/#schema-recommendations)');
  });

  test('keeps "below" on anchors that did not move', () => {
    expect(content).toContain('](#persistent-storage) below');
  });
});

describe('react package page', () => {
  test('cross-package GitHub link to multi-tab-behavior follows the move', () => {
    expect(page('src/content/docs/packages/react.md')).toContain('](/guides/multi-tab-behavior/)');
  });
});

describe('every generated page', () => {
  for (const [path, content] of files) {
    test(`${path} is well-formed`, () => {
      expect(content).not.toContain('[!');
      expect(content).not.toContain('<kbd');
      expect(content.indexOf('---\n')).toBe(0);
      expect(content.indexOf('---\n', 1)).toBeGreaterThan(0);
    });
  }
});

describe('GUIDES', () => {
  test('every guide has a distinct slug', () => {
    const slugs = GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
