# Third-party notices

CueLight Web itself is under the [MIT license](LICENSE). The published site contains, or downloads, the open-source
components below, each under its own license and copyright. The license files of the packages that are copied into the
site are published next to them, in [`vendor/licenses/`](https://cs92604.github.io/CueLightWeb/vendor/licenses/) on the
site and in the `_site/vendor/licenses/` folder of a build. This list is kept with the source so that anyone who only
has the site can still find it.

Exact versions are pinned in `package-lock.json` and recorded in `vendor/versions.json` on the built site.

## Libraries copied into the site

| Component | What it is used for | License | Copyright |
|---|---|---|---|
| [Transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | Runs the Whisper speech model in a Web Worker | Apache-2.0 | Hugging Face |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (`onnxruntime-web`, bundled inside Transformers.js, and its `ort-wasm-simd-threaded*.wasm` files) | Runs the model on WebGPU or WebAssembly | MIT | Microsoft Corporation |
| [Tesseract.js](https://github.com/naptha/tesseract.js) (`tesseract.js`) and `tesseract.js-core` (the Tesseract OCR engine and Leptonica compiled to WebAssembly) | Reads the words of a text area on this device (Fast screen reading) | Apache-2.0 (Tesseract.js, Tesseract); BSD-2-Clause (Leptonica) | The Tesseract.js authors; Google and the Tesseract authors; Dan Bloomberg |
| [`@tesseract.js-data/eng`](https://github.com/naptha/tessdata) (`eng.traineddata`, the `4.0.0_best_int` English model) | The language data Tesseract reads English with | Published under MIT by the package; the data derives from Tesseract's [tessdata_best](https://github.com/tesseract-ocr/tessdata_best), which is Apache-2.0 | The Tesseract authors and the package authors |

## Fonts

| Font | License | Copyright |
|---|---|---|
| [Inter](https://rsms.me/inter/) (from `@fontsource-variable/inter`) | SIL Open Font License 1.1 | The Inter Project Authors |
| [Young Serif](https://github.com/noirblancrouge/YoungSerif) (from `@fontsource/young-serif`) | SIL Open Font License 1.1 | The Young Serif Project Authors |

## Downloaded on first use, not part of the site

| Component | License | Copyright |
|---|---|---|
| The Whisper speech models (`whisper-tiny.en`, `whisper-base.en`, `whisper-small.en`), as ONNX conversions published under [huggingface.co/onnx-community](https://huggingface.co/onnx-community) from OpenAI's [Whisper](https://github.com/openai/whisper) weights. The page downloads them from huggingface.co into your browser's cache the first time you listen, and never uploads audio. | MIT (OpenAI's Whisper); the license on each model's page is the one that applies | OpenAI |

## The Apache License 2.0

Transformers.js, Tesseract.js, `tesseract.js-core` and Tesseract are licensed under the Apache License, Version 2.0. You
may obtain a copy of the license at <https://www.apache.org/licenses/LICENSE-2.0>; a copy accompanies each of those
packages in `vendor/licenses/`. Unless required by applicable law or agreed to in writing, software distributed under the
License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

## The MIT license

The components marked MIT above are each under the following terms, with the copyright holder named in the table:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## The SIL Open Font License

Inter and Young Serif are under the SIL Open Font License, Version 1.1 (<https://openfontlicense.org>); the license text
accompanies each font in `vendor/licenses/`.
