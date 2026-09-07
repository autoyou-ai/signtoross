import { opensignProvider } from "./opensign";
import type { SigningProvider } from "./types";

export function getSigningProvider(
  name = process.env.SIGNING_PROVIDER,
): SigningProvider {
  const provider = (name ?? "opensign").toLowerCase();
  if (provider === "opensign") return opensignProvider;
  throw new Error(`Unsupported signing provider: ${provider}`);
}

export * from "./types";
