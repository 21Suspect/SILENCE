"use client";

import { useRef, useState } from "react";

/** Dev soundboard: candidate creature sounds, so one of each can be chosen by ear. Open /sounds. */
const takes = (group: string, labels: string[]): [string, string][] => labels.map((label, i) => [`creature/${group}_${i + 1}`, `${i + 1} · ${label}`]);
const GROUPS: [title: string, when: string, sounds: [file: string, label: string][]][] = [
  ["Roar", "the grab, and (quieter, from a distance) the start of a hunt. The game picks a different take each time.",
    takes("screech", ["take", "take", "take", "take", "take"])],
  ["Hiss", "when the flashlight pins it", takes("hiss", ["through teeth", "through teeth", "rattle only", "rattle only", "wet growl", "wet growl"])],
  ["Clicks", "it has been close for a while and you have not found it",
    takes("clicks", ["short, ends on an in-breath", "slow, swelling once", "stops as if listening, then picks up", "very slow single ticks", "long, runs together near the end", "starts fast and winds down", "with a held breath, ends on an in-breath", "sparse and patient"])],
  ["Knocks on a tree trunk", "rare: when you have stopped to listen and are not looking at it", takes("knock_trunk", ["two, then one late", "two, slow", "three, a long wait, one more", "once"])],
  ["Branch", "it moving in the trees, out of sight", takes("branch", ["dry stick", "dry stick", "dry stick", "green limb tearing", "green limb tearing", "heavy break dropping through brush"])],
  ["Distant call", "when it has lost you", takes("call", ["moan", "moan", "from the recording, slowed", "from the recording, slowed"])],
  ["Already in the game", "", [["scary sound", "Reveal recording"]]],
];

export default function Sounds() {
  const player = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState("");
  function play(file: string) {
    player.current?.pause();
    const audio = new Audio(`/audio/${encodeURIComponent(file).replace("%2F", "/")}.mp3`);
    player.current = audio;
    setPlaying(file);
    audio.addEventListener("ended", () => setPlaying(p => (p === file ? "" : p)));
    void audio.play();
  }
  return (
    // The game's global CSS locks <main> and the page from scrolling, so this page scrolls inside its own box.
    <div style={{ position: "fixed", inset: 0, overflowY: "auto", touchAction: "auto", background: "#0d1210", color: "#dfe6dc", font: "16px/1.5 system-ui, sans-serif", padding: "40px 24px" }}>
      <div style={{ maxWidth: 600, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, letterSpacing: ".18em", fontWeight: 500, margin: "0 0 6px" }}>SILENCE / SOUNDS</h1>
        <p style={{ color: "#8fa196", margin: "0 0 30px" }}>Every creature sound in the game. In play each comes from where the creature is; here they are plain.</p>
        {GROUPS.map(([title, when, sounds]) => (
          <section key={title} style={{ margin: "0 0 30px" }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 2px" }}>{title}</h2>
            {when && <p style={{ color: "#8fa196", fontSize: 13, margin: "0 0 10px" }}>{when}</p>}
            {sounds.map(([file, label]) => (
              <button key={file} onClick={() => play(file)} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 16px", margin: "0 0 8px", background: playing === file ? "#2c3a33" : "#1b2420", color: "inherit", border: `1px solid ${playing === file ? "#7f9588" : "#34413a"}`, borderRadius: 6, font: "inherit", cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
