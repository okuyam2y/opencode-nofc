// Fork compatibility shim: re-export ProviderV2 brand types under the old
// ProviderID/ModelID names so legacy fork code that imports from
// "@/provider/schema" continues to work after upstream consolidated brands
// into ProviderV2 (#29068).
import { ProviderV2 } from "@opencode-ai/core/provider"

export const ProviderID = ProviderV2.ID
export type ProviderID = ProviderV2.ID

export const ModelID = ProviderV2.ModelID
export type ModelID = ProviderV2.ModelID
