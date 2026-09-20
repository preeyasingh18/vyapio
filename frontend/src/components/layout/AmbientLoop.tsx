import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/cn';

/**
 * Ambient background video.
 *
 * Built so the page is correct whether or not the video file exists. The poster
 * renders first and stays visible until the video can actually play; if the
 * file is missing, fails to decode, or the visitor prefers reduced motion, the
 * poster simply remains. Nothing is ever a broken black rectangle.
 *
 * Video assets live in /public/videos and are optional — see
 * public/videos/README.md for the specification.
 */
export function AmbientLoop({
  src,
  poster,
  className,
  caption,
}: {
  /** Path under /public. Absent or unplayable falls back to the poster. */
  src?: string;
  poster: string;
  className?: string;
  /** Described to screen readers; the video itself is decorative. */
  caption?: string;
}) {
  const reduceMotion = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || reduceMotion || !src) return;

    // autoplay can still be refused (low power mode, data saver). Treating a
    // rejected play() as a failure keeps the poster in place rather than
    // leaving a frozen first frame.
    video.play().then(
      () => setPlaying(true),
      () => setFailed(true),
    );
  }, [src, reduceMotion]);

  const showVideo = Boolean(src) && !reduceMotion && !failed;

  return (
    <figure
      className={cn(
        'relative isolate overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-sunken)]',
        className,
      )}
    >
      {/* Poster is the base layer, always present. */}
      <img
        src={poster}
        alt={caption ?? ''}
        className={cn(
          'absolute inset-0 size-full object-cover transition-opacity duration-700',
          playing ? 'opacity-0' : 'opacity-100',
        )}
        loading="lazy"
        decoding="async"
      />

      {showVideo ? (
        <video
          ref={videoRef}
          className={cn(
            'absolute inset-0 size-full object-cover transition-opacity duration-700',
            playing ? 'opacity-100' : 'opacity-0',
          )}
          poster={poster}
          muted
          loop
          playsInline
          // Metadata only: a 6-second loop is decoration and must not compete
          // with the app shell for bandwidth on a 3G connection.
          preload="metadata"
          disablePictureInPicture
          aria-hidden="true"
          onError={() => setFailed(true)}
          onPlaying={() => setPlaying(true)}
        >
          <source src={src} type="video/mp4" />
        </video>
      ) : null}

      {/* Warm gradient so overlaid text stays legible on any frame. */}
      <div
        className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent"
        aria-hidden="true"
      />

      {caption ? (
        <figcaption className="absolute inset-x-0 bottom-0 p-4 text-xs font-medium text-white/85">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
