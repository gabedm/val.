import { useLayoutEffect, useRef, useState } from "react";

/** Keep one bubble on screen while its status becomes the first reply. */
export function IngestionBubble({ label, message }: { label: string; message: string | null }) {
  const bubble = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const parent = bubble.current?.parentElement;
    const content = measure.current;
    if (!parent || !content) return;
    const update = () => {
      const style = getComputedStyle(parent);
      const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const maxWidth = available * 0.88;
      content.style.width = message ? `${maxWidth}px` : "max-content";
      content.style.maxWidth = `${maxWidth}px`;
      const { width, height } = content.getBoundingClientRect();
      setSize((previous) =>
        previous?.width === width && previous.height === height ? previous : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    // Re-measure if the app font finishes loading during the opening.
    document.fonts.addEventListener("loadingdone", update);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", update);
    };
  }, [label, message]);
  const status = (
    <>
      <span className="chat-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </>
  );
  return (
    <div
      ref={bubble}
      className={`chat-message from-val ingestion-bubble${message ? " is-ready" : ""}`}
      style={size ?? undefined}
    >
      <div ref={measure} className="ingestion-measure" aria-hidden="true">
        {message ? <p>{message}</p> : <div className="ingestion-status">{status}</div>}
      </div>
      <div
        className="ingestion-status ingestion-layer"
        role={message ? undefined : "status"}
        aria-hidden={!!message}
      >
        {status}
      </div>
      <div className="ingestion-message ingestion-layer" aria-hidden={!message}>
        <span className="chat-author sr-only">Val</span>
        <p>{message}</p>
      </div>
    </div>
  );
}
