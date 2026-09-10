import { Sparkle } from '../Icons'

/**
 * Representative image-generation result state (UI only — no backend).
 *
 * An animated canvas with morphing accent blobs + glow, a "Generating image"
 * indicator with dots, a resolution badge, and the quoted prompt underneath.
 * Styled entirely with HPOS theme tokens (see the `ig-*` rules in index.css),
 * so it follows light/dark palettes, accent, and radius automatically.
 */
export default function ImageGeneration({
  prompt = 'a calm mountain lake at dawn',
  resolution = '1024 × 1024',
}) {
  return (
    <figure
      className="ig-card"
      role="status"
      aria-label={`Generating image: ${prompt}`}
    >
      <div className="ig-canvas">
        {/* Decorative morphing blobs + glow wash. */}
        <div className="ig-blob ig-blob-a" aria-hidden="true" />
        <div className="ig-blob ig-blob-b" aria-hidden="true" />
        <div className="ig-blob ig-blob-c" aria-hidden="true" />
        <div className="ig-glow" aria-hidden="true" />

        <div className="ig-center">
          <span className="ig-icon" aria-hidden="true">
            <Sparkle size={18} />
          </span>
          <span className="ig-label">
            Generating image
            <span className="ig-dots" aria-hidden="true">
              <i className="ig-dot" style={{ animationDelay: '0ms' }} />
              <i className="ig-dot" style={{ animationDelay: '160ms' }} />
              <i className="ig-dot" style={{ animationDelay: '320ms' }} />
            </span>
          </span>
        </div>

        <span className="ig-res">{resolution}</span>
      </div>
      <figcaption className="ig-caption">
        <span className="ig-quote">&ldquo;{prompt}&rdquo;</span>
      </figcaption>
    </figure>
  )
}
