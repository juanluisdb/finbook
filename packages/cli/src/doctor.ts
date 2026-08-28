import { CURRENT_SCHEMA_VERSION } from "@finbook/core";

export type DoctorSummary = {
  schemaVersion: number;
  eventCount: number;
  holeCount: number;
  dataPath: string;
};

export function createDoctor(
  dataPath: string,
  eventCount: number,
  holeCount: number,
): DoctorSummary {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, eventCount, holeCount, dataPath };
}

export function createEmptyDoctor(dataPath: string): DoctorSummary {
  return createDoctor(dataPath, 0, 0);
}
