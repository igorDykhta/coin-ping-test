import { useEffect, useState } from "react";
import { Button } from "@sqlrooms/ui";

type Playback = { url: string } | { error: string } | null;

export function SoundResultPlayback({ resultId }: { resultId: number }) {
  const [playback, setPlayback] = useState<Playback>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let url: string | undefined;

    async function load() {
      try {
        const recording = await window.coinCatalogApi.getSoundAudio(resultId);
        if (!active) return;
        if (!recording) throw new Error("The saved recording is unavailable.");
        const bytes = new Uint8Array(recording.bytes);
        url = URL.createObjectURL(new Blob([bytes], { type: recording.mimeType }));
        setPlayback({ url });
      } catch (error) {
        if (active) setPlayback({ error: error instanceof Error ? error.message : "Could not load the recording." });
      }
    }

    void load();
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attempt, resultId]);

  if (!playback) return <p role="status" className="text-xs text-muted-foreground">Loading recording…</p>;
  if ("error" in playback) {
    return <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-xs text-red-400">{playback.error}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => {
        setPlayback(null);
        setAttempt((previous) => previous + 1);
      }}>Retry playback</Button>
    </div>;
  }
  return <audio aria-label="Recorded ping" controls preload="metadata" src={playback.url}
    className="w-full max-w-sm" onError={() => setPlayback({ error: "This recording could not be played." })} />;
}
