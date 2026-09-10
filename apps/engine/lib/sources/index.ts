import { ntsSource } from "./nts";
import { lotRadioSource } from "./lotradio";
import type { DiscoverySource } from "../sources";

// Mix archives are indexed by dedicated crawlers. Keeping Soulection out of
// generic seed discovery prevents archive appearances becoming user opinions.
export const SOURCES: DiscoverySource[] = [ntsSource, lotRadioSource];

export function getSource(name: string): DiscoverySource | undefined {
  return SOURCES.find((s) => s.name === name);
}
