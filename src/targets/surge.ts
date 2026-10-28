import { formatSurge } from "../rule";
import type { Projection } from "./index";

export function renderSurge({ set, kept }: Projection): string {
  return [`# ${set.name}`, ...kept.map((r) => formatSurge(r))].join("\n") + "\n";
}
