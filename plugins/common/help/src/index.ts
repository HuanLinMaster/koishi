import { Argv, Channel, Command, Context, FieldCollector, Schema, segment, Session, Tables, User } from 'koishi'
import zhCN from './locales/zh-CN.yml'
import enUS from './locales/en-US.yml'
import jaJP from './locales/ja-JP.yml'
import frFR from './locales/fr-FR.yml'
import zhTW from './locales/zh-TW.yml'

declare module 'koishi' {
  interface Events {
    'help/command'(output: string[], command: Command, session: Session): void
    'help/option'(output: string, option: Argv.OptionVariant, command: Command, session: Session): string
  }

  namespace Command {
    interface Config {
      /** hide all options by default */
      hideOptions?: boolean
      /** hide command */
      hidden?: boolean
    }
  }

  namespace Argv {
    interface OptionConfig {
      hidden?: boolean | ((session: Session) => boolean)
    }
  }
}

interface HelpOptions {
  showHidden?: boolean
  authority?: boolean
}

export interface Config {
  shortcut?: boolean
  options?: boolean
}

export const Config: Schema<Config> = Schema.object({
  shortcut: Schema.boolean().default(true).description('是否启用快捷调用。'),
  options: Schema.boolean().default(true).description('是否为每个指令添加 `-h, --help` 选项。'),
})

export function enableHelp<U extends User.Field, G extends Channel.Field, A extends any[], O extends {}>(cmd: Command<U, G, A, O>) {
  return cmd.option('help', '-h', {
    hidden: true,
    // @ts-ignore
    notUsage: true,
    descPath: 'commands.help.options.help',
  })
}

function executeHelp(session: Session, name: string) {
  if (!session.app.$commander.getCommand('help')) return
  return session.execute({
    name: 'help',
    args: [name],
  })
}

export const name = 'help'

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh', zhCN)
  ctx.i18n.define('en', enUS)
  ctx.i18n.define('ja', jaJP)
  ctx.i18n.define('fr', frFR)
  ctx.i18n.define('zh-TW', zhTW)

  if (config.options !== false) {
    ctx.$commander._commandList.forEach(cmd => cmd.use(enableHelp))
    ctx.on('command-added', cmd => cmd.use(enableHelp))
  }

  ctx.before('command/execute', (argv) => {
    const { command, options, session } = argv
    if (options['help'] && command._options.help) {
      return executeHelp(session, command.name)
    }

    if (command['_actions'].length) return
    return executeHelp(session, command.name)
  })

  const $ = ctx.$commander
  function findCommand(target: string, session: Session) {
    const command = $.resolve(target)
    if (command?.match(session)) return command

    // shortcuts
    const data = ctx.i18n
      .find('commands.(name).shortcuts.(variant)', target)
      .map(item => ({ ...item, command: $.resolve(item.data.name) }))
      .filter(item => item.command?.match(session))
    const perfect = data.filter(item => item.similarity === 1)
    if (!perfect.length) return data
    return perfect[0].command
  }

  const createCollector = <T extends keyof Tables>(key: T): FieldCollector<T> => (argv, fields) => {
    const { args: [target], session } = argv
    const result = findCommand(target, session)
    if (!Array.isArray(result)) {
      session.collect(key, { ...argv, command: result, args: [], options: { help: true } }, fields)
      return
    }
    for (const { command } of result) {
      session.collect(key, { ...argv, command, args: [], options: { help: true } }, fields)
    }
  }

  async function inferCommand(target: string, session: Session) {
    const result = findCommand(target, session)
    if (!Array.isArray(result)) return result

    const expect = $.available(session).filter((name) => {
      return name && session.app.i18n.compare(name, target)
    })
    for (const item of result) {
      if (expect.includes(item.data.name)) continue
      expect.push(item.data.name)
    }
    const name = await session.suggest({
      expect,
      prefix: session.text('.not-found'),
      suffix: session.text('internal.suggest-command'),
    })
    return $.resolve(name)
  }

  const cmd = ctx.command('help [command:string]', { authority: 0, ...config })
    .userFields(['authority'])
    .userFields(createCollector('user'))
    .channelFields(createCollector('channel'))
    .option('authority', '-a')
    .option('showHidden', '-H')
    .action(async (argv, target) => {
      const { session, options } = argv
      if (!target) {
        const commands = $._commandList.filter(cmd => cmd.parent === null)
        const output = formatCommands('.global-prolog', session, commands, options)
        const epilog = session.text('.global-epilog')
        if (epilog) output.push(epilog)
        return output.filter(Boolean).join('\n')
      }

      const command = await inferCommand(target, session)
      if (command) return showHelp(command, session, options)
    })

  if (config.shortcut !== false) cmd.shortcut('help', { i18n: true, fuzzy: true })
}

