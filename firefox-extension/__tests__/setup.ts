// Jest setup: a mocked `browser` global. Storage is a working in-memory store so config
// reads and writes behave like the real thing; everything else is a jest.fn per test.

const store: Record<string, unknown> = {};

function event() {
  return { addListener: jest.fn(), removeListener: jest.fn() };
}

const mockBrowser = {
  tabs: {
    create: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    get: jest.fn(),
    executeScript: jest.fn(),
    move: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
    group: jest.fn(),
    ungroup: jest.fn().mockResolvedValue(undefined),
    discard: jest.fn().mockResolvedValue(undefined),
    goBack: jest.fn().mockResolvedValue(undefined),
    goForward: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    captureVisibleTab: jest.fn(),
    onUpdated: event(),
    onRemoved: event(),
    onCreated: event(),
    onActivated: event(),
  },
  tabGroups: {
    get: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    move: jest.fn(),
    onCreated: event(),
    onUpdated: event(),
    onRemoved: event(),
  },
  windows: {
    get: jest.fn().mockResolvedValue({ id: 1, incognito: false, focused: true }),
    getAll: jest.fn().mockResolvedValue([{ id: 1, incognito: false, focused: true }]),
    getLastFocused: jest.fn().mockResolvedValue({ id: 1, incognito: false, focused: true }),
    create: jest.fn(),
  },
  contextualIdentities: {
    query: jest.fn().mockResolvedValue([]),
  },
  browserAction: {
    setBadgeText: jest.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: jest.fn().mockResolvedValue(undefined),
    setTitle: jest.fn().mockResolvedValue(undefined),
  },
  bookmarks: {
    getTree: jest.fn(),
    search: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    move: jest.fn(),
    remove: jest.fn(),
  },
  history: {
    search: jest.fn().mockResolvedValue([]),
  },
  find: {
    find: jest.fn(),
    highlightResults: jest.fn(),
  },
  storage: {
    local: {
      get: jest.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
      set: jest.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, JSON.parse(JSON.stringify(items)));
      }),
    },
    onChanged: event(),
  },
  permissions: {
    contains: jest.fn().mockResolvedValue(true),
  },
  runtime: {
    getURL: jest.fn((path: string) => `moz-extension://test/${path}`),
    getManifest: jest.fn(() => ({ version: "2.0.0" })),
  },
};

Object.defineProperty(global, "browser", {
  value: mockBrowser,
  writable: true,
  configurable: true,
});

export function resetStore(initial: Record<string, unknown> = {}) {
  for (const key of Object.keys(store)) delete store[key];
  Object.assign(store, JSON.parse(JSON.stringify(initial)));
}

export function readStore(key: string): unknown {
  return store[key];
}

export { mockBrowser };

// jsdom doesn't implement scrolling
Element.prototype.scrollIntoView = jest.fn();
window.scrollTo = jest.fn() as unknown as typeof window.scrollTo;
window.scrollBy = jest.fn() as unknown as typeof window.scrollBy;
