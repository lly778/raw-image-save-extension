# Raw Image Save To Folder

One Chrome extension for saving chapter images from MangaRaw and Soraraw, including complete manga downloads from directory pages.

## Supported Sites

- `https://mangaraw.ac/manga/*/*`
- `https://soraraw.com/manga/*/ch-*`

MangaRaw pages use the existing canvas reconstruction workflow. Soraraw pages decode the encrypted chapter image manifest and save the original WebP files.

## Install

1. Open `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this `chrome-extension` folder

## Use

### One Chapter

1. Open a supported chapter page.
2. Click the floating `Save To Folder` button.
3. In the worker tab, click `Choose Folder And Continue`.

### All Chapters

1. Open a manga directory/detail page.
2. Click `Download Chapters (N)`.
3. Choose the chapters to download in the worker tab. All chapters are selected by default, and the list can be searched, selected, or cleared.
4. Choose one destination folder.

All images are saved directly into that folder. Filenames use chapter sequence, chapter label, and page sequence, for example `0001 - Chapter 1 - 001.webp`, so normal filename sorting keeps the manga in reading order.

Soraraw chapters are resolved directly by the worker. MangaRaw chapters are rendered one at a time in a temporary background tab because its reader reconstructs pages with canvas. Failed chapters are reported and the queue continues.

Chrome requires that direct click in the worker tab before it allows folder access.
