# Cached style-function benchmark

Run from an installed ol-mapbox-style worktree. This uses the existing Rollup and
Puppeteer dependencies and imports `src/apply.js` directly; no library build or
server is needed.

Install the repository dependencies, then run the benchmark setup:

```sh
npm ci
npm run benchmark:setup -- --cache ../benchmark-inputs --output ../prepared.json
```

Setup automatically downloads the public [basemap.de color style](https://basemap.de/produkte-und-dienste/web-vektor/),
its TileJSON, sprite JSON/PNG, and the vector tiles needed for zooms 13, 14 and 15.
The runner discovers these resources by loading the three views, and stores their
URLs and SHA-256 hashes in `../benchmark-inputs/manifest.json`.

Then measure the current worktree with those inputs, without network access:

```sh
npm run benchmark -- --cache ../benchmark-inputs --output ../result.json
```

To compare several installed worktrees in one run, repeat `--worktree`:

```sh
npm run benchmark -- --cache ../benchmark-inputs --output ../comparison.json \
  --worktree ../baseline --worktree ../index --worktree ../loop
```

The runner only reads the selected worktrees. Each needs its dependencies
installed. The benchmark files can also be copied into another worktree and run
with `node benchmarks/run.js` instead of the npm command.

The first preparation pins input bytes by SHA-256. Keep the same cache for every
comparison; another `benchmark:setup` downloads a fresh set. Missing or changed cached
bytes fail the measured run. Keep the cache and result files outside the checkout.

## What is measured

Each zoom (13, 14 and 15) uses a 1000×700 map in Berlin (`[13.405, 52.52]` longitude/latitude), pixel ratio 1,
preload 0, Arial, and Chromium with 4× CPU throttling. Font substitution isolates
styling from web font loading. The basemap.de attribution remains on the map.

After rendering, visible features are collected through `getFeaturesInExtent()`
and put in a stable order. All implementations receive the same feature objects
and resolution. Three warmup passes precede nine measured passes, with the first
implementation rotating each pass. The timed loop calls the complete style
function once per feature and counts the returned styles. Loading, decoding,
setup, fingerprints and rendering are outside that timer.

JSON includes commits, dependency/browser versions, CPU, input hashes, feature
counts and raw samples. Selected style fields and screenshots are fingerprinted
separately; a mismatch between implementations fails the run. These checks are
specific to the sampled views, not exhaustive style equivalence tests.

Use the same dependencies, browser and cache across comparisons. Absolute times
depend on the machine. CPU throttling does not reproduce a particular device;
this is cached styling time, not page-load time or frame rate. Other styles and
views can behave differently.

On environments where Chromium requires it, append `--no-sandbox`. The
`PUPPETEER_EXECUTABLE_PATH` environment variable can select an existing Chromium.
