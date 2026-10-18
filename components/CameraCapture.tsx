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
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
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
          <div className="camera-guide" aria-hidden="true" />
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
