import { chromium, Browser, BrowserContext } from 'playwright';

// Singleton browser instance for test suite
let browser: Browser | null = null;
let context: BrowserContext | null = null;

// Minimal HTML template for bpmn-js rendering
const HTML_TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
  <style>
    html, body, #canvas {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: white;
    }
  </style>
</head>
<body>
  <div id="canvas"></div>
  <script src="https://unpkg.com/bpmn-js@17/dist/bpmn-viewer.production.min.js"></script>
  <script>
    window.renderBpmn = async function(xml) {
      const viewer = new BpmnJS({ container: '#canvas' });
      await viewer.importXML(xml);
      const canvas = viewer.get('canvas');
      canvas.zoom('fit-viewport');

      // Return diagram dimensions for screenshot
      const bbox = canvas.viewbox();
      return {
        width: Math.ceil(bbox.outer.width),
        height: Math.ceil(bbox.outer.height)
      };
    };
  </script>
</body>
</html>
`;

export async function initBrowser(): Promise<void> {
  if (browser) return;

  browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--no-sandbox'],
  });
  context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
}

export async function closeBrowser(): Promise<void> {
  if (context) await context.close();
  if (browser) await browser.close();
  browser = null;
  context = null;
}

export async function renderBpmnToPng(
  xml: string,
  outputPath: string
): Promise<void> {
  if (!context) {
    throw new Error('Browser not initialized. Call initBrowser() first.');
  }

  const page = await context.newPage();

  try {
    // Load HTML template
    await page.setContent(HTML_TEMPLATE, { waitUntil: 'networkidle' });

    // Render BPMN and get dimensions
    const dimensions = await page.evaluate(async (bpmnXml) => {
      return await (window as unknown as { renderBpmn: (xml: string) => Promise<{ width: number; height: number }> }).renderBpmn(bpmnXml);
    }, xml);

    // Resize viewport to fit diagram with padding
    const padding = 40;
    await page.setViewportSize({
      width: Math.max(800, dimensions.width + padding * 2),
      height: Math.max(600, dimensions.height + padding * 2),
    });

    // Take screenshot of the canvas element
    const canvas = page.locator('#canvas');
    await canvas.screenshot({
      path: outputPath,
      type: 'png',
    });
  } finally {
    await page.close();
  }
}
