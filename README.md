# ezScan

A private, browser-based document scanner. Capture or upload multiple pages, automatically frame each document, enhance its appearance, and export a searchable PDF or a ZIP of individual pages. Photos and recognized text are processed on your device.

## Run locally

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080`. Camera access needs localhost or HTTPS. The app loads its libraries, fonts, and English/Indonesian OCR language data from external providers; it does not upload document content.

## Scan a document

1. **Capture:** use the portrait 3:4 camera or upload photos. The viewfinder shrinks to leave room for the camera controls when mobile browser bars are open.
2. **Crop & Filter:** page bounds are suggested automatically. Adjust the handles if needed, then select **Apply crop** to see the cropped page as it will appear in the PDF. **Edit crop** reopens the original image with your saved selection. **Auto crop** retries detection; **Reset** restores the full image.
3. Choose **B&W**, **Color**, or **Original**. One enhancement slider controls the effect strength. Filters never overwrite the original photo.
4. **Create PDF:** text recognition runs on-device in English and Indonesian. Keep the tab open until it finishes. Download the combined PDF or separate PDFs in a ZIP.

Automatic framing uses a rectangular document region. When the page cannot be distinguished confidently from the background, the full image is retained for manual framing. It does not straighten perspective.

## Files

- `index.html`: capture, crop, processing, and result screens.
- `css/styles.css`: responsive layout and touch controls.
- `js/document-crop.js`: document-bound detection on a downsampled image.
- `js/app.js`: camera, page state, previews, filters, OCR, PDF, and ZIP export.
- `tests/scan.cjs`: browser checks for filtering, cropping, automatic framing, previews, and mobile layout.

Input images are limited to 2000 pixels on their longest edge. The camera targets 20–25 FPS. PDF pages preserve the cropped image proportions within A4 dimensions.

## Tests

```sh
npm install
npm test
```

On macOS the test uses the installed Google Chrome. On other platforms install Playwright’s Chromium with `npx playwright install chromium`. Tests need internet access to load the app’s CDN libraries. Mobile checks simulate a camera and reduced viewport heights; they do not replace testing on a physical iPhone with Safari.

For debugging, inspect `ezScan.state` and `window.__ezErrors` in the browser console.
