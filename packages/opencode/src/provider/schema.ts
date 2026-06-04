// Fork compatibility shim: re-export ProviderV2/ModelV2 brand types under the
// old ProviderID/ModelID names so legacy fork code that imports from
// "@/provider/schema" continues to work after upstream consolidated brands
// into ProviderV2 (#29068) and later nested the model id under ModelV2.ID
// (#30603, removing the ProviderV2.ModelID alias).
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export const ProviderID = ProviderV2.ID
export type ProviderID = ProviderV2.ID

export const ModelID = ModelV2.ID
export type ModelID = ModelV2.ID
