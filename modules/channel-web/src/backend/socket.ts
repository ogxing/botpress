import * as sdk from 'botpress/sdk'

import _ from 'lodash'
import mime from 'mime'
import path from 'path'
import axios from 'axios'
import Database from './db'
// ** *** * * * * * ** * * * * * * NOTE ********
// Whenever you update the serverUrl, remember to run yarn build on this folder to reflect the changes!!!!!!!!!!!
const test = false;
const serverChatBotReplyUrl = test ? "https://dapi.hso.my/service/chat/botpress-bot-send" : "https://api.hso.my/service/chat/botpress-bot-send";
const outgoingTypes = ['text', 'typing', 'login_prompt', 'file', 'carousel', 'custom', 'data']

export default async (bp: typeof sdk, db: Database) => {
  const config: any = {} // FIXME
  const { botName = 'Bot', botAvatarUrl = undefined } = config || {} // FIXME

  bp.events.registerMiddleware({
    description:
      'Sends out messages that targets platform = webchat.' +
      ' This middleware should be placed at the end as it swallows events once sent.',
    direction: 'outgoing',
    handler: outgoingHandler,
    name: 'web.sendMessages',
    order: 100
  })

  // Bot reply (Outbound).
  async function outgoingHandler(event: sdk.IO.Event, next: sdk.IO.MiddlewareNextCallback) {
    if (event.channel !== 'web') {
      return next()
    }

    const messageType = event.type === 'default' ? 'text' : event.type
    const userId = event.target
    const conversationId = event.threadId || (await db.getOrCreateRecentConversation(event.botId, userId))
    let msgType;
    let msgText;


    if (!_.includes(outgoingTypes, messageType)) {
      return next(new Error('Unsupported event type: ' + event.type))
    }

    if (messageType === 'typing') {
      const typing = parseTyping(event.payload.value)
      const payload = bp.RealTimePayload.forVisitor(userId, 'webchat.typing', { timeInMs: typing, conversationId })
      // Don't store "typing" in DB
      bp.realtime.sendPayload(payload)
      await Promise.delay(typing)
    } else if (messageType === 'text' || messageType === 'carousel' || messageType === 'custom') {
      const message = await db.appendBotMessage(botName, botAvatarUrl, conversationId, {
        data: event.payload,
        raw: event.payload,
        text: event.preview,
        type: messageType
      })

      let finalPayload = bp.RealTimePayload.forVisitor(userId, 'webchat.message', message)
      bp.realtime.sendPayload(finalPayload)

      // Extract text msg.
      msgType = finalPayload.payload.message_type;
      msgText = finalPayload.payload.message_text;
    } else if (messageType === 'file') {
      const extension = path.extname(event.payload.url)
      const mimeType = mime.getType(extension)
      const basename = path.basename(event.payload.url, extension)

      const message = await db.appendBotMessage(botName, botAvatarUrl, conversationId, {
        data: { storage: 'storage', mime: mimeType, name: basename, ...event.payload },
        raw: event.payload,
        text: event.preview,
        type: messageType
      })

      let finalPayload = bp.RealTimePayload.forVisitor(userId, 'webchat.message', message)
      bp.realtime.sendPayload(finalPayload)

      // Extract file type and their url.
      if (mimeType.includes("image")) {
        msgType = "image";
      }
      else if (mimeType.includes("audio")) {
        msgType = "audio";
      }
      msgText = finalPayload.payload.message_data.url;
    }
    else if (messageType === 'data') {
      const userId = event.target
      const payload = bp.RealTimePayload.forVisitor(userId, 'webchat.data', event.payload)
      bp.realtime.sendPayload(payload)
    }
    else {
      throw new Error(`Message type "${messageType}" not implemented yet`)
    }

    if (msgText && msgType) {
      // Send bot reply to server for forwarding.
      axios.post(serverChatBotReplyUrl, {
        userid: userId,
        msgtext: msgText,
        msgtype: msgType,
      })
        .then(function (response) {
          console.log(`Chatbot Send: type: ${msgType} userid: ${userId} text: ${msgText}`);
        })
        .catch(function (error) {
          console.log(error);
        });
    }

    next(undefined, false)
    // TODO Make official API (BotpressAPI.events.updateStatus(event.id, 'done'))
  }
}

function parseTyping(typing) {
  if (isNaN(typing)) {
    return 1000
  }

  return Math.max(typing, 500)
}
