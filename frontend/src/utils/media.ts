/**
 * Video-aware media helpers. A video sample is stored exactly like an image
 * sample (an `ImageRef` with `mime_type = "video/*"`); these helpers let the
 * UI tell the two apart so video renders as `<video>` instead of a broken
 * `<img>`.
 */

/** File extensions treated as video assets (lowercase, with leading dot). */
export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.flv',
  '.mpg',
  '.mpeg',
  '.3gpp',
]);

function extOf(value: string): string {
  // Extract the last clean extension anywhere in the string. We must NOT
  // strip the query string first: resolveImageSrc produces proxied URLs like
  // "/api/sample-images?path=%2Fclip.mp4" where the extension lives inside
  // the query param, and asset URLs may carry their own "?v=1". An extension
  // run is only valid when followed by end-of-string or a separator.
  let last = '';
  for (const match of value.toLowerCase().matchAll(/\.([a-z0-9]{1,8})(?=$|[?#&=/])/g)) {
    last = `.${match[1]}`;
  }
  return last;
}

/**
 * True if the asset is a video, by mime_type ("video/*") or by the extension
 * of its path/uri. Works on any ImageRef-shaped object.
 */
export function isVideoAsset(ref: {
  mime_type?: string | null;
  path?: string | null;
  uri?: string | null;
}): boolean {
  if (ref.mime_type?.startsWith('video/')) return true;
  return (
    VIDEO_EXTENSIONS.has(extOf(ref.path ?? '')) ||
    VIDEO_EXTENSIONS.has(extOf(ref.uri ?? ''))
  );
}

/**
 * True if a displayable src (URL or data: URI) or explicit mime is video.
 */
export function isVideoSrc(src: string, mime_type?: string | null): boolean {
  if (mime_type?.startsWith('video/')) return true;
  if (src.startsWith('data:')) {
    const mime = /^data:([^;,]+)/.exec(src);
    return Boolean(mime && mime[1].startsWith('video/'));
  }
  return VIDEO_EXTENSIONS.has(extOf(src));
}
