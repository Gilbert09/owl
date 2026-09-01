/**
 * Load an image file, downscale it to fit within `maxDim` px (aspect ratio
 * preserved), and return a PNG data URL. Keeps inline-stored logos small.
 *
 * The file is read as a data: URL, not as an object URL. Both app shells send
 * a CSP with `img-src 'self' data: …`, and `'self'` does not cover the blob:
 * scheme. The browser refused every blob: object URL, so the image never
 * loaded and each upload failed with "Could not read that image."
 */
export function downscaleImage(file: File, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('no canvas context'));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('could not load image'));
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
