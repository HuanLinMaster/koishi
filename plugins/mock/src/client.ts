import assert from 'assert'
import { Context, segment, Session, Universal } from 'koishi'
import { format } from 'util'
import { MockBot } from './adapter'

const RECEIVED_UNEXPECTED = 'expected "%s" to be not replied but received "%s"'
const RECEIVED_NOTHING = 'expected "%s" to be replied but received nothing'
const RECEIVED_OTHERWISE = 'expected "%s" to be replied with %s but received "%s"'
const RECEIVED_NTH_NOTHING = 'expected "%s" to be replied at index %s but received nothing'
const RECEIVED_NTH_OTHERWISE = 'expected "%s" to be replied with %s at index %s but received "%s"'

export class MessageClient {
  public app: Context
  public meta: Session.Payload & Partial<Session>

  _resolve: (checkLength?: boolean) => void
  private replies: string[] = []

  constructor(public bot: MockBot, public userId: string, public channelId?: string) {
    this.app = bot.ctx.root
    this.meta = {
      platform: 'mock',
      type: 'message',
      selfId: bot.selfId,
      userId,
      author: {
        userId,
        username: '' + userId,
      },
    }

    if (channelId) {
      this.meta.guildId = channelId
      this.meta.channelId = channelId
      this.meta.subtype = 'group'
    } else {
      this.meta.channelId = 'private:' + userId
      this.meta.subtype = 'private'
    }

    const self = this
    this._resolve = () => {}
    this.meta.send = async function (this: Session, fragment, options) {
      const elements = await this.transform(segment.normalize(fragment))
      if (!elements.length) return
      const session = this.app.bots[0].session({ ...self.meta, elements })
      if (await this.app.serial(session, 'before-send', session, options)) return
      if (!session?.content) return []
      self.replies.push(session.content)
      self._resolve(true)
      return []
    }
  }

  async receive(content: string, count = Infinity) {
    return new Promise<string[]>((resolve) => {
      let resolved = false
      this._resolve = (checkLength = false) => {
        if (resolved) return
        if (checkLength && this.replies.length < count) return
        resolved = true
        dispose()
        resolve(this.replies)
        this.replies = []
      }
      const dispose = this.app.on('middleware', (session) => {
        if (session.id === uuid) process.nextTick(this._resolve)
      })
      let quote: Universal.Message
      const elements = segment.parse(content)
      if (elements[0]?.type === 'quote') {
        const { attrs, children } = elements.shift()
        quote = { messageId: attrs.id, elements: children, content: children.join('') }
        content = elements.join('')
      }
      const uuid = this.bot.receive({ ...this.meta, content, elements, quote })
    })
  }

  async shouldReply(message: string, reply?: string | RegExp | (string | RegExp)[]) {
    function match(reply: string | RegExp, content: string) {
      return typeof reply === 'string' ? reply === content : reply.test(content)
    }

    function prettify(reply: string | RegExp) {
      return typeof reply === 'string' ? `"${reply}"` : reply.toString()
    }

    if (!reply) {
      const result = await this.receive(message)
      assert.ok(result.length, format(RECEIVED_NOTHING, message))
      return
    }

    if (!Array.isArray(reply)) {
      const [result] = await this.receive(message, 1)
      assert.ok(result, format(RECEIVED_NOTHING, message))
      assert.ok(match(reply, result), format(RECEIVED_OTHERWISE, message, prettify(reply), result))
      return
    }

    const result = await this.receive(message)
    for (const index in reply) {
      const expected = reply[index]
      const actual = result[index]
      assert.ok(actual, format(RECEIVED_NTH_NOTHING, message, index))
      assert.ok(match(expected, actual), format(RECEIVED_NTH_OTHERWISE, message, prettify(expected), index, actual))
    }
  }

  async shouldNotReply(message: string) {
    const result = await this.receive(message)
    assert.ok(!result.length, format(RECEIVED_UNEXPECTED, message, result))
  }
}
