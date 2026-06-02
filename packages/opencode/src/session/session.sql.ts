// Fork compatibility shim: re-export session SQL tables from new core location
// after upstream consolidated DB schema ownership into packages/core (#29068).
export { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
