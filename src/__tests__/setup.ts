import { vi } from "vitest";

// Mock ResizeObserver
class MockResizeObserver {
  callback: any;
  constructor(cb: any) {
    this.callback = cb;
  }
  observe = (target: any) => {
    if (this.callback) {
      this.callback([
        {
          target,
          contentRect: { width: 400, height: 800, top: 0, left: 0, bottom: 800, right: 400 },
          borderBoxSize: [{ inlineSize: 400, blockSize: 800 }],
        },
      ]);
    }
  };
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.ResizeObserver = MockResizeObserver as any;
globalThis.ResizeObserver = MockResizeObserver as any;

// Mock offsetWidth, offsetHeight, clientHeight for jsdom
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 400;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return 800;
  },
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get() {
    return 800;
  },
});

// Mock alert / confirm
window.alert = vi.fn();
window.confirm = vi.fn(() => true);

// Mock clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(""),
  },
});

// Mock pointer capture and canvas for PDF page interaction
HTMLElement.prototype.setPointerCapture = vi.fn();
HTMLElement.prototype.releasePointerCapture = vi.fn();
HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
  drawImage: vi.fn(),
  clearRect: vi.fn(),
  fillRect: vi.fn(),
}) as any;
HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue("data:image/jpeg;base64,mockImage");

// Mock getBoundingClientRect for jsdom containers
const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  const rect = origGetBoundingClientRect.call(this);
  if (rect.width === 0 && rect.height === 0) {
    return {
      top: 0,
      left: 0,
      right: 400,
      bottom: 800,
      width: 400,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => {},
    };
  }
  return rect;
};

// Mock Range getBoundingClientRect, getClientRects, and intersectsNode for jsdom
Range.prototype.getBoundingClientRect = function () {
  return {
    top: 100,
    left: 100,
    right: 300,
    bottom: 130,
    width: 200,
    height: 30,
    x: 100,
    y: 100,
    toJSON: () => {},
  };
};
Range.prototype.getClientRects = function () {
  return [this.getBoundingClientRect()] as any;
};
Range.prototype.intersectsNode = function () {
  return true;
};
Range.prototype.toString = function () {
  return this.cloneContents().textContent || "";
};
Selection.prototype.toString = function () {
  if (this.rangeCount === 0) return "";
  return this.getRangeAt(0).toString();
};
Object.defineProperty(Selection.prototype, "isCollapsed", {
  get() {
    return this.rangeCount === 0 || this.getRangeAt(0).collapsed;
  },
  configurable: true,
});

// Mock innerText for jsdom
Object.defineProperty(HTMLElement.prototype, "innerText", {
  get() {
    return this.textContent || "";
  },
  set(v: string) {
    this.textContent = v;
  },
  configurable: true,
});

// Mock window.matchMedia for themeManager
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === "db_get_cards") {
      return Promise.resolve({ items: [], total: 0, has_more: false });
    }
    if (cmd === "db_get_highlights") {
      return Promise.resolve([]);
    }
    if (cmd === "db_get_anchors") {
      return Promise.resolve([]);
    }
    if (cmd === "db_get_cards_by_anchor_ids") {
      return Promise.resolve([]);
    }
    if (cmd === "get_file_metadata") {
      return Promise.resolve({ size: 1024 * 1024 });
    }
    if (cmd === "read_file_chunk") {
      return Promise.resolve(new Uint8Array(65536));
    }
    return Promise.resolve(null);
  }),
}));

// Mock @tauri-apps/plugin-dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

// Mock pdfjs-dist
vi.mock("pdfjs-dist", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getDocument: vi.fn().mockImplementation(() => {
      const mockPage = {
        getViewport: ({ scale = 1.0 }: { scale?: number } = {}) => ({
          width: Math.floor(595 * scale),
          height: Math.floor(842 * scale),
          scale,
          convertToPdfPoint: (x: number, y: number) => [x, y],
        }),
        render: () => ({
          promise: Promise.resolve(),
          cancel: vi.fn(),
        }),
        getTextContent: () =>
          Promise.resolve({
            items: [
              {
                str: "PDF 关键论点分析与推导",
                dir: "ltr",
                width: 120,
                height: 16,
                transform: [1, 0, 0, 1, 0, 0],
              },
            ],
          }),
        cleanup: vi.fn(),
      };

      const mockDoc = {
        numPages: 2,
        getPage: vi.fn().mockResolvedValue(mockPage),
        cleanup: vi.fn(),
        destroy: vi.fn().mockResolvedValue(undefined),
      };

      return {
        promise: Promise.resolve(mockDoc),
        destroy: vi.fn().mockResolvedValue(undefined),
      };
    }),
    TextLayer: class MockTextLayer {
      constructor({ container }: any) {
        if (container) {
          const span = document.createElement("span");
          span.className = "pdf-text-item";
          span.textContent = "PDF 关键论点分析与推导";
          container.appendChild(span);
        }
      }
      render() {
        return Promise.resolve();
      }
      cancel() {}
    },
  };
});
