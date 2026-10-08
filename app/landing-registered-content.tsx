"use client";

import { registry } from "./plugins";
import { LandingContent, type LandingContentProps } from "./landing-content";

// Plugin objects include client components; resolve them inside the client boundary.
// The catalogue remains the same runtime registry used by the learning workspace.
export function RegisteredLandingContent(props: Omit<LandingContentProps, "modes">) {
  const modes = registry.getAll().map(({ id, name, description }) => ({ id, name, description }));
  return <LandingContent {...props} modes={modes} />;
}
