interface Page {
  readonly dir: string;
  readonly order: number;
}

interface Guide {
  readonly from: string;
  readonly heading: string;
  readonly slug: string;
  readonly description: string;
  readonly order: number;
}

export const PAGES: readonly Page[] = [
  { dir: 'supapower', order: 1 },
  { dir: 'worker', order: 2 },
  { dir: 'react', order: 3 },
  { dir: 'vue', order: 4 },
];

/** Sections lifted out of a package README onto a page of their own. */
export const GUIDES: readonly Guide[] = [
  {
    from: 'supapower',
    heading: 'Multi-tab behavior',
    slug: 'multi-tab-behavior',
    description:
      'How Supapower elects a single tab to drain the outgoing queue, and how to host PGlite in a worker so every tab shares one database.',
    order: 1,
  },
  {
    from: 'supapower',
    heading: 'Database migrations',
    slug: 'database-migrations',
    description:
      'Schema recommendations for client and server migrations, so older clients keep syncing.',
    order: 2,
  },
];

const ASIDES: Record<string, string> = {
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'note',
  WARNING: 'caution',
  CAUTION: 'danger',
};

/** `<kbd>C</kbd>`/`<kbd>S</kbd>` in a README become Starlight badges on a guide page. */
const BADGES: Record<string, string> = { C: 'tip', S: 'note' };

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

interface Split {
  readonly rest: string;
  readonly section: string;
  readonly anchors: readonly string[];
}

