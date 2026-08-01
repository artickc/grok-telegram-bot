/**
 * Discover a best-effort project icon (favicon, web assets, MSIX/store logos).
 * Used when creating forum topics: Telegram cannot set arbitrary topic avatars
 * from files, so we pin the image inside the topic as a visual stand-in.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const IMAGE_EXT = new Set([".ico", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"]);

const ROOT_CANDIDATES = [
  "favicon.ico",
  "favicon.png",
  "favicon.svg",
  "apple-touch-icon.png",
  "apple-touch-icon-precomposed.png",
  "logo.png",
  "logo.svg",
  "icon.png",
  "icon.ico",
  "app-icon.png",
];

const SUBDIR_CANDIDATES = [
  ["public", "favicon.ico"],
  ["public", "favicon.png"],
  ["public", "apple-touch-icon.png"],
  ["static", "favicon.ico"],
  ["assets", "favicon.ico"],
  ["assets", "favicon.png"],
  ["assets", "logo.png"],
  ["Assets", "StoreLogo.png"],
  ["Assets", "Square44x44Logo.png"],
  ["Assets", "Square150x150Logo.png"],
  ["Assets", "LockScreenLogo.png"],
  ["Images", "logo.png"],
  ["images", "logo.png"],
  ["images", "icon.png"],
  ["src", "assets", "logo.png"],
  ["src", "assets", "favicon.ico"],
];

/** Prefer larger / more “logo-like” MSIX asset names. */
const MSIX_NAME_RE =
  /StoreLogo|Square\d+x\d+Logo|Wide\d+x\d+Logo|BadgeLogo|AppList|logo|icon|favicon/i;

/**
 * Return the best absolute icon path for a project directory, or undefined.
 */
export function discoverProjectIcon(projectPath: string): string | undefined {
  if (!projectPath || !existsSync(projectPath)) return undefined;

  for (const rel of ROOT_CANDIDATES) {
    const p = join(projectPath, rel);
    if (isImageFile(p)) return p;
  }
  for (const parts of SUBDIR_CANDIDATES) {
    const p = join(projectPath, ...parts);
    if (isImageFile(p)) return p;
  }

  // MSIX / WinUI: scan Assets for logo-like files.
  const assetsDir = join(projectPath, "Assets");
  const fromAssets = pickBestImageInDir(assetsDir);
  if (fromAssets) return fromAssets;

  // Package.appxmanifest Logo="Assets\..."
  const fromManifest = iconFromAppxManifest(projectPath);
  if (fromManifest) return fromManifest;

  // Store listing folders (common in this workspace).
  for (const sub of ["StoreListing", "store-listing", "listing", "media"]) {
    const hit = pickBestImageInDir(join(projectPath, sub));
    if (hit) return hit;
  }

  return undefined;
}

function iconFromAppxManifest(projectPath: string): string | undefined {
  const manifest = join(projectPath, "Package.appxmanifest");
  if (!existsSync(manifest)) return undefined;
  let xml: string;
  try {
    xml = readFileSync(manifest, "utf-8");
  } catch {
    return undefined;
  }
  // Logo="Assets\StoreLogo.png" or Logo="Assets/StoreLogo.png"
  const re = /\b(?:Logo|Square\d+x\d+Logo|Wide\d+x\d+Logo|StoreLogo)\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((m = re.exec(xml))) {
    const rel = m[1]!.replace(/\\/g, "/");
    candidates.push(join(projectPath, rel));
  }
  for (const p of candidates) {
    if (isImageFile(p)) return p;
  }
  return undefined;
}

function pickBestImageInDir(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const scored: Array<{ path: string; score: number; size: number }> = [];
  for (const name of names) {
    const p = join(dir, name);
    if (!isImageFile(p)) continue;
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      continue;
    }
    let score = 0;
    if (MSIX_NAME_RE.test(name)) score += 50;
    if (/StoreLogo/i.test(name)) score += 30;
    if (/favicon/i.test(name)) score += 40;
    if (extname(name).toLowerCase() === ".png") score += 5;
    // Prefer mid-size icons over tiny badges / huge splash.
    if (size > 2_000 && size < 500_000) score += 10;
    scored.push({ path: p, score, size });
  }
  if (scored.length === 0) return undefined;
  scored.sort((a, b) => b.score - a.score || b.size - a.size);
  return scored[0]!.path;
}

function isImageFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    if (!statSync(p).isFile()) return false;
  } catch {
    return false;
  }
  return IMAGE_EXT.has(extname(p).toLowerCase()) || basename(p).toLowerCase() === "favicon.ico";
}
