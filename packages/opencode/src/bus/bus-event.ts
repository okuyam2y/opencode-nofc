import { Schema } from "effect"
// Upstream removed the global EventV2.registry; enumerate the full set of event
// definitions (durable + non-durable) from the aggregated event manifest.
import { EventManifest } from "@/event-manifest"

export type Definition<Type extends string = string, Properties extends Schema.Top = Schema.Top> = {
  type: Type
  properties: Properties
}

const registry = new Map<string, Definition>()

export function define<Type extends string, Properties extends Schema.Top>(
  type: Type,
  properties: Properties,
): Definition<Type, Properties> {
  const result = { type, properties }
  registry.set(type, result)
  return result
}

export function effectPayloads() {
  return [
    ...registry
      .entries()
      .map(([type, def]) =>
        Schema.Struct({
          id: Schema.String,
          type: Schema.Literal(type),
          properties: def.properties,
        }).annotate({ identifier: `Event.${type}` }),
      )
      .toArray(),
    ...EventManifest.Definitions.map((definition) =>
      Schema.Struct({
        id: Schema.String,
        type: Schema.Literal(definition.type),
        properties: definition.data,
      }).annotate({ identifier: `Event.${definition.type}` }),
    ),
  ]
}

export * as BusEvent from "./bus-event"