function* getCommands(session: Session<'authority'>, commands: Command[], showHidden = false): Generator<Command> {
  for (const command of commands) {
    if (!showHidden && command.config.hidden) continue
    if (command.match(session)) {
      yield command
    } else {
      yield* getCommands(session, command.children, showHidden)
    }
  }
}

function formatCommands(path: string, session: Session<'authority'>, children: Command[], options: HelpOptions) {
  const commands = Array
    .from(getCommands(session, children, options.showHidden))
    .sort((a, b) => a.displayName > b.displayName ? 1 : -1)
  if (!commands.length) return []

  let hasSubcommand = false
  const output = commands.map(({ name, displayName, config, children }) => {
    let output = '    ' + displayName
    if (options.authority) {
      output += ` (${config.authority}${children.length ? (hasSubcommand = true, '*') : ''})`
    }
    output += '  ' + session.text([`commands.${name}.description`, ''], config.params)
    return output
  })
  const hints: string[] = []
  if (options.authority) hints.push(session.text('.hint-authority'))
  if (hasSubcommand) hints.push(session.text('.hint-subcommand'))
  const hintText = hints.length
    ? session.text('general.paren', [hints.join(session.text('general.comma'))])
    : ''
  output.unshift(session.text(path, [hintText]))
  return output
}

function getOptionVisibility(option: Argv.OptionConfig, session: Session<'authority'>) {
  if (session.user && option.authority > session.user.authority) return false
  return !session.resolveValue(option.hidden)
}

function getOptions(command: Command, session: Session<'authority'>, config: HelpOptions) {
  if (command.config.hideOptions && !config.showHidden) return []
  const options = config.showHidden
    ? Object.values(command._options)
    : Object.values(command._options).filter(option => getOptionVisibility(option, session))
  if (!options.length) return []

  const output: string[] = []
  Object.values(command._options).forEach((option) => {
    const authority = option.authority && config.authority ? `(${option.authority}) ` : ''
    function pushOption(option: Argv.OptionVariant, name: string) {
      if (!config.showHidden && !getOptionVisibility(option, session)) return
      let line = `${authority}${segment.escape(option.syntax)}`
      const description = session.text(option.descPath ?? [`commands.${command.name}.options.${name}`, ''], option.params)
      if (description) line += '  ' + description
      line = command.ctx.chain('help/option', line, option, command, session)
      output.push('    ' + line)
    }

    if (!('value' in option)) pushOption(option, option.name)
    for (const value in option.variants) {
      pushOption(option.variants[value], `${option.name}.${value}`)
    }
  })

  if (!output.length) return []
  output.unshift(config.authority && options.some(o => o.authority)
    ? session.text('.available-options-with-authority')
    : session.text('.available-options'))
  return output
}

async function showHelp(command: Command, session: Session<'authority'>, config: HelpOptions) {
  const output = [command.displayName + segment.escape(command.declaration)]

  const description = session.text([`commands.${command.name}.description`, ''], command.config.params)
  if (description) output.push(description)

  if (session.app.database) {
    const argv: Argv = { command, args: [], options: { help: true } }
    const userFields = session.collect('user', argv)
    await session.observeUser(userFields)
    if (session.subtype === 'group') {
      const channelFields = session.collect('channel', argv)
      await session.observeChannel(channelFields)
    }
  }

  if (command._aliases.length > 1) {
    output.push(session.text('.command-aliases', [Array.from(command._aliases.slice(1)).join('，')]))
  }

  session.app.emit(session, 'help/command', output, command, session)

  if (session.user && command.config.authority > 1) {
    output.push(session.text('.command-authority', [command.config.authority]))
  }

  if (command._usage) {
    output.push(typeof command._usage === 'string' ? command._usage : await command._usage(session))
  } else {
    const text = session.text([`commands.${command.name}.usage`, ''])
    if (text) output.push(text)
  }

  output.push(...getOptions(command, session, config))

  if (command._examples.length) {
    output.push(session.text('.command-examples'), ...command._examples.map(example => '    ' + example))
  } else {
    const text = session.text([`commands.${command.name}.examples`, ''])
    if (text) output.push(...text.split('\n').map(line => '    ' + line))
  }

  output.push(...formatCommands('.subcommand-prolog', session, command.children, config))

  return output.filter(Boolean).join('\n')
}
