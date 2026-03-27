"use client";

import { createContext, useContext } from "react";

const ApiKeyContext = createContext<string | null>(null);

export function ApiKeyProvider({ value, children }: { value: string | null; children: React.ReactNode }) {
  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>;
}

export function useApiKey(): string | null {
  return useContext(ApiKeyContext);
}
