// Type declarations for pg module
declare module 'pg' {
  export class Pool {
    constructor(config?: PoolConfig | string)
    query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>
    connect(): Promise<PoolClient>
    end(): Promise<void>
    on(event: 'error', listener: (err: Error, client: PoolClient) => void): this
    totalCount: number
    idleCount: number
    waitingCount: number
  }

  export class PoolClient {
    query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>
    release(): void
  }

  export interface PoolConfig {
    host?: string
    port?: number
    database?: string
    user?: string
    password?: string
    max?: number
    idleTimeoutMillis?: number
    connectionTimeoutMillis?: number
    ssl?: boolean | object
    connectionString?: string
    options?: string
  }

  export interface QueryResult<T = any> {
    command: string
    rowCount: number | null
    oid: number | null
    rows: T[]
    fields: FieldDef[]
  }

  export interface FieldDef {
    name: string
    tableID: number
    columnID: number
    dataTypeID: number
    dataTypeSize: number
    dataTypeModifier: number
    format: string
  }

  export interface QueryResultRow {
    [key: string]: any
  }

  export class Client extends PoolClient {
    constructor(config?: PoolConfig | string)
    connect(): Promise<void>
    end(): Promise<void>
  }
}
