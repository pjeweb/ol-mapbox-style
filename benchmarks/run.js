import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {cpus, platform, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import puppeteer from 'puppeteer';
import {rollup} from 'rollup';

const {values} = parseArgs({
  options: {
    worktree: {type: 'string', multiple: true},
    cache: {
      type: 'string',
      default: join(tmpdir(), 'ol-mapbox-style-benchmark'),
    },
    output: {type: 'string'},
    prepare: {type: 'boolean', default: false},
    'no-sandbox': {type: 'boolean', default: false},
  },
});
const roots = (values.worktree || [process.cwd()]).map((root) => resolve(root));
const directory = fileURLToPath(new URL('.', import.meta.url));
const cache = resolve(values.cache);
await mkdir(cache, {recursive: true});
const manifestFile = join(cache, 'manifest.json');
const manifest = values.prepare
  ? {}
  : JSON.parse(await readFile(manifestFile, 'utf8'));
const usedInputs = new Map();
const pending = new Map();
const hash = (data) => createHash('sha256').update(data).digest('hex');
const styleUrl =
  'https://sgx.geodatenzentrum.de/gdz_basemapde_vektor/styles/bm_web_col.json';

/**
 * @param {string} url Public input URL.
 * @return {Promise<Object>} Pinned response.
 */
async function input(url) {
  if (!pending.has(url)) {
    pending.set(
      url,
      (async () => {
        let meta = manifest[url];
        if (!meta) {
          if (!values.prepare) {
            throw new Error(
              `Uncached input: ${url}. Run with --prepare first.`,
            );
          }
          const response = await fetch(url, {
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) {
            throw new Error(`${response.status}: ${url}`);
          }
          const body = Buffer.from(await response.arrayBuffer());
          meta = {
            sha256: hash(body),
            bytes: body.length,
            type: response.headers.get('content-type'),
          };
          await writeFile(join(cache, meta.sha256), body);
          manifest[url] = meta;
        }
        const body = await readFile(join(cache, meta.sha256));
        if (hash(body) !== meta.sha256) {
          throw new Error(`Input checksum mismatch: ${url}`);
        }
        usedInputs.set(url, meta);
        return {...meta, body};
      })(),
    );
  }
  return pending.get(url);
}

const entry = '\0benchmark';
const imports = roots
  .map(
    (root, i) =>
      `import * as implementation${i} from ${JSON.stringify(join(root, 'src/apply.js'))};`,
  )
  .join('\n');
const build = await rollup({
  input: entry,
  plugins: [
    {
      name: 'benchmark-entry',
      resolveId: (id) => (id === entry ? id : undefined),
      load: (id) =>
        id === entry
          ? `${imports}\nimport {initialize} from ${JSON.stringify(join(directory, 'stylefunction.js'))};\nwindow.initialize = (zoom, url) => initialize([${roots.map((root, i) => `implementation${i}`).join(',')}], zoom, url);`
          : undefined,
    },
    nodeResolve({browser: true, preferBuiltins: false}),
    commonjs(),
  ],
});
const generated = await build.generate({format: 'iife'});
await build.close();
const bundle = generated.output[0].code;
const require = createRequire(import.meta.url);
const css = await readFile(require.resolve('ol/ol.css'), 'utf8');
const html = `<!doctype html><html><head><style>${css}\nhtml,body{margin:0}#map{width:1000px;height:700px}</style></head><body><div id="map"></div><script src="/bundle.js"></script></body></html>`;
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();
const results = {
  date: new Date().toISOString(),
  cpu: cpus()[0].model,
  platform: platform(),
  node: process.version,
  benchmarkHash: hash(
    Buffer.concat([
      await readFile(new URL(import.meta.url)),
      await readFile(join(directory, 'stylefunction.js')),
    ]),
  ),
  versions: Object.fromEntries(
    ['ol', '@maplibre/maplibre-gl-style-spec', 'puppeteer'].map((name) => [
      name,
      require(`${name}/package.json`).version,
    ]),
  ),
  implementations: roots.map((root) => ({
    commit: git(root, 'rev-parse', 'HEAD'),
    sourceChanges: Boolean(git(root, 'status', '--porcelain', '--', 'src')),
  })),
  settings: {
    styleUrl,
    centerLonLat: [13.405, 52.52],
    viewport: [1000, 700],
    pixelRatio: 1,
    preload: 0,
    font: 'Arial',
    cpuThrottle: 4,
    warmups: 3,
    passes: 9,
  },
  preparation: values.prepare,
  zooms: [],
};
const browser = await puppeteer.launch({
  headless: true,
  args: values['no-sandbox'] ? ['--no-sandbox'] : [],
});
results.browser = await browser.version();
try {
  for (const zoom of [13, 14, 15]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    await page.setViewport({width: 1000, height: 700, deviceScaleFactor: 1});
    const client = await page.createCDPSession();
    await client.send('Emulation.setCPUThrottlingRate', {rate: 4});
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      try {
        const url = request.url();
        if (url === 'http://localhost/') {
          return await request.respond({
            status: 200,
            contentType: 'text/html',
            body: html,
          });
        }
        if (url === 'http://localhost/bundle.js') {
          return await request.respond({
            status: 200,
            contentType: 'application/javascript',
            body: bundle,
          });
        }
        if (url === 'http://localhost/favicon.ico') {
          return await request.respond({status: 204, body: ''});
        }
        const data = await input(url);
        await request.respond({
          status: 200,
          contentType: data.type,
          headers: {'access-control-allow-origin': '*'},
          body: data.body,
        });
      } catch (error) {
        errors.push(String(error));
        await request.abort();
      }
    });
    await page.goto('http://localhost/');
    const setup = await page.evaluate(
      (zoom, url) => window.initialize(zoom, url),
      zoom,
      styleUrl,
    );
    if (!setup.features) {
      throw new Error(`No features at zoom ${zoom}`);
    }
    const samples = roots.map(() => []);
    if (!values.prepare) {
      for (let pass = -3; pass < 9; ++pass) {
        for (let offset = 0; offset < roots.length; ++offset) {
          const index = (pass + 3 + offset) % roots.length;
          const sample = await page.evaluate(
            (index) => window.benchmark.pass(index),
            index,
          );
          if (pass >= 0) {
            samples[index].push(sample);
          }
        }
      }
    }
    const outputHashes = [],
      screenshotHashes = [];
    for (let index = 0; index < roots.length; ++index) {
      outputHashes.push(
        await page.evaluate(
          (index) => window.benchmark.outputHash(index),
          index,
        ),
      );
      await page.evaluate((index) => window.benchmark.render(index), index);
      screenshotHashes.push(hash(await page.screenshot()));
    }
    if (errors.length) {
      throw new Error(errors.join('\n'));
    }
    if (new Set(outputHashes).size > 1 || new Set(screenshotHashes).size > 1) {
      throw new Error(
        `Different style output or rendered pixels at zoom ${zoom}`,
      );
    }
    const medianMs = samples.map((items) => {
      const sorted = items.map((item) => item.ms).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    });
    results.zooms.push({
      zoom,
      ...setup,
      samples,
      medianMs,
      outputHashes,
      screenshotHashes,
    });
    process.stderr.write(
      `Zoom ${zoom}: ${setup.features} features; ${medianMs.map((ms) => ms?.toFixed(1) || 'prepared').join(' / ')} ms\n`,
    );
    await page.close();
  }
  if (values.prepare) {
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  }
  results.inputs = [...usedInputs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([url, meta]) => ({url, ...meta}));
  const json = JSON.stringify(results, null, 2) + '\n';
  if (values.output) {
    await writeFile(values.output, json);
  } else {
    process.stdout.write(json);
  }
} finally {
  await browser.close();
}
