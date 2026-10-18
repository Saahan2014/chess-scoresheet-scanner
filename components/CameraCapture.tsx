"use client";

import { useEffect, useRef, useState } from "react";

/** Full-screen camera for scanning a sheet with a webcam or phone camera. */
export default function CameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (canvas: HTMLCanvasElement) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        });
        if (cancelled) return;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        setReady(true);
      } catch (e) {
        setError(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Camera access was blocked. Allow the camera for this site in your browser settings, or upload a photo instead."
            : "No camera found. Upload a photo instead.",
        );
      }
    })();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    // Keep only what's inside the portrait frame (plus a small margin), so the
    // sheet fills the picture the AI reads.
    const crop = guideCrop(v, guideRef.current);
    const c = document.createElement("canvas");
    c.width = crop.w;
    c.height = crop.h;
    c.getContext("2d")!.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    onCapture(c);
  };

  return (
    <div className="camera" role="dialog" aria-modal="true" aria-label="Scan with camera">
      {error ? (
        <div className="camera-error">
          <p>{error}</p>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <>
          <video ref={videoRef} playsInline muted className="camera-video" />
          <div className="camera-guide" ref={guideRef} aria-hidden="true" />
          <p className="camera-hint">Fit the whole scoresheet inside the frame. Flat, in focus, no glare.</p>
          <div className="camera-actions">
            <button className="btn btn-ghost-light" onClick={onClose}>
              Cancel
            </button>
            <button className="shutter" onClick={snap} disabled={!ready} aria-label="Take photo" />
            <span className="camera-spacer" />
          </div>
        </>
      )}
    </div>
  );
}

/** Map the on-screen frame onto the camera image (the video is letterboxed with object-fit: contain). */
function guideCrop(v: HTMLVideoElement, guide: HTMLElement | null) {
  const full = { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight };
  if (!guide) return full;
  const box = v.getBoundingClientRect();
  const g = guide.getBoundingClientRect();
  const scale = Math.min(box.width / v.videoWidth, box.height / v.videoHeight);
  const offX = box.left + (box.width - v.videoWidth * scale) / 2;
  const offY = box.top + (box.height - v.videoHeight * scale) / 2;
  const margin = 0.06;
  const gx = g.left - g.width * margin;
  const gy = g.top - g.height * margin;
  const gw = g.width * (1 + 2 * margin);
  const gh = g.height * (1 + 2 * margin);
  const x = Math.max(0, Math.round((gx - offX) / scale));
  const y = Math.max(0, Math.round((gy - offY) / scale));
  const w = Math.min(v.videoWidth - x, Math.round(gw / scale));
  const h = Math.min(v.videoHeight - y, Math.round(gh / scale));
  return w > 50 && h > 50 ? { x, y, w, h } : full;
}
