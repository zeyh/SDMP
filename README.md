# SDMP project page

The static GitHub Pages site pairs the SDMP paper's overview with
progressive embedding animations and the spectral viewer. It serves directly
from this directory.

```
docs/
  index.html               project copy, GIF slots, and viewer controls
  assets/figures/          GIFs and poster images
  assets/project.css      project page styles
  assets/project.js       GIF controls
  assets/style.css        viewer styles
  assets/app.js           viewer rendering and controls
  data/index.json         datasets and colour maps
  data/<run>/             viewer metadata and binary arrays
```

## Replacing a GIF

Replace the matching `*-interpolated.gif` and PNG poster in `assets/figures/`.
For different filenames or dimensions, update the image attributes and the
button's `data-gif` in `index.html`. The GIF plays by default. Choosing
**Stop** switches back to its poster.

## Viewing it locally

`fetch` will not read `file://`, so open the site through a server:

```bash
python3 -m http.server 8070 --bind 127.0.0.1 --directory docs
```

Then <http://localhost:8070/>. (`.claude/launch.json` has this as the
`pages-site` configuration, but that file is ignored by the root `.gitignore`,
so it stays local.)

## Publishing to GitHub Pages

Pages only serves committed files, and it can only deploy from the repository
root or from `/docs`, so the site has to live where it does and the branch has
to be on `origin`.

1. Commit the site and push the branch:

   ```bash
   git add docs/.gitignore docs/.nojekyll docs/README.md docs/index.html docs/assets docs/data experiments/export_web_viewer.py
   git commit -m "Add SDMP project page and interactive viewer"
   git push -u origin ver3
   ```

2. On GitHub: **Settings → Pages → Build and deployment**. Source
   **Deploy from a branch**, branch **`ver3`**, folder **`/docs`**, then
   **Save**. The first build takes a minute or two.

3. The site is then at `https://zeyh.github.io/dr-diffusion/`.

Publishing from `main` instead is the same three steps with `main` chosen in
step 2; merge `ver3` first. Pages on a **private** repository needs a paid
plan — on the free plan the repository has to be public for the site to be
served.

`docs/.nojekyll` turns off the Jekyll build, so the files are served exactly as
committed. Nothing else in `docs/` is published: `docs/paper/` is ignored by
the repository root's `paper/` rule, and `docs/talks/` holds only `*.pdf` /
`*.key`, which are ignored too. The root `.gitignore` excludes `*.json`,
`*.png` and `*.md` everywhere, so `docs/.gitignore` re-includes the site's own
files; keep it when adding new file types here.

The whole export is ~17 MB for six runs and each run is fetched only when it is
selected (~3.2 MB), so this sits well inside the 1 GB Pages limit and needs
no LFS. Every path in `index.html` and `app.js` is relative, so the site works
at the `/<repo>/` subpath Pages serves it from.

## Regenerating the data

```bash
~/miniconda3/envs/torchEnv/bin/python experiments/export_web_viewer.py --clean
```

It reads the full-spectrum local-explanation runs under
`results/interactive_dash_results/` — the same exports
`figures/explaination_figures/` draws from, so a mode index means the same
thing on this page as it does in the paper. `--modes` sets the mode axis
(128 by default), `--datasets` picks runs, and the run list itself is the
`RUNS` table at the top of that script.

## What the page shows

- **Snapshot** — `Y_K` at the selected stage. Play steps through the stages;
  **interpolate** blends between them, which is a reading aid, not fitted
  layouts. Each stage is framed to its own extent, because the overall scale of
  the layout changes with `K`.
- **U·P** — `||u_{n,s} p_s||`, one row per point, one column per mode. **U**
  switches to the stage-independent `|u_{n,s}|`. The rows are grouped or sorted
  by whatever the points are coloured by.
- **Energy distribution** — the Parseval share
  `π_s = ||p_s||² / Σ_t ||p_t||²`, one row per stage, normalized over the whole
  exported spectrum and then windowed to the modes shown.
- **P** — the signed coefficients `p_{s,x}`, `p_{s,y}` on a symmetric-log
  diverging scale, plus the same numbers as bars.
- **Point spectrum** — the hovered (or pinned) point's own rows of the local
  panels, on the same mode axis.

## Point colours

