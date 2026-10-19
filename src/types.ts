export interface Viewport {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
}

export interface MaskIntersection {
  /** Selector that bounds the dynamic content on one axis (e.g. a scrollable tbody). */
  contentSelector: string;
  /** Selector that bounds the visible, clipped region on the other axis (e.g. the scroll container). */
  containerSelector: string;
}

export interface CaptureOptions {
  fullPage?: boolean;
  waitForSelector?: string;
  waitForTimeout?: number;
  /** Substring matched against a response URL; capture waits for it before proceeding. */
  waitForResponse?: string;
  waitForResponseTimeout?: number;
  /** Selector whose text content must read identically on two consecutive polls before capture. */
  stabilizeSelector?: string;
  stabilizeTimeout?: number;
  hideSelectors?: string[];
  maskSelectors?: string[];
  /** Masks the geometric intersection of two selectors' boxes — see MaskIntersection. */
  maskIntersections?: MaskIntersection[];
  navigationTimeout?: number;
  clickSelectors?: string[];
  storageStatePath?: string;
}

export interface Screenshot {
  id: string;
  name: string;
  url: string;
  viewport: Viewport;
  path: string;
  timestamp: string;
  fullPage: boolean;
  captureTimeMs: number;
}

export type DiffStatus =
  | 'baseline-created'
  | 'baseline-updated'
  | 'identical'
  | 'passed'
  | 'failed'
  | 'size-mismatch';

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  diffPixelCount: number;
  significance: 'low' | 'medium' | 'high';
}

export interface VisualDiffResult {
  name: string;
  viewport: string;
  url?: string;
  status: DiffStatus;
  passed: boolean;
  similarity: number;
  perceptualSimilarity?: number;
  diffPixelCount: number;
  totalPixels: number;
  diffPercentage: number;
  threshold: number;
  width: number;
  height: number;
  regions: DiffRegion[];
  baselinePath: string;
  currentPath: string;
  diffImagePath?: string;
  durationMs: number;
  error?: string;
}

export interface PageTarget {
  name: string;
  url: string;
  fullPage?: boolean;
  waitForSelector?: string;
  waitForTimeout?: number;
  waitForResponse?: string;
  waitForResponseTimeout?: number;
  stabilizeSelector?: string;
  stabilizeTimeout?: number;
  hideSelectors?: string[];
  maskSelectors?: string[];
  maskIntersections?: MaskIntersection[];
  clickSelectors?: string[];
}

export interface AuthConfig {
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  username?: string;
  password?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  waitForSelector?: string;
  waitForTimeout?: number;
  storageStatePath?: string;
  reuseExisting?: boolean;
}

export interface RunConfig {
  baseUrl?: string;
  pages: PageTarget[];
  /** Defaults to `['mobile-m', 'tablet', 'desktop-l']` if omitted. */
  viewports?: string[];
  threshold?: number;
  pixelSensitivity?: number;
  outputDir?: string;
  updateBaselines?: boolean;
  auth?: AuthConfig;
}
