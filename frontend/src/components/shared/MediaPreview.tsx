import { isVideoSrc } from '../../utils/media';

export interface MediaPreviewProps {
  src: string;
  mime_type?: string | null;
  alt?: string;
  className?: string;
  /** Whether the `<video>` shows native controls (default true, video only). */
  controls?: boolean;
}

/**
 * Drop-in for `<img>` that renders `<video controls>` when the src or
 * mime_type identifies a video asset, and `<img>` otherwise. Callers resolve
 * the src exactly as they would for an image — `resolveImageSrc` is
 * media-agnostic and already produces correct URLs for video.
 */
export function MediaPreview({
  src,
  mime_type,
  alt,
  className,
  controls = true,
}: MediaPreviewProps): JSX.Element {
  if (isVideoSrc(src, mime_type)) {
    // preload="metadata": no-controls thumbnails paint a first frame without
    // buffering the whole file; controls=true surfaces still play on demand.
    return <video src={src} controls={controls} preload="metadata" className={className} />;
  }
  return <img src={src} alt={alt} loading="lazy" decoding="async" className={className} />;
}
