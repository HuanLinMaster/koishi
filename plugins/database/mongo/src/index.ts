import { MongoClient, Db, MongoError, IndexDescription } from 'mongodb'
import { Context, Database, Tables as KoishiTables, makeArray, Schema, pick, omit, Query, Model, Dict, noop, KoishiError, valueMap } from 'koishi'
import { URLSearchParams } from 'url'
import { executeUpdate, executeEval } from '@koishijs/orm-utils'
import { transformQuery, transformEval } from './utils'

declare module 'koishi' {
  interface Database {
    mongo: MongoDatabase
  }

  interface Modules {
    'database-mongo': typeof import('.')
  }
}

type TableType = keyof Tables

export interface Tables extends KoishiTables {}

class MongoDatabase extends Database {
  public client: MongoClient
  public db: Db
  public mongo = this
  private tasks: Dict<Promise<any>> = {}

  constructor(public ctx: Context, private config: MongoDatabase.Config) {
    super(ctx)
  }

  private connectionStringFromConfig() {
    const { authDatabase, connectOptions, host, database: name, password, port, protocol, username } = this.config
    let mongourl = `${protocol}://`
    if (username) mongourl += `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    mongourl += `${host}${port ? `:${port}` : ''}/${authDatabase || name}`
    if (connectOptions) {
      const params = new URLSearchParams(connectOptions)
      mongourl += `?${params}`
    }
    return mongourl
  }

  async start() {
    const mongourl = this.config.uri || this.connectionStringFromConfig()
    this.client = await MongoClient.connect(mongourl)
    this.db = this.client.db(this.config.database)

    for (const name in this.ctx.model.config) {
      this.tasks[name] = this._syncTable(name)
    }

    this.ctx.on('model', (name) => {
      this.tasks[name] = this._syncTable(name)
    })
  }

  stop() {
    return this.client.close()
  }

  /** synchronize table schema */
  private async _syncTable(name: string) {
    await this.tasks[name]
    const col = await this.db.createCollection(name).catch(() => this.db.collection(name))
    const { primary, unique } = this.ctx.model.config[name]
    const newSpecs: IndexDescription[] = []
    const oldSpecs = await col.indexes()
    ;[primary, ...unique].forEach((keys, index) => {
      keys = makeArray(keys)
      const name = (index ? 'unique:' : 'primary:') + keys.join('+')
      if (oldSpecs.find(spec => spec.name === name)) return
      const key = Object.fromEntries(keys.map(key => [key, 1]))
      newSpecs.push({ name, key, unique: true })
    })
    if (!newSpecs.length) return
    await col.createIndexes(newSpecs)
  }

  private _createFilter(name: string, query: Query) {
    return transformQuery(this.ctx.model.resolveQuery(name, query))
  }

  async drop(name: TableType) {
    if (name) {
      await this.db.collection(name).drop()
    } else {
      const collections = await this.db.collections()
      await Promise.all(collections.map(c => c.drop()))
    }
  }

  async get(name: TableType, query: Query, modifier: Query.Modifier) {
    const filter = this._createFilter(name, query)
    let cursor = this.db.collection(name).find(filter)
    const { fields, limit, offset = 0 } = Query.resolveModifier(modifier)
    cursor = cursor.project({ _id: 0, ...Object.fromEntries((fields ?? []).map(key => [key, 1])) })
    if (offset) cursor = cursor.skip(offset)
    if (limit) cursor = cursor.limit(offset + limit)
    return await cursor.toArray() as any
  }

  async set(name: TableType, query: Query, update: {}) {
    await this.tasks[name]
    const { primary } = this.ctx.model.config[name]
    const indexFields = makeArray(primary)
    const updateFields = new Set(Object.keys(update).map(key => key.split('.', 1)[0]))
    const filter = this._createFilter(name, query)
    const col = this.db.collection(name)
    const original = await col.find(filter).toArray()
    if (!original.length) return
    const bulk = col.initializeUnorderedBulkOp()
    for (const item of original) {
      bulk.find(pick(item, indexFields)).updateOne({ $set: pick(executeUpdate(update, item), updateFields) })
    }
    await bulk.execute()
  }

  async remove(name: TableType, query: Query) {
    const filter = this._createFilter(name, query)
    await this.db.collection(name).deleteMany(filter)
  }

  private queue(name: TableType, callback: () => Promise<any>) {
    return this.tasks[name] = Promise.resolve(this.tasks[name]).catch(noop).then(callback)
  }

  async create(name: TableType, data: any) {
    const col = this.db.collection(name)
    return this.queue(name, async () => {
      const { primary, fields, autoInc } = this.ctx.model.config[name]
      if (autoInc && !Array.isArray(primary) && !(primary in data)) {
        const [latest] = await col.find().sort(primary, -1).limit(1).toArray()
        data[primary] = latest ? +latest[primary] + 1 : 1
        if (Model.Field.string.includes(fields[primary].type)) {
          data[primary] += ''
        }
      }
      const copy = { ...this.ctx.model.create(name), ...data }
      try {
        await col.insertOne(copy)
        delete copy._id
        return copy
      } catch (err) {
        if (err instanceof MongoError && err.code === 11000) {
          throw new KoishiError(err.message, 'database.duplicate-entry')
        }
        throw err
      }
    })
  }

  async upsert(name: TableType, data: any[], keys: string | string[]) {
    if (!data.length) return
    if (!keys) keys = this.ctx.model.config[name].primary
    const indexFields = makeArray(keys)
    await this.tasks[name]
    const col = this.db.collection(name)
    const original = await col.find({ $or: data.map(item => pick(item, indexFields)) }).toArray()
    const bulk = col.initializeUnorderedBulkOp()
    for (const update of data) {
      const item = original.find(item => indexFields.every(key => item[key] === update[key]))
      if (item) {
        const updateFields = new Set(Object.keys(update).map(key => key.split('.', 1)[0]))
        const override = omit(pick(executeUpdate(update, item), updateFields), indexFields)
        bulk.find(pick(item, indexFields)).updateOne({ $set: override })
      } else {
        bulk.insert(executeUpdate(update, this.ctx.model.create(name)))
      }
    }
    await bulk.execute()
  }

  async aggregate(name: TableType, fields: {}, query: Query) {
    if (!Object.keys(fields).length) return {}
    const $match = this._createFilter(name, query)
    const aggrs: any[][] = []
    fields = valueMap(fields, value => transformEval(value, aggrs))
    const stages = aggrs.map<any>((pipeline) => {
      pipeline.unshift({ $match })
      return { $unionWith: { coll: name, pipeline } }
    })
    stages.unshift({ $match: { _id: null } })
    const results = await this.db.collection(name).aggregate(stages).toArray()
    const data = Object.assign({}, ...results)
    return valueMap(fields, value => executeEval(value, data)) as any
  }
}

namespace MongoDatabase {
  export const name = 'database-mongo'

  export interface Config {
    username?: string
    password?: string
    protocol?: string
    host?: string
    port?: number
    /** database name */
    database?: string
    /** default auth database */
    authDatabase?: string
    connectOptions?: ConstructorParameters<typeof URLSearchParams>[0]
    /** connection string (will overwrite all configs except 'name') */
    uri?: string
  }

  export const Config = Schema.object({
    protocol: Schema.string().description('要使用的协议名。').default('mongodb'),
    host: Schema.string().description('要连接到的主机名。').default('localhost'),
    port: Schema.number().description('要连接到的端口号。'),
    username: Schema.string().description('要使用的用户名。'),
    password: Schema.string().description('要使用的密码。'),
    database: Schema.string().description('要访问的数据库名。').default('koishi'),
  })
}

export default MongoDatabase
