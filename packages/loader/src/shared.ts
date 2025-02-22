import { Context, Dict, EnvData, interpolate, isNullable, Logger, Plugin, resolveConfig, valueMap } from '@koishijs/core'
import { Modifier, patch } from './utils'

export * from './utils'

declare module '@koishijs/core' {
  interface Context {
    loader: Loader
  }

  interface Events {
    'config'(): void
  }

  namespace Context {
    interface Config {
      name?: string
      plugins?: Dict
    }
  }
}

declare module 'cordis' {
  // Theoretically, these properties will only appear on `ForkScope`.
  // We define them directly on `EffectScope` for typing convenience.
  interface EffectScope<C> {
    [Loader.kRecord]?: Dict<ForkScope<C>>
    alias?: string
  }
}

const kUpdate = Symbol('update')

Context.service('loader')

const logger = new Logger('app')

const group: Plugin.Object = {
  name: 'group',
  reusable: true,
  apply(ctx, plugins) {
    ctx.state[Loader.kRecord] ||= Object.create(null)

    for (const name in plugins || {}) {
      if (name.startsWith('~') || name.startsWith('$')) continue
      ctx.lifecycle.queue(ctx.loader.reloadPlugin(ctx, name, plugins[name]))
    }

    ctx.accept((neo) => {
      // update config reference
      const old = ctx.state.config

      // update inner plugins
      for (const key in { ...old, ...neo }) {
        if (key.startsWith('~') || key.startsWith('$')) continue
        const fork = ctx.state[Loader.kRecord][key]
        if (!fork) {
          ctx.loader.reloadPlugin(ctx, key, neo[key])
        } else if (!(key in neo)) {
          ctx.loader.unloadPlugin(ctx, key)
        } else {
          ctx.loader.reloadPlugin(ctx, key, neo[key] || {})
        }
      }
    }, { passive: true })
  },
}

export abstract class Loader {
  static readonly kRecord = Symbol.for('koishi.loader.record')
  static readonly exitCode = 51

  public envData: EnvData
  public ctxData = {}
  public app: Context
  public baseDir: string
  public config: Context.Config
  public entry: Context
  public suspend = false
  public filename: string
  public writable = true
  public envfile: string
  public cache: Dict<string> = Object.create(null)

  abstract readConfig(): Context.Config
  abstract writeConfig(): void
  abstract resolve(name: string): Promise<string>
  abstract resolvePlugin(name: string): Promise<any>
  abstract fullReload(): void

  interpolate(source: any) {
    if (!this.writable) return source
    if (typeof source === 'string') {
      return interpolate(source, this.ctxData, /\$\{\{(.+?)\}\}/g)
    } else if (!source || typeof source !== 'object') {
      return source
    } else if (Array.isArray(source)) {
      return source.map(item => this.interpolate(item))
    } else {
      return valueMap(source, item => this.interpolate(item))
    }
  }

  private async forkPlugin(name: string, config: any, parent: Context) {
    const plugin = await this.resolvePlugin(name)
    if (!plugin) return

    resolveConfig(plugin, config)
    return parent.plugin(plugin, this.interpolate(config))
  }

  isTruthyLike(expr: any) {
    if (isNullable(expr)) return true
    return !!this.interpolate(`\${{ ${expr} }}`)
  }

  async reloadPlugin(parent: Context, key: string, config: any) {
    let fork = parent.state[Loader.kRecord][key]
    if (fork) {
      if (!this.isTruthyLike(config?.$if)) {
        this.unloadPlugin(parent, key)
        return
      }
      patch(fork.parent, config)
      fork[kUpdate] = true
      if (fork.runtime.plugin !== group) {
        config = Modifier.pick(config, false)
      }
      fork.update(config)
    } else {
      if (!this.isTruthyLike(config?.$if)) return
      logger.info(`apply plugin %c`, key)
      const name = key.split(':', 1)[0]
      const ctx = parent.extend()
      patch(ctx, config)
      if (name === 'group') {
        fork = ctx.plugin(group, config)
      } else {
        config = Modifier.pick(config, false)
        fork = await this.forkPlugin(name, config, ctx)
      }
      if (!fork) return
      fork.alias = key.slice(name.length + 1)
      parent.state[Loader.kRecord][key] = fork
    }
    return fork
  }

  unloadPlugin(ctx: Context, key: string) {
    const fork = ctx.state[Loader.kRecord][key]
    if (fork) {
      fork.dispose()
      delete ctx.state[Loader.kRecord][key]
      logger.info(`unload plugin %c`, key)
    }
  }

  async createApp() {
    const app = this.app = new Context(this.interpolate(this.config))
    app.loader = this
    app.baseDir = this.baseDir
    app.envData = this.envData
    app.state[Loader.kRecord] = Object.create(null)
    const fork = await this.reloadPlugin(app, 'group:entry', this.config.plugins)
    this.entry = fork.ctx

    app.accept(['plugins'], (config) => {
      this.reloadPlugin(app, 'group:entry', config.plugins)
    }, { passive: true })

    app.on('dispose', () => {
      this.fullReload()
    })

    app.on('internal/update', (fork) => {
      const record = fork.parent.state[Loader.kRecord]
      if (!record) return
      for (const name in record) {
        if (record[name] !== fork) continue
        logger.info(`reload plugin %c`, name)
      }
    })

    app.on('internal/before-update', (fork, config) => {
      if (fork[kUpdate]) return delete fork[kUpdate]
      const record = fork.parent.state[Loader.kRecord]
      if (!record) return
      for (const name in record) {
        if (record[name] !== fork) continue
        const simplify = fork.runtime.schema?.simplify
        fork.parent.state.config[name] = {
          ...Modifier.pick(fork.parent.state.config[name], true),
          ...simplify ? simplify(config) : config,
        }
      }
    })

    return app
  }
}
