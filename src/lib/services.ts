import type { ServiceRow } from "@/lib/types/database";

/**
 * Pure helpers for presenting the service catalogue.
 *
 * Deliberately NOT in the picker component: that file is "use client", and a
 * server component importing a plain function from a client module gets a
 * client reference it cannot call. The services page renders on the server.
 */

export interface PickableService {
  id: string;
  name: string;
  category: string;
  price: number;
  duration_minutes: number;
}

/** Services grouped under their category, categories in alphabetical order. */
export function groupByCategory<T extends { category: string }>(
  items: T[],
): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.category?.trim() || "General";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function toPickable(services: ServiceRow[]): PickableService[] {
  return services.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    price: Number(s.price),
    duration_minutes: s.duration_minutes,
  }));
}
