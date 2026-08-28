const MINIMUM_NODE_MAJOR = 24;
const MINIMUM_NODE_MINOR = 19;
const NODE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/u;

export function assertSupportedNodeVersion(nodeVersion = process.versions.node): void {
  const match = NODE_VERSION_PATTERN.exec(nodeVersion);
  const majorText = match?.[1];
  const minorText = match?.[2];

  if (majorText === undefined || minorText === undefined) {
    throw new Error(
      `finbook requires Node >=24.19.0 <25.0.0; found ${nodeVersion}. Activate Node 24 and retry.`,
    );
  }

  const major = Number(majorText);
  const minor = Number(minorText);

  if (major !== MINIMUM_NODE_MAJOR || minor < MINIMUM_NODE_MINOR) {
    throw new Error(
      `finbook requires Node >=24.19.0 <25.0.0; found ${nodeVersion}. Activate Node 24 and retry.`,
    );
  }
}
