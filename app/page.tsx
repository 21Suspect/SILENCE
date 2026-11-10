"use client";

import { useEffect, useRef } from "react";

export default function Silence() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    import("../game/engine").then(({ createGame }) => {
      if (!disposed && container.current) cleanup = createGame(container.current);
    });
    return () => { disposed = true; cleanup?.(); };
  }, []);
  return <main ref={container} aria-label="SILENCE. Click to enter. WASD to walk, mouse to look, Shift to hurry, Control to crouch, Escape for pause settings. E to interact, Q to drop." />;
}
