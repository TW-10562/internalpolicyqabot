/**
 * Polyfills for DOM APIs required by pdfjs-dist in Node.js environment
 */
import { createRequire } from 'node:module';

// Node 18/20 compatibility shim for dependencies expecting Node 22's process.getBuiltinModule.
if (typeof (process as any).getBuiltinModule !== 'function') {
  const requireFromHere = createRequire(__filename);
  Object.defineProperty(process, 'getBuiltinModule', {
    value: (id: string) => {
      const mod = String(id || '').replace(/^node:/, '');
      if (!mod) return undefined;
      try {
        return requireFromHere(`node:${mod}`);
      } catch {
        try {
          return requireFromHere(mod);
        } catch {
          return undefined;
        }
      }
    },
    writable: false,
    configurable: true,
  });
}

// Polyfill DOMMatrix
if (typeof globalThis.DOMMatrix === 'undefined') {
  class DOMMatrix {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;

    constructor(elements?: number[] | string) {
      if (!elements || elements.length === 0) {
        // identity matrix
        this.a = 1;
        this.b = 0;
        this.c = 0;
        this.d = 1;
        this.e = 0;
        this.f = 0;
      } else if (typeof elements === 'number' && arguments.length === 6) {
        this.a = arguments[0];
        this.b = arguments[1];
        this.c = arguments[2];
        this.d = arguments[3];
        this.e = arguments[4];
        this.f = arguments[5];
      } else {
        // Simplified: assume identity matrix for string or array input
        this.a = 1;
        this.b = 0;
        this.c = 0;
        this.d = 1;
        this.e = 0;
        this.f = 0;
      }
    }

    toString(): string {
      return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
    }
  }

  Object.defineProperty(globalThis, 'DOMMatrix', {
    value: DOMMatrix,
    writable: true,
    configurable: true,
  });
}

// Polyfill ImageData
if (typeof globalThis.ImageData === 'undefined') {
  class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    colorSpace: string;

    constructor(
      data: Uint8ClampedArray | Uint8Array,
      width: number,
      height?: number,
      settings?: { colorSpace?: string }
    ) {
      this.data = new Uint8ClampedArray(data);
      this.width = width;
      this.height = height ?? data.length / (width * 4);
      this.colorSpace = settings?.colorSpace ?? 'srgb';
    }
  }

  Object.defineProperty(globalThis, 'ImageData', {
    value: ImageData,
    writable: true,
    configurable: true,
  });
}

// Polyfill Path2D
if (typeof globalThis.Path2D === 'undefined') {
  class Path2D {
    constructor(path?: Path2D | string) {
      // Simplified polyfill - empty implementation
    }
  }

  Object.defineProperty(globalThis, 'Path2D', {
    value: Path2D,
    writable: true,
    configurable: true,
  });
}

// Polyfill Canvas-related APIs if needed
if (typeof globalThis.CanvasRenderingContext2D === 'undefined') {
  class CanvasRenderingContext2D {
    constructor() {
      // Empty implementation
    }
  }

  Object.defineProperty(globalThis, 'CanvasRenderingContext2D', {
    value: CanvasRenderingContext2D,
    writable: true,
    configurable: true,
  });
}
