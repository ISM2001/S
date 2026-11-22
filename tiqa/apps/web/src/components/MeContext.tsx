"use client";
import { createContext, useContext } from "react";
import type { Me } from "@/lib/api";

export const MeContext = createContext<{ me: Me; reload: () => void } | null>(null);
export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe outside dashboard");
  return ctx;
}
