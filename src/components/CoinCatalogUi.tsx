import {
  useId,
  useState,
  type InputHTMLAttributes,
  type PropsWithChildren,
} from "react";
import { Input, Label } from "@sqlrooms/ui";

import type { CoinInput } from "../types/catalog";
import { imageUrl } from "../lib/catalogMedia";

export const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring";

export function CatalogField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

export function CatalogSelect({
  label,
  value,
  onChange,
  children,
  disabled,
}: PropsWithChildren<{
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}>) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {children}
      </select>
    </div>
  );
}

export function CatalogNotes({
  label = "Notes",
  value,
  onChange,
}: {
  label?: string;
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="block w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
      />
    </div>
  );
}

export function CatalogError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="text-sm text-red-400">{error}</p>;
}

export function useCatalogAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}

export function PhotoPlaceholder({ label }: { label: string }) {
  return (
    <div className="grid h-full min-h-20 place-items-center bg-muted/30 text-muted-foreground">
      <div className="grid justify-items-center gap-2 text-xs">
        <span aria-hidden className="grid size-12 place-items-center rounded-full border border-dashed border-current/50">
          <span className="size-8 rounded-full border border-current/30" />
        </span>
        <span>{label}</span>
      </div>
    </div>
  );
}

export function CatalogPhoto({
  id,
  alt,
  className,
  variant = "thumbnail",
}: {
  id: number;
  alt: string;
  className: string;
  variant?: "thumbnail" | "full";
}) {
  const src = imageUrl(id, variant);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === src) return <PhotoPlaceholder label="Photo unavailable" />;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={variant === "thumbnail" ? "lazy" : "eager"}
      decoding="async"
      onError={() => setFailedUrl(src)}
    />
  );
}

const localDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatCatalogDate(value: string) {
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : localDate.format(date);
}

export function coinYear(coin: CoinInput) {
  if (coin.yearFrom === undefined) return "";
  if (coin.yearTo === undefined || coin.yearFrom === coin.yearTo) return String(coin.yearFrom);
  return `${coin.yearFrom}–${coin.yearTo}`;
}
