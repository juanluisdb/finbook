import { CURRENT_SCHEMA_VERSION } from "@finbook/core";

export type DoctorSummary = {
  schemaVersion: number;
  eventCount: number;
  holeCount: number;
  dataPath: string;
};

export function createEmptyDoctor(dataPath: string): DoctorSummary {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventCount: 0,
    holeCount: 0,
    dataPath,
  };
}
