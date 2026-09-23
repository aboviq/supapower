interface Page {
  readonly dir: string;
  readonly order: number;
}

export const PAGES: readonly Page[] = [
  { dir: 'supapower', order: 1 },
  { dir: 'worker', order: 2 },
  { dir: 'react', order: 3 },
  { dir: 'vue', order: 4 },
];

const ASIDES: Record<string, string> = {
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'note',
  WARNING: 'caution',
  CAUTION: 'danger',
};

export function transform(
  markdown: string,
  title: string,
  description: string,
  order: number,
): string {
  const body = markdown
    // Strip a leading <picture> banner (only packages/supapower/README.md has one).
    .replace(/^<picture>[\s\S]*?<\/picture>\n+/, '')
    // Strip the leading H1 - Starlight renders the frontmatter `title` as the H1.
    .replace(/^#\s.*\n+/, '')
    // Convert GitHub alerts to Starlight asides.
    .replace(/^> \[!(\w+)]\n((?:>.*\n)*)/gm, (_m, type: string, quoted: string) => {
      const aside = ASIDES[type.toUpperCase()] ?? 'note';
      return `:::${aside}\n${quoted.replace(/^> ?/gm, '')}:::\n`;
    })
    // Rewrite cross-package GitHub links to site-relative links.
    .replace(
      /https:\/\/github\.com\/aboviq\/supapower\/tree\/main\/packages\/([\w-]+)(#[\w-]+)?/g,
      (_m, pkg: string, hash: string | undefined) =>
        `../${pkg}/${hash && hash !== '#readme' ? hash : ''}`,
    )
    // Absolutize the only relative link (the LICENSE link at the end of each README).
    .replace(/]\(LICENSE\)/g, '](https://github.com/aboviq/supapower/blob/main/LICENSE)');

  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\nsidebar:\n  order: ${order}\n---\n\n${body}`;
}

const ROOT = new URL('../', import.meta.url); // docs/

if (import.meta.main) {
  await Promise.all(
    PAGES.map(async ({ dir, order }) => {
      const pkg = await Bun.file(new URL(`../packages/${dir}/package.json`, ROOT)).json();
      const readme = await Bun.file(new URL(`../packages/${dir}/README.md`, ROOT)).text();
      await Bun.write(
        new URL(`src/content/docs/packages/${dir}.md`, ROOT),
        transform(readme, pkg.name, pkg.description, order),
      );
    }),
  );
}
