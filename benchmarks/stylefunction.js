import Map from 'ol/Map.js';
import View from 'ol/View.js';
import MVT from 'ol/format/MVT.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import {fromLonLat} from 'ol/proj.js';
import VectorTileSource from 'ol/source/VectorTile.js';

/**
 * @param {*} value Values to fingerprint outside the timed loop.
 * @return {Promise<string>} SHA-256 fingerprint.
 */
async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * @param {Array<Object>} implementations Style implementations.
 * @param {number} zoom View zoom.
 * @param {string} styleUrl Public style URL.
 * @return {Promise<Object>} Benchmark controls.
 */
export async function initialize(implementations, zoom, styleUrl) {
  const style = await (await fetch(styleUrl)).json();
  for (const layer of style.layers) {
    if (Array.isArray(layer.layout?.['text-font'])) {
      layer.layout['text-font'] = ['Arial'];
    }
  }
  delete style.metadata?.['ol:webfonts'];
  const source = new VectorTileSource({
    state: 'loading',
    format: new MVT({layerName: 'mvt:layer'}),
  });
  const layers = [];
  for (const implementation of implementations) {
    const layer = new VectorTileLayer({source, declutter: true, preload: 0});
    await implementation.applyStyle(
      layer,
      structuredClone(style),
      'smarttiles_de',
      {styleUrl, webfonts: false},
    );
    await implementation.applyBackground(layer, style);
    layers.push(layer);
  }
  const view = new View({center: fromLonLat([13.405, 52.52]), zoom});
  const map = new Map({
    target: 'map',
    pixelRatio: 1,
    layers: [layers[0]],
    view,
  });
  const ready = () =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Map did not finish rendering')),
        30000,
      );
      source.once('tileloaderror', () =>
        reject(new Error('Tile loading failed')),
      );
      map.once('rendercomplete', () => {
        clearTimeout(timeout);
        resolve();
      });
      map.render();
    });
  source.setState('ready');
  await ready();
  await document.fonts.ready;
  const entries = layers[0]
    .getFeaturesInExtent(view.calculateExtent(map.getSize()))
    .map((feature) => ({
      feature,
      key: JSON.stringify([
        feature.getId(),
        feature.getProperties(),
        feature.getGeometry().getType(),
        feature.getGeometry().getFlatCoordinates(),
      ]),
    }));
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const features = entries.map((entry) => entry.feature);
  const inputHash = await fingerprint(entries.map((entry) => entry.key));
  const resolution = view.getResolution();
  const functions = layers.map((layer) => layer.getStyleFunction());
  window.benchmark = {
    pass(index) {
      const fn = functions[index];
      let styles = 0;
      const start = performance.now();
      for (const feature of features) {
        styles += fn(feature, resolution)?.length || 0;
      }
      return {ms: performance.now() - start, styles};
    },
    async outputHash(index) {
      const fn = functions[index];
      return fingerprint(
        features.map((feature) =>
          (fn(feature, resolution) || []).map((style) => {
            const fill = style.getFill();
            const stroke = style.getStroke();
            const text = style.getText();
            const image = style.getImage();
            return [
              style.getZIndex(),
              fill?.getColor(),
              stroke && [
                stroke.getColor(),
                stroke.getWidth(),
                stroke.getLineDash(),
              ],
              text && [
                text.getText(),
                text.getFont(),
                text.getPlacement(),
                text.getOffsetX(),
                text.getOffsetY(),
                text.getFill()?.getColor(),
                text.getStroke()?.getColor(),
              ],
              image && [
                image.getOpacity(),
                image.getRotation(),
                image.getScale(),
                image.getSize(),
                image.getAnchor(),
                image.getOrigin?.(),
              ],
            ];
          }),
        ),
      );
    },
    async render(index) {
      map.setLayers([layers[index]]);
      layers[index].changed();
      await ready();
      await document.fonts.ready;
      map.renderSync();
    },
  };
  return {features: features.length, inputHash};
}
