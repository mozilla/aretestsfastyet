# Plan: deploying the migrated pages

Nine of the site's twenty-six pages have been rewritten onto the shared `lib/`
library and live in `next/`. They are built, tested and reviewed, and nothing
deploys them: `dist-pages/` is gitignored and there is no CI. This plan is what
a fresh session needs to change that.

Read `docs/PARITY.md` first for why the migration exists, and the header of
`next/errors.ts` for what a migrated page looks like.

---

## 1. What is actually being deployed

**Not a version swap.** Seventeen of the twenty-six pages have no migrated
twin, including `help.html` — the index of the whole site — and `green.html`.
Deleting the old pages would delete two thirds of the site. The deploy is a
**merge**: build the nine, copy the seventeen, publish the union.

| | count | where it comes from |
| --- | --- | --- |
| migrated | 9 | `next/*.html`, built by `npm run pages` |
| unmigrated | 17 | root `*.html`, copied verbatim |
| shared assets | — | `shared.js`, `shared.css`, `common-*.js`, `dashboards.js`, favicons |

The nine: `crash-viewer`, `crashes`, `errors`, `failures`, `index`, `issues`,
`manifests`, `test`, `try`.

**Decided:** the migrated page takes the canonical URL, and the previous
implementation is published under `old/`. So `test.html` is the new one and
`old/test.html` is the current one, kept for comparison and as an escape hatch
that is not a revert. `old/` is deleted once the new pages have been trusted
for long enough — that removal is a follow-up commit, not part of this work.

**Decided:** the workflow lands on the **fork** first
(`origin` → `fqueze.github.io/aretestsfastyet`), which is already the staging
instance. Pointing it at `upstream` → `tests.firefox.dev` is a separate,
later change, and should not be attempted until the fork has deployed
successfully at least once.

### Why `old/` works without rewriting any link

Every inter-page link is built by the shared scripts (`dashboards.js`,
`common-links.js`) as a **relative** URL — `test.html?test=…`, not
`/test.html?test=…`. A page served from `old/` therefore links to `old/`, and
a page served from the root links to the root. Each set is self-consistent with
no rewriting.

This was checked rather than assumed: `grep` for `.html` in `next/*.ts` and
`lib/` returns only comment citations, never a constructed link.

One consequence, and it is already settled: an `old/` page linking to an
**unmigrated** page (`old/issues.html` → `old/workers.html`) resolves inside
`old/`, so the seventeen have to be there too or that link 404s.

**Decided: copy all twenty-six pages and the shared assets into `old/`**, making
it a complete, self-consistent snapshot of the site as it is today. Measured
before choosing:

| | size |
| --- | --- |
| `dist-pages/` — nine built pages plus assets | 724 kB |
| all twenty-six root pages | 1.5 MB |
| shared assets (`shared.*`, `common-*.js`, `dashboards.js`, favicons) | 128 kB |

About 1.6 MB extra on a static site, which is not worth trading a working
fallback for. The alternative — copying only the nine — leaves links out of
`old/` broken for no saving that matters.

## 2. The workflow

One workflow, on push to `main`, in `.github/workflows/`. There is none today,
so this is new — and note **GitHub Pages is currently serving the branch root
directly**, configured in repository settings, with no `CNAME` and no
`.nojekyll` in the tree. Publishing a built artifact means changing the Pages
source to GitHub Actions, which is a settings change the workflow cannot make
for you. Plan for that step and for the possibility that the first run
publishes nothing until it is done.

**Gates before publishing, all of them (decided):**

```
npm ci
npm run typecheck     # both projects: root and tsconfig.next.json
npm test              # 1,331 tests, and check-bundle for a stale dist/fx-tests.js
npm run pages         # builds next/ into dist-pages/
```

A failure must **not** publish. The failure mode to avoid is the one
`tools/build-pages.ts` already guards against internally: a build that fails
after overwriting a good artifact, so the deploy ships the broken one.

**Assembly step**, after the gates:

1. `dist-pages/` already holds the nine built pages and the assets they
   reference (`tools/build-pages.ts` copies those).
2. Copy the seventeen unmigrated root `*.html` into it.
3. Copy **all twenty-six** root `*.html` and the shared assets into
   `dist-pages/old/`, so that tree is a complete snapshot (§1).
4. Publish `dist-pages/` as the Pages artifact.

Assemble into a **fresh** directory rather than into a `dist-pages/` left over
from a previous run. A stale file from an earlier build that no longer exists
in the sources would otherwise be published indefinitely, and nothing would
report it.

Add a `.nojekyll` file to the published artifact. Without it Pages runs Jekyll,
which ignores files beginning with `_` — the project has none today, but the
failure is silent and confusing when it happens.

## 3. What to verify, and in what order

**Before writing the workflow**, run the assembly locally and serve it:

```sh
npm run pages
# assemble into a scratch dir exactly as the workflow will
python3 -m http.server 8080 --directory <scratch>
```

Then check, in a browser, that:

- each of the nine loads and renders real data,
- each of the seventeen still loads,
- `old/test.html` loads and its links stay within `old/`,
- the "Dashboards ▾" menu works from a migrated page and from an unmigrated
  one,
- no page logs a console error that the same page does not log today.

**Do not skip the last one.** Two defects in this migration were invisible to
every automated check and visible immediately on loading the page: a button
that rendered enabled and did nothing, and a page that never fetched the file
its charts needed. `docs/PARITY.md` §7 says it directly — the harness makes
reading the output cheap, it does not replace doing it.

**After the first successful deploy**, load the fork's live pages and compare
against `old/` on the same site. That is the first time the two have been
compared on the same data at the same moment, which is worth more than any
pinned-snapshot run.

## 4. Rollback

Reverting the deploy commit and pushing re-runs the workflow and republishes.
While `old/` exists a reader also has an immediate fallback that needs no
deploy at all, which is most of the reason for shipping it.

State the rollback procedure in the workflow file itself, as a comment. The
person who needs it will be reading that file, not this document.

## 5. Not in scope

- **Deploying to `upstream` / `tests.firefox.dev`.** Separate change, after the
  fork works.
- **Removing the old implementations from the repository.** They are still the
  comparison target for the parity harnesses, and seventeen pages have no
  replacement. Revisit once `old/` has been dropped from the deploy.
- **Migrating the remaining seventeen pages.** No CLI command corresponds to
  them, so the argument that justified this programme — that the page and the
  command must agree — does not reach them.
- **The two known open items**, both recorded in the migrated pages' divergence
  lists: the Flaky Job Failures *chart* still plots `failedJobs − invalidJobs`
  although the table beside it has been corrected, and `failedJobs` counts
  Treeherder job state, so it includes infra failures with no failing test.

## 6. A caution for whoever picks this up

The pages were migrated by nine agents working largely independently, and the
defects that mattered were found by a human running the thing, not by the test
suite — which was green throughout. Specifically: a formatter duplicated
thirteen times, a control that rendered enabled and did nothing, a page whose
charts silently never loaded their data, and two rate formulas that were wrong
on both sides at once in different ways.

So when the site is deployed, the highest-value next action is not more
automation. It is opening the nine pages and reading them.