The colours come from `figures/plot_svg.py`, which draws the progressive table,
so a class is the same colour on this page as it is in that figure: the
Tableau-10 seed every figure in the project starts from, continued into the
tab20b/tab20c hues past ten classes and then into generated ones (only the
50-branch tree gets that far). Up to ten classes this also matches the
explanation figures in `figures/explaination_figures/`, which share the seed;
past ten those reuse the ten hues at a lighter and a darker value instead, and
the table's rule wins here because the snapshot panel *is* the table's panel.

One rule in the repository still disagrees: `exp_revision/plots.py:label_colors`,
which the snapshot GIFs in `snapshot_animation/` use, takes the first ten
colours of **tab20** rather than tab10, so its class 1 is a light blue where
everything else is orange. Changing it would mean re-rendering the GIFs.

## Colour schemes

A *scheme* is one way of colouring the points. Every run has a categorical one
over its own labels. C. elegans has a second, continuous one over embryo time,
matching the progressive table's "coloured by embryo time" row — viridis
between the earliest and latest cell, read from
`data/cel_processed_100pc/celegans_metadata.csv`. `src/data.py` loads that
dataset as `X[:n]`, the first `n` rows with no shuffle, so row `i` of the CSV is
point `i` of the run; the exporter asserts that before writing anything.

Each scheme carries its own heatmap row order, because grouping rows into class
blocks says nothing about a continuous quantity — under embryo time the rows are
sorted by it instead, so the row axis becomes the time axis and a band of modes
that only the late cells use shows up as a band at the bottom. `absU.bin` is
therefore exported in point order and permuted in the browser, one lookup per
row.

Hovering a point in the snapshot marks its row in the U·P panel and fills the
point spectrum; clicking pins it. Clicking a row of the U·P panel pins that
point, and clicking a row of the response panel jumps to that stage. The URL
hash carries dataset, stage, tab, mode count, colour scheme and pinned point, so
a view can be linked. Space plays and pauses, arrows step, Escape clears the selection.

## Binary layout

All little-endian, C order, no header; shapes are in each run's `meta.json`
under `files`.

| file | dtype | shape | notes |
| --- | --- | --- | --- |
| `order_<scheme>.bin` | uint32 | `N` | heatmap row → point index, one per scheme |
| `values_<scheme>.bin` | uint16 / float32 | `N` | the coloured quantity, in point order |
| `eigenvalues.bin` | float32 | `S` | non-trivial Laplacian spectrum |
| `absU.bin` | float32 | `N × M` | `\|u_{n,s}\|`, in **point** order |
| `snapshots.bin` | float32 | `T × N × 2` | the embedding at every stage |
| `response.bin` | float32 | `T × S` | `\|\|p_s\|\|`, zero past that stage's `K` |
| `coeff.bin` | float32 | `T × M × 2` | `p_s`, eigenvector signs canonicalized |
| `thumbs.png` | uint8 PNG (L) | `rows·side × cols·side` | image runs only: every point's input image |

`M` is the exported mode axis, `S = N - 1` the full spectrum, `T` the stage
count. `values_<scheme>.bin` is `uint16` (an index into that scheme's `classes`)
for a categorical scheme and `float32` for a continuous one. The displacement heatmap is not exported per stage: since `p_s` is a
2-vector,

```
||u_{n,s} p_s||₂ = |u_{n,s}| · ||p_s||₂
```

so the page builds every stage's panel from one `absU.bin` and that stage's row
of `response.bin`.

### Input images

A run whose points are images (`mnist`, `fashion_mnist`, `digits`) also exports
`thumbs.png`, one sprite sheet of every point's input: point `n` is the tile at
`(n % cols, n // cols)`, with `side`, `cols` and `rows` in `meta.json` under
`thumbs`. The viewer crops a tile out of it to put the image in a tooltip and
beside the point's spectrum, so identifying a point costs no request of its own.

The sheet keeps the raw exposure -- bright ink on black, one scale over the
whole run rather than one per tile, so a faint stroke still looks faint -- and
the page backs it with a dark chip instead of inverting it. The labels returned
by the loader are compared against the run's `local_labels.npy` at export time,
so a sheet that does not line up with the run is an error rather than a page
that shows the wrong digit.
