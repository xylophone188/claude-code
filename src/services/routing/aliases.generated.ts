export interface CCBRoutingAlias {
  alias: string
  target: string
}

// Keep only aliases whose provider exists in CCB's checked-in catalog.
export const CCB_ROUTING_ALIASES_GENERATED: CCBRoutingAlias[] = []
