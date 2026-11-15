export function imageUrl(id: number, variant: "thumbnail" | "full" = "full"): string {
  return `coin-media://image/${id}${variant === "thumbnail" ? "?variant=thumb" : ""}`;
}