/** Lifts a section - the heading and everything under it - out of a README. */
export function splitSection(markdown: string, heading: string): Split {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = markdown.match(new RegExp(`^(#{2,6}) ${escaped}\\s*$`, 'm'));
  if (start?.index === undefined) {
    throw new Error(`sync-readmes: section "${heading}" not found`);
  }

  const level = start[1].length;
  const from = start.index + start[0].length;
  const next = markdown.slice(from).match(new RegExp(`^#{1,${level}} `, 'm'));
  const to = next?.index === undefined ? markdown.length : from + next.index;
  const section = markdown.slice(from, to);

  return {
    rest: markdown.slice(0, start.index) + markdown.slice(to),
    // Re-level so the section's own subheadings start at H2 under the page title.
    section: section.replace(
      /^(#{2,6}) /gm,
      (_m, hashes: string) => `${'#'.repeat(Math.max(2, hashes.length - level + 1))} `,
    ),
    anchors: [
      slugify(heading),
      ...[...section.matchAll(/^#{2,6} (.+)$/gm)].map((m) => slugify(m[1])),
    ],
  };
}

interface Rewrite {
  /** Package the markdown came from, for resolving its own anchors. */
  readonly dir: string;
  /** `"<dir>#<anchor>"` for every anchor that now lives on a guide page. */
  readonly moved: ReadonlyMap<string, string>;
  /** URL of the page being generated, so links into it collapse back to anchors. */
  readonly self?: string;
  /** Where anchors that did not move live - set on guide pages. */
  readonly home?: string;
}

const local = (url: string, self: string | undefined) =>
  self && url.startsWith(self) ? url.slice(self.length) || '#_top' : url;

function rewrite(markdown: string, { dir, moved, self, home }: Rewrite): string {
  return (
    markdown
      // Convert GitHub alerts to Starlight asides.
      .replace(/^> \[!(\w+)]\n((?:>.*\n)*)/gm, (_m, type: string, quoted: string) => {
        const aside = ASIDES[type.toUpperCase()] ?? 'note';
        return `:::${aside}\n${quoted.replace(/^> ?/gm, '')}:::\n`;
      })
      // Rewrite cross-package GitHub links to site links, following moved sections.
      .replace(
        /https:\/\/github\.com\/aboviq\/supapower\/tree\/main\/packages\/([\w-]+)(#[\w-]+)?/g,
        (_m, pkg: string, hash: string | undefined) => {
          const anchor = hash && hash !== '#readme' ? hash : '';
          return local(moved.get(`${pkg}${anchor}`) ?? `/packages/${pkg}/${anchor}`, self);
        },
      )
      // Point same-page anchors at wherever their section ended up. A trailing "below" goes
      // with it - the target is another page now.
      .replace(/]\(#([\w-]+)\)(\s+below)?/g, (match, anchor: string) => {
        const url = moved.get(`${dir}#${anchor}`) ?? (home ? `${home}#${anchor}` : undefined);
        return url ? `](${local(url, self)})` : match;
      })
      // Absolutize the only relative link (the LICENSE link at the end of each README).
      .replace(/]\(LICENSE\)/g, '](https://github.com/aboviq/supapower/blob/main/LICENSE)')
  );
}

const frontmatter = (title: string, description: string, order: number) =>
  `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\nsidebar:\n  order: ${order}\n---\n\n`;

export function transform(
  markdown: string,
  meta: { dir: string; title: string; description: string; order: number },
  moved: ReadonlyMap<string, string> = new Map(),
): string {
  const body = rewrite(
    markdown
      // Strip a leading <picture> banner (only packages/supapower/README.md has one).
      .replace(/^<picture>[\s\S]*?<\/picture>\n+/, '')
      // Strip the leading H1 - Starlight renders the frontmatter `title` as the H1.
      .replace(/^#\s.*\n+/, ''),
    { dir: meta.dir, moved },
  );

  return frontmatter(meta.title, meta.description, meta.order) + body;
}

export function transformGuide(
  section: string,
  guide: Guide,
  moved: ReadonlyMap<string, string>,
): string {
  const body = rewrite(section, {
    dir: guide.from,
    moved,
    self: `/guides/${guide.slug}/`,
    home: `/packages/${guide.from}/`,
  }).replace(
    /<kbd>(\w+)<\/kbd>/g,
    (_m, key: string) =>
      `<Badge text=${JSON.stringify(key)} variant="${BADGES[key] ?? 'default'}" size="small" /> `,
  );

  const imports = body.includes('<Badge')
    ? "import { Badge } from '@astrojs/starlight/components';\n\n"
    : '';

  return `${frontmatter(guide.heading, guide.description, guide.order)}${imports}${body.trim()}\n`;
}

/** Path (relative to docs/) -> file content, for every page the site is built from. */
export function generate(
  readmes: Readonly<Record<string, string>>,
  meta: Readonly<Record<string, { name: string; description: string }>>,
): Map<string, string> {
  const rest: Record<string, string> = { ...readmes };
  const moved = new Map<string, string>();
  const extracted: Array<{ guide: Guide; section: string }> = [];

  for (const guide of GUIDES) {
    const split = splitSection(rest[guide.from], guide.heading);
    rest[guide.from] = split.rest;
    extracted.push({ guide, section: split.section });

    const url = `/guides/${guide.slug}/`;
    for (const anchor of split.anchors) {
      moved.set(
        `${guide.from}#${anchor}`,
        anchor === slugify(guide.heading) ? url : `${url}#${anchor}`,
      );
    }
  }

  const files = new Map<string, string>();

  for (const { dir, order } of PAGES) {
    files.set(
      `src/content/docs/packages/${dir}.md`,
      transform(
        rest[dir],
        { dir, title: meta[dir].name, description: meta[dir].description, order },
        moved,
      ),
    );
  }

  for (const { guide, section } of extracted) {
    files.set(`src/content/docs/guides/${guide.slug}.mdx`, transformGuide(section, guide, moved));
  }

  return files;
}

const ROOT = new URL('../', import.meta.url); // docs/

if (import.meta.main) {
  const readmes: Record<string, string> = {};
  const meta: Record<string, { name: string; description: string }> = {};

  await Promise.all(
    PAGES.map(async ({ dir }) => {
      meta[dir] = await Bun.file(new URL(`../packages/${dir}/package.json`, ROOT)).json();
      readmes[dir] = await Bun.file(new URL(`../packages/${dir}/README.md`, ROOT)).text();
    }),
  );

  await Promise.all(
    [...generate(readmes, meta)].map(([path, content]) => Bun.write(new URL(path, ROOT), content)),
  );
}
