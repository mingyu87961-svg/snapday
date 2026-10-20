# Third-party OCR assets

These files are distributed locally so browser OCR does not need external CDNs or an API key.

| Files | Upstream source | Version | Included license |
| --- | --- | --- | --- |
| tesseract.min.js, worker.min.js | https://github.com/naptha/tesseract.js | 6.0.1 | [TESSERACT-LICENSE.txt](TESSERACT-LICENSE.txt) |
| tesseract-core*.wasm, tesseract-core*.wasm.js | https://github.com/naptha/tesseract.js-core | 6.0.0 | [TESSERACT-CORE-LICENSE.txt](TESSERACT-CORE-LICENSE.txt) |
| chi_sim.traineddata.gz | @tesseract.js-data/chi_sim, 4.0.0_best_int | 1.0.0 | [TESSDATA-LICENSE.txt](TESSDATA-LICENSE.txt) |
| eng.traineddata.gz | @tesseract.js-data/eng, 4.0.0_best_int | 1.0.0 | [TESSDATA-LICENSE.txt](TESSDATA-LICENSE.txt) |

Tesseract.js, Tesseract.js Core, and the language-data distribution are licensed under Apache-2.0. The license copies listed above apply to the corresponding third-party assets, not to Snapday's original application code.

## Language-data provenance

`chi_sim.traineddata.gz` and `eng.traineddata.gz` are the simplified-Chinese and English `4.0.0_best_int` models distributed by the official Tesseract.js data project. Its [upstream README](https://github.com/naptha/tessdata/blob/gh-pages/README.md) identifies this set as an integerized version of Tessdata Best and documents the language-specific `@tesseract.js-data/{lang}` npm packages. The corresponding upstream files are in [naptha/tessdata/4.0.0_best_int](https://github.com/naptha/tessdata/tree/gh-pages/4.0.0_best_int); the underlying Best model project is [tesseract-ocr/tessdata_best](https://github.com/tesseract-ocr/tessdata_best).

[TESSDATA-LICENSE.txt](TESSDATA-LICENSE.txt) is an unmodified copy of the data distributor's [official Apache-2.0 license](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE), retrieved on 2026-10-21. The upstream data repository does not list a separate root NOTICE file.

The upstream precompiled files and compressed language models are redistributed without modifications by Snapday. The application chooses the LSTM engine and defaults to automatic page segmentation; users can optionally select sparse-text segmentation. Scalar and SIMD variants are retained for browser compatibility.
