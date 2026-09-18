# Raw Image Save To Folder

One Chrome extension for saving chapter images from MangaRaw and Soraraw.

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

1. Open a supported chapter page.
2. Click the floating `Save To Folder` button.
3. In the worker tab, click `Choose Folder And Continue`.

Chrome requires that direct click in the worker tab before it allows folder access.
