// "Fast" screen reading: the words of the watched text area are read in this browser with Tesseract (WebAssembly), and only
// that text is sent to the AI. The library, its WebAssembly core and the English language data are all copied into the site
// (see scripts/build.mjs): nothing is fetched from a CDN.

const BASE = new URL('../../vendor/tesseract/', import.meta.url).href;

export class TesseractReader {
  #worker = null;

  /** @param {{base?:string, load?:()=>Promise<{createWorker:Function}>}} [o] replaceable in tests */
  constructor({ base = BASE, load = () => import('../../vendor/tesseract/tesseract.esm.min.js').then((m) => m.default) } = {}) {
    this.base = base;
    this.load = load;
  }

  /** This browser can run it (a Worker and WebAssembly). */
  get isAvailable() { return typeof Worker !== 'undefined' && typeof WebAssembly === 'object'; }

  #start() {
    this.#worker ??= (async () => {
      const { createWorker } = await this.load();
      // The core directory holds the SIMD and non-SIMD builds: Tesseract.js picks the one this browser can run.
      return createWorker('eng', 1, {
        workerPath: `${this.base}worker.min.js`, corePath: `${this.base}core`, langPath: `${this.base}lang`,
        gzip: true, workerBlobURL: false, cacheMethod: 'none', logger: () => {},
      });
    })().catch((err) => { this.#worker = null; throw err; });
    return this.#worker;
  }

  /** @param {{canvas:HTMLCanvasElement}} grabbed what capture.grab() returned  @returns {Promise<string>} one line of text per line */
  async read(grabbed, signal) {
    const worker = await this.#start();
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const { data } = await worker.recognize(grabbed.canvas);
    return data.text ?? '';
  }

  async dispose() {
    const w = this.#worker;
    this.#worker = null;
    try { await (await w)?.terminate(); } catch { /* already gone */ }
  }
}
