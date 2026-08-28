#!/usr/bin/env node

const minimumMajor = 24;
const minimumMinor = 19;
const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(process.versions.node);
const major = Number(match?.[1]);
const minor = Number(match?.[2]);

if (
  !Number.isInteger(major) ||
  !Number.isInteger(minor) ||
  major !== minimumMajor ||
  minor < minimumMinor
) {
  console.error(
    `finbook requires Node >=24.19.0 <25.0.0; found ${process.versions.node}. Activate Node 24 and retry.`,
  );
  process.exit(1);
}
