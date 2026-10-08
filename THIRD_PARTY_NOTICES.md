# Third-party notices / 第三方说明

The root MIT license covers project-authored source and documentation. It does not replace dependency licenses or grant rights in imported notes, courseware, papers, trademarks, user submissions or separately downloaded runtime/installer binaries.

## Included files

- PDF.js worker: `public/vendor/pdf.worker-6.3.289.mjs`; Apache-2.0 notice is preserved in `public/vendor/pdfjs-LICENSE.txt`. The preparation script refreshes both files from the locked upstream package.
- Python logo: retain `public/images/python-original.LICENSE.txt` with the upstream asset. MIT permission for the illustration is separate from Python trademark policy.
- The Starter Kit and the public demo/course examples are original project educational fixtures. They are not personal learning records or reproductions of a university course/published paper.

## Installed dependencies

The checked-in lockfile pins dependencies. [npm license inventory](docs/third-party/npm-licenses.json) records installed package metadata; it is an inventory, not a promise that every possible redistribution is covered. Keep upstream license files when distributing packages or bundled artifacts. Major components include React, Vinext, Vite, CodeMirror, Drizzle, KaTeX, PDF.js, ts-fsrs and Pyodide. Pyodide and its bundled Python libraries retain their own licenses, including MPL-2.0/Python and other upstream terms.

Companion source dependencies are listed in `companion/requirements.txt`: pypdf (BSD-3-Clause), keyring (MIT), and tzdata (Apache-2.0 with applicable timezone-data notices). Check the actual versions and notices in each released runtime.

## Build inputs and future releases

Windows EXE/ZIP and the packaged Python runtime are excluded from source Git. The fixed 1.41.1 maintainer download manifest supplies exact file sizes and hashes for current build checks; downloading a file does not execute it or declare it a new MIT-licensed release.

Before independently publishing a binary, include the project LICENSE and these notices, the runtime's Python/dependency licenses, actual source/version mapping and SHA-256 checksums. Test packaging and installation separately. This initial public repository publishes source, not a newly audited binary release.

## 中文

根 MIT 只覆盖项目原创源码与文档，不覆盖依赖、用户资料、课程课件、论文、商标或独立发行的运行环境。请保留上游许可。公开示例为原创合成材料，不是学习成绩或真实研究证据。

发行安装包前必须核对实际依赖许可，附项目许可、第三方说明、源码对应关系与校验值，并单独完成打包和安装验收。公共源码首次发布不等于已发行新的开源二进制。
