import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { downscaleImage } from '../lib/imageDownscale';

/**
 * Workspace-logo uploads go through this. The original version passed a blob:
 * object URL to an <img>, which the app's own CSP refused: index.html and
 * vercel.json both send `img-src 'self' data: …`, and `'self'` does not cover
 * the blob: scheme. The image never decoded, so every upload reported "Could
 * not read that image" while Shuffle (no image) kept working.
 *
 * The scheme is the invariant under test — the downscale maths only guards
 * the size cap the backend enforces.
 */

let drawnTo: Array<{ w: number; h: number }> = [];
let imageSrcs: string[] = [];
let canvases: HTMLCanvasElement[] = [];
let decodeFails = false;
let naturalSize = { width: 512, height: 256 };

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 0;
  height = 0;

  set src(value: string) {
    imageSrcs.push(value);
    if (decodeFails) {
      queueMicrotask(() => this.onerror?.());
      return;
    }
    this.width = naturalSize.width;
    this.height = naturalSize.height;
    queueMicrotask(() => this.onload?.());
  }
}

const realImage = globalThis.Image;
const realGetContext = HTMLCanvasElement.prototype.getContext;
const realToDataURL = HTMLCanvasElement.prototype.toDataURL;
const realCreateObjectURL = URL.createObjectURL;
const createObjectURL = vi.fn(() => 'blob:stub');

function pngFile(name = 'logo.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

function stubCanvas(ctx: unknown) {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    canvases.push(this);
    return ctx;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

describe('downscaleImage', () => {
  beforeEach(() => {
    drawnTo = [];
    imageSrcs = [];
    canvases = [];
    decodeFails = false;
    naturalSize = { width: 512, height: 256 };
    createObjectURL.mockClear();

    globalThis.Image = FakeImage as unknown as typeof Image;
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    stubCanvas({
      drawImage: (_img: unknown, _x: number, _y: number, w: number, h: number) =>
        drawnTo.push({ w, h }),
    });
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,STUB';
  });

  afterEach(() => {
    globalThis.Image = realImage;
    URL.createObjectURL = realCreateObjectURL;
    HTMLCanvasElement.prototype.getContext = realGetContext;
    HTMLCanvasElement.prototype.toDataURL = realToDataURL;
  });

  it('decodes the file from a data: URL, which the CSP allows', async () => {
    const result = await downscaleImage(pngFile(), 256);

    expect(imageSrcs).toHaveLength(1);
    expect(imageSrcs[0].startsWith('data:image/png;base64,')).toBe(true);
    expect(result).toBe('data:image/png;base64,STUB');
  });

  it('never mints a blob: object URL — `self` does not cover that scheme', async () => {
    await downscaleImage(pngFile(), 256);

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(imageSrcs.some((src) => src.startsWith('blob:'))).toBe(false);
  });

  it.each<[string, number, number, number, number, number]>([
    ['landscape shrinks on its long edge', 512, 256, 256, 256, 128],
    ['portrait shrinks on its long edge', 256, 512, 256, 128, 256],
    ['square shrinks to the cap', 4000, 4000, 256, 256, 256],
    ['a smaller image is never upscaled', 100, 80, 256, 100, 80],
    ['an exact-size image is left alone', 256, 256, 256, 256, 256],
    ['a sub-pixel edge still rounds to 1px', 1000, 1, 256, 256, 1],
  ])('%s', async (_label, width, height, maxDim, expectedW, expectedH) => {
    naturalSize = { width, height };

    await downscaleImage(pngFile(), maxDim);

    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBe(expectedW);
    expect(canvases[0].height).toBe(expectedH);
    expect(drawnTo).toEqual([{ w: expectedW, h: expectedH }]);
  });

  it('rejects when the file is not a decodable image', async () => {
    decodeFails = true;

    await expect(downscaleImage(pngFile('notes.txt'), 256)).rejects.toThrow(
      /could not load image/,
    );
  });

  it('rejects when the canvas has no 2d context', async () => {
    stubCanvas(null);

    await expect(downscaleImage(pngFile(), 256)).rejects.toThrow(/no canvas context/);
  });
});
