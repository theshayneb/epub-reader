import {
  isBlobResourceUrl,
  prefetchBlobUrlsFromText,
  readBlobUrlAsArrayBuffer,
  readBlobUrlAsText,
  readResourceUrlAsBinary,
  readResourceUrlAsText,
} from "./blob-url-text";
import { sanitizePublicationMarkup } from "./sanitizer";

const REMOTE_URL = /^(?:https?:)?\/\//i;

/**
 * Inlined resources for the open book, keyed by a SHA-256 fingerprint of their content. Foliate gives a
 * resource a new Blob URL whenever it reloads it, so URLs cannot be the key; content can. Each image,
 * font and stylesheet is then converted once per book instead of on every chapter load. Bounded by size,
 * least recently used first, and cleared when the book closes.
 */
const resourceCache = new Map<string, Promise<string | null>>();
const resourceSizes = new Map<string, number>();
let cachedLength = 0;
const CACHE_LIMIT_CHARS = 48 * 1024 * 1024;

export function clearInlinedResourceCache(): void {
  resourceCache.clear();
  resourceSizes.clear();
  cachedLength = 0;
}

async function contentKey(kind: string, content: Uint8Array | string): Promise<string | null> {
  const subtle = window.crypto?.subtle;
  if (!subtle) return null;
  try {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    return `${kind}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

function cachedResource(key: string | null, load: () => Promise<string | null>): Promise<string | null> {
  if (!key) return load();
  const hit = resourceCache.get(key);
  if (hit) {
    // Refresh its place so the least recently used entries are evicted first.
    resourceCache.delete(key);
    resourceCache.set(key, hit);
    return hit;
  }
  const promise = load().then((value) => {
    const size = value?.length ?? 0;
    if (resourceCache.get(key) === promise) {
      resourceSizes.set(key, size);
      cachedLength += size;
      for (const oldest of resourceCache.keys()) {
        if (cachedLength <= CACHE_LIMIT_CHARS || oldest === key) break;
        cachedLength -= resourceSizes.get(oldest) ?? 0;
        resourceSizes.delete(oldest);
        resourceCache.delete(oldest);
      }
    }
    return value;
  }, (error: unknown) => {
    resourceCache.delete(key);
    throw error;
  });
  resourceCache.set(key, promise);
  return promise;
}

function parserType(mediaType: string): DOMParserSupportedType {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized.includes("svg")) return "image/svg+xml";
  if (normalized.includes("xhtml")) return "application/xhtml+xml";
  return normalized.includes("html") ? "text/html" : "application/xhtml+xml";
}

function inferMediaType(markup: string): string {
  return /<html[^>]*xmlns\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/i.test(markup)
    ? "application/xhtml+xml"
    : "text/html";
}

function parseMarkup(markup: string, type: DOMParserSupportedType): Document {
  const document = new DOMParser().parseFromString(markup, type);
  if (!document.querySelector("parsererror") || type === "text/html") return document;
  return new DOMParser().parseFromString(markup, "text/html");
}

async function readTextResource(url: string): Promise<string> {
  try {
    return isBlobResourceUrl(url)
      ? await readBlobUrlAsText(url)
      : await readResourceUrlAsText(url);
  } catch {
    return "";
  }
}

async function readBinaryResource(url: string) {
  try {
    return isBlobResourceUrl(url)
      ? await readBlobUrlAsArrayBuffer(url)
      : await readResourceUrlAsBinary(url);
  } catch {
    return null;
  }
}

function binaryToDataUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(typeof reader.result === "string" ? reader.result : ""));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to inline Blob resource")));
    reader.readAsDataURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
  });
}

async function blobResourceDataUrl(url: string): Promise<string | null> {
  const resource = await readBinaryResource(url);
  if (!resource?.bytes.length) return null;
  const key = await contentKey(`data:${resource.mimeType}`, resource.bytes);
  return cachedResource(key, () => binaryToDataUrl(resource.bytes, resource.mimeType));
}

async function inlineCssImports(css: string, visited: Set<string>): Promise<string> {
  const pattern = /@import\s+(?:url\()?\s*(['"]?)([^'"\s)]+)\1\s*\)?\s*;/gi;
  let output = css;
  for (const match of [...css.matchAll(pattern)]) {
    const url = (match[2] ?? "").trim();
    if (!isBlobResourceUrl(url)) {
      if (REMOTE_URL.test(url)) output = output.replace(match[0], "");
      continue;
    }
    if (visited.has(url)) {
      output = output.replace(match[0], "");
      continue;
    }
    visited.add(url);
    const imported = await readTextResource(url);
    const expanded = imported ? await inlineCssImports(imported, visited) : "";
    output = output.replace(match[0], expanded);
  }
  return output;
}

async function inlineCssBlobUrls(css: string): Promise<string> {
  const pattern = /url\(\s*(['"]?)(blob:[^'"\s)]+)\1\s*\)/gi;
  const matches = [...css.matchAll(pattern)];
  const urls = [...new Set(matches.map((match) => (match[2] ?? "").trim()))];
  // Convert every referenced resource (images, fonts) at once rather than one after another.
  const dataUrls = await Promise.all(urls.map((url) => blobResourceDataUrl(url)));
  const replacements = new Map(urls.map((url, index) => [url, dataUrls[index]]));
  let output = css;
  for (const match of matches) {
    const replacement = replacements.get((match[2] ?? "").trim());
    if (replacement) output = output.replace(match[0], `url("${replacement}")`);
  }
  return output;
}

function stripUnsupportedCss(css: string): string {
  return css
    .replace(/@import\s+(?:url\()?\s*(['"]?)(?:https?:)?\/\/[^;]+;?/gi, "")
    .replace(/url\(\s*(['"]?)(?:https?:)?\/\/[^)]*\)/gi, "url()")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/-moz-binding\s*:[^;]+;?/gi, "");
}

async function normalizeCssUncached(css: string): Promise<string> {
  await prefetchBlobUrlsFromText(css);
  const imports = await inlineCssImports(css, new Set());
  return stripUnsupportedCss(await inlineCssBlobUrls(imports));
}

async function normalizeCss(css: string): Promise<string> {
  if (!css.trim()) return css;
  return await cachedResource(await contentKey("css", css), () => normalizeCssUncached(css)) ?? "";
}

function removeBlockingMeta(document: Document): void {
  for (const meta of [...document.querySelectorAll("meta[http-equiv]")]) {
    const value = meta.getAttribute("http-equiv")?.trim().toLowerCase();
    if (value === "content-security-policy" || value === "refresh") meta.remove();
  }
}

function createStyleElement(document: Document, css: string, source: Element): Element {
  const style = document.createElementNS(
    document.documentElement?.namespaceURI || "http://www.w3.org/1999/xhtml",
    "style",
  );
  style.setAttribute("type", "text/css");
  style.setAttribute("data-omni-inline-stylesheet", "true");
  const media = source.getAttribute("media");
  if (media) style.setAttribute("media", media);
  style.textContent = css;
  return style;
}

async function inlineStylesheets(document: Document): Promise<void> {
  await Promise.all([...document.querySelectorAll("style")].map(async (style) => {
    style.textContent = await normalizeCss(style.textContent ?? "");
  }));
  await Promise.all([...document.querySelectorAll('link[rel~="stylesheet"][href]')].map(async (link) => {
    const url = link.getAttribute("href")?.trim() ?? "";
    if (REMOTE_URL.test(url)) {
      link.remove();
      return;
    }
    if (!isBlobResourceUrl(url)) return;
    const css = await readTextResource(url);
    if (!css) {
      link.remove();
      return;
    }
    link.replaceWith(createStyleElement(document, await normalizeCss(css), link));
  }));
}

async function inlineImages(document: Document): Promise<void> {
  await Promise.all([...document.querySelectorAll("img[src]")].map(async (image) => {
    const url = image.getAttribute("src")?.trim() ?? "";
    if (!isBlobResourceUrl(url)) return;
    const dataUrl = await blobResourceDataUrl(url);
    if (dataUrl) image.setAttribute("src", dataUrl);
  }));
}

async function inlineStyleAttributes(document: Document): Promise<void> {
  for (const element of [...document.querySelectorAll("[style]")]) {
    const style = element.getAttribute("style") ?? "";
    if (isBlobResourceUrl(style) || style.toLowerCase().includes("blob:")) {
      element.setAttribute("style", await inlineCssBlobUrls(style));
    }
  }
}

/** Build self-contained, inert markup suitable for Android iframe.srcdoc. */
export async function inlineFoliateBlobMarkup(markup: string, mediaType?: string): Promise<string> {
  await prefetchBlobUrlsFromText(markup);
  const resolvedType = mediaType || inferMediaType(markup);
  const type = parserType(resolvedType);
  let document: Document;
  try {
    const sanitized = sanitizePublicationMarkup(markup, resolvedType);
    document = parseMarkup(sanitized, type);
  } catch {
    return markup;
  }

  removeBlockingMeta(document);
  await inlineStylesheets(document);
  await inlineImages(document);
  await inlineStyleAttributes(document);

  const serialized = type === "text/html"
    ? document.documentElement.outerHTML
    : new XMLSerializer().serializeToString(document);
  return type === "text/html" ? `<!doctype html>\n${serialized}` : serialized;
}
